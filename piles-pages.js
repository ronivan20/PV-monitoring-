/* Solar PV Installation Monitoring — Piles module (update 8): dashboard, setup
   (import, work areas, statuses, targets, storage) and exports. Pile counts are
   kept apart from the Mounting Structure and PV Module table counts. */
(function () {
  'use strict';

  var Pi = window.PVMPiles; if (!Pi || !Pi._) return;
  var I = Pi._, X = I.X, PS = I.PS, S = X.S, h = X.h, $ = X.$, $$ = X.$$, call = X.call, toast = X.toast, openModal = X.openModal, closeModal = X.closeModal;
  var plural = X.plural, fmtTime = X.fmtTime, fmtDate = X.fmtDate, pct1 = X.pct1, addDays = X.addDays;
  var stOf = I.stOf, inspOf = I.inspOf, openCases = I.openCases, coOf = I.coOf, areaName = I.areaName, counts = I.counts, sw = I.sw;
  function ap(el) { for (var i = 1; i < arguments.length; i++) X.append(el, arguments[i]); return el; }

  var D = { block: 'all', company: 'all', area: 'all', status: 'all', from: null, to: null, page: 0, q: '', tb: null, tbKey: '', rec: null, recKey: '', act: null, fmt: 'xlsx' };
  var U = { tab: 'import', imp: null, imports: null, storage: null, tf: null, tl: { from: null, to: null }, tlData: null, tlKey: '' };
  Pi.resetPages = function () {
    D.tb = null; D.tbKey = ''; D.rec = null; D.recKey = ''; D.act = null; D.page = 0; D.company = 'all'; D.area = 'all';
    U.imp = null; U.imports = null; U.storage = null; U.tf = null; U.tlData = null; U.tlKey = '';
  };
  function companyName(id) { return X.companyName(id) || '—'; }
  function ensureDates() {
    if (!D.from) { D.to = PS.siteDate || S.siteDate; D.from = addDays(D.to, -6); }
  }
  function keepScroll(root, reset, fn) {
    var sc = root.parentElement, y = sc.scrollTop; fn(); if (!reset) sc.scrollTop = y; else sc.scrollTop = 0;
  }

  // ------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------
  function dPass(p, withStatus) {
    if (D.block !== 'all' && String(p.block) !== D.block) return false;
    if (D.company !== 'all') { var c = coOf(p); if (D.company === 'none' ? c != null : String(c) !== D.company) return false; }
    if (D.area !== 'all') { if (D.area === 'none' ? p.area != null : String(p.area) !== D.area) return false; }
    if (withStatus && D.status !== 'all') {
      if (D.status === 'case') { if (!openCases(p).length) return false; }
      else if (D.status === 'off') { if (p.active) return false; }
      else if (!p.active || 's' + stOf(p).id !== D.status) return false;
    }
    return true;
  }
  function tPass(r) {
    return (D.company === 'all' || String(r.company_id) === D.company) && (D.block === 'all' || String(r.block) === D.block)
      && (D.area === 'all' || (D.area === 'none' ? r.work_area_id == null : String(r.work_area_id) === D.area));
  }
  function loadBoard() {
    var key = D.from + '|' + D.to;
    if (D.tbKey === key && D.tb) return;
    D.tbKey = key; D.tb = null;
    call('get_pile_target_board', { p_from: D.from, p_to: D.to }).then(function (d) { if (D.tbKey === key) { D.tb = d; render(); } })
      .catch(function (e) { if (D.tbKey === key) { D.tb = { error: e.message, targets: [], untargeted: [], done: [], accepted: [] }; render(); } });
    call('get_pile_records', { p_from: D.from, p_to: D.to }).then(function (d) { if (D.tbKey === key) { D.rec = d; render(); } })
      .catch(function (e) { if (D.tbKey === key) { D.rec = { error: e.message, cases: [], inspections: [] }; render(); } });
  }
  function render() { if (PS.visible && PS.sub === 'dashboard') Pi.renderDashboard(); }
  Pi.renderDashboard = function (reset) {
    var root = $('#ppage'); if (!root) return;
    if (!PS.loaded) { root.textContent = ''; ap(root, h('p', { class: 'small muted', text: 'Loading piles…' })); return; }
    ensureDates(); loadBoard();
    if (!D.act && !X.isSub()) {
      D.act = 'loading';
      call('get_pile_activity', { p_limit: 60 }).then(function (d) { D.act = d.events; render(); }).catch(function () { D.act = []; });
    }
    keepScroll(root, reset, function () { root.textContent = ''; build(root); });
  };
  function build(root) {
    ap(root, h('div', { class: 'page-head' },
      h('div', null, h('h1', { text: 'Piles installation dashboard' }),
        h('p', { text: 'Counts are piles, from the imported pile layout. They are kept separate from the Mounting Structure and PV Module table counts.' + (X.isSub() ? ' You see the piles assigned to your company.' : '') }))));
    if (X.isSub()) { var big = I.todayTargetCard(false); if (big) ap(root, big); }
    if (!PS.piles.length) {
      ap(root, h('div', { class: 'card empty-state' }, X.isAdmin() ? 'No pile layout has been imported yet. Import the pile list under Pile setup → Import.' : 'No piles to show yet.'));
      return;
    }
    ap(root, filtersCard());
    var base = PS.piles.filter(function (p) { return dPass(p, false); }), c = counts(base);
    ap(root, kpis(c));
    ap(root, blockProgress());
    ap(root, targetCard());
    ap(root, contractorCard(base));
    ap(root, areaCard(base));
    ap(root, recordsCard());
    ap(root, pileList());
    if (X.isAdmin()) ap(root, exportsCard());
    if (!X.isSub() && Array.isArray(D.act) && D.act.length) ap(root, activityCard());
  }
  function filtersCard() {
    function sel(id, label, key, opts, onch) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { D[key] = e.target.value; D.page = 0; if (onch) onch(); Pi.renderDashboard(); } },
          opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(D[key]) === String(o[0]) }); })));
    }
    function dateIn(id, label, key) {
      var i = h('input', { id: id, type: 'date', value: D[key] || '' });
      i.addEventListener('change', function () { D[key] = i.value || D[key]; if (D.to < D.from) { if (key === 'from') D.to = D.from; else D.from = D.to; } Pi.renderDashboard(); });
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), i);
    }
    var cos = new Map(); PS.asg.forEach(function (c) { cos.set(c, 1); });
    var areas = PS.areas.filter(function (a) { return D.block === 'all' || String(a.block) === D.block; });
    var stOpts = [['all', 'All statuses']].concat(PS.statuses.map(function (s) { return ['s' + s.id, s.label]; })).concat([['case', 'Open refusal / rectification case'], ['off', 'Out of scope']]);
    return h('div', { class: 'card' }, h('div', { class: 'filters pd-filters' },
      sel('pd-block', 'Block', 'block', [['all', 'Both blocks'], ['1', 'Block 1'], ['5', 'Block 5']], function () { D.area = 'all'; }),
      X.isSub() ? null : sel('pd-co', 'Contractor', 'company', [['all', 'All contractors'], ['none', 'No contractor']].concat(Array.from(cos.keys()).sort(function (a, b) { return companyName(a).localeCompare(companyName(b)); }).map(function (c) { return [String(c), companyName(c)]; }))),
      sel('pd-area', 'Work area', 'area', [['all', 'All work areas'], ['none', 'No work area']].concat(areas.map(function (a) { return [String(a.id), (D.block === 'all' ? 'B' + a.block + ' · ' : '') + a.name]; }))),
      sel('pd-status', 'Status (pile list)', 'status', stOpts),
      dateIn('pd-from', 'From (targets and records)', 'from'), dateIn('pd-to', 'To', 'to')),
      h('p', { class: 'hint filters-note', text: 'Block, contractor and work area filter every part of the page. The status filter narrows the pile list. The dates set the period for targets, accomplishment, inspections and cases.' }));
  }
  function kpi(label, n, total, color, note, id) {
    var k = h('div', { class: 'kpi pkpi', id: id || null }, h('span', { class: 'k-label', text: label }),
      h('span', { class: 'k-num' }, String(n), total != null ? h('small', { text: ' ' + X.fmtPct(n, total) }) : null), note ? h('span', { class: 'k-note', text: note }) : null);
    if (color) k.style.borderTop = '4px solid ' + color;
    return k;
  }
  function kpis(c) {
    var wrap = h('div', { class: 'card' }, h('h2', { text: 'Pile scope and status' }));
    var grid = h('div', { class: 'kpis' },
      kpi('Total pile scope', c.total, null, '#15212c', c.off ? c.off + ' more out of scope (not counted)' : 'piles in the monitoring scope', 'pk-total'),
      kpi('Reported complete', c.reported, c.total, '#6cc070', 'completed, for reinspection or accepted', 'pk-reported'),
      kpi('Accepted / verified', c.cat.accepted || 0, c.total, '#166534', 'accepted by the inspector', 'pk-accepted'),
      kpi('Remaining', c.remaining, c.total, '#c3cad2', 'not yet reported complete', 'pk-remaining'));
    var grid2 = h('div', { class: 'kpis pkpis-st' }, PS.statuses.filter(function (s) { return s.is_active || c.st.get(s.id); }).map(function (s) {
      return kpi(s.label, c.st.get(s.id) || 0, c.total, s.color, s.key.indexOf('custom_') === 0 ? 'counts as: ' + I.CAT_LABEL[s.category].toLowerCase() : null);
    }));
    var notAcc = c.total - (c.cat.accepted || 0);
    ap(wrap, grid, h('h3', { class: 'ph3', text: 'By status' }), grid2,
      h('p', { class: 'small muted', text: 'Completed piles are not accepted until the inspector records it: ' + notAcc + ' piles are not yet accepted. ' + (c.cases ? plural(c.cases, 'pile') + (c.cases === 1 ? ' has' : ' have') + ' an open refusal or rectification case.' : 'No open refusal or rectification case.') }));
    return wrap;
  }
  function bar(c) {
    var b = h('div', { class: 'pbar big' });
    PS.statuses.forEach(function (s) { var n = c.st.get(s.id) || 0; if (!n) return; var sp = h('span', { color: s.color, title: s.label + ': ' + n }); sp.style.width = (100 * n / Math.max(1, c.total)) + '%'; ap(b, sp); });
    return b;
  }
  function blockProgress() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Block 1 and Block 5 progress' }));
    var prog = h('div', { class: 'prog' });
    [1, 5].forEach(function (b) {
      if (D.block !== 'all' && String(b) !== D.block) return;
      var list = PS.piles.filter(function (p) { return p.block === b && dPass(p, false); }), c = counts(list);
      ap(prog, h('div', { class: 'prog-row' },
        h('div', { class: 'p-label', text: 'Block ' + b + ' · ' + plural(c.total, 'pile') }), bar(c),
        h('div', { class: 'p-nums' }, h('span', { text: 'Reported complete ' + c.reported + ' (' + X.fmtPct(c.reported, c.total) + ')' }),
          h('span', { text: 'Accepted ' + (c.cat.accepted || 0) + ' (' + X.fmtPct(c.cat.accepted || 0, c.total) + ')' }), h('span', { text: 'Remaining ' + c.remaining }))));
    });
    ap(card, prog, h('div', { class: 'legend-inline' }, PS.statuses.filter(function (s) { return s.is_active; }).map(function (s) { return h('span', null, sw(s.color), s.label); })));
    return card;
  }
  function targetCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Daily target vs accomplished · ' + fmtDate(D.from) + (D.to !== D.from ? ' – ' + fmtDate(D.to) : '') }));
    var tb = D.tb;
    if (!tb) { ap(card, h('p', { class: 'small muted', text: 'Loading targets…' })); return card; }
    if (tb.error) { ap(card, h('p', { class: 'form-error', text: tb.error })); return card; }
    var rows = tb.targets.filter(tPass);
    var done = (tb.done || []).filter(function (r) { return tPass({ company_id: r[0], block: r[1], work_area_id: r[2] }); });
    var acc = (tb.accepted || []).filter(function (r) { return tPass({ company_id: r[0], block: r[1], work_area_id: r[2] }); });
    var byDate = new Map();
    function day(d) { var x = byDate.get(d); if (!x) byDate.set(d, x = { t: 0, a: 0, v: 0 }); return x; }
    rows.forEach(function (r) { day(r.date).t += r.quantity; });
    done.forEach(function (r) { day(r[3]).a += r[4]; });
    acc.forEach(function (r) { day(r[3]).v += r[4]; });
    var tq = 0, ta = 0, tv = 0; byDate.forEach(function (x) { tq += x.t; ta += x.a; tv += x.v; });
    ap(card, h('p', { class: 'small', text: 'Period total: target ' + tq + ', accomplished ' + ta + ' (reported complete, counted once per pile), accepted ' + tv + '.' + (tq ? ' Achievement ' + pct1(ta, tq) + '.' : '') }));
    if (byDate.size) {
      var max = 1; byDate.forEach(function (x) { max = Math.max(max, x.t, x.a); });
      ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable pdays' },
        h('thead', null, h('tr', null, ['Date', 'Target', 'Accomplished', 'Accepted', 'Achieved', ''].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, Array.from(byDate.keys()).sort().reverse().map(function (d) {
          var x = byDate.get(d), b1 = h('span', { class: 'pd-t' }), b2 = h('span', { class: 'pd-a' });
          b1.style.width = (100 * x.t / max) + '%'; b2.style.width = (100 * x.a / max) + '%';
          return h('tr', null, h('td', { class: 'nowrap', text: fmtDate(d) }), h('td', { class: 'num', text: x.t ? String(x.t) : '—' }), h('td', { class: 'num', text: String(x.a) }),
            h('td', { class: 'num', text: String(x.v) }), h('td', { class: 'num', text: x.t ? pct1(x.a, x.t) : '—' }), h('td', { class: 'pd-bars' }, h('div', null, b1), h('div', null, b2)));
        })))));
    }
    if (rows.length) {
      ap(card, h('h3', { class: 'ph3', text: 'Targets' }), h('div', { class: 'table-wrap' }, h('table', { class: 'dtable tgt-table ptgt' },
        h('thead', null, h('tr', null, ['Date', 'Contractor', 'Block / work area', 'Target', 'Accomplished', 'Accepted', 'Remaining', 'Achieved', ''].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, rows.map(function (r) {
          return h('tr', null, h('td', { class: 'nowrap', text: fmtDate(r.date) }), h('td', null, X.cchip(r.company_id)),
            h('td', { text: 'Block ' + r.block + (r.work_area ? ' · ' + r.work_area : ' · whole block') }),
            h('td', { class: 'num' }, String(r.quantity), r.revision ? h('div', { class: 'small muted', text: 'revised (was ' + r.original_quantity + ')' }) : null),
            h('td', { class: 'num', text: String(r.accomplished) }), h('td', { class: 'num', text: String(r.accepted) }),
            h('td', { class: 'num', text: String(Math.max(0, r.quantity - r.accomplished)) }), h('td', { class: 'num', text: pct1(r.accomplished, r.quantity) }),
            h('td', { class: 'nowrap' }, X.tgtIndicator(r.accomplished, r.quantity), ' ', h('button', { type: 'button', class: 'link-btn', text: 'History', onclick: function () { targetHistory(r); } })));
        })))));
    } else ap(card, h('p', { class: 'small muted', text: 'No pile targets in this period for these filters.' }));
    var extra = (tb.untargeted || []).filter(tPass);
    if (extra.length) ap(card, h('p', { class: 'small', text: 'Accomplished on days without a target: ' + extra.map(function (r) { return companyName(r.company_id) + ' B' + r.block + ' ' + fmtDate(r.date) + ': ' + r.accomplished; }).join(' · ') }));
    ap(card, h('p', { class: 'small muted', text: 'Accomplished = piles first reported complete on that date (Philippine time), counted once per pile even if saved again. Accepted = piles first accepted by the inspector on that date.' }));
    return card;
  }
  function targetHistory(t) {
    call('get_pile_target_revisions', { p_target_id: t.id }).then(function (d) {
      openModal('Target history · ' + companyName(t.company_id), [
        h('p', { class: 'small', text: 'Block ' + t.block + (t.work_area ? ' · ' + t.work_area : '') + ' · ' + fmtDate(t.date) + '. The dashboard uses the current quantity: ' + t.quantity + ' piles.' }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
          h('thead', null, h('tr', null, ['When', 'Change', 'Quantity', 'Instructions', 'By'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, d.revisions.map(function (r) {
            return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(r.at) }), h('td', { text: r.action === 'created' ? 'Set' : r.action === 'revised' ? 'Revised' : 'Removed' }),
              h('td', { text: r.action === 'revised' ? r.prev_quantity + ' → ' + r.new_quantity : String(r.new_quantity != null ? r.new_quantity : r.prev_quantity) }),
              h('td', { text: (r.action === 'removed' ? r.prev_remarks : r.new_remarks) || '—' }), h('td', { text: r.username }));
          })))),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', text: 'Close', onclick: closeModal }))]);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function contractorCard(base) {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Contractor performance' }));
    var rows = new Map();
    function row(cid) { var r = rows.get(cid); if (!r) rows.set(cid, r = { list: [], t: 0, a: 0, v: 0 }); return r; }
    base.forEach(function (p) { row(coOf(p)).list.push(p); });
    var tb = D.tb && !D.tb.error ? D.tb : null;
    if (tb) {
      tb.targets.filter(tPass).forEach(function (r) { row(r.company_id).t += r.quantity; });
      (tb.done || []).forEach(function (r) { if (tPass({ company_id: r[0], block: r[1], work_area_id: r[2] })) row(r[0]).a += r[4]; });
      (tb.accepted || []).forEach(function (r) { if (tPass({ company_id: r[0], block: r[1], work_area_id: r[2] })) row(r[0]).v += r[4]; });
    }
    var keys = Array.from(rows.keys()).sort(function (a, b) { return a == null ? 1 : b == null ? -1 : companyName(a).localeCompare(companyName(b)); });
    ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable pco' },
      h('thead', null, h('tr', null, ['Contractor', 'Piles', 'Reported complete', 'Accepted', 'Remaining', 'Open cases', 'Period target', 'Period accomplished', 'Achieved'].map(function (x, i) { return h('th', { class: i ? 'num' : null, text: x }); }))),
      h('tbody', null, keys.map(function (k) {
        var r = rows.get(k), c = counts(r.list);
        return h('tr', null, h('td', null, k == null ? h('span', { class: 'pill', text: 'No contractor' }) : X.cchip(k)),
          h('td', { class: 'num', text: String(c.total) }), h('td', { class: 'num', text: c.reported + ' (' + X.fmtPct(c.reported, c.total) + ')' }),
          h('td', { class: 'num', text: (c.cat.accepted || 0) + ' (' + X.fmtPct(c.cat.accepted || 0, c.total) + ')' }), h('td', { class: 'num', text: String(c.remaining) }),
          h('td', { class: 'num', text: String(c.cases) }), h('td', { class: 'num', text: r.t ? String(r.t) : '—' }), h('td', { class: 'num', text: String(r.a) }),
          h('td', { class: 'num', text: r.t ? pct1(r.a, r.t) : '—' }));
      })))));
    ap(card, h('p', { class: 'small muted', text: 'Piles and status are the current assignment. Period figures count the piles each contractor first reported complete in the chosen dates.' }));
    return card;
  }
  function areaCard(base) {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Work areas' }));
    var by = new Map();
    base.forEach(function (p) { var k = p.area == null ? 'none' : p.area; var l = by.get(k); if (!l) by.set(k, l = []); l.push(p); });
    var keys = Array.from(by.keys()).sort(function (a, b) {
      if (a === 'none') return 1; if (b === 'none') return -1;
      var A = PS.areaById.get(a), B = PS.areaById.get(b); return A.block - B.block || X.cmpCode(A.name, B.name);
    });
    ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Work area', 'Piles', 'Reported complete', 'Accepted', 'Remaining', 'Progress'].map(function (x, i) { return h('th', { class: i && i < 5 ? 'num' : null, text: x }); }))),
      h('tbody', null, keys.map(function (k) {
        var l = by.get(k), c = counts(l), a = PS.areaById.get(k);
        return h('tr', null, h('td', { text: a ? 'B' + a.block + ' · ' + a.name : 'No work area' }), h('td', { class: 'num', text: String(c.total) }),
          h('td', { class: 'num', text: String(c.reported) }), h('td', { class: 'num', text: String(c.cat.accepted || 0) }), h('td', { class: 'num', text: String(c.remaining) }),
          h('td', { class: 'pd-bars' }, bar(c)));
      })))));
    return card;
  }
  function recordsCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Refusal, rectification and inspections' }));
    var R = D.rec;
    if (!R) { ap(card, h('p', { class: 'small muted', text: 'Loading records…' })); return card; }
    if (R.error) { ap(card, h('p', { class: 'form-error', text: R.error })); return card; }
    function ok(id) { var p = PS.byId.get(id); return p && dPass(p, false); }
    var cases = R.cases.filter(function (c) { return ok(c.pile_id); });
    var openC = cases.filter(function (c) { return c.resolution_status === 'open' || c.resolution_status === 'in_progress'; });
    ap(card, h('h3', { class: 'ph3', text: 'Open and recently changed cases (' + openC.length + ' open)' }));
    if (cases.length) ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable pcases' },
      h('thead', null, h('tr', null, ['Pile', 'Type', 'Encountered', 'Details', 'Corrective action', 'Responsible', 'Status'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, cases.slice(0, 200).map(function (c) {
        var open = c.resolution_status === 'open' || c.resolution_status === 'in_progress';
        return h('tr', null, h('td', null, h('button', { type: 'button', class: 'link-btn tid', text: c.pile_code, onclick: function () { I.openPile(c.pile_id); } }), h('div', { class: 'small muted', text: 'B' + c.block + (c.work_area ? ' · ' + c.work_area : '') })),
          h('td', { text: I.CASE_KIND[c.kind] }), h('td', { class: 'nowrap', text: fmtDate(c.date_encountered) }), h('td', { text: c.details }),
          h('td', { text: c.corrective_action || '—' }), h('td', { text: c.responsible_party || '—' }),
          h('td', null, h('span', { class: 'pill ' + (open ? 'off' : 'on'), text: I.CASE_ST[c.resolution_status] }), c.resolution_date ? h('div', { class: 'small muted', text: fmtDate(c.resolution_date) }) : null));
      })))));
    else ap(card, h('p', { class: 'small muted', text: 'No refusal or rectification cases for these filters.' }));
    var ins = R.inspections.filter(function (i) { return ok(i.pile_id); });
    var byS = new Map(); ins.forEach(function (i) { byS.set(i.status_label, (byS.get(i.status_label) || 0) + 1); });
    ap(card, h('h3', { class: 'ph3', text: 'Inspection records in the period (' + ins.length + ')' }),
      ins.length ? h('p', { class: 'small', text: Array.from(byS.entries()).map(function (e) { return e[0] + ': ' + e[1]; }).join(' · ') }) : h('p', { class: 'small muted', text: 'No inspections recorded in this period.' }));
    if (ins.length) ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Recorded', 'Pile', 'Result', 'Inspection date', 'Inspector', 'Approved', 'Pile status set'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, ins.slice(0, 100).map(function (i) {
        var s = PS.istById.get(i.status_id);
        return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(i.created_at) }),
          h('td', null, h('button', { type: 'button', class: 'link-btn tid', text: i.pile_code, onclick: function () { I.openPile(i.pile_id); } })),
          h('td', null, I.pchip(s ? s.color : '#999999', i.status_label)), h('td', { class: 'nowrap', text: i.inspection_date ? fmtDate(i.inspection_date) : '—' }),
          h('td', { text: i.inspector || i.username }), h('td', { class: 'nowrap', text: i.approval_date ? fmtDate(i.approval_date) : '—' }), h('td', { text: i.pile_status_set || '—' }));
      })))), ins.length > 100 ? h('p', { class: 'small muted', text: 'Showing the latest 100. The administrator can export all records.' }) : null);
    return card;
  }
  function pileList() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Pile list' }));
    var q = h('input', { id: 'pd-q', type: 'search', placeholder: 'Find pile ID or table ID', value: D.q, autocomplete: 'off', 'aria-label': 'Find pile ID or table ID' });
    q.addEventListener('input', function () { D.q = q.value; D.page = 0; var pos = q.selectionStart; Pi.renderDashboard(); var nq = $('#pd-q'); if (nq) { nq.focus(); try { nq.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } });
    var n = String(D.q || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var list = PS.piles.filter(function (p) {
      if (!dPass(p, true)) return false;
      if (!n) return true;
      return String(p.code).toUpperCase().replace(/[^A-Z0-9]/g, '').indexOf(n) >= 0 || String(p.table || '').toUpperCase().replace(/[^A-Z0-9]/g, '').indexOf(n) >= 0;
    }).sort(function (a, b) { return a.block - b.block || X.cmpCode(a.code, b.code); });
    var per = 50, pages = Math.max(1, Math.ceil(list.length / per)); if (D.page >= pages) D.page = pages - 1;
    ap(card, h('div', { class: 'tool-row' }, h('div', { class: 'search pd-search' }, q), h('span', { class: 'small', text: plural(list.length, 'pile') })));
    ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable plist' },
      h('thead', null, h('tr', null, ['Pile ID', 'Block', 'Work area', 'Table', 'Contractor', 'Status', 'Inspection', 'Case'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, list.slice(D.page * per, D.page * per + per).map(function (p) {
        var cs = openCases(p);
        return h('tr', null, h('td', null, h('button', { type: 'button', class: 'link-btn tid', text: p.code, onclick: function () { I.openPile(p.id); } })),
          h('td', { text: String(p.block) }), h('td', { text: areaName(p.area) || '—' }), h('td', { text: p.table || '—' }),
          h('td', null, I.coChip(coOf(p))), h('td', null, p.active ? I.stChip(stOf(p)) : h('span', { class: 'pill', text: 'Out of scope' })),
          h('td', null, I.iChip(inspOf(p))), h('td', null, cs.length ? cs.map(I.caseChip) : '—'));
      })))));
    if (pages > 1) ap(card, h('div', { class: 'pager' }, h('span', { text: 'Page ' + (D.page + 1) + ' of ' + pages }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', disabled: D.page === 0, text: 'Previous', onclick: function () { D.page--; Pi.renderDashboard(); } }),
        h('button', { type: 'button', class: 'btn small', disabled: D.page >= pages - 1, text: 'Next', onclick: function () { D.page++; Pi.renderDashboard(); } }))));
    return card;
  }
  function activityCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Recent pile activity' }));
    var KIND = { status: 'Status update', inspection: 'Inspection', 'case': 'Case', assign: 'Contractor assignment', import: 'Pile import' };
    ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['When', 'By', 'What', 'Piles', 'Details'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, D.act.slice(0, 40).map(function (e) {
        return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(e.at) }), h('td', { text: e.username }),
          h('td', { text: (KIND[e.kind] || e.kind) + ': ' + e.label }), h('td', { class: 'num', text: String(e.n) + (e.unchanged ? ' (+' + e.unchanged + ' unchanged)' : '') }),
          h('td', { class: 'small', text: [e.detail, e.remarks, e.codes && e.codes.length ? e.codes.slice(0, 12).join(', ') + (e.n > 12 ? ' …' : '') : null].filter(Boolean).join(' · ') }));
      })))));
    return card;
  }

  // ------------------------------------------------------------------
  // Exports (administrator): Excel (.xlsx) or CSV
  // ------------------------------------------------------------------
  function exportsCard() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Reports and exports' }),
      h('p', { class: 'card-sub', text: 'Download the records as Excel or CSV. Period reports use the dates chosen above (' + fmtDate(D.from) + ' – ' + fmtDate(D.to) + ').' }));
    var fmt = h('div', { class: 'seg', role: 'group', 'aria-label': 'File format' },
      [['xlsx', 'Excel (.xlsx)'], ['csv', 'CSV']].map(function (f) { return h('button', { type: 'button', 'aria-pressed': String(D.fmt === f[0]), text: f[1], onclick: function () { D.fmt = f[0]; Pi.renderDashboard(); } }); }));
    function b(id, label, fn) { return h('button', { type: 'button', class: 'btn small', id: id, text: label, onclick: function (e) { var btn = e.currentTarget; btn.disabled = true; Promise.resolve(fn()).catch(function (er) { toast(er.message, 'err'); }).then(function () { btn.disabled = false; }); } }); }
    ap(card, h('div', { class: 'tool-row' }, fmt),
      h('div', { class: 'btn-row' },
        b('px-register', 'Pile register', exportRegister), b('px-daily', 'Daily accomplishment report', exportDaily), b('px-insp', 'Inspection records', exportInspections),
        b('px-status', 'Status changes', exportStatusLog), b('px-cases', 'Refusal and rectification cases', exportCases), b('px-asg', 'Contractor assignment changes', exportAssign),
        b('px-summary', 'Progress summary (current filters)', exportSummary)));
    return card;
  }
  function stampNow() { return X.stamp(); }
  function localTs(v) {
    if (!v) return '';
    var d = new Date(v); if (isNaN(d)) return v;
    function z(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }
  function save(name, header, rows) {
    if (D.fmt === 'csv') X.download(name + '.csv', [header].concat(rows));
    else downloadBlob(name + '.xlsx', xlsxBlob(name.slice(0, 31), header, rows));
    toast('Downloaded ' + plural(rows.length, 'row') + '.', 'ok');
  }
  function downloadBlob(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function exportRegister() {
    return call('admin_pile_register', {}).then(function (d) {
      var col = {}; d.columns.forEach(function (c, i) { col[c] = i; });
      var head = ['Pile ID', 'Block', 'Work area', 'Table', 'Drawing X', 'Drawing Y', 'Pile type', 'Design length (m)', 'In scope', 'Remarks', 'Contractor',
        'Installation status', 'Status since', 'Status by', 'Status remarks', 'Latest inspection', 'Inspection date', 'Approval date', 'Open cases', 'Files',
        'First reported complete', 'First accepted'];
      var rows = d.rows.map(function (r) {
        return [r[col.code], r[col.block], r[col.work_area] || '', r[col.table_code] || '', num(r[col.x]), num(r[col.y]), r[col.pile_type] || '', num(r[col.design_length]),
          r[col.in_scope] ? 'Yes' : 'No', r[col.remarks] || '', r[col.contractor] || '', r[col.status] || PS.notStarted.label, localTs(r[col.status_at]), r[col.status_by] || '',
          r[col.status_remarks] || '', r[col.inspection] || PS.notInspected.label, r[col.inspection_date] || '', r[col.approval_date] || '', r[col.open_cases], r[col.files],
          localTs(r[col.first_completed]), localTs(r[col.first_accepted])];
      });
      save('pile-register-' + stampNow(), head, rows);
    });
  }
  function num(v) { return v == null || v === '' ? '' : +v; }
  function exportDaily() {
    return call('admin_pile_daily_report', { p_from: D.from, p_to: D.to }).then(function (d) {
      save('pile-daily-accomplishment-' + D.from + '-to-' + D.to, ['Date', 'Contractor', 'Block', 'Work area', 'Target (piles)', 'Accomplished (first reported complete)', 'Accepted (first accepted)', 'Remaining target', 'Achieved %'],
        d.rows.map(function (r) { return [r.date, r.company, r.block, r.work_area || '(whole block / none)', r.target || '', r.completed, r.accepted, r.target ? Math.max(0, r.target - r.completed) : '', r.target ? Math.round(1000 * r.completed / r.target) / 10 : '']; }));
    });
  }
  function exportInspections() {
    return call('admin_pile_inspections', { p_from: D.from, p_to: D.to }).then(function (d) {
      save('pile-inspections-' + D.from + '-to-' + D.to, ['Recorded', 'Pile ID', 'Block', 'Inspection status', 'Inspection date', 'Inspector', 'Comments', 'Issues', 'Corrective action', 'Approval date', 'Approved by', 'Reinspection date', 'Reinspection result', 'Pile status set', 'Recorded by'],
        d.rows.map(function (r) { return [localTs(r.recorded), r.pile, r.block, r.status, r.inspection_date || '', r.inspector || '', r.comments || '', r.issues || '', r.corrective_action || '', r.approval_date || '', r.approved_by || '', r.reinspection_date || '', r.reinspection_result || '', r.pile_status_set || '', r.by]; }));
    });
  }
  function exportStatusLog() {
    return call('admin_pile_status_log', { p_from: D.from, p_to: D.to }).then(function (d) {
      var col = {}; d.columns.forEach(function (c, i) { col[c] = i; });
      save('pile-status-changes-' + D.from + '-to-' + D.to, ['Saved at', 'Pile ID', 'Block', 'Work area', 'Previous status', 'New status', 'Contractor', 'Saved by', 'Remarks', 'Source', 'Batch'],
        d.rows.map(function (r) { return [localTs(r[col.at]), r[col.pile], r[col.block], r[col.work_area] || '', r[col.previous] || '', r[col['new']], r[col.contractor] || '', r[col.by], r[col.remarks] || '', r[col.source], r[col.batch] || '']; }));
    });
  }
  function exportCases() {
    return call('admin_pile_cases', {}).then(function (d) {
      save('pile-refusal-rectification-' + stampNow(), ['Case', 'Pile ID', 'Block', 'Work area', 'Type', 'Date encountered', 'Details', 'Remarks', 'Corrective action', 'Responsible party', 'Resolution status', 'Resolution date', 'Reinspection result', 'Opened by', 'Opened at', 'Last change', 'Changes'],
        d.rows.map(function (r) { return [r['case'], r.pile, r.block, r.work_area || '', I.CASE_KIND[r.kind], r.date_encountered, r.details, r.remarks || '', r.corrective_action || '', r.responsible_party || '', I.CASE_ST[r.resolution_status], r.resolution_date || '', r.reinspection_result || '', r.opened_by, localTs(r.opened_at), localTs(r.updated_at), r.changes]; }));
    });
  }
  function exportAssign() {
    return call('admin_pile_assignment_log', { p_from: D.from, p_to: D.to }).then(function (d) {
      save('pile-assignment-changes-' + D.from + '-to-' + D.to, ['Changed at', 'Pile ID', 'Block', 'Previous contractor', 'New contractor', 'Changed by', 'Batch'],
        d.rows.map(function (r) { return [localTs(r.at), r.pile, r.block, r.previous || '', r['new'] || '', r.by, r.batch]; }));
    });
  }
  function exportSummary() {
    var groups = new Map();
    PS.piles.filter(function (p) { return dPass(p, false); }).forEach(function (p) {
      var k = p.block + '|' + (p.area == null ? '' : p.area) + '|' + (coOf(p) == null ? '' : coOf(p));
      var l = groups.get(k); if (!l) groups.set(k, l = []); l.push(p);
    });
    var sts = PS.statuses;
    var head = ['Block', 'Work area', 'Contractor', 'Piles in scope', 'Out of scope'].concat(sts.map(function (s) { return s.label; })).concat(['Reported complete', 'Accepted', 'Remaining', 'Reported %', 'Accepted %', 'Open cases']);
    var rows = Array.from(groups.keys()).sort().map(function (k) {
      var l = groups.get(k), c = counts(l), p = l[0];
      return [p.block, areaName(p.area) || '', coOf(p) ? companyName(coOf(p)) : '', c.total, c.off].concat(sts.map(function (s) { return c.st.get(s.id) || 0; }))
        .concat([c.reported, c.cat.accepted || 0, c.remaining, c.total ? Math.round(1000 * c.reported / c.total) / 10 : 0, c.total ? Math.round(1000 * (c.cat.accepted || 0) / c.total) / 10 : 0, c.cases]);
    });
    save('pile-progress-summary-' + stampNow(), head, rows);
  }

  // ---- minimal .xlsx writer (stored zip, inline strings) and reader (zip with deflate)
  var CRC = (function () { var t = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(b) { var c = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''); }
  function colName(i) { var s = ''; i++; while (i) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function zip(files) {
    var enc = new TextEncoder(), parts = [], central = [], off = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = enc.encode(f.data), crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), name);
      off += 30 + name.length + data.length;
    });
    var csize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, off, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function xlsxBlob(sheet, header, rows) {
    var all = [header].concat(rows), widths = header.map(function (x) { return Math.min(60, Math.max(8, String(x).length + 2)); });
    all.forEach(function (r) { r.forEach(function (v, i) { widths[i] = Math.min(60, Math.max(widths[i] || 8, String(v == null ? '' : v).length + 2)); }); });
    var x = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
      '<cols>' + widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>'];
    all.forEach(function (r, ri) {
      x.push('<row r="' + (ri + 1) + '">');
      r.forEach(function (v, ci) {
        var ref = colName(ci) + (ri + 1), st = ri === 0 ? ' s="1"' : '';
        if (v == null || v === '') return;
        if (typeof v === 'number' && isFinite(v)) x.push('<c r="' + ref + '"' + st + '><v>' + v + '</v></c>');
        else x.push('<c r="' + ref + '" t="inlineStr"' + st + '><is><t xml:space="preserve">' + esc(v) + '</t></is></c>');
      });
      x.push('</row>');
    });
    x.push('</sheetData><autoFilter ref="A1:' + colName(header.length - 1) + Math.max(1, all.length) + '"/></worksheet>');
    return zip([
      { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + esc(sheet.replace(/[\\\/?*\[\]:]/g, ' ')) + '" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + esc(sheet.replace(/[\\\/?*\[\]:']/g, ' ')) + '\'!$A$1:$' + colName(header.length - 1) + '$' + Math.max(1, all.length) + '</definedName></definedNames></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', data: x.join('') }]);
  }
  Pi.xlsxBlob = xlsxBlob;
  // reader
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function unzip(buf) {
    var b = new Uint8Array(buf), e = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) { if (u32(b, i) === 0x06054b50) { e = i; break; } }
    if (e < 0) return Promise.reject(new Error('This is not an Excel (.xlsx) file.'));
    var n = u16(b, e + 10), p = u32(b, e + 16), entries = {};
    for (var k = 0; k < n; k++) {
      if (u32(b, p) !== 0x02014b50) return Promise.reject(new Error('The Excel file is damaged.'));
      var method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), loff = u32(b, p + 42);
      var name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
      entries[name] = { method: method, csize: csize, loff: loff };
      p += 46 + nlen + xlen + clen;
    }
    function read(name) {
      var en = entries[name]; if (!en) return Promise.resolve(null);
      var lo = en.loff, start = lo + 30 + u16(b, lo + 26) + u16(b, lo + 28), data = b.subarray(start, start + en.csize);
      if (en.method === 0) return Promise.resolve(new TextDecoder().decode(data));
      if (en.method !== 8) return Promise.reject(new Error('This Excel file uses an unsupported compression.'));
      if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('This browser cannot read .xlsx files. Save the sheet as CSV and import that, or use a current Chrome, Edge, Safari or Firefox.'));
      var ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(ds).text();
    }
    return Promise.resolve({ names: Object.keys(entries), read: read });
  }
  function xmlDoc(t) { return new DOMParser().parseFromString(t, 'application/xml'); }
  function byTag(node, tag) { return Array.prototype.slice.call(node.getElementsByTagNameNS('*', tag)); }
  function readXlsx(buf) {
    return unzip(buf).then(function (z) {
      return Promise.all([z.read('xl/workbook.xml'), z.read('xl/_rels/workbook.xml.rels'), z.read('xl/sharedStrings.xml')]).then(function (r) {
        if (!r[0]) throw new Error('This is not an Excel workbook.');
        var wb = xmlDoc(r[0]), rels = {}, ss = [];
        if (r[1]) byTag(xmlDoc(r[1]), 'Relationship').forEach(function (x) { rels[x.getAttribute('Id')] = x.getAttribute('Target'); });
        if (r[2]) byTag(xmlDoc(r[2]), 'si').forEach(function (si) { ss.push(byTag(si, 't').map(function (t) { return t.textContent; }).join('')); });
        var sheets = byTag(wb, 'sheet').map(function (s) {
          var rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
          var tgt = rels[rid] || ''; tgt = tgt.replace(/^\//, ''); if (tgt.indexOf('xl/') !== 0) tgt = 'xl/' + tgt;
          return { name: s.getAttribute('name'), path: tgt };
        });
        return Promise.all(sheets.map(function (s) { return z.read(s.path); })).then(function (texts) {
          return sheets.map(function (s, i) { return { name: s.name, rows: texts[i] ? sheetRows(xmlDoc(texts[i]), ss) : [] }; });
        });
      });
    });
  }
  function colIndex(ref) { var m = /^([A-Z]+)/.exec(ref || ''), n = 0; if (!m) return -1; for (var i = 0; i < m[1].length; i++) n = n * 26 + m[1].charCodeAt(i) - 64; return n - 1; }
  function sheetRows(doc, ss) {
    var out = [];
    byTag(doc, 'row').forEach(function (row) {
      var rn = +row.getAttribute('r') || out.length + 1, cells = [];
      byTag(row, 'c').forEach(function (c, i) {
        var idx = colIndex(c.getAttribute('r')); if (idx < 0) idx = i;
        var t = c.getAttribute('t'), v = byTag(c, 'v')[0], val = '';
        if (t === 's') val = v ? (ss[+v.textContent] || '') : '';
        else if (t === 'inlineStr') val = byTag(c, 't').map(function (x) { return x.textContent; }).join('');
        else if (t === 'b') val = v && v.textContent === '1' ? 'TRUE' : 'FALSE';
        else val = v ? v.textContent : '';
        if (t !== 's' && t !== 'inlineStr' && /^-?\d+\.\d{9,}$/.test(val)) val = String(+(+val).toPrecision(15));
        cells[idx] = val;
      });
      out[rn - 1] = cells;
    });
    for (var i = 0; i < out.length; i++) if (!out[i]) out[i] = [];
    return out;
  }
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '', cand = [',', ';', '\t'], delim = ',', best = -1;
    cand.forEach(function (d) { var n = first.split(d).length; if (n > best) { best = n; delim = d; } });
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  Pi.parseCsv = parseCsv; Pi.readXlsx = readXlsx;

  // ------------------------------------------------------------------
  // Pile setup (administrator)
  // ------------------------------------------------------------------
  Pi.renderSetup = function (reset) {
    var root = $('#ppage'); if (!root) return;
    if (!X.isAdmin()) { root.textContent = ''; return; }
    keepScroll(root, reset, function () {
      root.textContent = '';
      ap(root, h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Pile setup' }),
        h('p', { text: 'Pile layout import, work areas, statuses, pile targets and storage. Only administrators see this page.' }))));
      ap(root, h('div', { class: 'subtabs', role: 'group', 'aria-label': 'Pile setup sections' },
        [['import', 'Import piles'], ['areas', 'Work areas'], ['statuses', 'Statuses'], ['targets', 'Pile targets'], ['storage', 'Storage']].map(function (x) {
          return h('button', { type: 'button', 'aria-pressed': String(U.tab === x[0]), 'data-ptab': x[0], text: x[1], onclick: function () { U.tab = x[0]; Pi.renderSetup(true); } });
        })));
      var body = h('div', { class: 'stack', id: 'psetup-body' }); ap(root, body);
      if (U.tab === 'import') importTab(body);
      else if (U.tab === 'areas') areasTab(body);
      else if (U.tab === 'statuses') statusesTab(body);
      else if (U.tab === 'targets') targetsTab(body);
      else storageTab(body);
    });
  };
  function rerender() { if (PS.visible && PS.sub === 'setup') Pi.renderSetup(); }

  // ---- import
  var FIELDS = [
    ['code', 'Pile ID', true, ['pileid', 'pileno', 'pilenumber', 'pilecode', 'pile', 'pilemark', 'pileref', 'piletag', 'id', 'pilename']],
    ['block', 'Block', true, ['block', 'blk', 'blockno', 'blocknumber']],
    ['x', 'X (drawing)', true, ['x', 'xcoord', 'xcoordinate', 'coordx', 'xm', 'positionx', 'easting', 'e']],
    ['y', 'Y (drawing)', true, ['y', 'ycoord', 'ycoordinate', 'coordy', 'ym', 'positiony', 'northing', 'n']],
    ['work_area', 'Work area', false, ['workarea', 'area', 'zone', 'sector', 'subblock', 'subarea']],
    ['table_code', 'Table ID', false, ['tableid', 'table', 'tableno', 'tablecode', 'tablenumber', 'structure', 'tracker']],
    ['pile_type', 'Pile type', false, ['piletype', 'type', 'profile', 'section']],
    ['design_length', 'Design length (m)', false, ['designlength', 'length', 'lengthm', 'designlengthm', 'pilelength', 'embedment']],
    ['remarks', 'Remarks', false, ['remarks', 'remark', 'notes', 'note', 'comments', 'comment']]];
  function normH(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function templateRows() { return [['Pile ID', 'Block', 'X', 'Y', 'Work area', 'Table ID', 'Pile type', 'Design length (m)', 'Remarks']]; }
  function importTab(body) {
    var M = U.imp;
    var card = h('div', { class: 'card' }, h('h2', { text: 'Import the pile layout' }),
      h('p', { class: 'card-sub', text: 'The keyplan drawing has no pile data, so the actual pile list is imported from Excel (.xlsx) or CSV. Nothing is saved until the file passes the check and you confirm.' }),
      h('div', { class: 'pimp-help' },
        h('p', null, h('strong', { text: 'Required columns: ' }), 'Pile ID (unique within its block) · Block (1 or 5) · X and Y in the same AutoCAD coordinates as BLOCK 1 AND BLOCK 5 – KEYPLAN.dwg, for example the pile centre points of the pile layout drawing.'),
        h('p', null, h('strong', { text: 'Optional: ' }), 'Work area · Table ID (e.g. M01-R02-T10) · Pile type · Design length (m) · Remarks.'),
        h('p', { class: 'small muted', text: 'Survey coordinates (easting/northing) from another system do not line up with the keyplan and are refused. One header row, one pile per row.' })),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', id: 'pimp-tpl-x', text: 'Blank template (.xlsx)', onclick: function () { downloadBlob('pile-import-template.xlsx', xlsxBlob('Piles', templateRows()[0], [])); } }),
        h('button', { type: 'button', class: 'btn small', id: 'pimp-tpl-c', text: 'Blank template (.csv)', onclick: function () { X.download('pile-import-template.csv', templateRows()); } })));
    var file = h('input', { id: 'pimp-file', type: 'file', accept: '.xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv' });
    file.addEventListener('change', function () { var f = file.files && file.files[0]; if (f) readFile(f); });
    ap(card, h('div', { class: 'field' }, h('label', { for: 'pimp-file', text: 'Pile list file' }), file));
    if (M && M.error) ap(card, h('p', { class: 'form-error', text: M.error }));
    if (M && M.sheets) mappingUI(card, M);
    body.append(card);
    body.append(importHistory());
  }
  function readFile(f) {
    U.imp = { name: f.name, loading: true }; rerender();
    var isX = /\.xlsx$/i.test(f.name) || f.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    var pr = isX ? f.arrayBuffer().then(readXlsx) : f.text().then(function (t) { return [{ name: 'CSV', rows: parseCsv(t) }]; });
    pr.then(function (sheets) {
      sheets = sheets.filter(function (s) { return s.rows.some(function (r) { return r.some(function (c) { return String(c || '').trim(); }); }); });
      if (!sheets.length) throw new Error('The file has no rows.');
      U.imp = { name: f.name, sheets: sheets, sheet: 0, mode: 'add', areas: true, blockFixed: '' };
      pickHeader(U.imp); rerender();
    }).catch(function (e) { U.imp = { name: f.name, error: e.message || 'The file could not be read.' }; rerender(); });
  }
  function pickHeader(M) {
    var rows = M.sheets[M.sheet].rows, hr = 0;
    for (var i = 0; i < Math.min(rows.length, 30); i++) { if ((rows[i] || []).filter(function (c) { return String(c || '').trim(); }).length >= 2) { hr = i; break; } }
    M.header = hr; M.map = {};
    var hdr = (rows[hr] || []).map(normH);
    FIELDS.forEach(function (f) {
      var idx = -1;
      f[3].some(function (alias) { var j = hdr.indexOf(alias); if (j >= 0) { idx = j; return true; } return false; });
      M.map[f[0]] = idx;
    });
    M.check = null; M.dataRows = null;
  }
  function mappingUI(card, M) {
    var rows = M.sheets[M.sheet].rows, hdr = rows[M.header] || [];
    if (M.sheets.length > 1) {
      var ss = h('select', { id: 'pimp-sheet' }, M.sheets.map(function (s, i) { return h('option', { value: i, text: s.name, selected: i === M.sheet }); }));
      ss.addEventListener('change', function () { M.sheet = +ss.value; pickHeader(M); rerender(); });
      ap(card, h('div', { class: 'field' }, h('label', { for: 'pimp-sheet', text: 'Sheet' }), ss));
    }
    var cols = [['-1', '— not in the file —']].concat(hdr.map(function (x, i) { return [String(i), (String(x || '').trim() || 'Column ' + colName(i)) + ' (' + colName(i) + ')']; }));
    var grid = h('div', { class: 'grid-form pimp-map' });
    FIELDS.forEach(function (f) {
      var s = h('select', { id: 'pimp-map-' + f[0] }, cols.map(function (c) { return h('option', { value: c[0], text: c[1], selected: String(M.map[f[0]]) === c[0] }); }));
      s.addEventListener('change', function () { M.map[f[0]] = +s.value; M.check = null; rerender(); });
      ap(grid, h('div', { class: 'field' }, h('label', { for: 'pimp-map-' + f[0], text: f[1] + (f[2] ? ' *' : '') }), s));
    });
    var fixed = h('select', { id: 'pimp-blockfixed' }, [['', 'Use the Block column'], ['1', 'All rows are Block 1'], ['5', 'All rows are Block 5']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: M.blockFixed === o[0] }); }));
    fixed.addEventListener('change', function () { M.blockFixed = fixed.value; M.check = null; rerender(); });
    ap(grid, h('div', { class: 'field' }, h('label', { for: 'pimp-blockfixed', text: 'Block for every row' }), fixed));
    var data = dataRows(M);
    ap(card, h('p', { class: 'small', text: M.name + ' · sheet "' + M.sheets[M.sheet].name + '" · header in row ' + (M.header + 1) + ' · ' + plural(data.length, 'data row') + '. Check the columns:' }), grid);
    var prev = data.slice(0, 5);
    if (prev.length) ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable small' },
      h('thead', null, h('tr', null, [h('th', { text: 'Row' })].concat(FIELDS.map(function (f) { return h('th', { text: f[1] }); })))),
      h('tbody', null, prev.map(function (r) { return h('tr', null, [h('td', { text: String(r.sheetRow) })].concat(FIELDS.map(function (f) { return h('td', { text: r.data[f[0]] || '' }); }))); })))));
    var modeA = h('input', { type: 'radio', name: 'pimp-mode', id: 'pimp-mode-add', checked: M.mode === 'add' });
    var modeU = h('input', { type: 'radio', name: 'pimp-mode', id: 'pimp-mode-upsert', checked: M.mode === 'upsert' });
    modeA.addEventListener('change', function () { M.mode = 'add'; M.check = null; rerender(); });
    modeU.addEventListener('change', function () { M.mode = 'upsert'; M.check = null; rerender(); });
    var mkA = h('input', { type: 'checkbox', id: 'pimp-areas', checked: M.areas });
    mkA.addEventListener('change', function () { M.areas = mkA.checked; M.check = null; rerender(); });
    ap(card, h('div', { class: 'field' }, h('span', { class: 'label', text: 'Mode' }),
      h('label', { class: 'check' }, modeA, h('span', { text: 'Add new piles only (an existing pile ID is an error)' })),
      h('label', { class: 'check' }, modeU, h('span', { text: 'Add new piles and update existing ones (same pile ID in the same block: position, area, table, type and length are replaced; status and history are kept)' }))),
      h('label', { class: 'check' }, mkA, h('span', { text: 'Create work areas named in the file that do not exist yet' })));
    var missing = FIELDS.filter(function (f) { return f[2] && !(f[0] === 'block' && M.blockFixed) && !(M.map[f[0]] >= 0); });
    var chk = h('button', { type: 'button', class: 'btn primary', id: 'pimp-check', text: M.checking ? 'Checking…' : 'Check the file', disabled: !!M.checking || !data.length || !!missing.length });
    chk.addEventListener('click', function () { checkImport(M); });
    ap(card, missing.length ? h('p', { class: 'form-error', text: 'Choose the column for: ' + missing.map(function (f) { return f[1]; }).join(', ') + '.' }) : null, h('div', { class: 'btn-row' }, chk));
    if (M.check) checkResult(card, M);
  }
  function dataRows(M) {
    var rows = M.sheets[M.sheet].rows, out = [];
    for (var i = M.header + 1; i < rows.length; i++) {
      var r = rows[i] || [], d = {}, any = false;
      FIELDS.forEach(function (f) { var j = M.map[f[0]]; var v = j >= 0 ? String(r[j] == null ? '' : r[j]).trim() : ''; d[f[0]] = v; if (v) any = true; });
      if (M.blockFixed) d.block = M.blockFixed;
      if (any && (d.code || d.x || d.y)) out.push({ sheetRow: i + 1, data: d });
    }
    return out;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var hx = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return hx.slice(0, 8) + '-' + hx.slice(8, 12) + '-' + hx.slice(12, 16) + '-' + hx.slice(16, 20) + '-' + hx.slice(20);
  }
  function stage(id, rows) {
    var chain = Promise.resolve();
    for (var i = 0; i < rows.length; i += 2000) (function (start) {
      chain = chain.then(function () { return call('admin_stage_pile_rows', { p_import_id: id, p_first_row: start + 1, p_rows: rows.slice(start, start + 2000).map(function (r) { return r.data; }) }); });
    })(i);
    return chain;
  }
  function checkImport(M) {
    var rows = dataRows(M); M.rows = rows; M.checking = true; M.check = null; rerender();
    var id = uuid();
    stage(id, rows).then(function () {
      return call('admin_commit_pile_import', { p_import_id: id, p_mode: M.mode, p_create_areas: M.areas, p_dry_run: true, p_file_name: M.name });
    }).then(function (r) { M.check = r; M.checkId = id; M.checking = false; rerender(); })
      .catch(function (e) { M.checking = false; M.check = { failed: e.message }; rerender(); });
  }
  function checkResult(card, M) {
    var r = M.check;
    if (r.failed) { ap(card, h('p', { class: 'form-error', text: r.failed })); return; }
    function rowOf(n) { var x = M.rows[n - 1]; return x ? x.sheetRow : n; }
    var okRows = r.error_count === 0;
    ap(card, h('div', { class: 'notice ' + (okRows ? 'info' : 'err'), id: 'pimp-result' },
      h('strong', { text: okRows ? 'The file passed the check.' : plural(r.error_count, 'problem') + ' found. Nothing can be saved until they are fixed.' }),
      plural(r.rows, 'row') + ': ' + r['new'] + ' new pile' + (r['new'] === 1 ? '' : 's') + (M.mode === 'upsert' ? ', ' + r.update + ' existing to update' : '') +
      (Object.keys(r.blocks || {}).length ? ' · ' + Object.keys(r.blocks).map(function (b) { return 'Block ' + b + ': ' + r.blocks[b]; }).join(', ') : '') +
      (r.areas_to_create.length ? ' · new work areas: ' + r.areas_to_create.map(function (a) { return 'B' + a.block + ' ' + a.name; }).join(', ') : '') + '.'));
    if (r.errors.length) ap(card, h('div', { class: 'table-wrap pimp-errors' }, h('table', { class: 'dtable small' },
      h('thead', null, h('tr', null, ['Row', 'Pile ID', 'Problem'].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, r.errors.map(function (e) { return h('tr', null, h('td', { text: String(rowOf(e.row)) }), h('td', { text: e.code || '—' }), h('td', { text: e.msg })); })))),
      r.error_count > r.errors.length ? h('p', { class: 'small muted', text: 'Showing the first ' + r.errors.length + ' problems.' }) : null);
    if (r.warnings.length) ap(card, h('details', { class: 'hist-box' }, h('summary', { text: plural(r.warning_count, 'warning') + ' (saved anyway)' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dtable small' }, h('tbody', null, r.warnings.map(function (e) { return h('tr', null, h('td', { text: 'Row ' + rowOf(e.row) }), h('td', { text: e.code || '' }), h('td', { text: e.msg })); }))))));
    if (!okRows) return;
    ap(card, h('p', { class: 'small', text: 'Preview: the piles of the file (blue) on the keyplan tables. Check that they sit on the tables before importing.' }), previewCanvas(M));
    var n = r['new'] + (M.mode === 'upsert' ? r.update : 0);
    var go = h('button', { type: 'button', class: 'btn primary', id: 'pimp-save', text: M.saving ? 'Saving…' : 'Import ' + plural(n, 'pile'), disabled: !!M.saving || !n });
    go.addEventListener('click', function () { confirmImport(M); });
    ap(card, h('div', { class: 'btn-row' }, go));
  }
  function previewCanvas(M) {
    var wrap = h('div', { class: 'pimp-preview' });
    var blocks = Object.keys(M.check.blocks || {}).map(Number).filter(function (b) { return S.kp[b] && PS.origins[b]; });
    blocks.forEach(function (b) {
      var kp = S.kp[b], o = PS.origins[b], cv = h('canvas', { class: 'pimp-cv', 'aria-label': 'Preview Block ' + b });
      ap(wrap, h('div', null, h('div', { class: 'small', text: 'Block ' + b }), cv));
      requestAnimationFrame(function () {
        var w = cv.clientWidth || 480, k = w / +kp.width, hh = Math.round(+kp.height * k), dpr = window.devicePixelRatio || 1;
        cv.width = w * dpr; cv.height = hh * dpr; cv.style.height = hh + 'px';
        var ctx = cv.getContext('2d'); ctx.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, +kp.width, +kp.height);
        ctx.beginPath(); (S.secByBlock[b] || []).forEach(function (s) { var g = s.geom; ctx.rect(g[0], g[1], g[2], g[3]); });
        ctx.fillStyle = '#e8ecf0'; ctx.fill(); ctx.lineWidth = 0.6 / k; ctx.strokeStyle = '#9aa5b0'; ctx.stroke();
        ctx.fillStyle = '#1d5bd8'; var r = Math.max(0.35, 1.3 / k);
        ctx.beginPath();
        M.rows.forEach(function (row) {
          var bb = M.blockFixed || String(row.data.block).replace(/[^0-9.]/g, '').replace(/\.0+$/, '');
          if (+bb !== b) return;
          var x = parseFloat(String(row.data.x).replace(/,/g, '')) - o.x, y = o.y - parseFloat(String(row.data.y).replace(/,/g, ''));
          if (isFinite(x) && isFinite(y)) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832); }
        });
        ctx.fill();
      });
    });
    return wrap;
  }
  function confirmImport(M) {
    var r = M.check, n = r['new'] + (M.mode === 'upsert' ? r.update : 0);
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'pimp-confirm', text: 'Confirm and import' });
    btn.addEventListener('click', function () { btn.disabled = true; btn.textContent = 'Saving…'; doImport(M); });
    openModal('Import ' + plural(n, 'pile') + '?', [
      h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'File' }), h('dd', { text: M.name }),
        h('dt', { text: 'New piles' }), h('dd', { text: String(r['new']) }),
        M.mode === 'upsert' ? h('dt', { text: 'Updated piles' }) : null, M.mode === 'upsert' ? h('dd', { text: String(r.update) }) : null,
        r.areas_to_create.length ? h('dt', { text: 'New work areas' }) : null, r.areas_to_create.length ? h('dd', { text: r.areas_to_create.map(function (a) { return 'B' + a.block + ' ' + a.name; }).join(', ') }) : null),
      h('p', { class: 'small muted', text: M.rows.length > 3000 ? 'Large files are saved in parts of 3000 rows; each part is saved completely or not at all.' : 'The import is saved completely or not at all.' }),
      h('p', { class: 'small muted', text: 'A new import can be undone below as long as nothing has been recorded on its piles.' }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function doImport(M) {
    M.saving = true;
    var rows = M.rows, parts = [], done = 0, created = 0, updated = 0, areas = 0;
    if (rows.length <= 3000) parts.push({ id: M.checkId, rows: null });
    else for (var i = 0; i < rows.length; i += 3000) parts.push({ id: uuid(), rows: rows.slice(i, i + 3000) });
    var chain = Promise.resolve();
    parts.forEach(function (pt, k) {
      chain = chain.then(function () { return pt.rows ? stage(pt.id, pt.rows) : null; }).then(function () {
        return call('admin_commit_pile_import', { p_import_id: pt.id, p_mode: M.mode, p_create_areas: M.areas, p_dry_run: false,
          p_file_name: M.name + (parts.length > 1 ? ' (part ' + (k + 1) + ' of ' + parts.length + ')' : '') });
      }).then(function (r) {
        if (!r.saved) throw new Error('Part ' + (k + 1) + ' did not pass the check (' + plural(r.error_count, 'problem') + '). Earlier parts were saved.');
        done++; created += r['new']; updated += r.update; areas += r.areas_created;
      });
    });
    chain.then(function () {
      closeModal(); toast('Imported: ' + created + ' new, ' + updated + ' updated' + (areas ? ', ' + plural(areas, 'new work area') : '') + '.', 'ok', 8000);
      U.imp = null; U.imports = null;
      return I.loadPiles().then(function () { PS.firstFit = true; rerender(); });
    }).catch(function (e) {
      closeModal(); M.saving = false;
      toast((done ? 'Saved ' + done + ' of ' + parts.length + ' parts. ' : 'Nothing was saved. ') + e.message, 'err', 15000);
      U.imports = null; I.loadPiles().then(rerender, rerender);
    });
  }
  function importHistory() {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Import history' }));
    if (!U.imports) {
      ap(card, h('p', { class: 'small muted', text: 'Loading…' }));
      if (!U.importsLoading) {
        U.importsLoading = true;
        call('admin_list_pile_imports', {}).then(function (d) { U.imports = d.imports; }).catch(function () { U.imports = []; }).then(function () { U.importsLoading = false; rerender(); });
      }
      return card;
    }
    if (!U.imports.length) { ap(card, h('p', { class: 'small muted', text: 'No imports yet. ' + plural(PS.piles.length, 'pile') + ' in the app.' })); return card; }
    ap(card, h('p', { class: 'small', text: plural(PS.piles.length, 'pile') + ' in the app (Block 1: ' + (PS.byBlock[1] || []).length + ', Block 5: ' + (PS.byBlock[5] || []).length + ').' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['When', 'File', 'By', 'New', 'Updated', 'Still in the app', ''].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, U.imports.map(function (i) {
          return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(i.at) }), h('td', { text: i.file_name || '—' }), h('td', { text: i.username }),
            h('td', { class: 'num', text: String(i.created) }), h('td', { class: 'num', text: String(i.updated) }), h('td', { class: 'num', text: String(i.still_in_app) }),
            h('td', null, i.undone_at ? h('span', { class: 'small muted', text: 'Undone ' + fmtTime(i.undone_at) + ' (' + i.undone_count + ')' }) : null,
              i.still_in_app ? h('button', { type: 'button', class: 'link-btn danger', text: 'Undo', onclick: function () { undoImport(i); } }) : null));
        })))));
    return card;
  }
  function undoImport(i) {
    var btn = h('button', { type: 'button', class: 'btn danger', id: 'pimp-undo-confirm', text: 'Remove the piles of this import' });
    btn.addEventListener('click', function () {
      btn.disabled = true;
      call('admin_undo_pile_import', { p_import_id: i.id }).then(function (r) {
        closeModal(); toast('Removed ' + plural(r.removed, 'pile') + (r.kept ? '; ' + r.kept + ' kept because work is already recorded on them' : '') + '.', 'ok', 8000);
        U.imports = null; return I.loadPiles().then(rerender);
      }).catch(function (e) { closeModal(); toast(e.message, 'err'); });
    });
    openModal('Undo import?', [h('p', { text: (i.file_name || 'This import') + ': the ' + plural(i.still_in_app, 'pile') + ' it added are removed, except piles that already have a status, contractor, inspection, case or file. Piles it updated keep their new values. The undo is recorded.' }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  // ---- work areas
  function areasTab(body) {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Work areas' }),
      h('p', { class: 'card-sub', text: 'Work areas group the piles of a block for assignment, targets and reports. Piles get their area from the import or from Set work area on the pile keyplan.' }));
    [1, 5].forEach(function (b) {
      var list = PS.areas.filter(function (a) { return a.block === b; });
      ap(card, h('h3', { class: 'ph3', text: 'Block ' + b }));
      if (!list.length) { ap(card, h('p', { class: 'small muted', text: 'No work areas yet.' })); return; }
      ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['Work area', 'Piles', 'Status', ''].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, list.map(function (a) {
          var n = PS.piles.filter(function (p) { return p.area === a.id; }).length;
          return h('tr', null, h('td', { text: a.name }), h('td', { class: 'num', text: String(n) }), h('td', null, h('span', { class: 'pill ' + (a.is_active ? 'on' : 'off'), text: a.is_active ? 'Active' : 'Inactive' })),
            h('td', null, h('button', { type: 'button', class: 'link-btn', text: 'Edit', onclick: function () { areaForm(a); } })));
        })))));
    });
    ap(card, h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'parea-add', text: 'Add a work area', onclick: function () { areaForm(null); } })));
    body.append(card);
  }
  function areaForm(a) {
    var fB = h('select', { id: 'pa-block' }, [1, 5].map(function (b) { return h('option', { value: b, text: 'Block ' + b, selected: a ? a.block === b : false }); }));
    var fN = h('input', { id: 'pa-name', maxlength: 80, value: a ? a.name : '' });
    var fA = h('input', { id: 'pa-active', type: 'checkbox', checked: a ? a.is_active : true });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'pa-save', text: 'Save' });
    save.addEventListener('click', function () {
      save.disabled = true;
      call('admin_save_pile_work_area', { p_id: a ? a.id : null, p_block: +fB.value, p_name: fN.value, p_is_active: fA.checked }).then(function () {
        closeModal(); toast('Work area saved.', 'ok'); return I.loadPiles().then(rerender);
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal(a ? 'Edit work area' : 'Add a work area', [h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pa-block', text: 'Block' }), fB),
      h('div', { class: 'field' }, h('label', { for: 'pa-name', text: 'Name' }), fN)), h('label', { class: 'check' }, fA, h('span', { text: 'Active (offered for new assignments and targets)' })),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  // ---- statuses
  var CATS = [['not_started', 'Not started'], ['ongoing', 'Ongoing / in progress'], ['completed', 'Reported complete, waiting for inspection'], ['accepted', 'Accepted / verified (official only)'],
    ['on_hold', 'On hold'], ['refusal', 'Pile refusal'], ['rectification', 'Rejected / rectification required'], ['reinspection', 'Rectified, for reinspection']];
  var ICATS = [['not_inspected', 'Not yet inspected'], ['in_progress', 'Inspection in progress'], ['pending', 'Inspected, approval pending'], ['accepted', 'Accepted / verified'],
    ['rejected', 'Rejected / rectification required'], ['reinspection', 'For reinspection']];
  function statusesTab(body) {
    var c1 = h('div', { class: 'card' }, h('h2', { text: 'Pile installation statuses' }),
      h('p', { class: 'card-sub', text: 'These are configurable options. The meaning decides how a status is counted: "reported complete" counts toward the daily accomplishment, "accepted" counts as accepted. An accepted status can never be set by contractors.' }));
    ap(c1, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Colour', 'Name', 'Meaning', 'Contractors may set', 'Order', 'In use', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, PS.statuses.map(function (s) {
        return h('tr', null, h('td', null, sw(s.color)), h('td', { text: s.label }), h('td', { text: (CATS.filter(function (c) { return c[0] === s.category; })[0] || [0, s.category])[1] }),
          h('td', { text: s.contractor_can_set ? 'Yes' : 'No (administrator / inspector)' }), h('td', { class: 'num', text: String(s.sort) }),
          h('td', null, h('span', { class: 'pill ' + (s.is_active ? 'on' : 'off'), text: s.is_active ? 'Active' : 'Not offered' })),
          h('td', null, h('button', { type: 'button', class: 'link-btn', text: 'Edit', onclick: function () { statusForm(s, false); } })));
      })))), h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'pst-add', text: 'Add a status', onclick: function () { statusForm(null, false); } })));
    var c2 = h('div', { class: 'card' }, h('h2', { text: 'Inspection statuses' }),
      h('p', { class: 'card-sub', text: 'Configurable options for the inspection and acceptance records, kept separate from the installation status.' }));
    ap(c2, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Colour', 'Name', 'Meaning', 'Order', 'In use', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, PS.istatuses.map(function (s) {
        return h('tr', null, h('td', null, sw(s.color)), h('td', { text: s.label }), h('td', { text: (ICATS.filter(function (c) { return c[0] === s.category; })[0] || [0, s.category])[1] }),
          h('td', { class: 'num', text: String(s.sort) }), h('td', null, h('span', { class: 'pill ' + (s.is_active ? 'on' : 'off'), text: s.is_active ? 'Active' : 'Not offered' })),
          h('td', null, h('button', { type: 'button', class: 'link-btn', text: 'Edit', onclick: function () { statusForm(s, true); } })));
      })))), h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', id: 'pist-add', text: 'Add an inspection status', onclick: function () { statusForm(null, true); } })));
    body.append(c1, c2);
  }
  function statusForm(s, insp) {
    var fL = h('input', { id: 'ps-label', maxlength: 60, value: s ? s.label : '' });
    var fC = h('input', { id: 'ps-color', type: 'color', value: s ? s.color : '#0ea5e9' });
    var fK = h('select', { id: 'ps-cat' }, (insp ? ICATS : CATS).map(function (c) { return h('option', { value: c[0], text: c[1], selected: s ? s.category === c[0] : false }); }));
    var fCS = h('input', { id: 'ps-contractor', type: 'checkbox', checked: s ? !!s.contractor_can_set : true });
    var fO = h('input', { id: 'ps-sort', type: 'number', min: 0, max: 999, value: s ? s.sort : 50 });
    var fA = h('input', { id: 'ps-active', type: 'checkbox', checked: s ? s.is_active : true });
    function sync() { if (!insp) { var acc = fK.value === 'accepted'; fCS.disabled = acc; if (acc) fCS.checked = false; } }
    fK.addEventListener('change', sync);
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'ps-save', text: 'Save' });
    save.addEventListener('click', function () {
      save.disabled = true;
      var pr = insp ? call('admin_save_pile_inspection_status', { p_id: s ? s.id : null, p_label: fL.value, p_color: fC.value, p_category: fK.value, p_sort: +fO.value || 0, p_is_active: fA.checked })
        : call('admin_save_pile_status', { p_id: s ? s.id : null, p_label: fL.value, p_color: fC.value, p_category: fK.value, p_contractor_can_set: fCS.checked, p_sort: +fO.value || 0, p_is_active: fA.checked });
      pr.then(function () { closeModal(); toast('Status saved. The keyplan legend uses the new name and colour.', 'ok'); return I.loadPiles().then(rerender); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal((s ? 'Edit ' : 'Add ') + (insp ? 'inspection status' : 'pile status'), [
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'ps-label', text: 'Name' }), fL), h('div', { class: 'field' }, h('label', { for: 'ps-color', text: 'Colour' }), fC)),
      h('div', { class: 'field' }, h('label', { for: 'ps-cat', text: 'Meaning (how it is counted)' }), fK),
      insp ? null : h('label', { class: 'check' }, fCS, h('span', { text: 'Contractors may set this status on their own piles' })),
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'ps-sort', text: 'Order in lists' }), fO)),
      h('label', { class: 'check' }, fA, h('span', { text: 'Offered when updating (piles already having it keep it)' })),
      s ? h('p', { class: 'small muted', text: 'Renaming does not change saved history: each record keeps the name it was saved with.' }) : null,
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
    sync();
  }

  // ---- pile targets
  function targetsTab(body) {
    var F = U.tf = U.tf || { company: '', block: '1', area: '', qty: '', start: PS.siteDate, end: PS.siteDate, days: [1, 2, 3, 4, 5, 6], dates: [], remarks: '' };
    var form = h('div', { class: 'card' }, h('h2', { text: 'Set daily pile targets' }),
      h('p', { class: 'card-sub', text: 'Per contractor, block and (optionally) work area. Only the dates in the list get a target, each with its own number of piles; not every calendar day is a working day.' }));
    function fsel(id, label, key, opts, onch) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { F[key] = e.target.value; if (onch) onch(); rerender(); } },
          opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(F[key]) === String(o[0]) }); })));
    }
    ap(form, h('div', { class: 'grid-form' },
      fsel('pt-co', 'Contractor', 'company', [['', 'Choose…']].concat(X.activeCompanies().map(function (c) { return [String(c.id), c.name]; }))),
      fsel('pt-blk', 'Block', 'block', [['1', 'Block 1'], ['5', 'Block 5']], function () { F.area = ''; }),
      fsel('pt-area', 'Work area (optional)', 'area', [['', 'Whole block']].concat(PS.areas.filter(function (a) { return String(a.block) === F.block && a.is_active; }).map(function (a) { return [String(a.id), a.name]; })))));
    var qty = h('input', { id: 'pt-qty', type: 'number', min: 1, max: 20000, value: F.qty, placeholder: 'e.g. 100' });
    qty.addEventListener('input', function () { F.qty = qty.value; });
    var st = h('input', { id: 'pt-start', type: 'date', value: F.start || '' }), en = h('input', { id: 'pt-end', type: 'date', value: F.end || '' });
    st.addEventListener('change', function () { F.start = st.value; }); en.addEventListener('change', function () { F.end = en.value; });
    var names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var dayBox = h('div', { class: 'day-pick', role: 'group', 'aria-label': 'Working days' }, names.map(function (n, i) {
      var cb = h('input', { type: 'checkbox', checked: F.days.indexOf(i) >= 0 });
      cb.addEventListener('change', function () { F.days = F.days.filter(function (x) { return x !== i; }); if (cb.checked) F.days.push(i); });
      return h('label', { class: 'check' }, cb, h('span', { text: n }));
    }));
    ap(form, h('div', { class: 'grid-form' },
      h('div', { class: 'field' }, h('label', { for: 'pt-qty', text: 'Piles per date' }), qty),
      h('div', { class: 'field' }, h('label', { for: 'pt-start', text: 'From' }), st),
      h('div', { class: 'field' }, h('label', { for: 'pt-end', text: 'To (same date for one day)' }), en)),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Working days in that range' }), dayBox),
      h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn', id: 'pt-add', text: 'Add these dates to the list', onclick: function () {
        if (!F.start) { toast('Choose the first date.', 'err'); return; }
        var q = parseInt(F.qty, 10); if (!(q >= 1)) { toast('Enter the number of piles per date first.', 'err'); return; }
        var end = F.end && F.end >= F.start ? F.end : F.start, d = F.start, n = 0, guard = 0;
        while (d <= end && guard++ < 400) {
          var wd = new Date(d + 'T00:00:00Z').getUTCDay();
          if (F.days.indexOf(wd) >= 0 || (d === end && d === F.start)) {
            var ex = F.dates.filter(function (x) { return x.date === d; })[0];
            if (ex) ex.quantity = q; else F.dates.push({ date: d, quantity: q });
            n++;
          }
          d = addDays(d, 1);
        }
        F.dates.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        if (!n) toast('No working days in that range. Tick the days of the week first.', 'err');
        rerender();
      } })));
    if (F.dates.length) {
      ap(form, h('p', { class: 'small', text: plural(F.dates.length, 'target date') + '. Change any quantity or remove a date before saving:' }),
        h('div', { class: 'tf-dates' }, F.dates.map(function (x) {
          var qi = h('input', { type: 'number', min: 1, max: 20000, value: x.quantity, 'aria-label': 'Piles on ' + x.date });
          qi.addEventListener('input', function () { x.quantity = parseInt(qi.value, 10) || 0; });
          return h('div', { class: 'tf-date' }, h('span', { text: fmtDate(x.date) }), qi,
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + x.date, text: '×', onclick: function () { F.dates = F.dates.filter(function (y) { return y !== x; }); rerender(); } }));
        })));
    }
    var rmk = h('textarea', { id: 'pt-remarks', maxlength: 500, rows: 2, placeholder: 'Optional instructions shown to the contractor' });
    rmk.value = F.remarks; rmk.addEventListener('input', function () { F.remarks = rmk.value; });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'pt-save', text: F.dates.length ? 'Review ' + plural(F.dates.length, 'target') : 'Save targets', disabled: !F.dates.length });
    save.addEventListener('click', function () {
      if (!F.company) { toast('Choose the contractor.', 'err'); return; }
      if (F.dates.some(function (x) { return !(x.quantity >= 1); })) { toast('Every date needs a quantity of at least 1 pile.', 'err'); return; }
      var total = F.dates.reduce(function (a, x) { return a + x.quantity; }, 0);
      var ok = h('button', { type: 'button', class: 'btn primary', id: 'pt-confirm', text: 'Confirm and save' });
      ok.addEventListener('click', function () {
        ok.disabled = true;
        call('admin_set_pile_targets', { p_company_id: +F.company, p_block: +F.block, p_work_area_id: F.area ? +F.area : null, p_dates: F.dates, p_remarks: F.remarks || null }).then(function (r) {
          closeModal(); toast('Pile targets saved: ' + r.created + ' new, ' + r.revised + ' revised' + (r.unchanged ? ', ' + r.unchanged + ' unchanged' : '') + '.', 'ok', 6000);
          F.dates = []; U.tlData = null; U.tlKey = ''; D.tb = null; D.tbKey = ''; rerender();
        }).catch(function (e) { closeModal(); toast(e.message, 'err', 8000); });
      });
      openModal('Save pile targets?', [h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'Contractor' }), h('dd', null, X.cchip(+F.company)),
        h('dt', { text: 'Block / area' }), h('dd', { text: 'Block ' + F.block + (F.area ? ' · ' + areaName(+F.area) : ' · whole block') }),
        h('dt', { text: 'Dates' }), h('dd', { text: F.dates.map(function (x) { return x.date + ': ' + x.quantity; }).join(', ') }),
        h('dt', { text: 'Total' }), h('dd', { text: plural(total, 'pile') }),
        F.remarks ? h('dt', { text: 'Instructions' }) : null, F.remarks ? h('dd', { text: F.remarks }) : null),
        h('p', { class: 'small muted', text: 'A date that already has a target for this contractor and area is revised; the original quantity and each change stay in its history.' }),
        h('div', { class: 'btn-row' }, ok, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: closeModal }))]);
    });
    ap(form, h('div', { class: 'field' }, h('label', { for: 'pt-remarks', text: 'Remarks or instructions' }), rmk), h('div', { class: 'btn-row' }, save));
    body.append(form, targetList());
  }
  function targetList() {
    var T = U.tl; if (!T.from) { T.to = addDays(PS.siteDate, 14); T.from = addDays(PS.siteDate, -14); }
    var card = h('div', { class: 'card' }, h('h2', { text: 'Pile targets' }));
    function dateIn(id, label, key) {
      var i = h('input', { id: id, type: 'date', value: T[key] });
      i.addEventListener('change', function () { T[key] = i.value || T[key]; if (T.to < T.from) T.to = T.from; rerender(); });
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), i);
    }
    ap(card, h('div', { class: 'grid-form' }, dateIn('ptl-from', 'From', 'from'), dateIn('ptl-to', 'To', 'to')));
    var key = T.from + '|' + T.to;
    if (U.tlKey !== key || !U.tlData) {
      ap(card, h('p', { class: 'small muted', text: 'Loading…' }));
      if (U.tlKey !== key) {
        U.tlKey = key;
        call('get_pile_target_board', { p_from: T.from, p_to: T.to }).then(function (d) { if (U.tlKey === key) { U.tlData = d; rerender(); } })
          .catch(function (e) { U.tlData = { targets: [], error: e.message }; rerender(); });
      }
      return card;
    }
    if (U.tlData.error) { ap(card, h('p', { class: 'form-error', text: U.tlData.error })); return card; }
    var rows = U.tlData.targets;
    if (!rows.length) { ap(card, h('p', { class: 'small muted', text: 'No pile targets in this period.' })); return card; }
    ap(card, h('div', { class: 'table-wrap' }, h('table', { class: 'dtable ptgt-admin' },
      h('thead', null, h('tr', null, ['Date', 'Contractor', 'Block / work area', 'Target', 'Accomplished', 'Accepted', 'Instructions', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, rows.map(function (r) {
        return h('tr', null, h('td', { class: 'nowrap', text: fmtDate(r.date) }), h('td', null, X.cchip(r.company_id)),
          h('td', { text: 'Block ' + r.block + (r.work_area ? ' · ' + r.work_area : ' · whole block') }),
          h('td', { class: 'num' }, String(r.quantity), r.revision ? h('div', { class: 'small muted', text: 'was ' + r.original_quantity }) : null),
          h('td', { class: 'num', text: String(r.accomplished) }), h('td', { class: 'num', text: String(r.accepted) }), h('td', { class: 'small', text: r.remarks || '—' }),
          h('td', { class: 'nowrap' },
            h('button', { type: 'button', class: 'link-btn', text: 'Revise', onclick: function () { reviseTarget(r); } }), ' ',
            h('button', { type: 'button', class: 'link-btn', text: 'History', onclick: function () { targetHistory(r); } }), ' ',
            h('button', { type: 'button', class: 'link-btn danger', text: 'Remove', onclick: function () { removeTarget(r); } })));
      })))));
    return card;
  }
  function reviseTarget(t) {
    var q = h('input', { id: 'ptr-q', type: 'number', min: 1, max: 20000, value: t.quantity });
    var rm = h('textarea', { id: 'ptr-r', maxlength: 500, rows: 2 }); rm.value = t.remarks || '';
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'ptr-save', text: 'Save revision' });
    save.addEventListener('click', function () {
      save.disabled = true;
      call('admin_set_pile_targets', { p_company_id: t.company_id, p_block: t.block, p_work_area_id: t.work_area_id, p_dates: [{ date: t.date, quantity: parseInt(q.value, 10) || 0 }], p_remarks: rm.value || null })
        .then(function () { closeModal(); toast('Target revised. The original stays in its history.', 'ok'); U.tlData = null; U.tlKey = ''; D.tb = null; D.tbKey = ''; rerender(); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Revise pile target · ' + companyName(t.company_id), [
      h('p', { class: 'small', text: 'Block ' + t.block + (t.work_area ? ' · ' + t.work_area : '') + ' · ' + fmtDate(t.date) }),
      h('div', { class: 'field' }, h('label', { for: 'ptr-q', text: 'Piles' }), q), h('div', { class: 'field' }, h('label', { for: 'ptr-r', text: 'Remarks or instructions' }), rm),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function removeTarget(t) {
    openModal('Remove this pile target?', [h('p', { text: companyName(t.company_id) + ' · Block ' + t.block + (t.work_area ? ' · ' + t.work_area : '') + ' · ' + fmtDate(t.date) + ' · ' + t.quantity + ' piles. It stops counting on the dashboard; its history is kept.' }),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn primary', id: 'ptrm-confirm', text: 'Remove', onclick: function () {
        call('admin_remove_pile_target', { p_target_id: t.id }).then(function () { closeModal(); toast('Target removed.', 'ok'); U.tlData = null; U.tlKey = ''; D.tb = null; D.tbKey = ''; rerender(); })
          .catch(function (e) { toast(e.message, 'err'); });
      } }), h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  // ---- storage
  function storageTab(body) {
    var card = h('div', { class: 'card' }, h('h2', { text: 'Photo and document storage' }));
    if (!U.storage) {
      ap(card, h('p', { class: 'small muted', text: 'Loading…' }));
      call('admin_pile_storage', {}).then(function (d) { U.storage = d; rerender(); }).catch(function (e) { U.storage = { error: e.message }; rerender(); });
      body.append(card); return;
    }
    var s = U.storage; if (s.error) { ap(card, h('p', { class: 'form-error', text: s.error })); body.append(card); return; }
    function mb(b) { return (b / 1048576).toFixed(1) + ' MB'; }
    var used = s.database_bytes / (s.limit_mb * 1048576);
    var b = h('div', { class: 'bar' }), sp = h('span', { class: used > 0.85 ? 'b-on_hold' : 'b-completed' }); sp.style.width = Math.min(100, 100 * used) + '%'; ap(b, sp);
    ap(card, h('p', { text: plural(s.files, 'file') + ' (' + mb(s.file_bytes) + ') for ' + plural(s.piles, 'pile') + '. Whole database: ' + mb(s.database_bytes) + ' of the ' + s.limit_mb + ' MB upload limit.' }), b,
      h('p', { class: 'small', text: 'Photos are reduced to about 1600 px (typically 150–400 KB) before upload; PDFs up to 2 MB. Files are kept inside the project database, so they are protected by the same sign-in and are visible only to users allowed to see the pile.' }),
      h('p', { class: 'small', text: 'The Supabase free plan allows a 500 MB database; at that size the project becomes read-only. The upload limit (400 MB by default) stops new photos before that, leaving room for the records. The Pro plan (US$25/month) has 8 GB; raise the limit only after upgrading.' }));
    var lim = h('input', { id: 'pst-limit', type: 'number', min: 50, max: 100000, value: s.limit_mb });
    var save = h('button', { type: 'button', class: 'btn', id: 'pst-limit-save', text: 'Save limit' });
    save.addEventListener('click', function () {
      call('admin_set_pile_upload_limit', { p_limit_mb: parseInt(lim.value, 10) || 0 }).then(function () { toast('Upload limit saved.', 'ok'); U.storage = null; rerender(); }).catch(function (e) { toast(e.message, 'err'); });
    });
    ap(card, h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pst-limit', text: 'Upload limit (MB of database size)' }), lim), h('div', { class: 'field' }, save)));
    body.append(card);
  }
})();
