'use strict';

/* =========================================================
   Rozpočet – osobná appka na sledovanie výdavkov
   Dáta: lokálne v telefóne + synchronizácia s Google tabuľkou
   ========================================================= */

const KEY = 'rozpocet.v1';
const MONTHS = ['Január', 'Február', 'Marec', 'Apríl', 'Máj', 'Jún', 'Júl', 'August', 'September', 'Október', 'November', 'December'];
const PALETTE = ['#5EE0AE', '#F4C152', '#FF9F6B', '#7FB2FF', '#B79BFF', '#FF8FC7', '#6FD3E8', '#C9E265', '#9A9CC0'];

const DEFAULT_SETTINGS = {
  categories: [
    { id: 'potraviny', name: 'Potraviny', limit: 150, color: '#5EE0AE', keywords: ['tesco', 'coop', 'billa', 'lidl', 'kaufland'] },
    { id: 'vonku', name: 'Jedlo vonku', limit: 30, color: '#FF9F6B', keywords: ['wolt', 'bolt', 'pizza'] },
    { id: 'doprava', name: 'Doprava', limit: 20, color: '#7FB2FF', keywords: ['uber', 'arriva'] },
    { id: 'ostatne', name: 'Ostatné', limit: 50, color: '#9A9CC0', keywords: [] },
    { id: 'pevne', name: 'Pevné platby', limit: 0, color: '#6B7099', keywords: [] }
  ],
  fixed: [],
  income: [],
  paid: {}
};

const eur = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR' });
const eur0 = new Intl.NumberFormat('sk-SK', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

/* ---------------- State ---------------- */

let S = load();
let ui = { tab: 'overview', month: monthKey(new Date()), filter: null };
let syncing = false;
let settingsTimer = null;

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.settings) {
      s.queue = s.queue || [];
      s.tx = s.tx || [];
      s.conn = s.conn || { url: '', token: '' };
      return s;
    }
  } catch (e) { /* prázdne úložisko */ }
  return { tx: [], settings: clone(DEFAULT_SETTINGS), queue: [], conn: { url: '', token: '' }, lastSync: null };
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('Nepodarilo sa uložiť v telefóne.'); }
}

function normalizeSettings(s) {
  const out = Object.assign(clone(DEFAULT_SETTINGS), s || {});
  out.categories = (out.categories || []).map((c, i) => ({
    id: String(c.id || uid()),
    name: String(c.name || 'Kategória'),
    limit: Number(c.limit) || 0,
    color: c.color || PALETTE[i % PALETTE.length],
    keywords: Array.isArray(c.keywords) ? c.keywords : []
  }));
  if (!out.categories.find(c => c.id === 'ostatne')) out.categories.push({ id: 'ostatne', name: 'Ostatné', limit: 0, color: '#9A9CC0', keywords: [] });
  if (!out.categories.find(c => c.id === 'pevne')) out.categories.push({ id: 'pevne', name: 'Pevné platby', limit: 0, color: '#6B7099', keywords: [] });
  if (!out.categories.find(c => c.id === 'sporenie')) out.categories.push({ id: 'sporenie', name: 'Sporenie a presuny', limit: 0, color: '#6FD3E8', keywords: [] });
  out.fixed = (out.fixed || []).map(f => ({ id: String(f.id || uid()), name: String(f.name || ''), amount: Number(f.amount) || 0 }));
  out.income = (out.income || []).map(f => ({ id: String(f.id || uid()), name: String(f.name || ''), amount: Number(f.amount) || 0 }));
  out.paid = out.paid || {};
  return out;
}

S.settings = normalizeSettings(S.settings);

/* ---------------- Helpers ---------------- */

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function pad(n) { return String(n).padStart(2, '0'); }
function monthKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function nowLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) { return eur.format(Math.round(n * 100) / 100); }
function parseMoney(v) {
  let s = String(v || '').replace(/[^\d,.\-]/g, '');
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc > -1) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function shiftMonth(key, d) {
  const [y, m] = key.split('-').map(Number);
  return monthKey(new Date(y, m - 1 + d, 1));
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  const now = new Date();
  return MONTHS[m - 1] + (y !== now.getFullYear() ? ' ' + y : '');
}
function dayLabel(dateStr) {
  const d = new Date(dateStr.slice(0, 10) + 'T12:00');
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  if (diff === 0) return 'Dnes';
  if (diff === 1) return 'Včera';
  return d.toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });
}
function cat(id) {
  return S.settings.categories.find(c => c.id === id) || S.settings.categories.find(c => c.id === 'ostatne');
}
function guessCategory(merchant) {
  const m = String(merchant || '').toLowerCase();
  for (const c of S.settings.categories) {
    for (const k of c.keywords || []) if (k && m.includes(String(k).toLowerCase())) return c.id;
  }
  return 'ostatne';
}
const NOT_SPENDING = ['pevne', 'sporenie'];
function txCat(t) {
  return S.settings.categories.find(c => c.id === t.category) ? t.category : guessCategory(t.merchant);
}

/* ---------------- Calculations ---------------- */

function monthData(key) {
  const tx = S.tx.filter(t => String(t.date).slice(0, 7) === key);
  const incomeLogged = tx.filter(t => t.amount > 0 && t.category !== 'sporenie').reduce((a, t) => a + t.amount, 0);
  const incomeExpected = S.settings.income.reduce((a, i) => a + i.amount, 0);
  // Kým nepríde celý príjem, počíta sa s očakávaným (drobné príjmy ho neprepíšu).
  const income = Math.max(incomeLogged, incomeExpected);
  const fixed = S.settings.fixed.reduce((a, f) => a + f.amount, 0);
  const byCat = {};
  let variable = 0;
  for (const t of tx) {
    if (t.amount >= 0) continue;
    const c = txCat(t);
    if (NOT_SPENDING.includes(c)) continue;
    byCat[c] = (byCat[c] || 0) - t.amount;
    variable -= t.amount;
  }
  const left = income - fixed - variable;
  return { tx, income, incomeLogged, incomeExpected, fixed, variable, left, byCat };
}

function daysLeft(key) {
  const now = new Date();
  if (key !== monthKey(now)) return 0;
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return last - now.getDate() + 1;
}

/* ---------------- Sync ---------------- */

async function api(body) {
  const res = await fetch(S.conn.url, {
    method: 'POST',
    body: JSON.stringify(Object.assign({}, body, { token: S.conn.token }))
  });
  if (!res.ok) throw new Error('Server odpovedal chybou ' + res.status + '.');
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || 'Neznáma chyba servera.');
  return j;
}

function applyOp(op) {
  if (op.action === 'upsert') {
    const i = S.tx.findIndex(t => t.id === op.tx.id);
    if (i > -1) S.tx[i] = op.tx; else S.tx.push(op.tx);
  } else if (op.action === 'delete') {
    S.tx = S.tx.filter(t => t.id !== op.id);
  } else if (op.action === 'settings') {
    S.settings = normalizeSettings(op.settings);
  }
}

function commit(op) {
  if (op.action === 'settings') S.queue = S.queue.filter(o => o.action !== 'settings');
  applyOp(op);
  S.queue.push(op);
  save();
  render();
  sync();
}

function saveSettings(immediate) {
  clearTimeout(settingsTimer);
  const run = () => commit({ action: 'settings', settings: clone(S.settings) });
  if (immediate) run(); else settingsTimer = setTimeout(run, 700);
}

async function sync() {
  if (!S.conn.url || !S.conn.token) { setStatus('setup'); return; }
  if (syncing) return;
  syncing = true;
  setStatus('busy');
  try {
    if (S.queue.length) {
      const ops = S.queue.slice();
      await api({ action: 'batch', ops });
      S.queue.splice(0, ops.length);
      save();
    }
    const j = await api({ action: 'all' });
    S.tx = Array.isArray(j.tx) ? j.tx : [];
    if (j.settings) S.settings = normalizeSettings(j.settings);
    S.queue.forEach(applyOp); // zmeny urobené počas synchronizácie
    S.lastSync = Date.now();
    save();
    setStatus('ok');
  } catch (e) {
    setStatus('err', e.message);
  } finally {
    syncing = false;
    const a = document.activeElement;
    const typing = a && view.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
    if (!typing) render();
  }
}

function setStatus(kind, msg) {
  const dot = document.getElementById('syncDot');
  const txt = document.getElementById('syncText');
  dot.className = 'dot';
  if (kind === 'setup') { txt.textContent = 'Nepripojené'; }
  else if (kind === 'busy') { dot.classList.add('busy'); txt.textContent = 'Synchronizujem…'; }
  else if (kind === 'ok') {
    dot.classList.add('ok');
    const d = new Date(S.lastSync);
    txt.textContent = S.queue.length ? 'Čaká na odoslanie' : 'Aktuálne ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  } else if (kind === 'err') {
    dot.classList.add('err');
    txt.textContent = navigator.onLine ? 'Chyba synchronizácie' : 'Offline';
    if (msg && navigator.onLine) txt.title = msg;
  }
}

/* ---------------- Rendering ---------------- */

const view = document.getElementById('view');

function render() {
  document.getElementById('monthLabel').textContent = monthLabel(ui.month);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  document.querySelector('.top .month').style.visibility = ui.tab === 'settings' ? 'hidden' : 'visible';
  document.getElementById('addBtn').hidden = ui.tab === 'settings' || ui.tab === 'fixed';
  const r = { overview: renderOverview, tx: renderTx, fixed: renderFixed, settings: renderSettings }[ui.tab];
  view.innerHTML = r();
}

function renderOverview() {
  const d = monthData(ui.month);
  const dl = daysLeft(ui.month);
  const total = Math.max(d.income, d.fixed + d.variable, 1);
  const pf = Math.min(d.fixed / total * 100, 100);
  const pv = Math.min(d.variable / total * 100, 100 - pf);
  const over = d.left < 0;
  let sub;
  if (dl > 0 && d.left > 0) sub = `To je <b>${money(d.left / dl)}</b> na deň do konca mesiaca.`;
  else if (over) sub = `Si o <b>${money(-d.left)}</b> v mínuse oproti príjmu.`;
  else if (dl > 0) sub = 'Zatiaľ tu nie je príjem ani výdavky.';
  else sub = 'Mesiac je za tebou.';
  if (d.incomeLogged < d.incomeExpected) sub += `<br>Počítam s očakávaným príjmom, zatiaľ prišlo ${money(d.incomeLogged)}.`;

  const cats = S.settings.categories.filter(c => !NOT_SPENDING.includes(c.id));
  const envs = cats.map(c => {
    const spent = d.byCat[c.id] || 0;
    if (!c.limit && !spent) return '';
    const rem = c.limit - spent;
    const fill = c.limit ? Math.min(spent / c.limit * 100, 100) : 100;
    const isOver = c.limit > 0 && spent > c.limit;
    const right = c.limit ? (isOver ? '−' + money(-rem) : money(rem)) : money(spent);
    const small = c.limit ? `Minuté ${money(spent)} z ${money(c.limit)}` : 'Bez limitu';
    return `<button class="env${isOver ? ' over' : ''}" style="--c:${c.color};--fill:${fill}%" data-env="${esc(c.id)}">
      <span class="n">${esc(c.name)}</span><span class="r">${right}</span><span class="s">${small}</span></button>`;
  }).join('');

  const setup = !S.conn.url ? `<div class="card"><h3>Pripoj Google tabuľku</h3>
    <p>Kým nie je pripojená, platby sa ukladajú len v tomto telefóne a Apple Pay sa nezapisuje automaticky.</p>
    <button class="btn primary" data-go="settings">Otvoriť nastavenia</button></div>` : '';

  return `${setup}
  <section class="hero">
    <p class="label">${over ? 'Prečerpané' : 'Ostáva tento mesiac'}</p>
    <p class="big${over ? ' neg' : ''}">${over ? '−' : ''}${eur0.format(Math.abs(Math.round(d.left)))}</p>
    <p class="sub">${sub}</p>
    <div class="gauge" aria-hidden="true">
      <div class="gauge-bar"><i class="g-fixed" style="width:${pf}%"></i><i class="${over ? 'g-over' : 'g-var'}" style="width:${pv}%"></i></div>
    </div>
    <div class="legend">
      <div>Príjem<b>${money(d.income)}</b></div>
      <div><span class="sw" style="background:var(--muted);opacity:.55"></span>Pevné<b>${money(d.fixed)}</b></div>
      <div><span class="sw" style="background:var(--amber)"></span>Výdavky<b>${money(d.variable)}</b></div>
    </div>
  </section>
  <div class="section-h"><h2>Obálky</h2><span>zostatok z limitu</span></div>
  <div class="envs">${envs || '<p class="hint">Nastav limity kategórií v Nastaveniach.</p>'}</div>`;
}

function renderTx() {
  const d = monthData(ui.month);
  let tx = d.tx.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (ui.filter) tx = tx.filter(t => txCat(t) === ui.filter);
  const chips = [`<button class="chip${!ui.filter ? ' on' : ''}" data-filter="">Všetko</button>`]
    .concat(S.settings.categories.map(c => `<button class="chip${ui.filter === c.id ? ' on' : ''}" data-filter="${esc(c.id)}">${esc(c.name)}</button>`)).join('');

  if (!tx.length) {
    return `<div class="filter">${chips}</div><div class="empty"><b>Zatiaľ tu nič nie je</b>
      ${ui.filter ? 'V tejto kategórii tento mesiac nemáš žiadne platby.' : 'Platby cez Apple Pay sa sem zapíšu samy. Ostatné pridáš tlačidlom +.'}</div>`;
  }
  const groups = {};
  tx.forEach(t => { const k = String(t.date).slice(0, 10); (groups[k] = groups[k] || []).push(t); });
  const html = Object.keys(groups).map(k => {
    const rows = groups[k];
    const daySum = rows.filter(t => t.amount < 0).reduce((a, t) => a - t.amount, 0);
    return `<div class="day"><span>${esc(dayLabel(k))}</span><span class="num">${daySum ? money(daySum) : ''}</span></div>
      <div class="list">${rows.map(t => {
        const c = t.amount > 0 && t.category !== 'sporenie' ? { name: 'Príjem', color: 'var(--mint)' } : cat(txCat(t));
        const time = String(t.date).slice(11, 16);
        const meta = [c.name, time, t.source === 'applepay' ? 'Apple Pay' : ''].filter(Boolean).join(', ');
        return `<button class="row" data-tx="${esc(t.id)}" style="--c:${c.color}">
          <span class="c"></span>
          <span class="t"><b>${esc(t.merchant || c.name)}</b><small>${esc(meta)}${t.note ? ' – ' + esc(t.note) : ''}</small></span>
          <span class="a${t.amount > 0 && t.category !== 'sporenie' ? ' in' : ''}">${t.amount > 0 ? '+' : ''}${money(t.amount)}</span></button>`;
      }).join('')}</div>`;
  }).join('');
  return `<div class="filter">${chips}</div>${html}`;
}

function renderFixed() {
  const paid = S.settings.paid[ui.month] || {};
  const f = S.settings.fixed;
  if (!f.length) return `<div class="empty"><b>Žiadne pevné platby</b>Pridaj nájom, telefón a podobne v Nastaveniach.</div>`;
  const total = f.reduce((a, x) => a + x.amount, 0);
  const done = f.filter(x => paid[x.id]).reduce((a, x) => a + x.amount, 0);
  return `<div class="section-h"><h2>Pevné platby</h2><span class="num">zaplatené ${money(done)} z ${money(total)}</span></div>
  <div class="list">${f.map(x => `<button class="check${paid[x.id] ? ' done' : ''}" data-paid="${esc(x.id)}" aria-pressed="${!!paid[x.id]}">
      <span class="box">${paid[x.id] ? '✓' : ''}</span><span class="nm">${esc(x.name)}</span><span class="am">${money(x.amount)}</span></button>`).join('')}</div>
  <p class="hint" style="margin-top:12px">Odškrtni, čo si tento mesiac už zaplatil. V prehľade sa pevné platby rátajú vždy celé.</p>`;
}

function renderSettings() {
  const s = S.settings;
  const catRows = s.categories.filter(c => !NOT_SPENDING.includes(c.id)).map(c => `
    <div class="edit-row cat" style="--c:${c.color}">
      <span class="sw"></span>
      <input class="input" value="${esc(c.name)}" data-cat-name="${esc(c.id)}" aria-label="Názov kategórie">
      <input class="input num" inputmode="decimal" value="${c.limit ? String(c.limit).replace('.', ',') : ''}" placeholder="limit" data-cat-limit="${esc(c.id)}" aria-label="Mesačný limit">
      ${c.id === 'ostatne' ? '<span></span>' : `<button class="del" data-cat-del="${esc(c.id)}" aria-label="Odstrániť kategóriu">×</button>`}
      <input class="input kw" value="${esc((c.keywords || []).join(', '))}" placeholder="kľúčové slová obchodov, oddelené čiarkou" data-cat-kw="${esc(c.id)}" aria-label="Kľúčové slová">
    </div>`).join('');
  const pev = s.categories.find(c => c.id === 'pevne');
  const listRows = (arr, kind) => arr.map(x => `
    <div class="edit-row">
      <input class="input" value="${esc(x.name)}" data-${kind}-name="${esc(x.id)}" aria-label="Názov">
      <input class="input num" inputmode="decimal" value="${x.amount ? String(x.amount).replace('.', ',') : ''}" data-${kind}-amt="${esc(x.id)}" aria-label="Suma">
      <button class="del" data-${kind}-del="${esc(x.id)}" aria-label="Odstrániť">×</button>
    </div>`).join('');

  return `
  <div class="section-h"><h2>Pripojenie</h2><span>${S.lastSync ? 'naposledy ' + new Date(S.lastSync).toLocaleString('sk-SK') : 'nepripojené'}</span></div>
  <label class="field"><span>Adresa webovej aplikácie z Google skriptu</span>
    <input class="input" id="connUrl" value="${esc(S.conn.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocapitalize="off" spellcheck="false"></label>
  <label class="field"><span>Kľúč</span>
    <input class="input" id="connToken" value="${esc(S.conn.token)}" autocapitalize="off" spellcheck="false"></label>
  <div class="btns"><button class="btn primary" data-act="connect">Uložiť a pripojiť</button></div>

  <div class="section-h"><h2>Obálky a limity</h2><span>na mesiac</span></div>
  <p class="hint">Platba sa zaradí podľa kľúčových slov v názve obchodu, napríklad „tesco“.</p>
  ${catRows}
  <div class="btns"><button class="btn small" data-act="add-cat">Pridať kategóriu</button></div>

  <div class="section-h"><h2>Pevné platby</h2><span class="num">${money(s.fixed.reduce((a, x) => a + x.amount, 0))}</span></div>
  ${listRows(s.fixed, 'fix')}
  <div class="btns"><button class="btn small" data-act="add-fix">Pridať pevnú platbu</button></div>
  ${pev ? `<label class="field" style="margin-top:14px"><span>Obchody, ktoré sú už v pevných platbách (nezarátajú sa do výdavkov)</span>
    <input class="input" value="${esc((pev.keywords || []).join(', '))}" data-cat-kw="pevne"></label>` : ''}

  <div class="section-h"><h2>Očakávaný príjem</h2><span class="num">${money(s.income.reduce((a, x) => a + x.amount, 0))}</span></div>
  <p class="hint">Použije sa, kým v danom mesiaci nezapíšeš skutočný príjem.</p>
  ${listRows(s.income, 'inc')}
  <div class="btns"><button class="btn small" data-act="add-inc">Pridať príjem</button></div>

  <div class="section-h"><h2>Dáta</h2></div>
  <div class="btns">
    <button class="btn small" data-act="sync">Synchronizovať teraz</button>
    <button class="btn small" data-act="export">Stiahnuť zálohu</button>
  </div>
  <p class="hint" style="margin-top:12px">Platieb v telefóne: ${S.tx.length}. Čaká na odoslanie: ${S.queue.length}.</p>`;
}

/* ---------------- Add / edit sheet ---------------- */

const wrap = document.getElementById('sheetWrap');
const sheet = document.getElementById('sheet');
let editing = null;

function openSheet(tx) {
  const isNew = !tx;
  editing = tx ? clone(tx) : { id: uid(), date: nowLocal(), amount: 0, merchant: '', category: ui.filter || 'potraviny', note: '', source: 'manual' };
  if (!S.settings.categories.find(c => c.id === editing.category)) editing.category = txCat(editing);
  const income = editing.amount > 0;
  const cats = S.settings.categories.map(c =>
    `<button type="button" class="chip${editing.category === c.id ? ' on' : ''}" style="--c:${c.color}" data-pick="${esc(c.id)}">${esc(c.name)}</button>`).join('');
  sheet.innerHTML = `<div class="grab"></div>
    <h2>${isNew ? 'Nová platba' : 'Upraviť platbu'}</h2>
    <div class="seg" role="tablist">
      <button type="button" data-kind="out" class="${income ? '' : 'on'}">Výdavok</button>
      <button type="button" data-kind="in" class="${income ? 'on' : ''}">Príjem</button>
    </div>
    <input class="amount-in" id="fAmount" inputmode="decimal" placeholder="0,00" value="${editing.amount ? String(Math.abs(editing.amount)).replace('.', ',') : ''}" aria-label="Suma">
    <p class="amount-cur">eur</p>
    <div class="cats" id="fCats" ${income ? 'hidden' : ''}>${cats}</div>
    <label class="field"><span>Obchod alebo popis</span><input class="input" id="fMerchant" value="${esc(editing.merchant)}" placeholder="napr. Tesco"></label>
    <label class="field"><span>Dátum</span><input class="input" type="datetime-local" id="fDate" value="${esc(String(editing.date).slice(0, 16))}"></label>
    <label class="field"><span>Poznámka</span><input class="input" id="fNote" value="${esc(editing.note)}"></label>
    <div class="btns">
      ${isNew ? '' : '<button type="button" class="btn danger" data-act="delete">Zmazať</button>'}
      <button type="button" class="btn" data-close>Zrušiť</button>
      <button type="submit" class="btn primary">${isNew ? 'Pridať' : 'Uložiť zmeny'}</button>
    </div>`;
  sheet.dataset.kind = income ? 'in' : 'out';
  sheet.dataset.isNew = isNew ? '1' : '';
  wrap.hidden = false;
  if (isNew) setTimeout(() => document.getElementById('fAmount').focus(), 60);
}

function closeSheet() { wrap.hidden = true; editing = null; }

sheet.addEventListener('click', e => {
  const k = e.target.closest('[data-kind]');
  if (k) {
    sheet.dataset.kind = k.dataset.kind;
    sheet.querySelectorAll('[data-kind]').forEach(b => b.classList.toggle('on', b === k));
    document.getElementById('fCats').hidden = k.dataset.kind === 'in';
    return;
  }
  const p = e.target.closest('[data-pick]');
  if (p) {
    editing.category = p.dataset.pick;
    sheet.querySelectorAll('[data-pick]').forEach(b => b.classList.toggle('on', b === p));
    return;
  }
  if (e.target.closest('[data-act="delete"]')) {
    if (confirm('Zmazať túto platbu?')) {
      commit({ action: 'delete', id: editing.id });
      closeSheet();
      toast('Platba zmazaná');
    }
  }
});

sheet.addEventListener('submit', e => {
  e.preventDefault();
  const amt = Math.abs(parseMoney(document.getElementById('fAmount').value));
  if (!amt) { toast('Zadaj sumu.'); document.getElementById('fAmount').focus(); return; }
  const income = sheet.dataset.kind === 'in';
  const merchant = document.getElementById('fMerchant').value.trim();
  const tx = Object.assign(editing, {
    amount: income ? amt : -amt,
    merchant,
    date: document.getElementById('fDate').value || nowLocal(),
    note: document.getElementById('fNote').value.trim(),
    category: income ? 'prijem' : editing.category
  });
  const isNew = !!sheet.dataset.isNew;
  commit({ action: 'upsert', tx: clone(tx) });
  closeSheet();
  toast(isNew ? 'Platba pridaná' : 'Zmeny uložené');
});

wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !wrap.hidden) closeSheet(); });

/* ---------------- Events ---------------- */

document.querySelector('.tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  ui.tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
});
document.getElementById('prevMonth').onclick = () => { ui.month = shiftMonth(ui.month, -1); render(); };
document.getElementById('nextMonth').onclick = () => { ui.month = shiftMonth(ui.month, 1); render(); };
document.getElementById('addBtn').onclick = () => openSheet(null);
document.getElementById('syncBtn').onclick = () => sync();

view.addEventListener('click', e => {
  const t = e.target;
  const env = t.closest('[data-env]');
  if (env) { ui.filter = env.dataset.env; ui.tab = 'tx'; render(); window.scrollTo(0, 0); return; }
  const f = t.closest('[data-filter]');
  if (f) { ui.filter = f.dataset.filter || null; render(); return; }
  const row = t.closest('[data-tx]');
  if (row) { const tx = S.tx.find(x => x.id === row.dataset.tx); if (tx) openSheet(tx); return; }
  const go = t.closest('[data-go]');
  if (go) { ui.tab = go.dataset.go; render(); return; }
  const pd = t.closest('[data-paid]');
  if (pd) {
    const m = S.settings.paid[ui.month] = S.settings.paid[ui.month] || {};
    if (m[pd.dataset.paid]) delete m[pd.dataset.paid]; else m[pd.dataset.paid] = true;
    saveSettings(true);
    return;
  }
  const act = t.closest('[data-act]');
  if (act) return settingsAction(act.dataset.act);
  const del = t.closest('[data-cat-del],[data-fix-del],[data-inc-del]');
  if (del) {
    const s = S.settings;
    if (del.dataset.catDel) {
      if (!confirm('Odstrániť kategóriu? Jej platby sa presunú do Ostatné.')) return;
      s.categories = s.categories.filter(c => c.id !== del.dataset.catDel);
    }
    if (del.dataset.fixDel) s.fixed = s.fixed.filter(x => x.id !== del.dataset.fixDel);
    if (del.dataset.incDel) s.income = s.income.filter(x => x.id !== del.dataset.incDel);
    saveSettings(true);
  }
});

view.addEventListener('input', e => {
  const el = e.target, d = el.dataset, s = S.settings;
  const find = (arr, id) => arr.find(x => x.id === id);
  if (d.catName) find(s.categories, d.catName).name = el.value;
  else if (d.catLimit) find(s.categories, d.catLimit).limit = parseMoney(el.value);
  else if (d.catKw) find(s.categories, d.catKw).keywords = el.value.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  else if (d.fixName) find(s.fixed, d.fixName).name = el.value;
  else if (d.fixAmt) find(s.fixed, d.fixAmt).amount = parseMoney(el.value);
  else if (d.incName) find(s.income, d.incName).name = el.value;
  else if (d.incAmt) find(s.income, d.incAmt).amount = parseMoney(el.value);
  else return;
  // Uloží sa bez prekreslenia, aby písanie neskákalo.
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    S.queue = S.queue.filter(o => o.action !== 'settings');
    S.queue.push({ action: 'settings', settings: clone(S.settings) });
    save();
    sync();
  }, 900);
});

async function settingsAction(a) {
  const s = S.settings;
  if (a === 'connect') {
    S.conn.url = document.getElementById('connUrl').value.trim();
    S.conn.token = document.getElementById('connToken').value.trim();
    save();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(S.conn.url)) {
      toast('Adresa má začínať https://script.google.com a končiť /exec.');
      return;
    }
    try {
      setStatus('busy');
      await api({ action: 'ping' });
      // Zmeny urobené offline pred pripojením sa odošlú; nastavenia prevezmeme zo servera.
      S.queue = S.queue.filter(o => o.action !== 'settings');
      save();
      toast('Pripojené');
      await sync();
    } catch (e) {
      setStatus('err', e.message);
      toast(e.message === 'Nesprávny kľúč.' ? 'Kľúč nesedí. Skontroluj ho v Google skripte.' : 'Nepodarilo sa pripojiť: ' + e.message);
    }
  } else if (a === 'sync') {
    sync();
  } else if (a === 'export') {
    const blob = new Blob([JSON.stringify({ tx: S.tx, settings: S.settings }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'rozpocet-zaloha-' + nowLocal().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
  } else if (a === 'add-cat') {
    s.categories.splice(s.categories.length - 2, 0, { id: uid(), name: 'Nová kategória', limit: 0, color: PALETTE[s.categories.length % PALETTE.length], keywords: [] });
    saveSettings(true);
  } else if (a === 'add-fix') {
    s.fixed.push({ id: uid(), name: 'Nová platba', amount: 0 });
    saveSettings(true);
  } else if (a === 'add-inc') {
    s.income.push({ id: uid(), name: 'Príjem', amount: 0 });
    saveSettings(true);
  }
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* Po návrate do appky (napr. po platbe Apple Pay) načíta nové platby. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});
window.addEventListener('online', () => sync());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
setStatus(S.conn.url ? 'ok' : 'setup');
if (S.conn.url) sync();
