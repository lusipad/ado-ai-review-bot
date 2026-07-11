import fs from 'node:fs';
import type { StateDb } from './state/db';
import type { Scheduler } from './queue/scheduler';
import { collectStats } from './stats';

export function buildOverview(db: StateDb, scheduler: Scheduler, days: number) {
  return {
    now: new Date().toISOString(),
    windowDays: days,
    queue: scheduler.stats(),
    stats: collectStats(db, days),
    recentRuns: db.listRecentRuns(50),
  };
}

let cachedVersion: string | undefined;
function botVersion(): string {
  if (!cachedVersion) {
    try {
      cachedVersion = (JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version?: string }).version ?? '?';
    } catch {
      cachedVersion = '?';
    }
  }
  return cachedVersion;
}

const startedAt = Date.now();

/**
 * 公开状态数据（无鉴权）：团队成员看「活着没、在忙什么、效果如何」。
 * 与 /admin 的差异：最近任务不含错误详情文本（可能带内部路径/URL），条数更少。
 */
export function buildStatus(db: StateDb, scheduler: Scheduler, days: number) {
  const stats = collectStats(db, days);
  return {
    now: new Date().toISOString(),
    version: botVersion(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    windowDays: days,
    queue: scheduler.stats(),
    overview: stats.overview,
    acceptanceByRepo: stats.acceptanceByRepo,
    recentRuns: db.listRecentRuns(15).map((r) => ({
      prKey: r.prKey,
      kind: r.kind,
      ok: r.ok,
      durationMs: r.durationMs,
      findingsPosted: r.findingsPosted,
      mustFix: r.mustFix,
      createdAt: r.createdAt,
      // 刻意不暴露 error 文本
    })),
  };
}

const KIND_LABEL: Record<string, string> = {
  full: '全量',
  incremental: '增量',
  qa: '问答',
  fix: '修复',
  dream: '记忆整理',
};

/** 公开状态页：无鉴权只读，单文件零外部依赖 */
export const STATUS_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Review Bot 状态</title>
<style>
  :root { --fg:#1f2328; --muted:#656d76; --border:#d1d9e0; --bg:#f6f8fa; --card:#fff; --ok:#1a7f37; --bad:#cf222e; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
  .wrap { max-width:960px; margin:0 auto; padding:24px 16px 60px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  h1 { font-size:20px; margin:0; }
  h2 { font-size:15px; margin:26px 0 10px; }
  .muted { color:var(--muted); font-size:12px; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; background:#ddf4e4; color:var(--ok); }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; }
  .card .v { font-size:22px; font-weight:600; }
  .card .k { color:var(--muted); font-size:12px; margin-top:2px; }
  .tablebox { overflow-x:auto; background:var(--card); border:1px solid var(--border); border-radius:8px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:7px 12px; border-top:1px solid var(--border); white-space:nowrap; }
  thead th { border-top:none; background:var(--bg); color:var(--muted); font-weight:500; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .pill { display:inline-block; padding:1px 7px; border-radius:9px; font-size:12px; background:var(--bg); border:1px solid var(--border); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🤖 AI Review Bot 状态</h1>
    <span id="up" class="badge">…</span>
    <span class="muted" id="meta"></span>
  </header>
  <div class="cards" id="cards"></div>
  <h2>队列</h2>
  <div class="tablebox"><table id="queue"></table></div>
  <h2>各仓库采纳率（近 <span id="days">7</span> 天已裁决部分）</h2>
  <div class="tablebox"><table id="acceptance">
    <thead><tr><th>仓库</th><th>采纳</th><th>拒绝</th><th>待处理</th><th>带病合并</th><th>采纳率</th></tr></thead>
    <tbody></tbody></table></div>
  <h2>最近任务</h2>
  <div class="tablebox"><table id="runs">
    <thead><tr><th>时间</th><th>对象</th><th>类型</th><th>结果</th><th>耗时</th><th>意见/必修</th></tr></thead>
    <tbody></tbody></table></div>
  <p class="muted">只读状态页 · 完整明细与错误信息见管理面板 /admin（需密码）</p>
</div>
<script>
const KIND = ${JSON.stringify(KIND_LABEL)};
const fmtDur = (ms) => ms >= 60000 ? (ms/60000).toFixed(1) + ' 分' : Math.round(ms/1000) + ' 秒';
const fmtTime = (utc) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtUp = (s) => s >= 86400 ? Math.floor(s/86400) + ' 天 ' + Math.floor(s%86400/3600) + ' 小时' : s >= 3600 ? Math.floor(s/3600) + ' 小时 ' + Math.floor(s%3600/60) + ' 分' : Math.floor(s/60) + ' 分钟';

async function load() {
  const res = await fetch('/status.json');
  if (!res.ok) { document.getElementById('up').textContent = '异常'; return; }
  const d = await res.json();
  document.getElementById('up').textContent = d.queue.draining ? '停机排水中' : '运行中';
  document.getElementById('meta').textContent = 'v' + d.version + ' · 已运行 ' + fmtUp(d.uptimeSec) + ' · 更新于 ' + new Date().toLocaleTimeString();
  const o = d.overview;
  document.getElementById('cards').innerHTML = [
    [o.runs, '任务(' + d.windowDays + '天)'], [o.prCount, '覆盖 PR'], [o.findingsPosted, '发布意见'],
    [o.mustFix, '必须修复'], [o.failures, '失败', o.failures > 0 ? 'bad' : ''],
  ].map(([v,k,c]) => '<div class="card"><div class="v ' + (c||'') + '">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>').join('');
  const q = d.queue;
  document.getElementById('queue').innerHTML =
    '<tr><th>正在处理</th><td>' + (q.runningKeys.length ? q.runningKeys.map(k=>'<span class="pill">'+esc(k)+'</span>').join(' ') : '空闲') + '</td></tr>' +
    '<tr><th>排队 / 防抖 / 问答</th><td>' + q.pending + ' / ' + q.debouncing + ' / ' + q.activeQa + '</td></tr>';
  document.querySelector('#acceptance tbody').innerHTML = d.acceptanceByRepo.map(r =>
    '<tr><td>' + esc(r.repoKey) + '</td><td class="ok">' + r.accepted + '</td><td class="bad">' + r.rejected +
    '</td><td>' + r.open + '</td><td>' + (r.stale ?? 0) + '</td><td>' +
    (r.acceptanceRate === null ? '—' : Math.round(r.acceptanceRate*100) + '%') + '</td></tr>').join('') ||
    '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
  document.querySelector('#runs tbody').innerHTML = d.recentRuns.map(r =>
    '<tr><td>' + fmtTime(r.createdAt) + '</td><td>' + esc(r.prKey) + '</td><td>' + (KIND[r.kind] || esc(r.kind)) +
    '</td><td class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '成功' : '失败') + '</td><td>' + fmtDur(r.durationMs) +
    '</td><td>' + r.findingsPosted + ' / ' + r.mustFix + '</td></tr>').join('') ||
    '<tr><td colspan="6" class="muted">暂无任务</td></tr>';
}
load();
setInterval(load, 30000);
</script>
</body>
</html>`;

/** 单文件只读面板：无外部依赖（内网/CSP 友好），浏览器 basic auth（密码=WEBHOOK_SECRET） */
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Review Bot 管理面板</title>
<style>
  :root { --fg:#1f2328; --muted:#656d76; --border:#d1d9e0; --bg:#f6f8fa; --card:#fff;
          --ok:#1a7f37; --bad:#cf222e; --accent:#0969da; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         color:var(--fg); background:var(--bg); }
  .wrap { max-width:1100px; margin:0 auto; padding:24px 16px 60px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
  h1 { font-size:20px; margin:0; }
  h2 { font-size:15px; margin:28px 0 10px; }
  .muted { color:var(--muted); font-size:12px; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; background:#ddf4e4; color:var(--ok); }
  .badge.draining { background:#ffebe9; color:var(--bad); }
  select { font:inherit; padding:2px 6px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(140px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; }
  .card .v { font-size:22px; font-weight:600; }
  .card .k { color:var(--muted); font-size:12px; margin-top:2px; }
  .tablebox { overflow-x:auto; background:var(--card); border:1px solid var(--border); border-radius:8px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:7px 12px; border-top:1px solid var(--border); white-space:nowrap; }
  thead th { border-top:none; background:var(--bg); color:var(--muted); font-weight:500; }
  td.err { color:var(--bad); max-width:340px; overflow:hidden; text-overflow:ellipsis; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .pill { display:inline-block; padding:1px 7px; border-radius:9px; font-size:12px;
          background:var(--bg); border:1px solid var(--border); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🤖 AI Review Bot</h1>
    <span id="drain" class="badge">运行中</span>
    <span class="muted">统计窗口
      <select id="days"><option value="1">1 天</option><option value="7" selected>7 天</option><option value="30">30 天</option></select>
    </span>
    <span class="muted" id="updated"></span>
  </header>

  <div class="cards" id="cards"></div>

  <h2>队列</h2>
  <div class="tablebox"><table id="queue"></table></div>

  <h2>各仓库意见采纳率（已裁决部分）</h2>
  <div class="tablebox"><table id="acceptance">
    <thead><tr><th>仓库</th><th>意见总数</th><th>采纳</th><th>拒绝</th><th>待处理</th><th>带病合并</th><th>采纳率</th></tr></thead>
    <tbody></tbody></table></div>

  <h2>最近任务</h2>
  <div class="tablebox"><table id="runs">
    <thead><tr><th>时间</th><th>PR</th><th>类型</th><th>结果</th><th>耗时</th><th>发布/必修/拦截</th><th>错误</th></tr></thead>
    <tbody></tbody></table></div>
</div>
<script>
const KIND = ${JSON.stringify(KIND_LABEL)};
const fmtDur = (ms) => ms >= 60000 ? (ms/60000).toFixed(1) + ' 分' : Math.round(ms/1000) + ' 秒';
const fmtTime = (utc) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function load() {
  const days = document.getElementById('days').value;
  const res = await fetch('/admin/api/overview?days=' + days);
  if (!res.ok) { document.getElementById('updated').textContent = '加载失败 HTTP ' + res.status; return; }
  const d = await res.json();
  const o = d.stats.overview;

  const drain = document.getElementById('drain');
  drain.textContent = d.queue.draining ? '停机排水中' : '运行中';
  drain.className = 'badge' + (d.queue.draining ? ' draining' : '');
  document.getElementById('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();

  const cards = [
    [o.runs, '任务数'], [o.prCount, '覆盖 PR'], [o.findingsPosted, '发布意见'],
    [o.mustFix, '必须修复'], [o.droppedByChallenge, '拦截误报'],
    [o.failures, '失败', o.failures > 0 ? 'bad' : ''], [fmtDur(o.avgDurationMs), '平均耗时'],
  ];
  document.getElementById('cards').innerHTML = cards.map(([v, k, cls]) =>
    '<div class="card"><div class="v ' + (cls||'') + '">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>').join('');

  const q = d.queue;
  document.getElementById('queue').innerHTML =
    '<tr><th>正在处理</th><td>' + (q.runningKeys.length ? q.runningKeys.map(k => '<span class="pill">' + esc(k) + '</span>').join(' ') : '—') + '</td></tr>' +
    '<tr><th>排队中</th><td>' + q.pending + '</td></tr>' +
    '<tr><th>问答（进行/排队）</th><td>' + q.activeQa + ' / ' + q.qaQueued + '</td></tr>' +
    '<tr><th>防抖等待</th><td>' + (q.debouncingKeys.length ? q.debouncingKeys.map(k => '<span class="pill">' + esc(k) + '</span>').join(' ') : '—') + '</td></tr>';

  document.querySelector('#acceptance tbody').innerHTML = d.stats.acceptanceByRepo.map(r =>
    '<tr><td>' + esc(r.repoKey) + '</td><td>' + r.total + '</td><td class="ok">' + r.accepted +
    '</td><td class="bad">' + r.rejected + '</td><td>' + r.open + '</td><td class="' + (r.stale > 0 ? 'bad' : '') + '">' + (r.stale ?? 0) + '</td><td>' +
    (r.acceptanceRate === null ? '—' : Math.round(r.acceptanceRate * 100) + '%') + '</td></tr>').join('') ||
    '<tr><td colspan="7" class="muted">暂无数据</td></tr>';

  document.querySelector('#runs tbody').innerHTML = d.recentRuns.map(r =>
    '<tr><td>' + fmtTime(r.createdAt) + '</td><td>' + esc(r.prKey) + '</td><td>' + (KIND[r.kind] || esc(r.kind)) +
    '</td><td class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '成功' : '失败') + '</td><td>' + fmtDur(r.durationMs) +
    '</td><td>' + r.findingsPosted + ' / ' + r.mustFix + ' / ' + r.droppedByChallenge +
    '</td><td class="err" title="' + esc(r.error) + '">' + esc(r.error || '') + '</td></tr>').join('') ||
    '<tr><td colspan="7" class="muted">暂无任务记录</td></tr>';
}
document.getElementById('days').addEventListener('change', load);
load();
setInterval(load, 30000);
</script>
</body>
</html>`;
