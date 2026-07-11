import type { PrRef } from '../types';

// ---- Service Hook payload 类型（只声明用到的字段） ----

export interface AdoIdentity {
  id: string;
  displayName?: string;
  uniqueName?: string;
}

export interface AdoPrResource {
  repository: {
    id: string;
    name: string;
    project: { id: string; name: string };
    remoteUrl?: string;
    webUrl?: string;
  };
  pullRequestId: number;
  status: string; // active | completed | abandoned
  isDraft?: boolean;
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeTargetCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
  createdBy?: AdoIdentity;
}

export interface AdoCommentResource {
  comment: {
    id: number;
    parentCommentId?: number;
    content?: string;
    commentType?: string;
    author: AdoIdentity;
    _links?: { threads?: { href?: string }; [k: string]: { href?: string } | undefined };
  };
  pullRequest: AdoPrResource;
}

export interface ServiceHookEvent {
  eventType: string;
  resource: AdoPrResource | AdoCommentResource | Record<string, unknown>;
}

export const EVENT_PR_CREATED = 'git.pullrequest.created';
export const EVENT_PR_UPDATED = 'git.pullrequest.updated';
export const EVENT_PR_COMMENTED = 'ms.vss-code.git-pullrequest-comment-event';

// ---- 路由结果 ----

export type RouteAction =
  | { type: 'full_review'; pr: PrInfo; reason: string }
  | { type: 'incremental_review'; pr: PrInfo }
  | { type: 'record_draft'; pr: PrInfo }
  | { type: 'qa'; pr: PrInfo; threadId: number; commentId: number; question: string }
  | { type: 'fix'; pr: PrInfo; threadId: number; commentId: number; instruction: string }
  | { type: 'pr_closed'; pr: PrInfo; closedStatus: 'completed' | 'abandoned' }
  | { type: 'ignore'; reason: string };

export interface PrInfo extends PrRef {
  isDraft: boolean;
  status: string;
  title: string;
  description: string;
  sourceRefName: string;
  targetRefName: string;
  sourceCommit?: string;
  targetCommit?: string;
  mergeCommit?: string;
  /** PR 作者（通知 @ 人用） */
  createdBy?: { displayName?: string; uniqueName?: string };
}

export interface RouteContext {
  botAccountId: string;
  botDisplayName: string;
  /** SQLite 中该 PR 的既有状态；从未见过则 undefined */
  priorState?: { isDraft: boolean; lastSourceCommit?: string };
}

export function parsePrResource(res: AdoPrResource, adoUrl: string): PrInfo {
  const project = res.repository.project.name;
  const repoName = res.repository.name;
  return {
    project,
    repoId: res.repository.id,
    repoName,
    pullRequestId: res.pullRequestId,
    remoteUrl:
      res.repository.remoteUrl ??
      `${adoUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}`,
    isDraft: res.isDraft === true,
    status: res.status,
    title: res.title ?? '',
    description: res.description ?? '',
    sourceRefName: res.sourceRefName ?? '',
    targetRefName: res.targetRefName ?? '',
    sourceCommit: res.lastMergeSourceCommit?.commitId,
    targetCommit: res.lastMergeTargetCommit?.commitId,
    mergeCommit: res.lastMergeCommit?.commitId,
    createdBy: res.createdBy
      ? { displayName: res.createdBy.displayName, uniqueName: res.createdBy.uniqueName }
      : undefined,
  };
}

/** ADO 富文本 mention 持久化格式：@<GUID>；同时兼容纯文本 @显示名 */
export function mentionsBot(content: string, ctx: RouteContext): boolean {
  const guidMention = new RegExp(`@<${escapeRegExp(ctx.botAccountId)}>`, 'i');
  const nameMention = new RegExp(`@${escapeRegExp(ctx.botDisplayName)}\\b`, 'i');
  return guidMention.test(content) || nameMention.test(content);
}

/** 去掉 mention 标记，留下用户真正的问题文本 */
export function stripMentions(content: string, ctx: RouteContext): string {
  return content
    .replace(new RegExp(`@<${escapeRegExp(ctx.botAccountId)}>`, 'gi'), '')
    .replace(new RegExp(`@${escapeRegExp(ctx.botDisplayName)}\\b`, 'gi'), '')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 comment._links.threads.href 提取 threadId */
export function threadIdFromComment(comment: AdoCommentResource['comment']): number | undefined {
  const href = comment._links?.threads?.href;
  const m = href?.match(/\/threads\/(\d+)/i);
  return m ? Number(m[1]) : undefined;
}

/**
 * ADO Server 2022 实测：评论事件只有 resourceVersion 1.0 会投递（2.0 显示支持但从不触发），
 * 且 1.0 的 resource 是扁平的 comment 对象（无 pullRequest 包装）。
 * 识别这种形态并提取 repoId/prId，调用方据此反查 PR 后重组为 2.0 形态再路由。
 */
export function flatCommentRef(
  resource: Record<string, unknown>,
): { repoId: string; pullRequestId: number } | undefined {
  if ((resource as unknown as AdoCommentResource).pullRequest) return undefined; // 已是 2.0 形态
  const comment = resource as unknown as AdoCommentResource['comment'];
  if (typeof comment?.id !== 'number' || !comment._links) return undefined;
  const href = comment._links.threads?.href ?? '';
  const m = href.match(/\/repositories\/([0-9a-f-]+)\/pullRequests\/(\d+)\//i);
  if (!m) return undefined;
  return { repoId: m[1], pullRequestId: Number(m[2]) };
}

export function routeEvent(
  event: ServiceHookEvent,
  ctx: RouteContext,
  adoUrl: string,
): RouteAction {
  switch (event.eventType) {
    case EVENT_PR_CREATED: {
      const pr = parsePrResource(event.resource as AdoPrResource, adoUrl);
      if (pr.status !== 'active') return { type: 'ignore', reason: `PR 状态 ${pr.status}` };
      if (pr.isDraft) return { type: 'record_draft', pr };
      return { type: 'full_review', pr, reason: 'PR 创建' };
    }

    case EVENT_PR_UPDATED: {
      const pr = parsePrResource(event.resource as AdoPrResource, adoUrl);
      // 合并/放弃 → 收尾归档（findings 置 stale、取消排队任务）
      if (pr.status === 'completed' || pr.status === 'abandoned') {
        return { type: 'pr_closed', pr, closedStatus: pr.status };
      }
      if (pr.status !== 'active') return { type: 'ignore', reason: `PR 状态 ${pr.status}` };
      const prior = ctx.priorState;

      // 草稿 → 正式
      if (prior?.isDraft && !pr.isDraft) return { type: 'full_review', pr, reason: '草稿转正式' };
      if (pr.isDraft) return { type: 'record_draft', pr };

      // 防御性核对：updated 事件也会因投票/reviewer 变更触发，
      // 只有源 commit 真的变了才算 push
      if (!pr.sourceCommit) return { type: 'ignore', reason: '事件缺少 lastMergeSourceCommit' };
      if (prior?.lastSourceCommit === pr.sourceCommit)
        return { type: 'ignore', reason: '源分支 commit 未变化' };
      // 从没 review 过（bot 上线前建的 PR 等）→ 全量
      if (!prior?.lastSourceCommit) return { type: 'full_review', pr, reason: '首次遇到该 PR 的更新' };
      return { type: 'incremental_review', pr };
    }

    case EVENT_PR_COMMENTED: {
      const res = event.resource as AdoCommentResource;
      const pr = parsePrResource(res.pullRequest, adoUrl);
      const comment = res.comment;
      const content = comment.content ?? '';

      // bot 自己的评论 → 忽略，防自触发循环
      if (comment.author?.id?.toLowerCase() === ctx.botAccountId.toLowerCase())
        return { type: 'ignore', reason: 'bot 自身评论' };

      const stripped = stripMentions(content, ctx);
      if (/^\/review\b/i.test(stripped) || /^\/review\b/i.test(content.trim()))
        return { type: 'full_review', pr, reason: '/review 命令' };

      // /fix [额外指示]：在当前线程语境下让 bot 实施修复（可带 @bot 前缀）
      const fixMatch = /^\/fix\b\s*([\s\S]*)/i.exec(stripped) ?? /^\/fix\b\s*([\s\S]*)/i.exec(content.trim());
      if (fixMatch) {
        const threadId = threadIdFromComment(comment);
        if (!threadId) return { type: 'ignore', reason: '评论事件缺少 thread 链接' };
        return { type: 'fix', pr, threadId, commentId: comment.id, instruction: fixMatch[1].trim() };
      }

      if (mentionsBot(content, ctx)) {
        const threadId = threadIdFromComment(comment);
        if (!threadId) return { type: 'ignore', reason: '评论事件缺少 thread 链接' };
        if (!stripped) return { type: 'ignore', reason: '@bot 但没有问题内容' };
        return { type: 'qa', pr, threadId, commentId: comment.id, question: stripped };
      }

      return { type: 'ignore', reason: '普通评论' };
    }

    default:
      return { type: 'ignore', reason: `未订阅的事件类型 ${event.eventType}` };
  }
}
