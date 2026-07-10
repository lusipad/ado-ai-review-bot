import type { PrRef } from '../types';
import type { AdoPrResource } from './events';

export type FetchFn = typeof fetch;

export interface CommentThread {
  id: number;
  status?: string;
  comments: Array<{
    id: number;
    content?: string;
    author?: { id: string; displayName?: string };
    isDeleted?: boolean;
  }>;
  threadContext?: {
    filePath?: string;
    rightFileStart?: { line: number; offset?: number };
    rightFileEnd?: { line: number; offset?: number };
  };
}

export interface ThreadCreateBody {
  comments: Array<{ content: string; commentType: number; parentCommentId?: number }>;
  status?: string;
  threadContext?: CommentThread['threadContext'];
}

/**
 * 直接封装 ADO REST API 7.0（不引 azure-devops-node-api：
 * threads/comments 的编辑接口封装更直接，且 fetch 可注入便于测试）。
 */
export class AdoClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: { baseUrl: string; pat: string; fetchFn?: FetchFn }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`:${opts.pat}`).toString('base64');
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    apiVersion: string | null = '7.0',
  ): Promise<T> {
    const sep = urlPath.includes('?') ? '&' : '?';
    const url = apiVersion
      ? `${this.baseUrl}${urlPath}${sep}api-version=${apiVersion}`
      : `${this.baseUrl}${urlPath}`;
    const res = await this.fetchFn(url, {
      method,
      headers: {
        authorization: this.authHeader,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ADO API ${method} ${urlPath} 失败: HTTP ${res.status} ${text.slice(0, 500)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private prPath(pr: PrRef): string {
    return `/${encodeURIComponent(pr.project)}/_apis/git/repositories/${pr.repoId}/pullRequests/${pr.pullRequestId}`;
  }

  getPullRequest(pr: PrRef): Promise<AdoPrResource> {
    return this.request('GET', this.prPath(pr));
  }

  /** collection 级按 repoId 查 PR（1.0 扁平评论事件补全用，此时还不知道项目名） */
  getPullRequestById(repoId: string, pullRequestId: number): Promise<AdoPrResource> {
    return this.request('GET', `/_apis/git/repositories/${repoId}/pullRequests/${pullRequestId}`);
  }

  /** PR 关联的工作项引用（id 列表） */
  async getPrWorkItemRefs(pr: PrRef): Promise<number[]> {
    const res = await this.request<{ value?: Array<{ id: string }> }>(
      'GET',
      `${this.prPath(pr)}/workitems`,
    );
    return (res.value ?? []).map((w) => Number(w.id)).filter((n) => Number.isInteger(n));
  }

  /** 批量取工作项的标题/类型/描述/验收标准 */
  async getWorkItems(
    ids: number[],
  ): Promise<Array<{ id: number; type: string; title: string; description: string }>> {
    if (ids.length === 0) return [];
    const fields = [
      'System.Title',
      'System.WorkItemType',
      'System.Description',
      'Microsoft.VSTS.Common.AcceptanceCriteria',
    ].join(',');
    const res = await this.request<{
      value?: Array<{ id: number; fields?: Record<string, unknown> }>;
    }>('GET', `/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}`);
    return (res.value ?? []).map((w) => {
      const f = w.fields ?? {};
      const desc = [f['System.Description'], f['Microsoft.VSTS.Common.AcceptanceCriteria']]
        .filter((s) => typeof s === 'string' && s)
        .join('\n验收标准：');
      return {
        id: w.id,
        type: String(f['System.WorkItemType'] ?? ''),
        title: String(f['System.Title'] ?? ''),
        description: stripHtml(desc).slice(0, 1000),
      };
    });
  }

  /**
   * PAT 所属账号的 identity（用于启动时自动获取 BOT_ACCOUNT_ID）。
   * 实测 ADO Server 2022 的 connectionData 带 api-version 会返回 400，必须裸调。
   */
  async getAuthenticatedUser(): Promise<{ id: string; displayName?: string }> {
    const data = await this.request<{
      authenticatedUser?: { id?: string; providerDisplayName?: string; customDisplayName?: string };
    }>('GET', '/_apis/connectionData', undefined, null);
    const user = data.authenticatedUser;
    if (!user?.id) throw new Error('connectionData 未返回 authenticatedUser.id，请检查 ADO_PAT');
    return { id: user.id, displayName: user.customDisplayName ?? user.providerDisplayName };
  }

  getThreads(pr: PrRef): Promise<{ value: CommentThread[] }> {
    return this.request('GET', `${this.prPath(pr)}/threads`);
  }

  getThread(pr: PrRef, threadId: number): Promise<CommentThread> {
    return this.request('GET', `${this.prPath(pr)}/threads/${threadId}`);
  }

  createThread(pr: PrRef, body: ThreadCreateBody): Promise<CommentThread> {
    return this.request('POST', `${this.prPath(pr)}/threads`, body);
  }

  replyToThread(pr: PrRef, threadId: number, content: string): Promise<{ id: number }> {
    return this.request('POST', `${this.prPath(pr)}/threads/${threadId}/comments`, {
      content,
      commentType: 1,
    });
  }

  updateComment(pr: PrRef, threadId: number, commentId: number, content: string): Promise<void> {
    return this.request(
      'PATCH',
      `${this.prPath(pr)}/threads/${threadId}/comments/${commentId}`,
      { content },
    );
  }

  /** status: active | fixed | closed | wontFix | pending */
  updateThreadStatus(pr: PrRef, threadId: number, status: string): Promise<void> {
    return this.request('PATCH', `${this.prPath(pr)}/threads/${threadId}`, { status });
  }

  /** 更新总评 thread 的第一条评论 */
  async updateThreadFirstComment(pr: PrRef, threadId: number, content: string): Promise<boolean> {
    const thread = await this.getThread(pr, threadId).catch(() => undefined);
    const first = thread?.comments?.find((c) => !c.isDeleted);
    if (!first) return false;
    await this.updateComment(pr, threadId, first.id, content);
    return true;
  }

  /** state: pending | succeeded | failed | error */
  setPrStatus(
    pr: PrRef,
    opts: { state: string; description: string; targetUrl?: string },
  ): Promise<void> {
    return this.request('POST', `${this.prPath(pr)}/statuses`, {
      state: opts.state,
      description: opts.description,
      targetUrl: opts.targetUrl,
      context: { name: 'ai-review', genre: 'bot' },
    });
  }

  /** PR 页面地址（通知消息里用） */
  prWebUrl(pr: PrRef): string {
    return `${this.baseUrl}/${encodeURIComponent(pr.project)}/_git/${encodeURIComponent(pr.repoName)}/pullrequest/${pr.pullRequestId}`;
  }
}

/** 工作项描述是 HTML，转成纯文本注入提示词 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
