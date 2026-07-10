import fs from 'node:fs';
import path from 'node:path';
import { sanitizePathSegment } from './util';

export interface KnowledgeEntry {
  generatedAt: string;
  commit: string;
  content: string;
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
}
