// Kuai Tracking front end
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  containers: [], daily: [], lastSave: null,
  q: '', chip: 'all', species: null, sort: { key: '_ataeta', dir: 1 }, open: new Set(),
  dDate: null, dSel: new Set(),
  cf: {}, df: {}, tf: {},
  edit: (() => { try { return localStorage.getItem('kt-edit') === 'on'; } catch { return false; } })(),
};

// Spanish status words typed by hand become English
const STATUS_EN = [[/^VENDID[OA]S?$/, 'SOLD'], [/^EN PROCESO$/, 'IN PROCESS'], [/^EN TRANSITO$/, 'IN TRANSIT'], [/^ARRIBAD[OA]$|^LLEGO$/, 'ARRIVED'], [/^APERTURA$/, 'OPENING'], [/^SEGUIMIENTO$/, 'SELLING']];
const enStatus = v => { const u = String(v || '').trim().toUpperCase(); const f = u.normalize('NFD').replace(/[̀-ͯ]/g, ''); for (const [re, en] of STATUS_EN) if (re.test(f)) return en; return u; };
// Daily Sales statuses: OPENING, SELLING (was FOLLOW-UP), SOLD OUT.
const dailyStatus = v => { const e = enStatus(v); const f = e.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/^(FOLLOW-?UP|SEGUIMIENTO|EN PROCESO DE VENTA|SELLING)$/.test(f)) return 'SELLING';
  if (/^(SOLD|SOLD-? ?OUT|AGOTAD[OA]S?|VENDID[OA]S?)$/.test(f)) return 'SOLD OUT';
  return e; };

function setEdit(on) {
  state.edit = on;
  try { localStorage.setItem('kt-edit', on ? 'on' : 'off'); } catch { }
  document.body.classList.toggle('locked', !on);
  const sw = $('#editSwitch'); sw.setAttribute('aria-checked', on); sw.querySelector('.lbl').textContent = on ? 'ON' : 'OFF';
  renderDaily();
}

// ---------- helpers ----------
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const isISO = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '');
const fmt = v => isISO(v) ? `${v.slice(8)}-${v.slice(5, 7)}-${v.slice(0, 4)}` : (v ?? '');
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 86400000);
const vkey = s => String(s || '').toUpperCase().replace(/^[MA](?=\d)/, '').replace(/^0+(?=\d)/, '').trim();
const num = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
// pallets sold: at opening (Sales Start day) and per day after it; a container has 20 pallets unless Pallets says otherwise
const palletsOf = c => num(c.pallets) || 20;
const openPct = c => { const o = num(c.openingSold); return o === null ? '' : `${Math.round(o / palletsOf(c) * 100)}% · ${o} pallet${o === 1 ? '' : 's'}`; };
const soldCum = c => {
  const out = []; let cum = 0;
  if (num(c.openingSold) !== null && /^\d{4}-\d{2}-\d{2}$/.test(c.salesStart || '')) { cum += num(c.openingSold); out.push([c.salesStart, cum]); }
  for (const d of Object.keys(c.soldByDay || {}).sort()) { const n = num(c.soldByDay[d]); if (n) { cum += n; out.push([d, cum]); } }
  return out;
};
const pctSold = c => { if (/^\d{4}-\d{2}-\d{2}$/.test(c.salesEnd || '')) return '100%'; const s = soldCum(c); return s.length ? Math.min(100, Math.round(s[s.length - 1][1] / palletsOf(c) * 100)) + '%' : ''; };
const fmtBoxes = n => Math.round(n).toLocaleString('en-US');

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// strong alert that stays until closed
function fcAlert(text) {
  let el = $('#fcPop');
  if (!el) { el = document.createElement('div'); el.id = 'fcPop'; el.className = 'fcpop'; document.body.appendChild(el); }
  el.innerHTML = `<b>Price alert</b><p>${esc(text)}</p><button type="button" class="btn hot">OK</button>`;
  el.hidden = false; el.querySelector('button').onclick = () => { el.hidden = true; };
}
let tipEl = null;
document.addEventListener('mouseover', e => {
  const td = e.target.closest('[data-tip]');
  if (!td) { if (tipEl) tipEl.hidden = true; return; }
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tipbox'; document.body.appendChild(tipEl); }
  tipEl.innerHTML = td.dataset.tip; tipEl.hidden = false;
  const rc = td.getBoundingClientRect();
  tipEl.style.left = Math.max(8, Math.min(rc.left, innerWidth - tipEl.offsetWidth - 8)) + 'px';
  tipEl.style.top = (rc.bottom + 6 + tipEl.offsetHeight > innerHeight ? Math.max(8, rc.top - tipEl.offsetHeight - 6) : rc.bottom + 6) + 'px';
});
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 4200);
}

// ---------- container state ----------
// sold -> green; sold with claim/survey -> yellow; selling; arriving soon (ETA in 0-2 days, no ATA) blinks.
// ATA minus ETA in days: positive = delayed, negative = early
const etaDiff = c => isISO(c.ata) && isISO(c.eta) ? daysBetween(c.eta, c.ata) : null;
const etaDiffText = c => { const d = etaDiff(c); if (d === null) return ''; if (d === 0) return 'On time'; const n = Math.abs(d); return `${d > 0 ? 'Delayed' : 'Early'} ${n} day${n === 1 ? '' : 's'}`; };
function stateOf(c) {
  const status = (c.status || '').toUpperCase();
  const today = todayISO();
  const ended = isISO(c.salesEnd) && c.salesEnd <= today;
  const started = isISO(c.salesStart) && c.salesStart <= today;
  const sold = /VENDID|SOLD/.test(status) || ended;
  const selling = !sold && (/PROCES|SELLING|EN VENTA/.test(status) || started);
  const dEta = isISO(c.eta) ? daysBetween(today, c.eta) : null;
  const dAta = isISO(c.ata) ? daysBetween(today, c.ata) : null;
  const late = isISO(c.ata) && isISO(c.eta) && c.ata > c.eta;
  const arrived = !sold && !selling && (dAta !== null ? dAta <= 0 : !!c.ata);
  const dNext = dAta !== null ? dAta : dEta;                       // days until it arrives (ATA when known, else ETA)
  const soon = !sold && !selling && !arrived && dNext !== null && dNext >= 0 && dNext <= 2;
  const transit = !sold && !selling && !arrived && !soon;
  const flagged = !!(c.claim || c.survey);       // claim or survey -> yellow row, whatever the state
  const inDays = d => d === 0 ? 'ARRIVING TODAY' : `ARRIVING IN ${d} DAY${d === 1 ? '' : 'S'}`;
  const arriving = dAta !== null && dAta > 0 ? inDays(dAta) + (late ? ' · DELAYED' : '') : soon ? (dEta === 0 ? 'ARRIVING TODAY' : 'ARRIVING SOON') : null;
  const landed = isISO(c.ata) ? c.ata <= today : !!c.ata || started || ended;
  let auto = sold ? (landed ? 'ARRIVED · SOLD OUT' : 'SOLD OUT') : selling ? (landed ? 'ARRIVED · SELLING' : 'SELLING') : arrived ? (isISO(c.salesStart) ? 'ARRIVED' : 'ARRIVED · NOT OPENED') : arriving ? arriving : dEta !== null && dEta < 0 ? 'ETA PASSED' : 'IN TRANSIT';
  return { sold, selling, soon, arrived, transit, flagged, auto, dEta, dAta, late, arriving };
}

// ---------- columns ----------
const CCOLS = [
  { k: 'transport', t: 'Transportation', auto: 1 },
  { k: 'week', t: 'Week of Departure', auto: 1, n: 1 },
  { k: 'etd', t: 'ETD', auto: 1, date: 1 },
  { k: 'eta', t: 'ETA', auto: 1, date: 1 },
  { k: 'client', t: 'Client Name', auto: 1 },
  { k: 'salesCity', t: 'Sales City', ed: 1 },
  { k: 'vesselCode', t: 'Vessel Code', auto: 1 },
  { k: 'vesselName', t: 'Vessel Name', auto: 1 },
  { k: 'port', t: 'Arrival Port', auto: 1 },
  { k: 'species', t: 'Species', auto: 1 },
  { k: 'mainVariety', t: 'Main Variety', auto: 1 },
  { k: 'mainLabel', t: 'Main Label', auto: 1 },
  { k: 'containerNo', t: 'Container / Booking No.', auto: 1 },
  { k: 'ata', t: 'ATA', ed: 1, date: 1 },
  { k: 'etaDiff', t: 'ETA vs ATA' },
  { k: 'salesStart', t: 'Sales Start', ed: 1, date: 1 },
  { k: 'salesEnd', t: 'Sales End', ed: 1, date: 1 },
  { k: 'status', t: 'Status', ed: 1 },
  { k: 'survey', t: 'Survey', ed: 1 },
  { k: 'claim', t: 'Claim', ed: 1 },
  { k: 'comments', t: 'Comments', ed: 1 },
  { k: 'openingPrices', t: 'Opening Prices (¥ RMB)', ed: 1 },
  { k: 'pallets', t: 'Pallets', ed: 1, n: 1 },
  { k: 'openingSold', t: '% Sold at Opening', ed: 1, n: 1 },
  { k: 'pct', t: '% of Container Sold', ed: 1, n: 1 },
];

const CHIPS = [
  ['all', 'All', () => true],
  ['transit', 'In transit', s => s.transit],
  ['soon', 'Arriving soon', s => s.soon],
  ['arrived', 'Arrived', s => s.arrived],
  ['selling', 'Selling', s => s.selling],
  ['sold', 'Sold', s => s.sold && !s.flagged],
  ['flagged', 'Claim / Survey', s => s.flagged],
];

// ---------- search ----------
function hay(c) {
  if (c._hay && c._hayV === c.updated) return c._hay;
  const b = c.breakdown ? Object.values(c.breakdown).flatMap(o => Object.keys(o)).join(' ') : '';
  c._hay = [...CCOLS.map(col => col.k === 'pct' ? '' : (col.date ? fmt(c[col.k]) + ' ' + c[col.k] : c[col.k])), b].join(' ').toUpperCase();
  c._hayV = c.updated;
  return c._hay;
}
function matches(c, terms) { const h = hay(c); return terms.every(t => h.includes(t)); }
function highlight(text, terms) {
  let s = esc(text);
  if (!terms.length) return s;
  for (const t of terms) {
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, m => `<mark>${m}</mark>`);
  }
  return s;
}

// ---------- column filters (Excel-style): click a column title, tick the values to show ----------
// state.cf (Containers) and state.df (Daily Sales) map a column key to the Set of values that are shown.
const BLANK = '(Blanks)';
function cVal(c, s, k) {
  let v = k === 'pct' ? pctSold(c) : k === 'openingSold' ? openPct(c) : k === 'etaDiff' ? etaDiffText(c) : k === 'status' ? (c.status || s.auto) : CCOLS.find(x => x.k === k)?.date ? fmt(c[k]) : c[k];
  v = String(v ?? '').trim();
  return v || BLANK;
}
function dVal(r, k) { const v = String((DCOLS.find(x => x.k === k)?.date ? fmt(r[k]) : r[k]) ?? '').trim(); return v || BLANK; }
function passes(filters, getter, except) {
  for (const [k, set] of Object.entries(filters)) { if (k === except || !set) continue; if (!set.has(getter(k))) return false; }
  return true;
}
function activeFilters(filters) { return Object.entries(filters).filter(([, s]) => s); }

let fpop = null;
function closeFilter() { if (fpop) { fpop.remove(); fpop = null; } }
// table: 'c' or 'd'; items: rows already filtered by everything except this column
function openFilter(th, table, key, title, items, getter) {
  closeFilter();
  const filters = table === 'c' ? state.cf : table === 't' ? state.tf : state.df;
  const counts = new Map();
  for (const it of items) { const v = getter(it, key); counts.set(v, (counts.get(v) || 0) + 1); }
  const isNum = table === 'c' ? CCOLS.find(x => x.k === key)?.n : key === 'size' || key === 'price';
  const values = [...counts.keys()].sort((a, b) => {
    if (a === BLANK) return 1; if (b === BLANK) return -1;
    const da = /^\d{2}[-/]\d{2}[-/]\d{4}$/.test(a) ? a.split(/[-/]/).reverse().join('') : null, db = /^\d{2}[-/]\d{2}[-/]\d{4}$/.test(b) ? b.split(/[-/]/).reverse().join('') : null;
    if (da && db) return db.localeCompare(da);
    return a.localeCompare(b, undefined, { numeric: true });
  });
  const cur = filters[key];
  fpop = document.createElement('div');
  fpop.className = 'fpop';
  fpop.innerHTML = `
    <div class="fp-head"><b>${esc(title)}</b><button class="x" data-act="close" aria-label="Close">×</button></div>
    ${table === 'c' ? `<div class="fp-sort"><button data-act="asc">Sort A → Z</button><button data-act="desc">Sort Z → A</button></div>` : ''}
    <input class="fp-search" type="search" placeholder="Search values…">
    <label class="fp-all"><input type="checkbox" data-act="all"> <span>Select all</span></label>
    <div class="fp-list">${values.map(v => `<label class="fp-item"><input type="checkbox" value="${esc(v)}" ${!cur || cur.has(v) ? 'checked' : ''}> <span>${esc(v)}</span><i>${counts.get(v)}</i></label>`).join('')}</div>
    <div class="fp-foot"><button data-act="clear" class="btn ghost">Clear filter</button><button data-act="ok" class="btn hot">OK</button></div>`;
  document.body.appendChild(fpop);
  const r = th.getBoundingClientRect();
  fpop.style.top = Math.min(r.bottom + 4, innerHeight - fpop.offsetHeight - 8) + 'px';
  fpop.style.left = Math.max(8, Math.min(r.left, innerWidth - fpop.offsetWidth - 8)) + 'px';
  const boxes = () => [...fpop.querySelectorAll('.fp-item')].filter(l => !l.hidden).map(l => l.querySelector('input'));
  const all = fpop.querySelector('[data-act="all"]');
  const syncAll = () => { const b = boxes(); all.checked = b.length && b.every(x => x.checked); all.indeterminate = !all.checked && b.some(x => x.checked); };
  syncAll();
  const apply = () => {
    const checked = [...fpop.querySelectorAll('.fp-item input')].filter(x => x.checked).map(x => x.value);
    filters[key] = checked.length === values.length ? null : new Set(checked);
    table === 'c' ? renderContainers() : table === 't' ? renderTotal() : renderDaily();
  };
  fpop.querySelector('.fp-search').addEventListener('input', e => {
    const q = e.target.value.trim().toUpperCase();
    fpop.querySelectorAll('.fp-item').forEach(l => {
      const hit = !q || l.textContent.toUpperCase().includes(q);
      l.hidden = !hit;
      if (q) l.querySelector('input').checked = hit;
    });
    syncAll();
  });
  fpop.querySelector('.fp-search').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fpop.querySelector('[data-act="ok"]').click(); } });
  fpop.addEventListener('change', e => {
    if (e.target === all) boxes().forEach(x => x.checked = all.checked);
    syncAll(); apply();
  });
  fpop.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'ok') apply();
    if (act === 'close' || act === 'ok') closeFilter();
    if (act === 'clear') { filters[key] = null; closeFilter(); table === 'c' ? renderContainers() : table === 't' ? renderTotal() : renderDaily(); }
    if (act === 'asc' || act === 'desc') {
      const prev = state.sort;
      state.sorts = [prev, ...(state.sorts || [])].filter(o => o && o.key !== key).filter((o, i, arr) => arr.findIndex(x => x.key === o.key) === i).slice(0, 3);
      state.sort = { key, dir: act === 'asc' ? 1 : -1 }; closeFilter(); renderContainers();
    }
  });
  setTimeout(() => fpop?.querySelector('.fp-search').focus(), 0);
}
document.addEventListener('mousedown', e => { if (fpop && !fpop.contains(e.target) && !e.target.closest('th')) closeFilter(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFilter(); });

function footHTML(n, total, noun, filters, labels, table) {
  const act = activeFilters(filters);
  const chips = act.map(([k, set]) => `<span class="ff">${esc(labels[k])}: <b>${esc([...set].slice(0, 3).join(', '))}${set.size > 3 ? ` +${set.size - 3}` : ''}</b><button data-clear="${k}" data-table="${table}" aria-label="Remove filter">×</button></span>`).join('');
  return `<div class="tf-num"><b>${n.toLocaleString('en-US')}</b><span>${noun}${n === 1 ? '' : 's'} shown${n !== total ? ` of ${total.toLocaleString('en-US')}` : ''}</span></div>
    <div class="tf-filters">${chips}${act.length > 1 ? `<button class="tf-clear" data-clearall="${table}">Clear all filters</button>` : ''}</div>`;
}

// ---------- render: containers ----------
function speciesOf(c) { return (c.species || '—').toUpperCase(); }

function renderContainers() {
  const terms = state.q.toUpperCase().split(/\s+/).filter(Boolean);
  const chipFn = CHIPS.find(x => x[0] === state.chip)[2];
  let list = state.containers.map(c => ({ c, s: stateOf(c) }));
  const base0 = list.filter(x => (!state.species || speciesOf(x.c) === state.species) && (!terms.length || matches(x.c, terms)) && (!state.ssDay || x.c.salesStart === state.ssDay));
  state._cbase = { base: base0, chipFn };
  const base = base0.filter(x => passes(state.cf, k => cVal(x.c, x.s, k)));
  const rows = base.filter(x => chipFn(x.s));

  // chips with counts
  $('#chips').innerHTML = CHIPS.map(([k, label, fn]) =>
    `<button class="chip ${state.chip === k ? 'on' : ''}" data-chip="${k}">${label}<b>${base.filter(x => fn(x.s)).length}</b></button>`).join('');

  const { key, dir } = state.sort;
  // Sorts stack like in Excel: the last one chosen decides first, earlier ones break ties. Empty cells always go last.
  const sortVal = (c, k) => k === 'etaDiff' ? etaDiff(c) : k === 'pct' ? num(pctSold(c)) : (c[k] ?? '');
  const cmpOne = (a, b, k, d) => {
    // default order: containers with ATA first (earliest ATA first), then the rest by ETA (earliest first)
    if (k === '_ataeta') {
      const ha = isISO(a.c.ata), hb = isISO(b.c.ata);
      if (ha !== hb) return ha ? -1 : 1;
      const va = ha ? a.c.ata : (isISO(a.c.eta) ? a.c.eta : ''), vb = hb ? b.c.ata : (isISO(b.c.eta) ? b.c.eta : '');
      if (!va || !vb) return !va && !vb ? 0 : !va ? 1 : -1;
      return va.localeCompare(vb) * d;
    }
    const va = sortVal(a.c, k), vb = sortVal(b.c, k);
    const ea = va === null || va === '', eb = vb === null || vb === '';
    if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
    const na = num(va), nb = num(vb);
    if ((k === 'etaDiff' || k === 'pct' || CCOLS.find(x => x.k === k)?.n) && na !== null && nb !== null) return (na - nb) * d;
    return String(va).localeCompare(String(vb), undefined, { numeric: true }) * d;
  };
  const order = [state.sort, ...(state.sorts || [])];
  rows.sort((a, b) => { for (const o of order) { const v = cmpOne(a, b, o.key, o.dir); if (v) return v; } return 0; });

  $('#ctable thead').innerHTML = '<tr>' + CCOLS.map(col =>
    `<th data-col="${col.k}" class="${col.auto ? 'auto' : ''} ${key === col.k ? 'sorted' : ''} ${state.cf[col.k] ? 'filtered' : ''}" title="Click to filter">${col.t}${key === col.k ? `<span class="arrow">${dir > 0 ? '▲' : '▼'}</span>` : ''}<span class="fico">▾</span></th>`).join('') + '</tr>';

  const html = [];
  rows.forEach(({ c, s }, i) => {
    const cls = ['c', i % 2 ? 'alt' : '', s.flagged ? 'warn' : s.sold ? 'sold' : (s.arrived || s.selling) ? 'arr' : '', s.selling ? 'selling' : '', s.soon ? 'soon' : '', state.open.has(c.key) ? 'open' : '', terms.length ? 'hit' : ''].join(' ');
    html.push(`<tr class="${cls}" data-key="${c.key}">` + CCOLS.map(col => cellHTML(c, s, col, terms)).join('') + '</tr>');
    if (state.open.has(c.key)) html.push(detailHTML(c));
  });
  $('#ctable tbody').innerHTML = html.join('') || `<tr><td colspan="${CCOLS.length}" class="dnote" style="padding:24px">${state.containers.length ? 'No containers match this filter.' : 'No containers yet. Click UPLOAD FILE and choose your Despacho (CSV or Excel).'}</td></tr>`;
  $('#count').textContent = `${rows.length} of ${state.containers.length} containers`;
  $('#cfoot').innerHTML = footHTML(rows.length, state.containers.length, 'container', state.cf, Object.fromEntries(CCOLS.map(c => [c.k, c.t])), 'c');

  // search hint: which containers have the words
  const hint = $('#qhint'), res = $('#qresults');
  if (terms.length) {
    hint.textContent = `${base.length} match${base.length === 1 ? '' : 'es'}`;
    res.hidden = false;
    res.innerHTML = base.length
      ? `<span>Found in:</span>` + base.slice(0, 14).map(x => `<button data-goto="${x.c.key}">${esc(x.c.containerNo)} · ${esc(x.c.vesselCode)}</button>`).join('') + (base.length > 14 ? `<span>+${base.length - 14} more</span>` : '')
      : '<span>No container has these words.</span>';
  } else { hint.textContent = ''; res.hidden = true; }

  renderRail();
}

const isFruitColor = c => /fruit\s*colou?r/i.test(c.client || '');
function cellHTML(c, s, col, terms) {
  if (col.k === 'etaDiff') { const d = etaDiff(c); return `<td data-k="etaDiff" class="${d === null ? '' : d > 0 ? 'late' : d < 0 ? 'early' : 'ontime'}">${esc(etaDiffText(c))}</td>`; }
  if (col.k === 'openingPrices') {
    const first = firstPrices(c);
    const today = todayISO(), noToday = !pricesFor(c, today);
    // reminders: opens today -> ask opening prices; opened before and still selling (no Sales End) -> ask follow up prices
    const due = noToday && c.salesStart === today ? 'ASK OPENING PRICES' : noToday && isISO(c.salesStart) && c.salesStart < today && !c.salesEnd ? 'ASK FOLLOW UP PRICES' : '';
    const txt = first ? (first.date !== c.salesStart ? `(${fmt(first.date)}) ` : '') + first.text : '';
    if (due) return `<td class="ed opdue" data-k="openingPrices" title="${esc(due + (txt ? ' · last prices: ' + txt : ''))}"><b>${due}</b>${txt ? ` <small>${esc(txt)}</small>` : ''}</td>`;
    return `<td class="ed ${txt ? '' : 'empty'}" data-k="openingPrices" title="${esc(txt)}">${highlight(txt, terms)}</td>`;
  }
  let v = col.k === 'pct' ? pctSold(c) : col.k === 'openingSold' ? openPct(c) : col.date ? fmt(c[col.k]) : c[col.k] ?? '';
  let inner;
  if (col.k === 'status') {
    const pills = [];
    if (s.soon) pills.push(`<span class="pill soon">${esc(s.arriving || 'Arriving soon')}</span>`);
    else if (s.arriving) pills.push(`<span class="pill ${s.late ? 'late' : 'selling'}">${esc(s.arriving)}</span>`);
    if (v) pills.push(`<span class="pill ${s.flagged ? 'warn' : s.sold ? 'sold' : s.selling ? 'selling' : ''}">${highlight(v, terms)}</span>`);
    else if (!s.soon && !s.arriving) pills.push(`<span class="pill auto">${s.auto}</span>`);
    inner = pills.join('');
  } else inner = highlight(v, terms);
  const ed = col.ed || (col.k === 'client' && isFruitColor(c));
  const classes = [ed ? 'ed' : '', ed && !v && col.k !== 'status' ? 'empty' : '', col.n ? 'num' : '', col.k === 'client' && isFruitColor(c) ? 'fc' : ''].join(' ');
  return `<td class="${classes}" data-k="${col.k}" title="${esc(v)}">${inner}</td>`;
}

function detailHTML(c) {
  const b = c.breakdown;
  const head = `<div class="dhead"><span>Container <b>${esc(c.containerNo)}</b></span><span>Vessel <b>${esc(c.vesselName)}</b></span>
    <span>Total boxes <b>${c.totalBoxes ? fmtBoxes(c.totalBoxes) : '—'}</b></span><span>Pallets in file <b>${c.palletsInFile || '—'}</b></span></div>`;
  if (!b) return `<tr class="detail"><td colspan="${CCOLS.length}">${head}<div class="dnote">No box detail yet. Upload the Despacho file that includes this container to see boxes by species, variety, label, grower, packaging and packing plant.</div></td></tr>`;
  const groups = [['species', 'Species'], ['variety', 'Variety'], ['label', 'Label'], ['grower', 'Grower'], ['packaging', 'Pack Code'], ['netWeight', 'Net Weight'], ['packType', 'Packing Type'], ['plant', 'Packing Plant'], ['size', 'Size']];
  const total = c.totalBoxes || 1;
  const blocks = groups.map(([k, t]) => {
    const e = Object.entries(b[k] || {}).sort((x, y) => y[1] - x[1]);
    const body = e.length ? e.map(([name, n]) => `<div class="dline"><span title="${esc(name)}">${esc(name)}</span><span>${fmtBoxes(n)}</span><span class="pct">${Math.round(n / total * 100)}%</span></div><div class="dbar" style="width:${n / total * 100}%"></div>`).join('')
      : `<div class="dnote">${k === 'plant' && !c.hasPlant ? 'Not in the Despacho file' : '—'}</div>`;
    return `<div><h4>${t}</h4>${body}</div>`;
  }).join('');
  return `<tr class="detail"><td colspan="${CCOLS.length}">${head}<div class="dgrid">${blocks}</div></td></tr>`;
}

// ---------- species rail ----------
function renderRail() {
  const by = {};
  for (const c of state.containers) {
    const s = stateOf(c), k = speciesOf(c);
    const o = by[k] || (by[k] = { total: 0, sold: 0, selling: 0 });
    o.total++; if (s.sold) o.sold++; if (s.selling) o.selling++;
  }
  const all = Object.values(by).reduce((a, o) => ({ total: a.total + o.total, sold: a.sold + o.sold, selling: a.selling + o.selling }), { total: 0, sold: 0, selling: 0 });
  const block = (name, o, key, extra = '') => `<button class="sp ${extra} ${state.species === key ? 'on' : ''}" data-sp="${esc(key ?? '')}">
    <div class="name"><span>${esc(name)}</span><b>${o.total}</b></div>
    <div class="bar"><i class="s" style="width:${o.total ? o.sold / o.total * 100 : 0}%"></i><i class="p" style="width:${o.total ? o.selling / o.total * 100 : 0}%"></i></div>
    <div class="stats"><span class="s">Sold ${o.sold}</span><span class="p">Selling ${o.selling}</span></div></button>`;
  $('#rail').innerHTML = block('All species', all, null, 'all') +
    Object.entries(by).sort((a, b) => b[1].total - a[1].total).map(([k, o]) => block(k, o, k)).join('');
}

// ---------- inline editing (containers) ----------
// size order: cherries L, XL, J, 2J, 3J... (dark "D" after the plain one); numeric sizes from small to big
function sizeRank(z) {
  const u = String(z).toUpperCase().trim(), m = /^(\d*)(J|XL|L)(D*)$/.exec(u);
  if (m) return [0, ({ L: 0, XL: 1, J: 2 }[m[2]] + (m[1] ? +m[1] : m[2] === 'J' ? 1 : 0)) * 3 + m[3].length, u];
  return /^\d+(\.\d+)?$/.test(u) ? [1, +u, u] : [2, 0, u];
}
const bySize = (a, b) => { const x = sizeRank(a), y = sizeRank(b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); };
// Opening Prices format: "LABEL SIZE PRICE / LABEL SIZE PRICE" (e.g. "GEN 2JD 180 / GEN JD 160").
// Older "SIZE PRICE" entries are still read (label left empty).
function parsePrices(t) {
  const out = [];
  for (const part of String(t || '').split('/').map(p => p.trim()).filter(Boolean)) {
    const w = part.split(/\s+/);
    if (w.length >= 3) out.push({ label: w[0].toUpperCase(), size: w[1].toUpperCase(), price: w.slice(2).join(' ') });
    else if (w.length === 2) out.push({ label: '', size: w[0].toUpperCase(), price: w[1] });
  }
  return out;
}
const lsKey = (l, z) => String(l || '').toUpperCase() + '|' + String(z || '').toUpperCase();
const U = v => String(v || '').trim().toUpperCase();
const specKey = p => [p.species, p.variety, p.netWeight, p.packType, p.label, p.category, p.size].map(U).join('|');
// every Species + Variety + Net Weight + Label + Size combination in the container (from the Despacho)
function fruitSpecs(c) {
  const set = new Map();
  for (const k of Object.keys(c.combos || {})) {
    const p = k.split('|');
    const [species, variety, netWeight, packType, label, size, category] = p[0] === 'v2' ? p.slice(1) : [p[0], p[1], '', '', p[3], p[4], ''];
    const sp = { species: U(species), variety: U(variety), netWeight: String(netWeight || '').trim(), packType: U(packType), label: U(label), category: U(category), size: U(size) };
    if (sp.size) set.set(specKey(sp), sp);
  }
  return [...set.values()].sort((x, y) => x.species.localeCompare(y.species) || x.variety.localeCompare(y.variety) || x.netWeight.localeCompare(y.netWeight) || x.packType.localeCompare(y.packType) || x.label.localeCompare(y.label) || x.category.localeCompare(y.category) || bySize(x.size, y.size));
}
// the price entries of a day: [{ species, variety, netWeight, label, size, price }]
function priceList(c, date) {
  const v = c.prices && c.prices[date];
  if (Array.isArray(v)) return v;
  return parsePrices(v || (date === c.salesStart && !c.prices ? c.openingPrices : ''));
}
const priceText = list => list.map(p => [p.variety, p.netWeight, p.packType, p.label, p.category, p.size, p.price].filter(Boolean).join(' ')).join(' / ');
// Prices of the Sales Start day, or of the first day that has prices
function firstPrices(c) {
  const days = Object.keys(c.prices || {}).filter(d => c.prices[d]).sort();
  if (c.prices && c.prices[c.salesStart]) return { date: c.salesStart, text: priceText(priceList(c, c.salesStart)) };
  if (days.length) return { date: days[0], text: priceText(priceList(c, days[0])) };
  return c.openingPrices ? { date: c.salesStart, text: c.openingPrices } : null;
}
function priceDates(c) {
  if (!isISO(c.salesStart)) return [];
  const last = isISO(c.salesEnd) ? c.salesEnd : (todayISO() > c.salesStart ? todayISO() : c.salesStart);
  const out = []; const d = new Date(c.salesStart + 'T12:00');
  while (out.length < 400) { const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; out.push(iso); if (iso >= last) break; d.setDate(d.getDate() + 1); }
  return out;
}
function editOpeningPrices(td, c, day) {
  const dates = priceDates(c);
  if (!dates.length) { toast('Set the Sales Start date first: prices are saved per day from Sales Start to Sales End.', true); return true; }
  if (!day) day = dates.includes(todayISO()) ? todayISO() : dates[dates.length - 1];
  const specs = fruitSpecs(c);
  const cur = priceList(c, day);
  const curMap = new Map(cur.map(p => [specKey(p), p.price]));
  for (const p of cur) if (!specs.some(x => specKey(x) === specKey(p))) specs.push({ species: U(p.species), variety: U(p.variety), netWeight: p.netWeight || '', packType: U(p.packType), label: U(p.label), category: U(p.category), size: U(p.size) });
  td.classList.add('editing');
  const box = document.createElement('div'); box.className = 'opbox wide';
  const line = p => `<label class="op-line"><span>${esc(p.species)}</span><span>${esc(p.variety)}</span><span>${esc(p.netWeight)}</span><span>${esc(p.packType || '')}</span><span>${esc(p.label)}</span><span>${esc(p.category || '')}</span><span>${esc(p.size)}</span><input data-spec="${esc(JSON.stringify(p))}" inputmode="decimal" value="${esc(curMap.get(specKey(p)) || '')}" aria-label="Price ${esc([p.variety, p.netWeight, p.label, p.size].join(' '))}"></label>`;
  box.innerHTML = `<div class="op-head">Prices (¥ RMB) · ${esc(c.containerNo)}</div>
    <label class="op-date">Date <select class="op-day">${dates.slice().reverse().map(d => `<option value="${d}" ${d === day ? 'selected' : ''}>${fmt(d)}${d === c.salesStart ? ' · opening' : ''}${d === c.salesEnd ? ' · sales end' : ''}${c.prices && c.prices[d] ? ' ✓' : ''}</option>`).join('')}</select></label>
    <div class="op-cols"><span>Species</span><span>Variety</span><span>Net Wt</span><span>Pack Type</span><span>Label</span><span>Category</span><span>Size</span><span>Price (¥ RMB)</span></div>
    <div class="op-list">${specs.map(line).join('') || '<div class="dnote">No box detail for this container: add the fruit with (+).</div>'}</div>
    <div class="op-add"><input class="op-ns" placeholder="Species" value="${esc(U(c.species).split(' / ')[0] || '')}"><input class="op-nv" placeholder="Variety"><input class="op-nw" placeholder="Net Wt"><input class="op-np" placeholder="Pack Type"><input class="op-nl" placeholder="Label"><input class="op-nc" placeholder="Category"><input class="op-nz" placeholder="Size"><button type="button" class="btn ghost" data-a="add" title="Add a fruit (species, variety, net weight, label, size) that is not in the list">+</button></div>
    <div class="op-prev"></div>
    <div class="op-foot"><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn hot" data-a="save">Save</button></div>`;
  document.body.appendChild(box);
  const place = () => { const rc = td.getBoundingClientRect(); box.style.top = Math.max(8, Math.min(rc.bottom + 4, innerHeight - box.offsetHeight - 8)) + 'px'; box.style.left = Math.max(8, Math.min(rc.left, innerWidth - box.offsetWidth - 8)) + 'px'; };
  place();
  const list = () => [...box.querySelectorAll('.op-list input')].filter(i => i.value.trim()).map(i => ({ ...JSON.parse(i.dataset.spec), price: i.value.trim() }));
  const prev = () => box.querySelector('.op-prev').textContent = priceText(list()) || 'Type the price next to each fruit.';
  prev(); box.addEventListener('input', prev);
  box.querySelector('.op-list input')?.focus();
  const close = async save => {
    if (save) {
      const l = list();
      const prices = {};
      for (const [d, v] of Object.entries(c.prices || {})) prices[d] = v;
      if (!c.prices && isISO(c.salesStart) && c.openingPrices) prices[c.salesStart] = c.openingPrices;
      if (l.length) prices[day] = l; else delete prices[day];
      const patch = { prices };
      if (day === c.salesStart) patch.openingPrices = priceText(l);   // the Opening Prices column shows the Sales Start day
      await patchContainer(c, patch);
    }
    box.remove(); renderContainers();
  };
  box.querySelector('.op-day').addEventListener('change', e => { box.remove(); td.classList.remove('editing'); editOpeningPrices(td, c, e.target.value); });
  box.addEventListener('click', e => {
    const act = e.target.closest('[data-a]')?.dataset.a; if (!act) return;
    if (act === 'add') {
      const v = cls => box.querySelector(cls).value.trim();
      const p = { species: U(v('.op-ns')), variety: U(v('.op-nv')), netWeight: kgUI(v('.op-nw')), packType: U(v('.op-np')), label: U(v('.op-nl')), category: U(v('.op-nc')), size: U(v('.op-nz')) };
      if (!p.size || !p.variety) { toast('Type at least the variety and the size.', true); return; }
      if ([...box.querySelectorAll('.op-list input')].some(i => specKey(JSON.parse(i.dataset.spec)) === specKey(p))) { toast('That fruit is already in the list.'); return; }
      box.querySelector('.op-list .dnote')?.remove();
      box.querySelector('.op-list').insertAdjacentHTML('beforeend', line(p));
      ['.op-nv', '.op-nw', '.op-np', '.op-nl', '.op-nc', '.op-nz'].forEach(cl => box.querySelector(cl).value = '');
      [...box.querySelectorAll('.op-list input')].pop().focus(); place(); prev();
      return;
    }
    close(act === 'save');
  });
  box.addEventListener('keydown', e => {
    if (e.key === 'Escape') close(false);
    if (e.key === 'Enter') { if (e.target.closest('.op-add')) box.querySelector('[data-a="add"]').click(); else close(true); }
  });
  return true;
}
// % of Container Sold: pallets sold per day after the opening, until 100%
function editSoldByDay(td, c) {
  if (!isISO(c.salesStart)) { toast('Set the Sales Start date first.', true); return; }
  const end = isISO(c.salesEnd) && c.salesEnd < todayISO() ? c.salesEnd : todayISO();
  const days = [];
  for (let d = new Date(c.salesStart + 'T12:00'); ; ) { d.setDate(d.getDate() + 1); const iso = d.toISOString().slice(0, 10); if (iso > end) break; days.push(iso); }
  for (const d of Object.keys(c.soldByDay || {})) if (!days.includes(d)) days.push(d);
  days.sort();
  td.classList.add('editing');
  const box = document.createElement('div'); box.className = 'opbox sold';
  box.innerHTML = `<div class="op-head">Pallets sold · ${esc(c.containerNo || c.vesselCode)} · ${palletsOf(c)} pallets</div>
    <div class="op-list"><label class="op-line"><span>${fmt(c.salesStart)} · opening</span><b>${num(c.openingSold) ?? '—'}</b></label>
    ${days.map(d => `<label class="op-line"><span>${fmt(d)}</span><input data-day="${d}" inputmode="decimal" value="${esc(c.soldByDay?.[d] ?? '')}" aria-label="Pallets sold on ${fmt(d)}"></label>`).join('') || '<div class="dnote">No days after the opening yet.</div>'}</div>
    <div class="op-prev"></div>
    <div class="op-foot"><button type="button" class="btn ghost" data-a="cancel">Cancel</button><button type="button" class="btn hot" data-a="save">Save</button></div>`;
  document.body.appendChild(box);
  const rc = td.getBoundingClientRect(); box.style.top = Math.max(8, Math.min(rc.bottom + 4, innerHeight - box.offsetHeight - 8)) + 'px'; box.style.left = Math.max(8, Math.min(rc.left, innerWidth - box.offsetWidth - 8)) + 'px';
  const read = () => { const o = {}; box.querySelectorAll('[data-day]').forEach(i => { if (i.value.trim()) o[i.dataset.day] = i.value.trim(); }); return o; };
  const prev = () => { const t = { ...c, soldByDay: read() }; const s = soldCum(t); const n = s.length ? s[s.length - 1][1] : 0; box.querySelector('.op-prev').textContent = `${n} of ${palletsOf(c)} pallets sold · ${Math.min(100, Math.round(n / palletsOf(c) * 100))}%`; };
  prev(); box.addEventListener('input', prev);
  [...box.querySelectorAll('[data-day]')].pop()?.focus();
  const close = async save => {
    if (save) { const o = read(); if (Object.values(o).some(v => num(v) === null)) { toast('Type numbers of pallets only.', true); return; } await patchContainer(c, { soldByDay: o }); }
    box.remove(); renderContainers();
  };
  box.addEventListener('click', e => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) close(a === 'save'); });
  box.addEventListener('keydown', e => { if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); });
}
function startEdit(td, c) {
  const k = td.dataset.k, col = CCOLS.find(x => x.k === k);
  if (td.classList.contains('editing')) return;
  if (k === 'openingPrices' && editOpeningPrices(td, c)) return;
  if (k === 'pct') { editSoldByDay(td, c); return; }
  td.classList.add('editing');
  const input = document.createElement('input');
  input.type = col.date ? 'date' : 'text';
  input.value = col.date ? (isISO(c[k]) ? c[k] : '') : (c[k] ?? '');
  if (k === 'status') { input.setAttribute('list', 'statusList'); }
  td.innerHTML = ''; td.appendChild(input); input.focus();
  if (col.date) { try { input.showPicker(); } catch { } } else if (input.select) try { input.select(); } catch { }
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const v = input.value.trim();
    // a date cell that held text (e.g. "NO INFORMATION") is only replaced when a date is picked
    const unchanged = col.date && !v && !isISO(c[k]);
    if (save && !unchanged && v !== (c[k] ?? '')) await patchContainer(c, { [k]: k === 'status' ? enStatus(v) : (k === 'salesCity' || k === 'client') ? v.toUpperCase() : v });
    renderContainers();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
  // picking a day in the calendar saves it right away (no Enter needed)
  if (input.type === 'date') input.addEventListener('change', () => { if (input.value) finish(true); });
}

function dateOrderError(c, patch) {
  if (!['ata', 'salesStart', 'salesEnd'].some(k => k in patch)) return null;
  const m = { ...c, ...patch };
  const ok = v => isISO(v);
  if (ok(m.ata) && ok(m.salesStart) && m.salesStart < m.ata) return `Sales Start (${fmt(m.salesStart)}) cannot be before ATA (${fmt(m.ata)}).`;
  if (ok(m.ata) && ok(m.salesEnd) && m.salesEnd < m.ata) return `Sales End (${fmt(m.salesEnd)}) cannot be before ATA (${fmt(m.ata)}).`;
  if (ok(m.salesStart) && ok(m.salesEnd) && m.salesEnd < m.salesStart) return `Sales End (${fmt(m.salesEnd)}) cannot be before Sales Start (${fmt(m.salesStart)}).`;
  return null;
}
// Prices of a container for one day (Containers > Opening Prices, saved per date)
const pricesFor = (c, date) => priceText(priceList(c, date));
// Daily Sales of a day: Sales Start that day -> OPENING TODAY (with or without Sales End).
// Started before and still no Sales End -> FOLLOWING UP, only when there are prices for that day.
function dailyStatusFor(c, date) {
  if (!isISO(c.salesStart) || c.salesStart > date) return null;
  if (c.salesStart === date) return 'OPENING TODAY';
  if (!c.salesEnd && pricesFor(c, date)) return 'FOLLOWING UP';
  return null;
}
// Today's Daily Sales rows of a container always match Containers: added, updated (price, status, client, market...) or removed.
async function syncDailyFrom(c, date = todayISO()) {
  const k = ckey(c);
  const mine = state.daily.filter(d => d.date === date && (tOf(d.transport) || 'M') + vkey(d.vesselCode) === k);
  const status = dailyStatusFor(c, date);
  const want = status ? rowsWithPrices(c, date, status) : [];
  const res = { added: 0, updated: 0, removed: 0 };
  const left = new Set(mine.map(d => d.id));
  const toAdd = [];
  for (const w of want) {
    const ex = mine.find(d => left.has(d.id) && dailySig(d) === dailySig(w));
    if (!ex) { toAdd.push(w); continue; }
    left.delete(ex.id);
    const patch = {};
    for (const f of ['status', 'client', 'market', 'transport', 'species', 'price']) if (String(ex[f] ?? '') !== String(w[f] ?? '')) patch[f] = w[f] ?? '';
    if (Object.keys(patch).length) { try { Object.assign(ex, await api('/api/daily/' + ex.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })); res.updated++; } catch { } }
  }
  for (const id of left) { try { await api('/api/daily/' + id, { method: 'DELETE' }); res.removed++; } catch { } }
  if (left.size) { state.daily = state.daily.filter(d => !left.has(d.id)); left.forEach(id => state.dSel.delete(id)); }
  if (toAdd.length) { await addDaily(toAdd); res.added = toAdd.length; }
  return res;
}
async function patchContainer(c, patch) {
  if ('openingSold' in patch) { patch.openingSold = String(patch.openingSold ?? '').trim(); if (patch.openingSold && num(patch.openingSold) === null) { toast('% Sold at Opening: type the number of pallets sold at the opening.', true); return false; } }
  if ('openingSold' in patch || 'soldByDay' in patch) {
    // the day the container reaches 100% becomes its Sales End
    const t = { ...c, ...patch }, full = soldCum(t).find(([, n]) => n >= palletsOf(t));
    if (full && t.salesEnd !== full[0]) { patch.salesEnd = full[0]; patch.salesEndAuto = '1'; toast(`${c.containerNo || c.vesselCode}: 100% sold on ${fmt(full[0])}, Sales End filled.`); }
    else if (!full && c.salesEndAuto === '1' && c.salesEnd) { patch.salesEnd = ''; patch.salesEndAuto = ''; }
  } else if ('salesEnd' in patch) patch.salesEndAuto = '';
  const err = dateOrderError(c, patch);
  if (err) { toast(`${c.containerNo || c.vesselCode}: ${err} Not saved.`, true); return false; }
  try {
    const upd = await api('/api/container/' + c.key, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    Object.assign(c, upd);
    if (['salesStart', 'salesEnd', 'client', 'salesCity', 'transport', 'species', 'prices', 'openingPrices'].some(f => f in patch)) { await syncDailyFrom(c); if (!$('#tab-daily').hidden) renderDaily(); }
    return true;
  } catch (e) { toast('Could not save: ' + e.message, true); return false; }
}

// ---------- daily sales ----------
const DCOLS = [
  { k: 'status', t: 'Status' }, { k: 'transport', t: 'Transportation' }, { k: 'date', t: 'Sales Date', date: 1 }, { k: 'client', t: 'Client' }, { k: 'market', t: 'Market' },
  { k: 'vesselCode', t: 'Vessel Code' }, { k: 'vesselName', t: 'Vessel Name', derived: 1 }, { k: 'species', t: 'Species' }, { k: 'variety', t: 'Variety' }, { k: 'netWeight', t: 'Net Weight' }, { k: 'packType', t: 'Packing Type' },
  { k: 'label', t: 'Label' }, { k: 'size', t: 'Size' }, { k: 'price', t: 'Sales Price' },
];
const isAir = c => /^A/i.test(String(c.transport || '').trim());
const ckey = c => (isAir(c) ? 'A' : 'M') + vkey(c.vesselCode);
const codeKey = code => { const s = String(code || '').trim().toUpperCase(); return { t: /^A(?=\d)/.test(s) ? 'A' : /^M(?=\d)/.test(s) ? 'M' : '', k: vkey(s) }; };
const dk = code => { const { t, k } = codeKey(code); return (t || 'M') + k; };
const tOf = v => /^A/i.test(String(v || '').trim()) ? 'A' : /^M/i.test(String(v || '').trim()) ? 'M' : '';
// all containers with this vessel code (can be one Air and one Sea)
const allByVessel = code => { const { t, k } = codeKey(code); return state.containers.filter(c => vkey(c.vesselCode) === k && (!t || ckey(c)[0] === t)); };
// transport (A / M) decides when the same code exists as Air and as Sea; without it Sea comes first
const byVessel = (code, transport) => {
  const hits = allByVessel(code);
  const t = tOf(transport);
  return (t && hits.find(c => ckey(c)[0] === t)) || hits.find(c => !isAir(c)) || hits[0];
};
// code as written in Daily Sales: air codes carry the A (A0001), sea codes go without letter (0001)
const dailyCode = c => String(c.vesselCode || '').replace(/^[MA](?=\d)/i, '');

function renderDaily() {
  _salesCache = allSales();      // also fills vesselName on every row
  const dates = [...new Set(state.daily.map(d => d.date).filter(Boolean))].sort().reverse();
  state.dDate = '*';
  if (!state._dDefault) { state._dDefault = true; state.df.date = new Set([fmt(todayISO())]); }
  const tdy = new Date(todayISO() + 'T12:00');
  $('#dTodayLabel').textContent = `Today: ${tdy.toLocaleDateString('en-GB', { weekday: 'long' })} ${fmt(todayISO())}`;

  const terms = state.q.toUpperCase().split(/\s+/).filter(Boolean);
  let rows = state.daily.filter(d => state.dDate === '*' || d.date === state.dDate);
  if (terms.length) rows = rows.filter(d => terms.every(t => Object.values(d).join(' ').toUpperCase().includes(t)));
  state._dbase = rows;
  rows = rows.filter(d => passes(state.df, k => dVal(d, k)));
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.status).localeCompare(String(b.status)) || String(a.vesselCode).localeCompare(String(b.vesselCode)) || String(a.variety).localeCompare(String(b.variety)) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));

  const allSel = rows.length && rows.every(r => state.dSel.has(r.id));
  $('#dtable thead').innerHTML = `<tr><th class="ck"><input type="checkbox" id="dAll" ${allSel ? 'checked' : ''} aria-label="Select all"></th>` + DCOLS.map(c => `<th data-col="${c.k}" class="${state.df[c.k] ? 'filtered' : ''}" title="Click to filter">${c.t}<span class="fico">▾</span></th>`).join('') + '<th title="Fruit Color price minus the best other sale of the same fruit (same vessel), same day or any other day">vs Best Sale</th><th></th></tr>';
  const fcLow = fcLowerMap();
  const lowShown = rows.filter(d => fcLow.has(d.id)).length;
  $('#fcAlert').hidden = !lowShown;
  $('#fcAlert').textContent = lowShown ? `⚠ ${lowShown} Fruit Color price${lowShown > 1 ? 's are' : ' is'} below another sale of the same fruit from the same vessel. See the vs Best Sale column.` : '';
  $('#dfoot').innerHTML = footHTML(rows.length, state.daily.filter(d => state.dDate === '*' || d.date === state.dDate).length, 'row', state.df, Object.fromEntries(DCOLS.map(c => [c.k, c.t])), 'd');
  $('#dtable tbody').innerHTML = rows.map(r => `<tr class="${(r.status || '').toLowerCase().replace(/\s+/g, '-')} ${state.dSel.has(r.id) ? 'sel' : ''}" data-id="${r.id}">
    <td class="ck"><input type="checkbox" ${state.dSel.has(r.id) ? 'checked' : ''} aria-label="Select row"></td>` +
    DCOLS.map(c => `<td class="${c.derived ? '' : 'ed'} ${r[c.k] ? '' : 'empty'} ${c.k === 'price' && fcLow.has(r.id) ? 'fclow' : ''}" data-k="${c.k}"${c.k === 'price' && fcLow.has(r.id) ? ` title="${esc(fcAlertText(r, fcLow.get(r.id)))}"` : ''}>${c.k === 'status' ? (r.status ? `<span class="pill ${/^OPENING/.test(r.status) ? 'soon-static' : r.status === 'SOLD OUT' ? 'soldout' : 'selling'}">${esc(r.status)}</span>` : '') : highlight(c.date ? fmt(r[c.k]) : r[c.k], terms)}</td>`).join('') +
    cmpCells(r) + `<td><button class="del" data-del="${r.id}" title="Delete row">×</button></td></tr>`).join('');
  $('#dEmpty').hidden = rows.length > 0;
  $('#dEmpty').textContent = 'No rows for today yet. Click IMPORT CONTAINERS to bring today\'s openings and the containers still selling, or ADD ROW for a single vessel code.';
  const n = state.dSel.size;
  $('#dSel').textContent = n ? `${n} selected` : '';
  $('#dCopy').disabled = !n; $('#dDel').disabled = !n || !state.edit;
  $('#dDel').textContent = 'Delete'; delete $('#dDel').dataset.armed;
}

function datalistFor(k, r) {
  const c = byVessel(r.vesselCode, r.transport);
  const map = { variety: 'variety', netWeight: 'netWeight', packType: 'packType', label: 'label', size: 'size' };
  let vals = [];
  if (k === 'status') vals = ['OPENING TODAY', 'FOLLOWING UP'];
  else if (map[k] && c?.breakdown) vals = Object.keys(c.breakdown[map[k]] || {});
  else if (k === 'vesselCode') vals = state.containers.filter(x => !stateOf(x).sold).map(x => x.vesselCode);
  let dl = $('#dl'); if (!dl) { dl = document.createElement('datalist'); dl.id = 'dl'; document.body.appendChild(dl); }
  dl.innerHTML = [...new Set(vals)].map(v => `<option value="${esc(v)}">`).join('');
  return vals.length ? 'dl' : null;
}

function startDailyEdit(td, r) {
  if (td.classList.contains('editing')) return;
  const k = td.dataset.k, col = DCOLS.find(c => c.k === k);
  td.classList.add('editing');
  const input = document.createElement('input');
  input.type = col.date ? 'date' : 'text'; input.value = r[k] ?? '';
  const list = datalistFor(k, r); if (list) input.setAttribute('list', list);
  td.innerHTML = ''; td.appendChild(input); input.focus();
  if (col.date) { try { input.showPicker(); } catch { } }
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    let v = input.value.trim();
    if (k !== 'date') v = k === 'status' ? dailyStatus(v) : k === 'netWeight' ? kgUI(v) : v.toUpperCase();
    if (save && v !== (r[k] ?? '')) {
      const patch = { [k]: v };
      if (k === 'vesselCode') {   // Vessel Code fills Client, Market and Species
        const hits = allByVessel(v);
        const c = byVessel(v, hits.length > 1 ? r.transport : '');
        if (hits.length > 1) toast(`${v} exists as Air and as Sea. Filled with ${isAir(c) ? 'Air' : 'Sea'}; change Transportation (A / M) and re-type the code if it is the other one.`);
        if (c) { patch.vesselCode = dailyCode(c); patch.transport = c.transport || ''; patch.client = c.client; patch.market = c.salesCity || ''; patch.species = c.species; if (!r.variety && c.mainVariety && !c.mainVariety.includes('/')) patch.variety = c.mainVariety; if (!r.label && c.mainLabel && !c.mainLabel.includes('/')) patch.label = c.mainLabel; }
        else toast(`No container with vessel code ${v}. Client, Market and Species were not filled.`, true);
      }
      try { Object.assign(r, await api('/api/daily/' + r.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })); }
      catch (e) { toast('Could not save: ' + e.message, true); }
      if (k === 'price' || k === 'client') {
        const low = fcLowerMap();
        const mine = isFC(r.client) ? (low.get(r.id) ? [[r, low.get(r.id)]] : []) : state.daily.filter(d => low.has(d.id) && fruitKey(d) === fruitKey(r)).map(d => [d, low.get(d.id)]);
        if (mine.length) fcAlert(fcAlertText(mine[0][0], mine[0][1]));
      }
    }
    renderDaily();
    // Tab to the next cell for quick entry
    if (save && done && nextAfter) { const nt = $(`#dtable tr[data-id="${r.id}"] td[data-k="${nextAfter}"]`); if (nt) startDailyEdit(nt, r); }
  };
  let nextAfter = null;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    if (e.key === 'Tab') { e.preventDefault(); const i = DCOLS.findIndex(c => c.k === k); nextAfter = DCOLS[(i + (e.shiftKey ? -1 : 1) + DCOLS.length) % DCOLS.length].k; finish(true); }
  });
  input.addEventListener('blur', () => finish(true));
  // picking a day in the calendar saves it right away (no Enter needed)
  if (input.type === 'date') input.addEventListener('change', () => { if (input.value) finish(true); });
}

const kgUI = v => { const s = String(v).trim(); if (!s) return ''; if (/^\d+([.,]\d+)?$/.test(s)) return s + ' kg'; return s.replace(/\s*(kgs?|kilos?|kilogram(s)?)\.?$/i, ' kg'); };
const isFC = name => /fruit\s*colou?r/i.test(name || '');
// "120-125" -> 122.5 ; "135" -> 135
const priceNum = p => { const n = String(p || '').replace(/,/g, '.').match(/\d+(\.\d+)?/g); return n ? n.map(Number).reduce((a, b) => a + b, 0) / n.length : null; };
// SAME FRUIT = same vessel (ship name, not the vessel code), species, variety, size, transport, net weight, packing type and label.
// Any day, any client, any container, any market. Price ranges are compared by their average.
const shipOf = d => (byVessel(d.vesselCode, d.transport)?.vesselName || '').trim().toUpperCase();
const sameFruitKey = d => [shipOf(d), tOf(d.transport) || 'M', d.species, d.variety, d.netWeight, d.packType, d.label, d.category, d.size].map(v => String(v || '').trim().toUpperCase()).join('|');
const fruitKey = sameFruitKey;
// For every Fruit Color row: the other sales of the same fruit (any day, any client, Fruit Color too) with a HIGHER price
// All sales: the Daily Sales rows plus every day of prices saved in Containers (Opening Prices by date).
// A day already present in Daily Sales is not counted twice.
// boxes of a sold fruit in its container (Despachos), by category: [{ category, boxes }]
function fruitCombos(r) {
  const c = byVessel(r.vesselCode, r.transport); if (!c?.combos) return [];
  const w = v => { const n = String(v || '').replace(/,/g, '.').match(/\d+(\.\d+)?/g); return n ? n.map(Number).reduce((a, b) => a * b, 1) : null; };
  const out = [];
  for (const [k, b] of Object.entries(c.combos)) {
    const [v, sp, va, nw, pt, lb, sz, ct] = k.split('|'); if (v !== 'v2') continue;
    if (U(sp) === U(r.species) && U(va) === U(r.variety) && w(nw) === w(r.netWeight) && U(pt) === U(r.packType) && U(lb) === U(r.label) && U(sz) === U(r.size)) out.push({ category: U(ct), boxes: b });
  }
  return out;
}
function allSales() {
  const out = state.daily.slice();
  const seen = new Set(out.map(dailySig));
  const loose = new Set(out.filter(d => !d.category).map(d => dailySig({ ...d, category: '' })));
  for (const c of state.containers) {
    const days = new Set(Object.keys(c.prices || {}).filter(d => c.prices[d]));
    if (!c.prices && isISO(c.salesStart) && c.openingPrices) days.add(c.salesStart);
    for (const day of days) {
      rowsWithPrices(c, day, day === c.salesStart ? 'OPENING TODAY' : 'FOLLOWING UP').forEach((row, i) => {
        if (seen.has(dailySig(row)) || loose.has(dailySig({ ...row, category: '' }))) return;
        seen.add(dailySig(row));
        out.push({ ...row, id: `p-${c.key}-${day}-${i}`, fromContainers: true });
      });
    }
  }
  for (const r of out) {
    const ct = byVessel(r.vesselCode, r.transport);
    r.vesselName = ct?.vesselName || '';
    r.cStatus = ct ? (ct.status || stateOf(ct).auto) : ''; r.openPct = ct ? openPct(ct) : ''; r.containerPct = ct ? pctSold(ct) : '';
    // a sale written before Category existed: take it from the container when that fruit has only one category
    if (!r.category) { const cats = [...new Set(fruitCombos(r).map(x => x.category))]; if (cats.length === 1 && cats[0]) r.category = cats[0]; }
  }
  return out;
}
let _salesCache = null;
const salesPool = () => _salesCache || allSales();
function fcLowerMap() {
  const groups = new Map();
  for (const d of salesPool()) { if (priceNum(d.price) === null) continue; const k = sameFruitKey(d); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  const out = new Map();
  for (const g of groups.values()) for (const fc of g.filter(d => isFC(d.client))) {
    const mine = priceNum(fc.price);
    const higher = g.filter(o => o.id !== fc.id && priceNum(o.price) > mine).sort((x, y) => priceNum(y.price) - priceNum(x.price));
    if (higher.length) out.set(fc.id, higher);
  }
  return out;
}
// One comparison: Fruit Color price versus the BEST other sale of the same fruit (same day or any other day)
function vsBest(row) {
  const mine = priceNum(row.price); if (mine === null) return null;
  const k = sameFruitKey(row);
  const best = salesPool().filter(o => o.id !== row.id && sameFruitKey(o) === k && priceNum(o.price) !== null).sort((x, y) => priceNum(y.price) - priceNum(x.price))[0];
  if (!best) return null;
  const c = byVessel(best.vesselCode, best.transport);
  return { diff: Math.round((mine - priceNum(best.price)) * 100) / 100, best, container: c?.containerNo || '' };
}
const bestText = o => `${o.best.price} · ${o.best.client}${isFC(o.best.client) ? ' [Fruit Color container]' : ''} · ${o.best.vesselCode}${o.container ? ' (' + o.container + ')' : ''} · ${fmt(o.best.date)}`;
const rmb = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + ' RMB';
function fcAlertText(row, higher) {
  return `⚠ Someone sold this fruit higher than Fruit Color · ${shipOf(row) || row.vesselCode} · ${row.species} ${row.variety} ${row.netWeight || ''} ${row.packType || ''} ${row.label || ''} ${row.category || ''} size ${row.size}: ${row.client} ${row.vesselCode} ${row.price} vs ` +
    higher.map(o => `${o.client}${isFC(o.client) ? ' [Fruit Color container]' : ''} ${o.vesselCode} (${o.market || '-'}, ${fmt(o.date)}) ${o.price}`).join(', ');
}
// Ranking of every sale of the same fruit (highest average price first); ties share the place
function rankHTML(r) {
  const k = sameFruitKey(r);
  const list = salesPool().filter(o => sameFruitKey(o) === k && priceNum(o.price) !== null).sort((x, y) => priceNum(y.price) - priceNum(x.price));
  const placeOf = o => 1 + list.filter(x => priceNum(x.price) > priceNum(o.price)).length;
  const mine = placeOf(r), leader = list[0];
  const ord = n => n + (n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th');
  return `<div class="tip-same">Ranking for this fruit: Fruit Color is ${ord(mine)} of ${list.length} · Leader: ${esc(leader.client)} ${esc(leader.vesselCode)} (${esc(leader.price)})</div>
    <div class="tip-rank">${list.slice(0, 8).map(o => `<span>${ord(placeOf(o))}</span><span class="${o.id === r.id ? 'me' : ''}">${esc(o.client)}${isFC(o.client) && o.id !== r.id ? ' [FC]' : ''} · ${esc(o.vesselCode)} · ${fmt(o.date)}</span><span>${esc(o.price)}</span>`).join('')}${list.length > 8 ? `<span></span><span>+${list.length - 8} more</span><span></span>` : ''}</div>`;
}
// Hover box for "vs Best Sale": the difference, who sold, and every parameter that makes it the same fruit
function cmpTip(r, o) {
  const b = o.best, same = [
    ['Vessel', shipOf(r)], ['Transportation', tOf(r.transport) === 'A' ? 'Air (A)' : 'Sea (M)'], ['Species', r.species], ['Variety', r.variety],
    ['Net Weight', r.netWeight], ['Packing Type', r.packType], ['Label', r.label], ['Category', r.category], ['Size', r.size]];
  const head = o.diff > 0 ? `Fruit Color is ${Math.abs(o.diff)} RMB ABOVE` : o.diff < 0 ? `Fruit Color is ${Math.abs(o.diff)} RMB BELOW` : 'Same price as';
  return `<b class="${o.diff > 0 ? 'up' : o.diff < 0 ? 'down' : ''}">${head} the best other sale</b>
    <div class="tip-grid"><span>Fruit Color</span><span>${esc(r.client)} · ${esc(r.vesselCode)} · ${esc(byVessel(r.vesselCode, r.transport)?.containerNo || '')} · ${fmt(r.date)} · <b>${esc(r.price)}</b></span>
    <span>Other client</span><span>${esc(b.client)}${isFC(b.client) ? ' [Fruit Color container]' : ''}</span>
    <span>Vessel code</span><span>${esc(b.vesselCode)}</span><span>Container</span><span>${esc(o.container || '—')}</span>
    <span>Date sold</span><span>${fmt(b.date)}</span><span>Market</span><span>${esc(b.market || '—')}</span><span>Price</span><span><b>${esc(b.price)}</b> RMB${/-/.test(b.price) ? ' (average ' + priceNum(b.price) + ')' : ''}</span></div>
    ${rankHTML(r)}
    <div class="tip-same">Same fruit because these are equal:</div>
    <div class="tip-grid">${same.map(([k, v]) => `<span>${k}</span><span>${esc(v || '—')}</span>`).join('')}</div>`;
}
function cmpCells(r) {
  if (!isFC(r.client)) return '<td></td>';
  const o = vsBest(r);
  if (!o) return '<td></td>';
  return `<td class="cmp wide ${o.diff > 0 ? 'up' : o.diff < 0 ? 'down' : ''}" data-tip="${esc(cmpTip(r, o))}">${rmb(o.diff)} <small>${o.diff > 0 ? 'above' : o.diff < 0 ? 'below' : 'same as'} ${esc(o.best.client)} · ${esc(o.best.vesselCode)}</small></td>`;
}
// ---------- Total Sales: every sale of every day, with the Fruit Color comparisons ----------
// Total Sales shows every column of Daily Sales except Status
// plus, from Tracking: the container's Status, % Sold at Opening and % of Container Sold
const TCOLS = DCOLS.filter(c => c.k !== 'status').flatMap(c => c.k === 'label' ? [c, { k: 'category', t: 'Category' }]
  : c.k === 'transport' ? [c, { k: 'cStatus', t: 'Status' }] : [c]);
function renderTotal() {
  _salesCache = allSales();
  const terms = state.q.toUpperCase().split(/\s+/).filter(Boolean);
  let rows = _salesCache.slice();
  if (terms.length) rows = rows.filter(d => terms.every(t => Object.values(d).join(' ').toUpperCase().includes(t)));
  state._tbase = rows;
  rows = rows.filter(d => passes(state.tf, k => dVal(d, k)));
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.vesselCode).localeCompare(String(b.vesselCode)) || String(a.label).localeCompare(String(b.label)) || bySize(a.size, b.size));
  $('#ttable thead').innerHTML = '<tr>' + TCOLS.map(c => `<th data-col="${c.k}" class="${state.tf[c.k] ? 'filtered' : ''}" title="Click to filter">${c.t}<span class="fico">▾</span></th>`).join('') +
    '<th title="Fruit Color price minus the best other sale of the same fruit (same vessel), same day or any other day">vs Best Sale</th></tr>';
  $('#ttable tbody').innerHTML = rows.map(r => `<tr data-id="${r.id}">` + TCOLS.map(c => `<td data-k="${c.k}">${highlight(c.date ? fmt(r[c.k]) : r[c.k], terms)}</td>`).join('') + cmpCells(r) + '</tr>').join('')
    || `<tr><td colspan="${TCOLS.length + 1}" class="dnote" style="padding:24px">No sales yet.</td></tr>`;
  const lower = rows.filter(r => isFC(r.client) && (vsBest(r)?.diff ?? 0) < 0).length;
  $('#tAlert').hidden = !lower;
  $('#tAlert').textContent = lower ? `⚠ ${lower} Fruit Color sale${lower > 1 ? 's are' : ' is'} below another sale of the same fruit from the same vessel. See the red cells.` : '';
  $('#tfoot').innerHTML = footHTML(rows.length, _salesCache.length, 'sale', state.tf, Object.fromEntries(TCOLS.map(c => [c.k, c.t])), 't');
}
// CSV download; dates written as ="dd-mm-yyyy" so Excel shows every date the same way
function downloadCSV(name, header, rows) {
  const q = v => { let t = String(v ?? ''); if (/^\d{2}-\d{2}-\d{4}$/.test(t) || /^0\d+$/.test(t)) t = `="${t}"`; return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = '\uFEFF' + [header, ...rows].map(r => r.map(q).join(',')).join('\r\n') + '\r\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  // keep a copy in History (PC only)
  if (!REMOTE) fetch('/api/history', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(name), 'Content-Type': 'text/csv' }, body: csv }).catch(() => { });
}
// ---------- File history (Settings): every uploaded and downloaded file, downloadable again ----------
async function openHistory() {
  closeBoxes();
  let list = [];
  try { list = await api('/api/history'); } catch (e) { toast('Could not read the history: ' + e.message, true); return; }
  const size = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const when = iso => { const d = new Date(iso); return `${fmt(d.toISOString().slice(0, 10))} ${d.toTimeString().slice(0, 5)}`; };
  const box = document.createElement('div'); box.className = 'opbox hist';
  box.innerHTML = `<div class="op-head">File history · uploaded and downloaded files</div>
    <div class="hist-list">${list.length ? `<table class="cmp-t"><thead><tr><th>Date</th><th>Type</th><th>File</th><th>Size</th><th></th></tr></thead><tbody>${list.map(h => `<tr><td>${when(h.at)}</td><td><span class="pill ${h.kind === 'upload' ? 'selling' : ''}">${h.kind === 'upload' ? 'Uploaded' : 'Downloaded'}</span></td><td>${esc(h.name)}</td><td>${size(h.size)}</td><td><a class="btn ghost" href="/api/history/file/${h.id}" download>Download</a></td></tr>`).join('')}</tbody></table>` : '<div class="dnote">No files yet. Every file you upload or download from now on will show here.</div>'}</div>
    <div class="dnote">Copies are kept in Kuai Tracking\\File history.</div>
    <div class="op-foot"><button type="button" class="btn ghost" data-a="close">Close</button></div>`;
  document.body.appendChild(box);
  box.style.top = '70px'; box.style.left = Math.max(8, (innerWidth - box.offsetWidth) / 2) + 'px';
  box.addEventListener('click', e => { if (e.target.closest('[data-a="close"]')) box.remove(); });
  box.addEventListener('keydown', e => { if (e.key === 'Escape') box.remove(); });
}
document.addEventListener('click', e => { if (e.target.id === 'histBtn') openHistory(); });
// value of a Tracking cell, as shown in the table (Opening Prices = every day of prices in one cell)
function trackingVal(c, col) {
  if (col.k === 'status') return c.status || stateOf(c).auto;
  if (col.k === 'pct') return pctSold(c);
  if (col.k === 'openingSold') return openPct(c);
  if (col.k === 'etaDiff') return etaDiffText(c);
  if (col.k === 'openingPrices') { const days = Object.keys(c.prices || {}).sort(); return days.length ? days.map(d => `${fmt(d)}: ${priceText(priceList(c, d))}`).join(' ; ') : (c.openingPrices || ''); }
  return col.date ? fmt(c[col.k]) : (c[col.k] ?? '');
}
// ---------- Excel (.xlsx) with several tabs, no library: plain XML parts in a stored (uncompressed) zip ----------
function downloadXLSX(name, sheets) {
  const enc = new TextEncoder();
  const x = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const colName = i => { let n = ''; i++; while (i) { const m = (i - 1) % 26; n = String.fromCharCode(65 + m) + n; i = Math.floor((i - 1) / 26); } return n; };
  const sheetXML = rows => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>' +
    rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => { const ref = colName(ci) + (ri + 1), t = String(v ?? ''); if (t === '') return '';
      return /^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t) ? `<c r="${ref}"${ri ? '' : ' s="1"'}><v>${t}</v></c>` : `<c r="${ref}" t="inlineStr"${ri ? '' : ' s="1"'}><is><t xml:space="preserve">${x(t)}</t></is></c>`; }).join('')}</row>`).join('') + '</sheetData></worksheet>';
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map(([n], i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ...sheets.map(([, rows], i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXML(rows)]),
  ];
  // zip (store)
  const crcT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], central = []; let off = 0;
  for (const [fn, txt] of files) {
    const nb = enc.encode(fn), data = enc.encode(txt), c = crc(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint32(14, c, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint32(16, c, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nb.length, true); ch.setUint32(42, off, true);
    central.push(new Uint8Array(ch.buffer), nb);
    off += 30 + nb.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  const blob = new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (!REMOTE) fetch('/api/history', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(name) }, body: blob }).catch(() => { });
  return blob;
}
async function addDaily(rows) {
  const created = await api('/api/daily', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rows) });
  state.daily.push(...created);
  return created;
}

// "Start today's update": type the vessel codes opened today; their rows come from Containers
// (one row per species / variety / packaging / label / size found in the container). Optionally carries over
// each container's most recent previous day's rows that are still selling (not SOLD OUT), as SELLING.
function rowsFromContainer(c, date, status = 'OPENING') {
  const base = { status, transport: c.transport || '', date, client: c.client || '', market: c.salesCity || '', vesselCode: dailyCode(c), price: '' };
  if (c.combos && Object.keys(c.combos).length) {
    return Object.keys(c.combos).map(k => {
      const p = k.split('|');
      const [species, variety, netWeight, packType, label, size, category] = p[0] === 'v2' ? p.slice(1) : [p[0], p[1], '', '', p[3], p[4], ''];
      return { ...base, species, variety, netWeight, packType, label, category: category || '', size };
    }).sort((a, b) => (a.variety + a.netWeight + a.packType + a.label).localeCompare(b.variety + b.netWeight + b.packType + b.label) || String(a.size).localeCompare(String(b.size), undefined, { numeric: true }));
  }
  const one = v => (v && !String(v).includes('/') ? v : '');
  const only = k => { const o = Object.keys(c.breakdown?.[k] || {}); return o.length === 1 ? o[0] : ''; };
  return [{ ...base, species: c.species || '', variety: one(c.mainVariety), netWeight: only('netWeight'), packType: only('packType'), label: one(c.mainLabel), size: '' }];
}

// ---------- Import Containers / Add row ----------
const dailySig = d => [d.date, tOf(d.transport) || 'M', vkey(d.vesselCode), d.variety, d.netWeight, d.packType, d.label, d.category, d.size].map(v => String(v || '').toUpperCase()).join('|');
// Today's openings (Sales Start = today) as OPENING, and containers that started earlier and have no Sales End yet as SELLING
// One Daily Sales row per label + size that has an opening price (one per variety / net weight / packing type found for it)
function rowsWithPrices(c, date, status) {
  const prices = priceList(c, date);
  if (!prices.length) return [];
  const all = rowsFromContainer(c, date, status);
  const out = [];
  const eq = (a, b) => !U(a) || U(a) === U(b);       // empty in the price = any (old entries)
  for (const p of prices) {
    const match = all.filter(r => U(r.size) === U(p.size) && eq(p.label, r.label) && eq(p.variety, r.variety) && eq(p.species, r.species) && eq(p.netWeight, r.netWeight) && eq(p.packType, r.packType) && eq(p.category, r.category));
    if (match.length) match.forEach(r => out.push({ ...r, price: p.price }));
    else out.push({ ...(all[0] || { status, transport: c.transport || '', date, client: c.client || '', market: c.salesCity || '', vesselCode: dailyCode(c) }),
      species: p.species || c.species || '', variety: p.variety || '', netWeight: p.netWeight || '', packType: p.packType || '', label: p.label || '', category: p.category || '', size: p.size, price: p.price });
  }
  return out;
}
async function importContainers() {
  if (!state.edit) { toast('Turn on Edit mode in Settings to import.'); return; }
  const today = todayISO();
  const tot = { added: 0, updated: 0, removed: 0 }; let opening = 0, follow = 0;
  for (const c of state.containers) {
    const st = dailyStatusFor(c, today);
    const had = state.daily.some(d => d.date === today && (tOf(d.transport) || 'M') + vkey(d.vesselCode) === ckey(c));
    if (!st && !had) continue;
    const r = await syncDailyFrom(c, today);
    tot.added += r.added; tot.updated += r.updated; tot.removed += r.removed;
    if (st && rowsWithPrices(c, today, st).length) st === 'OPENING TODAY' ? opening++ : follow++;
  }
  state.df.date = new Set([fmt(today)]); renderDaily();
  if (!tot.added && !tot.updated && !tot.removed) { toast('Daily Sales is already up to date with Containers. Only containers with prices for today are listed.'); return; }
  toast(`Today: ${opening} opening, ${follow} following up. ${tot.added} rows added, ${tot.updated} updated, ${tot.removed} removed.`);
}
function previewAdd() {
  const code = $('#adCode').value.trim(), t = $('#adForm').querySelector('input[name="adT"]:checked').value;
  if (!code) { $('#adPreview').textContent = ''; return; }
  const c = allByVessel(code).find(x => ckey(x)[0] === t);
  $('#adPreview').innerHTML = c ? `<b>${esc(dailyCode(c))}</b> ${t === 'A' ? 'Air' : 'Sea'} · ${esc(c.client)} · ${esc(c.species)} · ${esc(c.containerNo)} → ${rowsFromContainer(c, '').length} row(s)`
    : `<div class="err">No ${t === 'A' ? 'air' : 'sea'} container with code ${esc(code)}. An empty row will be added.</div>`;
}
async function addRowFromDialog() {
  const code = $('#adCode').value.trim(), t = $('#adForm').querySelector('input[name="adT"]:checked').value;
  if (!code) { toast('Type a vessel code.', true); return; }
  const today = todayISO();
  const c = allByVessel(code).find(x => ckey(x)[0] === t);
  const st = c ? (c.salesStart === today ? 'OPENING TODAY' : 'FOLLOWING UP') : 'OPENING TODAY';
  const priced = c ? rowsWithPrices(c, today, st) : [];
  const rows = c ? (priced.length ? priced : rowsFromContainer(c, today, st)) : [{ status: st, transport: t, date: today, vesselCode: code.replace(/^[MA](?=\d)/i, ''), price: '' }];
  await addDaily(rows);
  $('#addDlg').hidden = true;
  state.df.date = new Set([fmt(today)]); renderDaily();
  toast(`${rows.length} row${rows.length === 1 ? '' : 's'} added for ${code} (${t === 'A' ? 'Air' : 'Sea'}).`);
}
function openTodayDialog() {
  if (!state.edit) { toast('Turn on Edit mode in Settings to add rows.'); return; }
  const dlg = $('#todayDlg');
  const open = state.containers.filter(c => { const s = stateOf(c); return !s.sold; }).sort((a, b) => (b.eta || '').localeCompare(a.eta || ''));
  $('#tdList').innerHTML = open.slice(0, 300).map(c => `<option value="${esc(dailyCode(c))}">${isAir(c) ? 'Air' : 'Sea'} · ${esc(c.client)} · ${esc(c.species)} · ${esc(c.containerNo)}</option>`).join('');
  $('#tdCodes').value = ''; $('#tdPreview').textContent = '';
  dlg.hidden = false; $('#tdCodes').focus();
}
// Codes are typed without letters; add "A" or "M" after a code (e.g. "0001 A" or "0001A") only when it exists as both.
function parseCodes(text) {
  const tokens = String(text).toUpperCase().replace(/(\d)\s+([AM])\b/g, '$1$2').split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const found = [], missing = [], both = [];
  for (const tok of [...new Set(tokens)]) {
    const m = /^([AM]?)(\d[\w-]*?)([AM]?)$/.exec(tok);
    const code = m ? m[2] : tok, t = m ? (m[1] || m[3]) : '';
    const hits = allByVessel(code).filter(c => !t || ckey(c)[0] === t);
    if (!hits.length) missing.push(tok);
    else if (hits.length > 1 && !t) both.push({ code, hits });
    else found.push(hits[0]);
  }
  return { found, missing, both };
}
function previewToday() {
  const { found, missing, both } = parseCodes($('#tdCodes').value);
  const n = found.reduce((a, c) => a + rowsFromContainer(c, '').length, 0);
  $('#tdPreview').innerHTML = (found.length ? `${found.length} container${found.length > 1 ? 's' : ''} → ${n} rows: ` + found.map(c => `<b>${esc(dailyCode(c))}</b> ${isAir(c) ? 'Air' : 'Sea'} · ${esc(c.client)} · ${esc(c.species)}`).join(', ') : '') +
    (both.length ? `<div class="err">${both.map(b => `<b>${esc(b.code)}</b> exists as Air and Sea: <button type="button" class="pick" data-code="${esc(b.code)}" data-t="A">Air</button> <button type="button" class="pick" data-code="${esc(b.code)}" data-t="M">Sea</button> <button type="button" class="pick" data-code="${esc(b.code)}" data-t="AM">Both</button>`).join('<br>')}</div>` : '') +
    (missing.length ? `<div class="err">Not found: ${missing.map(esc).join(', ')}</div>` : '');
}
function pickTransport(code, t) {
  const inp = $('#tdCodes');
  const re = new RegExp('(^|[\\s,;])' + code + '(?=$|[\\s,;])');
  inp.value = inp.value.toUpperCase().replace(re, (m0, pre) => pre + (t === 'AM' ? code + 'A ' + code + 'M' : code + t));
  previewToday();
}
async function startToday() {
  const today = todayISO();
  const { found, missing, both } = parseCodes($('#tdCodes').value);
  if (both.length) { toast(`Choose Air or Sea for ${both.map(b => b.code).join(', ')}.`, true); return; }
  const sig = d => [tOf(d.transport) || 'M', vkey(d.vesselCode), d.variety, d.netWeight, d.packType, d.label, d.category || '', d.size].join('|');
  const have = new Set(state.daily.filter(d => d.date === today).map(sig));
  const rows = [];
  for (const c of found) for (const r of rowsFromContainer(c, today)) if (!have.has(sig(r))) { rows.push(r); have.add(sig(r)); }
  let carried = 0; const fromDates = new Set();
  if ($('#tdCarry').checked) {
    const finished = d => { const c = byVessel(d.vesselCode, d.transport); return c && (stateOf(c).sold || !!c.salesEnd); };
    // Each container carries from its own most recent previous date with rows (not only yesterday).
    const lastDate = new Map();
    for (const d of state.daily) if (d.date && d.date < today && d.vesselCode) { const v = (tOf(d.transport) || 'M') + vkey(d.vesselCode); if (!lastDate.has(v) || d.date > lastDate.get(v)) lastDate.set(v, d.date); }
    const prevRows = state.daily.filter(d => d.date && d.vesselCode && d.date === lastDate.get((tOf(d.transport) || 'M') + vkey(d.vesselCode)));
    const soldOut = new Set(prevRows.filter(d => d.status === 'SOLD OUT').map(sig));
    for (const d of prevRows) {
      if (finished(d) || soldOut.has(sig(d)) || have.has(sig(d))) continue;
      const { id, ...rest } = d; rows.push({ ...rest, status: 'SELLING', date: today }); have.add(sig(d)); carried++; fromDates.add(d.date);
    }
  }
  if (!rows.length) { toast(missing.length ? `Vessel code not found: ${missing.join(', ')}` : 'Nothing new to add for today.'); return; }
  await addDaily(rows);
  $('#todayDlg').hidden = true;
  state.dDate = today; renderDaily();
  toast(`${rows.length - carried} OPENING rows added${carried ? ` and ${carried} SELLING rows carried over from ${[...fromDates].sort().map(fmt).join(', ')}` : ''}. Fill in the sales prices.${missing.length ? ` Not found: ${missing.join(', ')}` : ''}`);
}

// WeChat text: grouped by container, one line per size.
// ---------- Copy for WeChat: formal white report image (GESEX + Fruit Color) ----------
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
let logosP = null;
// The Fruit Color logo comes as a JPG with a light checkered background; turn the light grey/white pixels transparent.
function cleanGold(img) {
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height), p = d.data;
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let i = 0; i < p.length; i += 4) {
    const r = p[i], g = p[i + 1], b = p[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), sat = max ? (max - min) / max : 0;
    if (sat < 0.22) p[i + 3] = 0;
    else { const k = i / 4, px = k % c.width, py = (k - px) / c.width; minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
  }
  x.putImageData(d, 0, 0);
  const t = document.createElement('canvas'); t.width = maxX - minX + 1; t.height = maxY - minY + 1;
  t.getContext('2d').drawImage(c, minX, minY, t.width, t.height, 0, 0, t.width, t.height);
  return t;
}
function logos() {
  if (!logosP) logosP = Promise.all([loadImg('img/gesex.png'), loadImg('img/fruitcolor.jpg').then(cleanGold)]).catch(() => [null, null]);
  return logosP;
}

async function reportCanvas(rows) {
  const [gesex, fc] = await logos();
  const S = 2;                                     // draw at 2x for a sharp image
  const NAVY = '#0e3a6b', INK = '#1d2733', GREY = '#6b7785', LINE = '#d5dbe3', ZEBRA = '#f3f6fa';
  const FONT = '"Segoe UI", "IBM Plex Sans", Arial, sans-serif';
  const cols = DCOLS.map(c => c.t);
  const data = rows.map(r => DCOLS.map(c => c.date ? fmt(r[c.k]) : c.k === 'client' && isFC(r.client) ? 'FRUIT COLOR' : c.k === 'vesselName' ? (byVessel(r.vesselCode, r.transport)?.vesselName || '') : String(r[c.k] ?? '')));
  const m = document.createElement('canvas').getContext('2d');
  m.font = `600 12px ${FONT}`; const hw = cols.map(t => m.measureText(t).width);
  m.font = `13px ${FONT}`;
  const cw = cols.map((t, i) => Math.ceil(Math.max(hw[i], ...data.map(r => m.measureText(r[i]).width)) + 20));
  const pad = 22, rowH = 26, headH = 30, tableW = cw.reduce((a, b) => a + b, 0);
  const logoH = 46;
  const gW = gesex ? gesex.naturalWidth * logoH / gesex.naturalHeight : 0;
  const fW = fc ? fc.width * logoH / fc.height : 0;
  const W = Math.max(tableW, 420 + gW + fW) + pad * 2;
  const top = pad + logoH + 14;
  const H = top + 4 + headH + rowH * data.length + 52 + pad;
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const x = cv.getContext('2d'); x.scale(S, S);
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  // title block
  const dates = [...new Set(rows.map(r => r.date).filter(Boolean))].sort();
  x.fillStyle = NAVY; x.font = `700 21px ${FONT}`; x.textBaseline = 'alphabetic';
  x.fillText('DAILY SALES REPORT', pad, pad + 22);
  x.fillStyle = GREY; x.font = `13px ${FONT}`;
  x.fillText(`Date: ${dates.map(fmt).join(', ') || fmt(todayISO())}   ·   ${rows.length} row${rows.length === 1 ? '' : 's'}`, pad, pad + 42);
  // logos on the right
  let lx = W - pad;
  if (fc) { lx -= fW; x.drawImage(fc, lx, pad, fW, logoH); lx -= 14; }
  if (gesex) { lx -= gW; x.drawImage(gesex, lx, pad, gW, logoH); }
  x.fillStyle = NAVY; x.fillRect(pad, top - 6, W - pad * 2, 3);
  // table header
  let y = top + 4, cx = pad;
  x.fillStyle = NAVY; x.fillRect(pad, y, tableW, headH);
  x.font = `600 12px ${FONT}`; x.fillStyle = '#fff'; x.textBaseline = 'middle';
  cols.forEach((t, i) => { x.fillText(t, cx + 10, y + headH / 2); cx += cw[i]; });
  y += headH;
  // rows
  x.font = `13px ${FONT}`;
  data.forEach((r, ri) => {
    if (ri % 2) { x.fillStyle = ZEBRA; x.fillRect(pad, y, tableW, rowH); }
    cx = pad;
    r.forEach((v, i) => {
      const isPrice = i === r.length - 1;
      x.fillStyle = INK; x.font = `${isPrice ? '600 ' : ''}13px ${FONT}`;
      if (isPrice) { x.textAlign = 'right'; x.fillText(v, cx + cw[i] - 10, y + rowH / 2); x.textAlign = 'left'; }
      else x.fillText(v, cx + 10, y + rowH / 2);
      cx += cw[i];
    });
    y += rowH;
  });
  // grid lines
  x.strokeStyle = LINE; x.lineWidth = 1;
  for (let i = 0; i <= data.length; i++) { const yy = top + 4 + headH + i * rowH + .5; x.beginPath(); x.moveTo(pad, yy); x.lineTo(pad + tableW, yy); x.stroke(); }
  cx = pad;
  for (let i = 0; i <= cw.length; i++) { const xx = Math.round(cx) + .5; x.beginPath(); x.moveTo(xx, top + 4); x.lineTo(xx, y); x.stroke(); cx += cw[i] || 0; }
  // confidentiality notice
  x.textBaseline = 'alphabetic'; x.fillStyle = GREY; x.font = `11px ${FONT}`;
  x.fillText('Prices in RMB per box.', pad, y + 22);
  x.font = `italic 10.5px ${FONT}`;
  x.fillText('CONFIDENTIAL · Internal office information of Fruit Color – GESEX. For internal use only.', pad, y + 40);
  return cv;
}

async function copyReportImage(rows) {
  const cv = await reportCanvas(rows);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return 'copied';
  } catch {
    // Phones or browsers that cannot copy images: save the picture instead.
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `Daily Sales ${todayISO()}.png`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return 'saved';
  }
}

function wechatText(rows) {
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const lines = [`GESEX · DAILY SALES 每日销售 · ${dates.map(fmt).join(', ')}`, ''];
  const groups = new Map();
  for (const r of rows) {
    const k = [r.date, r.status, r.vesselCode, r.client, r.market, r.species].join('|');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [, g] of groups) {
    const h = g[0];
    lines.push(`【${h.status || '-'}】 Vessel ${h.vesselCode || '-'} · ${h.client || '-'} · ${h.market || '-'} · ${h.species || '-'}${dates.length > 1 ? ' · ' + fmt(h.date) : ''}`);
    const sub = new Map();
    for (const r of g) { const k = [r.variety, r.netWeight, r.packType, r.label].filter(Boolean).join(' / '); if (!sub.has(k)) sub.set(k, []); sub.get(k).push(r); }
    for (const [k, rs] of sub) {
      lines.push(`  ${k || '-'}`);
      lines.push('  ' + rs.sort((a, b) => String(a.size).localeCompare(String(b.size), undefined, { numeric: true })).map(r => `Size ${r.size || '-'}: ${r.price || '-'}`).join(' | '));
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

// ---------- commands ----------
const LABELS = Object.fromEntries(CCOLS.map(c => [c.k, c.t]));
async function runCommand(text) {
  const log = $('#cmdLog');
  if (!state.edit) { toast('Turn on Edit mode in Settings to use Commands.'); return; }
  const r = KuaiCommands.interpret(text, state.containers);
  const entry = document.createElement('div');
  if (r.error) {
    entry.className = 'entry err';
    entry.innerHTML = `<div class="said">› ${esc(text)}</div><div>${esc(r.error)}</div>`;
    log.prepend(entry); return;
  }
  const undo = [];
  const lines = [];
  for (const c of r.targets) {
    const before = {};
    for (const k of Object.keys(r.changes)) before[k] = c[k] ?? '';
    if (r.changes.status) r.changes.status = enStatus(r.changes.status);
    const ok = await patchContainer(c, r.changes);
    if (!ok) continue;
    undo.push([c, before]);
    lines.push(`<div class="chg">${esc(c.containerNo)} <span class="said">(${esc(c.vesselCode)} · ${esc(c.vesselName)})</span></div>` +
      Object.entries(r.changes).map(([k, v]) => `<div class="chg">&nbsp;&nbsp;${LABELS[k]}: <span class="said">${esc(CCOLS.find(x => x.k === k)?.date ? fmt(before[k]) : before[k]) || '—'}</span> → <b>${esc(CCOLS.find(x => x.k === k)?.date ? fmt(v) : v)}</b></div>`).join(''));
  }
  entry.className = 'entry';
  entry.innerHTML = `<div class="said">› ${esc(text)}</div>${lines.join('')}<button type="button">Undo</button>`;
  entry.querySelector('button').onclick = async e => {
    for (const [c, before] of undo) await patchContainer(c, before);
    e.target.replaceWith(Object.assign(document.createElement('div'), { className: 'said', textContent: 'Undone.' }));
    renderContainers();
  };
  log.prepend(entry);
  renderContainers();
  for (const [c] of undo) {
    const tr = $(`#ctable tr[data-key="${c.key}"]`);
    if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); Object.keys(r.changes).forEach(k => tr.querySelector(`td[data-k="${k}"]`)?.classList.add('flash')); }
  }
}

// ---------- save ----------
function showLastSave() {
  const el = $('#lastSave');
  if (!state.lastSave) { el.textContent = 'Not saved yet'; return; }
  const d = new Date(state.lastSave.at);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Last saved: ${day} · ${time}${state.lastSave.reason && state.lastSave.reason !== 'manual' ? ' (auto)' : ''}`;
}

// ---------- events ----------
function bind() {
  $$('.tab').forEach(b => b.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.toggle('on', x === b));
    closeBoxes();
    $('#tab-containers').hidden = b.dataset.tab !== 'containers';
    $('#tab-daily').hidden = b.dataset.tab !== 'daily';
    $('#tab-total').hidden = b.dataset.tab !== 'total';
    b.dataset.tab === 'daily' ? renderDaily() : b.dataset.tab === 'total' ? renderTotal() : renderContainers();
  }));
  let qt;
  $('#q').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); renderContainers(); if (!$('#tab-daily').hidden) renderDaily(); if (!$('#tab-total').hidden) renderTotal(); }, 120); });
  $('#tRefresh').addEventListener('click', async () => { await load(); renderTotal(); toast('Total Sales updated.'); });
  $('#tExport').addEventListener('click', () => {
    const rows = allSales().sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.vesselCode).localeCompare(String(b.vesselCode)) || bySize(a.size, b.size));
    // every sale and every column, with the vs Best Sale comparison
    const best = r => { const o = isFC(r.client) ? vsBest(r) : null; return o ? [o.diff, `${o.best.price} ${o.best.client} ${o.best.vesselCode} ${fmt(o.best.date)}`] : ['', '']; };
    downloadCSV(`Total Sales ${fmt(todayISO())}.csv`, [...TCOLS.map(c => c.t), 'vs Best Sale (RMB)', 'Best Sale of the Same Fruit'], rows.map(r => [...TCOLS.map(c => c.date ? fmt(r[c.k]) : r[c.k]), ...best(r)]));
    toast(`Exported ${rows.length} sales to "Total Sales ${fmt(todayISO())}.csv" (Downloads).`);
  });
  // Chile: fixed columns; any Fruit Color client is written as FRUIT COLOR
  // Chile: tab "Total Sales" (every Total Sales column, no vs Best Sale) and tab "Tracking" (every Tracking column except
  // Survey, Claim and Comments; Opening Prices = the first day with prices). Fruit Color clients are written as FRUIT COLOR.
  $('#tExportCL').addEventListener('click', () => {
    const fc = v => isFC(v) ? 'FRUIT COLOR' : v;
    const rows = allSales().sort((a, b) => (b.date || '').localeCompare(a.date || '') || String(a.vesselCode).localeCompare(String(b.vesselCode)) || bySize(a.size, b.size));
    const sales = [TCOLS.map(c => c.t), ...rows.map(r => TCOLS.map(c => c.date ? fmt(r[c.k]) : c.k === 'client' ? fc(r.client) : r[c.k] ?? ''))];
    const tcols = CCOLS.filter(c => !['survey', 'claim', 'comments', 'etaDiff'].includes(c.k));
    const conts = state.containers.slice().sort((a, b) => (b.eta || '').localeCompare(a.eta || ''));
    const track = [tcols.map(c => c.t), ...conts.map(c => tcols.map(col => col.k === 'client' ? fc(c.client) : col.k === 'openingPrices' ? (firstPrices(c)?.text || '') : trackingVal(c, col)))];
    const name = `Total Sales Chile ${fmt(todayISO())}.xlsx`;
    downloadXLSX(name, [['Total Sales', sales], ['Tracking', track]]);
    toast(`Exported ${rows.length} sales and ${conts.length} containers to "${name}" (Downloads).`);
  });
  // Containers: every container (filters ignored), every column; Opening Prices = all days in one cell
  $('#cExport').addEventListener('click', () => {
    const list = state.containers.slice().sort((a, b) => (b.eta || '').localeCompare(a.eta || ''));
    const val = trackingVal;
    downloadCSV(`Containers ${fmt(todayISO())}.csv`, CCOLS.map(c => c.t), list.map(c => CCOLS.map(col => val(c, col))));
    toast(`Exported ${list.length} containers to "Containers ${fmt(todayISO())}.csv" (Downloads).`);
  });
  $('#ttable thead').addEventListener('click', e => {
    const th = e.target.closest('th'); const k = th?.dataset.col; if (!k) return;
    if (fpop && fpop.dataset.key === 't' + k) { closeFilter(); return; }
    const items = state._tbase.filter(d => passes(state.tf, kk => dVal(d, kk), k));
    openFilter(th, 't', k, TCOLS.find(c => c.k === k).t, items, (d, kk) => dVal(d, kk));
    fpop.dataset.key = 't' + k;
  });
  $('#qresults').addEventListener('click', e => {
    const k = e.target.closest('[data-goto]')?.dataset.goto; if (!k) return;
    state.open.add(k); state.chip = 'all';
    $$('.tab')[0].click();
    const tr = $(`#ctable tr[data-key="${k}"]`); tr?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  $('#chips').addEventListener('click', e => { const k = e.target.closest('[data-chip]')?.dataset.chip; if (k) { state.chip = k; renderContainers(); } });
  $('#rail').addEventListener('click', e => {
    const b = e.target.closest('.sp'); if (!b) return;
    const k = b.dataset.sp || null; state.species = state.species === k ? null : k;
    $$('.tab')[0].click();
  });
  $('#ctable thead').addEventListener('click', e => {
    const th = e.target.closest('th'); const k = th?.dataset.col; if (!k) return;
    if (fpop && fpop.dataset.key === 'c' + k) { closeFilter(); return; }
    const { base, chipFn } = state._cbase;
    const items = base.filter(x => chipFn(x.s) && passes(state.cf, kk => cVal(x.c, x.s, kk), k));
    openFilter(th, 'c', k, CCOLS.find(c => c.k === k).t, items, (x, kk) => cVal(x.c, x.s, kk));
    fpop.dataset.key = 'c' + k;
  });
  $('#ctable tbody').addEventListener('click', e => {
    const tr = e.target.closest('tr.c'); if (!tr) return;
    const c = state.containers.find(x => x.key === tr.dataset.key); if (!c) return;
    const td = e.target.closest('td');
    if (td?.classList.contains('ed') && state.edit) { startEdit(td, c); return; }
    if (td?.classList.contains('editing')) return;
    state.open.has(c.key) ? state.open.delete(c.key) : state.open.add(c.key);
    renderContainers();
  });

  // upload
  $('#file').addEventListener('change', async e => {
    const files = [...e.target.files]; e.target.value = '';
    for (const f of files) {
      try {
        toast(`Reading ${f.name}…`);
        const preview = await api('/api/import?dry=1', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
        showUploadSummary(f.name, preview);
        const go = await new Promise(res => { upDecide = res; });
        if (!go) { toast(`${f.name}: cancelled. Nothing was loaded.`); continue; }
        const r = await api('/api/import', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
        await load();
        toast(`${f.name}: loaded. ${(r.newCodes || []).length} new vessel codes added.`);
      } catch (err) { toast(`${f.name}: ${err.message}`, true); }
    }
  });

  // save
  $('#saveBtn').addEventListener('click', async () => {
    try { state.lastSave = await api('/api/save', { method: 'POST' }); showLastSave(); $('#lastSave').classList.add('fresh'); toast('Saved. Both tables were written as CSV to the Saves folder.'); }
    catch (e) { toast('Save failed: ' + e.message, true); }
  });

  // daily
  $('#dImport').addEventListener('click', () => importContainers().catch(err => toast(err.message, true)));
  $('#adCancel').addEventListener('click', () => $('#addDlg').hidden = true);
  $('#adCode').addEventListener('input', previewAdd);
  $('#adForm').addEventListener('change', previewAdd);
  $('#adForm').addEventListener('submit', e => { e.preventDefault(); addRowFromDialog().catch(err => toast(err.message, true)); });
  $('#upOk').addEventListener('click', () => { $('#upDlg').hidden = true; upDecide?.(true); upDecide = null; });
  $('#upCancel').addEventListener('click', () => { $('#upDlg').hidden = true; upDecide?.(false); upDecide = null; });

  $('#dAdd').addEventListener('click', () => {
    if (!state.edit) { toast('Turn on Edit mode in Settings to add rows.'); return; }
    $('#adCode').value = ''; $('#adPreview').textContent = ''; $('#addDlg').hidden = false; $('#adCode').focus();
  });
  $('#dtable thead').addEventListener('click', e => {
    const th = e.target.closest('th'); const k = th?.dataset.col; if (!k) return;
    if (fpop && fpop.dataset.key === 'd' + k) { closeFilter(); return; }
    const items = state._dbase.filter(d => passes(state.df, kk => dVal(d, kk), k));
    openFilter(th, 'd', k, DCOLS.find(c => c.k === k).t, items, (d, kk) => dVal(d, kk));
    fpop.dataset.key = 'd' + k;
  });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-clear],[data-clearall]'); if (!b) return;
    const t = b.dataset.table || b.dataset.clearall; const f = t === 'c' ? state.cf : t === 't' ? state.tf : state.df;
    if (b.dataset.clearall) { Object.keys(f).forEach(k => f[k] = null); if (t === 'c') { state.chip = 'all'; state.species = null; state.ssDay = null; ssLabel(); } } else f[b.dataset.clear] = null;
    t === 'c' ? renderContainers() : t === 't' ? renderTotal() : renderDaily();
  });
  $('#dtable').addEventListener('click', async e => {
    if (e.target.id === 'dAll') {
      const ids = $$('#dtable tbody tr').map(tr => +tr.dataset.id);
      e.target.checked ? ids.forEach(i => state.dSel.add(i)) : ids.forEach(i => state.dSel.delete(i));
      renderDaily(); return;
    }
    const tr = e.target.closest('tbody tr'); if (!tr) return;
    const r = state.daily.find(d => d.id === +tr.dataset.id); if (!r) return;
    if (e.target.matches('input[type=checkbox]')) { e.target.checked ? state.dSel.add(r.id) : state.dSel.delete(r.id); renderDaily(); return; }
    if (e.target.dataset.del) {
      if (!state.edit) { toast('Turn on Edit mode in Settings to delete rows.'); return; }
      await api('/api/daily/' + r.id, { method: 'DELETE' });
      state.daily = state.daily.filter(d => d.id !== r.id); state.dSel.delete(r.id); renderDaily(); return;
    }
    const td = e.target.closest('td.ed'); if (td && state.edit) startDailyEdit(td, r);
  });
  $('#dCopy').addEventListener('click', async () => {
    const rows = state.daily.filter(d => state.dSel.has(d.id)).sort((a, b) => String(a.vesselCode).localeCompare(String(b.vesselCode)));
    $('#dCopy').disabled = true;
    try {
      const how = await copyReportImage(rows);
      toast(how === 'copied' ? `Image with ${rows.length} rows copied. Paste it in WeChat with Ctrl+V.` : `Image with ${rows.length} rows saved. Send it in WeChat as a picture.`);
    } catch (e) { toast('Could not create the image: ' + e.message, true); }
    finally { $('#dCopy').disabled = !state.dSel.size; }
  });
  $('#dDel').addEventListener('click', async e => {
    const b = e.currentTarget;
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = `Confirm delete (${state.dSel.size})`; return; }
    for (const id of state.dSel) { await api('/api/daily/' + id, { method: 'DELETE' }); }
    state.daily = state.daily.filter(d => !state.dSel.has(d.id)); state.dSel.clear(); renderDaily();
  });

  // commands drawer

  // settings
  const openSet = open => { $('#settings').hidden = !open; $('#setBtn').setAttribute('aria-expanded', open); };
  $('#setBtn').addEventListener('click', e => { e.stopPropagation(); openSet($('#settings').hidden); });
  document.addEventListener('click', e => { if (!$('#settings').hidden && !e.target.closest('#settings')) openSet(false); });
  $('#editSwitch').addEventListener('click', () => { setEdit(!state.edit); toast(state.edit ? 'Edit mode ON: cells can be edited.' : 'Edit mode OFF: tables are locked.'); });

  // phone link settings (PC only)
  const showPub = p => {
    const st = $('#pubStatus'); st.className = 'pub-status';
    const t = p.status?.at ? new Date(p.status.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    $('#pubToken').placeholder = p.hasToken ? 'GitHub token saved (paste a new one to replace it)' : 'GitHub token (github_pat_…)';
    if (!p.hasToken || !p.hasPassword) st.textContent = 'Not set up yet. Paste the GitHub token, choose a password and press Save & publish.';
    else if (p.status?.state === 'error') { st.classList.add('err'); st.textContent = 'Last publish failed: ' + p.status.error; }
    else if (p.status?.state === 'publishing') st.textContent = 'Publishing…';
    else if (!p.enabled) st.textContent = 'Publishing is OFF.';
    else { st.classList.add('ok'); st.textContent = t ? 'Published ' + t + '. It updates within 10 minutes of any change.' : 'Waiting for the first publish…'; }
    $('#pubLinkRow').hidden = !p.link || !p.hasPassword; $('#pubLink').textContent = p.link;
    const sw = $('#pubSwitch'); sw.setAttribute('aria-checked', !!p.enabled); sw.querySelector('.lbl').textContent = p.enabled ? 'ON' : 'OFF';
  };
  const refreshPub = () => api('/api/publish').then(showPub).catch(() => { $('#pubBox').hidden = true; });
  $('#setBtn').addEventListener('click', refreshPub);
  $('#pubSave').addEventListener('click', async () => {
    const pw = $('#pubPw').value, token = $('#pubToken').value.trim();
    if (pw && pw.length < 6) { toast('Use at least 6 characters.', true); return; }
    $('#pubStatus').textContent = 'Publishing…';
    try { const p = await api('/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, ...(pw ? { password: pw } : {}), ...(token ? { token } : {}) }) }); $('#pubPw').value = ''; $('#pubToken').value = ''; showPub(p); }
    catch (e) { toast(e.message, true); }
  });
  $('#pubSwitch').addEventListener('click', async () => {
    const on = $('#pubSwitch').getAttribute('aria-checked') !== 'true';
    try { showPub(await api('/api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) })); } catch (e) { toast(e.message, true); }
  });
  $('#pubCopy').addEventListener('click', async () => { const ok = await copyText($('#pubLink').textContent); toast(ok ? 'Link copied.' : 'Select the link and copy it.'); });

  // status suggestions
  const dl = document.createElement('datalist'); dl.id = 'statusList';
  dl.innerHTML = ['SOLD', 'IN PROCESS', 'IN TRANSIT', 'ARRIVED', 'UNDER INSPECTION', 'ON HOLD'].map(v => `<option value="${v}">`).join('');
  document.body.appendChild(dl);
}

// ---------- phone link (github.io): encrypted snapshot, decrypted here with the password ----------
const REMOTE = location.protocol === 'https:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decryptSnapshot(enc, password) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(enc.salt), iterations: enc.iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const gz = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(enc.iv) }, key, b64(enc.data));
  const text = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
  return JSON.parse(text);
}
function askPassword(msg) {
  return new Promise(resolve => {
    $('#gate').hidden = false; $('#gateErr').hidden = !msg; $('#gateErr').textContent = msg || '';
    $('#gatePw').value = ''; $('#gatePw').focus();
    $('#gateForm').onsubmit = e => { e.preventDefault(); const v = $('#gatePw').value; if (v) { $('#gate').hidden = true; resolve(v); } };
  });
}
async function loadRemote() {
  let enc, offline = false;
  try {
    const r = await fetch('data/snapshot.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    enc = await r.json();
    try { localStorage.setItem('kt-enc', JSON.stringify(enc)); } catch { }
  } catch (e) {
    try { enc = JSON.parse(localStorage.getItem('kt-enc')); } catch { }
    if (!enc) throw new Error('Could not load the data. Check your internet or VPN.');
    offline = true;
  }
  let pw = null; try { pw = localStorage.getItem('kt-pw'); } catch { }
  let msg = null;
  for (;;) {
    if (!pw) pw = await askPassword(msg);
    try {
      const s = await decryptSnapshot(enc, pw);
      try { localStorage.setItem('kt-pw', pw); } catch { }
      s.viewOnly = true;
      return { s, offline };
    } catch { pw = null; try { localStorage.removeItem('kt-pw'); } catch { } msg = 'Wrong password. Try again.'; }
  }
}

// Phone / other devices get a view-only copy. The last data received is kept on the device,
// so search keeps working even if the PC cannot be reached for a while.
// Upload summary window: how many new vessels and new vessel codes (= containers / bookings) were added.
let upDecide = null;
function showUploadSummary(name, r) {
  const codes = r.newCodes || [];
  const nv = (r.newVessels || []).length;
  $('#upTitle').textContent = name;
  $('#upBody').innerHTML = `
    <div class="up-nums">
      <div><b>${nv}</b><span>new vessel${nv === 1 ? '' : 's'}</span></div>
      <div><b>${codes.length}</b><span>new vessel code${codes.length === 1 ? '' : 's'}<br>(containers / bookings)</span></div>
      <div><b>${codes.filter(c => /^A/i.test(c.transport)).length} / ${codes.filter(c => !/^A/i.test(c.transport)).length}</b><span>new Air / new Sea</span></div>
      <div class="muted"><b>${r.skipped || 0}</b><span>already in the list<br>will not change${r.oldCodes ? ` (${r.oldCodes.air} Air / ${r.oldCodes.sea} Sea)` : ''}</span></div>
    </div>
    ${r.inFile ? `<p class="up-sub">In this file: <b>${r.inFile.air}</b> Air (by Booking) and <b>${r.inFile.sea}</b> Sea (by container number).</p>` : ''}
    ${(r.noId || []).length ? `<p class="up-sub err">⚠ ${r.noId.length} vessel code${r.noId.length > 1 ? 's have' : ' has'} no ${r.noId.some(x => /^A/i.test(x.transport)) ? 'booking' : 'container number'} in the file and ${r.noId.length > 1 ? 'were' : 'was'} identified by vessel code: ${r.noId.map(x => `<b>${esc(x.code)}</b> ${/^A/i.test(x.transport) ? 'Air' : 'Sea'} (${esc(x.vessel)})`).join(', ')}. Add the ${r.noId.some(x => /^A/i.test(x.transport)) ? 'booking' : 'number'} by hand when you have it.</p>` : ''}
    ${nv ? `<p class="up-sub">New vessels: ${r.newVessels.map(esc).join(', ')}</p>` : ''}
    ${codes.length ? `<div class="up-list">${codes.map(c => `<div><span>${esc(c.code)}</span><span>${esc(c.id)}</span><span>${c.transport === 'A' ? 'Air' : 'Sea'}</span><span>${esc(c.vessel)}</span></div>`).join('')}</div>` : ''}
    ${r.detailAdded ? `<p class="up-sub">Box detail added to ${r.detailAdded} container${r.detailAdded === 1 ? '' : 's'} that had none.</p>` : ''}
    ${r.daily ? `<p class="up-sub">${r.daily} Daily Sales rows added.</p>` : ''}
    ${!codes.length && !r.daily && !r.detailAdded ? '<p class="up-sub">Nothing new in this file: every vessel code was already in the list.</p>' : ''}`;
  $('#upDlg').hidden = false;
}

async function load() {
  let s, offline = false;
  if (REMOTE) { ({ s, offline } = await loadRemote()); }
  else try {
    s = await api('/api/state');
    if (s.viewOnly) { try { localStorage.setItem('kt-cache', JSON.stringify(s)); } catch { } }
  } catch (e) {
    let cached = null; try { cached = JSON.parse(localStorage.getItem('kt-cache')); } catch { }
    if (!cached) throw e;
    s = cached; offline = true;
  }
  state.viewOnly = !!s.viewOnly;
  if (state.viewOnly) {
    document.body.classList.add('viewer');
    if (matchMedia('(pointer: coarse)').matches || innerWidth < 900) phoneMode();
    state.edit = false; document.body.classList.remove('locked');
    const b = $('#viewBadge'); b.hidden = false; b.classList.toggle('off', offline);
    const t = s.at ? new Date(s.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    b.textContent = offline ? `OFFLINE · data from ${t}` : `VIEW ONLY · updated ${t}`;
  }
  state.containers = s.containers; state.history = s.history || []; state.weather = s.weather || state.weather; state.daily = (s.daily || []).map(d => d.status ? { ...d, status: dailyStatus(d.status) } : d); state.lastSave = s.lastSave;
  showLastSave(); renderContainers(); if (!$('#tab-daily').hidden) renderDaily();
}

bind();
setEdit(state.edit);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
load().catch(e => toast(REMOTE ? e.message : 'Could not reach the Kuai Tracking server. Open "Start Kuai Tracking". ' + e.message, true));
// refresh "arriving soon" and the last-save label (scheduled saves happen on the server)
setInterval(() => { if (state.viewOnly && !document.querySelector('td.editing')) load().catch(() => { }); }, REMOTE ? 5 * 60000 : 60000);
setInterval(async () => { if (state.viewOnly) return; try { const s = await api('/api/state'); if (s.lastSave?.at !== state.lastSave?.at) { state.lastSave = s.lastSave; showLastSave(); } } catch { } }, 60000);
setInterval(() => { if (!document.querySelector('td.editing')) renderContainers(); }, 10 * 60000);

// ---------- Excel-style keys: arrows move between cells, Ctrl+C / Ctrl+V copy and paste ----------
// Paste only between cells of the same kind: date -> date, text -> text (numbers into number cells).
state.sel = null;          // { t: 'c' | 'd', id, k }
state.clip = null;         // { value, kind }
const tableOf = t => t === 'c' ? '#ctable' : '#dtable';
const rowSel = t => t === 'c' ? 'tbody tr.c' : 'tbody tr[data-id]';
const rowIdOf = (t, tr) => t === 'c' ? tr.dataset.key : tr.dataset.id;
function markSel() {
  document.querySelectorAll('td.selcell').forEach(x => x.classList.remove('selcell'));
  const s = state.sel; if (!s) return;
  const tr = document.querySelector(`${tableOf(s.t)} ${s.t === 'c' ? `tr.c[data-key="${CSS.escape(s.id)}"]` : `tr[data-id="${CSS.escape(String(s.id))}"]`}`);
  tr?.querySelector(`td[data-k="${CSS.escape(s.k)}"]`)?.classList.add('selcell');
}
function selectCell(td) {
  const tr = td.closest('tr'); const t = td.closest('#ctable') ? 'c' : td.closest('#dtable') ? 'd' : null;
  if (!t || !td.dataset.k) return;
  state.sel = { t, id: rowIdOf(t, tr), k: td.dataset.k };
  markSel();
}
const colDef = (t, k) => (t === 'c' ? CCOLS : DCOLS).find(c => c.k === k);
const kindOf = (t, k) => colDef(t, k)?.date ? 'date' : colDef(t, k)?.n ? 'number' : 'text';
const recOf = s => s.t === 'c' ? state.containers.find(c => c.key === s.id) : state.daily.find(d => String(d.id) === String(s.id));
function cellValue(s) {
  const rec = recOf(s); if (!rec) return '';
  if (s.t === 'c' && s.k === 'pct') return pctSold(rec);
  if (s.t === 'c' && s.k === 'etaDiff') return etaDiffText(rec);
  if (s.t === 'c' && s.k === 'status') return rec.status || stateOf(rec).auto;
  return rec[s.k] ?? '';
}
// read a pasted text as a date (dd-mm-yyyy, dd/mm/yyyy or yyyy-mm-dd)
function asISO(v) {
  const t = String(v || '').trim();
  if (isISO(t)) return t;
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}
async function pasteInto(s, clip) {
  if (!state.edit) { toast('Turn on Edit mode in Settings to paste.', true); return; }
  const td = document.querySelector(`${tableOf(s.t)} td.selcell`);
  const rec = recOf(s);
  if (!td || !rec || !td.classList.contains('ed')) { toast('This cell cannot be edited.', true); return; }
  if (s.t === 'c' && s.k === 'openingPrices') { toast('Opening Prices are entered in their own box (click the cell).', true); return; }
  if (s.t === 'c' && s.k === 'pct') { toast('Pallets sold per day are entered in their own box (click the cell).', true); return; }
  const want = kindOf(s.t, s.k);
  if (want !== clip.kind && !(want === 'text' && clip.kind === 'number')) {
    toast(`Cannot paste: you copied a ${clip.kind} and this cell is a ${want} cell.`, true); return;
  }
  let v = String(clip.value ?? '');
  if (want === 'number' && !/^-?\d+([.,]\d+)?$/.test(v.trim())) { toast('Cannot paste: this cell needs a number.', true); return; }
  if (s.t === 'c') {
    if (s.k === 'status') v = enStatus(v); else if (s.k === 'salesCity' || s.k === 'client') v = v.toUpperCase();
    if (await patchContainer(rec, { [s.k]: v })) { renderContainers(); toast('Pasted.'); }
  } else {
    if (s.k === 'netWeight') v = kgUI(v); else if (s.k !== 'date') v = s.k === 'status' ? enStatus(v) : v.toUpperCase();
    try { Object.assign(rec, await api('/api/daily/' + rec.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [s.k]: v }) })); renderDaily(); toast('Pasted.'); }
    catch (e) { toast('Could not paste: ' + e.message, true); }
  }
}
document.addEventListener('click', e => { const td = e.target.closest('#ctable td[data-k], #dtable td[data-k]'); if (td) selectCell(td); }, true);
document.addEventListener('keydown', async e => {
  const s = state.sel; if (!s) return;
  const a = document.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;          // typing in a cell or a box
  if (document.querySelector('.fpop, .opbox') || [...document.querySelectorAll('.dlg-wrap')].some(d => !d.hidden)) return;
  const table = document.querySelector(tableOf(s.t));
  if (!table || table.closest('[hidden]')) return;
  const td = table.querySelector('td.selcell'); if (!td) return;
  const key = e.key;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
    e.preventDefault();
    const rows = [...table.querySelectorAll(rowSel(s.t))];
    const tr = td.closest('tr'); let ri = rows.indexOf(tr);
    const cells = [...tr.querySelectorAll('td[data-k]')]; let ci = cells.indexOf(td);
    if (key === 'ArrowUp') ri = Math.max(0, ri - 1);
    if (key === 'ArrowDown') ri = Math.min(rows.length - 1, ri + 1);
    if (key === 'ArrowLeft') ci = Math.max(0, ci - 1);
    if (key === 'ArrowRight') ci = Math.min(cells.length - 1, ci + 1);
    const k = (rows[ri] === tr ? cells[ci] : [...rows[ri].querySelectorAll('td[data-k]')][ci])?.dataset.k || s.k;
    state.sel = { t: s.t, id: rowIdOf(s.t, rows[ri]), k };
    markSel();
    table.querySelector('td.selcell')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  if ((key === 'Enter' || key === 'F2') && td.classList.contains('ed') && state.edit) {
    e.preventDefault();
    if (s.t === 'c') startEdit(td, recOf(s)); else startDailyEdit(td, recOf(s));
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'c') {
    e.preventDefault();
    const value = cellValue(s);
    state.clip = { value, kind: kindOf(s.t, s.k) };
    try { await navigator.clipboard.writeText(colDef(s.t, s.k)?.date ? fmt(value) : String(value)); } catch { }
    toast(`Copied: ${colDef(s.t, s.k)?.date ? fmt(value) : value || '(empty)'}`);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'v') {
    e.preventDefault();
    let clip = state.clip;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const mine = clip && (clip.kind === 'date' ? fmt(clip.value) : String(clip.value)) === text;
      if (text && !mine) clip = asISO(text) ? { value: asISO(text), kind: 'date' } : /^-?\d+([.,]\d+)?$/.test(text) ? { value: text, kind: 'number' } : { value: text, kind: 'text' };
    } catch { }
    if (!clip) { toast('Nothing copied yet. Select a cell and press Ctrl+C.', true); return; }
    await pasteInto(s, clip);
  }
});
// keep the selected cell highlighted after the tables are redrawn
{ const _rc = renderContainers, _rd = renderDaily;
  renderContainers = function (...a) { const r = _rc.apply(this, a); markSel(); return r; };
  renderDaily = function (...a) { const r = _rd.apply(this, a); markSel(); return r; }; }

// ---------- floating boxes: drag them by the title or an edge; switching tab closes them without saving ----------
function closeBoxes() {
  document.querySelectorAll('.opbox').forEach(b => b.remove());
  document.querySelectorAll('td.editing').forEach(td => td.classList.remove('editing'));
  closeFilter();
  document.querySelectorAll('.dlg-wrap').forEach(d => { if (d.id !== 'upDlg') d.hidden = true; });
  if (tipEl) tipEl.hidden = true;
}
document.addEventListener('mousedown', e => {
  const box = e.target.closest('.opbox, .fpop, .dlg');
  if (!box || e.button !== 0) return;
  const rc = box.getBoundingClientRect(), edge = 10;
  const onEdge = e.clientX - rc.left < edge || rc.right - e.clientX < edge || e.clientY - rc.top < edge || rc.bottom - e.clientY < edge;
  const onHead = !!e.target.closest('.op-head, .fp-head, .dlg-title, .op-date > :not(select)') && !e.target.closest('input, select, button');
  if (!onEdge && !onHead) return;
  e.preventDefault();
  if (getComputedStyle(box).position !== 'fixed') { box.style.position = 'fixed'; box.style.margin = '0'; }
  const dx = e.clientX - rc.left, dy = e.clientY - rc.top;
  box.style.left = rc.left + 'px'; box.style.top = rc.top + 'px'; box.style.transform = 'none';
  box.classList.add('dragging');
  const move = ev => {
    box.style.left = Math.min(innerWidth - 40, Math.max(-rc.width + 60, ev.clientX - dx)) + 'px';
    box.style.top = Math.min(innerHeight - 30, Math.max(0, ev.clientY - dy)) + 'px';
  };
  const up = () => { box.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
});


// =====================================================================================
// Side panels: Cherry Program · Load Allocation · Comparison (Total Sales)
// =====================================================================================
// Fruit Color clients and how many containers each one gets this season
const PROGRAM = [
  { name: 'SHUNFA', target: 15, alias: ['SHUNFA', 'SHUN FA'] },
  { name: 'YUEHAO', target: 25, alias: ['YUEHAO', 'YUE HAO'] },
  { name: 'ZHONGXING', target: 15, alias: ['ZHONGXING', 'ZHONG XING', 'ZHXING'] },
  { name: 'PENGSHENG', target: 15, alias: ['PENGSHENG', 'PENG SHENG'] },
  { name: 'BALONGZHOU', target: 10, alias: ['BALONGZHOU', 'BA LONG ZHOU'] },
  { name: 'ZHIZUNBAO', target: 7, alias: ['ZHIZUNBAO', 'ZHI ZUN BAO'] },
];
// "FRUIT COLOR - SHUNFA" -> "SHUNFA"; plain "FRUIT COLOR" -> ''
const fcSub = client => U(client).replace(/^FRUIT\s*COLOU?R\s*-?\s*/, '').trim();
const programClientOf = c => { const sub = fcSub(c.client); if (!sub) return null; return PROGRAM.find(p => p.alias.some(a => sub === a || sub.startsWith(a))) || null; };
// ISO week number of a date
function isoWeek(iso) {
  const d = new Date(iso + 'T12:00'); const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3); const first = new Date(d.getFullYear(), 0, 4);
  return { y: d.getFullYear(), w: 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7) };
}

function openPanel(id) {
  closeBoxes();
  document.querySelectorAll('.sidepanel').forEach(p => p.hidden = p.id !== id);
  document.querySelectorAll('.sidetab').forEach(t => t.classList.toggle('on', t.dataset.panel === id));
  if (id === 'progPanel') renderProgram();
  if (id === 'adjPanel') renderAdj();
  if (id === 'cmpPanel') renderComparativa();
  if (id === 'pfPanel') { renderPallets(); setTimeout(() => $('#pfInput')?.focus(), 50); }
}
function closePanels() { document.querySelectorAll('.sidepanel').forEach(p => p.hidden = true); document.querySelectorAll('.sidetab').forEach(t => t.classList.remove('on')); }

// ---------- Cherry Program ----------
function renderProgram() {
  const fc = state.containers.filter(c => isFC(c.client) && /CHERR/i.test(c.species || ''));
  const weekOf = c => isISO(c.eta) ? isoWeek(c.eta) : null;
  const weeks = new Map();                  // "2025-W48" -> { label, sort }
  for (const c of fc) { const w = weekOf(c); if (w) weeks.set(`${w.y}-${String(w.w).padStart(2, '0')}`, { label: `W${w.w}`, y: w.y, w: w.w }); }
  const cols = [...weeks.keys()].sort();
  // clients outside the program (e.g. a new one written in Containers) get their own row, without a target
  const extra = [...new Set(fc.filter(c => !programClientOf(c) && fcSub(c.client)).map(c => fcSub(c.client)))].sort();
  const rows = [...PROGRAM.map(p => ({ p, list: fc.filter(c => programClientOf(c) === p) })),
    ...extra.map(n => ({ p: { name: n, target: null, extra: 1 }, list: fc.filter(c => !programClientOf(c) && fcSub(c.client) === n) })),
    { p: { name: 'FRUIT COLOR (not assigned)', target: null }, list: fc.filter(c => !fcSub(c.client)) }];
  const cell = (list, key) => { const inW = list.filter(c => { const w = weekOf(c); return w && `${w.y}-${String(w.w).padStart(2, '0')}` === key; }); return inW.length ? `<td class="pg-n" data-tip="${esc(inW.map(c => `<div><b>Cod Nave ${esc(c.vesselCode)}</b> · ${esc(c.containerNo || (isAir(c) ? 'Air' : ''))} · ETA ${fmt(c.eta)}</div>`).join(''))}">${inW.length}</td>` : '<td class="pg-0">·</td>'; };
  const noEta = list => list.filter(c => !weekOf(c)).length;
  const totalTarget = PROGRAM.reduce((a, p) => a + p.target, 0), assigned = rows.filter(r => r.p.target).reduce((a, r) => a + r.list.length, 0);
  $('#progBody').innerHTML = `
    <div class="pg-sum"><b>${assigned}</b> of <b>${totalTarget}</b> containers assigned · <b>${rows[rows.length - 1].list.length}</b> Fruit Color cherry containers without a client yet${extra.length ? ` · <b>${rows.filter(r => r.p.extra).reduce((a, r) => a + r.list.length, 0)}</b> for other clients` : ''} · week = ETA week</div>
    <div class="pg-wrap"><table class="pg">
      <thead><tr><th>Client</th>${cols.map(k => `<th>${weeks.get(k).label}<small>${weeks.get(k).y}</small></th>`).join('')}${rows.some(r => noEta(r.list)) ? '<th>No ETA</th>' : ''}<th>Total</th><th>Program</th></tr></thead>
      <tbody>${rows.map(r => {
        const n = r.list.length, t = r.p.target, pct = t ? Math.min(100, n / t * 100) : 0;
        return `<tr class="${t || r.p.extra ? '' : 'pg-un'}"><th>${esc(r.p.name)}</th>${cols.map(k => cell(r.list, k)).join('')}${rows.some(x => noEta(x.list)) ? `<td class="${noEta(r.list) ? 'pg-n' : 'pg-0'}">${noEta(r.list) || '·'}</td>` : ''}<td class="pg-t">${n}</td>
          <td class="pg-prog">${t ? `<span class="pg-frac ${n > t ? 'over' : n === t ? 'done' : ''}">${n}/${t}</span><span class="pg-bar"><i style="width:${pct}%"></i></span>` : ''}</td></tr>`;
      }).join('')}
      </tbody><tfoot><tr class="pg-gap"><td colspan="${cols.length + (rows.some(r => noEta(r.list)) ? 4 : 3)}"></td></tr><tr class="pg-total"><th>Total</th>${cols.map(k => cell(fc, k)).join('')}${rows.some(r => noEta(r.list)) ? `<td>${noEta(fc)}</td>` : ''}<td class="pg-t">${fc.length}</td><td class="pg-prog"><span class="pg-frac">${assigned}/${totalTarget}</span><span class="pg-bar"><i style="width:${Math.min(100, assigned / totalTarget * 100)}%"></i></span></td></tr></tfoot>
    </table></div>
    <p class="dnote">A container counts for a client when its Client in Containers is "FRUIT COLOR - CLIENT" (assign it there or in Load Allocation). Hover a number to see the Cod Nave of those containers.</p>`;
  fitProgram();
}
// hover box over a week number: Cod Nave of those containers
document.addEventListener('mouseover', e => {
  const td = e.target.closest('.pg td[data-tip]'); let tip = $('#pgTip');
  if (!td) { if (tip) tip.hidden = true; return; }
  if (!tip) { tip = document.createElement('div'); tip.id = 'pgTip'; tip.className = 'pg-tip'; document.body.appendChild(tip); }
  tip.innerHTML = td.dataset.tip; tip.hidden = false;
  const r = td.getBoundingClientRect(); tip.style.left = Math.min(r.left, innerWidth - tip.offsetWidth - 10) + 'px'; tip.style.top = (r.bottom + 6) + 'px';
});

// ---------- Load Allocation ----------
state.adj = { ship: null, key: null };
function renderAdj() {
  const fc = state.containers.filter(c => isFC(c.client));
  const ships = [...new Set(fc.map(c => c.vesselName || '—'))].sort();
  if (!ships.length) { $('#adjBody').innerHTML = '<div class="empty">No Fruit Color containers yet. Upload a Despachos file.</div>'; return; }
  if (!ships.includes(state.adj.ship)) state.adj.ship = ships[0];
  const list = fc.filter(c => (c.vesselName || '—') === state.adj.ship).sort((a, b) => String(a.vesselCode).localeCompare(String(b.vesselCode), undefined, { numeric: true }));
  if (!list.some(c => c.key === state.adj.key)) state.adj.key = list[0]?.key;
  const c = list.find(x => x.key === state.adj.key);
  const boxes = list.reduce((a, x) => a + (x.totalBoxes || 0), 0);
  const top = x => { const v = Object.entries(x.breakdown?.variety || {}).sort((a, b) => b[1] - a[1]); return v.length ? (v.length === 1 ? v[0][0] : `${v[0][0]} ${Math.round(v[0][1] / (x.totalBoxes || 1) * 100)}%`) : ''; };
  const card = (title, obj, total) => {
    const e = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    const body = !e.length ? '<div class="dnote">—</div>' : e.length === 1 ? `<div class="adj-single">✓ ${esc(e[0][0])}</div>`
      : e.map(([k, n], i) => `<div class="adj-bar"><div class="adj-meta"><span>${esc(k)}</span><span><small>${fmtBoxes(n)}</small> ${Math.round(n / (total || 1) * 1000) / 10}%</span></div><div class="adj-track"><i class="ac${i % 8}" style="width:${n / (total || 1) * 100}%"></i></div></div>`).join('');
    return `<div class="adj-card"><div class="adj-ch"><span>${title}</span><small>${fmtBoxes(total || 0)} boxes</small></div><div class="adj-cb">${body}</div></div>`;
  };
  const assigned = c ? fcSub(c.client) : '';
  $('#adjBody').innerHTML = `
    <div class="adj-ships">${ships.map(s => `<button type="button" class="chip ${s === state.adj.ship ? 'on' : ''}" data-ship="${esc(s)}">🚢 ${esc(s)} <b>${fc.filter(x => (x.vesselName || '—') === s).length}</b></button>`).join('')}</div>
    <div class="adj-main">
      <aside class="adj-side"><div class="adj-sl">${esc(state.adj.ship)} · ${list.length} containers · ${fmtBoxes(boxes)} boxes</div>
        ${list.map(x => `<button type="button" class="adj-item ${x.key === state.adj.key ? 'on' : ''}" data-key="${esc(x.key)}">
          <span class="adj-top"><b>${esc(x.vesselCode)}</b><small>${fmtBoxes(x.totalBoxes || 0)}</small></span>
          <span class="adj-cont">${esc(x.containerNo)}</span><span class="adj-var">${esc(top(x))}</span>
          ${fcSub(x.client) ? `<span class="adj-cli">→ ${esc(fcSub(x.client))}</span>` : ''}</button>`).join('')}
      </aside>
      <section class="adj-content">${c ? `
        <div class="adj-head">
          <div><div class="adj-title">Cod Nave ${esc(c.vesselCode)} <span class="pill">${isAir(c) ? 'Air' : 'Sea'}</span></div>
            <div class="dnote">${esc(c.containerNo)} · ${fmtBoxes(c.totalBoxes || 0)} boxes · ${esc(c.port || '')} · ETA ${fmt(c.eta)}</div></div>
          <form class="adj-assign" id="adjForm">
            <select id="adjClient" aria-label="Client for this container"><option value="">→ Assign client</option>
              ${[...new Set([...PROGRAM.map(p => p.name), ...state.containers.filter(x => isFC(x.client) && fcSub(x.client) && !programClientOf(x)).map(x => fcSub(x.client)).sort()])].map(n => `<option ${n === assigned ? 'selected' : ''}>${esc(n)}</option>`).join('')}
              <option value="__new">New client… (type the name)</option></select>
            <input id="adjNew" placeholder="New client name" autocomplete="off" hidden aria-label="New client name">
            <button class="btn hot" type="submit">Save</button>${assigned ? '<button class="btn ghost" type="button" id="adjClear">Remove</button>' : ''}
            <div class="dnote">Client in Containers: <b>${esc(c.client)}</b></div>
          </form>
        </div>
        ${similarNote(c)}${lastSeasonNote(c)}
        <div class="adj-grid">
          ${card('Species', c.breakdown?.species, c.totalBoxes)}${card('Variety', c.breakdown?.variety, c.totalBoxes)}
          ${card('Label', c.breakdown?.label, c.totalBoxes)}${card('Packaging (pack code)', c.breakdown?.packaging, c.totalBoxes)}
          ${card('Size', c.breakdown?.size, c.totalBoxes)}${card('Packing plant', c.breakdown?.plant, c.totalBoxes)}
          <div class="adj-full">${card('Grower', c.breakdown?.grower, c.totalBoxes)}</div>
        </div>` : ''}
      </section>
    </div>`;
}
// Note: containers already sold (Sales City filled) whose fruit looks like this one, and where they were sold.
// Similarity of each part = share of boxes both containers have in common (e.g. 60% 3J + 40% 2J vs 50% 3J + 50% 2J = 90%).
const SIM_DIMS = [['species', 'Species'], ['variety', 'Variety'], ['size', 'Sizes'], ['label', 'Label'], ['category', 'Category'], ['packType', 'Packing type'], ['plant', 'Packing plant'], ['grower', 'Grower']];
function simPart(a, b) {
  const ta = Object.values(a || {}).reduce((x, y) => x + y, 0), tb = Object.values(b || {}).reduce((x, y) => x + y, 0);
  if (!ta || !tb) return null;
  let s = 0; for (const [k, n] of Object.entries(a)) if (b[k]) s += Math.min(n / ta, b[k] / tb);
  return Math.round(s * 100);
}
function similarNote(c) {
  if (!c.breakdown) return '';
  const list = state.containers.filter(o => o.key !== c.key && o.salesCity && o.breakdown).map(o => {
    const parts = SIM_DIMS.map(([k, t]) => ({ k, t, p: simPart(c.breakdown[k], o.breakdown[k]), names: Object.keys(o.breakdown[k] || {}) })).filter(x => x.p !== null);
    const total = parts.length ? Math.round(parts.reduce((a, x) => a + x.p, 0) / parts.length) : 0;
    return { o, parts, total };
  }).filter(x => x.total >= 50).sort((a, b) => b.total - a.total).slice(0, 2);
  const part = (x, k) => x.parts.find(p => p.k === k);
  const say = x => {
    const o = x.o, v = part(x, 'variety'), z = part(x, 'size'), l = part(x, 'label'), sp = part(x, 'species');
    const bits = [];
    if (v) bits.push(`variety ${v.names.join(', ')} (${v.p}% similar)`);
    if (z) bits.push(`sizes ${Object.entries(o.breakdown.size || {}).sort((a, b) => b[1] - a[1]).map(e => e[0]).join(', ')} (${z.p}% similar)`);
    if (l) bits.push(l.p === 100 ? 'same label' : `label ${l.names.join(', ')} (${l.p}% similar)`);
    if (sp) bits.push(sp.p === 100 ? 'same species' : `species ${sp.names.join(', ')}`);
    const when = isISO(o.salesStart) ? `on ${fmt(o.salesStart)}${isISO(o.salesEnd) && o.salesEnd !== o.salesStart ? ` (sold out ${fmt(o.salesEnd)})` : ''}` : 'date not registered';
    return `Client <b>${esc(o.client || '—')}</b>, with a container of ${bits.join(', ')}, sold it in <b>${esc(o.salesCity)}</b> ${when}. It arrived at ${esc(o.port || '—')}.`;
  };
  return `<div class="adj-note"><div class="adj-ch"><span>📝 Note · similar containers already sold</span><small>${list.length ? 'similarity = share of boxes in common' : ''}</small></div><div class="adj-cb">${list.length ? list.map(x => `
    <details class="adj-ni"><summary><span class="adj-sim">${x.total}%</span> ${say(x)}</summary>
      <div class="adj-nd"><span>Cod Nave <b>${esc(x.o.vesselCode)}</b> · ${esc(x.o.vesselName || '')} · ${esc(x.o.containerNo || '')}</span>
      ${x.parts.map(p => `<span>${p.t}: <b>${p.p}%</b> <small>(${esc(p.names.slice(0, 4).join(', '))}${p.names.length > 4 ? '…' : ''})</small></span>`).join('')}</div></details>`).join('')
    : '<div class="dnote">No similar container with a Sales City yet. When you register where the competition sold (Sales City in Containers), similar ones will show here.</div>'}</div></div>`;
}
// Note 2: last season (2025-2026) containers of any client with similar fruit (comparison files in Drive), with how they did
const sizeN = s => U(s).replace(/^0+(?=\d)/, '');
function lastSeasonNote(c) {
  if (!c.breakdown) return '';
  const sp = U(Object.entries(c.breakdown.species || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || c.species);
  const mine = { variety: c.breakdown.variety, category: c.breakdown.category, label: c.breakdown.label, size: Object.fromEntries(Object.entries(c.breakdown.size || {}).map(([k, v]) => [sizeN(k), v])) };
  const dims = [['variety', 'Variety'], ['size', 'Sizes'], ['category', 'Category'], ['label', 'Label']];
  const list = (state.history || []).filter(h => h.species === sp).map(h => {
    const parts = dims.map(([k, t]) => ({ k, t, p: simPart(mine[k], h.dist[k]), names: Object.entries(h.dist[k] || {}).sort((a, b) => b[1] - a[1]).map(e => e[0]) })).filter(x => x.p !== null);
    return { h, parts, total: parts.length ? Math.round(parts.reduce((a, x) => a + x.p, 0) / parts.length) : 0 };
  }).filter(x => x.total >= 50).sort((a, b) => b.total - a.total).slice(0, 2);
  const say = x => {
    const h = x.h, p = k => x.parts.find(y => y.k === k);
    const bits = x.parts.map(y => `${y.t.toLowerCase()} ${y.names.slice(0, 4).join(', ')}${y.names.length > 4 ? '…' : ''} (${y.p}% similar)`);
    const res = h.perf === null ? 'no result registered' : `${h.perf > 0 ? '<span class="up">performed WELL' : h.perf < 0 ? '<span class="down">performed BADLY' : '<span>performed AVERAGE'}: ${h.perf > 0 ? '+' : ''}${h.perf} ${h.unit}</span> ${h.species === 'CHERRIES' ? 'vs comparable (Gesex differential, ' + h.compPct + '% of kilos compared)' : 'vs season average FOB of the same fruit'}`;
    return `Last season, client <b>${esc(h.client)}${h.sub ? ' (' + esc(h.sub) + ')' : ''}</b>, with a container of ${bits.join(', ')}, sold it in <b>${esc(h.city || '—')}</b> (arrived ${h.ata ? fmt(h.ata) : '—'}): ${res}.`;
  };
  return `<div class="adj-note last"><div class="adj-ch"><span>📚 Note · last season (2025-2026) similar containers</span><small>${sp === 'CHERRIES' ? 'Comparativa_Cerezas_2025-2026' : 'Comparativa_Carozos_2025-2026'}</small></div><div class="adj-cb">${list.length ? list.map(x => `
    <details class="adj-ni"><summary><span class="adj-sim">${x.total}%</span> ${say(x)}</summary>
      <div class="adj-nd"><span>${esc(x.h.vessel)} · Cod Nave <b>${esc(x.h.code)}</b>${x.h.container ? ' · ' + esc(x.h.container) : ''} · ${fmtBoxes(x.h.kg)} kg</span>
      ${x.parts.map(p => `<span>${p.t}: <b>${p.p}%</b></span>`).join('')}</div></details>`).join('')
    : '<div class="dnote">No container of last season is 50% similar or more.</div>'}</div></div>`;
}
async function adjAssign(name) {
  const c = state.containers.find(x => x.key === state.adj.key); if (!c) return;
  if (!state.edit) { toast('Turn on Edit mode in Settings to assign clients.', true); return; }
  const n = U(name).replace(/^FRUIT\s*COLOU?R\s*-?\s*/, '').trim();
  const client = n ? `FRUIT COLOR - ${n}` : 'FRUIT COLOR';
  if (await patchContainer(c, { client })) { toast(`${c.vesselCode}: Client is now ${client}.`); renderAdj(); renderContainers(); }
}

// ---------- Comparativa (Total Sales) ----------
// RMB per kilo: price per box / kilos per box ("2*2.5 kg" = 5 kg)
const kgOf = w => { const n = String(w || '').replace(/,/g, '.').match(/\d+(\.\d+)?/g); return n ? n.map(Number).reduce((a, b) => a * b, 1) : null; };
const perKg = r => { const p = priceNum(r.price), k = kgOf(r.netWeight); return p !== null && k ? Math.round(p / k * 100) / 100 : null; };
const colorOf = size => { const d = (String(size || '').toUpperCase().match(/D+$/) || [''])[0].length; return d >= 2 ? 'DD' : d === 1 ? 'D' : 'Roja'; };
state.cmp = { ship: null };
function renderComparativa() {
  // one unit = one client selling one fruit from one container; its weight = boxes of that fruit in the container (from the Despachos)
  const pool = allSales().filter(r => perKg(r) !== null);
  const shipKey = r => r.vesselName || shipOf(r) || '—';
  const ships = [...new Set([...pool.filter(r => isFC(r.client)).map(shipKey), ...state.containers.filter(c => isFC(c.client) && c.vesselName).map(c => c.vesselName)])].sort();
  if (!ships.length) { $('#cmpBody').innerHTML = '<div class="empty">No Fruit Color containers yet.</div>'; return; }
  if (!ships.includes(state.cmp.ship)) state.cmp.ship = ships[0];
  const rows = pool.filter(r => shipKey(r) === state.cmp.ship);
  const boxesOf = r => fruitCombos(r).filter(x => !r.category || x.category === U(r.category)).reduce((a, x) => a + x.boxes, 0) || null;
  const clientOf = r => isFC(r.client) ? 'FRUIT COLOR' : U(r.client);
  const units = new Map();
  for (const r of rows) {
    const c = byVessel(r.vesselCode, r.transport);
    const k = [sameFruitKey(r), clientOf(r), c?.key || r.vesselCode].join('#');
    if (!units.has(k)) units.set(k, { s: r, client: clientOf(r), fc: isFC(r.client), code: r.vesselCode, rows: [] });
    units.get(k).rows.push(r);
  }
  const U2 = [...units.values()].map(u => {
    const kgBox = kgOf(u.s.netWeight), boxes = boxesOf(u.s);
    const kg = u.rows.reduce((a, r) => a + perKg(r), 0) / u.rows.length;      // several days of the same fruit: their average
    return { ...u, kgBox, boxes, kilos: (boxes || 0) * kgBox, kg: Math.round(kg * 100) / 100, prices: u.rows.map(r => `${fmt(r.date)}: ${r.price}`).join(' · ') };
  });
  // weighted average ¥/kg of a set of units (weight = kilos); units with unknown boxes only count when none is known
  const wavg = us => { const k = us.filter(u => u.kilos > 0); const base = k.length ? k : us; if (!base.length) return null; const w = u => k.length ? u.kilos : 1; const t = base.reduce((a, u) => a + w(u), 0); return Math.round(base.reduce((a, u) => a + u.kg * w(u), 0) / t * 100) / 100; };
  const boxSum = us => us.reduce((a, u) => a + (u.boxes || 0), 0);
  const groups = new Map();
  for (const u of U2) { const k = sameFruitKey(u.s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(u); }
  const G = [...groups.values()].map(us => {
    const byC = new Map(); for (const u of us) { if (!byC.has(u.client)) byC.set(u.client, []); byC.get(u.client).push(u); }
    const clients = [...byC.entries()].map(([name, l]) => ({ name, fc: name === 'FRUIT COLOR', units: l, kg: wavg(l), boxes: boxSum(l) })).sort((a, b) => b.kg - a.kg);
    const fc = clients.find(c => c.fc), others = clients.filter(c => !c.fc);
    return { s: us[0].s, units: us, clients, fc, others, best: others[0] || null, comparable: !!fc && others.length > 0, onlyFC: !!fc && !others.length };
  });
  const comp = G.filter(g => g.comparable), only = G.filter(g => g.onlyFC);
  const kgTxt = n => n === null || n === undefined ? '—' : n + ' ¥/kg';
  const dTxt = n => n === null || n === undefined || isNaN(n) ? '' : `<span class="${n > 0 ? 'up' : n < 0 ? 'down' : ''}">${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Math.round(n * 100) / 100)} ¥/kg</span>`;
  const bx = n => n ? fmtBoxes(n) + ' boxes' : 'boxes n/a';
  const fruitName = s => [s.species, s.variety, s.netWeight, s.packType, s.label, s.category, s.size, tOf(s.transport) === 'A' ? 'Air' : 'Sea'].filter(Boolean).map(esc).join(' · ');
  const unitTable = us => `<table class="cmp-t"><thead><tr><th>Client</th><th>Vessel code</th><th>Boxes of this fruit</th><th>Prices (per box)</th><th>¥ per kg</th></tr></thead><tbody>${us.slice().sort((a, b) => b.kg - a.kg).map(u => `<tr class="${u.fc ? 'fc' : ''}"><td>${esc(u.client)}</td><td>${esc(u.code)}</td><td>${u.boxes ? fmtBoxes(u.boxes) : 'n/a'}</td><td>${esc(u.prices)}</td><td><b>${u.kg}</b></td></tr>`).join('')}</tbody></table>`;
  // a card: one compared characteristic. Per client: total boxes (all its fruit of this characteristic on the vessel),
  // comparable boxes (fruit sold by Fruit Color and at least one other client), % comparable and difference per kilo
  // vs the weighted average ¥/kg of all clients on the comparable fruit. Best difference on top.
  const rankCard = (title, sub, allUnits, compUnits) => {
    const avg = wavg(compUnits);
    const per = new Map();
    for (const u of allUnits) { if (!per.has(u.client)) per.set(u.client, { all: [], comp: [] }); per.get(u.client).all.push(u); }
    for (const u of compUnits) per.get(u.client).comp.push(u);
    const rows = [...per.entries()].filter(([, p]) => p.comp.length).map(([name, p]) => {
      const total = boxSum(p.all), cb = boxSum(p.comp), kg = wavg(p.comp);
      return { name, fc: name === 'FRUIT COLOR', total, cb, pct: total ? Math.round(cb / total * 100) : null, diff: kg !== null && avg !== null ? Math.round((kg - avg) * 100) / 100 : null };
    }).sort((a, b) => b.diff - a.diff);
    return `<div class="rk-card"><div class="rk-ch">${title}<small>${sub}</small><small class="rk-bx">Weighted average: <b>${avg ?? '—'} ¥/kg</b> · ${fmtBoxes(boxSum(compUnits))} comparable boxes</small></div>
      <div class="rk-h"><span>#</span><span>Client</span><span>Total boxes</span><span>Comparable boxes</span><span>% comp.</span><span>Diff. ¥/kg</span></div>
      ${rows.map((r, i) => `<div class="rk-r ${i === 0 ? 'top' : ''} ${r.fc ? 'fc' : ''}"><span class="n">${i === 0 ? '🏆' : i + 1}</span><span>${esc(r.name)}</span><span class="b">${fmtBoxes(r.total)}</span><span class="b">${fmtBoxes(r.cb)}</span><span class="b">${r.pct ?? '—'}%</span><span class="k">${dTxt(r.diff) || '0'}</span></div>`).join('')}</div>`;
  };
  // ---- 1. same fruit (every characteristic), weighted ----
  const fruitSub = s => [s.species, s.netWeight, s.packType, s.label, s.category, tOf(s.transport) === 'A' ? 'Air' : 'Sea'].filter(Boolean).map(esc).join(' · ');
  const sec1 = `<div class="cmp-sec rk-sec"><div class="rk-title">1 · Same fruit (all characteristics) · weighted by boxes · ${comp.length} fruit · ${fmtBoxes(comp.reduce((a, g) => a + boxSum(g.units), 0))} comparable boxes</div>
    ${comp.length ? `<div class="rk-grid">${comp.map(g => rankCard(`${esc(g.s.variety)} · ${esc(g.s.size)}`, fruitSub(g.s), g.units, g.units)).join('')}</div>` : '<p class="dnote">No fruit sold by Fruit Color and another client on this vessel yet.</p>'}</div>`;
  // ---- 2, 3 and 4. by variety, by size (with its color), by color: weighted by kilos ----
  const byDim = (num, label, sub, keyOf, sorter) => {
    const keys = [...new Set(comp.map(g => keyOf(g.s)))].sort((a, b) => sorter ? sorter(a, b) : String(a).localeCompare(String(b)));
    if (!keys.length) return '';
    return `<div class="cmp-sec rk-sec"><div class="rk-title">${num} · By ${label} · weighted by kilos</div><div class="rk-grid">${keys.map(k =>
      rankCard(esc(k), sub, G.filter(g => keyOf(g.s) === k).flatMap(g => g.units), comp.filter(g => keyOf(g.s) === k).flatMap(g => g.units))).join('')}</div></div>`;
  };
  // ---- 5. fruit only Fruit Color has on this vessel (Despachos): no other client's container carries the same fruit ----
  const shipConts = state.containers.filter(c => (c.vesselName || '—') === state.cmp.ship && c.combos);
  const fruitOf = (c, k) => { const [v, sp, va, nw, pt, lb, sz, ct] = k.split('|'); return v === 'v2' ? { species: sp, variety: va, netWeight: nw, packType: pt, label: lb, size: sz, category: ct || '', transport: c.transport } : null; };
  const fk = x => [tOf(x.transport) || 'M', x.species, x.variety, kgOf(x.netWeight), x.packType, x.label, x.category, x.size].map(v => U(v)).join('|');
  const otherFruit = new Set();
  for (const c of shipConts.filter(c => !isFC(c.client))) for (const k of Object.keys(c.combos)) { const x = fruitOf(c, k); if (x) otherFruit.add(fk(x)); }
  const onlyMap = new Map();
  for (const c of shipConts.filter(c => isFC(c.client))) for (const [k, b] of Object.entries(c.combos)) {
    const x = fruitOf(c, k); if (!x || otherFruit.has(fk(x))) continue;
    const o = onlyMap.get(fk(x)) || onlyMap.set(fk(x), { x, boxes: 0, codes: new Set() }).get(fk(x)); o.boxes += b; o.codes.add(c.vesselCode);
  }
  const onlyList = [...onlyMap.values()].sort((p, q) => p.x.variety.localeCompare(q.x.variety) || bySize(p.x.size, q.x.size));
  const sec4 = `<div class="cmp-sec rk-sec"><div class="rk-title">5 · Fruit only Fruit Color has on this vessel (no comparison) · ${onlyList.length} fruit · ${fmtBoxes(onlyList.reduce((a, o) => a + o.boxes, 0))} boxes</div>
    <p class="dnote">From Despachos: fruit in Fruit Color containers that no other client's container on this vessel carries (same species, variety, net weight, packing type, label, category, size and transport).</p>
    <table class="cmp-t"><thead><tr><th>Fruit</th><th>Vessel code</th><th>Boxes</th></tr></thead><tbody>${onlyList.map(o => `<tr><td>${fruitName(o.x)}</td><td>${esc([...o.codes].join(', '))}</td><td>${fmtBoxes(o.boxes)}</td></tr>`).join('') || '<tr><td colspan="3" class="dnote">None.</td></tr>'}</tbody></table></div>`;
  const missing = U2.filter(u => !u.boxes).length;
  $('#cmpBody').innerHTML = `
    <div class="adj-ships">${ships.map(s => `<button type="button" class="chip ${s === state.cmp.ship ? 'on' : ''}" data-cship="${esc(s)}">🚢 ${esc(s)}</button>`).join('')}</div>
    <p class="dnote">Same fruit = same vessel, transport, species, variety, net weight, packing type, label, category and size with its color (e.g. 3JD); any market. Price per kilo = price per box ÷ kg per box (ranges use their average; several days of one container use their average). Weighted averages use the boxes of that fruit in each container (Despachos).${missing ? ` ${missing} sale(s) have no box count in Despachos and only count when nothing else is known.` : ''}</p>
    ${sec1}
    ${byDim(2, 'Variety', 'all sizes', s => s.variety)}
    ${byDim(3, 'Size (with color)', 'all varieties', s => s.size, bySize)}
    ${byDim(4, 'Color', 'all varieties and sizes', s => colorOf(s.size))}
    ${sec4}`;
}

// ---------- wiring ----------
document.addEventListener('click', e => {
  const t = e.target.closest('.sidetab'); if (t) { const p = $('#' + t.dataset.panel); p.hidden ? openPanel(t.dataset.panel) : closePanels(); return; }
  if (e.target.closest('.sp-close')) { closePanels(); return; }
  const sh = e.target.closest('[data-ship]'); if (sh) { state.adj.ship = sh.dataset.ship; state.adj.key = null; renderAdj(); return; }
  const it = e.target.closest('.adj-item'); if (it) { state.adj.key = it.dataset.key; renderAdj(); return; }
  if (e.target.id === 'adjClear') { adjAssign(''); return; }
  const cs = e.target.closest('[data-cship]'); if (cs) { state.cmp.ship = cs.dataset.cship; renderComparativa(); return; }
  if (e.target.id === 'tCompare') { openPanel('cmpPanel'); }
});
document.addEventListener('submit', e => { if (e.target.id === 'adjForm') { e.preventDefault(); adjAssign($('#adjClient').value === '__new' ? $('#adjNew').value : $('#adjClient').value); } });
document.addEventListener('change', e => { if (e.target.id === 'adjClient') { const n = $('#adjNew'); n.hidden = e.target.value !== '__new'; if (!n.hidden) n.focus(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && document.querySelector('.sidepanel:not([hidden])') && !document.querySelector('.opbox, .fpop')) closePanels(); });

// =====================================================================================
// Phone (view-only link on a phone): Sales Start filter, Pallet Finder, Notes, long-press copy / paste
// =====================================================================================
state.ssDay = null;
function ssLabel() {
  const b = $('#ssBtn'); if (!b) return;
  b.classList.toggle('on', !!state.ssDay);
  b.textContent = state.ssDay ? `Sales Start: ${fmt(state.ssDay)}` : 'Sales Start';
}
// Sales Start filter: pick a day, then Apply filter
document.addEventListener('click', e => {
  if (e.target.id !== 'ssBtn') return;
  closeBoxes();
  const box = document.createElement('div'); box.className = 'opbox ssdlg';
  box.innerHTML = `<div class="op-head">Sales Start</div>
    <input type="date" class="ss-day" value="${state.ssDay || todayISO()}" aria-label="Sales Start date">
    <div class="op-foot">${state.ssDay ? '<button type="button" class="btn ghost" data-a="off">Remove filter</button>' : '<button type="button" class="btn ghost" data-a="cancel">Cancel</button>'}<button type="button" class="btn hot" data-a="apply">Apply filter</button></div>`;
  document.body.appendChild(box);
  const r = e.target.getBoundingClientRect();
  box.style.top = (r.bottom + 6) + 'px'; box.style.left = Math.max(8, Math.min(r.left, innerWidth - box.offsetWidth - 8)) + 'px';
  box.addEventListener('click', ev => {
    const a = ev.target.closest('[data-a]')?.dataset.a; if (!a) return;
    if (a === 'apply') state.ssDay = box.querySelector('.ss-day').value || todayISO();
    if (a === 'off') state.ssDay = null;
    box.remove(); ssLabel(); renderContainers();
  });
});
// current week number at the top, in Chinese (ISO week)
(() => { const el = $('#weekNo'); if (!el) return; const show = () => { el.textContent = `第${isoWeek(todayISO()).w}周`; }; show(); setInterval(show, 3600000); })();

// ---------- Pallet Finder ----------
function renderPallets() {
  const q = U($('#pfInput').value).replace(/\s+/g, '');
  const out = $('#pfResults');
  if (q.length < 2) { out.innerHTML = '<div class="dnote">Type at least 2 digits of the pallet number.</div>'; return; }
  const hits = [];
  for (const c of state.containers) for (const p of c.palletList || []) if (U(p.n).includes(q)) hits.push({ c, p });
  out.innerHTML = !hits.length ? '<div class="dnote">No pallet matches.</div>' : `<div class="dnote">${hits.length} pallet${hits.length === 1 ? '' : 's'}${hits.length > 60 ? ' · showing 60, type more digits' : ''}</div>` +
    hits.slice(0, 60).map(({ c, p }) => `<div class="pf-card">
      <div class="pf-n">Pallet <b>${esc(p.n).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), m => '<mark>' + m + '</mark>')}</b></div>
      <div class="pf-grid">
        <span>Cod Nave</span><b>${esc(c.vesselCode)} · ${esc(c.vesselName || '')}</b>
        <span>Client</span><b>${esc(c.client || '—')}</b>
        <span>Container</span><b>${esc(c.containerNo || (isAir(c) ? 'Air' : '—'))}</b>
        <span>Fruit</span><b>${esc([p.species, p.variety, p.sizes.join(' / ')].filter(Boolean).join(' · '))} · ${fmtBoxes(p.boxes)} boxes</b>
        <span>Label</span><b>${esc(p.label || '—')}</b>
        <span>ATA</span><b class="${isISO(c.ata) ? '' : 'pf-no'}">${isISO(c.ata) ? fmt(c.ata) : 'No ATA yet'}</b>
        <span>Sales Start</span><b class="${isISO(c.salesStart) ? '' : 'pf-no'}">${isISO(c.salesStart) ? fmt(c.salesStart) : 'Sales not started'}</b>
      </div></div>`).join('');
}
document.addEventListener('input', e => { if (e.target.id === 'pfInput') renderPallets(); });

// ---------- Notes (saved on this phone) ----------
(() => {
  const t = $('#notesText'); if (!t) return;
  try { t.value = localStorage.getItem('kt-notes') || ''; } catch { }
  t.addEventListener('input', () => { try { localStorage.setItem('kt-notes', t.value); } catch { } });
})();

// ---------- long press: on a cell copies its text; on the notes pastes it ----------
state.clipText = '';
(() => {
  let timer = null, startXY = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener('touchstart', e => {
    if (!document.body.classList.contains('phone')) return;
    const td = e.target.closest('.grid td, .pf-grid b'), notes = e.target.closest('#notesText');
    if (!td && !notes) return;
    const t = e.touches[0]; startXY = [t.clientX, t.clientY];
    timer = setTimeout(() => {
      timer = null;
      if (td) {
        const txt = td.innerText.trim(); if (!txt) return;
        state.clipText = txt;
        try { navigator.clipboard?.writeText(txt).catch(() => { }); } catch { }
        td.classList.add('copied'); setTimeout(() => td.classList.remove('copied'), 700);
        toast(`Copied: ${txt.length > 40 ? txt.slice(0, 40) + '…' : txt}`);
      } else if (state.clipText) {
        const s = notes.selectionStart ?? notes.value.length, en = notes.selectionEnd ?? s;
        notes.value = notes.value.slice(0, s) + state.clipText + notes.value.slice(en);
        notes.selectionStart = notes.selectionEnd = s + state.clipText.length;
        try { localStorage.setItem('kt-notes', notes.value); } catch { }
        toast('Pasted.');
      }
    }, 550);
  }, { passive: true });
  document.addEventListener('touchmove', e => { if (timer && startXY) { const t = e.touches[0]; if (Math.abs(t.clientX - startXY[0]) > 10 || Math.abs(t.clientY - startXY[1]) > 10) cancel(); } }, { passive: true });
  document.addEventListener('touchend', cancel); document.addEventListener('touchcancel', cancel);
})();

// ---------- phone: the app itself does not zoom; the tables zoom with two fingers ----------
function phoneMode() {
  if (document.body.classList.contains('phone')) return;      // load() runs again every few minutes
  document.body.classList.add('phone');
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no');
  $('#q').placeholder = 'Search…';
  // week next to the VIEW ONLY badge
  const wk = $('#weekNo'), vb = $('#viewBadge'); if (wk && vb) vb.after(wk);
  startTicker();
  ['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault(), { passive: false }));   // iPhone page zoom
  let pinch = null;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  document.addEventListener('touchstart', e => {
    const sc = e.target.closest('.scroller'); if (!sc || e.touches.length !== 2) return;
    const tb = sc.querySelector('table'); pinch = { tb, d: dist(e.touches), z: parseFloat(tb.style.zoom) || 1 };
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (e.touches.length === 2) e.preventDefault();          // never zoom the page
    if (!pinch || e.touches.length !== 2) return;
    pinch.tb.style.zoom = Math.min(2.5, Math.max(0.5, pinch.z * dist(e.touches) / pinch.d)).toFixed(2);
  }, { passive: false });
  document.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; });
}

// ---------- phone: weather ticker at the bottom ----------
// retro pixel icons (9x9), in the app colours; rain drops fall
const PIX = {
  sun: ['....Y....', '.Y..Y..Y.', '..YYYYY..', '..YYYYY..', 'YYYYYYYYY', '..YYYYY..', '..YYYYY..', '.Y..Y..Y.', '....Y....'],
  part: ['..Y.Y....', '...YYY...', '..YYYYWW.', '..YYWWWWW', '...WWWWWW', '..WWWWWWW', '..SSSSSS.', '.........', '.........'],
  cloud: ['.........', '...WWW...', '..WWWWW..', '.WWWWWWW.', 'WWWWWWWWW', 'WWWWWWWWW', '.SSSSSSS.', '.........', '.........'],
  rain: ['...WWW...', '..WWWWW..', '.WWWWWWW.', 'WWWWWWWWW', '.SSSSSSS.', '.B..B..B.', 'B..B..B..', '.B..B..B.', '.........'],
  fog: ['.........', 'GGGGGGG..', '.........', '..GGGGGGG', '.........', 'GGGGGGG..', '.........', '..GGGGGGG', '.........'],
  snow: ['...WWW...', '..WWWWW..', '.WWWWWWW.', 'WWWWWWWWW', '.SSSSSSS.', '.F..F..F.', '..F..F..F', '.F..F..F.', '.........'],
  storm: ['...WWW...', '..WWWWW..', '.WWWWWWW.', 'WWWWWWWWW', '.SSSASSS.', '....AA...', '...AA....', '....A....', '.........'],
};
const PIXC = { Y: '#ffd23f', W: '#cfe8e4', S: '#5fa79c', B: '#5fa8ff', G: '#8aa7a3', F: '#ffffff', A: '#ff6b57' };
const pixIcon = k => `<svg class="px px-${k}" viewBox="0 0 9 9" width="18" height="18" shape-rendering="crispEdges" aria-hidden="true">${PIX[k].flatMap((row, y) => [...row].map((ch, x) => ch === '.' ? '' : `<rect class="${ch === 'B' ? 'drop' : ''}" x="${x}" y="${y}" width="1" height="1" fill="${PIXC[ch]}"/>`)).join('')}</svg>`;
const WX = c => c === 0 ? [pixIcon('sun'), 'CLEAR'] : c <= 2 ? [pixIcon('part'), 'PARTLY CLOUDY'] : c === 3 ? [pixIcon('cloud'), 'CLOUDY'] : c <= 48 ? [pixIcon('fog'), 'FOG']
  : c <= 67 || (c >= 80 && c <= 82) ? [pixIcon('rain'), 'RAIN'] : c <= 77 || c === 85 || c === 86 ? [pixIcon('snow'), 'SNOW'] : c >= 95 ? [pixIcon('storm'), 'STORM'] : [pixIcon('cloud'), 'CLOUDY'];
const WX_CITIES = [['SANTIAGO', -33.45, -70.67], ['CONCEPCION', -36.83, -73.05], ['GUANGZHOU', 23.13, 113.26], ['SHANGHAI', 31.23, 121.47], ['WUHAN', 30.59, 114.31], ['BEIJING', 39.90, 116.41], ['SHENYANG', 41.80, 123.43]];
async function freshWeather() {
  // the data from the PC is used first; if it is old, ask Open-Meteo directly
  const old = (at, h = 12) => !at || Date.now() - new Date(at) > h * 3600000;   // twice a day
  if (!state.weather?.cities?.length || state.weather.cities.length < WX_CITIES.length || old(state.weather.at)) try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${WX_CITIES.map(c => c[1]).join(',')}&longitude=${WX_CITIES.map(c => c[2]).join(',')}&current=temperature_2m,weather_code`;
    const j = await (await fetch(u)).json();
    state.weather = { ...(state.weather || {}), at: new Date().toISOString(), cities: WX_CITIES.map((c, i) => ({ name: c[0], temp: j[i]?.current?.temperature_2m, code: j[i]?.current?.weather_code })) };
  } catch { }
  try {
    if (!state.weather?.fx || Date.now() - new Date(state.weather.fx.at) > 12 * 3600000) {
      const f = await (await fetch('https://open.er-api.com/v6/latest/USD')).json();
      if (f.result === 'success') state.weather = { ...(state.weather || { cities: [] }), fx: { cny: f.rates.CNY, clp: f.rates.CLP, at: new Date().toISOString() } };
    }
  } catch { }
  return state.weather;
}
async function renderTicker() {
  const el = $('#ticker .tk-move'); if (!el) return;
  const w = await freshWeather();
  const txt = w?.cities?.length ? w.cities.map(c => { const [ico, t] = WX(c.code); return `<span class="tk-i"><b>${c.name}</b>${ico}<em>${c.temp != null ? Math.round(c.temp) + '°C' : '--'}</em><small>${t}</small></span>`; }).join('<span class="tk-sep">◆</span>')
    : '<span class="tk-i"><small>WEATHER NOT AVAILABLE RIGHT NOW</small></span>';
  const fx = w?.fx ? `<span class="tk-sep">◆</span><span class="tk-i"><b>FX</b><small>USD/RMB</small><em>${(+w.fx.cny).toFixed(4)}</em></span><span class="tk-sep">◆</span><span class="tk-i"><b>FX</b><small>USD/CLP</small><em>${(+w.fx.clp).toFixed(2)}</em></span>` : '';
  el.innerHTML = txt + fx + '<span class="tk-sep">◆</span>' + txt + fx + '<span class="tk-sep">◆</span>';
  // the open ribbon: everything at once
  $('#ticker .tk-full').innerHTML = `<div class="tk-grid">${(w?.cities || []).map(c => { const [ico, t] = WX(c.code); return `<div class="tk-row">${ico.replace('width="18" height="18"', 'width="30" height="30"')}<b>${c.name}</b><em>${c.temp != null ? Math.round(c.temp) + '°C' : '--'}</em><small>${t}</small></div>`; }).join('') || '<div class="tk-row"><small>WEATHER NOT AVAILABLE RIGHT NOW</small></div>'}</div>
    ${w?.fx ? `<div class="tk-fx"><div class="tk-row"><b>FX</b><small>USD/RMB</small><em>${(+w.fx.cny).toFixed(4)}</em></div><div class="tk-row"><b>FX</b><small>USD/CLP</small><em>${(+w.fx.clp).toFixed(2)}</em></div></div>` : ''}
    <div class="tk-at">Updated ${w?.at ? new Date(w.at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '--'}</div>`;     // twice, so the ribbon loops without a gap
}
function startTicker() {
  if ($('#ticker')) return;
  const t = document.createElement('div'); t.id = 'ticker'; t.className = 'ticker'; t.innerHTML = '<div class="tk-bar"><div class="tk-tag">▶ WX</div><div class="tk-win"><div class="tk-move"></div></div></div><button class="tk-close" type="button" aria-label="Close">▼</button><div class="tk-full"></div>';
  // tap the ribbon: it opens to half the screen; the arrow closes it
  t.addEventListener('click', e => { if (e.target.closest('.tk-close')) t.classList.remove('open'); else if (!t.classList.contains('open')) t.classList.add('open'); });
  document.body.appendChild(t);
  renderTicker(); setInterval(renderTicker, 12 * 3600000);
}

// phone: the whole Cherry Program table fits the screen (portrait and landscape), no sideways scroll
function fitProgram() {
  const t = document.querySelector('#progBody table.pg'), wrap = document.querySelector('#progBody .pg-wrap');
  if (!t || !wrap) return;
  t.style.zoom = 1;
  if (!document.body.classList.contains('phone')) return;
  // fit the width (all weeks up to Program); more rows scroll down
  const z = Math.min(1, (wrap.clientWidth - 2) / t.scrollWidth);
  t.style.zoom = z.toFixed(3);
}
addEventListener('resize', () => { if (!document.querySelector('#progPanel')?.hidden) fitProgram(); });
addEventListener('orientationchange', () => setTimeout(() => { if (!document.querySelector('#progPanel')?.hidden) fitProgram(); }, 300));
