import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  routeEvent,
  mentionsBot,
  stripMentions,
  type ServiceHookEvent,
  type RouteContext,
  type AdoCommentResource,
} from '../src/ado/events';

const ADO_URL = 'https://ado.corp.local/DefaultCollection';
const BOT_ID = '11111111-2222-3333-4444-555555555555';

const ctx = (prior?: RouteContext['priorState']): RouteContext => ({
  botAccountId: BOT_ID,
  botDisplayName: 'ai-review-bot',
  priorState: prior,
});

function loadFixture(name: string): ServiceHookEvent {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'),
  ) as ServiceHookEvent;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

describe('routeEvent: git.pullrequest.created', () => {
  it('非草稿 PR 创建 → 全量 review', () => {
    const action = routeEvent(loadFixture('pr-created.json'), ctx(), ADO_URL);
    expect(action.type).toBe('full_review');
    if (action.type === 'full_review') {
      expect(action.pr.project).toBe('Fabrikam');
      expect(action.pr.pullRequestId).toBe(1);
      expect(action.pr.sourceCommit).toBe('53d54ac915144006c2c9e90d2c7d3880920db49c');
      expect(action.pr.mergeCommit).toBe('eef717f69257a6333f221566c1c987dc94cc0d72');
    }
  });

  it('草稿 PR 创建 → 只记录状态', () => {
    const event = clone(loadFixture('pr-created.json'));
    (event.resource as { isDraft: boolean }).isDraft = true;
    expect(routeEvent(event, ctx(), ADO_URL).type).toBe('record_draft');
  });

  it('非 active PR → 忽略', () => {
    const event = clone(loadFixture('pr-created.json'));
    (event.resource as { status: string }).status = 'completed';
    expect(routeEvent(event, ctx(), ADO_URL).type).toBe('ignore');
  });
});

describe('routeEvent: git.pullrequest.updated', () => {
  const updated = () => loadFixture('pr-updated-push.json');

  it('草稿转正式 → 全量 review', () => {
    const action = routeEvent(
      updated(),
      ctx({ isDraft: true, lastSourceCommit: 'aaaa0000bbbb1111cccc2222dddd3333eeee4444' }),
      ADO_URL,
    );
    expect(action.type).toBe('full_review');
  });

  it('源 commit 变化且有基线 → 增量 review', () => {
    const action = routeEvent(updated(), ctx({ isDraft: false, lastSourceCommit: 'oldcommit' }), ADO_URL);
    expect(action.type).toBe('incremental_review');
  });

  it('源 commit 未变化（投票/reviewer 等触发的 updated）→ 忽略', () => {
    const action = routeEvent(
      updated(),
      ctx({ isDraft: false, lastSourceCommit: 'aaaa0000bbbb1111cccc2222dddd3333eeee4444' }),
      ADO_URL,
    );
    expect(action.type).toBe('ignore');
  });

  it('从未见过该 PR 的更新 → 全量 review（补偿错过的 created）', () => {
    expect(routeEvent(updated(), ctx(undefined), ADO_URL).type).toBe('full_review');
  });

  it('仍是草稿 → 只记录状态', () => {
    const event = clone(updated());
    (event.resource as { isDraft: boolean }).isDraft = true;
    expect(routeEvent(event, ctx({ isDraft: true }), ADO_URL).type).toBe('record_draft');
  });
});

describe('routeEvent: 评论事件', () => {
  const commented = () => loadFixture('pr-commented.json');
  const setComment = (event: ServiceHookEvent, patch: Record<string, unknown>) => {
    const res = event.resource as unknown as AdoCommentResource;
    Object.assign(res.comment, patch);
    return event;
  };

  it('@bot（GUID mention 格式）→ 问答，问题去掉 mention', () => {
    const action = routeEvent(commented(), ctx(), ADO_URL);
    expect(action.type).toBe('qa');
    if (action.type === 'qa') {
      expect(action.threadId).toBe(5);
      expect(action.commentId).toBe(2);
      expect(action.question).toBe('这里为什么有并发风险？');
    }
  });

  it('@bot（纯文本显示名）→ 问答', () => {
    const event = setComment(clone(commented()), { content: '@ai-review-bot 解释这个文件' });
    const action = routeEvent(event, ctx(), ADO_URL);
    expect(action.type).toBe('qa');
    if (action.type === 'qa') expect(action.question).toBe('解释这个文件');
  });

  it('bot 自己的评论 → 忽略（防自触发循环）', () => {
    const event = setComment(clone(commented()), {
      author: { id: BOT_ID, displayName: 'ai-review-bot' },
    });
    expect(routeEvent(event, ctx(), ADO_URL).type).toBe('ignore');
  });

  it('/review 命令 → 手动全量 review', () => {
    const event = setComment(clone(commented()), { content: '/review' });
    const action = routeEvent(event, ctx(), ADO_URL);
    expect(action.type).toBe('full_review');
    if (action.type === 'full_review') expect(action.reason).toBe('/review 命令');
  });

  it('/fix 命令 → fix 任务，带线程与额外指示', () => {
    const event = setComment(clone(commented()), { content: '/fix 顺便把日志级别改成 warn' });
    const action = routeEvent(event, ctx(), ADO_URL);
    expect(action.type).toBe('fix');
    if (action.type === 'fix') {
      expect(action.threadId).toBe(5);
      expect(action.instruction).toBe('顺便把日志级别改成 warn');
    }
  });

  it('@bot /fix（带 mention 前缀）→ fix 任务', () => {
    const event = setComment(clone(commented()), { content: `@<${BOT_ID}> /fix` });
    const action = routeEvent(event, ctx(), ADO_URL);
    expect(action.type).toBe('fix');
    if (action.type === 'fix') expect(action.instruction).toBe('');
  });

  it('普通评论（不含 @bot / 命令）→ 忽略', () => {
    const event = setComment(clone(commented()), { content: 'LGTM 👍' });
    expect(routeEvent(event, ctx(), ADO_URL).type).toBe('ignore');
  });

  it('@bot 但没有问题内容 → 忽略', () => {
    const event = setComment(clone(commented()), { content: `@<${BOT_ID}>` });
    expect(routeEvent(event, ctx(), ADO_URL).type).toBe('ignore');
  });
});

describe('mention 工具函数', () => {
  it('大小写不敏感', () => {
    expect(mentionsBot(`@<${BOT_ID.toUpperCase()}> hi`, ctx())).toBe(true);
    expect(mentionsBot('@AI-Review-Bot hi', ctx())).toBe(true);
  });

  it('显示名必须整词匹配', () => {
    expect(mentionsBot('@ai-review-botx hi', ctx())).toBe(false);
  });

  it('stripMentions 去掉两种 mention 形式', () => {
    expect(stripMentions(`@<${BOT_ID}> @ai-review-bot 问题`, ctx())).toBe('问题');
  });
});

describe('未知事件类型', () => {
  it('忽略', () => {
    const action = routeEvent({ eventType: 'build.complete', resource: {} }, ctx(), ADO_URL);
    expect(action.type).toBe('ignore');
  });
});
