import json, os

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
d = json.load(open(os.path.join(BASE, 'data/voices.json'), encoding='utf-8'))
payload = json.dumps(d, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')

HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>声音引擎库 · dsh-voice-engine</title>
<style>
*{box-sizing:border-box}
:root{
  --bg:#f7f7f4; --surf:#ffffff; --bd:#e5e3db; --bd2:#d5d2c8;
  --tx:#1c1b18; --tx2:#6a675f; --tx3:#9d9a92;
  --acc:#1f6feb; --accbg:#eef4ff;
  --ok:#0d7a52; --okbg:#e7f6ef;
  --warn:#8a5200; --warnbg:#fdf2e3;
  --lock:#7a7871; --lockbg:#f0efeb;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#17171a; --surf:#1f1f23; --bd:#2e2e34; --bd2:#3a3a41;
    --tx:#ecebe8; --tx2:#a3a09a; --tx3:#6f6d68;
    --acc:#6a9bff; --accbg:#1b2740;
    --ok:#4ec9a0; --okbg:#14332a;
    --warn:#e0a458; --warnbg:#332614;
    --lock:#8b8983; --lockbg:#26262a;
  }
}
html,body{margin:0;height:100%;overflow-x:hidden}
body{
  background:var(--bg); color:var(--tx);
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased; display:flex; flex-direction:column; min-height:100%;
}
header,main,footer{min-width:0}
header{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--bd);padding:12px 16px 10px}
.r1{display:flex;align-items:center;gap:12px;margin-bottom:10px}
h1{font-size:14px;font-weight:600;margin:0;letter-spacing:.01em}
h1 span{color:var(--tx3);font-weight:400;margin-left:6px;font-size:12px}
.stat{font-size:11.5px;color:var(--tx2);margin-left:auto;font-variant-numeric:tabular-nums}
.seg{display:flex;background:var(--lockbg);border-radius:8px;padding:2px;flex:0 0 auto}
.seg button{border:0;background:transparent;color:var(--tx2);font:inherit;font-size:12px;padding:4px 12px;border-radius:6px;cursor:pointer}
.seg button.on{background:var(--surf);color:var(--tx);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.sbox{position:relative;display:flex;gap:8px;margin-bottom:9px}
.sbox input{
  flex:1;min-width:0;height:34px;border:1px solid var(--bd);border-radius:8px;background:var(--surf);color:var(--tx);
  padding:0 34px 0 32px;font:inherit;font-size:13px;outline:none;
}
.sbox input:focus{border-color:var(--acc);box-shadow:0 0 0 3px var(--accbg)}
.sbox .mag{position:absolute;left:11px;top:9px;color:var(--tx3);pointer-events:none}
.sbox .clr{position:absolute;right:6px;top:5px;width:24px;height:24px;border:0;background:transparent;color:var(--tx3);cursor:pointer;font-size:16px;line-height:1;border-radius:5px;display:none}
.sbox .clr:hover{background:var(--lockbg);color:var(--tx)}
.sbox.has .clr{display:block}
.frow{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
.frow::-webkit-scrollbar{display:none}
.frow+.frow{margin-top:6px}
.chip{
  flex:0 0 auto;border:1px solid var(--bd);background:var(--surf);color:var(--tx2);
  font:inherit;font-size:12px;padding:3px 10px;border-radius:99px;cursor:pointer;white-space:nowrap;
  transition:.1s;font-variant-numeric:tabular-nums;
}
.chip:hover{border-color:var(--bd2);color:var(--tx)}
.chip.on{background:var(--tx);border-color:var(--tx);color:var(--bg)}
.chip.on .n{opacity:.6}
.chip .n{margin-left:4px;font-size:11px}
.chip.lbl{border:0;background:transparent;color:var(--tx3);cursor:default;padding-left:0;padding-right:2px;font-size:11.5px}
.sel-wrap{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:4px}
.sel-wrap>span{font-size:11.5px;color:var(--tx3);margin-left:10px;white-space:nowrap}
.sel-wrap select{
  appearance:none;min-width:104px;border:1px solid var(--bd);background:var(--surf);color:var(--tx2);
  font:inherit;font-size:12px;padding:3px 22px 3px 9px;border-radius:99px;cursor:pointer;outline:none;
  background-image:url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' stroke='%239d9a92' stroke-width='1.4' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat:no-repeat;background-position:right 7px center;
}
.sel-wrap select:focus{border-color:var(--acc);box-shadow:0 0 0 2px var(--accbg)}
.sel-wrap select.on{border-color:var(--tx);color:var(--tx)}

main{flex:1;padding:14px 16px 90px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(238px,1fr));gap:10px}
.card{
  position:relative;background:var(--surf);border:1px solid var(--bd);border-radius:10px;
  padding:11px 12px 10px;cursor:pointer;transition:border-color .12s,box-shadow .12s;overflow:hidden;
}
.card:hover{border-color:var(--bd2)}
.card.sel{border-color:var(--acc);box-shadow:0 0 0 2px var(--accbg)}
.card.play{border-color:var(--acc)}
.ctop{display:flex;align-items:center;gap:9px;margin-bottom:7px}
.pbtn{
  width:30px;height:30px;flex:0 0 auto;border-radius:50%;border:0;background:var(--accbg);color:var(--acc);
  display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:.1s;
}
.pbtn:hover:not(:disabled){filter:brightness(.96)}
.pbtn:disabled{background:var(--lockbg);color:var(--tx3);cursor:not-allowed}
.cname{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.cmeta{font-size:11.5px;color:var(--tx2);margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccode{
  font-family:var(--mono);font-size:10.5px;color:var(--tx3);background:var(--lockbg);
  padding:2px 6px;border-radius:4px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.badge{font-size:10px;padding:1px 7px;border-radius:99px;font-weight:500;flex:0 0 auto;white-space:nowrap}
.b-both{background:var(--okbg);color:var(--ok)}
.b-use{background:var(--warnbg);color:var(--warn)}
.b-listen{background:var(--accbg);color:var(--acc)}
.b-locked{background:var(--lockbg);color:var(--lock)}
.prog{position:absolute;left:0;bottom:0;height:2px;width:0;background:var(--acc);transition:width .2s linear}

.tbl{width:100%;border-collapse:collapse;font-size:12.5px;table-layout:fixed}
.tbl th{
  position:sticky;top:0;background:var(--bg);text-align:left;padding:7px 10px;
  border-bottom:1px solid var(--bd2);font-weight:500;color:var(--tx2);font-size:11.5px;z-index:1;
}
.tbl td{padding:6px 10px;border-bottom:1px solid var(--bd);vertical-align:middle}
.tbl tbody tr{cursor:pointer}
.tbl tbody tr:hover td{background:var(--accbg)}
.tbl tbody tr.sel td{background:var(--accbg)}
.tbl .nm{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl .cd{font-family:var(--mono);font-size:11px;color:var(--tx2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tbl .mute{color:var(--tx3)}
.tbl .pbtn{width:24px;height:24px}

.empty{text-align:center;color:var(--tx3);padding:60px 0;font-size:13px}
.bar{
  position:fixed;left:0;right:0;bottom:0;z-index:30;background:var(--surf);border-top:1px solid var(--bd);
  transform:translateY(105%);transition:transform .18s ease;
}
.bar.show{transform:none}
.bar-in{display:flex;align-items:center;gap:12px;padding:10px 16px;max-width:1400px;margin:0 auto}
.bar-info{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.bar-info .nm{font-weight:600;font-size:13px;white-space:nowrap}
.bar-info code{font-family:var(--mono);font-size:11px;color:var(--tx2);background:var(--lockbg);padding:2px 7px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-act{display:flex;gap:7px;flex:0 0 auto}
.btn{border:1px solid var(--bd);background:var(--surf);color:var(--tx);font:inherit;font-size:12px;padding:6px 13px;border-radius:7px;cursor:pointer}
.btn:hover{border-color:var(--bd2)}
.btn.pri{background:var(--acc);border-color:var(--acc);color:#fff}
.btn.pri:hover{filter:brightness(1.06)}
.btn:disabled{opacity:.45;cursor:not-allowed}
mark{background:#ffe9a8;color:inherit;border-radius:2px;padding:0 1px}
@media (prefers-color-scheme:dark){mark{background:#5c4a12;color:#ffe9a8}}
@media (max-width:640px){
  header{padding:10px 12px 8px}
  h1 span{display:none}
  main{padding:10px 12px 96px}
  .cards{grid-template-columns:1fr;gap:8px}
  .bar-in{padding:9px 12px;flex-wrap:wrap}
  .bar-act{width:100%}
  .bar-act .btn{flex:1}
  .tbl .hide-s{display:none}
}
@media (max-width:430px){
  h1{font-size:13px}
  .stat{font-size:11px}
  .seg button{padding:4px 9px;font-size:11.5px}
  .r1{gap:8px}
  .card{padding:10px 11px 9px}
  .cname{font-size:13px}
}
</style>
</head>
<body>
<header>
  <div class="r1">
    <h1>声音引擎库<span>dsh-voice-engine</span></h1>
    <div class="stat" id="stat"></div>
    <div class="seg" id="seg">
      <button data-view="cards" class="on">卡片</button>
      <button data-view="table">表格</button>
    </div>
  </div>
  <div class="sbox" id="sbox">
    <svg class="mag" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
    <input id="q" placeholder="搜索音色名 / 拼音 / 首字母 / 发音人编码" autocomplete="off" spellcheck="false">
    <button class="clr" id="clr" title="清空 (Esc)">×</button>
  </div>
  <div class="frow" id="favail"></div>
  <div class="frow" id="fmore"></div>
</header>
<main>
  <div id="view"></div>
  <div class="empty" id="empty" style="display:none">没有匹配的音色，试试放宽筛选条件</div>
</main>
<footer class="bar" id="bar">
  <div class="bar-in">
    <div class="bar-info">
      <span class="nm" id="bnm"></span>
      <code id="bcd"></code>
    </div>
    <div class="bar-act">
      <button class="btn" id="btry">试听</button>
      <button class="btn" id="bcopy">复制编码</button>
      <button class="btn pri" id="bgo" disabled title="接入配音功能后可用">带入配音</button>
    </div>
  </div>
</footer>
<script>
const DATA = __DATA__;
const VOICES = DATA.voices;
const LANG_CN = {zh:'中文',en:'英语',yue:'粤语',sc:'四川话',fr:'法语',de:'德语',it:'意大利语',ru:'俄语',
  ja:'日语',ko:'韩语',es:'西班牙语',pt:'葡萄牙语','pt-BR':'巴西葡语',ar:'阿拉伯语',th:'泰语',
  vi:'越南语',hi:'印地语',tr:'土耳其语',nl:'荷兰语',pl:'波兰语',ur:'乌尔都语',id:'印尼语',
  ms:'马来语',he:'希伯来语',el:'希腊语',fa:'波斯语',ug:'维吾尔语',bo:'藏语',mn:'蒙古语'};
const AV = {
  both:{label:'能听能用',cls:'b-both'},
  use:{label:'仅能用',cls:'b-use'},
  listen:{label:'仅能听',cls:'b-listen'},
  locked:{label:'需开通',cls:'b-locked'}
};
const S = {q:'',avail:'both',gender:'all',lang:'all',scene:'all',view:'cards',sel:null};

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const byCode = Object.fromEntries(VOICES.map(v => [v.code, v]));
const fmtLang = l => LANG_CN[l] || l;

/* ---------- 筛选器 ---------- */
function countAvail(a){ return a==='all' ? VOICES.length : VOICES.filter(v=>v.availability===a).length }
function buildFilters(){
  const av = [['both','能听能用'],['all','全部'],['use','仅能用'],['listen','仅能听'],['locked','需开通']];
  $('#favail').innerHTML = '<span class="chip lbl">可用性</span>' + av.map(([k,t])=>
    `<button class="chip${S.avail===k?' on':''}" data-f="avail" data-v="${k}">${t}<span class="n">${countAvail(k)}</span></button>`
  ).join('');

  const g = [['all','全部声线'],['female','女声'],['male','男声'],['child','童声']];
  const langs = [...new Set(VOICES.map(v=>v.lang))];
  const langOrder = ['zh','en','yue','sc'];
  langs.sort((a,b)=>{
    const ia = langOrder.indexOf(a), ib = langOrder.indexOf(b);
    if(ia>=0||ib>=0) return (ia<0?99:ia)-(ib<0?99:ib);
    return a.localeCompare(b);
  });
  const scenes = [...new Set(VOICES.map(v=>v.scene).filter(Boolean))];
  const sceneOrder = ['通用场景','语音助手','阅读听书','新闻播报','多语种场景','智能客服','客服助理','教育培训','民族语言'];
  scenes.sort((a,b)=>{
    const ia = sceneOrder.indexOf(a), ib = sceneOrder.indexOf(b);
    if(ia>=0||ib>=0) return (ia<0?99:ia)-(ib<0?99:ib);
    return a.localeCompare(b);
  });

  $('#fmore').innerHTML =
    '<span class="chip lbl">声线</span>' + g.map(([k,t])=>
      `<button class="chip${S.gender===k?' on':''}" data-f="gender" data-v="${k}">${t}</button>`).join('') +
    `<div class="sel-wrap"><span>语种</span><select id="selLang" class="${S.lang!=='all'?'on':''}">` +
      `<option value="all">全部（${VOICES.length}）</option>` +
      langs.map(l=>`<option value="${l}"${S.lang===l?' selected':''}>${fmtLang(l)}（${VOICES.filter(v=>v.lang===l).length}）</option>`).join('') +
    `</select></div>` +
    `<div class="sel-wrap"><span>场景</span><select id="selScene" class="${S.scene!=='all'?'on':''}">` +
      `<option value="all">全部（${VOICES.length}）</option>` +
      scenes.map(s=>`<option value="${esc(s)}"${S.scene===s?' selected':''}>${esc(s)}（${VOICES.filter(v=>v.scene===s).length}）</option>`).join('') +
    `</select></div>`;
}

/* ---------- 过滤 ---------- */
function filtered(){
  const q = S.q.trim().toLowerCase();
  return VOICES.filter(v => {
    if(S.avail !== 'all' && v.availability !== S.avail) return false;
    if(S.gender !== 'all' && v.gender !== S.gender) return false;
    if(S.lang !== 'all' && v.lang !== S.lang) return false;
    if(S.scene !== 'all' && v.scene !== S.scene) return false;
    if(!q) return true;
    return v.name.toLowerCase().includes(q)
      || v.py.includes(q) || v.pyi.includes(q)
      || v.code.toLowerCase().includes(q)
      || (v.aliases||[]).some(a => a.toLowerCase().includes(q));
  });
}

function hl(text){
  const q = S.q.trim();
  if(!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if(i < 0) return esc(text);
  return esc(text.slice(0,i)) + '<mark>' + esc(text.slice(i, i+q.length)) + '</mark>' + esc(text.slice(i+q.length));
}

/* ---------- 渲染 ---------- */
const ICON_PLAY = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.6v8.8L10 6z"/></svg>';
const ICON_PAUSE = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2.6" y="1.8" width="2.6" height="8.4" rx=".6"/><rect x="6.8" y="1.8" width="2.6" height="8.4" rx=".6"/></svg>';

function render(){
  const list = filtered();
  const filteredNow = S.q || S.avail!=='both' || S.gender!=='all' || S.lang!=='all' || S.scene!=='all';
  $('#stat').textContent = filteredNow
    ? `命中 ${list.length} / ${VOICES.length}`
    : `${VOICES.length} 个音色 · ${VOICES.filter(v=>v.sample).length} 个可试听`;
  $('#empty').style.display = list.length ? 'none' : 'block';

  const host = $('#view');
  if(S.view === 'cards'){
    host.innerHTML = '<div class="cards">' + list.map(v => {
      const a = AV[v.availability];
      const canPlay = !!v.sample;
      return `<div class="card${S.sel===v.code?' sel':''}${cur===v.code?' play':''}" data-code="${esc(v.code)}">
        <div class="ctop">
          <button class="pbtn" data-play="${esc(v.code)}" ${canPlay?'':'disabled'} title="${canPlay?'播放样音':'无免费样音'}">${cur===v.code&&playing?ICON_PAUSE:ICON_PLAY}</button>
          <div class="cname">${hl(v.name)}</div>
          <span class="badge ${a.cls}">${a.label}</span>
        </div>
        <div class="cmeta">${esc(v.style||'—')}${v.scene?' · '+esc(v.scene):''}${v.lang!=='zh'?' · '+fmtLang(v.lang):''}</div>
        <code class="ccode">${esc(v.code)}</code>
        <div class="prog" data-prog="${esc(v.code)}"></div>
      </div>`;
    }).join('') + '</div>';
  } else {
    host.innerHTML = `<table class="tbl"><thead><tr>
      <th style="width:36px"></th><th>名称</th><th style="width:220px">发音人编码</th>
      <th class="hide-s" style="width:100px">声线</th><th class="hide-s" style="width:110px">场景</th>
      <th class="hide-s" style="width:86px">语种</th><th style="width:88px">可用性</th>
    </tr></thead><tbody>` + list.map(v => {
      const a = AV[v.availability];
      const canPlay = !!v.sample;
      return `<tr class="${S.sel===v.code?'sel':''}" data-code="${esc(v.code)}">
        <td><button class="pbtn" data-play="${esc(v.code)}" ${canPlay?'':'disabled'} title="${canPlay?'播放样音':'无免费样音'}">${cur===v.code&&playing?ICON_PAUSE:ICON_PLAY}</button></td>
        <td class="nm">${hl(v.name)}</td>
        <td class="cd">${esc(v.code)}</td>
        <td class="hide-s mute">${esc(v.style||'—')}</td>
        <td class="hide-s mute">${esc(v.scene||'—')}</td>
        <td class="hide-s mute">${fmtLang(v.lang)}</td>
        <td><span class="badge ${a.cls}">${a.label}</span></td>
      </tr>`;
    }).join('') + '</tbody></table>';
  }
}

/* ---------- 音频 ---------- */
const au = new Audio();
let cur = null, playing = false;

function syncPlayUI(){
  document.querySelectorAll('[data-play]').forEach(b => {
    const c = b.getAttribute('data-play');
    b.innerHTML = (c === cur && playing) ? ICON_PAUSE : ICON_PLAY;
  });
  document.querySelectorAll('[data-code]').forEach(el => {
    el.classList.toggle('play', el.getAttribute('data-code') === cur);
  });
}

function togglePlay(code){
  const v = byCode[code];
  if(!v || !v.sample) return;
  if(cur === code){ au.paused ? au.play() : au.pause(); return }
  cur = code;
  au.src = encodeURI(v.sample);
  au.play().catch(() => { cur = null; playing = false; syncPlayUI(); });
}

au.addEventListener('play', () => { playing = true; syncPlayUI() });
au.addEventListener('pause', () => { playing = false; syncPlayUI() });
au.addEventListener('ended', () => {
  playing = false;
  const p = document.querySelector(`[data-prog="${CSS.escape(cur)}"]`);
  if(p) p.style.width = '0%';
  cur = null; syncPlayUI();
});
au.addEventListener('timeupdate', () => {
  if(!cur || !au.duration) return;
  const p = document.querySelector(`[data-prog="${CSS.escape(cur)}"]`);
  if(p) p.style.width = (au.currentTime / au.duration * 100).toFixed(1) + '%';
});

/* ---------- 选中 ---------- */
function select(code){
  S.sel = (S.sel === code) ? null : code;
  const v = S.sel ? byCode[S.sel] : null;
  const bar = $('#bar');
  if(v){
    $('#bnm').textContent = v.name;
    $('#bcd').textContent = v.code;
    $('#btry').disabled = !v.sample;
    bar.classList.add('show');
  } else {
    bar.classList.remove('show');
  }
  render();
}

/* ---------- 事件 ---------- */
$('#view').addEventListener('click', e => {
  const pb = e.target.closest('[data-play]');
  if(pb){ e.stopPropagation(); togglePlay(pb.getAttribute('data-play')); return }
  const row = e.target.closest('[data-code]');
  if(row) select(row.getAttribute('data-code'));
});

$('#favail').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if(!b) return;
  S[b.dataset.f] = b.dataset.v; buildFilters(); render();
});
$('#fmore').addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if(!b) return;
  S[b.dataset.f] = b.dataset.v; buildFilters(); render();
});
$('#fmore').addEventListener('change', e => {
  const s = e.target.closest('select'); if(!s) return;
  if(s.id === 'selLang') S.lang = s.value;
  if(s.id === 'selScene') S.scene = s.value;
  buildFilters(); render();
});

$('#seg').addEventListener('click', e => {
  const b = e.target.closest('[data-view]'); if(!b) return;
  S.view = b.dataset.view;
  [...$('#seg').children].forEach(x => x.classList.toggle('on', x === b));
  render();
});

const qEl = $('#q'), sbox = $('#sbox');
qEl.addEventListener('input', () => {
  S.q = qEl.value;
  sbox.classList.toggle('has', !!qEl.value);
  render();
});
$('#clr').addEventListener('click', () => {
  qEl.value = ''; S.q = ''; sbox.classList.remove('has'); qEl.focus(); render();
});

document.addEventListener('keydown', e => {
  if(e.key === '/' && document.activeElement !== qEl){ e.preventDefault(); qEl.focus() }
  if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); qEl.focus() }
  if(e.key === 'Escape'){ qEl.value=''; S.q=''; sbox.classList.remove('has'); qEl.blur(); render() }
});

$('#btry').addEventListener('click', () => { if(S.sel) togglePlay(S.sel) });
$('#bcopy').addEventListener('click', async () => {
  if(!S.sel) return;
  try{
    await navigator.clipboard.writeText(S.sel);
    const b = $('#bcopy'), t = b.textContent;
    b.textContent = '已复制'; setTimeout(()=>b.textContent=t, 1200);
  }catch(_){
    const r = document.createRange(); r.selectNodeContents($('#bcd'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
});

/* ---------- 启动 ---------- */
buildFilters();
render();
</script>
</body>
</html>
'''

out = HTML.replace('__DATA__', payload)
p = os.path.join(BASE, 'docs/legacy/音色库.html')
open(p, 'w', encoding='utf-8').write(out)
print('写入:', p)
print('大小:', round(os.path.getsize(p) / 1024, 1), 'KB')
