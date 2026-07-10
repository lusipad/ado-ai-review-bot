import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { KeyedMutex, sanitizePathSegment } from '../util';
import type { Logger } from '../types';

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface WorkspaceOptions {
  dataDir: string;
  /** 用于 http(s) 远程认证；不写进 remote URL，避免 PAT 落盘 */
  pat?: string;
  logger: Logger;
}

/**
 * 每个仓库一份 mirror 缓存 + 每个任务一个独立 worktree。
 * mirror 的 fetch / worktree add 用每仓库互斥锁串行；checkout 后互不干扰。
 */
export class Workspace {
  private readonly mirrorsDir: string;
  private readonly worktreesDir: string;
  private readonly pat?: string;
  private readonly logger: Logger;
  private readonly gitLocks = new KeyedMutex();

  constructor(opts: WorkspaceOptions) {
    this.mirrorsDir = path.join(opts.dataDir, 'mirrors');
    this.worktreesDir = path.join(opts.dataDir, 'workspaces');
    this.pat = opts.pat;
    this.logger = opts.logger;
    fs.mkdirSync(this.mirrorsDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
  }

  private mirrorPath(repoKey: string): string {
    return path.join(this.mirrorsDir, sanitizePathSegment(repoKey) + '.git');
  }

  private authArgs(): string[] {
    if (!this.pat) return [];
    const b64 = Buffer.from(`:${this.pat}`).toString('base64');
    return ['-c', `http.extraHeader=Authorization: Basic ${b64}`];
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  }

  /** clone --mirror（首次）或 fetch --prune（已有），mirror 含全部 refs（分支 + PR 合并 ref） */
  ensureMirror(repoKey: string, remoteUrl: string): Promise<void> {
    return this.gitLocks.run(repoKey, async () => {
      const dir = this.mirrorPath(repoKey);
      if (fs.existsSync(dir)) {
        await this.git([...this.authArgs(), '--git-dir', dir, 'fetch', '--prune', 'origin']);
      } else {
        await this.git([...this.authArgs(), 'clone', '--mirror', remoteUrl, dir]);
      }
    });
  }

  /** 为一个任务 checkout 独立 worktree，返回目录路径；用完必须 removeWorktree */
  createWorktree(repoKey: string, commitId: string, label: string): Promise<string> {
    return this.gitLocks.run(repoKey, async () => {
      const dir = path.join(
        this.worktreesDir,
        sanitizePathSegment(repoKey),
        sanitizePathSegment(label),
      );
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.rmSync(dir, { recursive: true, force: true });
      await this.git([
        '--git-dir',
        this.mirrorPath(repoKey),
        'worktree',
        'add',
        '--detach',
        '--force',
        dir,
        commitId,
      ]);
      return dir;
    });
  }

  async removeWorktree(repoKey: string, worktreePath: string): Promise<void> {
    await this.gitLocks
      .run(repoKey, async () => {
        await this.git([
          '--git-dir',
          this.mirrorPath(repoKey),
          'worktree',
          'remove',
          '--force',
          worktreePath,
        ]).catch(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
        await this.git(['--git-dir', this.mirrorPath(repoKey), 'worktree', 'prune']).catch(
          () => undefined,
        );
      })
      .catch((err) => this.logger.warn({ err: String(err), worktreePath }, '清理 worktree 失败'));
  }

  /** commit 是否已在 mirror 中（避免不必要的 fetch） */
  async hasCommit(repoKey: string, commitId: string): Promise<boolean> {
    try {
      await this.git(['--git-dir', this.mirrorPath(repoKey), 'cat-file', '-e', `${commitId}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** PR 全量 diff：target...source（merge-base 三点式） */
  prDiff(repoKey: string, targetCommit: string, sourceCommit: string): Promise<string> {
    return this.git([
      '--git-dir',
      this.mirrorPath(repoKey),
      'diff',
      `${targetCommit}...${sourceCommit}`,
    ]);
  }

  /** 增量 diff：上次 review 的 commit → 本次 commit */
  rangeDiff(repoKey: string, fromCommit: string, toCommit: string): Promise<string> {
    return this.git(['--git-dir', this.mirrorPath(repoKey), 'diff', `${fromCommit}..${toCommit}`]);
  }

  async changedFiles(repoKey: string, fromCommit: string, toCommit: string, threeDot = true): Promise<string[]> {
    const range = threeDot ? `${fromCommit}...${toCommit}` : `${fromCommit}..${toCommit}`;
    const out = await this.git([
      '--git-dir',
      this.mirrorPath(repoKey),
      'diff',
      '--name-only',
      range,
    ]);
    return out.split('\n').filter(Boolean);
  }

  /** 启动时兜底：prune 所有 mirror 的 worktree 记录并删除孤儿目录 */
  async cleanupOrphans(): Promise<void> {
    for (const entry of fs.existsSync(this.mirrorsDir) ? fs.readdirSync(this.mirrorsDir) : []) {
      const dir = path.join(this.mirrorsDir, entry);
      await this.git(['--git-dir', dir, 'worktree', 'prune']).catch(() => undefined);
    }
    if (fs.existsSync(this.worktreesDir)) {
      fs.rmSync(this.worktreesDir, { recursive: true, force: true });
      fs.mkdirSync(this.worktreesDir, { recursive: true });
    }
  }
}
