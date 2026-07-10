import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateDb } from '../src/state/db';
import { findingFingerprint } from '../src/util';

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
    const fp = findingFingerprint('src/a.ts', '空指针风险');

    db.insertFinding({ prKey: key, fingerprint: fp, threadId: 7, severity: 'must-fix', file: 'src/a.ts', title: '空指针风险', line: 10 });
    expect(db.hasFingerprint(key, fp)).toBe(true);
    expect(db.hasFingerprint(key, 'other')).toBe(false);

    // 同指纹重复插入不报错、不重复
    db.insertFinding({ prKey: key, fingerprint: fp, threadId: 8, severity: 'must-fix', file: 'src/a.ts', title: '空指针风险', line: 10 });
    expect(db.listOpenFindings(key)).toHaveLength(1);
    expect(db.listOpenFindings(key)[0].threadId).toBe(7);

    db.markFindingFixed(key, 7);
    expect(db.listOpenFindings(key)).toHaveLength(0);
    db.close();
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
