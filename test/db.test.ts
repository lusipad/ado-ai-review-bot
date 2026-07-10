import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { StateDb } from '../src/state/db';
import { extractImageUrls, findingFingerprint, msUntilNextWeekly } from '../src/util';

let tmpDir: string;

function makeDb(): StateDb {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-db-'));
  return new StateDb(path.join(tmpDir, 'state.db'));
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('StateDb', () => {
  it('pr_state 读写 + 部分更新合并', () => {
    const db = makeDb();
    const key = 'Proj/Repo/1';
    expect(db.getPrState(key)).toBeUndefined();

    db.upsertPrState(key, { isDraft: true, lastSourceCommit: 'abc' });
    expect(db.getPrState(key)).toMatchObject({ isDraft: true, lastSourceCommit: 'abc' });

    // 部分更新不丢既有字段
    db.upsertPrState(key, { summaryThreadId: 42 });
    const s = db.getPrState(key)!;
    expect(s.summaryThreadId).toBe(42);
    expect(s.lastSourceCommit).toBe('abc');
    expect(s.isDraft).toBe(true);
    db.close();
  });

  it('findings 指纹去重 + open 列表 + 标记修复', () => {
    const db = makeDb();
    const key = 'Proj/Repo/1';
    const rKey = 'Proj/Repo';
    const fp = findingFingerprint('src/a.ts', '空指针风险');

    db.insertFinding({ prKey: key, repoKey: rKey, fingerprint: fp, threadId: 7, severity: 'must-fix', file: 'src/a.ts', title: '空指针风险', line: 10 });
    expect(db.hasFingerprint(key, fp)).toBe(true);
    expect(db.hasFingerprint(key, 'other')).toBe(false);

    // 同指纹重复插入不报错、不重复
    db.insertFinding({ prKey: key, repoKey: rKey, fingerprint: fp, threadId: 8, severity: 'must-fix', file: 'src/a.ts', title: '空指针风险', line: 10 });
    expect(db.listOpenFindings(key)).toHaveLength(1);
    expect(db.listOpenFindings(key)[0].threadId).toBe(7);

    db.markFindingFixed(key, 7);
    expect(db.listOpenFindings(key)).toHaveLength(0);
    db.close();
  });

  it('线程反馈：wontfix 记理由、进入拒绝清单，采纳率可查', () => {
    const db = makeDb();
    const rKey = 'Proj/Repo';
    const mk = (pr: number, thread: number, title: string) =>
      db.insertFinding({
        prKey: `${rKey}/${pr}`,
        repoKey: rKey,
        fingerprint: findingFingerprint('a.ts', title),
        threadId: thread,
        severity: 'nit',
        file: 'a.ts',
        title,
        line: 1,
      });

    mk(1, 10, '建议加注释');
    mk(1, 11, '变量命名');
    mk(2, 12, '空行过多');

    db.updateFindingFeedback('Proj/Repo/1', 10, 'wontfix', '团队约定不强制注释');
    db.updateFindingFeedback('Proj/Repo/1', 11, 'fixed');

    const rejected = db.listRejectedFindings(rKey);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].title).toBe('建议加注释');
    expect(rejected[0].note).toBe('团队约定不强制注释');

    // 只允许 open → 终态：重复反馈不覆盖
    db.updateFindingFeedback('Proj/Repo/1', 10, 'fixed');
    expect(db.listRejectedFindings(rKey)).toHaveLength(1);

    const acc = db.severityAcceptance(rKey, 'nit');
    expect(acc).toEqual({ resolved: 2, accepted: 1 });

    const byRepo = db.acceptanceByRepo('2000-01-01 00:00:00');
    expect(byRepo).toHaveLength(1);
    expect(byRepo[0]).toMatchObject({ repoKey: rKey, total: 3, accepted: 1, rejected: 1, open: 1 });
    db.close();
  });

  it('重启恢复扫描：源 commit 落后且资料齐全的 active PR', () => {
    const db = makeDb();
    // 需要恢复：source != reviewed 且有 remote_url
    db.upsertPrState('P/R/1', { isDraft: false, lastSourceCommit: 'new', lastReviewedCommit: 'old', repoId: 'g1', remoteUrl: 'http://r' });
    // 不需要：已 review 到位
    db.upsertPrState('P/R/2', { isDraft: false, lastSourceCommit: 'c', lastReviewedCommit: 'c', repoId: 'g1', remoteUrl: 'http://r' });
    // 不需要：草稿
    db.upsertPrState('P/R/3', { isDraft: true, lastSourceCommit: 'x', repoId: 'g1', remoteUrl: 'http://r' });
    // 不需要：老数据无 remote_url（无法重建 PrRef）
    db.upsertPrState('P/R/4', { isDraft: false, lastSourceCommit: 'x' });
    // 需要：从未 review 过
    db.upsertPrState('P/R/5', { isDraft: false, lastSourceCommit: 'y', repoId: 'g2', remoteUrl: 'http://r2' });

    const stale = db.listPrStatesNeedingReview();
    expect(stale.map((s) => s.prKey).sort()).toEqual(['P/R/1', 'P/R/5']);
    expect(stale.find((s) => s.prKey === 'P/R/1')).toMatchObject({ repoId: 'g1', remoteUrl: 'http://r' });
    db.close();
  });

  it('listRecentRuns 新的在前', () => {
    const db = makeDb();
    const base = { prKey: 'P/R/1', repoKey: 'P/R', findingsTotal: 0, findingsPosted: 0, mustFix: 0, droppedByChallenge: 0, degraded: false };
    db.insertReviewRun({ ...base, kind: 'full', ok: true, durationMs: 100 });
    db.insertReviewRun({ ...base, kind: 'qa', ok: false, durationMs: 200, error: 'boom' });
    const runs = db.listRecentRuns(10);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ kind: 'qa', ok: false, error: 'boom' });
    expect(runs[0].createdAt).toBeTruthy();
    expect(db.listRecentRuns(1)).toHaveLength(1);
    db.close();
  });

  it('review_runs 记录与聚合统计', () => {
    const db = makeDb();
    const base = {
      prKey: 'P/R/1',
      repoKey: 'P/R',
      findingsTotal: 5,
      findingsPosted: 3,
      mustFix: 1,
      droppedByChallenge: 2,
      degraded: false,
    };
    db.insertReviewRun({ ...base, kind: 'full', ok: true, durationMs: 1000 });
    db.insertReviewRun({ ...base, prKey: 'P/R/2', kind: 'incremental', ok: true, durationMs: 3000 });
    db.insertReviewRun({ ...base, kind: 'qa', ok: false, durationMs: 500, error: '超时' });

    const o = db.statsOverview('2000-01-01 00:00:00');
    expect(o.runs).toBe(3);
    expect(o.failures).toBe(1);
    expect(o.prCount).toBe(2); // qa 不算 review 覆盖的 PR
    expect(o.findingsPosted).toBe(9);
    expect(o.mustFix).toBe(3);
    expect(o.droppedByChallenge).toBe(6);
    expect(o.byKind).toEqual({ full: 1, incremental: 1, qa: 1 });

    // repo 过滤 + 时间窗过滤
    expect(db.statsOverview('2000-01-01 00:00:00', 'Other/Repo').runs).toBe(0);
    expect(db.statsOverview('2999-01-01 00:00:00').runs).toBe(0);
    db.close();
  });

  it('老库迁移：无 repo_key 列时补列并回填', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-db-'));
    const dbPath = path.join(tmpDir, 'state.db');
    // 用旧 schema 建库
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE findings (
        pr_key TEXT NOT NULL, fingerprint TEXT NOT NULL, thread_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', severity TEXT NOT NULL, file TEXT NOT NULL,
        title TEXT NOT NULL, line INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (pr_key, fingerprint)
      );
      INSERT INTO findings (pr_key, fingerprint, thread_id, status, severity, file, title)
      VALUES ('Proj/Repo/9', 'fp1', 1, 'open', 'nit', 'a.ts', '旧数据');
    `);
    legacy.close();

    const db = new StateDb(dbPath);
    const open = db.listOpenFindings('Proj/Repo/9');
    expect(open).toHaveLength(1);
    expect(open[0].repoKey).toBe('Proj/Repo');
    db.close();
  });
});

describe('msUntilNextWeekly', () => {
  it('同周未到时点 → 本周；已过 → 下周；恰好在时点 → 整周', () => {
    // 2026-07-08 是周三
    const wed10 = new Date(2026, 6, 8, 10, 0, 0);
    // 下周一 09:00 = 4 天 23 小时后
    expect(msUntilNextWeekly(wed10, 1, 9)).toBe((4 * 24 + 23) * 3600_000);
    // 本周五 09:00 = 1 天 23 小时后
    expect(msUntilNextWeekly(wed10, 5, 9)).toBe((1 * 24 + 23) * 3600_000);
    // 恰好周三 09:00 → 一整周
    const wed9 = new Date(2026, 6, 8, 9, 0, 0);
    expect(msUntilNextWeekly(wed9, 3, 9)).toBe(7 * 24 * 3600_000);
  });
});

describe('extractImageUrls', () => {
  it('提取 markdown 图片，识别扩展名或 attachments 路径，尊重上限', () => {
    const md = [
      '看这个报错 ![err](http://ado/x/_apis/git/repositories/g/pullRequests/1/attachments/err.png)',
      '还有 ![截图](/DefaultCollection/p/_apis/git/repositories/g/pullRequests/1/attachments/shot)',
      '普通链接 [doc](http://ado/doc.pdf) 不算',
      '![a](http://x/1.jpg) ![b](http://x/2.jpeg) ![c](http://x/3.webp)',
    ].join('\n');
    const urls = extractImageUrls(md, 4);
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain('err.png');
    expect(urls[1]).toContain('/attachments/shot');
    expect(urls.some((u) => u.includes('doc.pdf'))).toBe(false);
  });

  it('无图片返回空数组', () => {
    expect(extractImageUrls('纯文本 [链接](http://x/a.html)')).toEqual([]);
  });
});

describe('findingFingerprint', () => {
  it('措辞里的数字与空白差异不影响指纹', () => {
    expect(findingFingerprint('a.ts', '第 3 行  空指针')).toBe(findingFingerprint('a.ts', '第 15 行 空指针'));
  });

  it('不同文件指纹不同', () => {
    expect(findingFingerprint('a.ts', 'x')).not.toBe(findingFingerprint('b.ts', 'x'));
  });
});
