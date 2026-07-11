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
        // agent 看到的必须与提交内容逐字节一致，不受部署机全局 autocrlf 影响
        '-c',
        'core.autocrlf=false',
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

  /** 暂存全部改动并返回统计（/fix 护栏用）；文件列表含改名/新增/删除 */
  async stageAndStats(
    worktreePath: string,
  ): Promise<{ files: string[]; changedLines: number }> {
    await this.git(['add', '-A'], worktreePath);
    const numstat = await this.git(['diff', '--cached', '--numstat'], worktreePath);
    const files: string[] = [];
    let changedLines = 0;
    for (const line of numstat.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      // 二进制文件 numstat 为 "-"，按 0 行计但文件数照算
      changedLines += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
      files.push(m[3]);
    }
    return { files, changedLines };
  }

  /** 暂存并提交 worktree 中的全部改动；无改动返回 undefined，否则返回新 commit id */
  async commitAll(
    worktreePath: string,
    message: string,
    author: { name: string; email: string },
  ): Promise<string | undefined> {
    const status = await this.git(['status', '--porcelain'], worktreePath);
    if (!status.trim()) return undefined;
    await this.git(['add', '-A'], worktreePath);
    await this.git(
      [
        '-c',
        `user.name=${author.name}`,
        '-c',
        `user.email=${author.email}`,
        'commit',
        '-m',
        message,
      ],
      worktreePath,
    );
    return (await this.git(['rev-parse', 'HEAD'], worktreePath)).trim();
  }

  /**
   * 把 worktree 的 HEAD 推到远端分支。
   * 显式推 URL 而不是 origin：mirror 的 remote 配了 mirror=true，按名字推会变成全量镜像推送。
   */
  async pushHead(worktreePath: string, remoteUrl: string, branch: string): Promise<void> {
    await this.git(
      [...this.authArgs(), 'push', remoteUrl, `HEAD:refs/heads/${branch}`],
      worktreePath,
    );
  }

  /** 某 commit 的完整提交信息（[skip review] 标记检查用） */
  async commitMessage(repoKey: string, commitId: string): Promise<string> {
    return this.git(['--git-dir', this.mirrorPath(repoKey), 'log', '-1', '--format=%B', commitId]);
  }

  /** mirror 默认分支的 HEAD（自由问答 checkout 用） */
  async headCommit(repoKey: string): Promise<string> {
    return (await this.git(['--git-dir', this.mirrorPath(repoKey), 'rev-parse', 'HEAD'])).trim();
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
