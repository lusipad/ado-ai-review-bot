import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerRoutes, isAuthorized, type AppDeps } from '../src/server';
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
  };
  const config = {
    webhookSecret: SECRET,
    botAccountId: BOT_ID,
    botDisplayName: 'ai-review-bot',
    adoUrl: 'https://ado.corp.local/DefaultCollection',
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
