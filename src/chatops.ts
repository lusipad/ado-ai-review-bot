import type { StateDb } from './state/db';
import type { Scheduler } from './queue/scheduler';
import { KnowledgeStore } from './knowledge';
import { collectStats, formatWeeklyReport } from './stats';
import { truncateUtf8Bytes } from './util';

export interface ChatOpsDeps {
  db: StateDb;
  scheduler: Scheduler;
  adoUrl: string;
  knowledge: KnowledgeStore;
}

/** RocketChat outgoing webhook 的 payload（只声明用到的字段） */
export interface RocketChatOutgoing {
  token?: string;
  user_name?: string;
  text?: string;
  bot?: unknown;
  trigger_word?: string;
}

const HELP = [
  '我能回答：',
  '- `状态` — 当前队列与正在处理的 PR',
  '- `统计 [天数]` — review 次数、意见与采纳率（默认 7 天）',
  '- `待处理` — 各仓库未解决的 must-fix 清单',
  '- `架构 <项目/仓库>` — 该仓库的架构摘要（知识库缓存）',
  '- `帮助` — 本说明',
].join('\n');

/** prKey = project/repo/prId → PR 页面链接 */
function prUrl(adoUrl: string, prKey: string): string {
  const parts = prKey.split('/');
  const prId = parts.pop();
  const repo = parts.pop();
  const project = parts.join('/');
  return `${adoUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo ?? '')}/pullrequest/${prId}`;
}

/**
 * 处理群聊命令，返回要贴回频道的 markdown 文本。
 * 全部为结构化查询：不调模型、秒回。
 */
export function handleChatCommand(rawText: string, deps: ChatOpsDeps): string {
  const text = rawText.trim();

  // 注意：\b 对 CJK 无效，用 (?:\s|$) 判界
  if (/^(状态|status)(?:\s|$)/i.test(text)) {
    const q = deps.scheduler.stats();
    const lines = [
      `**当前状态**${q.draining ? '（⚠️ 停机排水中）' : ''}`,
      `- 正在处理：${q.runningKeys.length ? q.runningKeys.join('、') : '无'}`,
      `- 排队中：${q.pending}，问答进行/排队：${q.activeQa}/${q.qaQueued}`,
      `- 防抖等待：${q.debouncingKeys.length ? q.debouncingKeys.join('、') : '无'}`,
    ];
    return lines.join('\n');
  }

  const statsMatch = /^(统计|stats)\s*(\d+)?/i.exec(text);
  if (statsMatch) {
    const days = Math.min(365, Math.max(1, Number(statsMatch[2]) || 7));
    return formatWeeklyReport(collectStats(deps.db, days));
  }

  if (/^(待处理|must-?fix)(?:\s|$)/i.test(text)) {
    const open = deps.db.listOpenMustFix(15);
    if (open.length === 0) return '✅ 当前没有未解决的 must-fix。';
    return [
      `**未解决的 must-fix（${open.length} 条）**`,
      ...open.map((f) => `- [${f.prKey}](${prUrl(deps.adoUrl, f.prKey)}) ${f.file}:${f.line} ${f.title}`),
    ].join('\n');
  }

  const archMatch = /^(架构|arch)\s+(\S+)/i.exec(text);
  if (archMatch) {
    const repoKey = archMatch[2];
    const entry = deps.knowledge.get(repoKey);
    if (!entry) return `没有 \`${repoKey}\` 的知识库缓存（首次 review 后自动生成）。格式：项目/仓库，如 \`test/test\`。`;
    return truncateUtf8Bytes(`**${repoKey} 架构摘要**（${entry.generatedAt.slice(0, 10)} 生成）\n\n${entry.content}`, 3500, '\n…（已截断）');
  }

  return HELP;
}
