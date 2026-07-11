import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerRoutes, isAuthorized, recoverPendingReviews, type AppDeps } from '../src/server';
import { Scheduler } from '../src/queue/scheduler';
import { StateDb } from '../src/state/db';
import type { Config } from '../src/config';
import type { Pipeline } from '../src/pipeline';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const SECRET = 'hook-secret';
const BOT_ID = '11111111-2222-3333-4444-555555555555';

function loadFixture(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

let tmpDir: string;
let app: FastifyInstance;
let db: StateDb;
let pipeline: {
  runFullReview: ReturnType<typeof vi.fn>;
  runIncrementalReview: ReturnType<typeof vi.fn>;
  runQa: ReturnType<typeof vi.fn>;
  runFix: ReturnType<typeof vi.fn>;
  runChatQa: ReturnType<typeof vi.fn>;
  runWorkItemDiscussion: ReturnType<typeof vi.fn>;
  chatQaAvailable: ReturnType<typeof vi.fn>;
};
let adoMock: { getPullRequestById: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-srv-'));
  db = new StateDb(path.join(tmpDir, 'state.db'));
  pipeline = {
    runFullReview: vi.fn().mockResolvedValue(undefined),
    runIncrementalReview: vi.fn().mockResolvedValue(undefined),
    runQa: vi.fn().mockResolvedValue(undefined),
    runFix: vi.fn().mockResolvedValue(undefined),
    runChatQa: vi.fn().mockResolvedValue(undefined),
    runWorkItemDiscussion: vi.fn().mockResolvedValue(undefined),
    chatQaAvailable: vi.fn().mockReturnValue(true),
  };
  const config = {
    webhookSecret: SECRET,
    botAccountId: BOT_ID,
    botDisplayName: 'ai-review-bot',
    adoUrl: 'https://ado.corp.local/DefaultCollection',
    dataDir: tmpDir,
    rocketchatOutgoingToken: 'rc-token',
    channelRepos: {},
  } as unknown as Config;
  adoMock = { getPullRequestById: vi.fn() };
  const scheduler = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 2, debounceMs: 30, logger: silentLogger });
  app = Fastify({ logger: false });
  registerRoutes(app, {
    config,
    db,
    scheduler,
    ado: adoMock,
    pipeline: pipeline as unknown as Pipeline,
  } as unknown as AppDeps);
});

afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const inject = (payload: unknown, headers: Record<string, string> = { 'x-webhook-secret': SECRET }) =>
  app.inject({ method: 'POST', url: '/webhook/ado', payload: payload as object, headers });

describe('webhook 接收器', () => {
  it('无密钥 → 401，任何任务都不触发', async () => {
    const res = await inject(loadFixture('pr-created.json'), {});
    expect(res.statusCode).toBe(401);
    expect(pipeline.runFullReview).not.toHaveBeenCalled();
  });

  it('basic auth 密码匹配也可通过', async () => {
    const basic = 'Basic ' + Buffer.from(`ado:${SECRET}`).toString('base64');
    const res = await inject(loadFixture('pr-created.json'), { authorization: basic });
    expect(res.statusCode).toBe(200);
  });

  it('PR created → 立即 ACK + 异步全量 review 入队', async () => {
    const res = await inject(loadFixture('pr-created.json'));
    expect(res.statusCode).toBe(200);
    expect(res.json().action).toBe('full_review');
    await vi.waitFor(() => expect(pipeline.runFullReview).toHaveBeenCalledTimes(1));
    // 状态已记录（后续 updated 事件可比对）
    expect(db.getPrState('Fabrikam/Fabrikam/1')?.lastSourceCommit).toBe(
      '53d54ac915144006c2c9e90d2c7d3880920db49c',
    );
  });

  it('push 更新 → 防抖后一次增量 review；同一 commit 的重复事件被忽略', async () => {
    // 先造出「已 review 过」的状态
    db.upsertPrState('Fabrikam/Fabrikam/1', { isDraft: false, lastSourceCommit: 'old-commit' });

    const push = loadFixture('pr-updated-push.json');
    const r1 = await inject(push);
    expect(r1.json().action).toBe('incremental_review');
    // 同一 commit 立刻再来一次（ADO 会重复发 updated）→ 路由层忽略
    const r2 = await inject(push);
    expect(r2.json().action).toBe('ignore');

    await vi.waitFor(() => expect(pipeline.runIncrementalReview).toHaveBeenCalledTimes(1), {
      timeout: 2000,
    });
    expect(pipeline.runFullReview).not.toHaveBeenCalled();
  });

  it('Server 2022 扁平评论事件（resourceVersion 1.0）→ 反查 PR 补全后正常路由', async () => {
    const full = loadFixture('pr-commented.json');
    // 1.0 形态：resource 就是 comment 本身，无 pullRequest 包装
    const flat = { ...full, resourceVersion: '1.0', resource: full.resource.comment };
    adoMock.getPullRequestById.mockResolvedValue(full.resource.pullRequest);

    const res = await inject(flat);
    expect(res.json().action).toBe('qa');
    expect(adoMock.getPullRequestById).toHaveBeenCalledWith('4bc14d40-c903-45e2-872e-0462c7748079', 1);
    await vi.waitFor(() => expect(pipeline.runQa).toHaveBeenCalledTimes(1));
    expect(pipeline.runQa.mock.calls[0][0]).toMatchObject({ threadId: 5 });
  });

  it('扁平评论事件补全失败 → ACK 但不触发任务', async () => {
    const full = loadFixture('pr-commented.json');
    const flat = { ...full, resourceVersion: '1.0', resource: full.resource.comment };
    adoMock.getPullRequestById.mockRejectedValue(new Error('ADO 404'));
    const res = await inject(flat);
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBe('hydrate failed');
    await new Promise((r) => setTimeout(r, 30));
    expect(pipeline.runQa).not.toHaveBeenCalled();
  });

  it('评论 @bot → 问答任务', async () => {
    const res = await inject(loadFixture('pr-commented.json'));
    expect(res.json().action).toBe('qa');
    await vi.waitFor(() => expect(pipeline.runQa).toHaveBeenCalledTimes(1));
    expect(pipeline.runQa.mock.calls[0][0]).toMatchObject({
      threadId: 5,
      question: '这里为什么有并发风险？',
    });
  });

  it('bot 自己的评论 → 忽略（无死循环）', async () => {
    const payload = loadFixture('pr-commented.json');
    payload.resource.comment.author.id = BOT_ID;
    const res = await inject(payload);
    expect(res.json().action).toBe('ignore');
    await new Promise((r) => setTimeout(r, 50));
    expect(pipeline.runQa).not.toHaveBeenCalled();
    expect(pipeline.runFullReview).not.toHaveBeenCalled();
  });

  it('评论 /fix → fix 任务入队（review 串行域）', async () => {
    const payload = loadFixture('pr-commented.json');
    payload.resource.comment.content = '/fix 按建议修复';
    const res = await inject(payload);
    expect(res.json().action).toBe('fix');
    await vi.waitFor(() => expect(pipeline.runFix).toHaveBeenCalledTimes(1));
    expect(pipeline.runFix.mock.calls[0][0]).toMatchObject({
      threadId: 5,
      instruction: '按建议修复',
    });
  });

  it('评论 /review → 手动全量（manual=true 可跳过 autoReview 关闭）', async () => {
    const payload = loadFixture('pr-commented.json');
    payload.resource.comment.content = '/review';
    const res = await inject(payload);
    expect(res.json().action).toBe('full_review');
    await vi.waitFor(() => expect(pipeline.runFullReview).toHaveBeenCalledTimes(1));
    expect(pipeline.runFullReview.mock.calls[0][2]).toBe(true); // manual
  });

  it('草稿 PR created → 只记录状态；健康检查可用', async () => {
    const payload = loadFixture('pr-created.json');
    payload.resource.isDraft = true;
    const res = await inject(payload);
    expect(res.json().action).toBe('record_draft');
    expect(db.getPrState('Fabrikam/Fabrikam/1')?.isDraft).toBe(true);
    expect(pipeline.runFullReview).not.toHaveBeenCalled();

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });

  it('PR 合并 → open findings 归档为 stale，基线对齐', async () => {
    const key = 'Fabrikam/Fabrikam/1';
    db.insertFinding({
      prKey: key, repoKey: 'Fabrikam/Fabrikam',
      fingerprint: 'fp-x', threadId: 9, severity: 'must-fix', file: 'a.ts', title: '未修的问题', line: 1,
    });
    const payload = loadFixture('pr-updated-push.json');
    payload.resource.status = 'completed';
    const res = await inject(payload);
    expect(res.json().action).toBe('pr_closed');
    expect(db.listOpenFindings(key)).toHaveLength(0);
    const acc = db.acceptanceByRepo('2000-01-01 00:00:00').find((r) => r.repoKey === 'Fabrikam/Fabrikam');
    expect(acc?.stale).toBe(1);
    // 基线对齐 → 恢复扫描不会再入队
    expect(db.listPrStatesNeedingReview().map((s) => s.prKey)).not.toContain(key);
  });

  it('草稿转正式（updated 且旧状态 isDraft=true）→ 全量 review', async () => {
    db.upsertPrState('Fabrikam/Fabrikam/1', { isDraft: true, lastSourceCommit: 'aaaa0000bbbb1111cccc2222dddd3333eeee4444' });
    const res = await inject(loadFixture('pr-updated-push.json'));
    expect(res.json().action).toBe('full_review');
  });
});

describe('isAuthorized', () => {
  it('长度不同的密钥直接拒绝', () => {
    expect(isAuthorized({ 'x-webhook-secret': 'x' }, SECRET)).toBe(false);
    expect(isAuthorized({ 'x-webhook-secret': SECRET }, SECRET)).toBe(true);
  });
});

describe('管理面板与重启恢复', () => {
  it('/admin 无凭据 → 401 + WWW-Authenticate（触发浏览器登录框）', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('/admin 带密码返回面板页面；/admin/api/overview 返回聚合数据', async () => {
    const basic = 'Basic ' + Buffer.from(`admin:${SECRET}`).toString('base64');
    const page = await app.inject({ method: 'GET', url: '/admin', headers: { authorization: basic } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('管理面板');

    db.insertReviewRun({
      prKey: 'P/R/1', repoKey: 'P/R', kind: 'full', ok: true, durationMs: 500,
      findingsTotal: 1, findingsPosted: 1, mustFix: 0, droppedByChallenge: 0, degraded: false,
    });
    const api = await app.inject({ method: 'GET', url: '/admin/api/overview?days=7', headers: { authorization: basic } });
    expect(api.statusCode).toBe(200);
    const body = api.json();
    expect(body.queue).toMatchObject({ running: 0, draining: false });
    expect(Array.isArray(body.queue.runningKeys)).toBe(true);
    expect(body.stats.overview.runs).toBe(1);
    expect(body.recentRuns).toHaveLength(1);
  });

  it('recoverPendingReviews：落后的 PR 重新入队增量 review', async () => {
    db.upsertPrState('Fabrikam/Fabrikam/9', {
      isDraft: false,
      lastSourceCommit: 'abc123',
      lastReviewedCommit: 'old000',
      repoId: 'repo-guid-9',
      remoteUrl: 'https://ado.corp.local/DefaultCollection/Fabrikam/_git/Fabrikam',
    });
    const scheduler = new Scheduler({ reviewConcurrency: 2, qaConcurrency: 1, debounceMs: 10, logger: silentLogger });
    const n = recoverPendingReviews(
      { db, scheduler, pipeline: pipeline as unknown as Pipeline } as unknown as AppDeps,
      silentLogger,
    );
    expect(n).toBe(1);
    await vi.waitFor(() => expect(pipeline.runIncrementalReview).toHaveBeenCalledTimes(1));
    expect(pipeline.runIncrementalReview.mock.calls[0][0]).toMatchObject({
      project: 'Fabrikam',
      repoName: 'Fabrikam',
      pullRequestId: 9,
      repoId: 'repo-guid-9',
    });
  });
});

describe('RocketChat 双向问答', () => {
  const post = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/webhook/rocketchat', payload: payload as object });

  it('token 不对 → 401', async () => {
    const res = await post({ token: 'wrong', text: '状态' });
    expect(res.statusCode).toBe(401);
  });

  it('bot 消息 → 不回应（防回环）', async () => {
    const res = await post({ token: 'rc-token', text: '状态', bot: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBeUndefined();
  });

  it('命令响应 + trigger word/@ 前缀剥离', async () => {
    const res = await post({ token: 'rc-token', text: '!review @ai-review-bot 状态', trigger_word: '!review', user_name: 'lus' });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toContain('当前状态');

    // 无 channel_id 的自由文本 → 退回帮助
    const help = await post({ token: 'rc-token', text: '!review 你好', trigger_word: '!review' });
    expect(help.json().text).toContain('我能回答');
  });

  it('自由问答：带 channel_id 且能定位仓库 → 异步 runChatQa（线程锚定）', async () => {
    db.insertReviewRun({
      prKey: 'Proj/Repo/1', repoKey: 'Proj/Repo', kind: 'full', ok: true, durationMs: 1,
      findingsTotal: 0, findingsPosted: 0, mustFix: 0, droppedByChallenge: 0, degraded: false,
    });
    const res = await post({
      token: 'rc-token',
      text: '@review-bot 结算模块有没有并发风险？',
      channel_id: 'room-1',
      channel_name: 'dev',
      message_id: 'msg-7',
      user_name: 'lus',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toBeUndefined(); // 占位走 REST，不走同步应答
    await vi.waitFor(() => expect(pipeline.runChatQa).toHaveBeenCalledTimes(1));
    expect(pipeline.runChatQa.mock.calls[0][0]).toMatchObject({
      repoKey: 'Proj/Repo',
      roomId: 'room-1',
      tmid: 'msg-7',
      userName: 'lus',
      question: '结算模块有没有并发风险？',
    });
  });

  it('工作项命令 → runWorkItemDiscussion（带追加问题与兜底仓库）', async () => {
    db.insertReviewRun({
      prKey: 'P/R/1', repoKey: 'P/R', kind: 'full', ok: true, durationMs: 1,
      findingsTotal: 0, findingsPosted: 0, mustFix: 0, droppedByChallenge: 0, degraded: false,
    });
    const res = await post({
      token: 'rc-token',
      text: '工作项 #1234 这个需求要怎么拆？',
      channel_id: 'room-9',
      channel_name: 'dev',
      message_id: 'msg-3',
      user_name: 'lus',
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(pipeline.runWorkItemDiscussion).toHaveBeenCalledTimes(1));
    expect(pipeline.runWorkItemDiscussion.mock.calls[0][0]).toMatchObject({
      workItemId: 1234,
      extraQuestion: '这个需求要怎么拆？',
      roomId: 'room-9',
      tmid: 'msg-3',
      fallbackRepoKey: 'P/R',
    });
  });

  it('自由问答：讨论前缀强制开讨论；定位不了仓库给 hint', async () => {
    db.insertReviewRun({
      prKey: 'A/B/1', repoKey: 'A/B', kind: 'full', ok: true, durationMs: 1,
      findingsTotal: 0, findingsPosted: 0, mustFix: 0, droppedByChallenge: 0, degraded: false,
    });
    db.insertReviewRun({
      prKey: 'C/D/1', repoKey: 'C/D', kind: 'full', ok: true, durationMs: 1,
      findingsTotal: 0, findingsPosted: 0, mustFix: 0, droppedByChallenge: 0, degraded: false,
    });
    const hint = await post({ token: 'rc-token', text: '架构怎么样', channel_id: 'r', channel_name: 'x', message_id: 'm' });
    expect(hint.json().text).toContain('带上仓库名');

    const res = await post({ token: 'rc-token', text: '讨论 A/B 的整体架构', channel_id: 'r', channel_name: 'x', message_id: 'm' });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(pipeline.runChatQa).toHaveBeenCalled());
    expect(pipeline.runChatQa.mock.calls.at(-1)![0]).toMatchObject({ repoKey: 'A/B', forceDiscussion: true });
  });
});

describe('/stats', () => {
  it('无密钥 401；带密钥返回聚合统计', async () => {
    db.insertReviewRun({
      prKey: 'P/R/1',
      repoKey: 'P/R',
      kind: 'full',
      ok: true,
      durationMs: 1200,
      findingsTotal: 3,
      findingsPosted: 2,
      mustFix: 1,
      droppedByChallenge: 1,
      degraded: false,
    });

    const noAuth = await app.inject({ method: 'GET', url: '/stats' });
    expect(noAuth.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/stats?days=7',
      headers: { 'x-webhook-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.windowDays).toBe(7);
    expect(body.overview).toMatchObject({ runs: 1, findingsPosted: 2, mustFix: 1, droppedByChallenge: 1 });
    expect(Array.isArray(body.acceptanceByRepo)).toBe(true);
  });
});
