import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KnowledgeStore } from '../src/knowledge';

let tmpDir: string;

function makeStore(): KnowledgeStore {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-review-kb-'));
  return new KnowledgeStore(tmpDir);
}

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KnowledgeStore 长期记忆', () => {
  it('追加、解析、类型归一、注入文本', () => {
    const s = makeStore();
    const added = s.addMemories('P/R', [
      { type: '坑', text: '结算金额单位是分' },
      { type: '不认识的类型', text: '网关模块单线程写' },
      { type: '术语', text: '' }, // 空文本丢弃
    ]);
    expect(added).toBe(2);
    const items = s.getMemories('P/R');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: '坑', text: '结算金额单位是分' });
    expect(items[1].type).toBe('其他');
    expect(s.memoriesText('P/R')).toContain('[坑] 结算金额单位是分');
  });

  it('归一化去重：措辞里的空白与数字差异不算新记忆', () => {
    const s = makeStore();
    s.addMemories('P/R', [{ type: '坑', text: '第 3 步会超时' }]);
    const added = s.addMemories('P/R', [
      { type: '坑', text: '第 15 步 会超时' }, // 数字/空白差异 → 重复
      { type: '坑', text: '完全不同的新记忆' },
    ]);
    expect(added).toBe(1);
    expect(s.getMemories('P/R')).toHaveLength(2);
  });

  it('上限 50 条，超出淘汰最旧', () => {
    const s = makeStore();
    for (let i = 0; i < 55; i++) {
      s.addMemories('P/R', [{ type: '其他', text: `记忆条目字母${'abcdefghij'[i % 10]}序号${'甲乙丙丁戊己庚辛壬癸'[Math.floor(i / 10) % 10]}${'一二三四五六七八九十'[i % 10]}` }]);
    }
    const items = s.getMemories('P/R');
    expect(items.length).toBeLessThanOrEqual(50);
  });

  it('人工可编辑：直接改文件后能读回；writeMemories 整体重写', () => {
    const s = makeStore();
    s.addMemories('P/R', [{ type: '约定', text: '旧记忆' }]);
    s.writeMemories('P/R', [
      { date: '2026-01-01', type: '决策', text: '整理后的记忆' },
    ]);
    const items = s.getMemories('P/R');
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({ date: '2026-01-01', type: '决策', text: '整理后的记忆' });
  });

  it('无记忆文件返回空', () => {
    const s = makeStore();
    expect(s.getMemories('X/Y')).toEqual([]);
    expect(s.memoriesText('X/Y')).toBe('');
  });
});
