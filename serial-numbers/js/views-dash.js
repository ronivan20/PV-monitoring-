/* PV Module Serial Numbers — dashboard, daily accomplishments and exports */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, el = u.el, api = SN.api, S = SN.state;
  var D = { built: false, filter: { block: '', q: '', user_id: '', from: '', to: '' }, days: null, loading: false, day: null };

  function summarize(block) {
    var s = { total: 0, installed: 0, not_installed: 0, scope: 0, ready: 0, in_progress: 0, completed: 0, needs_review: 0,
      excluded: 0, no_id: 0, valid: 0, reg: 0, verified: 0, review_recs: 0, outside: 0, unconfirmed: 0 };
    S.list.forEach(function (t) {
      if (block && t.block !== block) return;
      if (!t.confirmed) { s.unconfirmed++; return; }
      s.total++;
      if (t.installed) s.installed++; else s.not_installed++;
      var st = SN.tableState(t);
      if (SN.inScope(t)) {
        s.scope++; s[st] = (s[st] || 0) + 1;
        s.valid += t.n_ok; s.reg += t.n_reg; s.verified += t.n_verified; s.review_recs += t.n_review;
      } else {
        if (st === 'excluded') s.excluded++;
        if (st === 'no_id') s.no_id++;
        s.outside += t.n_reg;
      }
    });
    s.expected = s.scope * 28;
    s.remaining = s.expected - s.valid;
    return s;
  }
  SN.summarize = summarize;

  function build() {
    if (D.built) return;
    D.built = true;
    var v = u.$('#view-dashboard');
    u.clear(v);
    v.appendChild(el('div.page',
      el('div.page-head', el('div', el('h1', 'Dashboard'), el('p.muted#dash-sub', '')),
        SN.can.export() ? el('div.row', el('button.btn', { type: 'button', on: { click: exportDialog } }, u.icon('download'), 'Export')) : null),
      el('div.filters.card#dash-filters'),
      el('div#dash-kpis'),
      el('div.grid2', el('div.card#dash-status'), el('div.card#dash-blocks')),
      el('div.card#dash-daily'),
      el('div.card#dash-defs')));
    renderFilters();
    SN.bus.on('tables', u.debounce(function () { if (S.view === 'dashboard') { renderTiles(); loadDaily(); } }, 1500));
    SN.bus.on('users', function () { if (S.view === 'dashboard') renderFilters(); });
  }

  function renderFilters() {
    var f = u.$('#dash-filters'), F = D.filter;
    u.clear(f);
    var block = el('select', { 'aria-label': 'Block' });
    block.appendChild(el('option', { value: '' }, 'All blocks'));
    S.blocks.forEach(function (b) { block.appendChild(el('option', { value: b.name }, 'Block ' + b.name)); });
    block.value = F.block;
    var q = el('input', { type: 'search', placeholder: 'Table ID contains…', value: F.q, 'aria-label': 'Table ID' });
    var usr = el('select', { 'aria-label': 'Registered by' });
    usr.appendChild(el('option', { value: '' }, 'Everyone'));
    Array.from(S.users.values()).filter(function (x) { return x.role !== 'manager'; })
      .sort(function (a, b) { return (a.full_name || a.username) < (b.full_name || b.username) ? -1 : 1; })
      .forEach(function (x) { usr.appendChild(el('option', { value: x.id }, x.full_name || x.username)); });
    usr.value = F.user_id;
    var from = el('input', { type: 'date', value: F.from, 'aria-label': 'From date' });
    var to = el('input', { type: 'date', value: F.to, 'aria-label': 'To date' });
    function apply() {
      F.block = block.value; F.q = q.value.trim(); F.user_id = usr.value; F.from = from.value; F.to = to.value;
      renderTiles(); loadDaily();
    }
    [block, usr, from, to].forEach(function (x) { x.addEventListener('change', apply); });
    q.addEventListener('input', u.debounce(apply, 400));
    f.appendChild(el('label.f', el('span', 'Block'), block));
    f.appendChild(el('label.f', el('span', 'Table ID'), q));
    f.appendChild(el('label.f', el('span', 'Registered by'), usr));
    f.appendChild(el('label.f', el('span', 'From'), from));
    f.appendChild(el('label.f', el('span', 'To'), to));
    f.appendChild(el('button.btn.small.ghost', { type: 'button', on: { click: function () {
      D.filter = { block: '', q: '', user_id: '', from: '', to: '' }; renderFilters(); renderTiles(); loadDaily();
    } } }, 'Reset'));
  }

  function tile(label, value, sub, kind) {
    return el('div.kpi' + (kind ? '.' + kind : ''), el('div.kpi-label', label), el('div.kpi-value', value), sub ? el('div.kpi-sub', sub) : null);
  }

  function renderTiles() {
    var s = summarize(D.filter.block);
    u.$('#dash-sub').textContent = (D.filter.block ? 'Block ' + D.filter.block : 'All blocks') + ' · live figures from the saved module records';
    var k = u.clear(u.$('#dash-kpis'));
    k.appendChild(el('div.kpis',
      tile('Serial-number registration', u.pct(s.valid, s.expected), u.num(s.valid) + ' of ' + u.num(s.expected) + ' modules confirmed and valid', 'hero'),
      tile('Remaining serial numbers', u.num(s.remaining), 'in installed tables in scope'),
      tile('Completed tables', u.num(s.completed || 0), u.pct(s.completed || 0, s.scope) + ' of ' + u.num(s.scope) + ' installed tables in scope'),
      tile('Needs review', u.num(s.review_recs), u.num(s.needs_review || 0) + ' table' + ((s.needs_review || 0) === 1 ? '' : 's') + ' affected', s.review_recs ? 'bad' : ''),
      tile('Verified by QA/QC', u.num(s.verified), u.pct(s.verified, s.valid) + ' of valid records')));
    // status breakdown
    var st = u.clear(u.$('#dash-status'));
    st.appendChild(el('h2', 'Tables by status'));
    st.appendChild(el('p.tot-line', el('strong', u.num(s.total)), ' tables in the layout · ', el('strong', u.num(s.installed)), ' installed · ',
      el('strong', u.num(s.not_installed)), ' not yet installed · ', el('strong', u.num(s.scope)), ' in the registration scope'));
    var segs = [['not_installed', s.not_installed], ['ready', s.ready || 0], ['in_progress', s.in_progress || 0], ['completed', s.completed || 0], ['needs_review', s.needs_review || 0]];
    if (s.excluded) segs.push(['excluded', s.excluded]);
    if (s.no_id) segs.push(['no_id', s.no_id]);
    var tot = segs.reduce(function (a, x) { return a + x[1]; }, 0) || 1;
    var stack = el('div.stack', { role: 'img', 'aria-label': segs.map(function (x) { return u.STATE[x[0]] + ' ' + x[1]; }).join(', ') });
    segs.forEach(function (x) {
      if (!x[1]) return;
      stack.appendChild(el('span.seg', { style: { width: (x[1] / tot * 100) + '%', background: SN.COLORS[x[0]] }, title: u.STATE[x[0]] + ': ' + x[1] }));
    });
    st.appendChild(stack);
    var ul = el('ul.stlist');
    segs.forEach(function (x) {
      ul.appendChild(el('li', el('i.sw', { style: { background: SN.COLORS[x[0]] } }), el('span', u.STATE[x[0]]), el('b', u.num(x[1])),
        el('span.muted', x[0] === 'not_installed' ? 'not counted in progress' : u.pct(x[1], s.scope))));
    });
    st.appendChild(ul);
    if (s.unconfirmed) st.appendChild(el('p.small.muted', s.unconfirmed + ' table IDs drawn without an outline are not counted until the administrator confirms them.'));
    if (s.outside) st.appendChild(el('p.small.muted', s.outside + ' module records sit on tables outside the scope and are not counted.'));
    // per block
    var bl = u.clear(u.$('#dash-blocks'));
    bl.appendChild(el('h2', 'By block'));
    var tbl = el('table.data');
    tbl.appendChild(el('thead', el('tr', el('th', 'Block'), el('th.num', 'Installed'), el('th.num', 'Completed'), el('th.num', 'Review'), el('th.num', 'Valid / expected'), el('th.num', 'Registration'))));
    var tb = el('tbody');
    S.blocks.concat([{ name: '' }]).forEach(function (b) {
      var x = summarize(b.name);
      tb.appendChild(el('tr' + (b.name ? '' : '.total'), el('td', b.name ? 'Block ' + b.name : 'All blocks'),
        el('td.num', u.num(x.installed) + ' / ' + u.num(x.total)), el('td.num', u.num(x.completed || 0)), el('td.num', u.num(x.needs_review || 0)),
        el('td.num', u.num(x.valid) + ' / ' + u.num(x.expected)), el('td.num', u.pct(x.valid, x.expected))));
    });
    tbl.appendChild(tb);
    bl.appendChild(el('div.table-scroll', tbl));
    // definitions
    var defs = u.clear(u.$('#dash-defs'));
    defs.appendChild(el('details', el('summary', 'How these figures are calculated'),
      el('ul.defs',
        el('li', el('strong', 'Registration scope: '), 'tables marked installed, included in scope, and with a table ID (' + u.num(s.scope) + ' tables = ' + u.num(s.expected) + ' expected modules). Tables not yet installed are shown separately and never counted as ready.'),
        el('li', el('strong', 'Serial-number registration % = '), 'valid, confirmed module records ÷ expected modules in the scope × 100.'),
        el('li', el('strong', 'Valid record: '), 'confirmed by the encoder and with no open issue (no duplicate, no mismatch, not flagged). ' +
          ((S.settings.validation || {}).require_qa_for_completion ? 'For completion it must also be verified by QA/QC.' : 'QA/QC verification is tracked separately.')),
        el('li', el('strong', 'Table completion % = '), 'completed tables ÷ installed tables in the scope × 100. A table is completed only when all 28 positions hold valid records.'),
        el('li', el('strong', 'Remaining serial numbers = '), 'expected modules in the scope − valid records.'),
        el('li', el('strong', 'Daily figures (Philippine time): '), '"modules registered" counts current records by the day the position was first registered (a later correction keeps that day). "Tables completed" counts tables by the day they first met the completion rule.'))));
  }

  // ---------- daily accomplishments ----------
  function filterArgs() {
    var F = D.filter;
    return { block: F.block || null, q: F.q || null, user_id: F.user_id ? parseInt(F.user_id, 10) : null, from: F.from || null, to: F.to || null };
  }
  function loadDaily() {
    var box = u.$('#dash-daily');
    if (!D.days) { u.clear(box).appendChild(el('h2', 'Daily accomplishments')); box.appendChild(el('p.muted', 'Loading…')); }
    var my = (D.seq = (D.seq || 0) + 1);
    api.call('sn_daily', { p_filter: filterArgs() }).then(function (r) {
      if (my !== D.seq) return;
      D.days = r.days || [];
      renderDaily();
    }, function (e) { if (e.code !== 'SESSION') { u.clear(box).appendChild(el('h2', 'Daily accomplishments')); box.appendChild(el('p.warn-text', e.message)); } });
  }
  function fillDays(days) {
    if (!days.length) return [];
    var map = {}; days.forEach(function (d) { map[d.d] = d; });
    var start = D.filter.from || days[0].d, end = D.filter.to || u.todayPH();
    if (end < days[days.length - 1].d) end = days[days.length - 1].d;
    var out = [], cur = start, n = 0;
    while (cur <= end && n < 400) { out.push(map[cur] || { d: cur, modules: 0, modules_ok: 0, tables: 0, reopened: 0 }); cur = u.addDays(cur, 1); n++; }
    return out;
  }
  function renderDaily() {
    var box = u.clear(u.$('#dash-daily'));
    box.appendChild(el('div.card-head', el('h2', 'Daily accomplishments'), el('span.muted.small', 'Philippine time · select a day for details')));
    var days = fillDays(D.days || []);
    if (!days.length) { box.appendChild(el('p.muted', 'No modules registered yet for this filter.')); return; }
    var shown = days.length > 45 && !D.filter.from ? days.slice(-45) : days;
    if (shown.length < days.length) box.appendChild(el('p.small.muted', 'Showing the last 45 days. Use the From/To filters for another period.'));
    box.appendChild(barChart(shown, 'modules', 'Modules registered per day'));
    box.appendChild(barChart(shown, 'tables', 'Tables completed per day'));
    var tbl = el('table.data.clickable');
    tbl.appendChild(el('thead', el('tr', el('th', 'Date'), el('th.num', 'Modules registered'), el('th.num', 'of which valid now'), el('th.num', 'Tables completed'))));
    var tb = el('tbody');
    (D.days || []).slice().reverse().forEach(function (d) {
      var tr = el('tr', { tabindex: '0', role: 'button', 'aria-label': 'Open details for ' + u.fmtDateLong(d.d) },
        el('td', u.fmtDateLong(d.d)), el('td.num', u.num(d.modules)), el('td.num', u.num(d.modules_ok)),
        el('td.num', u.num(d.tables) + (d.reopened ? ' (' + d.reopened + ' reopened)' : '')));
      tr.addEventListener('click', function () { openDay(d.d); });
      tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDay(d.d); } });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    box.appendChild(el('details.more', el('summary', 'Table view of every day (' + (D.days || []).length + ')'), el('div.table-scroll', tbl)));
  }

  // Single-series bar chart (SVG). One chart per measure — never two scales on one axis.
  function barChart(days, key, title) {
    var NS = 'http://www.w3.org/2000/svg';
    var wrap = el('figure.chart');
    wrap.appendChild(el('figcaption', title));
    var W = 720, H = 150, padL = 36, padR = 8, padT = 10, padB = 24;
    var max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d[key]; })));
    var nice = max <= 4 ? Math.max(1, max) : niceMax(max);
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'bars');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title + '. ' + days.filter(function (d) { return d[key]; }).length + ' days with activity. Maximum ' + max + '.');
    function node(tag, attrs, text) {
      var n = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      if (text !== undefined) n.textContent = text;
      svg.appendChild(n); return n;
    }
    var ih = H - padT - padB, iw = W - padL - padR, bw = iw / days.length;
    (nice >= 4 ? [0, 0.5, 1] : [0, 1]).forEach(function (f) {
      var y = padT + ih - ih * f;
      node('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: f ? 'grid' : 'axis' });
      node('text', { x: padL - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, u.num(Math.round(nice * f)));
    });
    var every = Math.ceil(days.length / 8);
    var tip = el('div.chart-tip', { hidden: true });
    days.forEach(function (d, i) {
      var v = d[key], h = v ? Math.max(2, ih * v / nice) : 0;
      var w = Math.max(1, Math.min(28, bw - Math.min(2, bw * 0.16))), x = padL + i * bw + (bw - w) / 2;
      if (v) {
        var r = Math.min(4, w / 2, h);
        var y0 = padT + ih, y1 = y0 - h;
        node('path', { class: 'bar', d: 'M' + x + ',' + y0 + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + w - r) + 'Q' + (x + w) + ',' + y1 + ' ' + (x + w) + ',' + (y1 + r) + 'V' + y0 + 'Z' });
      }
      var hitR = node('rect', { x: padL + i * bw, y: padT, width: bw, height: ih + padB, class: 'hit', tabindex: '-1' });
      hitR.addEventListener('mouseenter', function () {
        tip.hidden = false; u.clear(tip);
        tip.appendChild(el('strong', u.fmtDateShort(d.d)));
        tip.appendChild(el('span', u.num(v) + (key === 'modules' ? ' modules' : ' tables')));
        var pct = (padL + i * bw + bw / 2) / W * 100;
        tip.style.left = 'calc(' + Math.min(88, Math.max(6, pct)) + '% )';
      });
      hitR.addEventListener('mouseleave', function () { tip.hidden = true; });
      hitR.addEventListener('click', function () { openDay(d.d); });
      if (i % every === 0) node('text', { x: padL + i * bw + bw / 2, y: H - 6, class: 'tick', 'text-anchor': 'middle' }, u.fmtDateShort(d.d));
    });
    wrap.appendChild(el('div.chart-box', svg, tip));
    return wrap;
  }
  function niceMax(v) {
    var p = Math.pow(10, Math.floor(Math.log10(v))), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function openDay(date) {
    var body = el('div', el('p.muted', 'Loading…'));
    var m = u.openModal({ title: u.fmtDateLong(date), body: body, wide: true });
    api.call('sn_day', { p_date: date, p_filter: filterArgs() }).then(function (r) {
      u.clear(body);
      body.appendChild(el('div.kpis.two',
        tile('Modules registered that day', u.num(r.modules), 'current records first registered on this day'),
        tile('Tables completed that day', u.num(r.tables_completed), 'first time all 28 modules were valid')));
      if (!r.rows.length) { body.appendChild(el('p.muted', 'Nothing recorded on this day for the selected filter.')); return; }
      var tbl = el('table.data.clickable');
      tbl.appendChild(el('thead', el('tr', el('th', 'Table ID'), el('th', 'Block'), el('th.num', 'Registered that day'), el('th.num', 'Valid now'), el('th', 'Status'), el('th', 'By'))));
      var tb = el('tbody');
      r.rows.forEach(function (x) {
        var t = S.tables.get(x.table_id);
        var st = t ? SN.tableState(t) : 'in_progress';
        var tr = el('tr', { tabindex: '0', role: 'button' },
          el('td.mono', x.label || '—'), el('td', x.block), el('td.num', u.num(x.n_day)),
          el('td.num', x.n_ok + ' / 28'),
          el('td', SN.stateBadge(st), x.completed_day ? el('span.chip.ok', 'Completed this day') : null, x.completed_day && !x.complete_now ? el('span.chip.warn', 'Reopened later') : null),
          el('td.small', (x.users || []).map(SN.userName).join(', ')));
        var open = function () { m.close(); SN.go('#/keyplan/t/' + x.table_id); };
        tr.addEventListener('click', open);
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') open(); });
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      body.appendChild(el('div.table-scroll', tbl));
      body.appendChild(el('p.small.muted', 'Select a table to open its 28-module grid, serial numbers and photos.'));
    }, function (e) { u.clear(body).appendChild(el('p.warn-text', e.message)); });
  }
  SN.openDay = openDay;

  // ---------- exports ----------
  var REC_HEADER = ['Record ID', 'Table ref', 'Block', 'Table ID', 'DWG handle', 'Position no.', 'Row', 'Column', 'Module ID', 'Serial number',
    'Barcode value', 'Barcode format', 'OCR text', 'OCR confidence', 'Entry method', 'Validation status', 'Issues', 'Remarks',
    'Saved at (PH)', 'First registered at (PH)', 'Saved by', 'First registered by', 'Reviewed by', 'Reviewed at (PH)', 'Review note',
    'Photo reference', 'Replaces record', 'End reason', 'Open in app'];
  var TABLE_HEADER = ['Table ref', 'Block', 'Table ID', 'DWG handle', 'ID in drawing', 'Installation', 'In scope', 'Registered', 'Valid',
    'Needs review', 'Verified', 'Status', 'First completed (PH)', 'Assigned to', 'Open drawing issues'];
  function appLink(tid, r, c) { return location.origin + location.pathname + '#/keyplan/t/' + tid + (r ? '/m/' + r + '-' + c : ''); }

  function fetchAll(kind, block, progress) {
    var rows = [], after = 0;
    function next() {
      return api.call('sn_export', { p_kind: kind, p_filter: { block: block || null }, p_after: after, p_limit: 5000 }).then(function (r) {
        rows = rows.concat(r.rows || []); after = r.last_id || after;
        if (progress) progress(rows.length);
        return r.done ? rows : next();
      });
    }
    return next();
  }
  function recordRows(rows) {
    return rows.map(function (x) {
      var out = x.slice();
      out[13] = out[13] === null ? null : Math.round(out[13] * 10) / 10;
      out.push(appLink(x[1], x[6], x[7]));
      return out;
    });
  }
  function exportDialog() {
    var block = el('select');
    block.appendChild(el('option', { value: '' }, 'All blocks'));
    S.blocks.forEach(function (b) { block.appendChild(el('option', { value: b.name }, 'Block ' + b.name)); });
    block.value = D.filter.block;
    var what = el('div.radios',
      radio('exp', 'records', 'Module records (current serial numbers, one row per module)', true),
      radio('exp', 'tables', 'Table summary (status of every table)'),
      radio('exp', 'daily', 'Daily accomplishments (current dashboard filter)'),
      radio('exp', 'history', 'Full history (every saved, corrected and removed record)'),
      radio('exp', 'all', 'Excel workbook with records, tables and daily sheets'));
    var fmt = el('div.radios.inline', radio('fmt', 'xlsx', 'Excel (.xlsx)', true), radio('fmt', 'csv', 'CSV'));
    var prog = el('p.small.muted', { 'aria-live': 'polite' });
    u.openModal({
      title: 'Export',
      body: el('div', el('label.field', el('span', 'Block'), block), el('fieldset', el('legend', 'Data'), what), el('fieldset', el('legend', 'Format'), fmt),
        el('p.small.muted', 'Photos stay in the private store; each record row has a link that opens it in the app (sign-in required).'), prog),
      actions: [{ label: 'Close' }, { label: 'Download', kind: 'primary', onClick: function (m, btn) {
        var kind = what.querySelector('input:checked').value, f = fmt.querySelector('input:checked').value;
        btn.disabled = true;
        runExport(kind, f, block.value, function (msg) { prog.textContent = msg; }).then(function () {
          btn.disabled = false; prog.textContent = 'Done.';
        }, function (e) { btn.disabled = false; prog.textContent = e.message; });
        return false;
      } }]
    });
  }
  function radio(name, value, label, checked) {
    var id = 'r-' + name + '-' + value;
    return el('label.check', { for: id }, el('input', { type: 'radio', name: name, value: value, id: id, checked: !!checked }), el('span', label));
  }
  function stamp() { return u.todayPH().replace(/-/g, ''); }
  function runExport(kind, f, block, progress) {
    var name = 'PV-serials' + (block ? '-' + block : '') + '-' + stamp();
    var sheets = [];
    var jobs = [];
    if (kind === 'records' || kind === 'all') jobs.push(fetchAll('records', block, function (n) { progress('Module records: ' + n + ' rows…'); }).then(function (rows) { sheets.push({ name: 'Module records', header: REC_HEADER, rows: recordRows(rows) }); }));
    if (kind === 'history') jobs.push(fetchAll('history', block, function (n) { progress('History: ' + n + ' rows…'); }).then(function (rows) { sheets.push({ name: 'Full history', header: REC_HEADER, rows: recordRows(rows) }); }));
    if (kind === 'tables' || kind === 'all') jobs.push(fetchAll('tables', block, function (n) { progress('Tables: ' + n + ' rows…'); }).then(function (rows) {
      sheets.push({ name: 'Table summary', header: TABLE_HEADER.concat(['Open in app']), rows: rows.map(function (x) { return x.concat([appLink(x[0])]); }) });
    }));
    if (kind === 'daily' || kind === 'all') jobs.push(api.call('sn_daily', { p_filter: Object.assign(filterArgs(), { block: block || null }) }).then(function (r) {
      sheets.push({ name: 'Daily accomplishments', header: ['Date (PH)', 'Modules registered', 'Of which valid now', 'Tables completed (first time)', 'Of which reopened later'],
        rows: (r.days || []).map(function (d) { return [d.d, d.modules, d.modules_ok, d.tables, d.reopened]; }) });
    }));
    return Promise.all(jobs).then(function () {
      var order = ['Module records', 'Full history', 'Table summary', 'Daily accomplishments'];
      sheets.sort(function (a, b) { return order.indexOf(a.name) - order.indexOf(b.name); });
      if (f === 'csv') {
        sheets.forEach(function (sh) { u.download(name + '-' + sh.name.toLowerCase().replace(/\s+/g, '-') + '.csv', SN.exporter.csv(sh.header, sh.rows)); });
      } else {
        u.download(name + (kind === 'all' ? '' : '-' + kind) + '.xlsx', SN.exporter.xlsx(sheets));
      }
    });
  }
  SN.runExport = runExport;

  SN.views.register('dashboard', {
    init: function () { },
    show: function (args) {
      build(); renderTiles(); loadDaily();
      if (args[0] === 'day' && args[1]) openDay(args[1]);
    },
    reset: function () { D.built = false; D.days = null; }
  });
})();
