/* Solar PV Installation Monitoring — Piles Installation module (update 8).
   A separate page with its own pile keyplan, panel, tools, dashboard and setup.
   Uses the shared sign-in and helpers of app.js (window.PVM); the Mounting
   Structure and PV Module screens are not changed by this file.
   Talks only to the database functions (Supabase RPC). */
(function () {
  'use strict';

  var X = window.PVM;
  if (!X) return;
  var S = X.S, h = X.h, $ = X.$, $$ = X.$$, call = X.call, toast = X.toast, openModal = X.openModal, closeModal = X.closeModal;
  var plural = X.plural, fmtTime = X.fmtTime, fmtDate = X.fmtDate, pct1 = X.pct1;
  // append that skips null / false children (like h())
  function ap(el) { for (var i = 1; i < arguments.length; i++) X.append(el, arguments[i]); return el; }
  // updates saved on this phone and not sent yet (offline.js, update 10)
  var OFF = window.PVMOffline || null;
  var NOPEND = { pile: new Map(), pinsp: new Map(), pcase: new Map(), pfile: new Map() };
  function pend() { return OFF ? OFF.pend : NOPEND; }
  function submitSave(fn, args, meta) { return OFF && OFF.submit ? OFF.submit(fn, args, meta) : call(fn, args); }
  function queuedNote(what) { return what + ' saved on this phone (no signal). It is sent automatically when the connection is back.'; }
  function isPending(p) { var P = pend(); return P.pile.has(p.id) || P.pinsp.has(p.id) || P.pcase.has(p.id) || P.pfile.has(p.id); }

  var Pi = window.PVMPiles = window.PVMPiles || {};
  var POLL_MS = 20000;
  var BLOCKS = [1, 5];
  var CAT_LABEL = {
    not_started: 'Not started', ongoing: 'Ongoing', completed: 'Completed – pending inspection', accepted: 'Accepted / verified',
    on_hold: 'On hold', refusal: 'Pile refusal', rectification: 'Rectification required', reinspection: 'For reinspection'
  };
  var ICAT_LABEL = {
    not_inspected: 'Not yet inspected', in_progress: 'Inspection in progress', pending: 'Inspected – pending approval',
    accepted: 'Accepted / verified', rejected: 'Rejected / rectification required', reinspection: 'For reinspection'
  };
  var CASE_KIND = { refusal: 'Pile refusal', rectification: 'Rectification' };
  var CASE_ST = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' };
  var FILE_KIND = { installation: 'Installation photo', inspection: 'Inspection evidence', 'case': 'Refusal / rectification evidence', document: 'Document' };
  var REPORTED = { completed: 1, reinspection: 1, accepted: 1 };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var PS = Pi.state = {
    loaded: false, loading: null, err: null, visible: false, polling: false, lastSync: null, syncErr: false,
    meta: 0, since: null, siteDate: null, canInspect: false,
    statuses: [], stById: new Map(), notStarted: null, istatuses: [], istById: new Map(), notInspected: null,
    areas: [], areaById: new Map(), origins: {},
    piles: [], byId: new Map(), byBlock: { 1: [], 5: [] },
    cur: new Map(), asg: new Map(), insp: new Map(), cases: new Map(), files: new Map(),
    sub: 'keyplan', block: 1, disp: 'status', f: { area: 'all', company: 'all', status: 'all' },
    sel: null, detail: new Map(), tool: null, pick: 'tap', multi: new Set(), bulkStatus: null, bulkRemarks: '',
    form: null, myTarget: null, firstFit: true
  };
  var PK = { cv: null, ctx: null, view: { x: 0, y: 0, w: 100, h: 100 }, block: null, pointers: new Map(), gesture: null, anim: null,
    raf: 0, grid: new Map(), groups: null, area: null, stale: true };

  function me() { return S.user || {}; }
  function isAdmin() { return X.isAdmin(); }
  function isSub() { return X.isSub(); }
  function official() { return !!PS.canInspect; }
  function companyName(id) { return X.companyName(id) || '—'; }
  function prefs() { return X.prefs(); }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------
  function loadPiles() {
    if (PS.loading) return PS.loading;
    PS.loading = call('get_piles', {}).then(function (d) {
      applyAll(d); PS.loaded = true; PS.err = null; PS.loading = null; PS.lastSync = new Date(); PS.syncErr = false;
    }, function (e) { PS.loading = null; PS.err = e; throw e; });
    return PS.loading;
  }
  function applyAll(d) {
    PS.meta = d.pile_meta_version; PS.since = d.server_time; PS.siteDate = d.site_date; PS.canInspect = !!d.can_inspect;
    PS.statuses = d.statuses || []; PS.stById = new Map(); PS.statuses.forEach(function (s) { PS.stById.set(s.id, s); });
    PS.notStarted = PS.statuses.filter(function (s) { return s.key === 'not_started'; })[0] || PS.statuses[0] || { id: 0, label: 'Not Started', color: '#c3cad2', category: 'not_started' };
    PS.istatuses = d.inspection_statuses || []; PS.istById = new Map(); PS.istatuses.forEach(function (s) { PS.istById.set(s.id, s); });
    PS.notInspected = PS.istatuses.filter(function (s) { return s.category === 'not_inspected'; })[0] || { id: 0, label: 'Not Yet Inspected', color: '#e2e6ea', category: 'not_inspected' };
    PS.areas = d.work_areas || []; PS.areaById = new Map(); PS.areas.forEach(function (a) { PS.areaById.set(a.id, a); });
    PS.origins = {}; (d.origins || []).forEach(function (o) { PS.origins[o.block] = { x: +o.x, y: +o.y }; });
    PS.piles = (d.piles || []).map(function (a) { return { id: a[0], code: a[1], block: a[2], area: a[3], x: +a[4], y: +a[5], table: a[6], active: !!a[7], sec: a[8] }; });
    PS.byId = new Map(); PS.byBlock = { 1: [], 5: [] };
    PS.piles.forEach(function (p) { PS.byId.set(p.id, p); (PS.byBlock[p.block] = PS.byBlock[p.block] || []).push(p); });
    PS.cur = new Map(); (d.current || []).forEach(function (c) { PS.cur.set(c[0], { uid: c[1], sid: c[2] }); });
    PS.asg = new Map(); (d.assignments || []).forEach(function (a) { PS.asg.set(a[0], a[1]); });
    PS.insp = new Map(); (d.inspections || []).forEach(function (i) { PS.insp.set(i[0], { sid: i[1], date: i[2] }); });
    PS.cases = new Map(); (d.open_cases || []).forEach(function (c) { var l = PS.cases.get(c[0]) || []; l.push({ id: c[1], kind: c[2], st: c[3] }); PS.cases.set(c[0], l); });
    PS.files = new Map(); (d.file_counts || []).forEach(function (f) { PS.files.set(f[0], f[1]); });
    PS.multi.forEach(function (id) { if (!PS.byId.has(id)) PS.multi.delete(id); });
    if (PS.sel && !PS.byId.has(PS.sel)) { PS.sel = null; PS.form = null; }
    PS.detail = new Map();
    if (PS.f.area !== 'all' && PS.f.area !== 'none' && !PS.areaById.has(+PS.f.area)) PS.f.area = 'all';
    buildGrid(); PK.stale = true;
  }
  function applyChanges(d) {
    var changed = new Set();
    (d.current || []).forEach(function (c) {
      var prev = PS.cur.get(c[0]);
      if (!prev || prev.uid < c[1]) { PS.cur.set(c[0], { uid: c[1], sid: c[2] }); changed.add(c[0]); }
    });
    (d.inspections || []).forEach(function (i) {
      var prev = PS.insp.get(i[0]);
      if (!prev || prev.sid !== i[1] || prev.date !== i[2]) { PS.insp.set(i[0], { sid: i[1], date: i[2] }); changed.add(i[0]); }
    });
    (d.cases || []).forEach(function (c) {
      var l = (c[1] || []).map(function (x) { return { id: x[0], kind: x[1], st: x[2] }; });
      if (l.length) PS.cases.set(c[0], l); else PS.cases.delete(c[0]);
      changed.add(c[0]);
    });
    (d.files || []).forEach(function (f) { if (f[1]) PS.files.set(f[0], f[1]); else PS.files.delete(f[0]); changed.add(f[0]); });
    changed.forEach(function (id) { if (PS.byId.has(id)) PS.detail.delete(id); });
    return changed;
  }
  function refreshAfterSave(full) {
    var pr = full ? loadPiles() : pollNow();
    return pr.then(function () { loadMyTarget(); render(); }, function () { render(); });
  }

  // polling (driven by app.js every 20 s while the Piles page is open)
  function pollNow() {
    if (!S.token || !PS.loaded) return Promise.resolve();
    // a save during a running check asks for one more check afterwards, so the new state always shows
    if (PS.polling) { PS.pollAgain = true; return PS.polling; }
    PS.polling = call('get_pile_changes', { p_since: PS.since }).then(function (d) {
      PS.lastSync = new Date(); PS.syncErr = false;
      if (d.pile_meta_version !== PS.meta) {
        return loadPiles().then(function () { loadMyTarget(); render(); });
      }
      PS.since = d.server_time;
      var ch = applyChanges(d);
      if (ch.size) {
        saveCopy();
        PK.stale = true; loadMyTarget();
        if (PS.sub === 'keyplan') {
          if (PS.sel && ch.has(PS.sel)) {
            if (PS.form) toast('Someone just updated ' + pileLabel(PS.byId.get(PS.sel)) + '. Check its status before saving.', 'err', 7000);
            else loadDetail(PS.sel, true);
          }
          drawKP(); renderLegend(); renderFilters(); renderPanel();
        } else if (PS.sub === 'dashboard' && Pi.renderDashboard) Pi.renderDashboard();
      }
    }).catch(function (e) { PS.syncErr = e.hint === 'network' || e.status >= 500; })
      .then(function () {
        PS.polling = null; renderSync();
        if (PS.pollAgain) { PS.pollAgain = false; return pollNow(); }
      });
    return PS.polling;
  }
  Pi.poll = function (force) {
    if (!PS.visible || (document.hidden && !force)) return;
    pollNow();
  };
  Pi.pollNow = function () { return PS.loaded ? pollNow() : Promise.resolve(); };
  // the copy of the pile data kept on this phone follows what was merged (no extra download)
  function saveCopy() {
    if (!OFF) return;
    var cur = [], ins = [], cases = [], files = [], since = PS.since;
    PS.cur.forEach(function (v, k) { cur.push([k, v.uid, v.sid]); });
    PS.insp.forEach(function (v, k) { ins.push([k, v.sid, v.date]); });
    PS.cases.forEach(function (l, k) { l.forEach(function (c) { cases.push([k, c.id, c.kind, c.st]); }); });
    PS.files.forEach(function (n, k) { files.push([k, n]); });
    OFF.cachePatch('get_piles', {}, function (d) { d.current = cur; d.inspections = ins; d.open_cases = cases; d.file_counts = files; d.server_time = since; return d; });
  }
  // connects the outbox with the Piles screens
  if (OFF) {
    OFF.hooks.serverExpected = OFF.hooks.serverExpected || {};
    OFF.hooks.serverExpected.submit_pile_updates = function (it) {
      var e = {}; (it.args.p_pile_ids || []).forEach(function (id) { var c = PS.cur.get(id); e[id] = c ? c.uid : null; });
      it.args.p_expected = e;
    };
    var pileSyncTimer = null, pileRaf = 0;
    OFF.on('synced', function (it, res, first) {
      if (first || !/^(submit_pile_updates|record_pile_inspection|save_pile_case|upload_pile_file)$/.test(it.fn)) return;
      ((it.fx && it.fx.list) || []).map(function (x) { return x.id; }).concat(it.fx && it.fx.pile_id ? [it.fx.pile_id] : []).forEach(function (id) { PS.detail.delete(id); });
      clearTimeout(pileSyncTimer);
      pileSyncTimer = setTimeout(function () { if (PS.loaded) pollNow().then(function () { if (PS.sel && PS.visible) loadDetail(PS.sel, true); }); }, 600);
    });
    OFF.on('change', function () {
      if (pileRaf || !PS.visible || !PS.loaded) return;
      pileRaf = requestAnimationFrame(function () {
        pileRaf = 0; PK.stale = true;
        if (PS.sub === 'keyplan') { drawKP(); renderLegend(); renderFilters(); if (!PS.form && !PS.tool) renderPanel(); }
        else if (PS.sub === 'dashboard' && Pi.renderDashboard) Pi.renderDashboard();
      });
    });
  }

  // ------------------------------------------------------------------
  // Pile helpers
  // ------------------------------------------------------------------
  function curP(p) { return pend().pile.get(p.id) || PS.cur.get(p.id) || null; }
  function stOf(p) { var c = curP(p); return (c && PS.stById.get(c.sid)) || PS.notStarted; }
  function catOf(p) { return stOf(p).category; }
  function inspOf(p) { var i = pend().pinsp.get(p.id) || PS.insp.get(p.id); return i ? PS.istById.get(i.sid) || null : null; }
  function openCases(p) { var w = pend().pcase.get(p.id); return w ? (PS.cases.get(p.id) || []).concat(w) : (PS.cases.get(p.id) || []); }
  function coOf(p) { var c = PS.asg.get(p.id); return c == null ? null : c; }
  function areaName(id) { var a = PS.areaById.get(id); return a ? a.name : ''; }
  function pileLabel(p) { return p ? p.code : '—'; }
  function placeLabel(p) { return 'Block ' + p.block + (p.area ? ' · ' + areaName(p.area) : '') + (p.table ? ' · Table ' + p.table : ''); }
  function canSetStatus(s) {
    if (!s || !s.is_active) return false;
    if (official()) return true;
    return isSub() && s.contractor_can_set && s.category !== 'accepted';
  }
  function settable() { return PS.statuses.filter(canSetStatus); }
  function canUpdatePile(p) {
    if (!p || !p.active) return false;
    if (official()) return true;
    return isSub() && coOf(p) === me().company_id && catOf(p) !== 'accepted';
  }
  function canCasePile(p) { return !!p && (official() || (isSub() && coOf(p) === me().company_id)); }
  function toolAllows(tool, p) {
    if (!p) return false;
    if (tool === 'status') return canUpdatePile(p);
    if (tool === 'inspect') return official() && p.active;
    if (tool === 'assign' || tool === 'area') return isAdmin();
    return false;
  }
  function whyNot(tool, p) {
    if (!p.active) return p.code + ' is taken out of the monitoring scope.';
    if (tool === 'status' && isSub()) {
      if (coOf(p) !== me().company_id) return p.code + ' is not assigned to your company.';
      if (catOf(p) === 'accepted') return p.code + ' is accepted / verified. Only the administrator or an inspector can change it.';
    }
    return 'You cannot select ' + p.code + ' for this.';
  }
  function passes(p) {
    var f = PS.f;
    if (f.area !== 'all') { if (f.area === 'none' ? p.area != null : String(p.area) !== f.area) return false; }
    if (f.company !== 'all') { var c = coOf(p); if (f.company === 'none' ? c != null : String(c) !== f.company) return false; }
    if (f.status !== 'all') {
      if (f.status === 'case') { if (!openCases(p).length) return false; }
      else if (f.status === 'off') { if (p.active) return false; }
      else if (!p.active || 's' + stOf(p).id !== f.status) return false;
    }
    return true;
  }
  function filtersActive() { return PS.f.area !== 'all' || PS.f.company !== 'all' || PS.f.status !== 'all'; }
  // counts of a list of piles (out-of-scope piles are counted apart)
  function counts(list) {
    var c = { total: 0, off: 0, cat: {}, st: new Map(), cases: 0, reported: 0, remaining: 0 };
    list.forEach(function (p) {
      if (!p.active) { c.off++; return; }
      c.total++;
      var s = stOf(p);
      c.cat[s.category] = (c.cat[s.category] || 0) + 1;
      c.st.set(s.id, (c.st.get(s.id) || 0) + 1);
      if (openCases(p).length) c.cases++;
    });
    c.reported = (c.cat.completed || 0) + (c.cat.reinspection || 0) + (c.cat.accepted || 0);
    c.remaining = c.total - c.reported;
    return c;
  }
  // block + work area + contractor filters (the status filter only highlights)
  function scopeList(block) {
    var f = PS.f;
    return (PS.byBlock[block] || []).filter(function (p) {
      if (f.area !== 'all') { if (f.area === 'none' ? p.area != null : String(p.area) !== f.area) return false; }
      if (f.company !== 'all') { var c = coOf(p); if (f.company === 'none' ? c != null : String(c) !== f.company) return false; }
      return true;
    });
  }
  function pchip(color, text) { var el = h('span', { class: 'pchip', color: color, text: text }); el.style.color = textColorOn(color); return el; }
  function stChip(s) { return pchip(s.color, s.label); }
  function iChip(s) { return s ? pchip(s.color, s.label) : pchip(PS.notInspected.color, PS.notInspected.label); }
  function coChip(cid) { return cid ? X.cchip(cid) : h('span', { class: 'pill', text: 'No contractor' }); }
  function caseChip(c) { return h('span', { class: 'pill ' + (c.pending ? 'pend-pill' : c.st === 'open' || c.st === 'in_progress' ? 'off' : 'on'), text: CASE_KIND[c.kind] + ' · ' + (c.pending ? 'waiting to send' : CASE_ST[c.st]) }); }
  function sw(color, extra) { return h('span', { class: 'sw psw' + (extra ? ' ' + extra : ''), color: color }); }
  function textColorOn(hex) {
    var n = parseInt(String(hex || '#999999').slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#15212c' : '#ffffff';
  }
  Pi._ = {
    PS: PS, X: X, h: h, call: call, loadPiles: loadPiles, refreshAfterSave: refreshAfterSave, stOf: stOf, catOf: catOf, inspOf: inspOf,
    openCases: openCases, coOf: coOf, areaName: areaName, counts: counts, pchip: pchip, stChip: stChip, iChip: iChip, coChip: coChip, caseChip: caseChip, sw: sw,
    CAT_LABEL: CAT_LABEL, ICAT_LABEL: ICAT_LABEL, CASE_KIND: CASE_KIND, CASE_ST: CASE_ST, FILE_KIND: FILE_KIND, REPORTED: REPORTED,
    official: official, canSetStatus: canSetStatus, isAdmin: isAdmin, isSub: isSub, textColorOn: textColorOn,
    openPile: function (id) { openPile(id); }, todayTargetCard: function (c) { return todayTargetCard(c); }, loadMyTarget: function () { loadMyTarget(); },
    pileDetails: function (id, force) { return loadDetail(id, force); }, showFile: function (f) { showFile(f); }
  };

  // ------------------------------------------------------------------
  // Page and sub-pages
  // ------------------------------------------------------------------
  Pi.show = function (force) {
    PS.visible = true;
    if (S.dbVersion && S.dbVersion < 9) {
      // site published before the database update: explain instead of failing
      PS.sub = 'keyplan'; renderShell();
      var em = $('#pempty'); em.hidden = false; em.textContent = '';
      ap(em, h('strong', { text: 'The Piles module needs database update 9.' }),
        h('span', { text: isAdmin() ? ' Run pv-monitoring-update-9.sql in the Supabase SQL Editor, then reload this page. The table keyplan keeps working meanwhile.'
          : ' Ask the administrator to install it. The table keyplan works as usual.' }));
      return;
    }
    var p = prefs();
    if (!PS.loaded && BLOCKS.indexOf(p.pblock) >= 0) PS.block = p.pblock;
    if (!PS.loaded && ['status', 'contractor', 'inspection'].indexOf(p.pdisp) >= 0) PS.disp = p.pdisp;
    $('#psub-setup').hidden = !isAdmin();
    if (PS.sub === 'setup' && !isAdmin()) PS.sub = 'keyplan';
    if (!PS.loaded) {
      renderShell();
      $('#pempty').hidden = false; $('#pempty').textContent = 'Loading sections…';
      loadPiles().then(function () { PS.firstFit = true; loadMyTarget(); render(); }, function (e) {
        $('#pempty').hidden = false; $('#pempty').textContent = e.message;
      });
      return;
    }
    if (force) pollNow();
    render();
  };
  Pi.hide = function () { PS.visible = false; };
  // drone photo under the pile keyplan (update 11): same photo, same background button
  function renderLayerCtl() { if (window.PVMDrone) window.PVMDrone.control($('#player-ctl'), PS.block); }
  if (window.PVMDrone) window.PVMDrone.on(function (kind) {
    if (kind !== 'tint') renderLayerCtl();
    drawKP();
  });
  Pi.reset = function () {
    PS.loaded = false; PS.loading = null; PS.piles = []; PS.byId = new Map(); PS.byBlock = { 1: [], 5: [] };
    PS.cur = new Map(); PS.asg = new Map(); PS.insp = new Map(); PS.cases = new Map(); PS.files = new Map();
    PS.sel = null; PS.detail = new Map(); PS.tool = null; PS.multi.clear(); PS.form = null; PS.myTarget = null; PS.sub = 'keyplan';
    PS.f = { area: 'all', company: 'all', status: 'all' }; PS.firstFit = true;
    if (Pi.resetPages) Pi.resetPages();
  };
  function setSub(s) {
    if (s === 'setup' && !isAdmin()) s = 'keyplan';
    var changed = s !== PS.sub;
    PS.sub = s; render(true);
    if (changed && PS.loaded) pollNow();
  }
  function renderShell() {
    $$('#view-piles .psub button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.psub === PS.sub)); });
    $('#pile-kp').hidden = PS.sub !== 'keyplan';
    $('#pile-page').hidden = PS.sub === 'keyplan';
  }
  function render(resetScroll) {
    if (!PS.visible) return;
    renderShell();
    if (PS.sub === 'keyplan') {
      renderToolbar(); renderFilters();
      if (PK.block !== PS.block || PK.stale) buildKeyplan();
      renderLegend(); renderPanel(); renderLayerCtl(); drawKP();
      requestAnimationFrame(onResize);
    } else if (PS.sub === 'dashboard') { if (Pi.renderDashboard) Pi.renderDashboard(resetScroll); }
    else if (Pi.renderSetup) Pi.renderSetup(resetScroll);
    renderSync();
  }
  Pi.render = render;
  function renderSync() {
    var el = $('#psync'); if (!el) return;
    var off = !!PS.syncErr || (OFF && !OFF.online), n = OFF ? OFF.count() : 0;
    el.classList.toggle('ok', !off && !!PS.lastSync && !n);
    el.classList.toggle('err', off);
    el.classList.toggle('wait', !off && !!n);
    $('#psync-text').textContent = off ? (n ? 'Offline · ' + n + ' to send' : 'Offline · saved data') : n ? n + ' to send'
      : PS.lastSync ? 'Updated ' + PS.lastSync.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'Connecting…';
  }
  function renderToolbar() {
    $$('#pseg-block button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.block === PS.block)); });
    $$('#pseg-disp button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.pdisp === PS.disp)); });
  }
  function setBlock(b) {
    if (b === PS.block) return;
    PS.block = b; X.savePrefs({ pblock: b });
    var s = PS.byId.get(PS.sel); if (s && s.block !== b) { PS.sel = null; PS.form = null; }
    if (PS.f.area !== 'all' && PS.f.area !== 'none') PS.f.area = 'all';
    render();
  }
  function setDisp(d) {
    if (d === PS.disp) return;
    PS.disp = d; X.savePrefs({ pdisp: d }); PK.stale = true; render();
  }

  // filters row with the counts of the block
  function renderFilters() {
    var box = $('#pfilters'); if (!box) return;
    box.textContent = '';
    var areas = PS.areas.filter(function (a) { return a.block === PS.block; });
    function sel(id, label, key, opts) {
      var s = h('select', { id: id, 'aria-label': label, onchange: function (e) { PS.f[key] = e.target.value; PK.stale = true; render(); } },
        opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(PS.f[key]) === String(o[0]) }); }));
      return h('label', { class: 'pf' }, h('span', { text: label }), s);
    }
    var cos = new Map(); (PS.byBlock[PS.block] || []).forEach(function (p) { var c = coOf(p); if (c) cos.set(c, 1); });
    var coOpts = [['all', 'All contractors'], ['none', 'No contractor']].concat(Array.from(cos.keys()).sort(function (a, b) { return companyName(a).localeCompare(companyName(b)); })
      .map(function (c) { return [String(c), companyName(c)]; }));
    var stOpts = [['all', 'All statuses']].concat(PS.statuses.map(function (s) { return ['s' + s.id, s.label + (s.is_active ? '' : ' (not in use)')]; }))
      .concat([['case', 'Open refusal / rectification case'], ['off', 'Taken out of scope']]);
    ap(box, 
      sel('pf-area', 'Work area', 'area', [['all', 'All work areas'], ['none', 'No work area']].concat(areas.map(function (a) { return [String(a.id), a.name + (a.is_active ? '' : ' (inactive)')]; }))),
      isSub() ? null : sel('pf-co', 'Contractor', 'company', coOpts),
      sel('pf-st', 'Status', 'status', stOpts),
      filtersActive() ? h('button', { type: 'button', class: 'btn small ghost', text: 'Clear filters', onclick: function () { PS.f = { area: 'all', company: 'all', status: 'all' }; PK.stale = true; render(); } }) : null);
    var c = counts(scopeList(PS.block));
    var stats = h('div', { class: 'pstats', 'aria-label': 'Pile totals' },
      stat('Total sections', c.total), stat('Reported complete', c.reported), stat('Accepted', c.cat.accepted || 0), stat('Remaining', c.remaining),
      stat('On hold', c.cat.on_hold || 0), stat('Pile refusal', c.cat.refusal || 0), stat('Rectification', c.cat.rectification || 0),
      c.cases ? stat('Open cases', c.cases) : null, c.off ? stat('Out of scope', c.off) : null);
    ap(box, stats);
  }
  function stat(label, n) { return h('span', { class: 'pstat' }, h('b', { text: String(n) }), ' ' + label); }

  // ------------------------------------------------------------------
  // Keyplan (canvas): tables are drawn faintly, piles as dots
  // ------------------------------------------------------------------
  function buildGrid() {
    PK.grid = new Map();
    PS.piles.forEach(function (p) {
      var k = p.block + ':' + Math.floor(p.x / 5) + ':' + Math.floor(p.y / 5);
      var l = PK.grid.get(k); if (!l) PK.grid.set(k, l = []); l.push(p);
    });
  }
  function colorFor(p) {
    if (PS.disp === 'contractor') { var c = coOf(p); return c ? X.colorOf(c) : '#9aa5b0'; }
    if (PS.disp === 'inspection') { var i = inspOf(p); return i ? i.color : PS.notInspected.color; }
    return stOf(p).color;
  }
  function buildGroups() {
    var g = new Map(), dim = [], off = [];
    (PS.byBlock[PS.block] || []).forEach(function (p) {
      if (!p.active) { off.push(p); return; }
      if (!passes(p)) { dim.push(p); return; }
      var col = colorFor(p), l = g.get(col); if (!l) g.set(col, l = []); l.push(p);
    });
    PK.groups = { byColor: g, dim: dim, off: off };
  }
  function buildKeyplan() {
    PK.cv = $('#pkp'); PK.ctx = PK.cv.getContext('2d');
    var first = PK.block !== PS.block || PS.firstFit;
    PK.block = PS.block; PK.stale = false;
    buildGroups();
    var empty = $('#pempty');
    var none = !PS.piles.length;
    empty.hidden = !none;
    if (none) {
      empty.textContent = '';
      ap(empty, h('strong', { text: isSub() ? 'No sections are assigned to your company for pile installation yet.' : 'No table sections to show.' }),
        h('span', { text: isSub() ? ' Ask the administrator to assign them on the pile keyplan.' : ' Sections get a pile record once they have a section ID.' }));
    }
    if (first) requestAnimationFrame(function () { if (!(isSub() && fitScope(false))) fitView(false); PS.firstFit = false; });
  }
  function canvasRect() { return PK.cv ? PK.cv.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 }; }
  function kpOf(b) { return S.kp[b] || { width: 100, height: 100, lines: [] }; }
  function setVB(v) { PK.view = v; drawKP(); }
  function drawKP() { if (!PK.raf) PK.raf = requestAnimationFrame(paint); }
  function ppuNow() { var r = canvasRect(); return r.width ? r.width / PK.view.w : 1; }
  function paint() {
    PK.raf = 0;
    var cv = PK.cv; if (!cv || $('#pile-kp').hidden || !PS.visible) return;
    if (PK.stale) { buildGroups(); PK.stale = false; }
    var r = canvasRect(); if (!r.width || !r.height) return;
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    var ctx = PK.ctx, v = PK.view, ppu = r.width / v.w, k = ppu * dpr, px = 1 / ppu;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
    if (PK.secRef !== S.sections) { PK.secRef = S.sections; tableBoxes(); }
    var kp = kpOf(PS.block);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, +kp.width, +kp.height);
    // drone photo under the drawing (update 11), at true size in keyplan metres
    var DR = window.PVMDrone, photo = !!(DR && S.kp[PS.block] && DR.draw(ctx, PS.block, v, r.width, r.height, dpr, drawKP));
    var tint = photo ? DR.tint() : 1;
    ctx.lineWidth = px; ctx.strokeStyle = '#b9c2cb'; ctx.strokeRect(0, 0, +kp.width, +kp.height);
    ctx.beginPath();
    (kp.lines || []).forEach(function (l) { ctx.moveTo(l[0], l[1]); ctx.lineTo(l[2], l[3]); });
    ctx.lineWidth = 1.2 * px; ctx.strokeStyle = photo ? 'rgba(255,255,255,.8)' : '#8d98a4'; ctx.stroke();
    // table sections as faint context
    var x0 = v.x, y0 = v.y, x1 = v.x + v.w, y1 = v.y + v.h;
    ctx.beginPath();
    (S.secByBlock[PS.block] || []).forEach(function (s) {
      var g = s.geom; if (g[0] > x1 || g[1] > y1 || g[0] + g[2] < x0 || g[1] + g[3] < y0) return;
      ctx.rect(g[0], g[1], g[2], g[3]);
    });
    if (photo) { ctx.lineWidth = 0.8 * px; ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.stroke(); }
    else { ctx.fillStyle = '#f2f4f7'; ctx.fill(); ctx.lineWidth = 0.8 * px; ctx.strokeStyle = '#aab4be'; ctx.stroke(); }
    if (ppu >= 6) {
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '600 11px ' + getComputedStyle(document.body).fontFamily; ctx.fillStyle = photo ? '#15212c' : '#8a96a2'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (photo) { ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; }
      S.tables.forEach(function (t) {
        if (t.block !== PS.block || !t.code || !t._pbb) return;
        var cx = (t._pbb[0] + t._pbb[2]) / 2, cy = t._pbb[1] - 1.2;
        if (cx < x0 || cx > x1 || cy < y0 || cy > y1) return;
        if (photo) ctx.strokeText(t.code, (cx - v.x) * ppu, (cy - v.y) * ppu);
        ctx.fillText(t.code, (cx - v.x) * ppu, (cy - v.y) * ppu);
      });
      ctx.restore();
    }
    // sections coloured by their pile status
    var m = 2;
    function inView(p) { var g = gOf(p); return g && g[0] <= x1 + m && g[1] <= y1 + m && g[0] + g[2] >= x0 - m && g[1] + g[3] >= y0 - m; }
    function rects(list, grow) {
      ctx.beginPath();
      list.forEach(function (p) { if (!inView(p)) return; var g = gOf(p); ctx.rect(g[0] - grow, g[1] - grow, g[2] + 2 * grow, g[3] + 2 * grow); });
    }
    var G = PK.groups || { byColor: new Map(), dim: [], off: [] };
    if (G.dim.length) {
      ctx.globalAlpha = 0.22; rects(G.dim, 0); ctx.fillStyle = '#9aa5b0'; ctx.fill(); ctx.globalAlpha = 1;
    }
    G.byColor.forEach(function (list, col) {
      rects(list, 0); ctx.fillStyle = col; ctx.globalAlpha = tint; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = px; ctx.strokeStyle = photo ? 'rgba(255,255,255,.9)' : 'rgba(21,33,44,.55)'; ctx.stroke();
    });
    if (G.off.length) { rects(G.off, 0); ctx.fillStyle = '#ffffff'; ctx.globalAlpha = tint; ctx.fill(); ctx.globalAlpha = 1; ctx.lineWidth = 1.2 * px; ctx.strokeStyle = '#7a8692'; ctx.stroke(); }
    // open refusal / rectification cases: red outline
    rects((PS.byBlock[PS.block] || []).filter(function (p) { return openCases(p).length; }), 1.6 * px);
    ctx.lineWidth = 2.4 * px; ctx.strokeStyle = '#c0262d'; ctx.stroke();
    // saved on this phone, not sent yet: dashed blue outline
    var pl = (PS.byBlock[PS.block] || []).filter(isPending);
    if (pl.length) {
      rects(pl, 1.4 * px); ctx.setLineDash([5 * px, 3 * px]); ctx.lineWidth = 2.2 * px; ctx.strokeStyle = '#1d5bd8'; ctx.stroke(); ctx.setLineDash([]);
    }
    // selection
    if (PS.multi.size) {
      var ml = []; PS.multi.forEach(function (id) { var p = PS.byId.get(id); if (p && p.block === PS.block) ml.push(p); });
      rects(ml, 0.9 * px); ctx.lineWidth = 2.6 * px; ctx.strokeStyle = '#1d5bd8'; ctx.stroke();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var sp = PS.byId.get(PS.sel), sg = sp && gOf(sp);
    if (sp && sg && sp.block === PS.block) {
      var sx0 = (sg[0] - v.x) * ppu, sy0 = (sg[1] - v.y) * ppu, sw0 = sg[2] * ppu, sh0 = sg[3] * ppu;
      ctx.lineWidth = 3; ctx.strokeStyle = '#1d5bd8'; ctx.strokeRect(sx0 - 3, sy0 - 3, sw0 + 6, sh0 + 6);
      ctx.font = '700 13px ' + getComputedStyle(document.body).fontFamily;
      var sx = sx0 + sw0 / 2, tw = ctx.measureText(sp.code).width + 14, th = 22, tx = sx - tw / 2, ty = sy0 - 10 - th;
      ctx.fillStyle = '#1d5bd8'; roundRect(ctx, tx, ty, tw, th, 4); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(sp.code, sx, ty + th / 2);
    }
    if (PK.area) {
      var a = PK.area;
      ctx.setTransform(k, 0, 0, k, -v.x * k, -v.y * k);
      ctx.fillStyle = 'rgba(29,91,216,.08)'; ctx.fillRect(Math.min(a.a.x, a.b.x), Math.min(a.a.y, a.b.y), Math.abs(a.a.x - a.b.x), Math.abs(a.a.y - a.b.y));
      ctx.setLineDash([6 * px, 4 * px]); ctx.lineWidth = 2 * px; ctx.strokeStyle = '#1d5bd8';
      ctx.strokeRect(Math.min(a.a.x, a.b.x), Math.min(a.a.y, a.b.y), Math.abs(a.a.x - a.b.x), Math.abs(a.a.y - a.b.y)); ctx.setLineDash([]);
    }
    PK.cv.setAttribute('aria-label', 'Pile keyplan Block ' + PS.block + ' · ' + (PS.disp === 'contractor' ? 'contractors' : PS.disp === 'inspection' ? 'inspection status' : 'installation status') + ' · ' + plural((PS.byBlock[PS.block] || []).length, 'section'));
  }
  function roundRect(ctx, x, y, w, hh, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r); ctx.lineTo(x + w, y + hh - r);
    ctx.quadraticCurveTo(x + w, y + hh, x + w - r, y + hh); ctx.lineTo(x + r, y + hh); ctx.quadraticCurveTo(x, y + hh, x, y + hh - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function tableBoxes() {
    // table outline per table (for labels), computed once per data load
    S.tables.forEach(function (t) { t._pbb = null; });
    S.sections.forEach(function (s) {
      var t = S.tables.get(s.table_id); if (!t) return; var g = s.geom;
      var bb = t._pbb || [Infinity, Infinity, -Infinity, -Infinity];
      t._pbb = [Math.min(bb[0], g[0]), Math.min(bb[1], g[1]), Math.max(bb[2], g[0] + g[2]), Math.max(bb[3], g[1] + g[3])];
    });
  }
  function zoomLimits() { var kp = kpOf(PS.block), r = canvasRect(), aspect = r.width / Math.max(1, r.height); return { min: 4, max: Math.max(+kp.width, +kp.height * aspect) * 2.5 }; }
  function clampCenter(v) {
    var kp = kpOf(PS.block), cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    var ncx = Math.min(Math.max(cx, 0), +kp.width), ncy = Math.min(Math.max(cy, 0), +kp.height);
    return { x: v.x + (ncx - cx), y: v.y + (ncy - cy), w: v.w, h: v.h };
  }
  function panelCover() { if (window.innerWidth > 900) return 0; var p = $('#ppanel'); return p && !p.hidden ? p.getBoundingClientRect().height : 0; }
  function fitBox(bb, animate, minW) {
    var r = canvasRect(); if (!r.width || !r.height) return;
    var W = bb[2] - bb[0], H = bb[3] - bb[1];
    if (minW && W < minW) { var cx = (bb[0] + bb[2]) / 2; bb = [cx - minW / 2, bb[1], cx + minW / 2, bb[3]]; W = minW; }
    var padL = 14, padR = 14, padT = 14, padB = 14;
    if (window.innerWidth > 900) { var tb = $('#ptitleblock').getBoundingClientRect(); padL = Math.max(padL, tb.width + 24); padR = 70; }
    else { padR = 58; padB = Math.max(padB, panelCover() + 8); }
    var availW = Math.max(60, r.width - padL - padR), availH = Math.max(60, r.height - padT - padB);
    var ppu = Math.min(availW / Math.max(W, 1), availH / Math.max(H, 1));
    var v = { x: bb[0] - (padL + (availW - W * ppu) / 2) / ppu, y: bb[1] - (padT + (availH - H * ppu) / 2) / ppu, w: r.width / ppu, h: r.height / ppu };
    if (animate) animateTo(v); else setVB(v);
  }
  function fitView(animate) { var kp = kpOf(PS.block); fitBox([0, 0, +kp.width, +kp.height], animate); }
  function fitScope(animate) {
    var list = (PS.byBlock[PS.block] || []); if (!list.length) return false;
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    list.forEach(function (p) { bb = [Math.min(bb[0], p.x), Math.min(bb[1], p.y), Math.max(bb[2], p.x), Math.max(bb[3], p.y)]; });
    fitBox([bb[0] - 8, bb[1] - 8, bb[2] + 8, bb[3] + 8], animate, 60);
    return true;
  }
  function onResize() {
    if (!PK.cv || $('#pile-kp').hidden || !PS.visible) return;
    var r = canvasRect(); if (!r.width || !r.height) return;
    var v = PK.view, upp = PK.upp || v.w / r.width;
    if (PK.lastW && Math.abs(PK.lastW - r.width) < 1 && Math.abs(PK.lastH - r.height) < 1) { drawKP(); return; }
    var cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    if (PK.lastW) upp = v.w / PK.lastW;
    PK.lastW = r.width; PK.lastH = r.height; PK.upp = upp;
    setVB({ x: cx - r.width * upp / 2, y: cy - r.height * upp / 2, w: r.width * upp, h: r.height * upp });
  }
  function zoomAt(ux, uy, f) {
    var v = PK.view, r = canvasRect(), lim = zoomLimits();
    var w = Math.min(Math.max(v.w / f, lim.min), lim.max), kk = w / v.w;
    setVB(clampCenter({ x: ux - (ux - v.x) * kk, y: uy - (uy - v.y) * kk, w: w, h: w * r.height / r.width }));
  }
  function zoomCenter(f) { var v = PK.view; zoomAt(v.x + v.w / 2, v.y + v.h / 2, f); }
  function toUser(cx, cy) { var r = canvasRect(), v = PK.view; return { x: v.x + (cx - r.left) / r.width * v.w, y: v.y + (cy - r.top) / r.height * v.h }; }
  function animateTo(target) {
    if (PK.anim) cancelAnimationFrame(PK.anim);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { setVB(target); return; }
    var from = Object.assign({}, PK.view), t0 = performance.now(), dur = 380;
    function step(now) {
      var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      setVB({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
      if (p < 1) PK.anim = requestAnimationFrame(step); else PK.anim = null;
    }
    PK.anim = requestAnimationFrame(step);
  }
  function zoomToPile(p, animate) {
    var r = canvasRect(); if (!r.width) return;
    var w = 36, hh = w * r.height / r.width, upp = w / r.width, cover = panelCover();
    var visibleH = Math.max(120, r.height - cover);
    var v = { x: p.x - w / 2, y: p.y - (visibleH * 0.5) * upp, w: w, h: hh };
    if (animate) animateTo(v); else setVB(v);
  }
  function ensureVisible(p) {
    var r = canvasRect(), v = PK.view; if (!r.width) return;
    var cover = panelCover() * (v.h / r.height);
    if (!(p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h - cover)) {
      animateTo(clampCenter({ x: p.x - v.w / 2, y: p.y - (v.h - cover) / 2, w: v.w, h: v.h }));
    }
  }
  // section under a screen point (or the nearest one within a finger's reach)
  function gOf(p) { var x = p && S.sections.get(p.sec); return x ? x.geom : null; }
  function hitTest(cx, cy) {
    var u = toUser(cx, cy), ppu = ppuNow(), rad = Math.max(0.6, 12 / ppu), best = null, bd = Infinity;
    (PS.byBlock[PS.block] || []).forEach(function (p) {
      var g = gOf(p); if (!g) return;
      var dx = Math.max(g[0] - u.x, 0, u.x - (g[0] + g[2])), dy = Math.max(g[1] - u.y, 0, u.y - (g[1] + g[3])), d = Math.hypot(dx, dy);
      if (d <= rad && d < bd) { bd = d; best = p; }
    });
    return best;
  }
  function pilesInRect(a, b) {
    var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return (PS.byBlock[PS.block] || []).filter(function (p) { return p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1; });
  }
  Pi.screenOf = function (code) {
    var p = PS.piles.filter(function (x) { return x.code === code; })[0]; if (!p || p.block !== PS.block) return null;
    var r = canvasRect(), v = PK.view;
    return { x: r.left + (p.x - v.x) / v.w * r.width, y: r.top + (p.y - v.y) / v.h * r.height };
  };
  function wireCanvas() {
    var el = $('#pkp');
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (PK.anim) { cancelAnimationFrame(PK.anim); PK.anim = null; }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      PK.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (PK.pointers.size === 1) {
        if (PS.tool && PS.pick === 'area') PK.gesture = { type: 'area', start: toUser(e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, moved: 0 };
        else PK.gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, view: Object.assign({}, PK.view), moved: 0 };
      } else if (PK.pointers.size === 2) {
        var pts = Array.from(PK.pointers.values()); PK.area = null;
        PK.gesture = { type: 'pinch', d0: Math.max(10, dist(pts[0], pts[1])), m0: mid(pts[0], pts[1]), view: Object.assign({}, PK.view), moved: 99 };
      }
      var hint = $('#pcanvas-hint'); if (hint) hint.classList.add('gone');
    });
    el.addEventListener('pointermove', function (e) {
      if (!PK.pointers.has(e.pointerId)) return;
      PK.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var g = PK.gesture; if (!g) return;
      var r = canvasRect();
      if (g.type === 'area' && PK.pointers.size === 1) {
        g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.sx, e.clientY - g.sy));
        if (g.moved < 5) return;
        PK.area = { a: g.start, b: toUser(e.clientX, e.clientY) }; drawKP();
      } else if (g.type === 'pan' && PK.pointers.size === 1) {
        var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        g.moved = Math.max(g.moved, Math.hypot(dx, dy));
        if (g.moved < 5) return;
        el.classList.add('dragging');
        var upp = g.view.w / r.width;
        setVB(clampCenter({ x: g.view.x - dx * upp, y: g.view.y - dy * upp, w: g.view.w, h: g.view.h }));
      } else if (g.type === 'pinch' && PK.pointers.size >= 2) {
        var pts = Array.from(PK.pointers.values()), f = dist(pts[0], pts[1]) / g.d0, m = mid(pts[0], pts[1]);
        var upp0 = g.view.w / r.width, ux = g.view.x + (g.m0.x - r.left) * upp0, uy = g.view.y + (g.m0.y - r.top) * upp0, lim = zoomLimits();
        var w = Math.min(Math.max(g.view.w / f, lim.min), lim.max), kk = w / g.view.w, upp1 = w / r.width;
        setVB(clampCenter({ x: ux - (ux - g.view.x) * kk - (m.x - g.m0.x) * upp1, y: uy - (uy - g.view.y) * kk - (m.y - g.m0.y) * upp1, w: w, h: w * r.height / r.width }));
      }
    });
    function end(e) {
      if (!PK.pointers.has(e.pointerId)) return;
      PK.pointers.delete(e.pointerId);
      var g = PK.gesture;
      if (g && PK.pointers.size === 0 && e.type === 'pointerup') {
        if (g.type === 'area') {
          PK.area = null;
          if (g.moved >= 5) areaSelect(pilesInRect(g.start, toUser(e.clientX, e.clientY)));
          else { var t = hitTest(e.clientX, e.clientY); if (t) toggleMulti(t); else drawKP(); }
        } else if (g.type === 'pan' && g.moved < 6) {
          var p = hitTest(e.clientX, e.clientY);
          if (PS.tool) { if (p) toggleMulti(p); }
          else if (p) selectPile(p.id, { source: 'map' });
          else if (PS.sel && !PS.form) selectPile(null);
        }
      }
      if (PK.pointers.size === 0) { PK.gesture = null; el.classList.remove('dragging'); }
      else if (PK.pointers.size === 1) { var q = Array.from(PK.pointers.values())[0]; PK.gesture = { type: 'pan', sx: q.x, sy: q.y, view: Object.assign({}, PK.view), moved: 99 }; }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', function (e) { PK.area = null; end(e); drawKP(); });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var u = toUser(e.clientX, e.clientY), dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      zoomAt(u.x, u.y, Math.exp(-dy * 0.0016));
      var hint = $('#pcanvas-hint'); if (hint) hint.classList.add('gone');
    }, { passive: false });
    el.addEventListener('keydown', function (e) {
      var v = PK.view, step = 0.12;
      if (e.key === '+' || e.key === '=') zoomCenter(1.5);
      else if (e.key === '-' || e.key === '_') zoomCenter(1 / 1.5);
      else if (e.key === '0') fitView(true);
      else if (e.key === 'Escape' && PS.multi.size) { PS.multi.clear(); drawKP(); renderPanel(); }
      else if (e.key === 'ArrowLeft') setVB(clampCenter({ x: v.x - v.w * step, y: v.y, w: v.w, h: v.h }));
      else if (e.key === 'ArrowRight') setVB(clampCenter({ x: v.x + v.w * step, y: v.y, w: v.w, h: v.h }));
      else if (e.key === 'ArrowUp') setVB(clampCenter({ x: v.x, y: v.y - v.h * step, w: v.w, h: v.h }));
      else if (e.key === 'ArrowDown') setVB(clampCenter({ x: v.x, y: v.y + v.h * step, w: v.w, h: v.h }));
      else return;
      e.preventDefault();
    });
    $('#pzoom-in').addEventListener('click', function () { zoomCenter(1.6); });
    $('#pzoom-out').addEventListener('click', function () { zoomCenter(1 / 1.6); });
    $('#pzoom-fit').addEventListener('click', function () { if (!(isSub() && fitScope(true))) fitView(true); });
    window.addEventListener('resize', function () { requestAnimationFrame(onResize); });
  }

  // legend: title block (desktop) and strip (phones)
  function legendRows() {
    var list = scopeList(PS.block), rows = [];
    if (PS.disp === 'contractor') {
      var by = new Map(), un = 0;
      list.forEach(function (p) { var c = coOf(p); if (c) by.set(c, (by.get(c) || 0) + 1); else un++; });
      Array.from(by.keys()).sort(function (a, b) { return companyName(a).localeCompare(companyName(b)); }).forEach(function (c) {
        rows.push({ color: X.colorOf(c), label: companyName(c), n: by.get(c) });
      });
      rows.push({ color: '#9aa5b0', label: 'No contractor', n: un });
      return { kind: 'Pile contractors', rows: rows, total: list.length, foot: ['Assigned', X.fmtPct(list.length - un, list.length)] };
    }
    if (PS.disp === 'inspection') {
      var bi = new Map(), none = 0, tot = 0;
      list.forEach(function (p) { if (!p.active) return; tot++; var i = inspOf(p); if (i) bi.set(i.id, (bi.get(i.id) || 0) + 1); else none++; });
      PS.istatuses.forEach(function (s) {
        var n = (bi.get(s.id) || 0) + (s.id === PS.notInspected.id ? none : 0);
        if (s.is_active || n) rows.push({ color: s.color, label: s.label, n: n });
      });
      var acc = 0; PS.istatuses.forEach(function (s) { if (s.category === 'accepted') acc += bi.get(s.id) || 0; });
      return { kind: 'Pile inspection', rows: rows, total: tot, foot: ['Accepted / verified', X.fmtPct(acc, tot)] };
    }
    var c = counts(list);
    PS.statuses.forEach(function (s) { var n = c.st.get(s.id) || 0; if (s.is_active || n) rows.push({ color: s.color, label: s.label, n: n }); });
    return { kind: 'Pile installation status', rows: rows, total: c.total, foot: ['Accepted', X.fmtPct(c.cat.accepted || 0, c.total)], c: c };
  }
  function renderLegend() {
    var L = legendRows(), tb = $('#ptitleblock'), list = scopeList(PS.block);
    var off = list.filter(function (p) { return !p.active; }).length, cs = list.filter(function (p) { return openCases(p).length; }).length;
    tb.textContent = '';
    var rows = h('div', { class: 'tb-rows' });
    L.rows.forEach(function (r) { ap(rows, h('div', null, sw(r.color)), h('div', { text: r.label }), h('div', { class: 'num', text: String(r.n) })); });
    if (cs) ap(rows, h('div', null, h('span', { class: 'psw-ring' })), h('div', { text: 'Open refusal / rectification case' }), h('div', { class: 'num', text: String(cs) }));
    var pn = (PS.byBlock[PS.block] || []).filter(isPending).length;
    if (pn) ap(rows, h('div', null, h('span', { class: 'sw pend-sw' })), h('div', { text: 'Waiting to send (saved on this phone)' }), h('div', { class: 'num', text: String(pn) }));
    if (off) ap(rows, h('div', null, h('span', { class: 'psw-off' })), h('div', { text: 'Out of scope (not counted)' }), h('div', { class: 'num', text: String(off) }));
    ap(tb, h('div', { class: 'tb-head' },
      h('div', { class: 'tb-blk', text: 'Block ' + PS.block + ' · sections' }), h('div', { class: 'tnum', text: plural(L.total, 'section') }),
      h('div', { class: 'tb-act' }, h('strong', { text: L.kind }), filtersActive() ? h('span', { class: 'tb-note', text: 'filtered' }) : null)),
      rows,
      h('div', { class: 'tb-foot' }, h('span', { text: L.foot[0] }), h('strong', { class: 'tnum', text: L.foot[1] })));
    var strip = $('#plegend-strip'); strip.textContent = '';
    ap(strip, h('span', { class: 'ls-title', text: 'B' + PS.block + ' · ' + (PS.disp === 'contractor' ? 'contractors' : PS.disp === 'inspection' ? 'inspection' : 'sections') }));
    L.rows.forEach(function (r) { ap(strip, h('span', { class: 'ls-item' }, sw(r.color), r.label + ' ', h('b', { text: String(r.n) }))); });
    if (cs) ap(strip, h('span', { class: 'ls-item' }, h('span', { class: 'psw-ring' }), 'Open case ', h('b', { text: String(cs) })));
  }

  // ------------------------------------------------------------------
  // Selection
  // ------------------------------------------------------------------
  function selectPile(id, opts) {
    opts = opts || {};
    if (PS.form && PS.sel && id !== PS.sel && PS.form.dirty) { toast('Finish or cancel the update of ' + pileLabel(PS.byId.get(PS.sel)) + ' first.', 'err'); return; }
    var changed = PS.sel !== id;
    PS.sel = id; PS.form = null;
    drawKP(); renderPanel();
    if (changed) { var pp = $('#ppanel'); if (pp) pp.scrollTop = 0; }
    var p = PS.byId.get(id);
    if (p) {
      loadDetail(p.id);
      if (opts.zoom) zoomToPile(p, true);
      else if (opts.source === 'map' && window.innerWidth <= 900) requestAnimationFrame(function () { ensureVisible(p); });
    }
  }
  function openPile(id) {
    var p = PS.byId.get(id); if (!p) { toast('That section is not in your view.', 'err'); return; }
    PS.tool = null; PS.multi.clear();
    if (PS.block !== p.block) { PS.block = p.block; X.savePrefs({ pblock: p.block }); }
    PS.sub = 'keyplan'; PK.stale = true; render(true);
    requestAnimationFrame(function () { selectPile(p.id, { zoom: true }); });
  }
  function toggleMulti(p) {
    if (!toolAllows(PS.tool, p)) { toast(whyNot(PS.tool, p), 'err', 5000); return; }
    if (PS.multi.has(p.id)) PS.multi.delete(p.id); else PS.multi.add(p.id);
    drawKP(); renderPanel();
  }
  function areaSelect(hit) {
    var all = hit.filter(passes), ok = all.filter(function (p) { return toolAllows(PS.tool, p); });
    ok.forEach(function (p) { PS.multi.add(p.id); });
    if (!hit.length) toast('No sections inside that area. Draw a box around the sections.', 'err');
    else if (ok.length < all.length) toast(plural(all.length - ok.length, 'section') + ' in the box ' + (all.length - ok.length === 1 ? 'is' : 'are') + ' not yours to select here and ' + (all.length - ok.length === 1 ? 'was' : 'were') + ' left out.', 'err', 5000);
    drawKP(); renderPanel();
  }
  function panelTop() { var pp = $('#ppanel'); if (pp) pp.scrollTop = 0; }
  function startTool(t) {
    PS.tool = t; PS.sel = null; PS.form = null; PS.multi.clear(); PS.pick = 'tap'; PS.bulkStatus = null; PS.bulkRemarks = '';
    drawKP(); renderPanel(); panelTop();
  }
  function endTool() { PS.tool = null; PS.multi.clear(); PS.bulkStatus = null; PS.bulkRemarks = ''; drawKP(); renderPanel(); panelTop(); }
  function selection() {
    return Array.from(PS.multi).map(function (id) { return PS.byId.get(id); }).filter(function (p) { return p && toolAllows(PS.tool, p); })
      .sort(function (a, b) { return a.block - b.block || X.cmpCode(a.code, b.code); });
  }

  // ------------------------------------------------------------------
  // Side panel
  // ------------------------------------------------------------------
  function renderPanel() {
    var P = $('#ppanel'); if (!P) return;
    P.textContent = '';
    var p = PS.byId.get(PS.sel);
    P.classList.toggle('collapsed', false);
    if (PS.tool) renderTool(P);
    else if (p) { if (PS.form) renderForm(P, p); else renderDetails(P, p); }
    else renderSummary(P);
  }
  function toolButtons() {
    var b = [];
    if (settable().length && (official() || isSub())) b.push(h('button', { type: 'button', class: 'btn small', id: 'pbtn-bulk', text: 'Update several sections', onclick: function () { startTool('status'); } }));
    if (official()) b.push(h('button', { type: 'button', class: 'btn small', id: 'pbtn-insp', text: 'Record inspection', onclick: function () { startTool('inspect'); } }));
    if (isAdmin()) {
      b.push(h('button', { type: 'button', class: 'btn small', id: 'pbtn-assign', text: 'Assign contractors', onclick: function () { startTool('assign'); } }));
      b.push(h('button', { type: 'button', class: 'btn small', id: 'pbtn-area', text: 'Set work area', onclick: function () { startTool('area'); } }));
    }
    return b.length ? h('div', { class: 'tool-row' }, b) : null;
  }
  function renderSummary(P) {
    var list = scopeList(PS.block), c = counts(list);
    var stack = h('div', { class: 'stack psummary' });
    if (isSub()) { var card = todayTargetCard(true); if (card) ap(stack, card); }
    ap(stack, h('div', null, h('h2', { text: 'Piles · Block ' + PS.block }),
      h('p', { class: 'panel-sub', text: PS.piles.length ? (filtersActive() ? 'Filtered view. ' : '') + 'Tap a section to see its details and history.' : 'No sections yet.' })));
    if (list.length) {
      ap(stack, h('div', { class: 'summary-grid' },
        PS.statuses.filter(function (s) { return c.st.get(s.id); }).map(function (s) {
          return [sw(s.color), h('span', { text: s.label }), h('span', { class: 'num', text: String(c.st.get(s.id)) })];
        })),
      h('div', { class: 'pbar', 'aria-hidden': 'true' }, PS.statuses.map(function (s) {
        var n = c.st.get(s.id) || 0; if (!n) return null; var sp = h('span', { color: s.color }); sp.style.width = (100 * n / Math.max(1, c.total)) + '%'; return sp;
      })),
      h('p', { class: 'small', text: c.reported + ' of ' + c.total + ' reported complete (' + X.fmtPct(c.reported, c.total) + '), ' + (c.cat.accepted || 0) + ' accepted (' + X.fmtPct(c.cat.accepted || 0, c.total) + '). Remaining: ' + c.remaining + '.' }));
    }
    var tb = toolButtons(); if (tb) ap(stack, tb);
    ap(P, stack);
  }

  // ---- pile details
  function loadDetail(id, force) {
    var cur = PS.detail.get(id);
    if (!force && cur && cur !== 'error') return Promise.resolve(cur === 'loading' ? null : cur);
    PS.detail.set(id, 'loading');
    return call('get_pile_detail', { p_pile_id: id }).then(function (d) {
      PS.detail.set(id, d); if (PS.sel === id && PS.sub === 'keyplan' && !PS.form) renderPanel(); return d;
    }, function (e) { PS.detail.set(id, 'error'); if (PS.sel === id && PS.sub === 'keyplan') renderPanel(); toast(e.message, 'err'); return null; });
  }
  function kv(pairs) {
    var dl = h('dl', { class: 'kv' });
    pairs.forEach(function (x) { if (x) ap(dl, h('dt', { text: x[0] }), h('dd', null, x[1])); });
    return dl;
  }
  function renderDetails(P, p) {
    var d = PS.detail.get(p.id), st = stOf(p), cu = PS.cur.get(p.id), ins = inspOf(p), cs = openCases(p), co = coOf(p);
    var head = h('div', { class: 'panel-head' },
      h('div', null, h('h2', { text: 'Section' }), h('div', { class: 'panel-tid', text: p.code }), h('p', { class: 'panel-sub', text: placeLabel(p) })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: function () { selectPile(null); } }));
    var stack = h('div', { class: 'stack' }, head);
    if (!p.active) ap(stack, h('div', { class: 'notice warn' }, h('strong', { text: 'Out of the monitoring scope' }), 'This section is not counted and cannot be updated.'));
    var hist = d && d !== 'loading' && d !== 'error' ? d.history : null, last = hist && hist[0];
    var waits = OFF ? OFF.items.filter(function (it) { return it.fx && ((it.fx.list && it.fx.list.some(function (x) { return x.id === p.id; })) || it.fx.pile_id === p.id) && /^p/.test(it.fx.t); }) : [];
    if (waits.length) {
      ap(stack, h('div', { class: 'notice pend-note' }, h('strong', { text: waits.some(function (w) { return w.state === 'conflict' || w.state === 'failed'; }) ? 'Needs your decision. ' : 'Waiting to send. ' }),
        h('span', { text: waits.map(function (w) { return w.label; }).join('; ') + '. Saved on this phone without signal; sent automatically when the connection is back. ' }),
        h('button', { type: 'button', class: 'link-btn', text: 'Details', onclick: function () { OFF.openPanel(); } })));
    }
    ap(stack, h('div', { class: 'act-card' },
      h('h3', { text: 'Installation status' }),
      h('div', null, stChip(st)),
      kv([['Contractor', coChip(co)],
        ['Updated', last ? fmtTime(last.created_at) + ' by ' + (last.full_name || last.username) : cu ? '…' : 'No update saved yet'],
        last && last.remarks ? ['Remarks', last.remarks] : null]),
      canUpdatePile(p) ? h('button', { type: 'button', class: 'btn primary', id: 'pbtn-update', text: 'Update status', onclick: function () { PS.form = { sid: null, remarks: '', dirty: false }; renderPanel(); } })
        : h('p', { class: 'small muted', text: updateNote(p) })));
    ap(stack, h('div', { class: 'act-card' },
      h('h3', { text: 'Inspection and acceptance' }),
      h('div', null, iChip(ins)),
      PS.insp.get(p.id) && PS.insp.get(p.id).date ? h('p', { class: 'small', text: 'Inspected ' + fmtDate(PS.insp.get(p.id).date) }) : null,
      official() && p.active ? h('button', { type: 'button', class: 'btn', id: 'pbtn-inspect-one', text: 'Record inspection', onclick: function () { inspectionForm([p]); } }) : null,
      !official() ? h('p', { class: 'small muted', text: 'Inspection results are recorded by the administrator or the authorised inspector. A completed section is not accepted until they record it.' }) : null));
    var caseCard = h('div', { class: 'act-card' }, h('h3', { text: 'Refusal and rectification' }));
    if (cs.length) cs.forEach(function (c) { ap(caseCard, h('div', null, caseChip(c))); });
    else ap(caseCard, h('p', { class: 'small muted', text: 'No open case.' }));
    if (canCasePile(p)) ap(caseCard, h('button', { type: 'button', class: 'btn', id: 'pbtn-case', text: 'Report refusal or defect', onclick: function () { caseForm(p, null); } }));
    ap(stack, caseCard);
    if (canCasePile(p)) ap(stack, h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn small', id: 'pbtn-upload', text: 'Add photo or document', onclick: function () { uploadForm(p, null); } })));
    if (!d || d === 'loading') ap(stack, h('p', { class: 'small muted', text: 'Loading history…' }));
    else if (d === 'error') ap(stack, h('p', { class: 'form-error', text: 'Could not load the history. ' }, h('button', { type: 'button', class: 'link-btn', text: 'Try again', onclick: function () { loadDetail(p.id, true); } })));
    else detailSections(stack, p, d);
    ap(P, stack);
  }
  function updateNote(p) {
    if (!p.active) return 'Not in scope.';
    if (isSub() && catOf(p) === 'accepted') return 'Accepted / verified: only the administrator or the inspector can change it.';
    if (isSub()) return 'This section is not assigned to your company.';
    if (!settable().length) return 'Your account can view sections but not update them.';
    return '';
  }
  function detailSections(stack, p, d) {
    var pd = d.pile;
    ap(stack, box('Section details', [kv([['Section ID', pd.code], ['Block', String(pd.block)], ['Work area', pd.work_area || '—'], ['Table', pd.table_code || '—'],
      ['Drawing X / Y', (+pd.x).toFixed(3) + ' / ' + (+pd.y).toFixed(3)], pd.remarks ? ['Remarks', pd.remarks] : null,
      ['Contractor since', pd.assigned_at ? fmtTime(pd.assigned_at) + (pd.assigned_by ? ' (' + pd.assigned_by + ')' : '') : '—']]),
      isAdmin() ? h('button', { type: 'button', class: 'btn small', id: 'pbtn-editpile', text: 'Edit section details', onclick: function () { editPile(p, pd); } }) : null], true));
    ap(stack, box('Status history (' + d.history.length + ')', d.history.length ? h('ul', { class: 'hist' }, d.history.map(function (u) {
      var s = PS.stById.get(u.status_id) || { color: '#999', label: u.status_label };
      return h('li', null,
        h('div', { class: 'hist-top' }, pchip(s.color, u.status_label), h('span', { class: 'hist-meta', text: 'from ' + (u.prev_label || 'Not Started') })),
        h('div', { class: 'hist-meta', text: (u.offline && u.client_time ? fmtTime(u.client_time) + ' (saved without signal; received ' + fmtTime(u.created_at) + ')' : fmtTime(u.created_at)) + ' · ' + (u.full_name || u.username) + (u.company_name ? ' · ' + u.company_name : '') + (u.source !== 'manual' ? ' · via ' + u.source : '') }),
        u.remarks ? h('div', { class: 'hist-rem', text: u.remarks }) : null);
    })) : h('p', { class: 'small muted', text: 'No status saved yet: the section counts as Not Started.' }), true));
    ap(stack, box('Inspection records (' + d.inspections.length + ')', d.inspections.length ? h('ul', { class: 'hist' }, d.inspections.map(function (i) {
      var s = PS.istById.get(i.status_id) || { color: '#999' };
      return h('li', null,
        h('div', { class: 'hist-top' }, pchip(s.color, i.status_label), i.pile_status_set ? h('span', { class: 'hist-meta', text: 'pile set to ' + i.pile_status_set }) : null),
        h('div', { class: 'hist-meta', text: [i.inspection_date ? 'Inspected ' + fmtDate(i.inspection_date) : null, i.inspector ? 'by ' + i.inspector : null,
          i.approval_date ? 'approved ' + fmtDate(i.approval_date) + (i.approved_by ? ' by ' + i.approved_by : '') : null].filter(Boolean).join(' · ') || 'No date' }),
        i.comments ? h('div', { class: 'hist-rem', text: 'Comments: ' + i.comments }) : null,
        i.issues ? h('div', { class: 'hist-rem', text: 'Issues: ' + i.issues }) : null,
        i.corrective_action ? h('div', { class: 'hist-rem', text: 'Corrective action: ' + i.corrective_action }) : null,
        i.reinspection_date || i.reinspection_result ? h('div', { class: 'hist-rem', text: 'Reinspection: ' + [i.reinspection_date ? fmtDate(i.reinspection_date) : null, i.reinspection_result].filter(Boolean).join(' · ') }) : null,
        h('div', { class: 'hist-meta', text: 'Recorded ' + fmtTime(i.created_at) + ' by ' + i.username }));
    })) : h('p', { class: 'small muted', text: 'Not yet inspected.' }), d.inspections.length > 0));
    ap(stack, box('Refusal and rectification records (' + d.cases.length + ')', d.cases.length ? h('ul', { class: 'hist' }, d.cases.map(function (c) {
      var open = c.resolution_status === 'open' || c.resolution_status === 'in_progress';
      return h('li', null,
        h('div', { class: 'hist-top' }, h('strong', { text: CASE_KIND[c.kind] + ' #' + c.id }), h('span', { class: 'pill ' + (open ? 'off' : 'on'), text: CASE_ST[c.resolution_status] })),
        h('div', { class: 'hist-meta', text: 'Encountered ' + fmtDate(c.date_encountered) + (c.responsible_party ? ' · responsible: ' + c.responsible_party : '') + (c.resolution_date ? ' · resolved ' + fmtDate(c.resolution_date) : '') }),
        h('div', { class: 'hist-rem', text: c.details }),
        c.remarks ? h('div', { class: 'hist-rem', text: 'Remarks: ' + c.remarks }) : null,
        c.corrective_action ? h('div', { class: 'hist-rem', text: 'Corrective action: ' + c.corrective_action }) : null,
        c.reinspection_result ? h('div', { class: 'hist-rem', text: 'Reinspection result: ' + c.reinspection_result }) : null,
        h('div', { class: 'hist-meta', text: 'Opened ' + fmtTime(c.created_at) + ' by ' + c.created_by + ' · ' + plural(c.log.length - 1, 'change') }),
        h('div', { class: 'tool-row' },
          canEditCase(p, c) ? h('button', { type: 'button', class: 'link-btn', text: 'Update case', onclick: function () { caseForm(p, c); } }) : null,
          c.log.length > 1 ? h('button', { type: 'button', class: 'link-btn', text: 'Case history', onclick: function () { caseHistory(c); } }) : null));
    })) : h('p', { class: 'small muted', text: 'No refusal or rectification recorded.' }), d.cases.length > 0));
    ap(stack, box('Photos and documents (' + d.files.filter(function (f) { return !f.removed_at; }).length + ')', d.files.length ? h('ul', { class: 'hist pfiles' }, d.files.map(function (f) {
      return h('li', null,
        h('div', { class: 'hist-top' }, h('strong', { text: f.file_name }), h('span', { class: 'pill', text: FILE_KIND[f.kind] || f.kind })),
        h('div', { class: 'hist-meta', text: fmtTime(f.created_at) + ' · ' + f.username + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB' + (f.case_id ? ' · case #' + f.case_id : '') }),
        f.remarks ? h('div', { class: 'hist-rem', text: f.remarks }) : null,
        f.corrective_action ? h('div', { class: 'hist-rem', text: 'Corrective action: ' + f.corrective_action }) : null,
        f.removed_at ? h('div', { class: 'small muted', text: 'Removed ' + fmtTime(f.removed_at) + ' by ' + f.removed_by + ': ' + (f.removed_reason || '') })
          : h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'link-btn', text: f.mime === 'application/pdf' ? 'Open document' : 'View photo', onclick: function () { showFile(f); } }),
            isAdmin() ? h('button', { type: 'button', class: 'link-btn danger', text: 'Remove', onclick: function () { removeFile(p, f); } }) : null));
    })) : h('p', { class: 'small muted', text: 'No photos or documents yet.' }), d.files.length > 0));
    if (d.assignments.length) ap(stack, box('Contractor history (' + d.assignments.length + ')', h('ul', { class: 'hist' }, d.assignments.map(function (a) {
      return h('li', null, h('div', { text: (a.prev || 'No contractor') + ' → ' + (a.new || 'No contractor') }), h('div', { class: 'hist-meta', text: fmtTime(a.at) + ' · ' + a.username }));
    })), false));
    if (isAdmin() && d.changes.length) ap(stack, box('Layout record (' + d.changes.length + ')', h('ul', { class: 'hist' }, d.changes.map(function (c) {
      return h('li', null, h('div', { text: c.action === 'imported' ? 'Imported' : 'Changed: ' + changeText(c) }), h('div', { class: 'hist-meta', text: fmtTime(c.at) + ' · ' + c.username }));
    })), false));
  }
  function changeText(c) {
    var b = c.before || {}, a = c.after || {}, out = [];
    Object.keys(a).forEach(function (k) { if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k.replace(/_/g, ' ') + ' ' + (b[k] == null ? '—' : b[k]) + ' → ' + (a[k] == null ? '—' : a[k])); });
    return out.join('; ') || '—';
  }
  function box(title, content, open) {
    var d = h('details', { class: 'hist-box' }, h('summary', { text: title }), content);
    if (open) d.open = true;
    return d;
  }
  function canEditCase(p, c) {
    if (official()) return true;
    return isSub() && coOf(p) === me().company_id && (c.resolution_status === 'open' || c.resolution_status === 'in_progress');
  }

  // ---- single pile status update: form, review, save
  function statusPicker(list, current, onPick) {
    return h('div', { class: 'status-pick pstatus-pick' }, list.map(function (s) {
      return h('button', { type: 'button', 'data-sid': s.id, 'aria-pressed': String(current === s.id), onclick: function () { onPick(s.id); } }, sw(s.color), h('span', { text: s.label }));
    }));
  }
  function renderForm(P, p) {
    var F = PS.form, st = stOf(p);
    var rm = h('textarea', { id: 'pf-remarks', maxlength: 500, rows: 3, placeholder: 'Optional: depth reached, problems, crew…' });
    rm.value = F.remarks || '';
    rm.addEventListener('input', function () { F.remarks = rm.value; F.dirty = true; });
    var list = settable().filter(function (s) { return s.id !== st.id || PS.cur.has(p.id); });
    ap(P, h('div', { class: 'stack' },
      h('div', { class: 'panel-head' }, h('div', null, h('h2', { text: 'Update pile status' }), h('div', { class: 'panel-tid', text: p.code }), h('p', { class: 'panel-sub', text: placeLabel(p) }))),
      h('p', { class: 'small', text: 'Now: ' }, stChip(st)),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'New status' }), statusPicker(list, F.sid, function (sid) { F.sid = sid; F.dirty = true; renderPanel(); })),
      isSub() ? h('p', { class: 'small muted', text: 'Accepted / verified and other official results are recorded by the administrator or the inspector.' }) : null,
      h('div', { class: 'field' }, h('label', { for: 'pf-remarks', text: 'Remarks' }), rm),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn primary', id: 'pbtn-review', disabled: !F.sid || F.sid === st.id, text: F.sid ? 'Review update' : 'Choose the new status', onclick: function () { reviewStatus([p], F.sid, F.remarks); } }),
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: function () { PS.form = null; renderPanel(); } }))));
    setTimeout(function () { var b = P.querySelector('.pstatus-pick button'); if (b && !F.sid) b.focus({ preventScroll: true }); }, 0);
  }
  function reviewStatus(list, sid, remarks) {
    var st = PS.stById.get(sid); if (!st) return;
    var change = list.filter(function (p) { return stOf(p).id !== st.id || !curP(p) && st.key !== 'not_started'; });
    var same = list.length - change.length, byCo = new Map(), prev = new Map(), blocks = new Set();
    change.forEach(function (p) {
      var c = coOf(p); byCo.set(c, (byCo.get(c) || 0) + 1);
      var s = stOf(p); prev.set(s.label, (prev.get(s.label) || 0) + 1); blocks.add(p.block);
    });
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'pbtn-confirm', text: change.length ? 'Confirm and save ' + plural(change.length, 'update') : 'Nothing to save' });
    btn.disabled = !change.length;
    btn.addEventListener('click', function () { saveStatus(change, st, remarks, btn); });
    openModal('Confirm ' + plural(change.length, 'section update'), [
      h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'New status' }), h('dd', null, stChip(st)),
        h('dt', { text: 'Sections' }), h('dd', { text: String(change.length) + (same ? ' (' + same + ' already ' + st.label + ', not saved again)' : '') }),
        h('dt', { text: 'Block' }), h('dd', { text: Array.from(blocks).sort().map(function (b) { return 'Block ' + b; }).join(', ') || '—' }),
        h('dt', { text: 'Contractor' }), h('dd', null, Array.from(byCo.entries()).map(function (e) { return h('span', { class: 'cchip-wrap' }, coChip(e[0]), ' ' + e[1] + ' '); })),
        h('dt', { text: 'Previous status' }), h('dd', { text: Array.from(prev.entries()).map(function (e) { return e[0] + ' ' + e[1]; }).join(' · ') || '—' }),
        remarks ? h('dt', { text: 'Remarks' }) : null, remarks ? h('dd', { text: remarks }) : null),
      h('p', { class: 'small', text: 'Section IDs:' }),
      h('div', { class: 'sel-list bulk-ids', text: change.map(function (p) { return p.code; }).join(', ') || '—' }),
      h('p', { class: 'small muted', text: 'Only these sections change. Inspection records, contractor assignments and earlier remarks are kept.' + (st.category === 'completed' ? ' Completed sections still need the inspector\'s acceptance.' : '') }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: closeModal }))]);
  }
  function saveStatus(list, st, remarks, btn) {
    var expected = {};
    list.forEach(function (p) { var c = curP(p); expected[p.id] = c ? c.uid : null; });
    btn.disabled = true; btn.textContent = 'Saving…';
    var ids = list.map(function (p) { return p.id; });
    var what = (list.length === 1 ? list[0].code : plural(list.length, 'section')) + ' · Piles → ' + st.label;
    submitSave('submit_pile_updates', { p_pile_ids: ids, p_status_id: st.id, p_remarks: remarks || null, p_expected: expected }, {
      label: what + (list.length > 1 ? ' (' + list.slice(0, 6).map(function (p) { return p.code; }).join(', ') + (list.length > 6 ? ' …' : '') + ')' : ''),
      keys: ids.map(function (id) { return 'p:' + id; }),
      fx: { t: 'pile', sid: st.id, list: list.map(function (p) { return { id: p.id, code: p.code }; }) }
    }).then(function (r) {
      closeModal();
      if (r && r.queued) {
        toast(queuedNote(what), 'ok', 8000);
        PS.form = null; PS.multi.clear(); PS.bulkStatus = null; PS.bulkRemarks = '';
        PK.stale = true; drawKP(); renderLegend(); renderFilters(); renderPanel();
        return;
      }
      toast('Saved: ' + plural(r.changed, 'section') + ' now ' + st.label + (r.unchanged ? ' (' + r.unchanged + ' unchanged)' : '') + '.', 'ok', 7000);
      PS.form = null; PS.multi.clear(); PS.bulkStatus = null; PS.bulkRemarks = '';
      ids.forEach(function (id) { PS.detail.delete(id); });
      return refreshAfterSave(false).then(function () { if (PS.sel) loadDetail(PS.sel, true); });
    }).catch(function (e) {
      closeModal();
      if (e.hint !== 'session' && e.hint !== 'password') toast(e.message, 'err', 12000);
      if (e.hint === 'conflict' || e.hint === 'forbidden') refreshAfterSave(true);
    });
  }

  // ---- tools: several piles (status, assign, inspection, work area)
  var TOOL_TITLE = { status: 'Update several sections', assign: 'Assign contractors', inspect: 'Record inspection', area: 'Set work area' };
  function renderTool(P) {
    var t = PS.tool, sel = selection();
    var stack = h('div', { class: 'stack ptool' });
    if (t === 'status' && isSub()) { var card = todayTargetCard(true); if (card) ap(stack, card); }
    ap(stack, h('div', null, h('h2', { text: TOOL_TITLE[t] + ' · Block ' + PS.block }),
      h('p', { class: 'panel-sub', text: t === 'status' ? 'Select the sections, choose the new status, review, then confirm.' : t === 'assign' ? 'Select sections by tapping, drawing a box, a work area or the whole block.'
        : t === 'inspect' ? 'Select the inspected sections, then fill in the inspection result.' : 'Select sections and choose their work area.' })));
    ap(stack, h('div', { class: 'tool-row' },
      h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(PS.pick === 'tap'), text: 'Tap to select', onclick: function () { PS.pick = 'tap'; renderPanel(); } }),
      h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(PS.pick === 'area'), id: 'pbtn-drawarea', text: 'Draw an area', onclick: function () { PS.pick = 'area'; renderPanel(); } })),
      h('div', { class: 'tool-row' },
        h('button', { type: 'button', class: 'btn small', id: 'pbtn-selall', text: 'Select all shown', title: 'All sections in this block that match the filters and that you may select', onclick: function () {
          var n = 0; (PS.byBlock[PS.block] || []).forEach(function (p) { if (passes(p) && toolAllows(t, p) && !PS.multi.has(p.id)) { PS.multi.add(p.id); n++; } });
          if (!n) toast('No more sections to select with these filters.', 'err');
          drawKP(); renderPanel();
        } }),
        h('button', { type: 'button', class: 'btn small', id: 'pbtn-deselall', text: 'Deselect all shown', title: 'Remove the sections that match the filters from the selection', onclick: function () {
          (PS.byBlock[PS.block] || []).forEach(function (p) { if (passes(p)) PS.multi.delete(p.id); }); drawKP(); renderPanel();
        } }),
        h('button', { type: 'button', class: 'btn small ghost', id: 'pbtn-clearsel', text: 'Clear selection', onclick: function () { PS.multi.clear(); drawKP(); renderPanel(); } })));
    if (t === 'assign' || t === 'area') {
      var areas = PS.areas.filter(function (a) { return a.block === PS.block; });
      var aSel = h('select', { id: 'pt-area-pick', 'aria-label': 'Select a work area' }, [h('option', { value: '', text: 'Add a work area to the selection…' })].concat(areas.map(function (a) { return h('option', { value: a.id, text: a.name }); })));
      aSel.addEventListener('change', function () {
        var id = +aSel.value; if (!id) return;
        (PS.byBlock[PS.block] || []).forEach(function (p) { if (p.area === id) PS.multi.add(p.id); });
        drawKP(); renderPanel();
      });
      ap(stack, h('div', { class: 'tool-row' }, areas.length ? aSel : null,
        h('button', { type: 'button', class: 'btn small', id: 'pbtn-wholeblock', text: 'Whole Block ' + PS.block, onclick: function () { (PS.byBlock[PS.block] || []).forEach(function (p) { PS.multi.add(p.id); }); drawKP(); renderPanel(); } })));
    }
    ap(stack, h('p', { class: 'mode-note', text: PS.pick === 'area' ? 'Drag a box on the keyplan. Sections you may select inside it (and matching the filters) are added.' : 'Tap sections to add or remove them.' }),
      h('div', { class: 'sel-count', id: 'psel-count', text: sel.length ? plural(sel.length, 'section') + ' selected' : 'No sections selected' }));
    var otherBlock = Array.from(PS.multi).filter(function (id) { var p = PS.byId.get(id); return p && p.block !== PS.block; }).length;
    if (otherBlock) ap(stack, h('p', { class: 'small muted', text: plural(otherBlock, 'section') + ' selected in the other block ' + (otherBlock === 1 ? 'is' : 'are') + ' included.' }));
    if (sel.length) {
      ap(stack, h('div', { class: 'sel-list', text: sel.slice(0, 80).map(function (p) { return p.code; }).join(', ') + (sel.length > 80 ? ' …' : '') }));
      if (t === 'status') toolStatus(stack, sel);
      else if (t === 'assign') toolAssign(stack, sel);
      else if (t === 'inspect') toolInspect(stack, sel);
      else toolArea(stack, sel);
    }
    ap(stack, h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn', id: 'pbtn-done', text: 'Done', onclick: endTool })));
    ap(P, stack);
  }
  function currentSummary(sel) {
    var m = new Map(); sel.forEach(function (p) { var s = stOf(p); m.set(s.id, (m.get(s.id) || 0) + 1); });
    return h('div', { class: 'summary-grid' }, Array.from(m.entries()).map(function (e) {
      var s = PS.stById.get(e[0]) || PS.notStarted; return [sw(s.color), h('span', { text: s.label }), h('span', { class: 'num', text: String(e[1]) })];
    }));
  }
  function toolStatus(stack, sel) {
    ap(stack, h('p', { class: 'small', text: 'Current status:' }), currentSummary(sel),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'New status for all selected' }), statusPicker(settable(), PS.bulkStatus, function (sid) { PS.bulkStatus = sid; renderPanel(); })));
    var rm = h('textarea', { id: 'pbulk-remarks', maxlength: 500, rows: 2, placeholder: 'Optional; saved on each new record' });
    rm.value = PS.bulkRemarks || ''; rm.addEventListener('input', function () { PS.bulkRemarks = rm.value; });
    ap(stack, h('div', { class: 'field' }, h('label', { for: 'pbulk-remarks', text: 'Remarks' }), rm),
      h('button', { type: 'button', class: 'btn primary', id: 'pbtn-bulk-review', disabled: !PS.bulkStatus, text: PS.bulkStatus ? 'Review ' + plural(sel.length, 'update') : 'Choose the new status',
        onclick: function () { if (sel.length > 3000) { toast('Select at most 3000 sections at a time.', 'err'); return; } reviewStatus(sel, PS.bulkStatus, PS.bulkRemarks); } }));
  }
  function toolAssign(stack, sel) {
    var by = new Map(); sel.forEach(function (p) { var c = coOf(p); by.set(c, (by.get(c) || 0) + 1); });
    ap(stack, h('p', { class: 'small', text: 'Contractor now:' }), h('div', { class: 'summary-grid' }, Array.from(by.entries()).map(function (e) {
      return [sw(e[0] ? X.colorOf(e[0]) : '#9aa5b0'), h('span', { text: e[0] ? companyName(e[0]) : 'No contractor' }), h('span', { class: 'num', text: String(e[1]) })];
    })));
    var co = h('select', { id: 'pt-company' }, [h('option', { value: '', text: 'Choose the contractor…' })].concat(X.activeCompanies().map(function (c) { return h('option', { value: c.id, text: c.name }); })));
    ap(stack, h('div', { class: 'field' }, h('label', { for: 'pt-company', text: 'Pile installation contractor' }), co),
      h('div', { class: 'tool-row' },
        h('button', { type: 'button', class: 'btn primary', id: 'pbtn-assign-review', text: 'Review assignment', onclick: function () {
          if (!co.value) { toast('Choose the contractor.', 'err'); return; } reviewAssign(sel, +co.value, false);
        } }),
        h('button', { type: 'button', class: 'btn danger', id: 'pbtn-unassign', text: 'Remove contractor', onclick: function () { reviewAssign(sel, null, false); } })),
      h('p', { class: 'small muted', text: 'Reassigning keeps each section\'s status and history; earlier work stays recorded under the contractor who did it.' }));
  }
  function reviewAssign(sel, cid, allow) {
    var change = sel.filter(function (p) { return coOf(p) !== cid; });
    var other = change.filter(function (p) { return coOf(p) && cid; });
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'pbtn-assign-confirm', text: change.length ? (cid ? 'Confirm: assign ' : 'Confirm: remove contractor from ') + plural(change.length, 'section') : 'Nothing to change' });
    btn.disabled = !change.length;
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Saving…';
      call('assign_piles', { p_pile_ids: change.map(function (p) { return p.id; }), p_company_id: cid, p_allow_reassign: allow || !!other.length }).then(function (r) {
        closeModal(); toast((cid ? 'Assigned ' + plural(r.changed, 'section') + ' to ' + companyName(cid) : 'Removed the contractor from ' + plural(r.changed, 'section')) + '.', 'ok', 6000);
        PS.multi.clear(); return refreshAfterSave(true);
      }).catch(function (e) { closeModal(); if (e.hint !== 'session') toast(e.message, 'err', 10000); });
    });
    openModal(cid ? 'Assign ' + plural(change.length, 'section') : 'Remove the contractor', [
      h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'Contractor' }), h('dd', null, cid ? X.cchip(cid) : 'None (unassigned)'),
        h('dt', { text: 'Sections' }), h('dd', { text: String(change.length) + (sel.length - change.length ? ' (' + (sel.length - change.length) + ' already so)' : '') })),
      other.length ? h('div', { class: 'notice warn' }, h('strong', { text: plural(other.length, 'section') + ' already ' + (other.length === 1 ? 'has' : 'have') + ' another contractor' }), 'They will be reassigned. Their history stays.') : null,
      h('div', { class: 'sel-list bulk-ids', text: change.map(function (p) { return p.code; }).join(', ') || '—' }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: closeModal }))]);
  }
  function toolArea(stack, sel) {
    var a = h('select', { id: 'pt-workarea' }, [h('option', { value: '', text: 'No work area' })].concat(PS.areas.filter(function (x) { return x.block === PS.block && x.is_active; }).map(function (x) { return h('option', { value: x.id, text: x.name }); })));
    ap(stack, h('div', { class: 'field' }, h('label', { for: 'pt-workarea', text: 'Work area for the selected sections' }), a),
      h('button', { type: 'button', class: 'btn primary', id: 'pbtn-area-review', text: 'Review', onclick: function () {
        var id = a.value ? +a.value : null, list = sel.filter(function (p) { return p.block === PS.block; });
        var btn = h('button', { type: 'button', class: 'btn primary', id: 'pbtn-area-confirm', text: 'Confirm and save' });
        btn.addEventListener('click', function () {
          btn.disabled = true;
          call('admin_set_pile_area', { p_pile_ids: list.map(function (p) { return p.id; }), p_work_area_id: id }).then(function (r) {
            closeModal(); toast('Work area saved for ' + plural(r.changed, 'section') + '.', 'ok'); PS.multi.clear(); return refreshAfterSave(true);
          }).catch(function (e) { closeModal(); toast(e.message, 'err', 8000); });
        });
        openModal('Set work area', [h('p', { text: plural(list.length, 'section') + ' of Block ' + PS.block + ' → ' + (id ? areaName(id) : 'no work area') + '. The change is kept in each section\'s pile record.' }),
          h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: closeModal }))]);
      } }),
      PS.areas.filter(function (x) { return x.block === PS.block; }).length ? null : h('p', { class: 'small muted', text: 'Create work areas under Pile setup → Work areas first.' }));
  }
  function toolInspect(stack, sel) {
    ap(stack, h('p', { class: 'small', text: 'Current installation status:' }), currentSummary(sel),
      h('button', { type: 'button', class: 'btn primary', id: 'pbtn-insp-form', text: 'Fill in the inspection for ' + plural(sel.length, 'section'), onclick: function () {
        if (sel.length > 1500) { toast('Record at most 1500 sections at a time.', 'err'); return; } inspectionForm(sel);
      } }));
  }

  // ---- inspection form (one or several piles)
  function inspectionForm(list) {
    var today = PS.siteDate;
    var fSt = h('select', { id: 'pi-status' }, PS.istatuses.filter(function (s) { return s.is_active; }).map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    function di(id) { return h('input', { id: id, type: 'date', max: today }); }
    var fDate = di('pi-date'), fApp = di('pi-approval'), fRe = h('input', { id: 'pi-redate', type: 'date' });
    fDate.value = today;
    var fInsp = h('input', { id: 'pi-inspector', maxlength: 120, placeholder: 'Name and organisation' });
    var fBy = h('input', { id: 'pi-approvedby', maxlength: 120 });
    function ta(id, ph, max) { return h('textarea', { id: id, rows: 2, maxlength: max || 2000, placeholder: ph || '' }); }
    var fCom = ta('pi-comments'), fIss = ta('pi-issues'), fCor = ta('pi-corrective'), fRes = ta('pi-reresult', '', 500);
    var fSet = h('input', { id: 'pi-setstatus', type: 'checkbox' });
    var fPs = h('select', { id: 'pi-pilestatus' }, PS.statuses.filter(function (s) { return s.is_active; }).map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    var MATCH = { accepted: 'accepted', rejected: 'rectification', reinspection: 'reinspection' };
    function sync() {
      var s = PS.istById.get(+fSt.value) || {};
      var want = MATCH[s.category], match = PS.statuses.filter(function (x) { return x.is_active && x.category === want; })[0];
      if (match && !fSet.checked) fPs.value = match.id;
      approvalRow.hidden = s.category !== 'accepted';
    }
    var approvalRow = h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pi-approval', text: 'Acceptance / approval date' }), fApp),
      h('div', { class: 'field' }, h('label', { for: 'pi-approvedby', text: 'Approved by' }), fBy));
    fSt.addEventListener('change', sync);
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var next = h('button', { type: 'button', class: 'btn primary', id: 'pi-review', text: 'Review' });
    next.addEventListener('click', function () {
      var s = PS.istById.get(+fSt.value), ps = fSet.checked ? PS.stById.get(+fPs.value) : null;
      var F = { p_status_id: s.id, p_inspection_date: fDate.value || null, p_inspector: fInsp.value.trim() || null, p_comments: fCom.value.trim() || null,
        p_issues: fIss.value.trim() || null, p_corrective_action: fCor.value.trim() || null, p_approval_date: s.category === 'accepted' ? fApp.value || null : null,
        p_approved_by: s.category === 'accepted' ? fBy.value.trim() || null : null, p_reinspection_date: fRe.value || null, p_reinspection_result: fRes.value.trim() || null,
        p_set_pile_status_id: ps ? ps.id : null };
      err.hidden = true;
      if (s.category !== 'not_inspected' && s.category !== 'in_progress' && !F.p_inspection_date) { err.textContent = 'Enter the inspection date.'; err.hidden = false; return; }
      if (s.category === 'accepted' && !F.p_approval_date) { err.textContent = 'Enter the acceptance / approval date.'; err.hidden = false; return; }
      if (s.category === 'rejected' && !F.p_corrective_action) { err.textContent = 'Describe the required corrective action.'; err.hidden = false; return; }
      var withCase = list.filter(function (p) { return openCases(p).length; });
      if ((s.category === 'accepted' || (ps && ps.category === 'accepted')) && withCase.length) {
        err.textContent = plural(withCase.length, 'section') + ' (' + withCase.slice(0, 8).map(function (p) { return p.code; }).join(', ') + ') ' + (withCase.length === 1 ? 'has' : 'have') + ' an open refusal or rectification case. Resolve or close it first.';
        err.hidden = false; return;
      }
      confirmInspection(list, s, ps, F);
    });
    openModal('Inspection · ' + (list.length === 1 ? list[0].code : plural(list.length, 'section')), [
      list.length > 1 ? h('p', { class: 'small', text: 'The same result is recorded for each selected section, each with its own record.' }) : null,
      h('div', { class: 'field' }, h('label', { for: 'pi-status', text: 'Inspection status' }), fSt),
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pi-date', text: 'Inspection date' }), fDate),
        h('div', { class: 'field' }, h('label', { for: 'pi-inspector', text: 'Inspector' }), fInsp)),
      h('div', { class: 'field' }, h('label', { for: 'pi-comments', text: 'Comments' }), fCom),
      h('div', { class: 'field' }, h('label', { for: 'pi-issues', text: 'Identified issues' }), fIss),
      h('div', { class: 'field' }, h('label', { for: 'pi-corrective', text: 'Required corrective action' }), fCor),
      approvalRow,
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pi-redate', text: 'Reinspection date' }), fRe),
        h('div', { class: 'field' }, h('label', { for: 'pi-reresult', text: 'Reinspection result' }), fRes)),
      h('div', { class: 'inline-edit' },
        h('label', { class: 'check' }, fSet, h('span', { text: 'Also set the pile installation status (only when you tick this)' })),
        h('div', { class: 'field' }, h('label', { for: 'pi-pilestatus', text: 'Pile status to set' }), fPs)),
      err, h('div', { class: 'btn-row' }, next, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
    sync();
  }
  function confirmInspection(list, s, ps, F) {
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'pi-confirm', text: 'Confirm and save ' + plural(list.length, 'inspection record') });
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Saving…';
      var what = 'Inspection ' + s.label + ' · ' + (list.length === 1 ? list[0].code : plural(list.length, 'section'));
      submitSave('record_pile_inspection', Object.assign({ p_pile_ids: list.map(function (p) { return p.id; }) }, F), {
        label: what + (ps ? ' (status → ' + ps.label + ')' : ''),
        keys: list.map(function (p) { return (ps ? 'p:' : 'pi:') + p.id; }),
        fx: { t: 'pinsp', sid: s.id, date: F.p_inspection_date, set: ps ? ps.id : null, list: list.map(function (p) { return { id: p.id, code: p.code }; }) }
      }).then(function (r) {
        closeModal();
        if (r && r.queued) { toast(queuedNote(what), 'ok', 8000); PS.multi.clear(); PK.stale = true; drawKP(); renderLegend(); renderPanel(); return; }
        toast('Saved ' + plural(r.saved, 'inspection record') + (ps ? '; ' + plural(r.status_set, 'section') + ' set to ' + ps.label : '') + '.', 'ok', 7000);
        PS.multi.clear(); list.forEach(function (p) { PS.detail.delete(p.id); });
        return refreshAfterSave(false).then(function () { if (PS.sel) loadDetail(PS.sel, true); });
      }).catch(function (e) { closeModal(); toast(e.message, 'err', 12000); });
    });
    openModal('Confirm inspection', [
      h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'Inspection status' }), h('dd', null, iChip(s)),
        h('dt', { text: 'Sections' }), h('dd', { text: String(list.length) }),
        F.p_inspection_date ? h('dt', { text: 'Inspection date' }) : null, F.p_inspection_date ? h('dd', { text: fmtDate(F.p_inspection_date) }) : null,
        F.p_inspector ? h('dt', { text: 'Inspector' }) : null, F.p_inspector ? h('dd', { text: F.p_inspector }) : null,
        F.p_approval_date ? h('dt', { text: 'Approved' }) : null, F.p_approval_date ? h('dd', { text: fmtDate(F.p_approval_date) + (F.p_approved_by ? ' by ' + F.p_approved_by : '') }) : null,
        F.p_corrective_action ? h('dt', { text: 'Corrective action' }) : null, F.p_corrective_action ? h('dd', { text: F.p_corrective_action }) : null,
        h('dt', { text: 'Pile status' }), h('dd', null, ps ? stChip(ps) : h('span', { text: 'Not changed (installation status stays separate)' }))),
      h('div', { class: 'sel-list bulk-ids', text: list.map(function (p) { return p.code; }).join(', ') }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: function () { inspectionForm(list); } }))]);
  }

  // ---- refusal / rectification case
  function caseForm(p, c) {
    var off = official(), today = PS.siteDate;
    var fKind = h('select', { id: 'pc-kind' }, [h('option', { value: 'refusal', text: CASE_KIND.refusal }), h('option', { value: 'rectification', text: 'Defect / rectification required' })]);
    var fDate = h('input', { id: 'pc-date', type: 'date', max: today });
    function ta(id, max) { return h('textarea', { id: id, rows: 2, maxlength: max || 2000 }); }
    var fDet = ta('pc-details'), fRem = ta('pc-remarks'), fCor = ta('pc-corrective'), fRes = ta('pc-reresult', 500);
    var fResp = h('input', { id: 'pc-resp', maxlength: 120, placeholder: 'e.g. contractor, designer' });
    var stOpts = off ? ['open', 'in_progress', 'resolved', 'closed'] : ['open', 'in_progress'];
    var fSt = h('select', { id: 'pc-status' }, stOpts.map(function (k) { return h('option', { value: k, text: CASE_ST[k] }); }));
    var fRd = h('input', { id: 'pc-resdate', type: 'date', max: today });
    var setList = settable().filter(function (s) { return ['refusal', 'rectification', 'on_hold', 'reinspection', 'completed', 'ongoing'].indexOf(s.category) >= 0; });
    var fSet = h('input', { id: 'pc-set', type: 'checkbox' });
    var fPs = h('select', { id: 'pc-pilestatus' }, setList.map(function (s) { return h('option', { value: s.id, text: s.label }); }));
    var fFiles = h('input', { id: 'pc-files', type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', multiple: true });
    if (c) {
      fKind.value = c.kind; fDate.value = c.date_encountered; fDet.value = c.details || ''; fRem.value = c.remarks || ''; fCor.value = c.corrective_action || '';
      fResp.value = c.responsible_party || ''; fSt.value = c.resolution_status; fRd.value = c.resolution_date || ''; fRes.value = c.reinspection_result || '';
    } else { fDate.value = today; fResp.value = coOf(p) ? companyName(coOf(p)) : ''; }
    function syncSet() {
      var want = fKind.value === 'refusal' ? 'refusal' : 'rectification';
      var m = setList.filter(function (s) { return s.category === want; })[0];
      if (m && !fSet.checked) fPs.value = m.id;
    }
    fKind.addEventListener('change', syncSet);
    var resRow = h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pc-status', text: 'Resolution status' }), fSt),
      off ? h('div', { class: 'field' }, h('label', { for: 'pc-resdate', text: 'Resolution date' }), fRd) : null);
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var next = h('button', { type: 'button', class: 'btn primary', id: 'pc-review', text: 'Review' });
    next.addEventListener('click', function () {
      err.hidden = true;
      if (!fDate.value) { err.textContent = 'Enter the date encountered.'; err.hidden = false; return; }
      if (!fDet.value.trim()) { err.textContent = 'Describe the refusal or defect.'; err.hidden = false; return; }
      if ((fSt.value === 'resolved' || fSt.value === 'closed') && !fRd.value) { err.textContent = 'Enter the resolution date.'; err.hidden = false; return; }
      var F = { p_case_id: c ? c.id : null, p_pile_id: p.id, p_kind: fKind.value, p_date_encountered: fDate.value, p_details: fDet.value.trim(),
        p_remarks: fRem.value.trim() || null, p_corrective_action: fCor.value.trim() || null, p_responsible_party: fResp.value.trim() || null,
        p_resolution_status: fSt.value, p_resolution_date: fRd.value || null, p_reinspection_result: off ? (fRes.value.trim() || null) : (c ? c.reinspection_result : null),
        p_set_status_id: fSet.checked && setList.length ? +fPs.value : null };
      var files = Array.from(fFiles.files || []);
      var bad = files.filter(function (f) { return ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].indexOf(f.type) < 0; });
      if (bad.length) { err.textContent = 'Only photos (JPEG, PNG, WebP) and PDF files can be attached.'; err.hidden = false; return; }
      confirmCase(p, c, F, files);
    });
    openModal((c ? 'Update ' + CASE_KIND[c.kind].toLowerCase() + ' case #' + c.id : 'Report refusal or defect') + ' · ' + p.code, [
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pc-kind', text: 'Type' }), fKind),
        h('div', { class: 'field' }, h('label', { for: 'pc-date', text: 'Date encountered' }), fDate)),
      h('div', { class: 'field' }, h('label', { for: 'pc-details', text: 'Refusal or defect details' }), fDet),
      h('div', { class: 'field' }, h('label', { for: 'pc-remarks', text: 'Remarks' }), fRem),
      h('div', { class: 'field' }, h('label', { for: 'pc-corrective', text: 'Required corrective action' }), fCor),
      h('div', { class: 'field' }, h('label', { for: 'pc-resp', text: 'Responsible party' }), fResp),
      resRow,
      off ? h('div', { class: 'field' }, h('label', { for: 'pc-reresult', text: 'Reinspection result' }), fRes) : h('p', { class: 'small muted', text: 'The administrator or the inspector resolves the case and records the reinspection result.' }),
      setList.length ? h('div', { class: 'inline-edit' }, h('label', { class: 'check' }, fSet, h('span', { text: 'Also set the pile status' })),
        h('div', { class: 'field' }, h('label', { for: 'pc-pilestatus', text: 'Pile status' }), fPs)) : null,
      h('div', { class: 'field' }, h('label', { for: 'pc-files', text: 'Supporting photos or documents (optional)' }), fFiles, h('p', { class: 'hint', text: 'Photos are reduced to about 1600 px before upload.' })),
      err, h('div', { class: 'btn-row' }, next, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
    syncSet();
  }
  function confirmCase(p, c, F, files) {
    var ps = F.p_set_status_id ? PS.stById.get(F.p_set_status_id) : null;
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'pc-confirm', text: 'Confirm and save' });
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Saving…';
      // photos are prepared first so they can wait on this phone together with the report
      Promise.all(files.map(prepareFile)).then(function (ready) {
        var what = (c ? 'Case #' + c.id + ' update' : CASE_KIND[F.p_kind] + ' report') + ' · ' + p.code;
        var save = c ? call('save_pile_case', F) : submitSave('save_pile_case', F, {
          label: what + (ready.length ? ' (+ ' + plural(ready.length, 'file') + ')' : ''),
          keys: ['p:' + p.id, 'pc:' + p.id],
          fx: { t: 'pcase', pile_id: p.id, code: p.code, kind: F.p_kind, set: F.p_set_status_id || null }
        });
        return save.then(function (r) {
          var caseRef = r && r.queued ? 'ref:' + r.ref : r.case_id;
          return uploadPrepared(p, ready, 'case', caseRef, F.p_remarks, F.p_corrective_action).then(function (u) {
            closeModal();
            if ((r && r.queued) || u.queued) {
              toast(queuedNote(what + (ready.length ? ' and ' + plural(ready.length, 'file') : '')), 'ok', 8000);
              PS.detail.delete(p.id); PK.stale = true; drawKP(); renderLegend(); renderPanel();
              return;
            }
            toast((c ? 'Case updated' : 'Case #' + r.case_id + ' recorded') + (r.status_set && ps ? '; pile set to ' + ps.label : '') + (u.n ? '; ' + plural(u.n, 'file') + ' attached' : '') + '.', 'ok', 7000);
            PS.detail.delete(p.id); return refreshAfterSave(false).then(function () { loadDetail(p.id, true); });
          });
        });
      }).catch(function (e) {
        closeModal();
        toast(e.hint === 'network' && c ? 'Updating an existing case needs a connection. New reports can be saved without signal.' : e.message, 'err', 12000);
        refreshAfterSave(false);
      });
    });
    openModal('Confirm ' + (c ? 'case update' : 'new case'), [
      h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'Section' }), h('dd', { text: p.code + ' · ' + placeLabel(p) }),
        h('dt', { text: 'Type' }), h('dd', { text: CASE_KIND[F.p_kind] }),
        h('dt', { text: 'Encountered' }), h('dd', { text: fmtDate(F.p_date_encountered) }),
        h('dt', { text: 'Details' }), h('dd', { text: F.p_details }),
        F.p_corrective_action ? h('dt', { text: 'Corrective action' }) : null, F.p_corrective_action ? h('dd', { text: F.p_corrective_action }) : null,
        h('dt', { text: 'Resolution' }), h('dd', { text: CASE_ST[F.p_resolution_status] + (F.p_resolution_date ? ' · ' + fmtDate(F.p_resolution_date) : '') }),
        h('dt', { text: 'Pile status' }), h('dd', null, ps ? stChip(ps) : h('span', { text: 'Not changed' })),
        files.length ? h('dt', { text: 'Files' }) : null, files.length ? h('dd', { text: files.map(function (f) { return f.name; }).join(', ') }) : null),
      h('p', { class: 'small muted', text: 'Every save is kept in the case history.' }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: function () { caseForm(p, c); } }))]);
  }
  function caseHistory(c) {
    openModal('Case #' + c.id + ' history', [h('ul', { class: 'hist' }, c.log.map(function (l) {
      var a = l.after || {}, b = l.before || {}, diff = [];
      ['resolution_status', 'details', 'remarks', 'corrective_action', 'responsible_party', 'resolution_date', 'reinspection_result', 'kind', 'date_encountered'].forEach(function (k) {
        if (l.action === 'opened' ? a[k] : JSON.stringify(a[k]) !== JSON.stringify(b[k])) diff.push(k.replace(/_/g, ' ') + ': ' + (l.action === 'opened' ? '' : (b[k] == null ? '—' : b[k]) + ' → ') + (a[k] == null ? '—' : a[k]));
      });
      return h('li', null, h('div', { class: 'hist-top' }, h('strong', { text: l.action === 'opened' ? 'Opened' : 'Updated' }), h('span', { class: 'hist-meta', text: fmtTime(l.at) + ' · ' + l.username })),
        diff.map(function (t) { return h('div', { class: 'hist-rem', text: t }); }));
    })), h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', text: 'Close', onclick: closeModal }))]);
  }

  // ---- photos and documents
  function readAsDataURL(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('Could not read the file.')); }; r.readAsDataURL(blob); });
  }
  // photos: reduced to max 1600 px as JPEG (keeps the free database small); PDFs as they are
  function prepareFile(file) {
    if (file.type === 'application/pdf') {
      if (file.size > 2097152) return Promise.reject(new Error(file.name + ' is larger than 2 MB.'));
      return readAsDataURL(file).then(function (u) { return { name: file.name, mime: 'application/pdf', data: u.split(',')[1] }; });
    }
    return readAsDataURL(file).then(function (u) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          var max = 1600, w = img.naturalWidth, hh = img.naturalHeight, k = Math.min(1, max / Math.max(w, hh));
          var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(hh * k));
          var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0, c.width, c.height);
          var q = 0.8, out = c.toDataURL('image/jpeg', q);
          while (out.length * 0.75 > 1900000 && q > 0.4) { q -= 0.15; out = c.toDataURL('image/jpeg', q); }
          res({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mime: 'image/jpeg', data: out.split(',')[1] });
        };
        img.onerror = function () { rej(new Error(file.name + ' is not a photo this browser can read.')); };
        img.src = u;
      });
    });
  }
  // files already reduced (prepareFile); each one waits on this phone when there is no signal
  function uploadPrepared(p, ready, kind, caseId, remarks, corrective) {
    var n = 0, queued = 0, chain = Promise.resolve();
    ready.forEach(function (x) {
      chain = chain.then(function () {
        return submitSave('upload_pile_file', { p_pile_id: p.id, p_kind: kind, p_file_name: x.name, p_mime: x.mime, p_data: x.data, p_remarks: remarks || null,
          p_corrective_action: corrective || null, p_case_id: caseId || null, p_inspection_id: null }, {
          label: (FILE_KIND[kind] || 'File') + ' ' + x.name + ' · ' + p.code + ' (' + Math.max(1, Math.round(x.data.length * 0.75 / 1024)) + ' KB)',
          keys: ['pf:' + p.id],
          fx: { t: 'pfile', pile_id: p.id, code: p.code, name: x.name, kind: kind }
        });
      }).then(function (r) { if (r && r.queued) queued++; else n++; });
    });
    return chain.then(function () { return { n: n, queued: queued }; });
  }
  function uploadMany(p, files, kind, caseId, remarks, corrective) {
    return Promise.all(files.map(prepareFile)).then(function (ready) { return uploadPrepared(p, ready, kind, caseId, remarks, corrective); });
  }
  function uploadForm(p, caseId) {
    var d = PS.detail.get(p.id), cases = d && d.cases ? d.cases : [];
    var fKind = h('select', { id: 'pu-kind' }, Object.keys(FILE_KIND).filter(function (k) { return official() || k !== 'inspection'; }).map(function (k) { return h('option', { value: k, text: FILE_KIND[k] }); }));
    var fCase = h('select', { id: 'pu-case' }, [h('option', { value: '', text: 'Not linked to a case' })].concat(cases.map(function (c) { return h('option', { value: c.id, text: CASE_KIND[c.kind] + ' #' + c.id + ' (' + CASE_ST[c.resolution_status] + ')' }); })));
    if (caseId) { fCase.value = caseId; fKind.value = 'case'; }
    var fFile = h('input', { id: 'pu-file', type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', multiple: true });
    var fRem = h('textarea', { id: 'pu-remarks', rows: 2, maxlength: 1000, placeholder: 'Installation or inspection remarks' });
    var fCor = h('textarea', { id: 'pu-corrective', rows: 2, maxlength: 1000, placeholder: 'Relevant corrective action (optional)' });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'pu-save', text: 'Upload' });
    save.addEventListener('click', function () {
      var files = Array.from(fFile.files || []);
      err.hidden = true;
      if (!files.length) { err.textContent = 'Choose a photo or a PDF.'; err.hidden = false; return; }
      if (files.some(function (f) { return ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].indexOf(f.type) < 0; })) { err.textContent = 'Only photos (JPEG, PNG, WebP) and PDF files.'; err.hidden = false; return; }
      save.disabled = true; save.textContent = 'Uploading…';
      uploadMany(p, files, fKind.value, fCase.value ? +fCase.value : null, fRem.value.trim(), fCor.value.trim()).then(function (u) {
        closeModal(); PS.detail.delete(p.id);
        if (u.queued) { toast(queuedNote(plural(u.queued, 'file') + ' for ' + p.code) + (u.n ? ' ' + plural(u.n, 'file') + ' already sent.' : ''), 'ok', 8000); PK.stale = true; drawKP(); renderPanel(); return; }
        toast(plural(u.n, 'file') + ' attached to ' + p.code + '.', 'ok');
        return refreshAfterSave(false).then(function () { loadDetail(p.id, true); });
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; save.textContent = 'Upload'; });
    });
    openModal('Add photo or document · ' + p.code, [
      h('div', { class: 'field' }, h('label', { for: 'pu-file', text: 'Photos (JPEG, PNG, WebP) or PDF, up to 2 MB each' }), fFile),
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'pu-kind', text: 'What it shows' }), fKind),
        cases.length ? h('div', { class: 'field' }, h('label', { for: 'pu-case', text: 'Case' }), fCase) : null),
      h('div', { class: 'field' }, h('label', { for: 'pu-remarks', text: 'Remarks' }), fRem),
      h('div', { class: 'field' }, h('label', { for: 'pu-corrective', text: 'Corrective action' }), fCor),
      h('p', { class: 'small muted', text: 'Files are stored in the project database and shown only to signed-in users who may see this section. Your name and the upload time are recorded.' }),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function showFile(f) {
    call('get_pile_file', { p_file_id: f.id }).then(function (d) {
      var bin = atob(d.data), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([arr], { type: d.mime }));
      var body = d.mime === 'application/pdf'
        ? [h('p', { text: d.file_name + ' (' + Math.round(arr.length / 1024) + ' KB)' }), h('a', { class: 'btn primary', href: url, download: d.file_name, text: 'Download the PDF' })]
        : [h('img', { class: 'pphoto', src: url, alt: d.file_name }), h('a', { class: 'btn small', href: url, download: d.file_name, text: 'Download' })];
      openModal(f.file_name, body.concat([f.remarks ? h('p', { class: 'small', text: f.remarks }) : null, h('p', { class: 'small muted', text: 'Uploaded ' + fmtTime(f.created_at) + ' by ' + f.username })]));
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function removeFile(p, f) {
    var why = h('input', { id: 'prm-why', maxlength: 500, placeholder: 'e.g. wrong section, duplicate' });
    var btn = h('button', { type: 'button', class: 'btn danger', id: 'prm-confirm', text: 'Remove the file' });
    btn.addEventListener('click', function () {
      if (!why.value.trim()) { toast('Give the reason.', 'err'); return; }
      btn.disabled = true;
      call('admin_remove_pile_file', { p_file_id: f.id, p_reason: why.value.trim() }).then(function () {
        closeModal(); toast('File removed. Its record stays in the pile history.', 'ok'); PS.detail.delete(p.id); loadDetail(p.id, true); refreshAfterSave(false);
      }).catch(function (e) { toast(e.message, 'err'); btn.disabled = false; });
    });
    openModal('Remove ' + f.file_name + '?', [h('p', { text: 'The stored file is deleted to free space. Who uploaded it, when, the remarks and your reason stay in the record.' }),
      h('div', { class: 'field' }, h('label', { for: 'prm-why', text: 'Reason' }), why), h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function editPile(p, pd) {
    var fArea = h('select', { id: 'pe-area' }, [h('option', { value: '', text: 'No work area' })].concat(PS.areas.filter(function (a) { return a.block === p.block; }).map(function (a) { return h('option', { value: a.id, text: a.name, selected: a.id === pd.work_area_id }); })));
    var fTable = h('input', { id: 'pe-table', maxlength: 60, value: pd.table_code || '' });
    var fType = h('input', { id: 'pe-type', maxlength: 60, value: pd.pile_type || '' });
    var fLen = h('input', { id: 'pe-len', type: 'number', min: 0, max: 1000, step: '0.01', value: pd.design_length != null ? pd.design_length : '' });
    var fRem = h('textarea', { id: 'pe-rem', rows: 2, maxlength: 500 }); fRem.value = pd.remarks || '';
    var fAct = h('input', { id: 'pe-active', type: 'checkbox', checked: pd.is_active });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save' });
    save.addEventListener('click', function () {
      save.disabled = true;
      call('admin_update_pile', { p_pile_id: p.id, p_work_area_id: fArea.value ? +fArea.value : null, p_table_code: fTable.value, p_pile_type: fType.value,
        p_design_length: fLen.value === '' ? null : +fLen.value, p_remarks: fRem.value, p_is_active: fAct.checked }).then(function () {
        closeModal(); toast('Section details saved; the change is in its pile record.', 'ok'); return refreshAfterSave(true).then(function () { loadDetail(p.id, true); });
      }).catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Edit section ' + p.code, [h('p', { class: 'small muted', text: 'Section ID, block, table and position come from the keyplan and cannot be changed here.' }),
      h('div', { class: 'field' }, h('label', { for: 'pe-area', text: 'Work area' }), fArea),
      h('div', { class: 'field' }, h('label', { for: 'pe-rem', text: 'Remarks' }), fRem),
      h('label', { class: 'check' }, fAct, h('span', { text: 'Include this section in pile monitoring and counts' })),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  // ------------------------------------------------------------------
  // THIS IS YOUR TARGET FOR TODAY (pile targets)
  // ------------------------------------------------------------------
  function loadMyTarget() {
    if (!isSub() || !S.token) return;
    call('get_pile_target_board', {}).then(function (d) {
      PS.myTarget = d;
      if (!PS.visible) return;
      if (PS.sub === 'keyplan' && !PS.sel) renderPanel();
      else if (PS.sub === 'dashboard' && Pi.renderDashboard) Pi.renderDashboard();
    }).catch(function () { /* shown as loading */ });
  }
  function todayTargetCard(compact) {
    if (!isSub()) return null;
    var d = PS.myTarget;
    var box = h('section', { class: 'today-card ptoday' + (compact ? ' compact' : ''), 'aria-label': 'Your pile target for today' },
      h('h2', { class: 'today-title', text: 'THIS IS YOUR TARGET FOR TODAY' }),
      h('p', { class: 'today-date', text: (d ? fmtDate(d.site_date) : 'Loading…') + ' · Piles installation' }));
    if (!d) return box;
    if (!d.targets.length) { ap(box, h('p', { class: 'small', text: 'No pile target has been set for your company today. Ask the administrator if you expected one.' })); return box; }
    d.targets.forEach(function (t) {
      var acc = t.accomplished, q = t.quantity, rem = Math.max(0, q - acc), sc = t.scope || {};
      var bar = h('span', { class: 'b-completed' }); bar.style.width = Math.min(100, q ? 100 * acc / q : 0) + '%';
      ap(box, h('div', { class: 'today-row' },
        h('div', { class: 'today-head' }, h('strong', { text: 'Block ' + t.block + (t.work_area ? ' · ' + t.work_area : ' · whole block') }), X.tgtIndicator(acc, q)),
        h('div', { class: 'today-nums' },
          h('div', null, h('span', { class: 'tn-label', text: 'Daily target' }), h('span', { class: 'tn-num', text: String(q) })),
          h('div', null, h('span', { class: 'tn-label', text: 'Daily accomplished' }), h('span', { class: 'tn-num', text: String(acc) })),
          h('div', null, h('span', { class: 'tn-label', text: 'Remaining target' }), h('span', { class: 'tn-num', text: String(rem) })),
          h('div', null, h('span', { class: 'tn-label', text: 'Achieved' }), h('span', { class: 'tn-num', text: pct1(acc, q) }))),
        h('div', { class: 'bar' }, bar),
        h('p', { class: 'small ptoday-extra', text: 'Target date ' + fmtDate(t.date) + '. Accepted today: ' + (t.accepted || 0) + '.' }),
        compact ? null : h('p', { class: 'small', text: 'Current work status of your sections here (' + (sc.total || 0) + '): ' + Object.keys(CAT_LABEL).filter(function (k) { return sc[k]; }).map(function (k) { return CAT_LABEL[k] + ' ' + sc[k]; }).join(', ') + '.' }),
        t.remarks ? h('p', { class: 'small today-remarks', text: 'Instructions: ' + t.remarks }) : null));
    });
    var waitingDone = 0;
    pend().pile.forEach(function (v, id) { var st = PS.stById.get(v.sid), sv = PS.cur.get(id), sst = sv && PS.stById.get(sv.sid);
      if (st && REPORTED[st.category] && !(sst && REPORTED[sst.category])) waitingDone++; });
    if (waitingDone) ap(box, h('p', { class: 'small pend-line', text: plural(waitingDone, 'section') + ' reported complete on this phone ' + (waitingDone === 1 ? 'counts' : 'count') + ' once ' + (waitingDone === 1 ? 'it is' : 'they are') + ' sent.' }));
    if (!compact) ap(box, h('p', { class: 'small muted', text: 'Daily accomplished = sections first reported complete today (Philippine time), counted once per section. Acceptance by the inspector is counted separately.' }));
    return box;
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------
  function norm(x) { return String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function searchMatches(q) {
    var n = norm(q); if (!n) return [];
    var exact = [], starts = [], has = [];
    PS.piles.forEach(function (p) {
      var c = norm(p.code), t = norm(p.table);
      if (c === n) exact.push(p); else if (c.indexOf(n) === 0) starts.push(p); else if (c.indexOf(n) >= 0 || (t && t.indexOf(n) === 0)) has.push(p);
    });
    return exact.concat(starts, has).slice(0, 40);
  }
  function wireSearch() {
    var inp = $('#psearch'), list = $('#psearch-list'), items = [], idx = -1;
    function close() { list.hidden = true; inp.setAttribute('aria-expanded', 'false'); }
    function show() {
      items = searchMatches(inp.value); idx = items.length ? 0 : -1; list.textContent = '';
      if (!inp.value.trim()) { close(); return; }
      if (!items.length) ap(list, h('li', { class: 'empty', text: PS.piles.length ? 'No section with that ID' + (isSub() ? ' in your scope' : '') : 'No sections in your scope' }));
      items.forEach(function (p, i) {
        var li = h('li', { role: 'option', 'aria-selected': String(i === idx) }, h('span', { text: p.code }), h('span', { class: 'blk', text: 'B' + p.block + (p.table ? ' · ' + p.table : '') }));
        li.addEventListener('mousedown', function (e) { e.preventDefault(); choose(p); });
        ap(list, li);
      });
      list.hidden = false; inp.setAttribute('aria-expanded', 'true');
    }
    function choose(p) {
      close(); inp.value = p.code; inp.blur();
      if (PS.tool) {
        if (PS.block !== p.block) { PS.block = p.block; PK.stale = true; render(); }
        if (toolAllows(PS.tool, p)) { PS.multi.add(p.id); drawKP(); renderPanel(); } else toast(whyNot(PS.tool, p), 'err');
        requestAnimationFrame(function () { zoomToPile(p, true); });
        return;
      }
      openPile(p.id);
    }
    inp.addEventListener('input', show);
    inp.addEventListener('focus', function () { if (inp.value) show(); });
    inp.addEventListener('blur', function () { setTimeout(close, 120); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return; e.preventDefault();
        idx = (idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        $$('li', list).forEach(function (li, i) { li.setAttribute('aria-selected', String(i === idx)); });
      } else if (e.key === 'Enter') { e.preventDefault(); if (items[idx]) choose(items[idx]); }
      else if (e.key === 'Escape') close();
    });
  }

  function showHelp() {
    openModal('How to use the pile keyplan', [
      h('ol', { class: 'steps' },
        h('li', { text: 'Choose Block 1 or Block 5, and what the colours show: installation status, contractors or inspection.' }),
        h('li', { text: 'Use the filters for work area, contractor and status. Sections outside the filters are faded.' }),
        h('li', { text: 'Find a section: zoom in (pinch or scroll) and tap it, or type its ID in the search box. Tapping only selects it; nothing is saved.' }),
        h('li', { text: 'Press Update status, choose the new status, add remarks, review and confirm. For many sections use Update several sections: tap sections, draw a box or Select all shown, then review and confirm.' }),
        h('li', { text: 'A red ring marks a section with an open refusal or rectification case. White sections with a grey outline are out of scope.' })),
      h('p', { class: 'small', text: 'Contractors can update only the sections assigned to their company and cannot set Accepted / Verified. Only the administrator or the authorised inspector records inspection and acceptance; a Completed section stays Completed until then.' }),
      h('p', { class: 'small', text: 'Every save records your username, the server time, the previous and new status and the contractor. Section counts are separate from the Mounting Structure and PV Module table counts.' }),
      h('p', { class: 'small', text: 'Block 1 shows the drone photo under the sections, at true size, so installed piles can be checked against the photo. The date button at the top left switches between the photo and the drawing, picks the photo date and sets how strong the colours are.' })]);
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    if (!$('#view-piles')) return;
    $$('#view-piles .psub button').forEach(function (b) { b.addEventListener('click', function () { setSub(b.dataset.psub); }); });
    $$('#pseg-block button').forEach(function (b) { b.addEventListener('click', function () { setBlock(+b.dataset.block); }); });
    $$('#pseg-disp button').forEach(function (b) { b.addEventListener('click', function () { setDisp(b.dataset.pdisp); }); });
    $('#pbtn-help').addEventListener('click', showHelp);
    wireCanvas(); wireSearch();
  });
})();
