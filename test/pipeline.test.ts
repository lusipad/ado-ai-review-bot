import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pipeline } from '../src/pipeline';
import { StateDb } from '../src/state/db';
import { Workspace } from '../src/repo/workspace';
import { AdoClient } from '../src/ado/client';
import { NotifyDispatcher } from '../src/notify';
import type { Config } from '../src/config';
import type { PrInfo } from '../src/ado/events';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------- 本地 git 仓库（模拟 ADO 上的仓库） ----------

let tmpRoot: string;
let originDir: string;
let mainHead: string;
let featureHead: string;
let mergeHead: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-e2e-'));
  originDir = path.join(tmpRoot, 'origin');
  fs.mkdirSync(originDir);
  git(originDir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(originDir, 'app.ts'), 'export function add(a: number, b: number) { return a + b; }\n');
  git(originDir, 'add', '.');
  git(originDir, 'commit', '-m', 'init');
  mainHead = git(originDir, 'rev-parse', 'HEAD');

  git(originDir, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(originDir, 'app.ts'), 'export function add(a: number, b: number, c = 0) { return a + b + c; }\n');
  git(originDir, 'add', '.');
  git(originDir, 'commit', '-m', 'change signature');
  featureHead = git(originDir, 'rev-parse', 'HEAD');

  // 模拟 ADO 的预合并 commit（refs/pull/N/merge）
  git(originDir, 'checkout', '-b', 'pr-merge', 'main');
  git(originDir, 'merge', '--no-ff', 'feature', '-m', 'merge PR');
  mergeHead = git(originDir, 'rev-parse', 'HEAD');
  git(originDir, 'checkout', 'main');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- mock ADO REST ----------

interface AdoCall {
  method: string;
  url: string;
  body?: any;
}

function makeMockAdo(prResource: () => Record<string, unknown>) {
  const calls: AdoCall[] = [];
  const threads = new Map<number, any>();
  let threadSeq = 100;
  let commentSeq = 1000;

  const json = (obj: unknown) =>
    new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

  const fetchFn = (async (url: any, init: any) => {
    const method = init?.method ?? 'GET';
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: u, body });

    if (method === 'GET' && /pullRequests\/\d+\?api-version/.test(u)) return json(prResource());
    if (method === 'POST' && /\/threads\?api-version/.test(u)) {
      const id = ++threadSeq;
      const thread = {
        id,
        status: body.status,
        threadContext: body.threadContext,
        comments: body.comments.map((c: any, i: number) => ({ id: i + 1, ...c })),
      };
      threads.set(id, thread);
      return json(thread);
    }
    const threadComment = u.match(/\/threads\/(\d+)\/comments\?api-version/);
    if (method === 'POST' && threadComment) {
      const id = ++commentSeq;
      const t = threads.get(Number(threadComment[1]));
      t?.comments?.push({ id, content: body.content });
      return json({ id });
    }
    const threadGet = u.match(/\/threads\/(\d+)\?api-version/);
    if (method === 'GET' && threadGet) {
      const t = threads.get(Number(threadGet[1]));
      if (t) return json(t);
      // QA 场景：bot 未创建过的既有线程
      return json({
        id: Number(threadGet[1]),
        comments: [
          { id: 1, content: '这里为什么要加参数 c？', author: { id: 'user-1', displayName: '开发者' } },
        ],
        threadContext: { filePath: '/app.ts', rightFileStart: { line: 1 }, rightFileEnd: { line: 1 } },
      });
    }
    if (method === 'PATCH') return json({});
    if (method === 'POST' && /\/statuses\?api-version/.test(u)) return json({});
    return json({});
  }) as typeof fetch;

  return { calls, fetchFn, threads };
}

// ---------- 组装 ----------

function makeConfig(dataDir: string): Config {
  return {
    host: '0.0.0.0',
    port: 0,
    adoUrl: 'https://ado.corp.local/DefaultCollection',
    adoPat: '',
    webhookSecret: 's',
    botAccountId: '11111111-2222-3333-4444-555555555555',
    botDisplayName: 'ai-review-bot',
    debounceMs: 10,
    reviewConcurrency: 2,
    qaConcurrency: 2,
    dataDir,
    codexBin: 'codex',
    codexTimeoutMs: 60_000,
    codexSandbox: 'read-only',
    codexExtraArgs: [],
    maxInlineComments: 10,
    maxChangedFiles: 50,
    promptsDir: path.resolve(__dirname, '..', 'prompts'),
    notify: { rocketchatWebhookUrl: 'https://chat.local/hooks/x', events: ['review_completed', 'must_fix_found', 'job_failed'] },
    repoOverrides: {},
  };
}

describe('Pipeline 端到端（本地 git + mock ADO + 假 codex）', () => {
  const prInfo = (source: string, merge?: string): PrInfo => ({
    project: 'Proj',
    repoId: 'repo-guid',
    repoName: 'Repo',
    pullRequestId: 1,
    remoteUrl: originDir,
    isDraft: false,
    status: 'active',
    title: '改造 add 函数',
    description: '加第三个参数',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    sourceCommit: source,
    targetCommit: mainHead,
    mergeCommit: merge,
  });

  const prResourceOf = (pr: PrInfo) => ({
    repository: {
      id: pr.repoId,
      name: pr.repoName,
      project: { id: 'p', name: pr.project },
      remoteUrl: pr.remoteUrl,
    },
    pullRequestId: pr.pullRequestId,
    status: pr.status,
    isDraft: pr.isDraft,
    title: pr.title,
    description: pr.description,
    sourceRefName: pr.sourceRefName,
    targetRefName: pr.targetRefName,
    lastMergeSourceCommit: { commitId: pr.sourceCommit },
    lastMergeTargetCommit: { commitId: pr.targetCommit },
    ...(pr.mergeCommit ? { lastMergeCommit: { commitId: pr.mergeCommit } } : {}),
  });

  it('全量 → 增量修复关线程 → QA 的完整链路', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-data-'));
    const config = makeConfig(dataDir);
    let currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));
    const notifyCalls: any[] = [];
    const notifyFetch = (async (url: any, init: any) => {
      notifyCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, notifyFetch);

    const codexPrompts: string[] = [];
    const codexWorktrees: string[] = [];
    let codexResponse = '';
    const codexRun = async (worktree: string, prompt: string) => {
      codexPrompts.push(prompt);
      codexWorktrees.push(worktree);
      // agent 应看到合并后的完整代码
      expect(fs.existsSync(path.join(worktree, 'app.ts'))).toBe(true);
      return { ok: true, output: codexResponse };
    };

    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });
    const key = 'Proj/Repo/1';

    // ---------- 阶段 1：全量 review ----------
    codexResponse = JSON.stringify({
      summary: '整体改动合理，但存在一个签名兼容性问题。',
      walkthrough: '- app.ts — add 增加第三个参数',
      riskLevel: 'medium',
      findings: [
        { file: 'app.ts', line: 1, severity: 'must-fix', title: '调用方未更新', detail: '有调用方仍按两个参数调用。' },
        { file: 'app.ts', line: 1, severity: 'nit', title: '缺少 JSDoc', detail: '建议补充注释。' },
      ],
      resolvedThreadIds: [],
    });
    await pipeline.runFullReview(currentPr, 'PR 创建');

    // 提示词包含 PR 元信息与 diff
    expect(codexPrompts[0]).toContain('改造 add 函数');
    expect(codexPrompts[0]).toContain('c = 0');
    // 状态：pending → succeeded
    const statusCalls = ado.calls.filter((c) => c.url.includes('/statuses?'));
    expect(statusCalls.map((c) => c.body.state)).toEqual(['pending', 'succeeded']);
    // 行内评论：2 条，带 threadContext
    const threadPosts = ado.calls.filter((c) => c.method === 'POST' && /\/threads\?/.test(c.url));
    const inlinePosts = threadPosts.filter((c) => c.body.threadContext);
    expect(inlinePosts).toHaveLength(2);
    expect(inlinePosts[0].body.threadContext.filePath).toBe('/app.ts');
    expect(inlinePosts[0].body.comments[0].content).toContain('🔴');
    // 总评：1 条
    const summaryPosts = threadPosts.filter((c) => !c.body.threadContext);
    expect(summaryPosts).toHaveLength(1);
    expect(summaryPosts[0].body.comments[0].content).toContain('AI Code Review');
    // 状态库
    const state1 = db.getPrState(key)!;
    expect(state1.lastReviewedCommit).toBe(featureHead);
    expect(state1.summaryThreadId).toBeGreaterThan(0);
    expect(db.listOpenFindings(key)).toHaveLength(2);
    // worktree 已清理
    expect(fs.existsSync(codexWorktrees[0])).toBe(false);
    // 通知：review_completed + must_fix_found
    await vi.waitFor(() => expect(notifyCalls.length).toBe(2));

    const mustFixThreadId = db
      .listOpenFindings(key)
      .find((f) => f.severity === 'must-fix')!.threadId;

    // ---------- 阶段 2：push 修复 → 增量 review，自动关线程 ----------
    git(originDir, 'checkout', 'feature');
    fs.appendFileSync(path.join(originDir, 'app.ts'), '// callers updated\n');
    git(originDir, 'add', '.');
    git(originDir, 'commit', '-m', 'fix callers');
    const featureHead2 = git(originDir, 'rev-parse', 'HEAD');
    git(originDir, 'checkout', 'main');
    currentPr = prInfo(featureHead2, undefined); // 模拟此时无预合并 commit（走源分支回退）

    codexResponse = JSON.stringify({
      summary: '本次提交修复了调用方问题。',
      findings: [],
      resolvedThreadIds: [mustFixThreadId],
    });
    await pipeline.runIncrementalReview(currentPr);

    // 增量提示词只包含新变更，且带旧 finding 清单
    expect(codexPrompts[1]).toContain('callers updated');
    expect(codexPrompts[1]).toContain(`threadId=${mustFixThreadId}`);
    // 旧线程被回复 + 置 fixed
    const replyCall = ado.calls.find(
      (c) => c.method === 'POST' && c.url.includes(`/threads/${mustFixThreadId}/comments?`),
    );
    expect(replyCall?.body.content).toContain('已在最新提交中修复');
    const statusPatch = ado.calls.find(
      (c) => c.method === 'PATCH' && c.url.includes(`/threads/${mustFixThreadId}?`),
    );
    expect(statusPatch?.body.status).toBe('fixed');
    expect(db.listOpenFindings(key)).toHaveLength(1); // 只剩 nit
    // 总评是编辑（PATCH 第一条评论），不是新发
    const summaryPosts2 = ado.calls.filter(
      (c) => c.method === 'POST' && /\/threads\?/.test(c.url) && !c.body.threadContext,
    );
    expect(summaryPosts2).toHaveLength(1); // 仍只有阶段 1 那一条
    // 状态推进
    expect(db.getPrState(key)!.lastReviewedCommit).toBe(featureHead2);

    // ---------- 阶段 3：@bot 问答 ----------
    codexResponse = '因为 add 的新参数有默认值，旧调用方行为不变，风险主要在……';
    await pipeline.runQa({ pr: currentPr, threadId: 55, commentId: 1, question: '这里为什么要加参数 c？' });

    // 占位 → 编辑为答案
    const placeholderPost = ado.calls.find(
      (c) => c.method === 'POST' && c.url.includes('/threads/55/comments?'),
    );
    expect(placeholderPost?.body.content).toContain('正在分析');
    const answerPatch = ado.calls.find(
      (c) => c.method === 'PATCH' && /\/threads\/55\/comments\/\d+\?/.test(c.url),
    );
    expect(answerPatch?.body.content).toContain('默认值');
    // QA 提示词带线程历史与锚定位置
    expect(codexPrompts[2]).toContain('这里为什么要加参数 c？');
    expect(codexPrompts[2]).toContain('app.ts');

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('指纹去重：重复 review 不重复发相同 finding；codex 失败 → status failed + 告警', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-data2-'));
    const config = makeConfig(dataDir);
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));
    const notifyCalls: any[] = [];
    const notifyFetch = (async (url: any, init: any) => {
      notifyCalls.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, notifyFetch);

    let fail = false;
    const codexRun = async () => {
      if (fail) return { ok: false, output: '', error: '模型超时' };
      return {
        ok: true,
        output: JSON.stringify({
          summary: 'ok',
          findings: [{ file: 'app.ts', line: 1, severity: 'must-fix', title: '调用方未更新', detail: 'd' }],
          resolvedThreadIds: [],
        }),
      };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    await pipeline.runFullReview(currentPr, 'PR 创建');
    await pipeline.runFullReview(currentPr, '/review 命令', true);

    // 相同指纹的 finding 只发一次行内评论
    const inlinePosts = ado.calls.filter(
      (c) => c.method === 'POST' && /\/threads\?/.test(c.url) && c.body.threadContext,
    );
    expect(inlinePosts).toHaveLength(1);

    // codex 失败 → status failed + job_failed 通知 + 异常向上抛（由调度层记日志）
    fail = true;
    await expect(pipeline.runFullReview(currentPr, '/review 命令', true)).rejects.toThrow('模型超时');
    const statusCalls = ado.calls.filter((c) => c.url.includes('/statuses?'));
    expect(statusCalls.at(-1)?.body.state).toBe('failed');
    await vi.waitFor(() => expect(notifyCalls.some((b) => JSON.stringify(b).includes('失败'))).toBe(true));

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);
});
