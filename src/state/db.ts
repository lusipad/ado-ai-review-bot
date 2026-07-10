import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Severity } from '../types';

export interface PrState {
  prKey: string;
  isDraft: boolean;
  /** 上次 review 覆盖到的源分支 commit */
  lastReviewedCommit?: string;
  /** 最近一次事件里看到的源分支 commit（用于 updated 事件防御性去抖） */
  lastSourceCommit?: string;
  /** 总评 thread id（编辑同一条而不是新发） */
  summaryThreadId?: number;
  /** 重启恢复用：能重建 PrRef 的最小信息 */
  repoId?: string;
  remoteUrl?: string;
}

export interface FindingRow {
  prKey: string;
  repoKey: string;
  fingerprint: string;
  threadId: number;
  /** open=未处理；fixed=已修复（bot 判定或人工 resolve）；wontfix=被团队拒绝；closed=其他关闭 */
  status: 'open' | 'fixed' | 'wontfix' | 'closed';
  severity: Severity;
  file: string;
  title: string;
  line: number;
  /** wontfix 时人工留下的理由（用于注入后续 review 提示词） */
  note?: string;
}

export interface ReviewRunRow {
  prKey: string;
  repoKey: string;
  kind: 'full' | 'incremental' | 'qa' | 'fix';
  ok: boolean;
  durationMs: number;
  findingsTotal: number;
  findingsPosted: number;
  mustFix: number;
  droppedByChallenge: number;
  degraded: boolean;
  error?: string;
}

export interface RepoAcceptance {
  repoKey: string;
  total: number;
  accepted: number;
  rejected: number;
  open: number;
}

export interface StatsOverview {
  runs: number;
  failures: number;
  prCount: number;
  avgDurationMs: number;
  findingsPosted: number;
  mustFix: number;
  droppedByChallenge: number;
  byKind: Record<string, number>;
}

export class StateDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_state (
        pr_key TEXT PRIMARY KEY,
        is_draft INTEGER NOT NULL DEFAULT 0,
        last_reviewed_commit TEXT,
        last_source_commit TEXT,
        summary_thread_id INTEGER
      );
      CREATE TABLE IF NOT EXISTS findings (
        pr_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        thread_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        severity TEXT NOT NULL,
        file TEXT NOT NULL,
        title TEXT NOT NULL,
        line INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (pr_key, fingerprint)
      );
      CREATE TABLE IF NOT EXISTS review_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pr_key TEXT NOT NULL,
        repo_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        ok INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        findings_total INTEGER NOT NULL DEFAULT 0,
        findings_posted INTEGER NOT NULL DEFAULT 0,
        must_fix INTEGER NOT NULL DEFAULT 0,
        dropped_by_challenge INTEGER NOT NULL DEFAULT 0,
        degraded INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_review_runs_repo_time ON review_runs (repo_key, created_at);
    `);
    this.migrate();
  }

  /** 老库升级：findings 补 repo_key / note 列并回填；pr_state 补恢复用列 */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(findings)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!cols.includes('repo_key')) this.db.exec("ALTER TABLE findings ADD COLUMN repo_key TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('note')) this.db.exec('ALTER TABLE findings ADD COLUMN note TEXT');
    const prCols = (this.db.prepare('PRAGMA table_info(pr_state)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    if (!prCols.includes('repo_id')) this.db.exec('ALTER TABLE pr_state ADD COLUMN repo_id TEXT');
    if (!prCols.includes('remote_url')) this.db.exec('ALTER TABLE pr_state ADD COLUMN remote_url TEXT');
    // repo_key = pr_key 去掉最后一段（project/repo/prId → project/repo）
    const empty = this.db
      .prepare("SELECT DISTINCT pr_key FROM findings WHERE repo_key = ''")
      .all() as { pr_key: string }[];
    const upd = this.db.prepare('UPDATE findings SET repo_key = ? WHERE pr_key = ?');
    for (const { pr_key } of empty) {
      upd.run(pr_key.slice(0, pr_key.lastIndexOf('/')), pr_key);
    }
  }

  getPrState(prKey: string): PrState | undefined {
    const row = this.db
      .prepare('SELECT * FROM pr_state WHERE pr_key = ?')
      .get(prKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      prKey,
      isDraft: row.is_draft === 1,
      lastReviewedCommit: (row.last_reviewed_commit as string) ?? undefined,
      lastSourceCommit: (row.last_source_commit as string) ?? undefined,
      summaryThreadId: (row.summary_thread_id as number) ?? undefined,
      repoId: (row.repo_id as string) ?? undefined,
      remoteUrl: (row.remote_url as string) ?? undefined,
    };
  }

  upsertPrState(prKey: string, patch: Partial<Omit<PrState, 'prKey'>>): void {
    const existing = this.getPrState(prKey);
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `INSERT INTO pr_state (pr_key, is_draft, last_reviewed_commit, last_source_commit, summary_thread_id, repo_id, remote_url)
         VALUES (@prKey, @isDraft, @lastReviewedCommit, @lastSourceCommit, @summaryThreadId, @repoId, @remoteUrl)
         ON CONFLICT(pr_key) DO UPDATE SET
           is_draft = @isDraft,
           last_reviewed_commit = @lastReviewedCommit,
           last_source_commit = @lastSourceCommit,
           summary_thread_id = @summaryThreadId,
           repo_id = @repoId,
           remote_url = @remoteUrl`,
      )
      .run({
        prKey,
        isDraft: merged.isDraft ? 1 : 0,
        lastReviewedCommit: merged.lastReviewedCommit ?? null,
        lastSourceCommit: merged.lastSourceCommit ?? null,
        summaryThreadId: merged.summaryThreadId ?? null,
        repoId: merged.repoId ?? null,
        remoteUrl: merged.remoteUrl ?? null,
      });
  }

  /** 重启恢复：active（非草稿）且源 commit 落后于已 review commit 的 PR */
  listPrStatesNeedingReview(): PrState[] {
    const rows = this.db
      .prepare(
        `SELECT pr_key FROM pr_state
         WHERE is_draft = 0
           AND last_source_commit IS NOT NULL
           AND remote_url IS NOT NULL
           AND (last_reviewed_commit IS NULL OR last_reviewed_commit != last_source_commit)`,
      )
      .all() as { pr_key: string }[];
    return rows.map((r) => this.getPrState(r.pr_key)!);
  }

  insertFinding(row: Omit<FindingRow, 'status' | 'note'>): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO findings (pr_key, repo_key, fingerprint, thread_id, status, severity, file, title, line)
         VALUES (@prKey, @repoKey, @fingerprint, @threadId, 'open', @severity, @file, @title, @line)`,
      )
      .run(row);
  }

  hasFingerprint(prKey: string, fingerprint: string): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM findings WHERE pr_key = ? AND fingerprint = ?')
      .get(prKey, fingerprint);
  }

  listOpenFindings(prKey: string): FindingRow[] {
    return (
      this.db
        .prepare("SELECT * FROM findings WHERE pr_key = ? AND status = 'open'")
        .all(prKey) as Record<string, unknown>[]
    ).map((r) => this.rowToFinding(r));
  }

  private rowToFinding(r: Record<string, unknown>): FindingRow {
    return {
      prKey: r.pr_key as string,
      repoKey: r.repo_key as string,
      fingerprint: r.fingerprint as string,
      threadId: r.thread_id as number,
      status: r.status as FindingRow['status'],
      severity: r.severity as Severity,
      file: r.file as string,
      title: r.title as string,
      line: r.line as number,
      note: (r.note as string) ?? undefined,
    };
  }

  markFindingFixed(prKey: string, threadId: number): void {
    this.db
      .prepare("UPDATE findings SET status = 'fixed' WHERE pr_key = ? AND thread_id = ?")
      .run(prKey, threadId);
  }

  /** 线程反馈同步：仅允许 open → 终态（人工改回 active 的场景由下次同步重新判定） */
  updateFindingFeedback(
    prKey: string,
    threadId: number,
    status: 'fixed' | 'wontfix' | 'closed',
    note?: string,
  ): void {
    this.db
      .prepare(
        "UPDATE findings SET status = ?, note = COALESCE(?, note) WHERE pr_key = ? AND thread_id = ? AND status = 'open'",
      )
      .run(status, note ?? null, prKey, threadId);
  }

  /** 本仓库被拒绝（wontfix）的历史意见，最近的在前，用于提示词注入 */
  listRejectedFindings(repoKey: string, limit = 15): FindingRow[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM findings WHERE repo_key = ? AND status = 'wontfix' ORDER BY created_at DESC LIMIT ?",
        )
        .all(repoKey, limit) as Record<string, unknown>[]
    ).map((r) => this.rowToFinding(r));
  }

  /** 某仓库指定 severity 的已裁决 finding 数与采纳数（自动收紧上报级别用） */
  severityAcceptance(repoKey: string, severity: Severity): { resolved: number; accepted: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status IN ('fixed','closed','wontfix') THEN 1 ELSE 0 END) AS resolved,
           SUM(CASE WHEN status IN ('fixed','closed') THEN 1 ELSE 0 END) AS accepted
         FROM findings WHERE repo_key = ? AND severity = ?`,
      )
      .get(repoKey, severity) as { resolved: number | null; accepted: number | null };
    return { resolved: row.resolved ?? 0, accepted: row.accepted ?? 0 };
  }

  // ---------- 度量 ----------

  insertReviewRun(row: ReviewRunRow): void {
    this.db
      .prepare(
        `INSERT INTO review_runs
           (pr_key, repo_key, kind, ok, duration_ms, findings_total, findings_posted, must_fix, dropped_by_challenge, degraded, error)
         VALUES (@prKey, @repoKey, @kind, @ok, @durationMs, @findingsTotal, @findingsPosted, @mustFix, @droppedByChallenge, @degraded, @error)`,
      )
      .run({
        ...row,
        ok: row.ok ? 1 : 0,
        degraded: row.degraded ? 1 : 0,
        error: row.error ?? null,
      });
  }

  statsOverview(sinceUtc: string, repoKey?: string): StatsOverview {
    const where = repoKey ? 'created_at >= ? AND repo_key = ?' : 'created_at >= ?';
    const params = repoKey ? [sinceUtc, repoKey] : [sinceUtc];
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                COUNT(DISTINCT CASE WHEN kind != 'qa' THEN pr_key END) AS pr_count,
                AVG(duration_ms) AS avg_ms,
                SUM(findings_posted) AS posted,
                SUM(must_fix) AS must_fix,
                SUM(dropped_by_challenge) AS dropped
         FROM review_runs WHERE ${where}`,
      )
      .get(...params) as Record<string, number | null>;
    const kinds = this.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM review_runs WHERE ${where} GROUP BY kind`)
      .all(...params) as { kind: string; n: number }[];
    return {
      runs: agg.runs ?? 0,
      failures: agg.failures ?? 0,
      prCount: agg.pr_count ?? 0,
      avgDurationMs: Math.round(agg.avg_ms ?? 0),
      findingsPosted: agg.posted ?? 0,
      mustFix: agg.must_fix ?? 0,
      droppedByChallenge: agg.dropped ?? 0,
      byKind: Object.fromEntries(kinds.map((k) => [k.kind, k.n])),
    };
  }

  /** 最近的任务记录（管理面板用），新的在前 */
  listRecentRuns(limit = 50): Array<ReviewRunRow & { id: number; createdAt: string }> {
    return (
      this.db
        .prepare('SELECT * FROM review_runs ORDER BY id DESC LIMIT ?')
        .all(limit) as Record<string, unknown>[]
    ).map((r) => ({
      id: r.id as number,
      prKey: r.pr_key as string,
      repoKey: r.repo_key as string,
      kind: r.kind as ReviewRunRow['kind'],
      ok: r.ok === 1,
      durationMs: r.duration_ms as number,
      findingsTotal: r.findings_total as number,
      findingsPosted: r.findings_posted as number,
      mustFix: r.must_fix as number,
      droppedByChallenge: r.dropped_by_challenge as number,
      degraded: r.degraded === 1,
      error: (r.error as string) ?? undefined,
      createdAt: r.created_at as string,
    }));
  }

  /** 各仓库 finding 采纳情况（accepted=fixed/closed，rejected=wontfix） */
  acceptanceByRepo(sinceUtc: string): RepoAcceptance[] {
    return (
      this.db
        .prepare(
          `SELECT repo_key,
                  COUNT(*) AS total,
                  SUM(CASE WHEN status IN ('fixed','closed') THEN 1 ELSE 0 END) AS accepted,
                  SUM(CASE WHEN status = 'wontfix' THEN 1 ELSE 0 END) AS rejected,
                  SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open
           FROM findings WHERE created_at >= ? GROUP BY repo_key ORDER BY total DESC`,
        )
        .all(sinceUtc) as Record<string, unknown>[]
    ).map((r) => ({
      repoKey: r.repo_key as string,
      total: r.total as number,
      accepted: (r.accepted as number) ?? 0,
      rejected: (r.rejected as number) ?? 0,
      open: (r.open as number) ?? 0,
    }));
  }

  close(): void {
    this.db.close();
  }
}
