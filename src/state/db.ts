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
}

export interface FindingRow {
  prKey: string;
  fingerprint: string;
  threadId: number;
  status: 'open' | 'fixed' | 'closed';
  severity: Severity;
  file: string;
  title: string;
  line: number;
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
    `);
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
    };
  }

  upsertPrState(prKey: string, patch: Partial<Omit<PrState, 'prKey'>>): void {
    const existing = this.getPrState(prKey);
    const merged = { ...existing, ...patch };
    this.db
      .prepare(
        `INSERT INTO pr_state (pr_key, is_draft, last_reviewed_commit, last_source_commit, summary_thread_id)
         VALUES (@prKey, @isDraft, @lastReviewedCommit, @lastSourceCommit, @summaryThreadId)
         ON CONFLICT(pr_key) DO UPDATE SET
           is_draft = @isDraft,
           last_reviewed_commit = @lastReviewedCommit,
           last_source_commit = @lastSourceCommit,
           summary_thread_id = @summaryThreadId`,
      )
      .run({
        prKey,
        isDraft: merged.isDraft ? 1 : 0,
        lastReviewedCommit: merged.lastReviewedCommit ?? null,
        lastSourceCommit: merged.lastSourceCommit ?? null,
        summaryThreadId: merged.summaryThreadId ?? null,
      });
  }

  insertFinding(row: Omit<FindingRow, 'status'>): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO findings (pr_key, fingerprint, thread_id, status, severity, file, title, line)
         VALUES (@prKey, @fingerprint, @threadId, 'open', @severity, @file, @title, @line)`,
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
    ).map((r) => ({
      prKey,
      fingerprint: r.fingerprint as string,
      threadId: r.thread_id as number,
      status: r.status as FindingRow['status'],
      severity: r.severity as Severity,
      file: r.file as string,
      title: r.title as string,
      line: r.line as number,
    }));
  }

  markFindingFixed(prKey: string, threadId: number): void {
    this.db
      .prepare("UPDATE findings SET status = 'fixed' WHERE pr_key = ? AND thread_id = ?")
      .run(prKey, threadId);
  }

  close(): void {
    this.db.close();
  }
}
