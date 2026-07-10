import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pipeline, mergeReviewOutputs, isProtectedPath } from '../src/pipeline';
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
  const workItemRefs: Array<{ id: string }> = [];
  const workItems: Array<{ id: number; fields: Record<string, unknown> }> = [];
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
    if (method === 'GET' && /pullRequests\/\d+\/workitems\?api-version/.test(u))
      return json({ value: workItemRefs });
    if (method === 'GET' && /_apis\/wit\/workitems\?ids=/.test(u)) return json({ value: workItems });
    if (method === 'GET' && /\/threads\?api-version/.test(u))
      return json({ value: [...threads.values()] });
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
    if (method === 'GET' && /\/attachments\//.test(u))
      return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 });
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

  return { calls, fetchFn, threads, workItemRefs, workItems };
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
    codexRetries: 1,
    reviewProfiles: ['default'],
    shutdownGraceMs: 1000,
    userMap: {},
    persona: '测试人格：直接了当，不打官腔。',
    dreamEnabled: false,
    maxInlineComments: 10,
    maxChangedFiles: 50,
    promptsDir: path.resolve(__dirname, '..', 'prompts'),
    // 端到端主链路测试关闭质疑 pass 和知识库（否则每次 review 多出额外 codex 调用），专门的测试单独开
    challengeEnabled: false,
    weeklyReportEnabled: false,
    fixEnabled: false,
    fixMaxFiles: 10,
    fixMaxLines: 300,
    knowledgeEnabled: false,
    knowledgeTtlDays: 14,
    notify: { rocketchatWebhookUrl: 'https://chat.local/hooks/x', events: ['review_completed', 'must_fix_found', 'job_failed'] },
    repoOverrides: {},
  };
}

describe('mergeReviewOutputs', () => {
  const out = (over: Record<string, unknown>) => ({
    summary: 's', findings: [], resolvedThreadIds: [], degraded: false, ...over,
  }) as any;

  it('指纹相同或近邻行合并，agreedBy 累计；resolved 取交集；risk 取最严重', () => {
    const a = out({
      riskLevel: 'medium',
      resolvedThreadIds: [1, 2],
      findings: [
        { file: 'a.ts', line: 10, severity: 'must-fix', title: '空指针风险', detail: 'aa' },
        { file: 'b.ts', line: 5, severity: 'nit', title: '仅 A 发现', detail: 'a-only' },
      ],
    });
    const b = out({
      riskLevel: 'high',
      resolvedThreadIds: [2, 3],
      findings: [
        { file: 'a.ts', line: 11, severity: 'must-fix', title: '可能出现空引用', detail: 'bbbb 更长' },
        { file: 'c.ts', line: 1, severity: 'suggestion', title: '仅 B 发现', detail: 'b-only' },
      ],
    });
    const m = mergeReviewOutputs([a, b]);
    expect(m.findings).toHaveLength(3);
    const common = m.findings.find((f) => f.file === 'a.ts' && f.line === 10)!;
    expect(common.agreedBy).toBe(2);
    expect(common.detail).toBe('bbbb 更长');
    expect(m.resolvedThreadIds).toEqual([2]);
    expect(m.riskLevel).toBe('high');
  });

  it('同文件近邻行但严重度不同 → 不合并', () => {
    const a = out({ findings: [{ file: 'a.ts', line: 10, severity: 'must-fix', title: 'x', detail: '' }] });
    const b = out({ findings: [{ file: 'a.ts', line: 10, severity: 'nit', title: 'y', detail: '' }] });
    expect(mergeReviewOutputs([a, b]).findings).toHaveLength(2);
  });
});

describe('isProtectedPath（/fix 禁改清单）', () => {
  it('评审配置、团队规范、CI 配置受保护；普通代码不受', () => {
    expect(isProtectedPath('.ai-review.yml')).toBe(true);
    expect(isProtectedPath('sub/dir/.ai-review.yaml')).toBe(true);
    expect(isProtectedPath('AGENTS.md')).toBe(true);
    expect(isProtectedPath('azure-pipelines.yml')).toBe(true);
    expect(isProtectedPath('ci/azure-pipelines-release.yml')).toBe(true);
    expect(isProtectedPath('.github/workflows/build.yml')).toBe(true);
    expect(isProtectedPath('.gitlab-ci.yml')).toBe(true);
    expect(isProtectedPath('src/app.ts')).toBe(false);
    expect(isProtectedPath('docs/AGENTS-guide.md')).toBe(false);
  });
});

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

    // 提示词包含 PR 元信息、diff 与沟通风格卡
    expect(codexPrompts[0]).toContain('改造 add 函数');
    expect(codexPrompts[0]).toContain('c = 0');
    expect(codexPrompts[0]).toContain('测试人格：直接了当');
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

  it('质疑 pass 丢弃误报 + wontFix 反馈注入下次 review + 度量落库', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-data3-'));
    const config = { ...makeConfig(dataDir), challengeEnabled: true };
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    const reviewPrompts: string[] = [];
    const codexRun = async (_worktree: string, prompt: string) => {
      // 质疑 pass：index 0 判误报，index 1 证实
      if (prompt.includes('待复核 findings')) {
        return {
          ok: true,
          output: JSON.stringify({
            verdicts: [
              { index: 0, verdict: 'wrong', reason: '上游已判空' },
              { index: 1, verdict: 'confirmed', reason: 'caller.ts 确实未同步' },
            ],
          }),
        };
      }
      reviewPrompts.push(prompt);
      return {
        ok: true,
        output: JSON.stringify({
          summary: 'ok',
          findings: [
            { file: 'app.ts', line: 1, severity: 'suggestion', title: '疑似空指针', detail: 'x' },
            { file: 'app.ts', line: 1, severity: 'must-fix', title: '调用方未同步', detail: 'y' },
          ],
          resolvedThreadIds: [],
        }),
      };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });
    const key = 'Proj/Repo/1';

    // ---------- 第一次 review：误报被拦截，真问题带复核标注 ----------
    await pipeline.runFullReview(currentPr, 'PR 创建');

    const inlinePosts = ado.calls.filter(
      (c) => c.method === 'POST' && /\/threads\?/.test(c.url) && c.body.threadContext,
    );
    expect(inlinePosts).toHaveLength(1); // 误报没发出来
    expect(inlinePosts[0].body.comments[0].content).toContain('调用方未同步');
    expect(inlinePosts[0].body.comments[0].content).toContain('已二次复核');
    const summaryPost = ado.calls.find(
      (c) => c.method === 'POST' && /\/threads\?/.test(c.url) && !c.body.threadContext,
    );
    expect(summaryPost!.body.comments[0].content).toContain('二次复核丢弃了 1 条');

    // 度量落库
    const stats = db.statsOverview('2000-01-01 00:00:00');
    expect(stats.runs).toBe(1);
    expect(stats.droppedByChallenge).toBe(1);
    expect(stats.findingsPosted).toBe(1);
    expect(stats.mustFix).toBe(1);

    // ---------- 人工 wontFix + 理由 → 下次 review 提示词带历史反馈 ----------
    const findingThreadId = db.listOpenFindings(key)[0].threadId;
    const thread = ado.threads.get(findingThreadId)!;
    thread.status = 'wontFix';
    thread.comments.push({
      id: 999,
      content: '业务上就是这样设计的',
      author: { id: 'user-1', displayName: '开发者' },
    });

    await pipeline.runFullReview(currentPr, '/review 命令', true);

    // 反馈已入库
    expect(db.listOpenFindings(key)).toHaveLength(0);
    const rejected = db.listRejectedFindings('Proj/Repo');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].note).toBe('业务上就是这样设计的');
    // 第二次 review 的提示词包含被拒意见与理由
    expect(reviewPrompts[1]).toContain('调用方未同步');
    expect(reviewPrompts[1]).toContain('业务上就是这样设计的');

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('/fix：codex 改代码 → commit 并 push 到源分支 → 线程回复；未开启时拒绝', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-fix-'));
    const config = { ...makeConfig(dataDir), fixEnabled: true };
    // 独立分支承接 bot 的 push，避免影响其他用例
    git(originDir, 'branch', 'fixable', 'feature');
    const fixableHead = git(originDir, 'rev-parse', 'fixable');
    const pr: PrInfo = {
      ...prInfo(fixableHead, undefined),
      pullRequestId: 7,
      sourceRefName: 'refs/heads/fixable',
    };
    const ado = makeMockAdo(() => prResourceOf(pr));

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    const codexRun = async (worktree: string, prompt: string, opts?: { sandbox?: string }) => {
      expect(prompt).toContain('实施一个具体修复');
      expect(prompt).toContain('这里为什么要加参数 c？'); // 线程历史
      expect(opts?.sandbox).toBe('workspace-write');
      fs.writeFileSync(path.join(worktree, 'fixed.txt'), 'done\n');
      return { ok: true, output: '把调用方改为三参调用，并补充了 fixed.txt。' };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    await pipeline.runFix({ pr, threadId: 55, commentId: 1, instruction: '按建议修复' });

    // push 已到达 origin 的 fixable 分支
    const newTip = git(originDir, 'rev-parse', 'fixable');
    expect(newTip).not.toBe(fixableHead);
    expect(git(originDir, 'log', '-1', '--format=%s', 'fixable')).toContain('AI fix');
    expect(git(originDir, 'show', 'fixable:fixed.txt')).toBe('done');
    // 占位评论被编辑为成功信息
    const patch = ado.calls.find(
      (c) => c.method === 'PATCH' && /\/threads\/55\/comments\/\d+\?/.test(c.url),
    );
    expect(patch?.body.content).toContain('✅ 已推送修复');
    // 度量
    expect(db.statsOverview('2000-01-01 00:00:00').byKind.fix).toBe(1);

    // ---------- 未开启 allowFix → 拒绝且不 push ----------
    const config2 = { ...makeConfig(dataDir), fixEnabled: false };
    const ado2 = makeMockAdo(() => prResourceOf(pr));
    const adoClient2 = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado2.fetchFn });
    const pipeline2 = new Pipeline({
      config: config2, db, ado: adoClient2, workspace, notify, logger: silentLogger,
      codexRun: async () => ({ ok: true, output: '不应被调用' }),
    });
    await pipeline2.runFix({ pr, threadId: 55, commentId: 1, instruction: '' });
    const patch2 = ado2.calls.find(
      (c) => c.method === 'PATCH' && /\/threads\/55\/comments\/\d+\?/.test(c.url),
    );
    expect(patch2?.body.content).toContain('未开启 /fix');
    expect(git(originDir, 'rev-parse', 'fixable')).toBe(newTip); // 没有新 push

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('仓库知识库：首次 review 后生成，之后注入提示词', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-kb-'));
    const config = { ...makeConfig(dataDir), knowledgeEnabled: true };
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    const reviewPrompts: string[] = [];
    let mapGenerations = 0;
    const codexRun = async (_worktree: string, prompt: string) => {
      if (prompt.includes('资深架构师')) {
        mapGenerations++;
        return { ok: true, output: '这是仓库地图内容 ABC123' };
      }
      reviewPrompts.push(prompt);
      return { ok: true, output: JSON.stringify({ summary: 'ok', findings: [], resolvedThreadIds: [] }) };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    await pipeline.runFullReview(currentPr, 'PR 创建');
    expect(reviewPrompts[0]).toContain('首次 review 后自动生成'); // 还没有地图
    expect(mapGenerations).toBe(1);

    await pipeline.runFullReview(currentPr, '/review 命令', true);
    expect(reviewPrompts[1]).toContain('这是仓库地图内容 ABC123'); // 第二次注入
    expect(mapGenerations).toBe(1); // 未过期，不重复生成

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('瞬时失败自动重试 + 同 commit 幂等跳过 + 工作项注入提示词', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-retry-'));
    const config = makeConfig(dataDir);
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));
    ado.workItemRefs.push({ id: '12' });
    ado.workItems.push({
      id: 12,
      fields: {
        'System.WorkItemType': 'Bug',
        'System.Title': '会员折扣算错金额',
        'System.Description': '<p>九五折被算成了<br>仅减免 0.05%</p>',
      },
    });

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    const prompts: string[] = [];
    let calls = 0;
    const codexRun = async (_wt: string, prompt: string) => {
      calls++;
      if (calls === 1) return { ok: false, output: '', error: 'stream error: connection reset' };
      prompts.push(prompt);
      return { ok: true, output: JSON.stringify({ summary: 'ok', findings: [], resolvedThreadIds: [] }) };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    // 第一次：首次调用失败 → 自动重试成功
    await pipeline.runFullReview(currentPr, 'PR 创建');
    expect(calls).toBe(2);
    // 工作项注入（HTML 已转纯文本）
    expect(prompts[0]).toContain('#12 [Bug] 会员折扣算错金额');
    expect(prompts[0]).toContain('九五折被算成了\n仅减免 0.05%');

    // 同 commit 的自动触发 → 幂等跳过，codex 不再被调用
    await pipeline.runFullReview(currentPr, 'PR 创建（重复事件）');
    expect(calls).toBe(2);

    // 手动 /review 不受幂等限制
    await pipeline.runFullReview(currentPr, '/review 命令', true);
    expect(calls).toBe(3);

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('QA 带图：线程截图下载后经 -i 传给 codex，用完清理', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-img-'));
    const config = makeConfig(dataDir);
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));
    // 线程里有一条带截图的评论
    ado.threads.set(66, {
      id: 66,
      status: 'active',
      threadContext: { filePath: '/app.ts', rightFileStart: { line: 1 }, rightFileEnd: { line: 1 } },
      comments: [
        {
          id: 1,
          content: '报错截图 ![err](https://ado.corp.local/DefaultCollection/Proj/_apis/git/repositories/g/pullRequests/1/attachments/err.png) 这是怎么回事？',
          author: { id: 'user-1', displayName: '开发者' },
        },
      ],
    });

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    let seenImages: string[] = [];
    const codexRun = async (_wt: string, prompt: string, opts?: { images?: string[] }) => {
      seenImages = opts?.images ?? [];
      expect(prompt).toContain('附有 1 张图片');
      // 图片文件此刻真实存在且是下载的内容
      expect(fs.existsSync(seenImages[0])).toBe(true);
      expect([...fs.readFileSync(seenImages[0])].slice(0, 4)).toEqual([137, 80, 78, 71]);
      return { ok: true, output: '图里是空指针异常，原因是……' };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    await pipeline.runQa({ pr: currentPr, threadId: 66, commentId: 1, question: '这是怎么回事？' });

    expect(seenImages).toHaveLength(1);
    expect(fs.existsSync(seenImages[0])).toBe(false); // 用完已清理
    const patch = ado.calls.find((c) => c.method === 'PATCH' && /\/threads\/66\/comments\/\d+\?/.test(c.url));
    expect(patch?.body.content).toContain('空指针异常');

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('/fix 护栏：超规模拒绝、受保护文件拒绝、PR 分支 yaml 无法自我提权', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-guard-'));
    const config = { ...makeConfig(dataDir), fixEnabled: true, fixMaxFiles: 2, fixMaxLines: 20 };
    git(originDir, 'branch', 'guarded', 'feature');
    const guardedHead = git(originDir, 'rev-parse', 'guarded');
    const pr: PrInfo = {
      ...prInfo(guardedHead, undefined),
      pullRequestId: 9,
      sourceRefName: 'refs/heads/guarded',
    };
    const ado = makeMockAdo(() => prResourceOf(pr));
    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    let writeMode: 'huge' | 'protected' = 'huge';
    const codexRun = async (worktree: string) => {
      if (writeMode === 'huge') {
        fs.writeFileSync(path.join(worktree, 'big.txt'), Array(50).fill('line').join('\n'));
      } else {
        fs.mkdirSync(path.join(worktree, '.github', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(worktree, '.github', 'workflows', 'evil.yml'), 'on: push\n');
      }
      return { ok: true, output: '改好了' };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    // 超行数上限 → 拒绝，分支无新提交
    await pipeline.runFix({ pr, threadId: 70, commentId: 1, instruction: '重构' });
    let patch = ado.calls.filter((c) => c.method === 'PATCH' && /threads\/70/.test(c.url)).at(-1);
    expect(patch?.body.content).toContain('超出护栏');
    expect(git(originDir, 'rev-parse', 'guarded')).toBe(guardedHead);

    // 受保护文件 → 拒绝
    writeMode = 'protected';
    await pipeline.runFix({ pr, threadId: 71, commentId: 1, instruction: '加个 CI' });
    patch = ado.calls.filter((c) => c.method === 'PATCH' && /threads\/71/.test(c.url)).at(-1);
    expect(patch?.body.content).toContain('受保护文件');
    expect(git(originDir, 'rev-parse', 'guarded')).toBe(guardedHead);

    // PR 分支 yaml 写 allowFix: true → 不再生效（fixEnabled=false 时仍拒绝）
    git(originDir, 'checkout', 'guarded', '-q');
    fs.writeFileSync(path.join(originDir, '.ai-review.yml'), 'allowFix: true\n');
    git(originDir, 'add', '.');
    git(originDir, 'commit', '-m', 'try self-authorize', '-q');
    const newHead = git(originDir, 'rev-parse', 'HEAD');
    git(originDir, 'checkout', 'main', '-q');
    const pr2 = { ...pr, sourceCommit: newHead };
    const config2 = { ...config, fixEnabled: false };
    const pipeline2 = new Pipeline({
      config: config2, db, ado: adoClient, workspace, notify, logger: silentLogger,
      codexRun: async () => ({ ok: true, output: '不应执行到修改' }),
    });
    await pipeline2.runFix({ pr: pr2, threadId: 72, commentId: 1, instruction: '' });
    patch = ado.calls.filter((c) => c.method === 'PATCH' && /threads\/72/.test(c.url)).at(-1);
    expect(patch?.body.content).toContain('未开启 /fix');

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('长期记忆闭环：review 沉淀 → 注入下次 review → dream 整理重写', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mem-'));
    const config = {
      ...makeConfig(dataDir),
      knowledgeEnabled: true,
      notify: {
        rocketchatWebhookUrl: 'https://chat.local/hooks/x',
        events: ['review_completed', 'must_fix_found', 'job_failed', 'weekly_report'] as const,
      },
    } as unknown as Config;
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notifyCalls: any[] = [];
    const notify = new NotifyDispatcher(config, silentLogger, (async (_u: any, init: any) => {
      notifyCalls.push(JSON.parse(init.body));
      return new Response('{}');
    }) as typeof fetch);

    const prompts: string[] = [];
    let mode: 'review' | 'dream' = 'review';
    const codexRun = async (_wt: string, prompt: string, opts?: { skipGitCheck?: boolean }) => {
      prompts.push(prompt);
      if (mode === 'dream') {
        expect(opts?.skipGitCheck).toBe(true);
        expect(prompt).toContain('记忆整理器');
        expect(prompt).toContain('金额单位是分'); // 现有记忆参与整理
        return {
          ok: true,
          output: JSON.stringify({
            memories: [{ type: '约定', text: '整理后：金额一律用分，禁止用元', date: '2026-07-01' }],
            teamSuggestions: '- 建议在 AGENTS.md 声明金额单位约定',
          }),
        };
      }
      if (prompt.includes('资深架构师')) return { ok: true, output: '地图' };
      return {
        ok: true,
        output: JSON.stringify({
          summary: 'ok',
          findings: [],
          resolvedThreadIds: [],
          repoMemories: [{ type: '坑', text: '金额单位是分不是元' }],
        }),
      };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    // 第一次 review：记忆被沉淀
    await pipeline.runFullReview(currentPr, 'PR 创建');
    const memFile = fs.readdirSync(path.join(dataDir, 'knowledge')).find((f) => f.endsWith('-memory.md'));
    expect(memFile).toBeTruthy();
    expect(fs.readFileSync(path.join(dataDir, 'knowledge', memFile!), 'utf8')).toContain('金额单位是分不是元');

    // 第二次 review：提示词带上记忆
    await pipeline.runFullReview(currentPr, '/review 命令', true);
    const secondReviewPrompt = prompts.filter((p) => p.includes('评审要求')).at(-1)!;
    expect(secondReviewPrompt).toContain('金额单位是分不是元');
    expect(secondReviewPrompt).toContain('以代码为准');

    // dream 整理：重写记忆 + 团队建议推送
    mode = 'dream';
    expect(pipeline.dreamCandidates()).toEqual(['Proj/Repo']);
    await pipeline.runDream('Proj/Repo');
    const after = fs.readFileSync(path.join(dataDir, 'knowledge', memFile!), 'utf8');
    expect(after).toContain('整理后：金额一律用分');
    expect(after).not.toContain('金额单位是分不是元'); // 旧条目被整理掉
    expect(after).toContain('[2026-07-01]'); // 沿用原日期
    await vi.waitFor(() => expect(JSON.stringify(notifyCalls)).toContain('AGENTS.md'));
    expect(db.statsOverview('2000-01-01 00:00:00').byKind.dream).toBe(1);

    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('多模型交叉：各 profile 独立跑，findings 合并、双命中标注、语言清单与导读注入', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-mm-'));
    const config = { ...makeConfig(dataDir), reviewProfiles: ['default', 'deepseek'] };
    const currentPr = prInfo(featureHead, mergeHead);
    const ado = makeMockAdo(() => prResourceOf(currentPr));

    const db = new StateDb(path.join(dataDir, 'state.db'));
    const workspace = new Workspace({ dataDir, logger: silentLogger });
    const adoClient = new AdoClient({ baseUrl: config.adoUrl, pat: 'pat', fetchFn: ado.fetchFn });
    const notify = new NotifyDispatcher(config, silentLogger, (async () => new Response('{}')) as typeof fetch);

    const profilesSeen: (string | undefined)[] = [];
    let lastPrompt = '';
    const codexRun = async (_wt: string, prompt: string, opts?: { profile?: string }) => {
      profilesSeen.push(opts?.profile);
      lastPrompt = prompt;
      // 两个模型：一个共同 finding（措辞不同但同文件近邻行）+ 各自一个独有 finding
      const isDeepseek = opts?.profile === 'deepseek';
      return {
        ok: true,
        output: JSON.stringify({
          summary: isDeepseek ? 'deepseek 视角' : '主模型视角',
          reviewerGuide: isDeepseek ? undefined : '- 重点看 app.ts 的签名变更是否影响业务',
          riskLevel: isDeepseek ? 'high' : 'medium',
          findings: [
            isDeepseek
              ? { file: 'app.ts', line: 2, severity: 'must-fix', title: '调用点未同步更新', detail: '较长的说明文本来自 deepseek' }
              : { file: 'app.ts', line: 1, severity: 'must-fix', title: '调用方未更新', detail: '短说明' },
            isDeepseek
              ? { file: 'app.ts', line: 9, severity: 'nit', title: 'deepseek 独有发现', detail: 'd' }
              : { file: 'app.ts', line: 5, severity: 'suggestion', title: '主模型独有发现', detail: 'm' },
          ],
          resolvedThreadIds: isDeepseek ? [7, 8] : [7],
        }),
      };
    };
    const pipeline = new Pipeline({ config, db, ado: adoClient, workspace, notify, logger: silentLogger, codexRun });

    await pipeline.runFullReview(currentPr, 'PR 创建');

    // 两个 profile 都被调用
    expect(profilesSeen.sort()).toEqual(['deepseek', 'default'].sort());
    // 语言清单注入（app.ts → typescript 清单）
    expect(lastPrompt).toContain('TypeScript / JavaScript 专项检查');

    const inlinePosts = ado.calls.filter(
      (c) => c.method === 'POST' && /\/threads\?/.test(c.url) && c.body.threadContext,
    );
    // 合并后 3 条：共同 1 条（near-line 合并）+ 各自独有 2 条
    expect(inlinePosts).toHaveLength(3);
    const common = inlinePosts.find((c) => c.body.comments[0].content.includes('调用方未更新'));
    expect(common!.body.comments[0].content).toContain('2 个模型独立发现');
    expect(common!.body.comments[0].content).toContain('较长的说明文本来自 deepseek'); // 保留更详尽说明

    // 总评包含导读，风险取最严重
    const summary = ado.calls.find(
      (c) => c.method === 'POST' && /\/threads\?/.test(c.url) && !c.body.threadContext,
    );
    expect(summary!.body.comments[0].content).toContain('👀 给人工审阅者');
    expect(summary!.body.comments[0].content).toContain('**整体风险**：high');

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
