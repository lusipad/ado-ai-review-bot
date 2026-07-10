import fs from 'node:fs';
import path from 'node:path';
import { sanitizePathSegment, sha1 } from './util';

export interface KnowledgeEntry {
  generatedAt: string;
  commit: string;
  content: string;
}

export type MemoryType = '约定' | '坑' | '决策' | '术语' | '其他';

export interface MemoryItem {
  date: string;
  type: MemoryType;
  text: string;
}

const MEMORY_TYPES: MemoryType[] = ['约定', '坑', '决策', '术语', '其他'];
/** 每仓库记忆上限，超出淘汰最旧的 */
const MEMORY_CAP = 50;
const MEMORY_LINE = /^-\s*\[(\d{4}-\d{2}-\d{2})\]\[([^\]]+)\]\s*(.+)$/;

/** 去重指纹：小写、抹平空白与数字（措辞微差不算新记忆） */
function memoryFingerprint(text: string): string {
  return sha1(text.toLowerCase().replace(/\s+/g, '').replace(/\d+/g, 'N'));
}

export function normalizeMemoryType(t: unknown): MemoryType {
  return MEMORY_TYPES.includes(t as MemoryType) ? (t as MemoryType) : '其他';
}

/** 仓库知识库：每仓库一份架构摘要（codex 生成），注入 review/问答提示词 */
export class KnowledgeStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(repoKey: string): string {
    return path.join(this.dir, sanitizePathSegment(repoKey) + '.json');
  }

  get(repoKey: string): KnowledgeEntry | undefined {
    try {
      const raw = fs.readFileSync(this.file(repoKey), 'utf8');
      const parsed = JSON.parse(raw);
      if (typeof parsed?.content === 'string' && typeof parsed?.generatedAt === 'string') {
        return parsed as KnowledgeEntry;
      }
    } catch {
      // 不存在或损坏 → 视为无
    }
    return undefined;
  }

  save(repoKey: string, entry: KnowledgeEntry): void {
    fs.writeFileSync(this.file(repoKey), JSON.stringify(entry, null, 2), 'utf8');
  }

  isFresh(entry: KnowledgeEntry | undefined, ttlDays: number): boolean {
    if (!entry) return false;
    const age = Date.now() - Date.parse(entry.generatedAt);
    return Number.isFinite(age) && age < ttlDays * 86_400_000;
  }

  // ---------- 长期记忆层（人工可编辑的 markdown，一行一条） ----------

  private memoryFile(repoKey: string): string {
    return path.join(this.dir, sanitizePathSegment(repoKey) + '-memory.md');
  }

  getMemories(repoKey: string): MemoryItem[] {
    try {
      const raw = fs.readFileSync(this.memoryFile(repoKey), 'utf8');
      const items: MemoryItem[] = [];
      for (const line of raw.split('\n')) {
        const m = MEMORY_LINE.exec(line.trim());
        if (m) items.push({ date: m[1], type: normalizeMemoryType(m[2]), text: m[3].trim() });
      }
      return items;
    } catch {
      return [];
    }
  }

  /** 追加记忆：归一化去重、超上限淘汰最旧；返回实际新增条数 */
  addMemories(repoKey: string, items: Array<{ type?: unknown; text: string }>): number {
    const existing = this.getMemories(repoKey);
    const seen = new Set(existing.map((m) => memoryFingerprint(m.text)));
    const today = new Date().toISOString().slice(0, 10);
    let added = 0;
    for (const it of items) {
      const text = it.text?.trim();
      if (!text || text.length > 300) continue;
      const fp = memoryFingerprint(text);
      if (seen.has(fp)) continue;
      seen.add(fp);
      existing.push({ date: today, type: normalizeMemoryType(it.type), text });
      added++;
    }
    if (added > 0) this.writeMemories(repoKey, existing.slice(-MEMORY_CAP));
    return added;
  }

  /** 整体重写（dream 整理用）；条目仍会走上限裁剪 */
  writeMemories(repoKey: string, items: MemoryItem[]): void {
    const lines = items
      .slice(-MEMORY_CAP)
      .map((m) => `- [${m.date}][${m.type}] ${m.text.replace(/\n+/g, ' ').trim()}`);
    const header = `<!-- ${repoKey} 的长期记忆：bot 自动积累 + 每周 dream 整理。可直接编辑：删错的、改过时的、手工补充团队约定 -->\n`;
    fs.writeFileSync(this.memoryFile(repoKey), header + lines.join('\n') + '\n', 'utf8');
  }

  /** 注入提示词/群聊展示用的原文 */
  memoriesText(repoKey: string): string {
    const items = this.getMemories(repoKey);
    return items.length
      ? items.map((m) => `- [${m.date}][${m.type}] ${m.text}`).join('\n')
      : '';
  }
}
