import { describe, expect, it } from 'vitest';
import { AdoClient } from '../src/ado/client';
import type { PrRef } from '../src/types';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

function mockFetch(responses: Array<{ status?: number; json?: unknown }>): {
  calls: Captured[];
  fetchFn: typeof fetch;
} {
  const calls: Captured[] = [];
  const fetchFn = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)] ?? {};
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const pr: PrRef = {
  project: 'My Proj',
  repoId: '4bc14d40-c903-45e2-872e-0462c7748079',
  repoName: 'Fabrikam',
  pullRequestId: 7,
  remoteUrl: 'https://ado.corp.local/DefaultCollection/My%20Proj/_git/Fabrikam',
};

const BASE = 'https://ado.corp.local/DefaultCollection';

function client(fetchFn: typeof fetch): AdoClient {
  return new AdoClient({ baseUrl: BASE, pat: 'secret-pat', fetchFn });
}

describe('AdoClient', () => {
  it('URL 结构 + api-version + PAT basic auth', async () => {
    const { calls, fetchFn } = mockFetch([{ json: { pullRequestId: 7 } }]);
    await client(fetchFn).getPullRequest(pr);
    expect(calls[0].url).toBe(
      `${BASE}/My%20Proj/_apis/git/repositories/${pr.repoId}/pullRequests/7?api-version=7.0`,
    );
    const expected = 'Basic ' + Buffer.from(':secret-pat').toString('base64');
    expect(calls[0].headers.authorization).toBe(expected);
  });

  it('createThread 提交 threadContext 与评论', async () => {
    const { calls, fetchFn } = mockFetch([{ json: { id: 9 } }]);
    const thread = await client(fetchFn).createThread(pr, {
      comments: [{ content: 'hi', commentType: 1 }],
      status: 'active',
      threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 3 }, rightFileEnd: { line: 3 } },
    });
    expect(thread.id).toBe(9);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/threads?api-version=7.0');
    expect(calls[0].body.threadContext.filePath).toBe('/src/a.ts');
  });

  it('replyToThread / updateComment / updateThreadStatus 的路径与方法', async () => {
    const { calls, fetchFn } = mockFetch([{ json: { id: 2 } }, { json: {} }, { json: {} }]);
    const c = client(fetchFn);
    await c.replyToThread(pr, 5, '回复');
    await c.updateComment(pr, 5, 2, '编辑后');
    await c.updateThreadStatus(pr, 5, 'fixed');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/threads/5/comments?');
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toContain('/threads/5/comments/2?');
    expect(calls[2].method).toBe('PATCH');
    expect(calls[2].url).toContain('/threads/5?');
    expect(calls[2].body).toEqual({ status: 'fixed' });
  });

  it('setPrStatus 带 ai-review context', async () => {
    const { calls, fetchFn } = mockFetch([{ json: {} }]);
    await client(fetchFn).setPrStatus(pr, { state: 'pending', description: '进行中' });
    expect(calls[0].url).toContain('/statuses?');
    expect(calls[0].body.context).toEqual({ name: 'ai-review', genre: 'bot' });
  });

  it('updateThreadFirstComment 编辑第一条未删除评论', async () => {
    const { calls, fetchFn } = mockFetch([
      { json: { id: 5, comments: [{ id: 1, isDeleted: true }, { id: 2, content: 'old' }] } },
      { json: {} },
    ]);
    const ok = await client(fetchFn).updateThreadFirstComment(pr, 5, 'new content');
    expect(ok).toBe(true);
    expect(calls[1].url).toContain('/threads/5/comments/2?');
    expect(calls[1].body).toEqual({ content: 'new content' });
  });

  it('getAuthenticatedUser 走 collection 级 connectionData（不带 api-version，Server 2022 带了会 400）', async () => {
    const { calls, fetchFn } = mockFetch([
      { json: { authenticatedUser: { id: 'guid-1', providerDisplayName: 'ai-review-bot' } } },
    ]);
    const user = await client(fetchFn).getAuthenticatedUser();
    expect(calls[0].url).toBe(`${BASE}/_apis/connectionData`);
    expect(user).toEqual({ id: 'guid-1', displayName: 'ai-review-bot' });
  });

  it('getAuthenticatedUser 缺少 id 时报错提示检查 PAT', async () => {
    const { fetchFn } = mockFetch([{ json: {} }]);
    await expect(client(fetchFn).getAuthenticatedUser()).rejects.toThrow('ADO_PAT');
  });

  it('getPrWorkItemRefs + getWorkItems：字段选择与 HTML 转纯文本', async () => {
    const { calls, fetchFn } = mockFetch([
      { json: { value: [{ id: '12' }, { id: 'x' }] } },
      {
        json: {
          value: [
            {
              id: 12,
              fields: {
                'System.WorkItemType': 'Bug',
                'System.Title': '折扣算错',
                'System.Description': '<div>第一行<br/>第二行&nbsp;&amp;&lt;end&gt;</div>',
              },
            },
          ],
        },
      },
    ]);
    const c = client(fetchFn);
    const ids = await c.getPrWorkItemRefs(pr);
    expect(ids).toEqual([12]); // 非数字 id 被过滤
    expect(calls[0].url).toContain(`/pullRequests/7/workitems?`);

    const items = await c.getWorkItems(ids);
    expect(calls[1].url).toContain('/_apis/wit/workitems?ids=12&fields=System.Title');
    expect(items[0]).toMatchObject({ id: 12, type: 'Bug', title: '折扣算错' });
    expect(items[0].description).toBe('第一行\n第二行 &<end>');

    expect(await c.getWorkItems([])).toEqual([]); // 空列表不发请求
    expect(calls).toHaveLength(2);
  });

  it('非 2xx 抛出带状态码的错误', async () => {
    const { fetchFn } = mockFetch([{ status: 403, json: { message: 'denied' } }]);
    await expect(client(fetchFn).getPullRequest(pr)).rejects.toThrow('HTTP 403');
  });

  it('prWebUrl 生成 PR 页面地址', () => {
    const { fetchFn } = mockFetch([]);
    expect(client(fetchFn).prWebUrl(pr)).toBe(`${BASE}/My%20Proj/_git/Fabrikam/pullrequest/7`);
  });
});
