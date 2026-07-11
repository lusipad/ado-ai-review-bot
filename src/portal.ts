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

/**
 * 多 tab 公开门户。设计遵循 dataviz 参考色板（明暗双模式各自选定，非自动翻转）：
 * 墨色/表面/发丝线来自 chrome 表，状态色固定且永远「色点+文字」成对出现，
 * 数字列右对齐 tabular-nums，采纳率用同色系浅轨 meter。零外部依赖。
 */
export const PORTAL_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Review Bot</title>
<style>
  :root {
    --plane:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#898781;
    --hairline:#e1e0d9; --ring:rgba(11,11,11,.10);
    --accent:#2a78d6; --accent-track:#cde2fb;
    --good:#0ca30c; --good-text:#006300; --bad:#d03b3b; --warn:#fab219;
    --code-bg:#f0efec; --pre-bg:#1a1a19; --pre-ink:#e6edf3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --plane:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7; --ink-3:#898781;
      --hairline:#2c2c2a; --ring:rgba(255,255,255,.10);
      --accent:#3987e5; --accent-track:#184f95;
      --good:#0ca30c; --good-text:#0ca30c; --bad:#d03b3b; --warn:#fab219;
      --code-bg:#2c2c2a; --pre-bg:#0d0d0d; --pre-ink:#e6edf3;
    }
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; font:14px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         color:var(--ink); background:var(--plane); }
  .wrap { max-width:1080px; margin:0 auto; padding:28px 20px 72px; }

  header { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .brand { font-size:17px; font-weight:650; letter-spacing:-.01em; }
  .live { display:inline-flex; align-items:center; gap:7px; font-size:12.5px; color:var(--ink-2);
          padding:3px 11px 3px 9px; border:1px solid var(--ring); border-radius:999px; background:var(--surface); }
  .live .dot { width:8px; height:8px; border-radius:50%; background:var(--good); }
  .live.down .dot { background:var(--bad); }
  .meta { color:var(--ink-3); font-size:12.5px; margin-left:auto; }

  nav { display:flex; gap:2px; margin:22px 0 26px; border-bottom:1px solid var(--hairline); }
  nav a { padding:9px 14px 11px; text-decoration:none; color:var(--ink-2); font-size:14px;
          border-bottom:2px solid transparent; margin-bottom:-1px; }
  nav a:hover { color:var(--ink); }
  nav a.active { color:var(--ink); font-weight:600; border-bottom-color:var(--accent); }
  nav .adminlink { margin-left:auto; color:var(--ink-3); font-size:13px; }
  section { display:none; } section.active { display:block; }

  h2 { font-size:13px; font-weight:600; letter-spacing:.02em; color:var(--ink-2);
       text-transform:none; margin:30px 0 10px; }
  .muted { color:var(--ink-3); font-size:12.5px; }

  .tiles { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; }
  .tile { background:var(--surface); border:1px solid var(--ring); border-radius:10px;
          padding:14px 16px 12px; box-shadow:0 1px 2px rgba(0,0,0,.03); }
  .tile .v { font-size:27px; font-weight:600; letter-spacing:-.01em; line-height:1.15; }
  .tile .v.bad { color:var(--bad); }
  .tile .k { color:var(--ink-2); font-size:12.5px; margin-top:3px; }

  .panel { background:var(--surface); border:1px solid var(--ring); border-radius:10px;
           box-shadow:0 1px 2px rgba(0,0,0,.03); overflow:hidden; }
  .kv { display:flex; padding:10px 16px; gap:16px; border-top:1px solid var(--hairline); font-size:13.5px; }
  .kv:first-child { border-top:none; }
  .kv .k { color:var(--ink-2); min-width:130px; flex-shrink:0; }
  .kv .v { color:var(--ink); }

  .tablebox { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:13.5px; }
  th, td { text-align:left; padding:9px 16px; border-top:1px solid var(--hairline); white-space:nowrap; }
  thead th { border-top:none; color:var(--ink-3); font-weight:500; font-size:12px; letter-spacing:.02em; }
  tbody tr:hover { background:color-mix(in srgb, var(--ink) 3%, transparent); }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  td.time { color:var(--ink-2); font-variant-numeric:tabular-nums; font-size:12.5px; }

  .status { display:inline-flex; align-items:center; gap:6px; }
  .status .dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .status.ok .dot { background:var(--good); } .status.ok { color:var(--good-text); }
  .status.fail .dot { background:var(--bad); } .status.fail { color:var(--bad); }

  .kind { display:inline-block; font-size:12px; color:var(--ink-2); background:color-mix(in srgb, var(--ink) 5%, transparent);
          border-radius:6px; padding:1px 8px; }
  .chip { display:inline-block; font-size:12.5px; padding:2px 10px; border:1px solid var(--ring);
          border-radius:999px; background:color-mix(in srgb, var(--accent) 8%, transparent); margin:1px 3px 1px 0; }

  .meter { display:inline-flex; align-items:center; gap:9px; }
  .meter .track { width:96px; height:6px; border-radius:3px; background:var(--accent-track); overflow:hidden; }
  .meter .fill { height:100%; border-radius:3px; background:var(--accent); }
  .meter .pct { font-variant-numeric:tabular-nums; min-width:38px; }

  select { font:inherit; font-size:13.5px; padding:6px 10px; color:var(--ink);
           border:1px solid var(--ring); border-radius:8px; background:var(--surface); }

  .memline { display:flex; gap:10px; align-items:baseline; padding:9px 16px; border-top:1px solid var(--hairline); font-size:13.5px; }
  .memline:first-child { border-top:none; }
  .memline .date { color:var(--ink-3); font-size:12px; font-variant-numeric:tabular-nums; flex-shrink:0; }
  .tag { font-size:11.5px; padding:0 8px; border-radius:999px; border:1px solid var(--ring);
         color:var(--ink-2); background:color-mix(in srgb, var(--ink) 4%, transparent); flex-shrink:0; }

  .md { background:var(--surface); border:1px solid var(--ring); border-radius:10px;
        padding:26px 32px; box-shadow:0 1px 2px rgba(0,0,0,.03); overflow-x:auto; line-height:1.75; }
  .md > :first-child { margin-top:0; }
  .md h1 { font-size:21px; letter-spacing:-.01em; border-bottom:1px solid var(--hairline); padding-bottom:10px; }
  .md h2 { font-size:17px; color:var(--ink); letter-spacing:0; text-transform:none; margin:30px 0 12px; font-weight:650; }
  .md h3 { font-size:14.5px; }
  .md p, .md li { color:var(--ink-2); } .md strong { color:var(--ink); }
  .md code { background:var(--code-bg); border-radius:5px; padding:1.5px 6px; font-size:12.5px;
             font-family:ui-monospace,Consolas,monospace; }
  .md pre { background:var(--pre-bg); color:var(--pre-ink); padding:14px 16px; border-radius:8px; overflow-x:auto; }
  .md pre code { background:none; padding:0; color:inherit; font-size:12.5px; line-height:1.6; }
  .md table { margin:12px 0; font-size:13px; }
  .md td, .md th { white-space:normal; padding:8px 12px; }
  .md blockquote { margin:12px 0; padding:8px 16px; border-left:3px solid var(--accent);
                   background:color-mix(in srgb, var(--accent) 5%, transparent); border-radius:0 8px 8px 0; color:var(--ink-2); }
  .md a { color:var(--accent); text-decoration:none; } .md a:hover { text-decoration:underline; }
  .md img { max-width:100%; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="brand">AI Review Bot</span>
    <span id="live" class="live"><span class="dot"></span><span id="liveText">连接中…</span></span>
    <span class="meta" id="meta"></span>
  </header>
  <nav id="tabs">
    <a href="#status" data-tab="status" class="active">状态</a>
    <a href="#knowledge" data-tab="knowledge">记忆与知识</a>
    <a href="#usage" data-tab="usage">使用说明</a>
    <a href="#examples" data-tab="examples">示例</a>
    <a href="/admin" class="adminlink">管理面板 ↗</a>
  </nav>

  <section id="tab-status" class="active">
    <div class="tiles" id="tiles"></div>
    <h2>队列</h2>
    <div class="panel" id="queue"></div>
    <h2>各仓库意见采纳率（近 7 天已裁决部分）</h2>
    <div class="panel tablebox"><table id="acceptance">
      <thead><tr><th>仓库</th><th>采纳率</th><th class="num">采纳</th><th class="num">拒绝</th><th class="num">待处理</th><th class="num">带病合并</th></tr></thead>
      <tbody></tbody></table></div>
    <h2>最近任务</h2>
    <div class="panel tablebox"><table id="runs">
      <thead><tr><th>时间</th><th>对象</th><th>类型</th><th>结果</th><th class="num">耗时</th><th class="num">意见 / 必修</th></tr></thead>
      <tbody></tbody></table></div>
  </section>

  <section id="tab-knowledge">
    <p class="muted" style="margin-top:0">bot 对每个仓库的「地图快照」（定期从代码重生成）与「长期记忆」（review 中积累、每周日 dream 自动整理；也可直接编辑 data/knowledge/ 下的 md 文件）。</p>
    <p><select id="repoSel"></select></p>
    <h2>长期记忆</h2>
    <div class="panel" id="memories"></div>
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
const fmtTime = (utc) => { const d = new Date(utc.replace(' ', 'T') + 'Z');
  return (d.getMonth()+1) + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
const fmtUp = (s) => s >= 86400 ? Math.floor(s/86400) + ' 天' : s >= 3600 ? Math.floor(s/3600) + ' 小时' : Math.floor(s/60) + ' 分钟';

// ---- 迷你 markdown 渲染 ----
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
  let d;
  try { d = await (await fetch('/status.json')).json(); }
  catch { document.getElementById('liveText').textContent = '连接失败'; document.getElementById('live').classList.add('down'); return; }
  const live = document.getElementById('live');
  live.classList.toggle('down', !!d.queue.draining);
  document.getElementById('liveText').textContent = d.queue.draining ? '停机排水中' : '运行中';
  document.getElementById('meta').textContent = 'v' + d.version + ' · 已运行 ' + fmtUp(d.uptimeSec);
  const o = d.overview;
  document.getElementById('tiles').innerHTML = [
    [o.runs, '任务 · 近 ' + d.windowDays + ' 天'], [o.prCount, '覆盖 PR'], [o.findingsPosted, '发布意见'],
    [o.mustFix, '必须修复'], [o.failures, '失败', o.failures > 0],
  ].map(([v,k,bad]) => '<div class="tile"><div class="v' + (bad ? ' bad' : '') + '">' + esc(v) + '</div><div class="k">' + esc(k) + '</div></div>').join('');
  const q = d.queue;
  document.getElementById('queue').innerHTML =
    '<div class="kv"><span class="k">正在处理</span><span class="v">' +
      (q.runningKeys.length ? q.runningKeys.map(k=>'<span class="chip">'+esc(k)+'</span>').join('') : '<span class="muted">空闲</span>') + '</span></div>' +
    '<div class="kv"><span class="k">排队 / 防抖 / 问答</span><span class="v" style="font-variant-numeric:tabular-nums">' + q.pending + ' / ' + q.debouncing + ' / ' + q.activeQa + '</span></div>';
  document.querySelector('#acceptance tbody').innerHTML = d.acceptanceByRepo.map(r => {
    const rate = r.acceptanceRate;
    const meter = rate === null ? '<span class="muted">—</span>'
      : '<span class="meter"><span class="track"><span class="fill" style="width:' + Math.round(rate*100) + '%"></span></span><span class="pct">' + Math.round(rate*100) + '%</span></span>';
    return '<tr><td>' + esc(r.repoKey) + '</td><td>' + meter + '</td><td class="num">' + r.accepted +
      '</td><td class="num">' + r.rejected + '</td><td class="num">' + r.open + '</td><td class="num">' + (r.stale ?? 0) + '</td></tr>';
  }).join('') || '<tr><td colspan="6" class="muted">暂无数据</td></tr>';
  document.querySelector('#runs tbody').innerHTML = d.recentRuns.map(r =>
    '<tr><td class="time">' + fmtTime(r.createdAt) + '</td><td>' + esc(r.prKey) + '</td><td><span class="kind">' + (KIND[r.kind] || esc(r.kind)) +
    '</span></td><td><span class="status ' + (r.ok ? 'ok' : 'fail') + '"><span class="dot"></span>' + (r.ok ? '成功' : '失败') + '</span></td><td class="num">' + fmtDur(r.durationMs) +
    '</td><td class="num">' + r.findingsPosted + ' / ' + r.mustFix + '</td></tr>').join('') || '<tr><td colspan="6" class="muted">暂无任务</td></tr>';
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
    ? r.memories.map(m => '<div class="memline"><span class="date">' + esc(m.date) + '</span><span class="tag">' + esc(m.type) + '</span><span>' + esc(m.text) + '</span></div>').join('')
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
