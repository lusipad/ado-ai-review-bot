import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleChatCommand, type ChatOpsDeps } from '../src/chatops';
import { StateDb } from '../src/state/db';
import { Scheduler } from '../src/queue/scheduler';
import { KnowledgeStore } from '../src/knowledge';
import { findingFingerprint } from '../src/util';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let tmpDir: string;

function makeDeps(): ChatOpsDeps & { db: StateDb } {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-chat-'));
  return {
    db: new StateDb(path.join(tmpDir, 'state.db')),
    scheduler: new Scheduler({ reviewConcurrency: 1, qaConcurrency: 1, debounceMs: 1000, logger: silentLogger }),
    adoUrl: 'http://ado.local/DefaultCollection',
    knowledge: new KnowledgeStore(path.join(tmpDir, 'knowledge')),
  };
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleChatCommand', () => {
  it('状态：队列概况', () => {
    const deps = makeDeps();
    const out = handleChatCommand('状态', deps);
    expect(out).toContain('当前状态');
    expect(out).toContain('正在处理：无');
    deps.db.close();
  });

  it('统计：默认 7 天，可带天数', () => {
    const deps = makeDeps();
    deps.db.insertReviewRun({
      prKey: 'P/R/1', repoKey: 'P/R', kind: 'full', ok: true, durationMs: 1000,
      findingsTotal: 2, findingsPosted: 2, mustFix: 1, droppedByChallenge: 0, degraded: false,
    });
    expect(handleChatCommand('统计', deps)).toContain('过去 7 天');
    expect(handleChatCommand('stats 30', deps)).toContain('过去 30 天');
    deps.db.close();
  });

  it('待处理：open must-fix 清单带 PR 链接；无则报平安', () => {
    const deps = makeDeps();
    expect(handleChatCommand('待处理', deps)).toContain('没有未解决的 must-fix');

    deps.db.insertFinding({
      prKey: 'Proj/Repo/7', repoKey: 'Proj/Repo',
      fingerprint: findingFingerprint('a.ts', '空指针'), threadId: 1,
      severity: 'must-fix', file: 'a.ts', title: '空指针', line: 3,
    });
    const out = handleChatCommand('must-fix', deps);
    expect(out).toContain('a.ts:3 空指针');
    expect(out).toContain('http://ado.local/DefaultCollection/Proj/_git/Repo/pullrequest/7');
    deps.db.close();
  });

  it('架构：返回知识库缓存；不存在时给提示', () => {
    const deps = makeDeps();
    expect(handleChatCommand('架构 test/test', deps)).toContain('没有 `test/test` 的知识库缓存');
    deps.knowledge.save('test/test', { generatedAt: '2026-07-10T00:00:00Z', commit: 'abc', content: '模块划分……' });
    const out = handleChatCommand('架构 test/test', deps);
    expect(out).toContain('架构摘要');
    expect(out).toContain('模块划分');
    deps.db.close();
  });

  it('未知命令 → 帮助', () => {
    const deps = makeDeps();
    expect(handleChatCommand('随便说点什么', deps)).toContain('我能回答');
    deps.db.close();
  });
});
