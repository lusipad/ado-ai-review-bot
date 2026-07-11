import fs from 'node:fs';
import path from 'node:path';
import type { StateDb } from './state/db';
import { KnowledgeStore } from './knowledge';

/** 记忆与知识 tab 的数据：每个仓库的地图 + 长期记忆 */
export function buildKnowledge(db: StateDb, knowledge: KnowledgeStore) {
  return db.listKnownRepoKeys().map((repoKey) => {
    const entry = knowledge.get(repoKey);
    return {
      repoKey,
      map: entry?.content ?? null,
      mapGeneratedAt: entry?.generatedAt ?? null,
      memories: knowledge.getMemories(repoKey),
    };
  });
}

/** 文档 tab 的数据：直接读 docs/ 下的 markdown（跟随部署更新） */
export function buildDocs(docsDir = 'docs') {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(docsDir, name), 'utf8');
    } catch {
      return `（未找到 ${name}——离线部署包需包含 docs/ 目录）`;
    }
  };
  return { usage: read('usage.md'), examples: read('examples.md') };
}

const KIND_LABEL: Record<string, string> = {
  full: '全量',
  incremental: '增量',
  qa: '问答',
  fix: '修复',
  dream: '记忆整理',
};

/** 多 tab 公开门户：状态 / 记忆与知识 / 使用说明 / 示例。零外部依赖，内置迷你 md 渲染 */
export const PORTAL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Review Bot</title>
<style>
  :root { --fg:#1f2328; --muted:#656d76; --border:#d1d9e0; --bg:#f6f8fa; --card:#fff;
          --ok:#1a7f37; --bad:#cf222e; --accent:#0969da; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
  .wrap { max-width:1000px; margin:0 auto; padding:20px 16px 60px; }
  header { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-bottom:6px; }
  h1 { font-size:19px; margin:0; }
  .badge { padding:2px 8px; border-radius:10px; font-size:12px; background:#ddf4e4; color:var(--ok); }
  .badge.draining { background:#ffebe9; color:var(--bad); }
  .muted { color:var(--muted); font-size:12px; }
  nav { display:flex; gap:4px; border-bottom:1px solid var(--border); margin:12px 0 20px; flex-wrap:wrap; }
  nav a { padding:8px 14px; text-decoration:none; color:var(--muted); border-bottom:2px solid transparent; font-size:14px; }
  nav a.active { color:var(--fg); font-weight:600; border-bottom-color:var(--accent); }
  section { display:none; } section.active { display:block; }
  h2 { font-size:15px; margin:24px 0 10px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:10px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:12px 14px; }
  .card .v { font-size:22px; font-weight:600; } .card .k { color:var(--muted); font-size:12px; margin-top:2px; }
  .tablebox { overflow-x:auto; background:var(--card); border:1px solid var(--border); border-radius:8px; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  th, td { text-align:left; padding:7px 12px; border-top:1px solid var(--border); white-space:nowrap; }
  thead th { border-top:none; background:var(--bg); color:var(--muted); font-weight:500; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .pill { display:inline-block; padding:1px 7px; border-radius:9px; font-size:12px; background:var(--bg); border:1px solid var(--border); margin:1px; }
  select { font:inherit; padding:4px 8px; border:1px solid var(--border); border-radius:6px; background:var(--card); }
  .md { background:var(--card); border:1px solid var(--border); border-radius:8px; padding:20px 26px; overflow-x:auto; }
  .md h1 { font-size:20px; border-bottom:1px solid var(--border); padding-bottom:8px; }
  .md h2 { font-size:17px; margin-top:26px; } .md h3 { font-size:15px; }
  .md code { background:var(--bg); border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:12.5px; }
  .md pre { background:#0d1117; color:#e6edf3; padding:12px 14px; border-radius:8px; overflow-x:auto; }
  .md pre code { background:none; border:none; color:inherit; padding:0; }
  .md table { margin:10px 0; } .md td, .md th { white-space:normal; }
  .md blockquote { margin:10px 0; padding:6px 14px; border-left:3px solid var(--accent); background:var(--bg); border-radius:0 6px 6px 0; }
  .md img { max-width:100%; }
  .memline { padding:6px 10px; border-top:1px solid var(--border); font-size:13px; }
  .memline:first-child { border-top:none; }
  .tag { font-size:11px; padding:0 6px; border-radius:8px; background:var(--bg); border:1px solid var(--border); color:var(--muted); margin-right:6px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🤖 AI Review Bot</h1>
    <span id="up" class="badge">…</span>
    <span class="muted" id="meta"></span>
  </header>
  <nav id="tabs">
    <a href="#status" data-tab="status" class="active">状态</a>
    <a href="#knowledge" data-tab="knowledge">记忆与知识</a>
    <a href="#usage" data-tab="usage">使用说明</a>
    <a href="#examples" data-tab="examples">示例</a>
    <a href="/admin" style="margin-left:auto">管理面板 →</a>
  </nav>

  <section id="tab-status" class="active">
    <div class="cards" id="cards"></div>
    <h2>队列</h2>
    <div class="tablebox"><table id="queue"></table></div>
    <h2>各仓库意见采纳率（近 7 天已裁决部分）</h2>
    <div class="tablebox"><table id="acceptance">
      <thead><tr><th>仓库</th><th>采纳</th><th>拒绝</th><th>待处理</th><th>带病合并</th><th>采纳率</th></tr></thead>
      <tbody></tbody></table></div>
    <h2>最近任务</h2>
    <div class="tablebox"><table id="runs">
      <thead><tr><th>时间</th><th>对象</th><th>类型</th><th>结果</th><th>耗时</th><th>意见/必修</th></tr></thead>
      <tbody></tbody></table></div>
  </section>

  <section id="tab-knowledge">
    <p class="muted">bot 对每个仓库的「地图快照」（定期从代码重生成）与「长期记忆」（review 中积累、每周日 dream 自动整理；也可直接编辑 data/knowledge/ 下的 md 文件）。</p>
    <p><select id="repoSel"></select></p>
    <h2>长期记忆</h2>
    <div class="tablebox" id="memories"></div>
    <h2>仓库地图 <span class="muted" id="mapMeta"></span></h2>
    <div class="md" id="repoMap">（选择仓库）</div>
  </section>

  <section id="tab-usage"><div class="md" id="docUsage">加载中…</div></section>
  <section id="tab-examples"><div class="md" id="docExamples">加载中…</div></section>
</div>
<script>
const KIND = ${JSON.stringify(KIND_LABEL)};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtDur = (ms) => ms >= 60000 ? (ms/60000).toFixed(1) + ' 分' : Math.round(ms/1000) + ' 秒';
const fmtTime = (utc) => new Date(utc.replace(' ', 'T') + 'Z').toLocaleString();
const fmtUp = (s) => s >= 86400 ? Math.floor(s/86400) + ' 天' : s >= 3600 ? Math.floor(s/3600) + ' 小时' : Math.floor(s/60) + ' 分钟';

// ---- 迷你 markdown 渲染（够用即可：标题/粗斜体/行内码/围栏/列表/表格/引用/链接） ----
function md(src) {
  const blocks = [];
  src = src.replace(/\\r\\n/g, '\\n');
  src = src.replace(/\`\`\`[a-z]*\\n([\\s\\S]*?)\`\`\`/g, (_, code) => {
    blocks.push('<pre><code>' + esc(code) + '</code></pre>');
    return '\\u0000B' + (blocks.length - 1) + '\\u0000';
  });
  const lines = src.split('\\n');
  const out = [];
  let list = null, table = null, para = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('<' + list.tag + '>' + list.items.map(i => '<li>' + inline(i) + '</li>').join('') + '</' + list.tag + '>'); list = null; } };
  const flushTable = () => { if (table) {
    out.push('<div class="tablebox"><table><thead><tr>' + table.head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>' +
      table.rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'); table = null; } };
  function inline(t) {
    return esc(t)
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/(^|\\s)_([^_]+)_/g, '$1<em>$2</em>')
      .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  for (const raw of lines) {
    const line = raw;
    const cells = (s) => s.replace(/^\\||\\|$/g, '').split('|').map(c => c.trim());
    if (/^\\|.*\\|/.test(line.trim())) {
      flushPara(); flushList();
      if (!table) table = { head: cells(line.trim()), rows: [], sep: false };
      else if (!table.sep && /^[\\s|:-]+$/.test(line)) table.sep = true;
      else table.rows.push(cells(line.trim()));
      continue;
    }
    flushTable();
    const h = /^(#{1,4})\\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
    if (/^>\\s?/.test(line)) { flushPara(); flushList(); out.push('<blockquote>' + inline(line.replace(/^>\\s?/, '')) + '</blockquote>'); continue; }
    const li = /^\\s*[-*]\\s+(.*)$/.exec(line);
    if (li) { flushPara(); if (!list) list = { tag: 'ul', items: [] }; list.items.push(li[1]); continue; }
    const oli = /^\\s*\\d+[.、]\\s+(.*)$/.exec(line);
    if (oli) { flushPara(); if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(oli[1]); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    para.push(line.trim());
  }
  flushPara(); flushList(); flushTable();
  return out.join('\\n').replace(/\\u0000B(\\d+)\\u0000/g, (_, i) => blocks[Number(i)]);
}

// ---- tab 切换 ----
const loaded = {};
function activate(tab) {
  document.querySelectorAll('nav a[data-tab]').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  document.querySelectorAll('section').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  if (tab === 'knowledge' && !loaded.knowledge) loadKnowledge();
  if ((tab === 'usage' || tab === 'examples') && !loaded.docs) loadDocs();
}
document.getElementById('tabs').addEventListener('click', (e) => {
  const t = e.target.closest('a[data-tab]');
  if (!t) return;
  e.preventDefault();
  location.hash = t.dataset.tab;
  activate(t.dataset.tab);
});
window.addEventListener('hashchange', () => activate(location.hash.slice(1) || 'status'));

// ---- 状态 ----
async function loadStatus() {
  const res = await fetch('/status.json');
  if (!res.ok) { document.getElementById('up').textContent = '异常'; return; }
  const d = await res.json();
  const up = document.getElementById('up');
  up.textContent = d.queue.draining ? '停机排水中' : '运行中';
  up.className = 'badge' + (d.queue.draining ? ' draining' : '');
  document.getElementById('meta').textContent = 'v' + d.version + ' · 已运行 ' + fmtUp(d.uptimeSec) + ' · ' + new Date().toLocaleTimeString();
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
    (r.acceptanceRate === null ? '—' : Math.round(r.acceptanceRate*100) + '%') + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
  document.querySelector('#runs tbody').innerHTML = d.recentRuns.map(r =>
    '<tr><td>' + fmtTime(r.createdAt) + '</td><td>' + esc(r.prKey) + '</td><td>' + (KIND[r.kind] || esc(r.kind)) +
    '</td><td class="' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '成功' : '失败') + '</td><td>' + fmtDur(r.durationMs) +
    '</td><td>' + r.findingsPosted + ' / ' + r.mustFix + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">暂无任务</td></tr>';
}

// ---- 记忆与知识 ----
let knowledgeData = [];
async function loadKnowledge() {
  loaded.knowledge = true;
  knowledgeData = await (await fetch('/knowledge.json')).json();
  const sel = document.getElementById('repoSel');
  sel.innerHTML = knowledgeData.map((r, i) => '<option value="' + i + '">' + esc(r.repoKey) + '</option>').join('') || '<option>（暂无仓库）</option>';
  sel.onchange = () => showRepo(Number(sel.value));
  if (knowledgeData.length) showRepo(0);
}
function showRepo(i) {
  const r = knowledgeData[i];
  if (!r) return;
  document.getElementById('memories').innerHTML = r.memories.length
    ? r.memories.map(m => '<div class="memline"><span class="tag">' + esc(m.type) + '</span><span class="muted">' + esc(m.date) + '</span> ' + esc(m.text) + '</div>').join('')
    : '<div class="memline muted">（暂无记忆——review 过程中自动积累）</div>';
  document.getElementById('mapMeta').textContent = r.mapGeneratedAt ? '（' + r.mapGeneratedAt.slice(0, 10) + ' 生成）' : '';
  document.getElementById('repoMap').innerHTML = r.map ? md(r.map) : '（暂无——首次 review 后自动生成）';
}

// ---- 文档 ----
async function loadDocs() {
  loaded.docs = true;
  const d = await (await fetch('/docs.json')).json();
  document.getElementById('docUsage').innerHTML = md(d.usage);
  document.getElementById('docExamples').innerHTML = md(d.examples);
}

loadStatus();
setInterval(loadStatus, 30000);
activate(location.hash.slice(1) || 'status');
</script>
</body>
</html>`;
