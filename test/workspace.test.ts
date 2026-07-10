import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/repo/workspace';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let tmpRoot: string;
let originDir: string;
let dataDir: string;
let mainCommit: string;
let featureCommit: string;

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-ws-'));
  originDir = path.join(tmpRoot, 'origin');
  dataDir = path.join(tmpRoot, 'data');
  fs.mkdirSync(originDir);

  git(originDir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(originDir, 'a.txt'), 'hello\n');
  git(originDir, 'add', '.');
  git(originDir, 'commit', '-m', 'init');
  mainCommit = git(originDir, 'rev-parse', 'HEAD');

  git(originDir, 'checkout', '-b', 'feature');
  fs.writeFileSync(path.join(originDir, 'a.txt'), 'hello world\n');
  fs.writeFileSync(path.join(originDir, 'b.txt'), 'new file\n');
  git(originDir, 'add', '.');
  git(originDir, 'commit', '-m', 'feature change');
  featureCommit = git(originDir, 'rev-parse', 'HEAD');
  git(originDir, 'checkout', 'main');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('Workspace', () => {
  it('mirror clone + 再次 ensureMirror 走 fetch + hasCommit', async () => {
    const ws = new Workspace({ dataDir, logger: silentLogger });
    await ws.ensureMirror('P/R', originDir);
    expect(await ws.hasCommit('P/R', featureCommit)).toBe(true);
    expect(await ws.hasCommit('P/R', 'deadbeef'.repeat(5))).toBe(false);

    // origin 上有新提交后 fetch 能拿到
    git(originDir, 'checkout', 'feature');
    fs.writeFileSync(path.join(originDir, 'c.txt'), 'more\n');
    git(originDir, 'add', '.');
    git(originDir, 'commit', '-m', 'second push');
    const newCommit = git(originDir, 'rev-parse', 'HEAD');
    git(originDir, 'checkout', 'main');

    expect(await ws.hasCommit('P/R', newCommit)).toBe(false);
    await ws.ensureMirror('P/R', originDir);
    expect(await ws.hasCommit('P/R', newCommit)).toBe(true);
  });

  it('worktree checkout 指定 commit，任务间互不影响，可清理', async () => {
    const ws = new Workspace({ dataDir, logger: silentLogger });
    await ws.ensureMirror('P/R', originDir);

    const wt1 = await ws.createWorktree('P/R', featureCommit, 'pr-1-t1');
    const wt2 = await ws.createWorktree('P/R', mainCommit, 'pr-2-t1');
    expect(fs.readFileSync(path.join(wt1, 'a.txt'), 'utf8')).toBe('hello world\n');
    expect(fs.existsSync(path.join(wt1, 'b.txt'))).toBe(true);
    expect(fs.readFileSync(path.join(wt2, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(fs.existsSync(path.join(wt2, 'b.txt'))).toBe(false);

    await ws.removeWorktree('P/R', wt1);
    await ws.removeWorktree('P/R', wt2);
    expect(fs.existsSync(wt1)).toBe(false);
    expect(fs.existsSync(wt2)).toBe(false);
  });

  it('prDiff（三点）与 changedFiles', async () => {
    const ws = new Workspace({ dataDir, logger: silentLogger });
    await ws.ensureMirror('P/R', originDir);
    const diff = await ws.prDiff('P/R', mainCommit, featureCommit);
    expect(diff).toContain('+hello world');
    expect(diff).toContain('b.txt');
    const files = await ws.changedFiles('P/R', mainCommit, featureCommit, true);
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rangeDiff（两点增量）', async () => {
    const ws = new Workspace({ dataDir, logger: silentLogger });
    await ws.ensureMirror('P/R', originDir);
    const head = git(originDir, 'rev-parse', 'feature');
    const diff = await ws.rangeDiff('P/R', featureCommit, head);
    expect(diff).toContain('c.txt');
    expect(diff).not.toContain('b.txt'); // 上一轮已 review 的部分不出现
  });

  it('cleanupOrphans 清空 worktree 目录', async () => {
    const ws = new Workspace({ dataDir, logger: silentLogger });
    await ws.ensureMirror('P/R', originDir);
    const wt = await ws.createWorktree('P/R', mainCommit, 'orphan');
    expect(fs.existsSync(wt)).toBe(true);
    await ws.cleanupOrphans();
    expect(fs.existsSync(wt)).toBe(false);
    // 清理后仍能正常创建新 worktree
    const wt2 = await ws.createWorktree('P/R', mainCommit, 'after-cleanup');
    expect(fs.existsSync(wt2)).toBe(true);
    await ws.removeWorktree('P/R', wt2);
  });
});
