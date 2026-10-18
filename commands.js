// Commands interpreter: turns short Spanish/English sentences into field changes.
// Runs entirely in the browser, no external AI. Exposed as window.KuaiCommands.interpret(text, containers, today)
(function () {
  // Accent folding that keeps string length, so regex indices map back to the original text.
  const FOLD = { á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n', Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ú: 'u', Ü: 'u', Ñ: 'n' };
  const fold = s => s.replace(/[áéíóúüñÁÉÍÓÚÜÑ]/g, c => FOLD[c]).toLowerCase();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const MONTHS = { ene: 1, enero: 1, jan: 1, january: 1, feb: 2, febrero: 2, february: 2, mar: 3, marzo: 3, march: 3, abr: 4, abril: 4, apr: 4, april: 4,
    may: 5, mayo: 5, jun: 6, junio: 6, june: 6, jul: 7, julio: 7, july: 7, ago: 8, agosto: 8, aug: 8, august: 8, sep: 9, sept: 9, septiembre: 9, setiembre: 9, september: 9,
    oct: 10, octubre: 10, october: 10, nov: 11, noviembre: 11, november: 11, dic: 12, diciembre: 12, dec: 12, december: 12 };

  // Finds a date in the text. Returns {value, start, end} or null.
  function findDate(t, today) {
    const add = n => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };
    const rel = [[/\b(anteayer|antier)\b/, -2], [/\b(ayer|yesterday)\b/, -1], [/\b(hoy|today|ahora|now)\b/, 0], [/\b(pasado manana)\b/, 2], [/\b(manana|tomorrow)\b/, 1]];
    for (const [re, n] of rel) { const m = re.exec(t); if (m) return { value: add(n), start: m.index, end: m.index + m[0].length }; }
    let m = /\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/.exec(t);
    if (m && +m[2] <= 12 && +m[1] <= 31) {
      let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear();
      return { value: `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`, start: m.index, end: m.index + m[0].length };
    }
    m = /\b(\d{1,2})\s*(?:de\s+)?([a-z]{3,10})(?:\s+(?:de\s+)?(\d{4}))?\b/.exec(t);
    if (m && MONTHS[m[2]]) {
      const y = m[3] ? +m[3] : today.getFullYear();
      return { value: `${y}-${String(MONTHS[m[2]]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`, start: m.index, end: m.index + m[0].length };
    }
    m = /\b([a-z]{3,10})\s+(\d{1,2})\b/.exec(t);
    if (m && MONTHS[m[1]]) {
      return { value: `${today.getFullYear()}-${String(MONTHS[m[1]]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`, start: m.index, end: m.index + m[0].length };
    }
    return null;
  }

  const ckey = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const vkey = s => String(s || '').toUpperCase().replace(/^[MA](?=\d)/, '').replace(/^0+(?=\d)/, '');

  // Finds the containers referenced in the text.
  function findContainers(t, containers) {
    const refs = [];
    // full container ids like MNBU910027-8 / MNBU 9100278
    for (const m of t.matchAll(/\b([a-z]{4})\s?(\d{6,7})(?:-?(\d))?\b/g)) refs.push({ raw: m[0], code: ckey(m[1] + m[2] + (m[3] || '')), kind: 'full', start: m.index, end: m.index + m[0].length });
    // bare numbers (vessel codes or partial container numbers), skipping those inside full ids
    for (const m of t.matchAll(/\b([ma]?\d{3,8}(?:-\d)?)\b/g)) {
      if (refs.some(r => m.index >= r.start && m.index < r.end)) continue;
      refs.push({ raw: m[0], code: ckey(m[1]), kind: 'num', start: m.index, end: m.index + m[0].length });
    }
    const found = []; const ambiguous = []; const usedRefs = [];
    for (const r of refs) {
      let hits;
      if (r.kind === 'full') hits = containers.filter(c => c.key.startsWith(r.code) || r.code.startsWith(c.key));
      else {
        const want = /^A/i.test(r.code) ? 'A' : /^M/i.test(r.code) ? 'M' : '';
        hits = containers.filter(c => vkey(c.vesselCode) === vkey(r.code) && (!want || (/^A/i.test(c.transport || '') ? 'A' : 'M') === want));
        if (!hits.length) hits = containers.filter(c => c.key.replace(/^[A-Z]+/, '').startsWith(r.code.replace(/^[MA]/, '')) || c.key.includes(r.code));
      }
      if (hits.length === 1) { found.push(hits[0]); usedRefs.push(r); }
      else if (hits.length > 1) { ambiguous.push({ ref: r.raw, hits }); usedRefs.push(r); }
    }
    return { found: [...new Set(found)], ambiguous, refs: usedRefs };
  }

  // Free text that follows a keyword, minus the container reference and the date.
  function textAfter(orig, t, re, cut) {
    const m = re.exec(t);
    if (!m) return null;
    let s = orig.slice(m.index + m[0].length);
    for (const c of cut) {
      const pos = fold(s).indexOf(fold(c));
      if (pos >= 0) s = s.slice(0, pos) + s.slice(pos + c.length);
    }
    return s.replace(/^\s*(:|-|=|de|del|por|es|of|is)\b\s*/i, '').replace(/^[:\-=\s]+/, '').trim();
  }

  function interpret(text, containers, today = new Date()) {
    const orig = text.trim();
    const t = fold(orig);
    if (!t) return { error: 'Type a command.' };
    const date = findDate(t, today);
    // hide the date so its digits are not taken as a container number
    const tNoDate = date ? t.slice(0, date.start) + ' '.repeat(date.end - date.start) + t.slice(date.end) : t;
    const { found, ambiguous, refs } = findContainers(tNoDate, containers);
    if (ambiguous.length && !found.length) {
      const a = ambiguous[0];
      return { error: `"${a.ref}" matches ${a.hits.length} containers: ${a.hits.slice(0, 6).map(c => c.containerNo + ' (' + c.vesselCode + ')').join(', ')}${a.hits.length > 6 ? '…' : ''}. Type more digits.` };
    }
    if (!found.length) return { error: 'Container not found. Use the container number (or part of it) or the vessel code.' };

    const day = date ? date.value : iso(today);
    const cut = [...refs.map(r => orig.slice(r.start, r.end)), ...(date ? [orig.slice(date.start, date.end)] : []),
      'contenedor', 'container', 'cntr'];
    const ch = {};
    let consumed = false;

    // free-text fields first (their text may contain words that look like other intents)
    const freeFields = [
      ['openingPrices', /(precios?\s+(de\s+)?apertura|opening\s+prices?)/],
      ['claim', /\b(claim|reclamo|reclamacion)\b/],
      ['survey', /\bsurvey\b/],
      ['comments', /\b(comentarios?|comments?|nota|note)\b/],
    ];
    for (const [field, re] of freeFields) {
      const v = textAfter(orig, t, re, cut);
      if (v !== null) { ch[field] = v; consumed = true; break; }
    }

    if (!consumed) {
      const mStatus = /\b(status|estatus|estado)\b/.exec(t);
      if (mStatus) {
        ch.status = textAfter(orig, t, /\b(status|estatus|estado)\b/, cut).toUpperCase();
      }
      // sales start
      if (/(comenz|empez|inici|abri|arranc|start|began|begin|open)\w*\s+(\w+\s+)?(la\s+)?(venta|vender|ventas|sale|sales|selling)|inicio\s+de\s+venta|en\s+venta\b|started selling/.test(t)) ch.salesStart = day;
      // sales end / sold
      const sold = /\b(vendid[oa]s?|sold|se\s+vendio)\b/.test(t);
      if (/(termin|finaliz|acab|cerr|end|finish)\w*\s+(\w+\s+)?(la\s+)?(venta|ventas|sale|sales|selling)|fin\s+de\s+venta|sold\s*out/.test(t) || sold) {
        ch.salesEnd = day;
        if (!ch.status) ch.status = 'SOLD';
      }
      if (!ch.status && /\ben\s+proceso\b|\bin\s+process\b|\bselling\b/.test(t) && !ch.salesStart) ch.status = 'IN PROCESS';
      // arrival
      if (/\b(lleg|arrib|arriv|atrac|descarg)\w*|\bata\b/.test(t)) ch.ata = day;
      // stock / pallets
      let m = /(stock|quedan?|quedaron|left|restan?)\D{0,20}?(\d+(?:[.,]\d+)?)/.exec(tNoDate) || /(\d+(?:[.,]\d+)?)\s*(pallets?|pallet)\s*(de\s+)?(stock|left|quedan|restantes?)/.exec(tNoDate);
      if (m) {
        const n = /^\d/.test(m[1]) ? m[1] : m[2];
        if (!refs.some(r => r.raw === n)) ch.stockLeft = n.replace(',', '.');
      } else if ((m = /\b(\d{1,3})\s*pallets?\b/.exec(tNoDate)) && !refs.some(r => r.raw === m[1])) ch.pallets = m[1];
      // sales city
      m = /(se\s+vende(?:ra|n)?\s+en|vende(?:ra)?\s+en|venta\s+en|sales\s+city|ciudad(?:\s+de\s+venta)?|lugar\s+de\s+venta|market|mercado|selling\s+in|sold\s+in)\s*:?\s*([a-z][a-z\/ \-]{1,30})/.exec(t);
      if (m) {
        const city = orig.slice(m.index + m[0].length - m[2].length, m.index + m[0].length).trim().replace(/\s+(hoy|today|ayer|desde.*)$/i, '');
        if (city) { ch.salesCity = city.toUpperCase(); if (/^(sold|venta)/.test(m[1]) && !/vendid|sold\b/.test(t.replace(m[0], ''))) { /* city only */ } }
        if (/^(se\s+vende|vende|venta\s+en|selling|sold\s+in)/.test(m[1])) { delete ch.salesEnd; if (ch.status === 'SOLD' && !/\bvendid[oa]\b/.test(t)) delete ch.status; if (ch.status === 'IN PROCESS' && !/en\s+proceso|in\s+process/.test(t)) delete ch.status; }
      }
    }

    if (!Object.keys(ch).length) return { error: 'I could not tell which field to change. Try: arrived, started selling, finished selling, sold, claim, survey, comment, opening prices, N pallets left, selling in, status.' };
    return { targets: found, changes: ch, ambiguous };
  }

  window.KuaiCommands = { interpret };
})();
