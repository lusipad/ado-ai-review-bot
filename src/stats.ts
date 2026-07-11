import type { StateDb, StatsOverview, RepoAcceptance } from './state/db';

export interface StatsReport {
  windowDays: number;
  since: string;
  overview: StatsOverview;
  acceptanceByRepo: Array<RepoAcceptance & { acceptanceRate: number | null }>;
}

/** SQLite datetime('now') 是 UTC 'YYYY-MM-DD HH:MM:SS'，比较用同一格式 */
export function sinceUtc(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}

export function collectStats(db: StateDb, days: number, repo?: string): StatsReport {
  const since = sinceUtc(days);
  const acceptance = db
    .acceptanceByRepo(since)
    .filter((r) => !repo || r.repoKey === repo)
    .map((r) => {
      const decided = r.accepted + r.rejected;
      return { ...r, acceptanceRate: decided > 0 ? r.accepted / decided : null };
    });
  return {
    windowDays: days,
    since,
    overview: db.statsOverview(since, repo),
    acceptanceByRepo: acceptance,
  };
}

/** IM 周报文本（markdown，兼容企业微信/RocketChat） */
export function formatWeeklyReport(stats: StatsReport): string {
  const o = stats.overview;
  const lines: string[] = [
    `**过去 ${stats.windowDays} 天**`,
    `- review ${o.runs} 次（全量 ${o.byKind.full ?? 0} / 增量 ${o.byKind.incremental ?? 0} / 问答 ${o.byKind.qa ?? 0}），覆盖 ${o.prCount} 个 PR，失败 ${o.failures} 次`,
    `- 发布意见 ${o.findingsPosted} 条（must-fix ${o.mustFix} 条），二次复核拦截疑似误报 ${o.droppedByChallenge} 条`,
    `- 平均耗时 ${Math.round(o.avgDurationMs / 1000)} 秒`,
  ];
  if (stats.acceptanceByRepo.length > 0) {
    lines.push('**各仓库意见采纳率**（已裁决部分）');
    for (const r of stats.acceptanceByRepo.slice(0, 10)) {
      const rate = r.acceptanceRate === null ? '—' : `${Math.round(r.acceptanceRate * 100)}%`;
      const stale = r.stale > 0 ? ` / ⚠️ 带病合并 ${r.stale}` : '';
      lines.push(`- ${r.repoKey}：${rate}（采纳 ${r.accepted} / 拒绝 ${r.rejected} / 待处理 ${r.open}${stale}）`);
    }
  }
  return lines.join('\n');
}
