/* Solar PV Installation Monitoring — browser client
   (update 3: West/East sections, contractor assignment per activity).
   Talks only to the database functions (Supabase RPC). No other services. */
(function () {
  'use strict';

  var CFG = window.PVM_CONFIG || {};
  var DB_VERSION = 5;
  var CCI = ['not_inspected', 'in_progress', 'pending_approval', 'approved', 'rejected', 'reinspection'];
  var CCI_LABEL = { not_inspected: 'Not Yet Inspected', in_progress: 'Inspection in Progress', pending_approval: 'Inspected – Pending Approval',
    approved: 'Approved by CCI', rejected: 'Rejected / Rectification Required', reinspection: 'For Reinspection' };
  var RFI_SUGGEST = ['#e11d48', '#0ea5e9', '#8b5cf6', '#f97316', '#14b8a6', '#a16207', '#ec4899', '#4f46e5', '#65a30d', '#0f172a', '#db2777', '#0891b2'];
  var ACT = { mounting: 'Mounting Structure Installation', module: 'PV Module Installation' };
  var ACT_SHORT = { mounting: 'Mounting Structure', module: 'PV Module' };
  var ACT_TINY = { mounting: 'Mounting', module: 'PV Module' };
  var ACTS = ['mounting', 'module'];
  function otherAct(a) { return a === 'mounting' ? 'module' : 'mounting'; }
  var ST = ['not_started', 'ongoing', 'completed', 'on_hold'];
  var ST_LABEL = { not_started: 'Not Started', ongoing: 'Ongoing', completed: 'Completed', on_hold: 'On Hold' };
  var ROLE_LABEL = { admin: 'Administrator', subcontractor: 'Subcontractor', viewer: 'Viewer (read only)' };
  var SIDE_LABEL = { W: 'West', E: 'East' };
  var FLAG_LABEL = {
    no_id: 'No table ID in drawing',
    id_format: 'ID written differently',
    duplicate_label: 'Drawn twice in DWG',
    half_outline: 'Only one half drawn',
    split_unresolved: 'West/East not confirmed'
  };
  // contractor colours (the database sends the same list; kept clear of the status colours)
  var PALETTE = ['#2563eb', '#92400e', '#0f766e', '#38bdf8', '#1e293b', '#86198f', '#a78bfa', '#7c3aed', '#0891b2', '#1e3a8a', '#c026d3'];
  var BLOCKS = [1, 5];
  var POLL_MS = 20000;
  var LS_TOKEN = 'pvm.token';
  var LS_PREFS = 'pvm.prefs';
  var SVGNS = 'http://www.w3.org/2000/svg';
  var LABEL_PPU = 6.2;

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'color') el.style.setProperty('--c', v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid instanceof Node ? kid : String(kid));
  }
  function svg(tag, attrs) {
    var el = document.createElementNS(SVGNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) {
      try { if (v === null || v === undefined) window.localStorage.removeItem(k); else window.localStorage.setItem(k, v); } catch (e) { /* storage blocked */ }
    }
  };
  var dtFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  var clockFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  function fmtTime(iso) { if (!iso) return '—'; var d = new Date(iso); return isNaN(d) ? '—' : dtFmt.format(d); }
  function fmtPct(n, d) {
    if (!d) return '0%';
    var p = 100 * n / d;
    if (p > 0 && p < 0.1) return '<0.1%';
    return (p === 0 || p >= 10 || Number.isInteger(p) ? Math.round(p) : p.toFixed(1)) + '%';
  }
  function normId(x) { return String(x || '').toUpperCase().replace(/\s+/g, ''); }
  function looseId(x) { return normId(x).replace(/[^A-Z0-9]/g, '').replace(/([A-Z])0+(?=\d)/g, '$1'); }
  function natKey(code) { return String(code || '').replace(/\d+/g, function (d) { return ('0000' + d).slice(-5); }); }
  function cmpCode(a, b) { var x = natKey(a), y = natKey(b); return x < y ? -1 : x > y ? 1 : 0; }
  var SIDE_ORDER = { W: 0, E: 1 };
  function cmpSec(a, b) {
    var pa = S.tables.get(a.table_id), pb = S.tables.get(b.table_id);
    return a.block - b.block || cmpCode(pa && pa.code || 'zzz' + a.table_id, pb && pb.code || 'zzz' + b.table_id)
      || (a.side in SIDE_ORDER ? SIDE_ORDER[a.side] : 2) - (b.side in SIDE_ORDER ? SIDE_ORDER[b.side] : 2);
  }
  function initials(u) {
    var n = (u.full_name || u.username || '?').trim();
    var p = n.split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function userLabel(u) { return u.full_name ? u.full_name + ' (' + u.username + ')' : u.username; }
  function prefs() { try { return JSON.parse(store.get(LS_PREFS) || '{}') || {}; } catch (e) { return {}; } }
  function savePrefs(p) { store.set(LS_PREFS, JSON.stringify(Object.assign(prefs(), p))); }
  function genPassword() {
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var buf = new Uint32Array(12); window.crypto.getRandomValues(buf);
    var out = '';
    for (var i = 0; i < 12; i++) { out += chars[buf[i] % chars.length]; if (i === 3 || i === 7) out += '-'; }
    return out;
  }
  function copyText(text, btn) {
    function done(ok) {
      if (!btn) return;
      var old = btn.textContent; btn.textContent = ok ? 'Copied' : 'Select and copy';
      setTimeout(function () { btn.textContent = old; }, 1600);
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else { done(false); }
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  function ApiError(message, hint, status, details) {
    var e = new Error(message); e.hint = hint || null; e.status = status || 0; e.details = details || null; return e;
  }
  function rpc(fn, args) {
    var headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
    if (/^eyJ/.test(CFG.supabaseKey || '')) headers.Authorization = 'Bearer ' + CFG.supabaseKey;
    var url = String(CFG.supabaseUrl || '').replace(/\/+$/, '') + '/rest/v1/rpc/' + fn;
    return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(args || {}), cache: 'no-store', credentials: 'omit' })
      .catch(function () {
        throw ApiError('Cannot reach the server. Check the internet connection, then try again.', 'network', 0);
      })
      .then(function (res) {
        return res.text().then(function (txt) {
          var data = null;
          try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
          if (!res.ok) {
            var msg = data && (data.message || data.msg || data.error_description || data.error);
            if (res.status >= 500 || !msg) {
              msg = 'The database is not responding (error ' + res.status + '). If nobody has used the app for 7 days, the administrator must restore the Supabase project. Otherwise try again in a minute.';
            }
            if (data && data.code === 'PGRST202') {
              msg = 'The app and the database are on different versions. Ask the administrator to run the latest database update.';
            }
            throw ApiError(msg, data && data.hint, res.status, data && data.details);
          }
          return data;
        });
      });
  }
  // Calls that need a signed-in user: handles expired sessions in one place.
  function call(fn, args) {
    args = Object.assign({ p_token: S.token }, args || {});
    return rpc(fn, args).catch(function (e) {
      if (e.hint === 'session') { signedOut(e.message); }
      else if (e.hint === 'password') { showPasswordScreen(true); }
      throw e;
    });
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var S = {
    token: null, user: null, kp: {}, tables: new Map(), sections: new Map(), secByBlock: { 1: [], 5: [] },
    companies: [], compById: new Map(), assign: new Map(), cur: new Map(), history: new Map(),
    metaVersion: 0, serverTime: null, lastSync: null, syncErr: false, polling: false, pollTimer: null,
    // disp: what the colours show ('assign' = contractors, 'status' = installation status); act: which activity
    page: 'keyplan', block: 1, disp: 'status', act: 'mounting', selected: null, mode: 'details', form: null,
    scopeOnly: true, pick: null, multi: new Set(), multiFresh: false, highlight: null, firstFit: true,
    bulk: false, bulkStatus: null, bulkRemarks: '', siteDate: null, myTarget: null,
    q: { cats: [], cci: new Map(), rfis: [], rfiById: new Map(), rfiBySec: new Map(), statuses: new Map(), canCci: false }, rfiFocus: null,
    tgt: { from: null, to: null, company: 'all', act: 'all', block: 'all', data: null, loading: false },
    dash: { block: 'all', act: 'all', status: 'all', company: 'all', page: 0 },
    admin: { tab: 'accounts', users: null, log: null, reviewAll: false, afilter: { block: 'all', act: 'all', company: 'all', area: 'all', page: 0 } }
  };
  function curOf(sid, act) { return S.cur.get(sid + '|' + act) || null; }
  function statusOf(sid, act) { var u = curOf(sid, act); return u ? u.status : 'not_started'; }
  function isAdmin() { return !!S.user && S.user.role === 'admin'; }
  function isSub() { return !!S.user && S.user.role === 'subcontractor'; }
  function canAssign() { return !!S.user && (S.user.role === 'admin' || (S.user.role === 'subcontractor' && S.user.can_assign)); }
  function counted(s) { return !!s.code && s.is_active; }
  function parentOf(s) { return S.tables.get(s.table_id); }
  function siblingOf(s) {
    var p = parentOf(s); if (!p) return null;
    var other = p.sections.filter(function (id) { return id !== s.id; })[0];
    return other ? S.sections.get(other) : null;
  }
  // contractor assigned to one activity of one section
  function asgOf(sid, act) { return S.assign.get(sid + '|' + act) || null; }
  function company(id) { return S.compById.get(id) || null; }
  function companyName(id) { var c = company(id); return c ? c.name : ''; }
  function colorOf(id) { var c = company(id); return (c && c.color) || '#9aa5b0'; }
  function activeCompanies() { return S.companies.filter(function (c) { return c.is_active; }); }
  function inMyScope(s, act) {
    var a = asgOf(s.id, act);
    return !!(a && S.user && S.user.company_id && a.company_id === S.user.company_id);
  }
  function canUpdate(s, act) {
    if (!S.user || !s || !counted(s)) return false;
    if (S.user.role === 'admin') return true;
    return S.user.role === 'subcontractor' && inMyScope(s, act);
  }
  function updatableActs(s) { return ACTS.filter(function (a) { return canUpdate(s, a); }); }
  // sections assigned to the signed-in subcontractor's company: { mounting: {1: n, 5: n}, module: {...} }
  function myCounts() {
    var c = { mounting: { 1: 0, 5: 0 }, module: { 1: 0, 5: 0 } };
    if (!S.user || !S.user.company_id) return c;
    S.assign.forEach(function (a) {
      if (a.company_id !== S.user.company_id) return;
      var s = S.sections.get(a.section_id);
      if (s && counted(s) && c[a.activity]) c[a.activity][s.block]++;
    });
    return c;
  }
  function secLabel(s) { return s.code || (parentOf(s) && parentOf(s).code ? parentOf(s).code + (s.side || '?') : 'NO ID'); }

  // ------------------------------------------------------------------
  // Screens
  // ------------------------------------------------------------------
  function showOnly(id) {
    ['boot', 'screen-login', 'screen-password', 'screen-app'].forEach(function (x) { $('#' + x).hidden = x !== id; });
  }
  function showLogin(message) {
    stopPolling();
    showOnly('screen-login');
    var err = $('#login-error');
    err.hidden = !message; err.textContent = message || '';
    setTimeout(function () { ($('#login-user').value ? $('#login-pass') : $('#login-user')).focus(); }, 30);
  }
  function showPasswordScreen(forced) {
    stopPolling();
    showOnly('screen-password');
    $('#pw-intro').textContent = forced
      ? 'Your account has a temporary password. Choose a new one to continue.'
      : 'Choose a new password.';
    $('#pw-error').hidden = true;
    ['#pw-current', '#pw-new', '#pw-confirm'].forEach(function (s) { $(s).value = ''; });
    setTimeout(function () { $('#pw-current').focus(); }, 30);
  }
  function resetScreenState() {
    S.selected = null; S.mode = 'details'; S.form = null; S.admin.users = null; S.admin.log = null;
    S.multi.clear(); S.multiFresh = false; S.pick = null; S.highlight = null;
  }
  function signedOut(message) {
    S.token = null; S.user = null; store.set(LS_TOKEN, null);
    resetScreenState();
    closeModal();
    showLogin(message || 'You have been logged out.');
  }
  function showApp() {
    showOnly('screen-app');
    setPage(S.page || 'keyplan', true);
    startPolling();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', init);
  function init() {
    wire();
    if (!CFG.supabaseUrl || !CFG.supabaseKey || /YOUR_|__/.test(CFG.supabaseUrl + CFG.supabaseKey)) {
      showOnly('boot');
      $('#boot').textContent = 'This copy of the app is not connected to its database yet (config.js is missing the Supabase settings).';
      return;
    }
    var p = prefs();
    if (BLOCKS.indexOf(p.block) >= 0) S.block = p.block;
    if (p.disp === 'assign' || p.disp === 'status') S.disp = p.disp;
    else if (ACTS.indexOf(p.disp) >= 0) { S.disp = 'status'; S.act = p.disp; } // saved by update 2
    if (ACTS.indexOf(p.act) >= 0) S.act = p.act;
    var tok = store.get(LS_TOKEN);
    if (!tok) { showLogin(); return; }
    S.token = tok;
    loadBootstrap().then(function () { afterLogin(); showApp(); }).catch(function (e) {
      if (e.hint === 'password') return showPasswordScreen(true);
      if (e.hint === 'session') { store.set(LS_TOKEN, null); S.token = null; return showLogin(); }
      showLogin(e.message);
    });
  }

  function loadBootstrap() {
    return rpc('get_bootstrap', { p_token: S.token }).then(function (d) {
      if (d.version !== DB_VERSION) {
        throw ApiError(d.version < DB_VERSION
          ? 'The database needs the latest update (update ' + DB_VERSION + '). Ask the administrator to run it, then reload this page.'
          : 'A newer version of this app is available. Reload the page.', 'version', 0);
      }
      S.siteDate = d.site_date || null;
      if (Array.isArray(d.palette) && d.palette.length) PALETTE = d.palette.map(function (c) { return String(c).toLowerCase(); });
      S.kp = {};
      d.keyplans.forEach(function (k) { S.kp[k.block] = k; });
      S.tables = new Map();
      d.tables.forEach(function (t) { t.sections = []; S.tables.set(t.id, t); });
      S.sections = new Map(); S.secByBlock = { 1: [], 5: [] };
      d.sections.forEach(function (s) {
        S.sections.set(s.id, s);
        (S.secByBlock[s.block] = S.secByBlock[s.block] || []).push(s);
        var p = S.tables.get(s.table_id); if (p) p.sections.push(s.id);
      });
      S.tables.forEach(function (t) {
        t.sections.sort(function (a, b) { var x = S.sections.get(a).side || 'Z', y = S.sections.get(b).side || 'Z'; return x === 'W' ? -1 : y === 'W' ? 1 : 0; });
      });
      S.companies = d.companies || [];
      S.compById = new Map(); S.companies.forEach(function (c) { S.compById.set(c.id, c); });
      S.assign = new Map(); (d.assignments || []).forEach(function (a) { S.assign.set(a.section_id + '|' + a.activity, a); });
      S.cur = new Map();
      d.current.forEach(function (u) { S.cur.set(u.section_id + '|' + u.activity, u); });
      S.history = new Map();
      S.metaVersion = d.meta_version;
      S.serverTime = d.server_time;
      S.lastSync = new Date();
      if (S.selected && !S.sections.has(S.selected)) { S.selected = null; S.mode = 'details'; }
      S.multi.forEach(function (id) { if (!S.sections.has(id)) S.multi.delete(id); });
      applyUser(d.user);
      KP.stale = true; // rebuild the keyplan with the new data; the zoom and position are kept
    }).then(loadQuality);
  }
  function loadQuality() {
    return rpc('get_quality', { p_token: S.token }).then(function (d) {
      var Q = S.q;
      Q.canCci = !!d.can_record_cci; Q.cats = d.categories || [];
      Q.cci = new Map(); (d.cci || []).forEach(function (r) { Q.cci.set(r.section_id + '|' + (r.activity || 'both'), r); });
      Q.statuses = new Map(); (d.rfi_statuses || []).forEach(function (x) { Q.statuses.set(x.id, x); });
      Q.rfis = d.rfis || []; Q.rfiById = new Map(); Q.rfiBySec = new Map();
      Q.rfis.forEach(function (r) {
        Q.rfiById.set(r.id, r);
        r.section_ids.forEach(function (sid) { var l = Q.rfiBySec.get(sid) || []; l.push(r); Q.rfiBySec.set(sid, l); });
      });
    });
  }

  // first view after signing in: subcontractors start on the status of their own activity and block
  function afterLogin() {
    S.firstFit = true; S.bulk = false; S.myTarget = null; S.tgt.data = null;
    loadMyTarget();
    S.highlight = null;
    if (isSub()) {
      S.scopeOnly = true;
      S.disp = 'status';
      var cnt = myCounts();
      var tot = function (a) { return cnt[a][1] + cnt[a][5]; };
      if (!tot(S.act) && tot(otherAct(S.act))) S.act = otherAct(S.act);
      if (tot(S.act) && !cnt[S.act][S.block]) S.block = S.block === 1 ? 5 : 1;
    }
  }

  function applyUser(u) {
    var prev = S.user;
    S.user = u;
    $('#user-name').textContent = u.full_name || u.username;
    $('#user-avatar').textContent = initials(u);
    $('#user-pop-name').textContent = userLabel(u);
    $('#user-pop-role').textContent = ROLE_LABEL[u.role] + (u.company_name ? ' · ' + u.company_name : '');
    $('#tab-admin').hidden = u.role !== 'admin';
    $('#btn-scope').hidden = u.role !== 'subcontractor';
    if (prev && (prev.role !== u.role || prev.can_assign !== u.can_assign || prev.company_id !== u.company_id)) {
      if (S.page === 'admin' && u.role !== 'admin') setPage('keyplan');
      if (!canAssign()) { S.pick = null; S.multi.clear(); }
      if (S.mode !== 'details') { S.mode = 'details'; S.form = null; }
      if (S.page === 'keyplan') { renderToolbar(); paintStatuses(); renderPanel(); }
    }
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------
  function setPage(v, force) {
    if (v === 'admin' && !isAdmin()) v = 'keyplan';
    var changed = v !== S.page;
    S.page = v;
    $$('.tab').forEach(function (b) {
      if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('#view-keyplan').hidden = v !== 'keyplan';
    $('#view-dashboard').hidden = v !== 'dashboard';
    $('#view-admin').hidden = v !== 'admin';
    if (v === 'keyplan') {
      renderToolbar();
      if (KP.block !== S.block) buildKeyplan();
      else if (KP.stale) rebuildKeyplan();
      else { paintStatuses(); requestAnimationFrame(onResize); }
      renderPanel();
    } else if (v === 'dashboard') {
      renderDashboard(changed || force);
    } else if (v === 'admin') {
      renderAdmin(changed || force);
    }
  }

  function renderToolbar() {
    $$('#seg-block button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.block === S.block)); });
    $$('#seg-view button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.disp === S.disp)); });
    $$('#seg-act button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.act === S.act)); });
    $('#btn-scope').setAttribute('aria-pressed', String(S.scopeOnly));
    renderSync();
  }
  function setBlock(b) {
    if (b === S.block) return;
    S.block = b; savePrefs({ block: b });
    var s = S.sections.get(S.selected);
    if (s && s.block !== b) { S.selected = null; S.mode = 'details'; S.form = null; }
    S.multi.clear(); S.multiFresh = false;
    renderToolbar(); buildKeyplan(); renderPanel();
  }
  // what the colours show: contractors or installation status
  function setDisp(d) {
    if (d === S.disp || ['assign', 'status', 'cci', 'rfi'].indexOf(d) < 0) return;
    S.rfiFocus = null;
    S.disp = d; savePrefs({ disp: d });
    S.pick = null; S.multi.clear(); S.multiFresh = false; S.bulk = false;
    renderToolbar(); paintStatuses(); renderPanel();
  }
  // which activity the keyplan shows; a selection made for assigning is kept, so the
  // same sections can be given a contractor for the other activity
  function setAct(a) {
    if (a === S.act || ACTS.indexOf(a) < 0) return;
    S.act = a; savePrefs({ act: a });
    if (S.bulk) { S.multi.clear(); S.bulkStatus = null; }
    renderToolbar(); paintStatuses(); renderPanel();
  }
  function modeLabel() {
    if (S.disp === 'rfi') return 'RFIs';
    return (S.disp === 'assign' ? 'Contractors · ' : S.disp === 'cci' ? 'CCI inspection · ' : 'Status · ') + ACT[S.act];
  }

  // ------------------------------------------------------------------
  // Keyplan drawing, zoom and pan
  // ------------------------------------------------------------------
  var KP = { svg: null, block: null, groups: new Map(), view: { x: 0, y: 0, w: 100, h: 100 }, upp: null, sel: null, pointers: new Map(), gesture: null, anim: null, fitToken: null };

  function buildKeyplan() {
    var el = $('#kp'); KP.svg = el; el.textContent = '';
    KP.groups = new Map();
    var kp = S.kp[S.block];
    if (!kp) return;
    var W = +kp.width, H = +kp.height;
    var defs = svg('defs');
    var pat = svg('pattern', { id: 'hatch', patternUnits: 'userSpaceOnUse', width: 1.6, height: 1.6, patternTransform: 'rotate(45)' });
    pat.append(svg('rect', { width: 1.6, height: 1.6, fill: '#ffffff' }));
    pat.append(svg('line', { x1: 0.4, y1: 0, x2: 0.4, y2: 1.6, stroke: '#e48a8f', 'stroke-width': 0.55 }));
    defs.append(pat); el.append(defs);
    el.append(svg('rect', { class: 'sheet', x: 0, y: 0, width: W, height: H }));
    var gl = svg('g', { class: 'bglines' });
    (kp.lines || []).forEach(function (l) { gl.append(svg('line', { class: 'bgline', x1: l[0], y1: l[1], x2: l[2], y2: l[3] })); });
    el.append(gl);
    var gt = svg('g', { class: 'tables' });
    var glb = svg('g', { class: 'labels' });
    var parents = new Map();
    (S.secByBlock[S.block] || []).forEach(function (s) {
      var r = s.geom;
      var g = svg('g', { class: 't', 'data-id': s.id });
      g.append(svg('rect', { class: 'h', x: r[0], y: r[1], width: r[2], height: r[3] }));
      gt.append(g); KP.groups.set(s.id, g);
      s._bb = [r[0], r[1], r[0] + r[2], r[1] + r[3]];
      var p = parents.get(s.table_id) || [Infinity, Infinity, -Infinity, -Infinity];
      parents.set(s.table_id, [Math.min(p[0], s._bb[0]), Math.min(p[1], s._bb[1]), Math.max(p[2], s._bb[2]), Math.max(p[3], s._bb[3])]);
      var side = svg('text', { class: 'lbl side', transform: 'translate(' + (r[0] + r[2] / 2) + ' ' + (r[1] + 2.0) + ') scale(0.1)', 'font-size': 15 });
      side.textContent = s.side || '?';
      glb.append(side);
    });
    parents.forEach(function (bb, tid) {
      var t = S.tables.get(tid);
      if (t) t._bb = bb;
      var lb = svg('text', { class: 'lbl' + (t && t.code ? '' : ' noid'), transform: 'translate(' + ((bb[0] + bb[2]) / 2) + ' ' + ((bb[1] + bb[3]) / 2) + ') scale(0.1)', 'font-size': t && t.code ? 13 : 16 });
      lb.textContent = t && t.code ? t.code : 'NO ID';
      glb.append(lb);
    });
    el.append(gt, glb);
    KP.sel = svg('g', { class: 'sel-layer' });
    el.append(KP.sel);
    KP.block = S.block; KP.stale = false;
    paintStatuses();
    var tok = KP.fitToken = {};
    requestAnimationFrame(function () {
      if (KP.fitToken !== tok) return;
      if (S.firstFit && isSub() && fitScope(false)) { S.firstFit = false; return; }
      S.firstFit = false;
      fitView(false);
    });
  }

  // Rebuild with fresh data. On the same block the zoom and position stay where the user left them
  // (after assigning, or when someone else's change reloads the data); a new sign-in fits as usual.
  function rebuildKeyplan() {
    var keep = !S.firstFit && KP.svg && KP.view && KP.block === S.block ? Object.assign({}, KP.view) : null;
    buildKeyplan();
    if (keep) { KP.fitToken = null; requestAnimationFrame(function () { setVB(keep); onResize(); }); }
  }

  // S.highlight = { cid }: show one contractor's sections for the activity on screen
  function dimmed(s) {
    if (S.disp === 'rfi' && S.rfiFocus) return !rfisOf(s.id).some(function (r) { return r.id === S.rfiFocus; });
    if (S.highlight) { var a = asgOf(s.id, S.act); return !(a && a.company_id === S.highlight.cid); }
    if (isSub() && S.scopeOnly) return !inMyScope(s, S.act);
    return false;
  }
  function secClass(s) {
    var c = 't';
    if (S.disp === 'assign') {
      c += asgOf(s.id, S.act) ? ' asg' : ' unasg';
      if (!s.code) c += ' noid-o';
    } else if (S.disp === 'cci') {
      if (!s.code) c += ' noid'; else { var q = cciOf(s.id, S.act); c += ' q-' + (q ? q.status : 'not_inspected'); }
    } else if (S.disp === 'rfi') {
      var rl = rfisOf(s.id); c += rl.length ? ' rfi' + (rl.length > 1 ? ' rfi-multi' : '') : ' norfi';
    } else if (!s.code) c += ' noid';
    else if (!s.is_active) c += ' off';
    else c += ' s-' + statusOf(s.id, S.act);
    if (s.id === S.selected) c += ' sel';
    if (S.multi.has(s.id)) c += ' msel';
    if (dimmed(s)) c += ' dim';
    return c;
  }
  function paintStatuses() {
    if (!KP.svg) return;
    KP.svg.classList.toggle('v-assign', S.disp === 'assign');
    KP.svg.classList.toggle('v-cci', S.disp === 'cci');
    KP.svg.classList.toggle('v-rfi', S.disp === 'rfi');
    KP.svg.classList.toggle('picking', S.pick === 'tap');
    KP.svg.classList.toggle('area-mode', S.pick === 'area');
    KP.svg.setAttribute('aria-label', 'Keyplan Block ' + S.block + ' · ' + modeLabel());
    (S.secByBlock[S.block] || []).forEach(function (s) {
      var g = KP.groups.get(s.id); if (!g) return;
      g.setAttribute('class', secClass(s));
      var a = asgOf(s.id, S.act);
      if (S.disp === 'rfi') { var rl = rfisOf(s.id); if (rl.length) g.style.setProperty('--c', rl[0].color); else g.style.removeProperty('--c'); }
      else if (a) g.style.setProperty('--c', colorOf(a.company_id)); else g.style.removeProperty('--c');
    });
    renderLegend();
    drawSelMarker();
  }

  function canvasRect() { return KP.svg ? KP.svg.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 }; }
  function setVB(v) {
    KP.view = v;
    var r = canvasRect();
    if (r.width) KP.upp = v.w / r.width;
    KP.svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
    var ppu = r.width ? r.width / v.w : 1;
    KP.svg.classList.toggle('show-labels', ppu >= LABEL_PPU);
    drawSelMarker(ppu);
  }
  function zoomLimits() {
    var kp = S.kp[S.block]; var r = canvasRect(); var aspect = r.width / Math.max(1, r.height);
    return { min: 10, max: Math.max(+kp.width, +kp.height * aspect) * 2.5 };
  }
  function clampCenter(v) {
    var kp = S.kp[S.block]; if (!kp) return v;
    var cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    var ncx = Math.min(Math.max(cx, 0), +kp.width), ncy = Math.min(Math.max(cy, 0), +kp.height);
    return { x: v.x + (ncx - cx), y: v.y + (ncy - cy), w: v.w, h: v.h };
  }
  function fitBox(bb, animate, minW) {
    var r = canvasRect(); if (!r.width || !r.height) return;
    var W = bb[2] - bb[0], H = bb[3] - bb[1];
    if (minW && W < minW) { var cx = (bb[0] + bb[2]) / 2; bb = [cx - minW / 2, bb[1], cx + minW / 2, bb[3]]; W = minW; }
    var padL = 14, padR = 14, padT = 14, padB = 14;
    if (window.innerWidth > 900) {
      var tb = $('#titleblock').getBoundingClientRect();
      padL = Math.max(padL, tb.width + 24); padR = 70;
    } else { padR = 58; padB = Math.max(padB, panelCover() + 8); }
    var availW = Math.max(60, r.width - padL - padR), availH = Math.max(60, r.height - padT - padB);
    var ppu = Math.min(availW / Math.max(W, 1), availH / Math.max(H, 1));
    var v = { x: bb[0] - (padL + (availW - W * ppu) / 2) / ppu, y: bb[1] - (padT + (availH - H * ppu) / 2) / ppu, w: r.width / ppu, h: r.height / ppu };
    KP.fitToken = null;
    if (animate) animateTo(v); else setVB(v);
  }
  function fitView(animate) {
    var kp = S.kp[S.block]; if (!kp) return;
    fitBox([0, 0, +kp.width, +kp.height], animate);
  }
  function fitScope(animate) {
    var bb = [Infinity, Infinity, -Infinity, -Infinity], n = 0;
    (S.secByBlock[S.block] || []).forEach(function (s) {
      if (!inMyScope(s, S.act) || !s._bb) return;
      n++; bb = [Math.min(bb[0], s._bb[0]), Math.min(bb[1], s._bb[1]), Math.max(bb[2], s._bb[2]), Math.max(bb[3], s._bb[3])];
    });
    if (!n) return false;
    fitBox([bb[0] - 6, bb[1] - 6, bb[2] + 6, bb[3] + 6], animate, 60);
    return true;
  }
  function onResize() {
    if (!KP.svg || $('#view-keyplan').hidden) return;
    var r = canvasRect(); if (!r.width || !r.height) return;
    var v = KP.view, upp = KP.upp || v.w / r.width;
    var cx = v.x + v.w / 2, cy = v.y + v.h / 2, w = r.width * upp, hh = r.height * upp;
    setVB({ x: cx - w / 2, y: cy - hh / 2, w: w, h: hh });
  }
  function zoomAt(ux, uy, f) {
    var v = KP.view, r = canvasRect(), lim = zoomLimits();
    var w = Math.min(Math.max(v.w / f, lim.min), lim.max), k = w / v.w;
    setVB(clampCenter({ x: ux - (ux - v.x) * k, y: uy - (uy - v.y) * k, w: w, h: w * r.height / r.width }));
  }
  function zoomCenter(f) { var v = KP.view; zoomAt(v.x + v.w / 2, v.y + v.h / 2, f); }
  function toUser(cx, cy) {
    var r = canvasRect(), v = KP.view;
    return { x: v.x + (cx - r.left) / r.width * v.w, y: v.y + (cy - r.top) / r.height * v.h };
  }
  function reducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function animateTo(target) {
    KP.fitToken = null;
    if (KP.anim) cancelAnimationFrame(KP.anim);
    if (reducedMotion()) { setVB(target); return; }
    var from = Object.assign({}, KP.view), t0 = performance.now(), dur = 380;
    function step(now) {
      var p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      setVB({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, w: from.w + (target.w - from.w) * e, h: from.h + (target.h - from.h) * e });
      if (p < 1) KP.anim = requestAnimationFrame(step); else KP.anim = null;
    }
    KP.anim = requestAnimationFrame(step);
  }
  function panelCover() {
    if (window.innerWidth > 900) return 0;
    var p = $('#panel'); if (!p || p.hidden) return 0;
    return p.getBoundingClientRect().height;
  }
  function zoomToSection(s, animate) {
    if (!s || !s._bb) return;
    var r = canvasRect(); if (!r.width) return;
    var aspect = r.width / r.height;
    var w = 60, hh = w / aspect;
    var cx = (s._bb[0] + s._bb[2]) / 2, cy = (s._bb[1] + s._bb[3]) / 2;
    var cover = panelCover(), upp = w / r.width;
    var visibleH = Math.max(120, r.height - cover);
    var v = { x: cx - w / 2, y: cy - (visibleH * 0.56) * upp, w: w, h: hh };
    KP.fitToken = null;
    if (animate) animateTo(v); else setVB(v);
  }
  function ensureVisible(s) {
    var r = canvasRect(), v = KP.view, bb = s && s._bb; if (!bb || !r.width) return;
    var cover = panelCover() * (v.h / r.height);
    var inside = bb[0] >= v.x && bb[2] <= v.x + v.w && bb[1] >= v.y && bb[3] <= v.y + v.h - cover;
    if (!inside) zoomToSection(s, true);
  }
  function drawSelMarker(ppu) {
    var L = KP.sel; if (!L) return;
    $$('.selring, .seltag', L).forEach(function (n) { n.remove(); });
    var s = S.sections.get(S.selected);
    if (!s || s.block !== S.block || !s._bb) return;
    var r = canvasRect();
    ppu = ppu || (r.width ? r.width / KP.view.w : 1);
    var bb = s._bb, pad = 4 / ppu;
    L.append(svg('rect', { class: 'selring', x: bb[0] - pad, y: bb[1] - pad, width: bb[2] - bb[0] + 2 * pad, height: bb[3] - bb[1] + 2 * pad }));
    var text = secLabel(s), k = 1 / ppu, tw = text.length * 13 * 0.62 + 16, th = 24;
    var cx = (bb[0] + bb[2]) / 2, ty = bb[1] - pad - (th / 2 + 4) * k;
    var g = svg('g', { class: 'seltag', transform: 'translate(' + cx + ' ' + ty + ') scale(' + k + ')' });
    g.append(svg('rect', { x: -tw / 2, y: -th / 2, width: tw, height: th, rx: 4 }));
    var tx = svg('text', { x: 0, y: 0, 'font-size': 13 }); tx.textContent = text;
    g.append(tx); L.append(g);
  }

  function sectionsInRect(a, b) {
    var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    return (S.secByBlock[S.block] || []).filter(function (s) {
      var cx = (s._bb[0] + s._bb[2]) / 2, cy = (s._bb[1] + s._bb[3]) / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
  }

  function wireCanvas() {
    var el = $('#kp');
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
    function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (KP.anim) { cancelAnimationFrame(KP.anim); KP.anim = null; }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      KP.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (KP.pointers.size === 1) {
        var tg = e.target && e.target.closest ? e.target.closest('.t') : null;
        if (S.pick === 'area') {
          KP.gesture = { type: 'area', start: toUser(e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, moved: 0, target: tg };
        } else {
          KP.gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, view: Object.assign({}, KP.view), moved: 0, target: tg };
        }
      } else if (KP.pointers.size === 2) {
        var pts = Array.from(KP.pointers.values());
        removeAreaRect();
        KP.gesture = { type: 'pinch', d0: Math.max(10, dist(pts[0], pts[1])), m0: mid(pts[0], pts[1]), view: Object.assign({}, KP.view), moved: 99 };
      }
      hideHint();
    });
    el.addEventListener('pointermove', function (e) {
      if (!KP.pointers.has(e.pointerId)) return;
      KP.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var g = KP.gesture; if (!g) return;
      var r = canvasRect();
      if (g.type === 'area' && KP.pointers.size === 1) {
        g.moved = Math.max(g.moved, Math.hypot(e.clientX - g.sx, e.clientY - g.sy));
        if (g.moved < 5) return;
        var p = toUser(e.clientX, e.clientY);
        drawAreaRect(g.start, p);
      } else if (g.type === 'pan' && KP.pointers.size === 1) {
        var dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        g.moved = Math.max(g.moved, Math.hypot(dx, dy));
        if (g.moved < 5) return;
        el.classList.add('dragging');
        var upp = g.view.w / r.width;
        setVB(clampCenter({ x: g.view.x - dx * upp, y: g.view.y - dy * upp, w: g.view.w, h: g.view.h }));
      } else if (g.type === 'pinch' && KP.pointers.size >= 2) {
        var pts = Array.from(KP.pointers.values());
        var f = dist(pts[0], pts[1]) / g.d0, m = mid(pts[0], pts[1]);
        var upp0 = g.view.w / r.width;
        var ux = g.view.x + (g.m0.x - r.left) * upp0, uy = g.view.y + (g.m0.y - r.top) * upp0;
        var lim = zoomLimits();
        var w = Math.min(Math.max(g.view.w / f, lim.min), lim.max), k = w / g.view.w, upp1 = w / r.width;
        setVB(clampCenter({
          x: ux - (ux - g.view.x) * k - (m.x - g.m0.x) * upp1,
          y: uy - (uy - g.view.y) * k - (m.y - g.m0.y) * upp1,
          w: w, h: w * r.height / r.width
        }));
      }
    });
    function end(e) {
      if (!KP.pointers.has(e.pointerId)) return;
      KP.pointers.delete(e.pointerId);
      var g = KP.gesture;
      if (g && KP.pointers.size === 0 && e.type === 'pointerup') {
        if (g.type === 'area') {
          removeAreaRect();
          if (g.moved >= 5) {
            var hit = sectionsInRect(g.start, toUser(e.clientX, e.clientY));
            if (S.bulk) {
              var all = hit.length; hit = hit.filter(canBulk);
              if (all && hit.length < all) toast(plural(all - hit.length, 'section') + ' in the box ' + (all - hit.length === 1 ? 'is' : 'are') + ' not yours for ' + ACT_SHORT[S.act] + ' and ' + (all - hit.length === 1 ? 'was' : 'were') + ' left out.', 'err', 5000);
            }
            if (hit.length) startNewSelection();
            hit.forEach(function (s) { S.multi.add(s.id); });
            paintStatuses(); renderPanel();
            if (!hit.length) toast('No sections inside that area. Draw a box around the tables.', 'err');
          } else if (g.target) toggleMulti(+g.target.getAttribute('data-id'));
        } else if (g.type === 'pan' && g.moved < 6) {
          var id = g.target ? +g.target.getAttribute('data-id') : null;
          if (S.pick === 'tap') { if (id) toggleMulti(id); }
          else if (id) selectSection(id, { source: 'map' });
          else if (S.selected && S.mode === 'details') selectSection(null);
        }
      }
      if (KP.pointers.size === 0) { KP.gesture = null; el.classList.remove('dragging'); }
      else if (KP.pointers.size === 1) {
        var p = Array.from(KP.pointers.values())[0];
        KP.gesture = { type: 'pan', sx: p.x, sy: p.y, view: Object.assign({}, KP.view), moved: 99, target: null };
      }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', function (e) { removeAreaRect(); end(e); });
    el.addEventListener('wheel', function (e) {
      e.preventDefault();
      var u = toUser(e.clientX, e.clientY);
      var dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      zoomAt(u.x, u.y, Math.exp(-dy * 0.0016));
      hideHint();
    }, { passive: false });
    el.addEventListener('keydown', function (e) {
      var v = KP.view, step = 0.12;
      if (e.key === '+' || e.key === '=') zoomCenter(1.5);
      else if (e.key === '-' || e.key === '_') zoomCenter(1 / 1.5);
      else if (e.key === '0') fitView(true);
      else if (e.key === 'Escape' && S.multi.size) { S.multi.clear(); S.multiFresh = false; paintStatuses(); renderPanel(); }
      else if (e.key === 'ArrowLeft') setVB(clampCenter({ x: v.x - v.w * step, y: v.y, w: v.w, h: v.h }));
      else if (e.key === 'ArrowRight') setVB(clampCenter({ x: v.x + v.w * step, y: v.y, w: v.w, h: v.h }));
      else if (e.key === 'ArrowUp') setVB(clampCenter({ x: v.x, y: v.y - v.h * step, w: v.w, h: v.h }));
      else if (e.key === 'ArrowDown') setVB(clampCenter({ x: v.x, y: v.y + v.h * step, w: v.w, h: v.h }));
      else return;
      e.preventDefault();
    });
    $('#zoom-in').addEventListener('click', function () { zoomCenter(1.6); });
    $('#zoom-out').addEventListener('click', function () { zoomCenter(1 / 1.6); });
    $('#zoom-fit').addEventListener('click', function () { if (!(isSub() && S.scopeOnly && fitScope(true))) fitView(true); });
    window.addEventListener('resize', function () { requestAnimationFrame(onResize); });
  }
  function drawAreaRect(a, b) {
    var L = KP.sel; if (!L) return;
    var rect = $('.area-rect', L);
    if (!rect) { rect = svg('rect', { class: 'area-rect' }); L.append(rect); }
    rect.setAttribute('x', Math.min(a.x, b.x)); rect.setAttribute('y', Math.min(a.y, b.y));
    rect.setAttribute('width', Math.abs(a.x - b.x)); rect.setAttribute('height', Math.abs(a.y - b.y));
  }
  function removeAreaRect() { var r = KP.sel && $('.area-rect', KP.sel); if (r) r.remove(); }
  function hideHint() { var hEl = $('#canvas-hint'); if (hEl) hEl.classList.add('gone'); }

  // Legend: drawing title block (desktop) and one-line strip (phones)
  function legendRows() {
    var list = S.secByBlock[S.block] || [];
    var rows = [], noid = 0;
    if (S.disp === 'assign') {
      // contractors of the activity on screen only
      var byCo = new Map(), un = 0;
      list.forEach(function (s) {
        var a = asgOf(s.id, S.act);
        if (a) byCo.set(a.company_id, (byCo.get(a.company_id) || 0) + 1); else un++;
      });
      Array.from(byCo.keys()).sort(function (a, b) { return companyName(a).localeCompare(companyName(b)); }).forEach(function (cid) {
        rows.push({ sw: function () { return h('span', { class: 'sw c', color: colorOf(cid) }); }, label: companyName(cid), n: byCo.get(cid), cid: cid });
      });
      rows.push({ sw: function () { return h('span', { class: 'sw unasg' }); }, label: 'Unassigned', n: un });
      return { rows: rows, total: list.length, kind: 'Contractors', note: 'who is responsible, not progress', foot: ['Assigned', fmtPct(list.length - un, list.length)] };
    }
    if (S.disp === 'cci') {
      var qc = {}, qt = 0; CCI.forEach(function (k) { qc[k] = 0; });
      list.forEach(function (s) { if (!s.code) { noid++; return; } if (!s.is_active) return; qt++; var q = cciOf(s.id, S.act); qc[q ? q.status : 'not_inspected']++; });
      CCI.forEach(function (k) { rows.push({ sw: function () { return h('span', { class: 'sw q-' + k }); }, label: CCI_LABEL[k], n: qc[k] }); });
      if (noid) rows.push({ sw: function () { return h('span', { class: 'sw noid' }); }, label: 'No section ID', n: noid });
      return { rows: rows, total: qt, kind: 'CCI inspection', note: isSub() ? 'your assigned sections' : '', foot: ['Approved by CCI', fmtPct(qc.approved, qt)] };
    }
    if (S.disp === 'rfi') {
      var byR = new Map(), none = 0, multi = 0;
      list.forEach(function (s) { var rl = rfisOf(s.id); if (!rl.length) none++; if (rl.length > 1) multi++; rl.forEach(function (r) { byR.set(r.id, (byR.get(r.id) || 0) + 1); }); });
      S.q.rfis.filter(function (r) { return byR.has(r.id); }).forEach(function (r) {
        var st = S.q.statuses.get(r.status_id);
        rows.push({ sw: function () { return h('span', { class: 'sw c', color: r.color }); }, label: r.rfi_no + ' · ' + (st ? st.name : ''), n: byR.get(r.id) });
      });
      if (multi) rows.push({ sw: function () { return h('span', { class: 'sw rfi-multi-sw' }); }, label: 'Sections with 2+ RFIs (tap to see all)', n: multi });
      rows.push({ sw: function () { return h('span', { class: 'sw unasg' }); }, label: 'No RFI', n: none });
      return { rows: rows, total: list.length, kind: 'RFIs', note: 'colour = RFI number; status in text', foot: ['With an RFI', fmtPct(list.length - none, list.length)] };
    }
    var c = { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 }, total = 0;
    list.forEach(function (s) { if (!s.code) { noid++; return; } if (!s.is_active) return; total++; c[statusOf(s.id, S.act)]++; });
    ST.forEach(function (st) { rows.push({ sw: function () { return h('span', { class: 'sw s-' + st }); }, label: ST_LABEL[st], n: c[st] }); });
    if (noid) rows.push({ sw: function () { return h('span', { class: 'sw noid' }); }, label: 'No section ID', n: noid });
    return { rows: rows, total: total, kind: 'Installation status', note: '', foot: ['Completed', fmtPct(c.completed, total)] };
  }
  function renderLegend() {
    var tb = $('#titleblock'); if (!tb) return;
    var L = legendRows();
    tb.textContent = '';
    tb.setAttribute('data-disp', S.disp); tb.setAttribute('data-act', S.act);
    var rows = h('div', { class: 'tb-rows' });
    L.rows.forEach(function (r) { rows.append(h('div', null, r.sw()), h('div', { text: r.label }), h('div', { class: 'num', text: String(r.n) })); });
    tb.append(h('div', { class: 'tb-head' },
      h('div', { class: 'tb-blk', text: 'Block ' + S.block }),
      h('div', { class: 'tnum', text: L.total + ' sections' }),
      h('div', { class: 'tb-act' }, h('strong', { text: L.kind }), S.disp === 'rfi' ? '' : ' · ' + ACT[S.act], L.note ? h('span', { class: 'tb-note', text: L.note }) : null)),
      rows,
      h('div', { class: 'tb-foot' }, h('span', { text: L.foot[0] }), h('strong', { class: 'tnum', text: L.foot[1] })));
    var strip = $('#legend-strip');
    if (strip) {
      strip.textContent = '';
      strip.append(h('span', { class: 'ls-title', text: 'B' + S.block + ' · ' + (S.disp === 'rfi' ? '' : ACT_TINY[S.act]) + (S.disp === 'assign' ? ' contractors' : S.disp === 'cci' ? ' CCI' : S.disp === 'rfi' ? ' RFIs' : ' status') }));
      L.rows.forEach(function (r) { strip.append(h('span', { class: 'ls-item' }, r.sw(), r.label + ' ', h('b', { text: String(r.n) }))); });
    }
  }

  // ------------------------------------------------------------------
  // Selection and side panel
  // ------------------------------------------------------------------
  function selectSection(id, opts) {
    opts = opts || {};
    if (S.mode !== 'details' && S.selected && id !== S.selected && S.form && S.form.dirty) {
      toast('Finish or cancel the update for ' + secLabel(S.sections.get(S.selected)) + ' first.', 'err');
      return;
    }
    var prev = S.selected;
    S.selected = id;
    S.mode = 'details'; S.form = null;
    [prev, id].forEach(function (x) {
      var s = S.sections.get(x), g = KP.groups.get(x);
      if (s && g) g.setAttribute('class', secClass(s));
    });
    drawSelMarker();
    renderPanel();
    var s = S.sections.get(id);
    if (s) {
      loadHistory(s.id);
      if (opts.zoom) zoomToSection(s, true);
      else if (opts.source === 'map' && window.innerWidth <= 900) requestAnimationFrame(function () { ensureVisible(s); });
    }
  }
  function toggleMulti(id) {
    if (!id) return;
    if (S.bulk && !S.multi.has(id) && !canBulk(S.sections.get(id))) {
      var bs = S.sections.get(id);
      toast((bs ? secLabel(bs) + ': ' : '') + (bs && !bs.code ? 'this section has no ID yet.' : 'you cannot update ' + ACT_SHORT[S.act] + ' here (not assigned to your company).'), 'err', 5000);
      return;
    }
    if (S.multiFresh) { startNewSelection(); paintStatuses(); }
    if (S.multi.has(id)) S.multi.delete(id); else S.multi.add(id);
    var s = S.sections.get(id), g = KP.groups.get(id);
    if (s && g) g.setAttribute('class', secClass(s));
    renderPanel();
  }
  // After an assignment the sections stay selected (to assign the other activity too);
  // the next tap or drawn area starts a new selection.
  function startNewSelection() {
    if (S.multiFresh) { S.multi.clear(); S.multiFresh = false; }
  }

  function renderPanel() {
    var P = $('#panel'); if (!P) return;
    var keepScroll = P.scrollTop;
    P.textContent = '';
    var s = S.sections.get(S.selected);
    var tools = S.disp === 'assign' && canAssign() && (S.pick || S.multi.size);
    // phones: the panel is a bottom sheet; only short content may grow without a height limit
    P.classList.toggle('collapsed', !s && !S.highlight && !S.bulk && !(S.disp === 'assign' && canAssign()) && !(S.disp === 'cci' && S.q.canCci) && !(S.disp === 'rfi' && isAdmin()));
    if (S.highlight) {
      var hn = (S.secByBlock[S.block] || []).filter(function (x) { var a = asgOf(x.id, S.act); return a && a.company_id === S.highlight.cid; }).length;
      P.append(h('div', { class: 'notice info sibling' }, cchip(S.highlight.cid),
        h('span', { text: ACT_SHORT[S.act] + ': ' + plural(hn, 'section') + ' in Block ' + S.block + '.' }),
        h('button', { type: 'button', class: 'btn small', text: 'Show all', onclick: function () { S.highlight = null; paintStatuses(); renderPanel(); } })));
    }
    if (s && S.mode !== 'details' && S.form && !canUpdate(s, S.form.act)) {
      // the assignment (or the section) changed while the form was open
      var lostAct = S.form.act;
      S.mode = 'details'; S.form = null;
      toast(isSub() ? ACT_SHORT[lostAct] + ' of ' + secLabel(s) + ' is no longer assigned to your company. Nothing was saved.'
        : secLabel(s) + ' was changed and can no longer be updated. Nothing was saved.', 'err', 8000);
    }
    // a section opened on purpose (tap without a tool, search, link) is shown even while
    // sections are selected for assigning; closing it brings the assignment tools back
    if (s) {
      if (S.mode === 'form') renderForm(P, s);
      else if (S.mode === 'confirm') renderConfirm(P, s);
      else renderDetails(P, s);
    } else if (S.disp === 'assign' && canAssign()) renderAssignTools(P);
    else if (S.bulk) renderBulkTools(P);
    else if (S.disp === 'cci' && S.q.canCci) renderCciTools(P);
    else if (S.disp === 'rfi' && isAdmin()) renderRfiTools(P);
    else if (S.disp === 'cci' || S.disp === 'rfi') renderQualitySummary(P);
    else renderPanelSummary(P);
    if (S.mode === 'details') P.scrollTop = keepScroll;
  }

  function statusCounts(list, act) {
    var c = { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 };
    list.forEach(function (s) { c[statusOf(s.id, act)]++; });
    return c;
  }
  function statusBar(c, total) {
    var bar = h('div', { class: 'bar', role: 'img', 'aria-label': ST.map(function (s) { return ST_LABEL[s] + ' ' + c[s]; }).join(', ') });
    ['completed', 'ongoing', 'on_hold'].forEach(function (st) {
      if (!c[st] || !total) return;
      var sp = h('span', { class: 'b-' + st });
      sp.style.width = (100 * c[st] / total) + '%';
      bar.append(sp);
    });
    return bar;
  }
  function chip(st) { return h('span', { class: 'chip s-' + st, text: ST_LABEL[st] }); }
  function cchip(cid, suffix) {
    if (!cid) return h('span', { class: 'cchip none' }, h('i', { class: 'cdot none' }), h('span', { text: 'Unassigned' }));
    return h('span', { class: 'cchip' }, h('i', { class: 'cdot', color: colorOf(cid) }), h('span', { text: companyName(cid) + (suffix || '') }));
  }

  function renderPanelSummary(P) {
    var mobile = window.innerWidth <= 900;
    var act = S.act;
    if (isSub()) { renderScope(P, mobile); return; }
    if (mobile) {
      P.append(h('p', { class: 'panel-sub' }, h('strong', { text: 'Tap a section' }), ' to see its contractors and status' + (isAdmin() ? ' and update it.' : '.')));
      if (isAdmin() && S.disp === 'status') P.append(bulkButton());
      return;
    }
    var list = (S.secByBlock[S.block] || []).filter(counted);
    if (S.disp === 'assign') {
      var assigned = list.filter(function (s) { return asgOf(s.id, act); }).length;
      P.append(h('div', { class: 'stack' },
        h('div', null, h('h2', { text: 'Block ' + S.block + ' · Contractors · ' + ACT_SHORT[act] }),
          h('p', { class: 'panel-sub', text: assigned + ' of ' + list.length + ' sections have a ' + ACT_SHORT[act] + ' contractor.' })),
        h('p', { class: 'small muted', text: 'Colours show which company is responsible for ' + ACT[act] + ' on each section. Switch the activity above to see the ' + ACT_SHORT[otherAct(act)] + ' contractors. Colours do not show progress: choose Status for that.' })));
      return;
    }
    var c = statusCounts(list, act);
    P.append(h('div', { class: 'stack' },
      h('div', null, h('h2', { text: 'Block ' + S.block + ' · ' + ACT_SHORT[act] + ' status' }),
        h('p', { class: 'panel-sub', text: list.length + ' sections with an ID (each table has a West and an East section)' })),
      statusBar(c, list.length),
      h('div', { class: 'summary-grid' }, ST.map(function (st) {
        return [h('span', { class: 'sw s-' + st }), h('span', { text: ST_LABEL[st] }), h('span', { class: 'num', text: c[st] + ' · ' + fmtPct(c[st], list.length) })];
      })),
      h('div', { class: 'notice info' },
        h('strong', { text: isAdmin() ? 'To update a section' : 'View-only access' }),
        isAdmin()
          ? h('ol', { class: 'steps' },
            h('li', { text: 'Choose the block and the activity above.' }),
            h('li', { text: 'Tap the West or East section of a table, or type its ID in the search box.' }),
            h('li', { text: 'Press Update status on the activity, choose the status and check the company.' }),
            h('li', { text: 'Check the summary, then press Confirm and save.' }))
          : h('p', { class: 'small', text: 'Tap a section to see its contractors, status and history.' })),
      isAdmin() ? bulkButton() : null));
  }

  // Subcontractor: their scope per activity (an assignment for one activity does not cover the other)
  function renderScope(P, mobile) {
    var act = S.act, co = S.user.company_id, cnt = myCounts();
    var here = (S.secByBlock[S.block] || []).filter(function (s) { return counted(s) && inMyScope(s, act); });
    var total = cnt.mounting[1] + cnt.mounting[5] + cnt.module[1] + cnt.module[5];
    var otherBlock = S.block === 1 ? 5 : 1, oa = otherAct(act);
    if (mobile) {
      P.append(h('div', { class: 'sibling' }, cchip(co), h('span', {
        text: here.length ? plural(here.length, 'section') + ' for ' + ACT_SHORT[act] + ' in Block ' + S.block + '. Tap one to update it.'
          : 'No ' + ACT_SHORT[act] + ' sections for you in Block ' + S.block + (cnt[oa][S.block] ? '. You have ' + ACT_SHORT[oa] + ' sections here.' : '.')
      })));
      var tm = todayTargetCard(true); if (tm) P.append(tm);
      if (here.length && S.disp === 'status') P.append(bulkButton());
      return;
    }
    var stack = h('div', { class: 'stack scope-card' }, todayTargetCard(true),
      h('div', null, h('h2', { text: 'Your scope' }), h('div', { class: 'sibling' }, cchip(co))));
    if (!total) {
      stack.append(h('div', { class: 'notice warn', text: 'No sections are assigned to your company yet. Ask the administrator to assign your tables and activity.' }));
      P.append(stack); return;
    }
    stack.append(h('table', { class: 'scope-tbl' },
      h('thead', null, h('tr', null, h('th', { text: 'Activity' }), h('th', { class: 'num', text: 'Block 1' }), h('th', { class: 'num', text: 'Block 5' }))),
      h('tbody', null, ACTS.map(function (a) {
        return h('tr', { class: a === act ? 'is-current' : null },
          h('td', null, a === act ? h('strong', { text: ACT_SHORT[a] })
            : h('button', { type: 'button', class: 'link-btn', text: ACT_SHORT[a], onclick: function () { setAct(a); if (S.scopeOnly) fitScope(true); } })),
          h('td', { class: 'num', text: String(cnt[a][1]) }), h('td', { class: 'num', text: String(cnt[a][5]) }));
      }))));
    if (here.length) {
      var c = statusCounts(here, act);
      stack.append(h('p', { class: 'small', text: ACT_SHORT[act] + ' in Block ' + S.block + ':' }), statusBar(c, here.length),
        h('div', { class: 'summary-grid' }, ST.map(function (st) {
          return [h('span', { class: 'sw s-' + st }), h('span', { text: ST_LABEL[st] }), h('span', { class: 'num', text: c[st] + ' · ' + fmtPct(c[st], here.length) })];
        })),
        h('div', { class: 'tool-row' },
          h('button', { type: 'button', class: 'btn small', text: 'Zoom to my sections', onclick: function () { if (!fitScope(true)) toast('Nothing assigned to you in this block.', 'err'); } }),
          S.disp === 'status' ? bulkButton() : null));
    } else {
      var tips = [];
      if (cnt[act][otherBlock]) tips.push(h('button', { type: 'button', class: 'btn small', text: 'Go to Block ' + otherBlock, onclick: function () { setBlock(otherBlock); } }));
      if (cnt[oa][S.block]) tips.push(h('button', { type: 'button', class: 'btn small', text: 'Show ' + ACT_SHORT[oa], onclick: function () { setAct(oa); if (S.scopeOnly) fitScope(true); } }));
      stack.append(h('div', { class: 'notice warn' }, 'Your company has no ' + ACT_SHORT[act] + ' sections in Block ' + S.block + '.',
        tips.length ? h('div', { class: 'tool-row tips' }, tips) : null));
    }
    stack.append(h('div', { class: 'notice info' }, h('strong', { text: 'To update a section' }),
      h('ol', { class: 'steps' },
        h('li', { text: 'Choose the activity above. Your sections for it are bright; the rest is faded (My scope).' }),
        h('li', { text: 'Tap the West or East section of a table, or search its ID.' }),
        h('li', { text: 'Press Update status, choose the status, then confirm.' }))));
    P.append(stack);
  }

  function areaNames() {
    var areas = new Set(); S.assign.forEach(function (a) { if (a.area) areas.add(a.area); });
    return Array.from(areas).sort(function (a, b) { return a.localeCompare(b); });
  }
  // Assignment tools: always for ONE activity, the one shown on the keyplan
  function renderAssignTools(P) {
    var act = S.act, oa = otherAct(act), mobile = window.innerWidth <= 900;
    var sel = Array.from(S.multi).map(function (id) { return S.sections.get(id); }).filter(Boolean);
    sel.sort(cmpSec);
    var byCo = new Map(), un = 0;
    sel.forEach(function (s) { var a = asgOf(s.id, act); if (a) byCo.set(a.company_id, (byCo.get(a.company_id) || 0) + 1); else un++; });
    var compact = mobile && !sel.length;
    var stack = h('div', { class: 'stack' + (compact ? ' compact' : '') },
      h('div', null, h('h2', { text: 'Assign contractors · Block ' + S.block }),
        compact ? null : h('p', { class: 'panel-sub', text: 'Choose the activity, select sections, then choose the company. Assigning does not change any status.' })),
      h('div', { class: 'field' }, h('span', { class: 'label', id: 'as-act-label', text: 'Activity to assign' }),
        h('div', { class: 'act-pick', role: 'group', 'aria-labelledby': 'as-act-label' }, ACTS.map(function (x) {
          return h('button', { type: 'button', 'data-act': x, 'aria-pressed': String(x === act), text: ACT_SHORT[x], onclick: function () { setAct(x); } });
        })),
        compact ? null : h('p', { class: 'hint', text: 'Only ' + ACT[act] + ' is assigned here. The ' + ACT_SHORT[oa] + ' contractor of each section stays as it is.' })),
      h('div', { class: 'tool-row' },
        h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.pick === 'tap'), text: 'Tap to select', onclick: function () { setPick(S.pick === 'tap' ? null : 'tap'); } }),
        h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.pick === 'area'), text: 'Draw an area', onclick: function () { setPick(S.pick === 'area' ? null : 'area'); } })),
      h('p', { class: 'mode-note', text: S.pick === 'area' ? 'Drag a box on the keyplan. Every section whose centre is inside is added. Use two fingers or the buttons to move.'
        : S.pick === 'tap' ? 'Tap sections to add or remove them. Drag to move the keyplan.' : 'Choose a selection tool, or pick a named area below.' }));
    var names = areaNames();
    if (names.length) {
      var selArea = h('select', { id: 'as-pick-area' }, h('option', { value: '', text: 'Add the sections of a named area…' }),
        names.map(function (n) { return h('option', { value: n, text: n }); }));
      selArea.addEventListener('change', function () { if (selArea.value) selectNamedArea(selArea.value); });
      stack.append(h('div', { class: 'field' }, h('label', { for: 'as-pick-area', text: 'Named area (Block ' + S.block + ')' }), selArea));
    }
    stack.append(h('div', { class: 'sel-count', text: sel.length ? plural(sel.length, 'section') + ' selected' : 'No sections selected' }));
    if (sel.length) {
      if (S.multiFresh) {
        stack.append(h('p', { class: 'hint keep-note', text: 'Still selected, so you can switch the activity and assign it too. Tapping or drawing starts a new selection.' }));
      }
      stack.append(h('div', { class: 'sel-list', text: sel.slice(0, 40).map(secLabel).join(', ') + (sel.length > 40 ? ' …' : '') }));
      var cur = h('div', { class: 'summary-grid', 'aria-label': 'Current ' + ACT_SHORT[act] + ' contractor of the selection' });
      byCo.forEach(function (n, cid) { cur.append(h('i', { class: 'cdot', color: colorOf(cid) }), h('span', { text: 'Now ' + companyName(cid) }), h('span', { class: 'num', text: String(n) })); });
      if (un) cur.append(h('i', { class: 'cdot none' }), h('span', { text: 'Now unassigned' }), h('span', { class: 'num', text: String(un) }));
      stack.append(h('p', { class: 'small', text: 'Current ' + ACT_SHORT[act] + ' contractor:' }), cur);
      var selCo = h('select', { id: 'as-company' }, h('option', { value: '', text: activeCompanies().length ? 'Choose the company…' : 'No companies yet' }),
        activeCompanies().map(function (c) { return h('option', { value: c.id, text: c.name, selected: S.lastAssignCo === c.id }); }));
      var area = h('input', { id: 'as-area', maxlength: 80, list: 'as-areas', placeholder: 'Optional, e.g. North cluster rows 1-6' });
      area.value = S.lastArea || '';
      var dl = h('datalist', { id: 'as-areas' }, names.map(function (a) { return h('option', { value: a }); }));
      var btnA = h('button', { type: 'button', class: 'btn primary', id: 'btn-assign', text: 'Assign ' + ACT_SHORT[act] });
      btnA.addEventListener('click', function () {
        if (!selCo.value) { toast('Choose the company first.', 'err'); return; }
        S.lastAssignCo = +selCo.value; S.lastArea = area.value.trim();
        doAssign(Array.from(S.multi), +selCo.value, area.value.trim(), false);
      });
      stack.append(
        h('div', { class: 'field' }, h('label', { for: 'as-company', text: 'Assign ' + ACT_SHORT[act] + ' to' }), selCo),
        h('div', { class: 'field' }, h('label', { for: 'as-area', text: 'Area name' }), area, dl),
        h('div', { class: 'tool-row' }, btnA,
          h('button', { type: 'button', class: 'btn', text: 'Unassign', disabled: !byCo.size, onclick: confirmUnassign }),
          h('button', { type: 'button', class: 'btn ghost', text: 'Clear selection', onclick: function () { S.multi.clear(); S.multiFresh = false; paintStatuses(); renderPanel(); } })));
    }
    if (!S.pick && !sel.length && !compact) {
      stack.append(h('p', { class: 'small muted', text: 'Tip: tap a section without a selection tool to see its details and history.' }));
    }
    P.append(stack);
  }
  function selectNamedArea(name) {
    startNewSelection();
    var n = 0;
    (S.secByBlock[S.block] || []).forEach(function (s) {
      if (ACTS.some(function (a) { var x = asgOf(s.id, a); return x && x.area === name; })) { S.multi.add(s.id); n++; }
    });
    paintStatuses(); renderPanel();
    if (!n) toast('No sections of “' + name + '” in Block ' + S.block + '.', 'err');
  }
  function setPick(p) {
    S.pick = p;
    if (p) { S.selected = null; S.mode = 'details'; }
    paintStatuses(); renderPanel();
  }
  function doAssign(ids, companyId, area, allowReassign, forAct) {
    var act = forAct || S.act;
    return call('assign_sections', { p_section_ids: ids, p_activity: act, p_company_id: companyId, p_area: area || '', p_allow_reassign: !!allowReassign })
      .then(function (r) {
        toast((companyId ? 'Assigned ' + plural(r.changed, 'section') + ' to ' + companyName(companyId) : 'Unassigned ' + plural(r.changed, 'section'))
          + ' for ' + ACT_SHORT[act] + (r.unchanged ? ' (' + r.unchanged + ' unchanged).' : '.'), 'ok', 6000);
        S.multiFresh = true; // keep the selection: the other activity can be assigned next
        closeModal();
        return loadBootstrap().then(function () { refreshAll(); });
      })
      .catch(function (e) {
        if (e.hint === 'assign_conflict') { showConflict(e, ids, companyId, area, act); return; }
        if (e.hint !== 'session' && e.hint !== 'password') toast(e.message, 'err', 8000);
      });
  }
  function showConflict(e, ids, companyId, area, act) {
    var list = [];
    try { list = JSON.parse(e.details || '[]'); } catch (x) { list = []; }
    var byCo = new Map();
    list.forEach(function (c) { var k = c.company_id; if (!byCo.has(k)) byCo.set(k, []); byCo.get(k).push(c.code || '(no ID)'); });
    var conflictIds = new Set(list.map(function (c) { return c.section_id; }));
    var rest = ids.filter(function (id) { return !conflictIds.has(id); });
    openModal('Some sections already have a ' + ACT_SHORT[act] + ' contractor', [
      h('p', { text: e.message + ' Nothing has been changed yet. The ' + ACT_SHORT[otherAct(act)] + ' assignments are not affected.' }),
      h('div', { class: 'stack' }, Array.from(byCo.entries()).map(function (en) {
        return h('div', null, cchip(en[0], ' · ' + en[1].length), h('div', { class: 'sel-list', text: en[1].slice(0, 30).join(', ') + (en[1].length > 30 ? ' …' : '') }));
      })),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', text: 'Reassign all ' + ids.length + ' to ' + companyName(companyId), onclick: function () { doAssign(ids, companyId, area, true, act); } }),
        rest.length ? h('button', { type: 'button', class: 'btn', text: 'Assign only the other ' + rest.length, onclick: function () { doAssign(rest, companyId, area, false, act); } }) : null,
        h('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: closeModal }))]);
  }
  function confirmUnassign() {
    var act = S.act;
    var ids = Array.from(S.multi).filter(function (id) { return asgOf(id, act); });
    openModal('Unassign ' + plural(ids.length, 'section') + ' from ' + ACT_SHORT[act] + '?', [
      h('p', { text: 'They will show as Unassigned for ' + ACT[act] + '. Their ' + ACT_SHORT[otherAct(act)] + ' contractor, installation statuses and history stay as they are. The change is recorded in the assignment log.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', text: 'Unassign', onclick: function () { doAssign(ids, null, '', true, act); } }),
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function flagNotices(s) {
    var p = parentOf(s), out = [];
    if (!s.code) {
      if (p && !p.code) out.push(h('div', { class: 'notice err' }, h('strong', { text: 'No table ID in the drawing' }),
        'This table has no ID in the DWG or the PDF keyplan, so its sections are not counted and cannot be updated. ' +
        (isAdmin() ? 'Use Edit table info to assign its ID.' : 'Ask the administrator to assign its ID.')));
      else out.push(h('div', { class: 'notice err' }, h('strong', { text: 'West/East not confirmed' }), s.flag_notes || '',
        isAdmin() ? h('div', { class: 'small', text: 'Use Edit section to set W or E once confirmed.' }) : null));
      return out;
    }
    var flags = (p && p.flags || []).filter(function (f) { return f !== 'no_id'; }).concat(s.flags || []);
    if (flags.length) {
      var notes = [p && p.flag_notes, s.flag_notes].filter(Boolean).join(' ');
      out.push(h('div', { class: 'notice warn' }, h('strong', { text: 'Drawing note: ' + flags.map(function (f) { return FLAG_LABEL[f] || f; }).join(' · ') }),
        notes, p && p.review_note ? h('div', { class: 'small', text: 'Review: ' + p.review_note }) : null));
    }
    return out;
  }

  function renderDetails(P, s) {
    var p = parentOf(s), sib = siblingOf(s);
    var head = h('div', { class: 'panel-head' },
      h('div', null, h('h2', { text: 'Section' }), h('div', { class: 'panel-tid', text: s.code || 'NO ID' }),
        h('p', { class: 'panel-sub', text: (s.side ? SIDE_LABEL[s.side] + ' half' : 'Half outline') + ' of table ' + (p && p.code ? p.code : '(no ID)') + ' · Block ' + s.block + (s.is_active ? '' : ' · excluded') })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: function () { selectSection(null); } }));
    var stack = h('div', { class: 'stack' }, head);
    if (sib) stack.append(h('div', { class: 'sibling' }, h('span', { text: 'Other half:' }),
      h('button', { type: 'button', class: 'link-btn tid', text: secLabel(sib), onclick: function () { selectSection(sib.id); } })));
    if (!s.code) {
      // no ID: no status cards, but show who is assigned (if anyone)
      stack.append(h('div', { class: 'asg-mini' }, ACTS.map(function (act) {
        var a = asgOf(s.id, act);
        return h('div', { class: 'sibling' }, h('span', { text: ACT_SHORT[act] + ':' }), cchip(a && a.company_id));
      })));
    }
    stack.append(flagNotices(s));
    var rcard = rfiCard(s); if (rcard) stack.append(rcard);
    if (s.code) {
      [S.act, otherAct(S.act)].forEach(function (act) { stack.append(actCard(s, act)); }); // activity on screen first
      var qcard = cciCard(s); if (qcard) stack.append(qcard);
      if (isSub() && s.is_active && !updatableActs(s).length) {
        stack.append(h('p', { class: 'small muted', text: 'This section is not assigned to your company for either activity. Ask the administrator if this is wrong.' }));
      }
      stack.append(historyBox(s));
    }
    if (isAdmin()) {
      stack.append(h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', text: 'Edit table info', onclick: function () { openTableEditor(p); } }),
        h('button', { type: 'button', class: 'btn small', text: 'Edit section', onclick: function () { openSectionEditor(s); } })));
    }
    P.append(stack);
  }

  // One card per activity: its own contractor, status and update button
  function actCard(s, act) {
    var u = curOf(s.id, act), st = u ? u.status : 'not_started', a = asgOf(s.id, act);
    var card = h('section', { class: 'act-card' + (act === S.act ? ' is-current' : ''), 'aria-label': ACT[act], 'data-act': act },
      h('h3', { text: ACT[act] }), h('div', null, chip(st)));
    var kv = h('dl', { class: 'kv' },
      h('dt', { text: 'Contractor' }), h('dd', { class: 'asg-dd' }, cchip(a && a.company_id)),
      a && a.area ? [h('dt', { text: 'Area' }), h('dd', { text: a.area })] : null);
    if (u) {
      kv.append(
        h('dt', { text: 'Saved for' }), h('dd', null, h('strong', { text: u.company_name })),
        h('dt', { text: 'Updated by' }), h('dd', { text: u.full_name ? u.full_name + ' (' + u.username + ')' : u.username }),
        h('dt', { text: 'Date & time' }), h('dd', { text: fmtTime(u.created_at) }));
      if (u.remarks) kv.append(h('dt', { text: 'Remarks' }), h('dd', { text: u.remarks }));
    }
    card.append(kv);
    if (!u) card.append(h('p', { class: 'small muted', text: 'No update recorded yet.' }));
    if (canUpdate(s, act)) {
      card.append(h('button', { type: 'button', class: 'btn primary small', text: 'Update status', onclick: function () { openForm(s, act); } }));
    } else if (isSub() && s.is_active) {
      card.append(h('p', { class: 'small muted', text: a ? 'Only ' + companyName(a.company_id) + ' accounts can update this activity.' : 'Not assigned to your company for this activity.' }));
    }
    return card;
  }

  function historyBox(s) {
    var hist = S.history.get(s.id);
    var box = h('details', { class: 'hist-box' });
    if (prefs().histOpen) box.open = true;
    box.addEventListener('toggle', function () { savePrefs({ histOpen: box.open }); });
    var n = hist && hist.history ? hist.history.length + hist.assignments.length : null;
    box.append(h('summary', { text: 'History' + (n !== null ? ' (' + n + ')' : '') }));
    if (hist === undefined || hist === 'loading') box.append(h('p', { class: 'small muted', text: 'Loading history…' }));
    else if (hist === 'error') box.append(h('p', { class: 'small muted', text: 'Could not load the history. It will retry on the next refresh.' }));
    else {
      var items = hist.history.map(function (u) { return { at: u.created_at, u: u }; })
        .concat(hist.assignments.map(function (a) { return { at: a.at, a: a }; }))
        .sort(function (x, y) { return x.at < y.at ? 1 : -1; });
      if (!items.length) box.append(h('p', { class: 'small muted', text: 'No changes recorded yet.' }));
      else box.append(h('ul', { class: 'hist' }, items.map(function (it) {
        if (it.u) {
          var u = it.u;
          return h('li', null,
            h('div', { class: 'hist-top' }, h('strong', { text: ACT_SHORT[u.activity] }), chip(u.status)),
            h('div', { class: 'hist-meta', text: fmtTime(u.created_at) + ' · ' + u.company_name + ' · by ' + u.username }),
            u.remarks ? h('div', { class: 'hist-rem', text: u.remarks }) : null);
        }
        var a = it.a;
        return h('li', null,
          h('div', { class: 'hist-top' }, h('strong', { text: 'Contractor · ' + (a.activity ? ACT_SHORT[a.activity] : 'both activities') }),
            h('span', { class: 'small', text: (a.prev_company_name || 'Unassigned') + ' → ' + (a.new_company_name || 'Unassigned') })),
          h('div', { class: 'hist-meta', text: fmtTime(a.at) + ' · by ' + a.username + (a.new_area ? ' · area: ' + a.new_area : '') + (a.activity ? '' : ' · before activities were assigned separately') }));
      })));
    }
    return box;
  }

  function loadHistory(id, force) {
    var cur = S.history.get(id);
    if (!force && cur && cur.history) return;
    S.history.set(id, 'loading');
    call('get_section_history', { p_section_id: id }).then(function (d) {
      S.history.set(id, { history: d.history || [], assignments: d.assignments || [] });
    }).catch(function () {
      S.history.set(id, 'error');
    }).then(function () {
      if (S.selected === id && S.mode === 'details' && S.page === 'keyplan') renderPanel();
    });
  }

  // ----- update form -----
  function openForm(s, act) {
    if (!canUpdate(s, act)) return;
    var u = curOf(s.id, act), a = asgOf(s.id, act);
    S.form = { sid: s.id, act: act, status: null, company: a ? a.company_id : null, remarks: '', base: u ? u.id : null, dirty: false };
    S.mode = 'form';
    if (S.act !== act) setAct(act); else renderPanel(); // keyplan shows the activity being updated
    if (window.innerWidth <= 900) ensureVisible(s);
  }
  function setFormAct(act) {
    var f = S.form; if (!f) return;
    var s = S.sections.get(f.sid);
    if (!canUpdate(s, act)) return;
    var u = curOf(f.sid, act), a = asgOf(f.sid, act);
    f.act = act; f.base = u ? u.id : null; f.company = a ? a.company_id : null;
    if (S.act !== act) setAct(act); else renderPanel();
  }
  function renderForm(P, s) {
    var f = S.form, u = curOf(s.id, f.act), cur = u ? u.status : 'not_started', a = asgOf(s.id, f.act);
    var head = h('div', { class: 'panel-head' },
      h('div', null, h('h2', { text: 'Update status' }), h('div', { class: 'panel-tid', text: s.code }),
        h('p', { class: 'panel-sub', text: SIDE_LABEL[s.side] + ' half of ' + parentOf(s).code + ' · Block ' + s.block })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cancel update', text: '×', onclick: cancelForm }));
    var allowed = updatableActs(s);
    var actPick = allowed.length > 1
      ? h('div', { class: 'act-pick', role: 'group', 'aria-label': 'Activity' }, allowed.map(function (x) {
        return h('button', { type: 'button', 'aria-pressed': String(f.act === x), text: ACT_SHORT[x], onclick: function () { setFormAct(x); } });
      }))
      : h('div', { class: 'act-fixed' }, h('strong', { text: ACT[f.act] }),
        isSub() ? h('span', { class: 'small muted', text: ' · the activity assigned to your company' }) : null);
    var stPick = h('div', { class: 'status-pick', role: 'group', 'aria-label': 'New status' }, ST.map(function (st) {
      return h('button', { type: 'button', 'aria-pressed': String(f.status === st), onclick: function () { f.status = st; f.dirty = true; renderPanel(); } },
        h('span', { class: 'sw s-' + st }), ST_LABEL[st]);
    }));
    var coField;
    if (a || !isAdmin()) {
      coField = h('div', { class: 'field' }, h('span', { class: 'label', text: 'Responsible contractor (assigned for ' + ACT_SHORT[f.act] + ')' }), h('div', null, cchip(a && a.company_id)));
    } else {
      var companies = activeCompanies();
      var sel = h('select', { id: 'f-company', onchange: function (e) { f.company = e.target.value ? +e.target.value : null; f.dirty = true; renderPanel(); } },
        h('option', { value: '', text: companies.length ? 'Choose the company…' : 'No companies yet' }),
        companies.map(function (c) { return h('option', { value: c.id, text: c.name, selected: f.company === c.id }); }));
      coField = h('div', { class: 'field' }, h('label', { for: 'f-company', text: 'Company responsible (no ' + ACT_SHORT[f.act] + ' contractor assigned yet)' }), sel);
    }
    var rem = h('textarea', { id: 'f-remarks', maxlength: 500, placeholder: 'Optional. For example: waiting for materials.' });
    rem.value = f.remarks;
    rem.addEventListener('input', function () { f.remarks = rem.value; f.dirty = true; });
    var ready = f.status && (a || f.company);
    P.append(h('div', { class: 'stack' }, head,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Activity' }), actPick),
      h('p', { class: 'small' }, 'Current: ', chip(cur), u ? ' · ' + u.company_name + ' · ' + fmtTime(u.created_at) : ' · no update yet'),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'New status' }), stPick),
      coField,
      h('div', { class: 'field' }, h('label', { for: 'f-remarks', text: 'Remarks (optional)' }), rem),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: cancelForm }),
        h('button', { type: 'button', class: 'btn primary', text: 'Review update', disabled: !ready, onclick: function () { S.mode = 'confirm'; renderPanel(); } })),
      !ready ? h('p', { class: 'hint', text: !f.status ? 'Choose the new status.' : 'Choose the responsible company.' }) : null));
  }
  function cancelForm() { S.mode = 'details'; S.form = null; renderPanel(); }

  function renderConfirm(P, s) {
    var f = S.form, u = curOf(s.id, f.act), cur = u ? u.status : 'not_started', a = asgOf(s.id, f.act);
    var coId = a ? a.company_id : f.company;
    var same = u && u.status === f.status && u.company_id === coId;
    var btnSave = h('button', { type: 'button', class: 'btn primary', id: 'btn-save', text: 'Confirm and save', onclick: function () { saveUpdate(btnSave); } });
    P.append(h('div', { class: 'stack' },
      h('div', null, h('h2', { text: 'Confirm update' }), h('p', { class: 'panel-sub', text: 'Check the details. Nothing is saved until you press Confirm and save.' })),
      h('table', { class: 'confirm-tbl' }, h('tbody', null,
        h('tr', null, h('th', { text: 'Section' }), h('td', null, h('strong', { class: 'tid', text: s.code }), ' · ' + SIDE_LABEL[s.side] + ' half of ' + parentOf(s).code + ' · Block ' + s.block)),
        h('tr', null, h('th', { text: 'Activity' }), h('td', { text: ACT[f.act] })),
        h('tr', null, h('th', { text: 'Status' }), h('td', null, chip(cur), h('span', { class: 'arrow', text: '→' }), chip(f.status))),
        h('tr', null, h('th', { text: 'Contractor' }), h('td', null, cchip(coId))),
        h('tr', null, h('th', { text: 'Remarks' }), h('td', { text: f.remarks.trim() || '—' })),
        h('tr', null, h('th', { text: 'Saved by' }), h('td', { text: userLabel(S.user) })),
        h('tr', null, h('th', { text: 'Date & time' }), h('td', { text: 'Recorded by the server when you save' })))),
      same ? h('div', { class: 'notice warn', text: 'The status and company are the same as the current record. Saving adds a new history entry.' }) : null,
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn', text: 'Back', onclick: function () { S.mode = 'form'; renderPanel(); } }),
        btnSave)));
    btnSave.focus();
  }

  function saveUpdate(btn) {
    var f = S.form, s = S.sections.get(f.sid);
    btn.disabled = true; btn.textContent = 'Saving…';
    $$('#panel button').forEach(function (b) { b.disabled = true; });
    call('submit_update', {
      p_section_id: s.id, p_activity: f.act, p_status: f.status, p_company_id: asgOf(s.id, f.act) ? null : f.company,
      p_remarks: f.remarks.trim() || null, p_expected_update_id: f.base
    }).then(function (d) {
      var u = d.update;
      S.cur.set(u.section_id + '|' + u.activity, u);
      S.mode = 'details'; S.form = null;
      var hist = S.history.get(s.id);
      if (hist && hist.history) hist.history.unshift(u);
      paintStatuses(); renderPanel();
      toast('Saved. ' + s.code + ' · ' + ACT_SHORT[u.activity] + ' is now ' + ST_LABEL[u.status] + ' (' + fmtTime(u.created_at) + ').', 'ok', 6000);
    }).catch(function (e) {
      if (e.hint === 'session' || e.hint === 'password') return;
      if (e.hint === 'conflict' || e.hint === 'forbidden') {
        toast(e.message, 'err', 9000);
        S.mode = 'details'; S.form = null;
        poll(true).then(function () { loadHistory(s.id, true); renderPanel(); });
        return;
      }
      toast('Not saved. ' + e.message, 'err', 9000);
      renderPanel();
    });
  }

  // ------------------------------------------------------------------
  // Search
  // ------------------------------------------------------------------
  var SR = { items: [], idx: -1 };
  function searchMatches(q) {
    var n = normId(q), l = looseId(q);
    if (!n) return [];
    var out = [];
    S.sections.forEach(function (s) {
      if (!s.code) return;
      var c = normId(s.code), cl = looseId(s.code), pc = normId(parentOf(s).code), score;
      if (c === n) score = 0; else if (cl === l) score = 1; else if (pc === n || looseId(pc) === l) score = 2;
      else if (c.indexOf(n) === 0) score = 3; else if (c.indexOf(n) > 0) score = 4;
      else if (l.length >= 2 && cl.indexOf(l) >= 0) score = 5; else return;
      out.push({ s: s, score: score });
    });
    out.sort(function (a, b) {
      return a.score - b.score || (a.s.block === S.block ? 0 : 1) - (b.s.block === S.block ? 0 : 1) || cmpSec(a.s, b.s);
    });
    return out.slice(0, 10).map(function (x) { return x.s; });
  }
  function renderSearchList(q) {
    var ul = $('#search-list'); ul.textContent = '';
    SR.items = searchMatches(q); SR.idx = SR.items.length ? 0 : -1;
    if (!q.trim()) { ul.hidden = true; return; }
    if (!SR.items.length) ul.append(h('li', { class: 'empty', text: 'No section with ID “' + q.trim() + '”.' }));
    else SR.items.forEach(function (s, i) {
      ul.append(h('li', {
        role: 'option', 'aria-selected': String(i === SR.idx), id: 'sr-' + i,
        onmousedown: function (e) { e.preventDefault(); chooseSearch(s); }
      }, h('span', { text: s.code }), h('span', { class: 'blk', text: SIDE_LABEL[s.side] + ' · Block ' + s.block })));
    });
    ul.hidden = false;
  }
  function chooseSearch(s) {
    var inp = $('#search');
    inp.value = ''; $('#search-list').hidden = true; inp.blur();
    if (S.page !== 'keyplan') setPage('keyplan');
    if (S.pick) { S.pick = null; paintStatuses(); }
    if (s.block !== S.block) setBlock(s.block);
    selectSection(s.id, { zoom: true });
  }
  function wireSearch() {
    var inp = $('#search');
    inp.addEventListener('input', function () { renderSearchList(inp.value); });
    inp.addEventListener('focus', function () { if (inp.value.trim()) renderSearchList(inp.value); });
    inp.addEventListener('blur', function () { setTimeout(function () { $('#search-list').hidden = true; }, 120); });
    inp.addEventListener('keydown', function (e) {
      var ul = $('#search-list');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!SR.items.length) return;
        e.preventDefault();
        SR.idx = (SR.idx + (e.key === 'ArrowDown' ? 1 : -1) + SR.items.length) % SR.items.length;
        $$('li', ul).forEach(function (li, i) { li.setAttribute('aria-selected', String(i === SR.idx)); });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        var exact = SR.items.filter(function (s) { return normId(s.code) === normId(inp.value) || looseId(s.code) === looseId(inp.value); });
        var pick = SR.idx >= 0 ? SR.items[SR.idx] : null;
        if (exact.length === 1) pick = exact[0];
        if (pick) chooseSearch(pick); else renderSearchList(inp.value);
      } else if (e.key === 'Escape') { ul.hidden = true; inp.blur(); }
    });
  }

  // ------------------------------------------------------------------
  // Sync with the server (polling)
  // ------------------------------------------------------------------
  function startPolling() {
    stopPolling();
    S.pollTimer = setInterval(function () { poll(); }, POLL_MS);
    renderSync();
  }
  function stopPolling() { if (S.pollTimer) clearInterval(S.pollTimer); S.pollTimer = null; }
  function poll(force) {
    if (!S.token || !S.user || S.polling) return Promise.resolve();
    if (document.hidden && !force) return Promise.resolve();
    S.polling = true;
    return call('get_changes', { p_since: S.serverTime }).then(function (d) {
      S.serverTime = d.server_time; S.lastSync = new Date(); S.syncErr = false;
      applyUser(d.user);
      if (S.selected && S.history.get(S.selected) === 'error') loadHistory(S.selected, true);
      if (d.meta_version !== S.metaVersion) {
        return loadBootstrap().then(function () { refreshAll(); });
      }
      var changed = [];
      d.current.forEach(function (u) {
        var k = u.section_id + '|' + u.activity, prev = S.cur.get(k);
        if (!prev || prev.id < u.id) { S.cur.set(k, u); changed.push(u); }
      });
      if (changed.length) {
        loadMyTarget();
        if (S.page === 'dashboard' || (S.page === 'admin' && S.admin.tab === 'targets')) S.tgt.data = null;
        changed.forEach(function (u) {
          var hist = S.history.get(u.section_id);
          if (hist && hist.history && !hist.history.some(function (x) { return x.id === u.id; })) hist.history.unshift(u);
        });
        if (S.page === 'keyplan') {
          paintStatuses();
          if (S.selected && changed.some(function (u) { return u.section_id === S.selected; })) {
            if (S.mode === 'details') renderPanel();
            else toast('Someone just updated ' + secLabel(S.sections.get(S.selected)) + '. Check its status before saving.', 'err', 7000);
          } else if (!S.selected && !S.multi.size) renderPanel();
        } else if (S.page === 'dashboard') renderDashboard();
      }
    }).catch(function (e) {
      S.syncErr = e.hint === 'network' || e.status >= 500;
    }).then(function () { S.polling = false; renderSync(); });
  }
  function refreshAll() {
    loadMyTarget();
    if (S.page === 'keyplan') {
      rebuildKeyplan();
      if (S.selected) loadHistory(S.selected, true); // the reload emptied the history cache
      renderPanel();
    } else if (S.page === 'dashboard') renderDashboard();
    else if (S.page === 'admin') renderAdmin();
  }
  function renderSync() {
    var el = $('#sync'); if (!el) return;
    el.classList.toggle('ok', !S.syncErr && !!S.lastSync);
    el.classList.toggle('err', !!S.syncErr);
    $('#sync-text').textContent = S.syncErr ? 'Offline · retrying' : S.lastSync ? 'Updated ' + clockFmt.format(S.lastSync) : 'Connecting…';
  }

  // ------------------------------------------------------------------
  // Dashboard
  // ------------------------------------------------------------------
  function allSections() { var a = []; BLOCKS.forEach(function (b) { a = a.concat(S.secByBlock[b] || []); }); return a; }
  function renderDashboard(resetPage) {
    var root = $('#dash'); if (!root) return;
    var F = S.dash; if (resetPage) F.page = 0;
    var scrollY = root.parentElement.scrollTop;
    root.textContent = '';
    var blocks = F.block === 'all' ? BLOCKS : [+F.block];
    var acts = F.act === 'all' ? ACTS : [F.act];
    var base = allSections().filter(function (s) { return counted(s) && blocks.indexOf(s.block) >= 0; });
    // The contractor filter is applied per activity: a section can be in Alpha's
    // Mounting Structure scope and in Bravo's PV Module scope at the same time.
    function inFilter(s, act) {
      var a = asgOf(s.id, act);
      if (F.company === 'all') return true;
      if (F.company === 'none') return !a;
      return !!a && String(a.company_id) === F.company;
    }
    var scope = {};
    acts.forEach(function (act) { scope[act] = base.filter(function (s) { return inFilter(s, act); }); });
    var coLabel = F.company === 'all' ? 'All contractors' : F.company === 'none' ? 'Unassigned sections' : companyName(+F.company);
    var blkLabel = blocks.length === 2 ? 'Blocks 1 and 5' : 'Block ' + blocks[0];

    root.append(h('div', { class: 'page-head' },
      h('div', null, h('h1', { text: 'Project overview' }),
        h('p', { text: 'Counts use West and East sections that have an ID in the drawing. A section with no saved update counts as Not Started. Each activity is counted on its own.' })),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', text: 'Download current status (CSV)', onclick: exportCurrent }),
        h('button', { type: 'button', class: 'btn small', text: 'Download full history (CSV)', onclick: exportHistory }))));
    if (isSub()) { var big = todayTargetCard(false); if (big) root.append(big); }
    root.append(renderTargetBoard());
    root.append(renderCciBoard(blocks, F));

    function sel(id, label, value, options, key) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { F[key] = e.target.value; renderDashboard(true); } },
          options.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(value) === String(o[0]) }); })));
    }
    root.append(h('div', { class: 'card' }, h('div', { class: 'filters' },
      sel('f-block', 'Block', F.block, [['all', 'Both blocks'], ['1', 'Block 1'], ['5', 'Block 5']], 'block'),
      sel('f-act', 'Activity', F.act, [['all', 'Both activities'], ['mounting', ACT_SHORT.mounting], ['module', ACT_SHORT.module]], 'act'),
      sel('f-status', 'Status', F.status, [['all', 'All statuses']].concat(ST.map(function (s) { return [s, ST_LABEL[s]]; })), 'status'),
      sel('f-company', 'Contractor (assigned)', F.company, [['all', 'All contractors'], ['none', 'Unassigned']].concat(S.companies.map(function (c) { return [String(c.id), c.name + (c.is_active ? '' : ' (inactive)')]; })), 'company')),
      h('p', { class: 'hint filters-note', text: 'Scope, progress and remaining work are worked out separately for each activity, using that activity\'s contractor assignment. They follow the Block and Contractor filters. The Status filter narrows the section list.' })));

    function kpi(label, num, note, cls, key) {
      return h('div', { class: 'kpi' + (cls ? ' ' + cls : ''), 'data-k': key || null }, h('div', { class: 'k-label', text: label }), h('div', { class: 'k-num' }, num), note ? h('div', { class: 'k-note', text: note }) : null);
    }
    // one summary per activity: scope, completed, remaining, updated today
    var today = new Date().toDateString();
    var sums = h('div', { class: 'act-sums' + (acts.length === 1 ? ' one' : '') });
    acts.forEach(function (act) {
      var list = scope[act], n = list.length, c = statusCounts(list, act);
      var assigned = list.filter(function (s) { return asgOf(s.id, act); }).length;
      var todayN = list.filter(function (s) { var u = curOf(s.id, act); return u && new Date(u.created_at).toDateString() === today; }).length;
      var scopeNote = F.company === 'all' ? assigned + ' assigned · ' + (n - assigned) + ' unassigned'
        : F.company === 'none' ? 'No ' + ACT_SHORT[act] + ' contractor yet' : 'Assigned to this contractor for ' + ACT_SHORT[act];
      sums.append(h('section', { class: 'card act-sum', 'data-act': act, 'aria-label': ACT[act] },
        h('div', { class: 'act-sum-head' }, h('h2', { text: ACT[act] }), h('span', { class: 'small muted', text: blkLabel + ' · ' + coLabel })),
        h('div', { class: 'kpis' },
          kpi('Scope', String(n), scopeNote, null, 'scope'),
          kpi('Completed', [String(c.completed), h('small', { text: ' / ' + n })], fmtPct(c.completed, n) + ' of scope', 's-completed', 'completed'),
          kpi('Remaining', [String(n - c.completed), h('small', { text: ' / ' + n })], 'Ongoing ' + c.ongoing + ' · On hold ' + c.on_hold + ' · Not started ' + c.not_started, 's-not_started', 'remaining'),
          kpi('Updated today', String(todayN), 'Sections with a status saved today', null, 'today')),
        statusBar(c, n)));
    });
    root.append(sums);

    // progress by block and activity (same scope rules)
    var prog = h('div', { class: 'prog' });
    blocks.forEach(function (b) {
      acts.forEach(function (act) {
        var list = scope[act].filter(function (s) { return s.block === b; });
        var c = statusCounts(list, act);
        prog.append(h('div', { class: 'prog-row', 'data-block': String(b), 'data-act': act },
          h('div', { class: 'p-label', text: 'Block ' + b + ' · ' + ACT_SHORT[act] }), statusBar(c, list.length),
          h('div', { class: 'p-nums' }, h('span', { text: 'Scope: ' + list.length }),
            ST.map(function (s) { return h('span', { text: ST_LABEL[s] + ': ' + c[s] }); }),
            h('span', { text: 'Remaining: ' + (list.length - c.completed) }),
            h('strong', { text: fmtPct(c.completed, list.length) + ' completed' }))));
      });
    });
    var nid = { 1: 0, 5: 0 }, cnt = { 1: 0, 5: 0 };
    BLOCKS.forEach(function (b) { (S.secByBlock[b] || []).forEach(function (s) { if (!s.code) nid[b]++; else if (s.is_active) cnt[b]++; }); });
    var outlineNote = BLOCKS.map(function (b) {
      return 'Block ' + b + ': ' + cnt[b] + ' sections' + (nid[b] ? ' (' + nid[b] + ' outline' + (nid[b] > 1 ? 's' : '') + ' without ID not counted)' : '');
    }).join(' · ');
    root.append(h('div', { class: 'card' }, h('h2', { text: 'Progress by block' }),
      h('p', { class: 'card-sub', text: outlineNote }),
      h('div', { class: 'card-stack' },
        h('div', { class: 'legend-inline' }, ST.map(function (s) { return h('span', null, h('i', { class: 'sw s-' + s }), ST_LABEL[s]); })),
        prog)));

    // contractors: each activity has its own contractors
    var byCo = new Map();
    acts.forEach(function (act) {
      base.forEach(function (s) {
        var a = asgOf(s.id, act), k = a ? a.company_id : 0;
        var r = byCo.get(k); if (!r) { r = {}; byCo.set(k, r); }
        var x = r[act] || (r[act] = { n: 0, c: { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 } });
        x.n++; x.c[statusOf(s.id, act)]++;
      });
    });
    var coKeys = Array.from(byCo.keys()).sort(function (x, y) { return x === 0 ? 1 : y === 0 ? -1 : companyName(x).localeCompare(companyName(y)); });
    var coHead1 = h('tr', null, h('th', { rowspan: 2, text: 'Contractor' }));
    var coHead2 = h('tr');
    var COLS = [['n', 'Sections'], ['completed', 'Completed'], ['ongoing', 'Ongoing'], ['on_hold', 'On hold'], ['rem', 'Remaining'], ['pct', '% done']];
    acts.forEach(function (a) {
      coHead1.append(h('th', { colspan: COLS.length, class: 'grp', text: ACT_SHORT[a] }));
      COLS.forEach(function (c, i) { coHead2.append(h('th', { class: 'num' + (i === 0 ? ' grp-start' : ''), text: c[1] })); });
    });
    var coBody = h('tbody');
    coKeys.forEach(function (k) {
      var r = byCo.get(k);
      var tr = h('tr', { 'data-company': String(k) }, h('td', null, cchip(k || null)));
      acts.forEach(function (a) {
        var x = r[a];
        COLS.forEach(function (c, i) {
          var v = !x ? '—' : c[0] === 'n' ? String(x.n) : c[0] === 'rem' ? String(x.n - x.c.completed)
            : c[0] === 'pct' ? fmtPct(x.c.completed, x.n) : String(x.c[c[0]]);
          tr.append(h('td', { class: 'num' + (i === 0 ? ' grp-start' : ''), 'data-col': a + '.' + c[0], text: v }));
        });
      });
      if (F.company !== 'all' && String(k || 'none') !== F.company) tr.className = 'muted';
      coBody.append(tr);
    });
    root.append(h('div', { class: 'card' }, h('h2', { text: 'Contractors' }),
      h('p', { class: 'card-sub', text: 'Each activity has its own contractors. Sections, progress and remaining work per contractor and activity. Colours match the Contractors view of the keyplan.' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dtable co-table' }, h('thead', null, coHead1, coHead2), coBody))));

    // filtered list (one row per section and activity)
    var rows = [];
    base.forEach(function (s) {
      acts.forEach(function (act) {
        if (!inFilter(s, act)) return;
        var u = curOf(s.id, act), st = u ? u.status : 'not_started';
        if (F.status !== 'all' && st !== F.status) return;
        rows.push({ s: s, a: act, u: u, st: st, asg: asgOf(s.id, act) });
      });
    });
    rows.sort(function (x, y) { return cmpSec(x.s, y.s) || ACTS.indexOf(x.a) - ACTS.indexOf(y.a); });
    var per = 50, pages = Math.max(1, Math.ceil(rows.length / per));
    if (F.page >= pages) F.page = pages - 1;
    var body = h('tbody');
    rows.slice(F.page * per, F.page * per + per).forEach(function (r) {
      body.append(h('tr', null,
        h('td', null, h('button', { type: 'button', class: 'link-btn tid', text: r.s.code, title: 'Show on keyplan', onclick: function () { locate(r.s, r.a); } })),
        h('td', { class: 'nowrap', text: 'Block ' + r.s.block }),
        h('td', { class: 'nowrap', text: ACT_SHORT[r.a] }),
        h('td', null, cchip(r.asg && r.asg.company_id)),
        h('td', null, chip(r.st)),
        h('td', { class: 'nowrap', text: r.u ? r.u.username : '—' }),
        h('td', { class: 'nowrap', text: r.u ? fmtTime(r.u.created_at) : '—' }),
        h('td', { text: r.u && r.u.remarks ? r.u.remarks : '' })));
    });
    var listCard = h('div', { class: 'card' }, h('h2', { text: 'Sections matching the filters' }),
      h('p', { class: 'card-sub', text: rows.length + ' section-activit' + (rows.length === 1 ? 'y' : 'ies') + '. Select a section ID to show it on the keyplan.' }));
    if (rows.length) {
      listCard.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable', id: 'dash-list' },
        h('thead', null, h('tr', null, ['Section ID', 'Block', 'Activity', 'Contractor', 'Status', 'Updated by', 'Date & time', 'Remarks'].map(function (x) { return h('th', { text: x }); }))),
        body)));
      if (pages > 1) listCard.append(h('div', { class: 'pager' },
        h('span', { text: 'Page ' + (F.page + 1) + ' of ' + pages }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn small', text: '← Previous', disabled: F.page === 0, onclick: function () { F.page--; renderDashboard(); } }),
          h('button', { type: 'button', class: 'btn small', text: 'Next →', disabled: F.page >= pages - 1, onclick: function () { F.page++; renderDashboard(); } }))));
    } else listCard.append(h('div', { class: 'empty-state', text: 'No sections match these filters.' }));
    root.append(listCard);

    root.append(h('div', { class: 'card' }, h('h2', { text: 'Latest saved updates' }),
      h('p', { class: 'card-sub', text: 'Every change is kept. Newest first. Uses the block, activity and status filters.' }),
      h('div', { id: 'dash-log' }, h('p', { class: 'small muted', text: 'Loading…' }))));
    loadLog();
    root.parentElement.scrollTop = scrollY;
  }
  function loadLog() {
    var F = S.dash;
    call('get_updates', {
      p_block: F.block === 'all' ? null : +F.block, p_activity: F.act === 'all' ? null : F.act,
      p_status: F.status === 'all' ? null : F.status, p_company_id: null, p_limit: 30, p_before_id: null
    }).then(function (d) {
      var box = $('#dash-log'); if (!box) return;
      box.textContent = '';
      if (!d.updates.length) { box.append(h('div', { class: 'empty-state', text: 'No saved updates yet.' })); return; }
      box.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['Date & time', 'Section ID', 'Activity', 'Status', 'Company', 'Saved by', 'Remarks'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, d.updates.map(function (u) {
          return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(u.created_at) }),
            h('td', null, h('span', { class: 'tid', text: u.section_code })), h('td', { class: 'nowrap', text: ACT_SHORT[u.activity] }),
            h('td', null, chip(u.status)), h('td', { text: u.company_name }), h('td', { class: 'nowrap', text: u.username }),
            h('td', { text: u.remarks || '' }));
        })))));
    }).catch(function (e) {
      var box = $('#dash-log'); if (box) box.textContent = 'Could not load updates: ' + e.message;
    });
  }
  function locate(s, act, disp) {
    setPage('keyplan');
    if (S.pick) { S.pick = null; paintStatuses(); }
    if (disp) setDisp(disp);
    if (act) setAct(act);
    if (s.block !== S.block) setBlock(s.block);
    selectSection(s.id, { zoom: true });
  }

  // ----- CSV exports -----
  function csvCell(v) {
    var s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formulas
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(name, rows) {
    var csv = '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function sortedSections() {
    var list = [];
    BLOCKS.forEach(function (b) {
      list = list.concat((S.secByBlock[b] || []).slice().sort(cmpSec));
    });
    return list;
  }
  function exportCurrent() {
    var head = ['Block', 'Section ID', 'Parent table ID', 'Side', 'In monitoring', 'Drawing note'];
    ACTS.forEach(function (act) {
      var n = ACT_SHORT[act];
      head.push(n + ' contractor (assigned)', n + ' area', n + ' status', n + ' saved for company', n + ' updated by', n + ' updated at', n + ' remarks');
    });
    var rows = [head];
    sortedSections().forEach(function (s) {
      var p = parentOf(s);
      var flags = (p.flags || []).concat(s.flags || []).map(function (f) { return FLAG_LABEL[f] || f; }).join('; ');
      var r = [s.block, s.code || '(no section ID)', p.code || '(no ID in drawing)', s.side ? SIDE_LABEL[s.side] : '?', counted(s) ? 'Yes' : 'No', flags];
      ACTS.forEach(function (act) {
        var u = curOf(s.id, act), a = asgOf(s.id, act);
        r.push(a ? companyName(a.company_id) : 'Unassigned', a ? a.area : '',
          counted(s) ? ST_LABEL[u ? u.status : 'not_started'] : '', u ? u.company_name : '', u ? u.username : '', u ? fmtTime(u.created_at) : '', u && u.remarks ? u.remarks : '');
      });
      rows.push(r);
    });
    download('pv-installation-status-' + stamp() + '.csv', rows);
  }
  function exportHistory(e) {
    var btn = e && e.target; if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    call('get_updates', { p_block: null, p_activity: null, p_status: null, p_company_id: null, p_limit: 20000, p_before_id: null })
      .then(function (d) {
        var rows = [['Update no.', 'Date & time', 'Date & time (UTC, ISO)', 'Block', 'Section ID', 'Parent table ID', 'Activity', 'Status', 'Company', 'Username', 'Name', 'Remarks']];
        d.updates.slice().reverse().forEach(function (u) {
          rows.push([u.id, fmtTime(u.created_at), new Date(u.created_at).toISOString(), u.block, u.section_code, u.table_code || '', ACT[u.activity], ST_LABEL[u.status], u.company_name, u.username, u.full_name || '', u.remarks || '']);
        });
        download('pv-installation-history-' + stamp() + '.csv', rows);
      })
      .catch(function (err) { toast('Download failed. ' + err.message, 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Download full history (CSV)'; } });
  }
  function exportAssignments() {
    var rows = [['Block', 'Section ID', 'Parent table ID', 'Side', 'Activity', 'Contractor', 'Area', 'Assigned by', 'Assigned at']];
    sortedSections().forEach(function (s) {
      var p = parentOf(s);
      ACTS.forEach(function (act) {
        var a = asgOf(s.id, act);
        rows.push([s.block, s.code || '(no section ID)', p.code || '(no ID in drawing)', s.side ? SIDE_LABEL[s.side] : '?', ACT[act],
          a ? companyName(a.company_id) : 'Unassigned', a ? a.area : '', a ? a.assigned_by_name : '', a ? fmtTime(a.assigned_at) : '']);
      });
    });
    download('pv-contractor-assignments-' + stamp() + '.csv', rows);
  }

  // ------------------------------------------------------------------
  // Administration
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Bulk status update (several sections, one activity, one status)
  // ------------------------------------------------------------------
  function canBulk(s) { return !!s && canUpdate(s, S.act) && !!asgOf(s.id, S.act); }
  function bulkButton() {
    return h('button', { type: 'button', class: 'btn small bulk-start', text: 'Update several sections', onclick: startBulk });
  }
  function startBulk() {
    S.bulk = true; S.bulkStatus = null; S.selected = null; S.mode = 'details'; S.form = null;
    S.multi.clear(); S.multiFresh = false; S.pick = 'tap';
    paintStatuses(); renderPanel(); drawSelMarker();
  }
  function endBulk() {
    S.bulk = false; S.pick = null; S.multi.clear(); S.bulkStatus = null; S.bulkRemarks = '';
    paintStatuses(); renderPanel();
  }
  function bulkSelection() {
    return Array.from(S.multi).map(function (id) { return S.sections.get(id); }).filter(canBulk).sort(cmpSec);
  }
  function renderBulkTools(P) {
    var act = S.act, sel = bulkSelection();
    var stack = h('div', { class: 'stack bulk-tools' }, todayTargetCard(true),
      h('div', null, h('h2', { text: 'Update several · ' + ACT_SHORT[act] + ' · Block ' + S.block }),
        h('p', { class: 'panel-sub', text: 'Only ' + ACT[act] + ' changes. The ' + ACT_SHORT[otherAct(act)] + ' status stays as it is. Switch the activity above to update the other one.' })),
      h('div', { class: 'tool-row' },
        h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.pick === 'tap'), text: 'Tap to select', onclick: function () { setPick(S.pick === 'tap' ? null : 'tap'); } }),
        h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.pick === 'area'), text: 'Draw an area', onclick: function () { setPick(S.pick === 'area' ? null : 'area'); } }),
        h('button', { type: 'button', class: 'btn small', text: 'Select all mine here', onclick: function () {
          (S.secByBlock[S.block] || []).forEach(function (x) { if (canBulk(x)) S.multi.add(x.id); });
          paintStatuses(); renderPanel();
        } })),
      h('p', { class: 'mode-note', text: S.pick === 'area' ? 'Drag a box on the keyplan. Sections you can update for ' + ACT_SHORT[act] + ' are added.'
        : S.pick === 'tap' ? 'Tap sections to add or remove them.' : 'Choose a selection tool.' }),
      h('div', { class: 'sel-count', text: sel.length ? plural(sel.length, 'section') + ' selected' : 'No sections selected' }));
    if (sel.length) {
      stack.append(h('div', { class: 'sel-list', text: sel.slice(0, 60).map(secLabel).join(', ') + (sel.length > 60 ? ' …' : '') }));
      var now = statusCounts(sel, act);
      stack.append(h('p', { class: 'small', text: 'Current ' + ACT_SHORT[act] + ' status:' }),
        h('div', { class: 'summary-grid' }, ST.filter(function (x) { return now[x]; }).map(function (st) {
          return [h('span', { class: 'sw s-' + st }), h('span', { text: ST_LABEL[st] }), h('span', { class: 'num', text: String(now[st]) })];
        })));
      stack.append(h('div', { class: 'field' }, h('span', { class: 'label', text: 'New status for all selected' }),
        h('div', { class: 'status-pick' }, ST.map(function (st) {
          return h('button', { type: 'button', 'data-st': st, 'aria-pressed': String(S.bulkStatus === st),
            onclick: function () { S.bulkStatus = st; renderPanel(); } }, h('span', { class: 'sw s-' + st }), h('span', { text: ST_LABEL[st] }));
        }))));
      var rm = h('textarea', { id: 'bulk-remarks', maxlength: 500, rows: 2, placeholder: 'Optional; saved on each new record' });
      rm.value = S.bulkRemarks || '';
      rm.addEventListener('input', function () { S.bulkRemarks = rm.value; });
      stack.append(h('div', { class: 'field' }, h('label', { for: 'bulk-remarks', text: 'Remarks' }), rm));
      stack.append(h('div', { class: 'tool-row' },
        h('button', { type: 'button', class: 'btn primary', id: 'btn-bulk-review', disabled: !S.bulkStatus,
          text: S.bulkStatus ? 'Review ' + plural(sel.length, 'update') : 'Choose the new status', onclick: function () { reviewBulk(sel); } }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Clear selection', onclick: function () { S.multi.clear(); paintStatuses(); renderPanel(); } })));
    }
    stack.append(h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn', text: 'Done', onclick: endBulk })));
    P.append(stack);
  }
  function reviewBulk(sel) {
    var act = S.act, st = S.bulkStatus;
    var change = sel.filter(function (x) { return statusOf(x.id, act) !== st; });
    var same = sel.length - change.length;
    var byCo = new Map();
    change.forEach(function (x) { var a = asgOf(x.id, act); byCo.set(a.company_id, (byCo.get(a.company_id) || 0) + 1); });
    var prev = statusCounts(change, act);
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'btn-bulk-confirm', text: change.length ? 'Confirm and save ' + plural(change.length, 'update') : 'Nothing to save' });
    btn.disabled = !change.length;
    btn.addEventListener('click', function () { saveBulk(sel, btn); });
    openModal('Confirm ' + plural(change.length, 'update'), [
      h('dl', { class: 'confirm-dl' },
        h('dt', { text: 'Activity' }), h('dd', { text: ACT[act] }),
        h('dt', { text: 'New status' }), h('dd', null, chip(st)),
        h('dt', { text: 'Sections' }), h('dd', { text: change.length + (same ? ' (' + same + ' already ' + ST_LABEL[st] + ', not saved again)' : '') }),
        h('dt', { text: 'Responsible contractor' }), h('dd', null, Array.from(byCo.entries()).map(function (e) { return cchip(e[0], ' · ' + e[1]); })),
        h('dt', { text: 'Previous status' }), h('dd', { text: ST.filter(function (x) { return prev[x]; }).map(function (x) { return ST_LABEL[x] + ' ' + prev[x]; }).join(' · ') || '—' }),
        S.bulkRemarks ? h('dt', { text: 'Remarks' }) : null, S.bulkRemarks ? h('dd', { text: S.bulkRemarks }) : null),
      h('p', { class: 'small', text: 'Section IDs:' }),
      h('div', { class: 'sel-list bulk-ids', text: change.map(secLabel).join(', ') || '—' }),
      h('p', { class: 'small muted', text: 'Only these sections and only ' + ACT_SHORT[act] + ' change. Earlier records and remarks are kept.' }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: closeModal }))]);
  }
  function saveBulk(sel, btn) {
    var act = S.act, expected = {};
    sel.forEach(function (x) { var u = curOf(x.id, act); expected[x.id] = u ? u.id : null; });
    btn.disabled = true; btn.textContent = 'Saving…';
    call('bulk_submit_update', { p_section_ids: sel.map(function (x) { return x.id; }), p_activity: act, p_status: S.bulkStatus, p_remarks: S.bulkRemarks || null, p_expected: expected })
      .then(function (r) {
        closeModal();
        toast('Saved ' + plural(r.changed, 'section') + ' as ' + ST_LABEL[S.bulkStatus] + ' for ' + ACT_SHORT[act] + (r.unchanged ? ' (' + r.unchanged + ' unchanged).' : '.'), 'ok', 7000);
        S.multi.clear(); S.bulkStatus = null; S.bulkRemarks = '';
        return loadBootstrap().then(function () { refreshAll(); });
      })
      .catch(function (e) {
        closeModal();
        if (e.hint !== 'session' && e.hint !== 'password') toast(e.message, 'err', 10000);
        if (e.hint === 'conflict') loadBootstrap().then(function () { refreshAll(); });
      });
  }

  // ------------------------------------------------------------------
  // Daily targets
  // ------------------------------------------------------------------
  function fmtDate(d) {
    if (!d) return '—';
    var x = new Date(d + 'T00:00:00');
    return x.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function addDays(d, n) { var x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  function pct1(a, b) { return b ? (Math.round(1000 * a / b) / 10).toFixed(1) + '%' : '—'; }
  function tgtIndicator(acc, q) {
    if (acc > q) return h('span', { class: 'pill on', text: 'Over target +' + (acc - q) });
    if (acc === q) return h('span', { class: 'pill on', text: 'Target met' });
    return h('span', { class: 'pill warn', text: 'Below target −' + (q - acc) });
  }
  function areaLabel(t) { return 'Block ' + t.block + (t.area ? ' · ' + t.area : ''); }
  function loadMyTarget() {
    if (!isSub() || !S.token) return;
    rpc('get_target_board', { p_token: S.token }).then(function (d) {
      S.myTarget = d;
      if (S.page === 'keyplan' && !S.selected) renderPanel();
      else if (S.page === 'dashboard') renderDashboard();
    }).catch(function () { /* shown as unavailable */ });
  }
  // contractor: THIS IS YOUR TARGET FOR TODAY
  function todayTargetCard(compact) {
    if (!isSub()) return null;
    var d = S.myTarget;
    var box = h('section', { class: 'today-card' + (compact ? ' compact' : ''), 'aria-label': 'Your target for today' },
      h('h2', { class: 'today-title', text: 'THIS IS YOUR TARGET FOR TODAY' }),
      h('p', { class: 'today-date', text: d ? fmtDate(d.site_date) : 'Loading…' }));
    if (!d) return box;
    if (!d.targets.length) {
      box.append(h('p', { class: 'small', text: 'No target has been set for your company today. Ask the administrator if you expected one.' }));
      return box;
    }
    d.targets.forEach(function (t) {
      var acc = t.accomplished, q = t.quantity, rem = Math.max(0, q - acc);
      var sc = t.scope || {};
      box.append(h('div', { class: 'today-row' },
        h('div', { class: 'today-head' }, h('strong', { text: ACT[t.activity] }), h('span', { text: areaLabel(t) }), tgtIndicator(acc, q)),
        h('div', { class: 'today-nums' },
          h('div', null, h('span', { class: 'tn-label', text: 'Daily target' }), h('span', { class: 'tn-num', text: String(q) })),
          h('div', null, h('span', { class: 'tn-label', text: 'Accomplished' }), h('span', { class: 'tn-num', text: String(acc) })),
          h('div', null, h('span', { class: 'tn-label', text: 'Remaining' }), h('span', { class: 'tn-num', text: String(rem) })),
          h('div', null, h('span', { class: 'tn-label', text: 'Achieved' }), h('span', { class: 'tn-num', text: pct1(acc, q) }))),
        h('div', { class: 'bar' }, (function () { var sp = h('span', { class: 'b-completed' }); sp.style.width = Math.min(100, q ? 100 * acc / q : 0) + '%'; return sp; })()),
        compact ? null : h('p', { class: 'small', text: 'Your assigned ' + ACT_SHORT[t.activity] + ' work in ' + areaLabel(t) + ': ' + (sc.completed || 0) + ' Completed, ' + (sc.ongoing || 0) + ' Ongoing, ' + (sc.on_hold || 0) + ' On Hold, ' + (sc.not_started || 0) + ' Not Started of ' + (sc.total || 0) + '.' }),
        t.remarks ? h('p', { class: 'small today-remarks', text: 'Instructions: ' + t.remarks }) : null));
    });
    if (!compact) box.append(h('p', { class: 'small muted', text: 'Accomplished = sections first saved as Completed today (Philippine time). Saving the same section again does not count twice.' }));
    return box;
  }
  // target vs accomplished table (dashboard; subcontractors see only their own company)
  function renderTargetBoard() {
    var T = S.tgt;
    if (!T.from) { T.from = S.siteDate; T.to = S.siteDate; }
    var card = h('div', { class: 'card tgt-board' }, h('h2', { text: 'Daily target vs accomplished' }));
    function dateIn(id, label, key) {
      var i = h('input', { id: id, type: 'date', value: T[key] || '' });
      i.addEventListener('change', function () { T[key] = i.value || S.siteDate; if (key === 'from' && T.to < T.from) T.to = T.from; T.data = null; renderDashboard(); });
      return h('div', { class: 'field' }, h('label', { for: id, text: label }), i);
    }
    function sel(id, label, key, opts) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { T[key] = e.target.value; renderDashboard(); } },
          opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(T[key]) === String(o[0]) }); })));
    }
    card.append(h('div', { class: 'filters tgt-filters' },
      dateIn('t-from', 'From', 'from'), dateIn('t-to', 'To', 'to'),
      isSub() ? null : sel('t-co', 'Contractor', 'company', [['all', 'All contractors']].concat(S.companies.map(function (c) { return [String(c.id), c.name]; }))),
      sel('t-act', 'Activity', 'act', [['all', 'Both activities'], ['mounting', ACT_SHORT.mounting], ['module', ACT_SHORT.module]]),
      sel('t-blk', 'Block', 'block', [['all', 'Both blocks'], ['1', 'Block 1'], ['5', 'Block 5']])));
    if (!T.data || T.data.from !== T.from || T.data.to !== T.to) {
      card.append(h('p', { class: 'small muted', text: 'Loading targets…' }));
      if (!T.loading) {
        T.loading = true;
        call('get_target_board', { p_from: T.from, p_to: T.to }).then(function (d) { T.data = d; })
          .catch(function (e) { T.data = { from: T.from, to: T.to, targets: [], untargeted: [], error: e.message }; })
          .then(function () { T.loading = false; if (S.page === 'dashboard') renderDashboard(); else if (S.page === 'admin') renderAdmin(); });
      }
      return card;
    }
    if (T.data.error) { card.append(h('p', { class: 'form-error', text: T.data.error })); return card; }
    function keep(r) {
      return (T.company === 'all' || String(r.company_id) === T.company) && (T.act === 'all' || r.activity === T.act) && (T.block === 'all' || String(r.block) === T.block);
    }
    var rows = T.data.targets.filter(keep), extra = T.data.untargeted.filter(keep);
    var tq = 0, ta = 0; rows.forEach(function (r) { tq += r.quantity; ta += r.accomplished; });
    card.append(h('p', { class: 'small', text: rows.length ? 'Total: target ' + tq + ', accomplished ' + ta + ', remaining ' + Math.max(0, tq - ta) + ' (' + pct1(ta, tq) + ').' : 'No targets in this period for these filters.' }));
    if (rows.length || extra.length) {
      card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable tgt-table' },
        h('thead', null, h('tr', null, ['Date', 'Contractor', 'Activity', 'Block / area', 'Target', 'Accomplished', 'Remaining', 'Achieved', ''].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null,
          rows.map(function (r) {
            return h('tr', null, h('td', { class: 'nowrap', text: fmtDate(r.date) }), h('td', null, cchip(r.company_id)),
              h('td', { text: ACT_SHORT[r.activity] }), h('td', { text: areaLabel(r) }),
              h('td', { class: 'num' }, String(r.quantity), r.revision ? h('div', { class: 'small muted', text: 'revised (was ' + r.original_quantity + ')' }) : null),
              h('td', { class: 'num', text: String(r.accomplished) }), h('td', { class: 'num', text: String(Math.max(0, r.quantity - r.accomplished)) }),
              h('td', { class: 'num', text: pct1(r.accomplished, r.quantity) }),
              h('td', { class: 'nowrap' }, tgtIndicator(r.accomplished, r.quantity), ' ',
                h('button', { type: 'button', class: 'link-btn', text: 'History', onclick: function () { showTargetHistory(r); } })));
          }),
          extra.map(function (r) {
            return h('tr', { class: 'muted-row' }, h('td', { class: 'nowrap', text: fmtDate(r.date) }), h('td', null, cchip(r.company_id)),
              h('td', { text: ACT_SHORT[r.activity] }), h('td', { text: 'Block ' + r.block }), h('td', { class: 'num', text: '—' }),
              h('td', { class: 'num', text: String(r.accomplished) }), h('td', { class: 'num', text: '—' }), h('td', { class: 'num', text: '—' }),
              h('td', null, h('span', { class: 'pill off', text: 'No target set' })));
          })))));
    }
    card.append(h('p', { class: 'small muted', text: 'Accomplished = sections first saved as Completed on that date (Philippine time), counted once per section and activity. These are reported by the contractor; CCI approval is tracked separately.' }));
    return card;
  }
  function showTargetHistory(t) {
    call('get_target_revisions', { p_target_id: t.id }).then(function (d) {
      openModal('Target history · ' + companyName(t.company_id), [
        h('p', { class: 'small', text: ACT[t.activity] + ' · ' + areaLabel(t) + ' · ' + fmtDate(t.date) + '. The dashboard uses the current quantity: ' + t.quantity + '.' }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
          h('thead', null, h('tr', null, ['When', 'Change', 'Quantity', 'Instructions', 'By'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, d.revisions.map(function (r) {
            return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(r.at) }),
              h('td', { text: r.action === 'created' ? 'Set' : r.action === 'revised' ? 'Revised' : 'Removed' }),
              h('td', { text: r.action === 'revised' ? r.prev_quantity + ' → ' + r.new_quantity : String(r.new_quantity != null ? r.new_quantity : r.prev_quantity) }),
              h('td', { text: (r.action === 'revised' && r.prev_remarks !== r.new_remarks ? (r.prev_remarks || '—') + ' → ' : '') + ((r.action === 'removed' ? r.prev_remarks : r.new_remarks) || '—') }),
              h('td', { text: r.username }));
          })))),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', text: 'Close', onclick: closeModal }))]);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  // administrator: set targets
  function renderTargetsAdmin(body) {
    var A = S.admin; A.tf = A.tf || { company: '', act: 'mounting', block: '1', area: '', qty: '', start: S.siteDate, end: S.siteDate, days: [1, 2, 3, 4, 5, 6], dates: [], remarks: '' };
    var F = A.tf;
    var form = h('div', { class: 'card' }, h('h2', { text: 'Set daily targets' }),
      h('p', { class: 'card-sub', text: 'Targets are per contractor and activity. Choose the exact working days: only the dates in the list get a target, each with its own quantity of table sections.' }));
    function fsel(id, label, key, opts) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { F[key] = e.target.value; renderAdmin(); } },
          opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(F[key]) === String(o[0]) }); })));
    }
    var areas = new Set(); S.assign.forEach(function (a) {
      var sx = S.sections.get(a.section_id);
      if (a.area && String(a.company_id) === F.company && a.activity === F.act && sx && String(sx.block) === F.block) areas.add(a.area);
    });
    form.append(h('div', { class: 'grid-form' },
      fsel('tf-co', 'Contractor', 'company', [['', 'Choose…']].concat(activeCompanies().map(function (c) { return [String(c.id), c.name]; }))),
      fsel('tf-act', 'Activity', 'act', [['mounting', ACT.mounting], ['module', ACT.module]]),
      fsel('tf-blk', 'Block', 'block', [['1', 'Block 1'], ['5', 'Block 5']]),
      fsel('tf-area', 'Work area (optional)', 'area', [['', 'Whole block']].concat(Array.from(areas).sort().map(function (a) { return [a, a]; })))));
    // date picking
    var qty = h('input', { id: 'tf-qty', type: 'number', min: 1, max: 5000, value: F.qty, placeholder: 'e.g. 30' });
    qty.addEventListener('input', function () { F.qty = qty.value; });
    var st = h('input', { id: 'tf-start', type: 'date', value: F.start || '' }), en = h('input', { id: 'tf-end', type: 'date', value: F.end || '' });
    st.addEventListener('change', function () { F.start = st.value; }); en.addEventListener('change', function () { F.end = en.value; });
    var dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var dayBox = h('div', { class: 'day-pick', role: 'group', 'aria-label': 'Working days' }, dayNames.map(function (n, i) {
      var cb = h('input', { type: 'checkbox', checked: F.days.indexOf(i) >= 0 });
      cb.addEventListener('change', function () { F.days = F.days.filter(function (x) { return x !== i; }); if (cb.checked) F.days.push(i); });
      return h('label', { class: 'check' }, cb, h('span', { text: n }));
    }));
    form.append(h('div', { class: 'grid-form' },
      h('div', { class: 'field' }, h('label', { for: 'tf-qty', text: 'Quantity per date (sections)' }), qty),
      h('div', { class: 'field' }, h('label', { for: 'tf-start', text: 'From' }), st),
      h('div', { class: 'field' }, h('label', { for: 'tf-end', text: 'To (same date for one day)' }), en)),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Working days in that range' }), dayBox),
      h('div', { class: 'tool-row' }, h('button', { type: 'button', class: 'btn', id: 'tf-add', text: 'Add these dates to the list', onclick: function () {
        if (!F.start) { toast('Choose the first date.', 'err'); return; }
        var q = parseInt(F.qty, 10); if (!(q >= 1)) { toast('Enter the quantity per date first.', 'err'); return; }
        var end = F.end && F.end >= F.start ? F.end : F.start, d = F.start, n = 0, guard = 0;
        while (d <= end && guard++ < 400) {
          var wd = new Date(d + 'T00:00:00Z').getUTCDay();
          if (F.days.indexOf(wd) >= 0 || d === end && d === F.start) {
            var ex = F.dates.filter(function (x) { return x.date === d; })[0];
            if (ex) ex.quantity = q; else F.dates.push({ date: d, quantity: q });
            n++;
          }
          d = addDays(d, 1);
        }
        F.dates.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
        if (!n) toast('No working days in that range. Tick the days of the week first.', 'err');
        renderAdmin();
      } })));
    if (F.dates.length) {
      form.append(h('p', { class: 'small', text: plural(F.dates.length, 'target date') + '. Change any quantity or remove a date before saving:' }),
        h('div', { class: 'tf-dates' }, F.dates.map(function (x) {
          var qi = h('input', { type: 'number', min: 1, max: 5000, value: x.quantity, 'aria-label': 'Quantity for ' + x.date });
          qi.addEventListener('input', function () { x.quantity = parseInt(qi.value, 10) || 0; });
          return h('div', { class: 'tf-date' }, h('span', { text: fmtDate(x.date) }), qi,
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove ' + x.date, text: '×', onclick: function () { F.dates = F.dates.filter(function (y) { return y !== x; }); renderAdmin(); } }));
        })));
    }
    var rmk = h('textarea', { id: 'tf-remarks', maxlength: 500, rows: 2, placeholder: 'Optional instructions shown to the contractor' });
    rmk.value = F.remarks; rmk.addEventListener('input', function () { F.remarks = rmk.value; });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'tf-save', text: F.dates.length ? 'Save ' + plural(F.dates.length, 'target') : 'Save targets' });
    save.disabled = !F.dates.length;
    save.addEventListener('click', function () {
      err.hidden = true;
      if (!F.company) { err.textContent = 'Choose the contractor.'; err.hidden = false; return; }
      save.disabled = true;
      call('admin_set_targets', { p_company_id: +F.company, p_activity: F.act, p_block: +F.block, p_area: F.area, p_dates: F.dates, p_remarks: F.remarks || null })
        .then(function (r) {
          toast('Targets saved: ' + r.created + ' new, ' + r.revised + ' revised' + (r.unchanged ? ', ' + r.unchanged + ' unchanged' : '') + '.', 'ok', 6000);
          F.dates = []; S.tgt.data = null; renderAdmin();
        })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    form.append(h('div', { class: 'field' }, h('label', { for: 'tf-remarks', text: 'Remarks or instructions' }), rmk), err,
      h('p', { class: 'small muted', text: 'Saving a date that already has a target for this contractor, activity and area revises it; the original and every change stay in its history.' }),
      h('div', { class: 'btn-row' }, save));
    body.append(form);
    // list with edit / remove
    var list = renderTargetBoard();
    list.querySelector('h2').textContent = 'Targets and results';
    $$('.tgt-table tbody tr', list).forEach(function (tr, i) {
      var rows = (S.tgt.data && S.tgt.data.targets || []).filter(function (r) {
        var T = S.tgt; return (T.company === 'all' || String(r.company_id) === T.company) && (T.act === 'all' || r.activity === T.act) && (T.block === 'all' || String(r.block) === T.block);
      });
      var r = rows[i]; if (!r) return;
      var cell = tr.lastChild;
      cell.append(' ', h('button', { type: 'button', class: 'link-btn', text: 'Revise', onclick: function () { reviseTarget(r); } }), ' ',
        h('button', { type: 'button', class: 'link-btn danger', text: 'Remove', onclick: function () { removeTarget(r); } }));
    });
    body.append(list);
  }
  function reviseTarget(t) {
    var q = h('input', { id: 'rv-q', type: 'number', min: 1, max: 5000, value: t.quantity });
    var rm = h('textarea', { id: 'rv-r', maxlength: 500, rows: 2 }); rm.value = t.remarks || '';
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save revision' });
    save.addEventListener('click', function () {
      save.disabled = true;
      call('admin_set_targets', { p_company_id: t.company_id, p_activity: t.activity, p_block: t.block, p_area: t.area, p_dates: [{ date: t.date, quantity: parseInt(q.value, 10) || 0 }], p_remarks: rm.value || null })
        .then(function () { closeModal(); toast('Target revised. The original stays in its history.', 'ok'); S.tgt.data = null; renderAdmin(); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Revise target · ' + companyName(t.company_id), [
      h('p', { class: 'small', text: ACT[t.activity] + ' · ' + areaLabel(t) + ' · ' + fmtDate(t.date) }),
      h('div', { class: 'field' }, h('label', { for: 'rv-q', text: 'Quantity (sections)' }), q),
      h('div', { class: 'field' }, h('label', { for: 'rv-r', text: 'Remarks or instructions' }), rm), err,
      h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function removeTarget(t) {
    openModal('Remove this target?', [
      h('p', { text: companyName(t.company_id) + ' · ' + ACT[t.activity] + ' · ' + areaLabel(t) + ' · ' + fmtDate(t.date) + ' · ' + t.quantity + ' sections. It stops counting on the dashboard; its history is kept.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary', text: 'Remove', onclick: function () {
          call('admin_remove_target', { p_target_id: t.id }).then(function () { closeModal(); toast('Target removed.', 'ok'); S.tgt.data = null; renderAdmin(); })
            .catch(function (e) { toast(e.message, 'err'); });
        } }),
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  // ------------------------------------------------------------------
  // CCI inspection and approval, RFIs
  // ------------------------------------------------------------------
  // latest CCI record for a section and activity (a record for both activities counts for each)
  function cciOf(sid, act) {
    var a = S.q.cci.get(sid + '|' + act), b = S.q.cci.get(sid + '|both');
    if (a && b) return a.id > b.id ? a : b;
    return a || b || null;
  }
  function rfisOf(sid) { return S.q.rfiBySec.get(sid) || []; }
  function qchip(st) { return h('span', { class: 'chip q-' + st, text: CCI_LABEL[st] }); }
  function rfiChip(r) {
    var st = S.q.statuses.get(r.status_id);
    return h('span', { class: 'cchip' }, h('i', { class: 'cdot', color: r.color }), h('span', { text: r.rfi_no + (st ? ' · ' + st.name : '') }));
  }
  function qualityRefresh() { return loadBootstrap().then(function () { refreshAll(); }); }

  function selTools(stack, note) {
    stack.append(h('div', { class: 'tool-row' },
      h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.pick === 'tap'), text: 'Tap to select', onclick: function () { setPick(S.pick === 'tap' ? null : 'tap'); } }),
      h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(S.pick === 'area'), text: 'Draw an area', onclick: function () { setPick(S.pick === 'area' ? null : 'area'); } })),
      h('p', { class: 'mode-note', text: S.pick === 'area' ? 'Drag a box on the keyplan; every section whose centre is inside is added.' : S.pick === 'tap' ? 'Tap sections to add or remove them.' : note }));
    var sel = Array.from(S.multi).map(function (id) { return S.sections.get(id); }).filter(Boolean).sort(cmpSec);
    stack.append(h('div', { class: 'sel-count', text: sel.length ? plural(sel.length, 'section') + ' selected' : 'No sections selected' }));
    if (sel.length) stack.append(h('div', { class: 'sel-list', text: sel.slice(0, 60).map(secLabel).join(', ') + (sel.length > 60 ? ' …' : '') }));
    return sel;
  }
  function renderCciTools(P) {
    var stack = h('div', { class: 'stack' }, h('div', null, h('h2', { text: 'CCI inspection · Block ' + S.block }),
      h('p', { class: 'panel-sub', text: 'Colours show the CCI status for ' + ACT[S.act] + '. Select sections to record an inspection or approval result.' })));
    var sel = selTools(stack, 'Choose a selection tool, or tap a section without one to see its CCI history.');
    if (sel.length) {
      var ok = sel.filter(function (x) { return x.code && x.is_active; });
      if (ok.length < sel.length) stack.append(h('p', { class: 'small muted', text: (sel.length - ok.length) + ' selected without an ID are left out.' }));
      stack.append(h('div', { class: 'tool-row' },
        h('button', { type: 'button', class: 'btn primary', id: 'btn-cci-record', text: 'Record CCI result for ' + plural(ok.length, 'section'), disabled: !ok.length, onclick: function () { openCciForm(ok); } }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Clear selection', onclick: function () { S.multi.clear(); paintStatuses(); renderPanel(); } })));
    }
    stack.append(cciNeedsAction((S.secByBlock[S.block] || []).filter(counted), 8));
    P.append(stack);
  }
  function openCciForm(list, pre) {
    var F = pre || { act: S.act, status: '', insp: S.siteDate || '', appr: '', rein: '', cc: [], ic: [], com: '', iss: '', rem: '', ca: '' };
    function field(id, label, el) { return h('div', { class: 'field' }, h('label', { for: id, text: label }), el); }
    var fAct = h('select', { id: 'q-act' }, [['mounting', ACT.mounting], ['module', ACT.module], ['both', 'Both activities']].map(function (o) { return h('option', { value: o[0], text: o[1], selected: F.act === o[0] }); }));
    var fSt = h('select', { id: 'q-st' }, [h('option', { value: '', text: 'Choose…' })].concat(CCI.map(function (k) { return h('option', { value: k, text: CCI_LABEL[k], selected: F.status === k }); })));
    function dateEl(id, v) { return h('input', { id: id, type: 'date', value: v || '' }); }
    var fI = dateEl('q-insp', F.insp), fA = dateEl('q-appr', F.appr), fR = dateEl('q-rein', F.rein);
    function catBox(kind, chosen) {
      var cats = S.q.cats.filter(function (c) { return c.kind === kind && c.is_active; });
      if (!cats.length) return h('p', { class: 'small muted', text: 'No ' + kind + ' categories yet. Add them in Admin → CCI & RFI.' });
      return h('div', { class: 'cat-pick', 'data-kind': kind }, cats.map(function (c) {
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', value: c.name, checked: chosen.indexOf(c.name) >= 0 }), h('span', { text: c.name }));
      }));
    }
    function ta(id, v, ph) { var t = h('textarea', { id: id, maxlength: 2000, rows: 2, placeholder: ph || '' }); t.value = v || ''; return t; }
    var fCom = ta('q-com', F.com), fIss = ta('q-iss', F.iss), fRem = ta('q-rem', F.rem, 'Your remarks and technical details'), fCa = ta('q-ca', F.ca);
    var cc = catBox('comment', F.cc), ic = catBox('issue', F.ic);
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    function read() {
      F.act = fAct.value; F.status = fSt.value; F.insp = fI.value; F.appr = fA.value; F.rein = fR.value;
      F.cc = $$('input:checked', cc).map(function (x) { return x.value; }); F.ic = $$('input:checked', ic).map(function (x) { return x.value; });
      F.com = fCom.value.trim(); F.iss = fIss.value.trim(); F.rem = fRem.value.trim(); F.ca = fCa.value.trim();
    }
    var next = h('button', { type: 'button', class: 'btn primary', id: 'btn-cci-review', text: 'Review' });
    next.addEventListener('click', function () {
      read(); err.hidden = true;
      var msg = !F.status ? 'Choose the CCI status.' : F.status === 'approved' && !F.appr ? 'Enter the CCI approval date.'
        : ['pending_approval', 'approved', 'rejected', 'reinspection'].indexOf(F.status) >= 0 && !F.insp ? 'Enter the inspection date.'
        : F.status === 'rejected' && !F.ca ? 'Describe the required corrective action.' : '';
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      confirmCci(list, F);
    });
    openModal('Record CCI result · ' + plural(list.length, 'section'), [
      h('p', { class: 'small', text: 'Official CCI result, recorded by you. Installation statuses are not changed.' }),
      h('div', { class: 'grid-form' }, field('q-act', 'Activity', fAct), field('q-st', 'CCI status', fSt)),
      h('div', { class: 'grid-form' }, field('q-insp', 'Inspection date', fI), field('q-appr', 'Approval date', fA), field('q-rein', 'Reinspection date', fR)),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'CCI comment categories' }), cc),
      field('q-com', 'CCI comments', fCom),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Issue / defect categories' }), ic),
      field('q-iss', 'Identified issues or defects', fIss),
      field('q-rem', 'Administrator remarks and technical details', fRem),
      field('q-ca', 'Required corrective action', fCa), err,
      h('div', { class: 'btn-row' }, next, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function confirmCci(list, F) {
    var btn = h('button', { type: 'button', class: 'btn primary', id: 'btn-cci-confirm', text: 'Confirm and save ' + plural(list.length, 'record') });
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Saving…';
      call('record_cci', { p_section_ids: list.map(function (x) { return x.id; }), p_activity: F.act === 'both' ? null : F.act, p_status: F.status,
        p_inspection_date: F.insp || null, p_approval_date: F.appr || null, p_reinspection_date: F.rein || null,
        p_comment_categories: F.cc, p_issue_categories: F.ic, p_cci_comments: F.com || null, p_issues: F.iss || null,
        p_admin_remarks: F.rem || null, p_corrective_action: F.ca || null })
        .then(function (r) { closeModal(); toast('CCI result saved for ' + plural(r.saved, 'section') + '.', 'ok', 6000); S.multi.clear(); return qualityRefresh(); })
        .catch(function (e) { btn.disabled = false; btn.textContent = 'Confirm and save'; if (e.hint !== 'session') toast(e.message, 'err', 8000); });
    });
    function row(k, v) { return v ? [h('dt', { text: k }), h('dd', null, v)] : null; }
    openModal('Confirm CCI result', [
      h('dl', { class: 'confirm-dl' },
        row('Activity', F.act === 'both' ? 'Both activities' : ACT[F.act]), row('CCI status', qchip(F.status)),
        row('Sections', String(list.length)), row('Inspection date', F.insp && fmtDate(F.insp)), row('Approval date', F.appr && fmtDate(F.appr)),
        row('Reinspection date', F.rein && fmtDate(F.rein)), row('Comment categories', F.cc.join(', ')), row('CCI comments', F.com),
        row('Issue categories', F.ic.join(', ')), row('Issues', F.iss), row('Remarks', F.rem), row('Corrective action', F.ca)),
      h('div', { class: 'sel-list bulk-ids', text: list.map(secLabel).join(', ') }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: function () { openCciForm(list, F); } }))]);
  }
  // sections that need action: rectification or reinspection
  function cciNeedsAction(list, max) {
    var rows = [];
    list.forEach(function (x) {
      ACTS.forEach(function (act) {
        var q = cciOf(x.id, act);
        if (q && (q.status === 'rejected' || q.status === 'reinspection') && !rows.some(function (r) { return r.q.id === q.id; })) rows.push({ s: x, q: q });
      });
    });
    var box = h('div', { class: 'stack cci-action' }, h('h3', { text: 'Needs action (' + rows.length + ')' }));
    if (!rows.length) { box.append(h('p', { class: 'small muted', text: 'No section is waiting for rectification or reinspection.' })); return box; }
    rows.sort(function (a, b) { return cmpSec(a.s, b.s); }).slice(0, max || 1000).forEach(function (r) {
      box.append(h('div', { class: 'cci-act-row' },
        h('button', { type: 'button', class: 'link-btn tid', text: secLabel(r.s), onclick: function () { locate(r.s, r.q.activity || S.act); } }),
        qchip(r.q.status), h('span', { class: 'small', text: (r.q.activity ? ACT_SHORT[r.q.activity] : 'Both activities') + (r.q.corrective_action ? ' · ' + r.q.corrective_action : '') + (r.q.reinspection_date ? ' · reinspection ' + fmtDate(r.q.reinspection_date) : '') })));
    });
    if (max && rows.length > max) box.append(h('p', { class: 'small muted', text: (rows.length - max) + ' more on the Dashboard.' }));
    return box;
  }
  function renderRfiTools(P) {
    var stack = h('div', { class: 'stack' }, h('div', null, h('h2', { text: 'RFIs · Block ' + S.block }),
      h('p', { class: 'panel-sub', text: 'Each colour is one RFI number. Select sections, then link or unlink an RFI. Create RFIs in Admin → CCI & RFI.' })));
    var sel = selTools(stack, 'Choose a selection tool, or tap a section to see its RFIs.');
    if (sel.length) {
      var rs = h('select', { id: 'rfi-pick' }, [h('option', { value: '', text: S.q.rfis.length ? 'Choose the RFI…' : 'No RFIs yet' })].concat(S.q.rfis.map(function (r) {
        var st = S.q.statuses.get(r.status_id); return h('option', { value: r.id, text: r.rfi_no + ' · ' + r.subject.slice(0, 40) + (st ? ' (' + st.name + ')' : '') });
      })));
      function go(link) {
        if (!rs.value) { toast('Choose the RFI first.', 'err'); return; }
        call('admin_link_rfi', { p_rfi_id: +rs.value, p_section_ids: sel.map(function (x) { return x.id; }), p_link: link })
          .then(function (r) { toast((link ? 'Linked ' : 'Unlinked ') + plural(r.changed, 'section') + '.', 'ok'); S.multi.clear(); return qualityRefresh(); })
          .catch(function (e) { toast(e.message, 'err', 8000); });
      }
      stack.append(h('div', { class: 'field' }, h('label', { for: 'rfi-pick', text: 'RFI' }), rs),
        h('div', { class: 'tool-row' },
          h('button', { type: 'button', class: 'btn primary', id: 'btn-rfi-link', text: 'Link to selected', onclick: function () { go(true); } }),
          h('button', { type: 'button', class: 'btn', text: 'Unlink', onclick: function () { go(false); } }),
          h('button', { type: 'button', class: 'btn ghost', text: 'Clear selection', onclick: function () { S.multi.clear(); paintStatuses(); renderPanel(); } })));
    }
    if (S.rfiFocus) stack.append(h('div', { class: 'notice info sibling' }, rfiChip(S.q.rfiById.get(S.rfiFocus)), h('button', { type: 'button', class: 'btn small', text: 'Show all RFIs', onclick: function () { S.rfiFocus = null; paintStatuses(); renderPanel(); } })));
    P.append(stack);
  }
  function renderQualitySummary(P) {
    var list = (S.secByBlock[S.block] || []).filter(counted);
    if (isSub()) list = list.filter(function (x) { return asgOf(x.id, 'mounting') && asgOf(x.id, 'mounting').company_id === S.user.company_id || asgOf(x.id, 'module') && asgOf(x.id, 'module').company_id === S.user.company_id; });
    var stack = h('div', { class: 'stack' });
    if (S.disp === 'cci') {
      stack.append(h('h2', { text: (isSub() ? 'Your sections · ' : '') + 'CCI · ' + ACT_SHORT[S.act] + ' · Block ' + S.block }));
      var c = {}; CCI.forEach(function (k) { c[k] = 0; });
      list.forEach(function (x) { var q = cciOf(x.id, S.act); c[q ? q.status : 'not_inspected']++; });
      stack.append(h('div', { class: 'summary-grid' }, CCI.map(function (k) { return [h('span', { class: 'sw q-' + k }), h('span', { text: CCI_LABEL[k] }), h('span', { class: 'num', text: String(c[k]) })]; })));
      stack.append(cciNeedsAction(list, 10));
      stack.append(h('p', { class: 'small muted', text: 'CCI results are recorded by the administrator. Tap a section to see its comments and corrective actions.' }));
    } else {
      stack.append(h('h2', { text: 'RFIs · Block ' + S.block }));
      var ids = new Set(); list.forEach(function (x) { rfisOf(x.id).forEach(function (r) { ids.add(r.id); }); });
      var rl = S.q.rfis.filter(function (r) { return ids.has(r.id); });
      if (!rl.length) stack.append(h('p', { class: 'small muted', text: 'No RFIs on ' + (isSub() ? 'your sections in ' : '') + 'this block.' }));
      rl.forEach(function (r) { stack.append(h('div', { class: 'rfi-line' }, rfiChip(r), h('span', { class: 'small', text: r.subject }))); });
    }
    P.append(stack);
  }
  function cciCard(s) {
    if (isSub() && !(asgOf(s.id, 'mounting') && asgOf(s.id, 'mounting').company_id === S.user.company_id) && !(asgOf(s.id, 'module') && asgOf(s.id, 'module').company_id === S.user.company_id)) return null;
    var card = h('section', { class: 'act-card cci-card', 'aria-label': 'CCI inspection' }, h('h3', { text: 'CCI inspection and approval' }));
    [S.act, otherAct(S.act)].forEach(function (act) {
      var q = cciOf(s.id, act);
      var kv = h('dl', { class: 'kv' }, h('dt', { text: ACT_SHORT[act] }), h('dd', null, qchip(q ? q.status : 'not_inspected')));
      if (q) {
        if (!q.activity) kv.append(h('dt', { text: 'Applies to' }), h('dd', { text: 'Both activities' }));
        if (q.inspection_date) kv.append(h('dt', { text: 'Inspected' }), h('dd', { text: fmtDate(q.inspection_date) }));
        if (q.approval_date) kv.append(h('dt', { text: 'Approved' }), h('dd', { text: fmtDate(q.approval_date) }));
        if (q.reinspection_date) kv.append(h('dt', { text: 'Reinspection' }), h('dd', { text: fmtDate(q.reinspection_date) }));
        var cats = (q.comment_categories || []).concat(q.issue_categories || []);
        if (cats.length) kv.append(h('dt', { text: 'Categories' }), h('dd', { text: cats.join(', ') }));
        if (q.cci_comments) kv.append(h('dt', { text: 'CCI comments' }), h('dd', { text: q.cci_comments }));
        if (q.issues) kv.append(h('dt', { text: 'Issues' }), h('dd', { text: q.issues }));
        if (q.corrective_action) kv.append(h('dt', { text: 'Corrective action' }), h('dd', null, h('strong', { text: q.corrective_action })));
        if (q.admin_remarks) kv.append(h('dt', { text: 'Remarks' }), h('dd', { text: q.admin_remarks }));
        kv.append(h('dt', { text: 'Recorded' }), h('dd', { text: fmtTime(q.created_at) + ' by ' + q.username }));
      }
      card.append(kv);
    });
    card.append(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn small', text: 'CCI history', onclick: function () { showCciHistory(s); } }),
      S.q.canCci && s.code && s.is_active ? h('button', { type: 'button', class: 'btn small', text: 'Record CCI result', onclick: function () { openCciForm([s]); } }) : null));
    return card;
  }
  function showCciHistory(s) {
    call('get_section_quality', { p_section_id: s.id }).then(function (d) {
      openModal('CCI history · ' + secLabel(s), [
        d.cci_history.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
          h('thead', null, h('tr', null, ['Recorded', 'Activity', 'Status', 'Dates', 'Comments / issues', 'Corrective action', 'By'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, d.cci_history.map(function (q) {
            return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(q.created_at) }), h('td', { text: q.activity ? ACT_SHORT[q.activity] : 'Both' }),
              h('td', null, qchip(q.status), q.prev_status ? h('div', { class: 'small muted', text: 'was ' + CCI_LABEL[q.prev_status] }) : null),
              h('td', { class: 'small', text: [q.inspection_date && 'Insp. ' + q.inspection_date, q.approval_date && 'Appr. ' + q.approval_date, q.reinspection_date && 'Reinsp. ' + q.reinspection_date].filter(Boolean).join(' · ') }),
              h('td', { class: 'small', text: [(q.comment_categories || []).concat(q.issue_categories || []).join(', '), q.cci_comments, q.issues, q.admin_remarks].filter(Boolean).join(' — ') }),
              h('td', { class: 'small', text: q.corrective_action || '' }), h('td', { text: q.username }));
          })))) : h('p', { text: 'No CCI record yet.' }),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', text: 'Close', onclick: closeModal }))]);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function rfiCard(s) {
    var rl = rfisOf(s.id); if (!rl.length) return null;
    var card = h('section', { class: 'act-card rfi-card', 'aria-label': 'RFIs' }, h('h3', { text: plural(rl.length, 'RFI') }));
    rl.forEach(function (r) {
      card.append(h('div', { class: 'rfi-item' }, rfiChip(r),
        h('p', { class: 'small', text: (r.discipline ? r.discipline + ' · ' : '') + r.subject }),
        h('p', { class: 'small muted', text: [r.date_raised && 'Raised ' + fmtDate(r.date_raised), r.date_resolved && 'Resolved ' + fmtDate(r.date_resolved)].filter(Boolean).join(' · ') }),
        r.remarks ? h('p', { class: 'small', text: r.remarks }) : null,
        h('button', { type: 'button', class: 'link-btn', text: 'RFI history', onclick: function () { showRfiHistory(r); } })));
    });
    return card;
  }
  function showRfiHistory(r) {
    call('get_rfi_history', { p_rfi_id: r.id }).then(function (d) {
      function describe(l) {
        if (l.action === 'linked' || l.action === 'unlinked') return (l.action === 'linked' ? 'Linked ' : 'Unlinked ') + (l.details.sections || []).join(', ');
        if (l.action === 'created') return 'Created';
        var b = l.details.before || {}, a = l.details.after || {}, out = [];
        ['rfi_no', 'subject', 'discipline', 'date_raised', 'date_resolved', 'remarks', 'color'].forEach(function (k) { if (String(b[k] || '') !== String(a[k] || '')) out.push(k.replace('_', ' ') + ': ' + (b[k] || '—') + ' → ' + (a[k] || '—')); });
        if (b.status_id !== a.status_id) { var x = S.q.statuses.get(b.status_id), y = S.q.statuses.get(a.status_id); out.unshift('status: ' + (x ? x.name : '?') + ' → ' + (y ? y.name : '?')); }
        return out.join('; ') || 'Saved without changes';
      }
      openModal('RFI history · ' + r.rfi_no, [
        h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
          h('thead', null, h('tr', null, ['When', 'Change', 'By'].map(function (x) { return h('th', { text: x }); }))),
          h('tbody', null, d.log.map(function (l) { return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(l.at) }), h('td', { class: 'small', text: describe(l) }), h('td', { text: l.username })); })))),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', text: 'Close', onclick: closeModal }))]);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  // dashboard: CCI per activity and the open RFIs
  function renderCciBoard(blocks, F) {
    var card = h('div', { class: 'card cci-board' }, h('h2', { text: isSub() ? 'CCI inspection of your sections' : 'CCI inspection and approval' }));
    var base = allSections().filter(function (x) { return counted(x) && blocks.indexOf(x.block) >= 0; });
    var acts = F.act === 'all' ? ACTS : [F.act];
    var t = h('table', { class: 'dtable' }, h('thead', null, h('tr', null, [h('th', { text: 'Activity' })].concat(CCI.map(function (k) { return h('th', { class: 'num', text: CCI_LABEL[k] }); })))));
    var tb = h('tbody'); t.append(tb);
    var scopeAll = [];
    acts.forEach(function (act) {
      var list = base.filter(function (x) {
        var a = asgOf(x.id, act);
        if (isSub()) return a && a.company_id === S.user.company_id;
        if (F.company === 'all') return true; if (F.company === 'none') return !a; return a && String(a.company_id) === F.company;
      });
      list.forEach(function (x) { if (scopeAll.indexOf(x) < 0) scopeAll.push(x); });
      var c = {}; CCI.forEach(function (k) { c[k] = 0; });
      list.forEach(function (x) { var q = cciOf(x.id, act); c[q ? q.status : 'not_inspected']++; });
      tb.append(h('tr', null, [h('td', { text: ACT_SHORT[act] })].concat(CCI.map(function (k) { return h('td', { class: 'num', text: String(c[k]) }); }))));
    });
    card.append(h('div', { class: 'table-wrap' }, t), cciNeedsAction(scopeAll, 0));
    var open = S.q.rfis.filter(function (r) { var st = S.q.statuses.get(r.status_id); return !(st && st.is_closed) && r.section_ids.some(function (id) { return scopeAll.some(function (x) { return x.id === id; }); }); });
    card.append(h('h3', { text: 'Open RFIs (' + open.length + ')' }));
    open.forEach(function (r) { card.append(h('div', { class: 'rfi-line' }, rfiChip(r), h('span', { class: 'small', text: r.subject + ' · ' + plural(r.section_ids.length, 'section') }))); });
    return card;
  }
  // administrator: categories, RFI statuses and RFIs
  function renderQualityAdmin(body) {
    var catCard = h('div', { class: 'card' }, h('h2', { text: 'CCI comment and issue categories' }),
      h('p', { class: 'card-sub', text: 'Configurable options for recording CCI results. None are filled in for you: add the categories your project inspections use.' }));
    ['comment', 'issue'].forEach(function (kind) {
      var inp = h('input', { id: 'cat-new-' + kind, maxlength: 120, placeholder: kind === 'comment' ? 'New comment category' : 'New issue / defect category' });
      var add = h('button', { type: 'button', class: 'btn small', text: 'Add', onclick: function () {
        call('admin_save_cci_category', { p_id: null, p_kind: kind, p_name: inp.value, p_is_active: true })
          .then(function () { toast('Category added.', 'ok'); return qualityRefresh(); }).catch(function (e) { toast(e.message, 'err'); });
      } });
      var list = h('div', { class: 'cat-list' }, S.q.cats.filter(function (c) { return c.kind === kind; }).map(function (c) {
        return h('div', { class: 'cat-row' + (c.is_active ? '' : ' off') }, h('span', { text: c.name + (c.is_active ? '' : ' (not offered)') }),
          h('button', { type: 'button', class: 'link-btn', text: 'Rename', onclick: function () {
            var n = h('input', { id: 'cat-rn', maxlength: 120, value: c.name });
            openModal('Rename category', [h('div', { class: 'field' }, h('label', { for: 'cat-rn', text: 'Name' }), n), h('div', { class: 'btn-row' },
              h('button', { type: 'button', class: 'btn primary', text: 'Save', onclick: function () {
                call('admin_save_cci_category', { p_id: c.id, p_kind: kind, p_name: n.value, p_is_active: c.is_active }).then(function () { closeModal(); return qualityRefresh(); }).catch(function (e) { toast(e.message, 'err'); });
              } }), h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
          } }),
          h('button', { type: 'button', class: 'link-btn', text: c.is_active ? 'Stop offering' : 'Offer again', onclick: function () {
            call('admin_save_cci_category', { p_id: c.id, p_kind: kind, p_name: c.name, p_is_active: !c.is_active }).then(qualityRefresh).catch(function (e) { toast(e.message, 'err'); });
          } }));
      }));
      catCard.append(h('h3', { text: kind === 'comment' ? 'Comment categories' : 'Issue / defect categories' }), list, h('div', { class: 'tool-row' }, inp, add));
    });
    body.append(catCard);
    // RFIs
    var rfiCardEl = h('div', { class: 'card' }, h('h2', { text: 'RFIs' }),
      h('p', { class: 'card-sub', text: 'Each RFI number gets its own colour on the RFI keyplan view. Link sections from Keyplan → RFI. The colour shows the RFI number; its status is shown as text.' }),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn primary', id: 'btn-rfi-new', text: 'New RFI', onclick: function () { rfiForm(null); } })));
    if (S.q.rfis.length) {
      rfiCardEl.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['RFI', 'Status', 'Discipline', 'Subject', 'Raised', 'Resolved', 'Sections', ''].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, S.q.rfis.map(function (r) {
          var st = S.q.statuses.get(r.status_id);
          return h('tr', null, h('td', null, h('span', { class: 'cchip' }, h('i', { class: 'cdot', color: r.color }), h('span', { text: r.rfi_no }))),
            h('td', { text: st ? st.name : '' }), h('td', { text: r.discipline || '—' }), h('td', { text: r.subject }),
            h('td', { class: 'nowrap', text: r.date_raised || '—' }), h('td', { class: 'nowrap', text: r.date_resolved || '—' }), h('td', { class: 'num', text: String(r.section_ids.length) }),
            h('td', { class: 'nowrap' },
              h('button', { type: 'button', class: 'link-btn', text: 'Edit', onclick: function () { rfiForm(r); } }), ' ',
              h('button', { type: 'button', class: 'link-btn', text: 'History', onclick: function () { showRfiHistory(r); } }), ' ',
              h('button', { type: 'button', class: 'link-btn', text: 'Show on keyplan', onclick: function () {
                var first = r.section_ids.map(function (id) { return S.sections.get(id); }).filter(Boolean)[0];
                S.rfiFocus = r.id; setPage('keyplan'); if (first && first.block !== S.block) setBlock(first.block); setDisp('rfi'); S.rfiFocus = r.id; paintStatuses(); renderPanel();
              } })));
        })))));
    }
    body.append(rfiCardEl);
    // RFI statuses
    var stCard = h('div', { class: 'card' }, h('h2', { text: 'RFI statuses' }), h('p', { class: 'card-sub', text: 'Configurable. A status marked "closed" counts the RFI as resolved on the dashboard.' }));
    Array.from(S.q.statuses.values()).forEach(function (x) {
      stCard.append(h('div', { class: 'cat-row' + (x.is_active ? '' : ' off') }, h('span', { text: x.name + (x.is_closed ? ' · closed' : '') + (x.is_active ? '' : ' (not offered)') }),
        h('button', { type: 'button', class: 'link-btn', text: x.is_active ? 'Stop offering' : 'Offer again', onclick: function () {
          call('admin_save_rfi_status', { p_id: x.id, p_name: x.name, p_sort: x.sort, p_is_closed: x.is_closed, p_is_active: !x.is_active }).then(qualityRefresh).catch(function (e) { toast(e.message, 'err'); });
        } })));
    });
    var sn = h('input', { id: 'rfi-st-new', maxlength: 60, placeholder: 'New status' }), sc = h('input', { type: 'checkbox', id: 'rfi-st-closed' });
    stCard.append(h('div', { class: 'tool-row' }, sn, h('label', { class: 'check' }, sc, h('span', { text: 'closed' })),
      h('button', { type: 'button', class: 'btn small', text: 'Add status', onclick: function () {
        call('admin_save_rfi_status', { p_id: null, p_name: sn.value, p_sort: 99, p_is_closed: sc.checked, p_is_active: true }).then(qualityRefresh).catch(function (e) { toast(e.message, 'err'); });
      } })));
    body.append(stCard);
  }
  function rfiForm(r) {
    var used = S.q.rfis.filter(function (x) { return !r || x.id !== r.id; }).map(function (x) { return x.color; });
    var color = r ? r.color : (RFI_SUGGEST.filter(function (c) { return used.indexOf(c) < 0; })[0] || '#334155');
    function inp(id, v, attrs) { var i = h('input', Object.assign({ id: id }, attrs || {})); i.value = v || ''; return i; }
    var fNo = inp('rf-no', r && r.rfi_no, { maxlength: 60, placeholder: 'e.g. RFI-PAG1A-001' }), fCol = inp('rf-col', color, { type: 'color' });
    var fDis = inp('rf-dis', r && r.discipline, { maxlength: 80, placeholder: 'e.g. Mounting Structure, Electrical' });
    var fSub = inp('rf-sub', r && r.subject, { maxlength: 300 });
    var fSt = h('select', { id: 'rf-st' }, Array.from(S.q.statuses.values()).filter(function (x) { return x.is_active || (r && r.status_id === x.id); }).map(function (x) { return h('option', { value: x.id, text: x.name, selected: r ? r.status_id === x.id : x.sort === 1 }); }));
    var fRa = inp('rf-ra', r && r.date_raised, { type: 'date' }), fRe = inp('rf-re', r && r.date_resolved, { type: 'date' });
    var fRm = h('textarea', { id: 'rf-rm', maxlength: 2000, rows: 3 }); fRm.value = (r && r.remarks) || '';
    var sw = h('div', { class: 'palette' }, RFI_SUGGEST.map(function (c) {
      return h('button', { type: 'button', class: 'sw-btn', color: c, disabled: used.indexOf(c) >= 0, 'aria-label': 'Colour ' + c, onclick: function () { fCol.value = c; } });
    }));
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', id: 'rf-save', text: r ? 'Save changes' : 'Create RFI' });
    save.addEventListener('click', function () {
      save.disabled = true; err.hidden = true;
      call('admin_save_rfi', { p_id: r ? r.id : null, p_rfi_no: fNo.value, p_color: fCol.value, p_discipline: fDis.value, p_subject: fSub.value, p_status_id: +fSt.value,
        p_date_raised: fRa.value || null, p_date_resolved: fRe.value || null, p_remarks: fRm.value || null })
        .then(function () { return qualityRefresh(); })
        .then(function () { closeModal(); toast(r ? 'RFI saved. The change is in its history.' : 'RFI created. Link its sections from Keyplan → RFI.', 'ok', 6000); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    function field(id, label, el) { return h('div', { class: 'field' }, h('label', { for: id, text: label }), el); }
    openModal(r ? 'Edit ' + r.rfi_no : 'New RFI', [
      h('div', { class: 'grid-form' }, field('rf-no', 'RFI number', fNo), field('rf-st', 'Status', fSt)),
      h('div', { class: 'field' }, h('label', { for: 'rf-col', text: 'Colour on the keyplan (unique per RFI)' }), h('div', { class: 'tool-row' }, fCol, sw)),
      field('rf-dis', 'Activity or discipline', fDis), field('rf-sub', 'Subject / description', fSub),
      h('div', { class: 'grid-form' }, field('rf-ra', 'Date raised', fRa), field('rf-re', 'Date resolved', fRe)),
      field('rf-rm', 'Remarks and supporting details', fRm), err,
      h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function renderAdmin(refetch) {
    var root = $('#admin'); if (!root || !isAdmin()) return;
    var scrollY = root.parentElement.scrollTop;
    root.textContent = '';
    var A = S.admin;
    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Administration' }),
      h('p', { text: 'Accounts, contractors, assignments and drawing review. Only administrators see this page.' }))));
    root.append(h('div', { class: 'subtabs', role: 'group', 'aria-label': 'Administration sections' },
      [['accounts', 'Accounts'], ['companies', 'Companies'], ['assignments', 'Assignments'], ['targets', 'Targets'], ['quality', 'CCI & RFI'], ['review', 'Drawing review']].map(function (x) {
        return h('button', { type: 'button', 'aria-pressed': String(A.tab === x[0]), text: x[1], onclick: function () { A.tab = x[0]; renderAdmin(true); } });
      })));
    var body = h('div', { class: 'stack', id: 'admin-body' });
    root.append(body);
    if (A.tab === 'accounts') renderAccounts(body, refetch || !A.users);
    else if (A.tab === 'companies') renderCompanies(body);
    else if (A.tab === 'assignments') renderAssignments(body, refetch || !A.log);
    else if (A.tab === 'targets') renderTargetsAdmin(body);
    else if (A.tab === 'quality') renderQualityAdmin(body);
    else renderReview(body);
    if (!refetch) root.parentElement.scrollTop = scrollY;
  }

  function roleOptions(selected) {
    return ['subcontractor', 'viewer', 'admin'].map(function (r) { return h('option', { value: r, text: ROLE_LABEL[r], selected: r === selected }); });
  }
  function companyOptions(selected, allowNone) {
    return [h('option', { value: '', text: allowNone ? 'None' : 'Choose…' })].concat(S.companies.map(function (c) {
      return h('option', { value: c.id, text: c.name + (c.is_active ? '' : ' (inactive)'), selected: c.id === selected });
    }));
  }

  function renderAccounts(body, refetch) {
    var A = S.admin;
    var fUser = h('input', { id: 'a-user', maxlength: 32, autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'e.g. abc.foreman' });
    var fName = h('input', { id: 'a-name', maxlength: 120, autocomplete: 'off', placeholder: 'Full name' });
    var fRole = h('select', { id: 'a-role' }, roleOptions('subcontractor'));
    var fCo = h('select', { id: 'a-company' }, companyOptions(null, true));
    var fPw = h('input', { id: 'a-pass', type: 'text', maxlength: 72, autocomplete: 'off', spellcheck: 'false' });
    fPw.value = genPassword();
    var fReq = h('input', { id: 'a-req', type: 'checkbox' });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var btn = h('button', { type: 'submit', class: 'btn primary', text: 'Create account' });
    var form = h('form', { class: 'card', novalidate: true },
      h('h2', { text: 'Add an account' }),
      h('p', { class: 'card-sub', text: 'Subcontractors update the sections assigned to their company. Viewers can only look. Administrators manage everything.' }),
      !S.companies.length ? h('div', { class: 'notice warn', text: 'Add the contractor and subcontractor companies first (Companies tab). Subcontractor accounts need a company.' }) : null,
      h('div', { class: 'grid-form' },
        h('div', { class: 'field' }, h('label', { for: 'a-user', text: 'Username' }), fUser),
        h('div', { class: 'field' }, h('label', { for: 'a-name', text: 'Full name' }), fName),
        h('div', { class: 'field' }, h('label', { for: 'a-role', text: 'Role' }), fRole),
        h('div', { class: 'field' }, h('label', { for: 'a-company', text: 'Company' }), fCo),
        h('div', { class: 'field' }, h('label', { for: 'a-pass', text: 'Password' }),
          h('div', { class: 'pw-wrap' }, fPw, h('button', { type: 'button', class: 'pw-toggle', text: 'New', 'aria-label': 'Generate a new password', onclick: function () { fPw.value = genPassword(); } })))),
      h('label', { class: 'check' }, fReq, h('span', { text: 'Ask the user to choose their own password at first sign-in' })),
      err, h('div', { class: 'btn-row' }, btn));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      err.hidden = true; btn.disabled = true; btn.textContent = 'Creating…';
      var uname = fUser.value.trim(), pw = fPw.value;
      call('admin_create_user', {
        p_username: uname, p_full_name: fName.value.trim(), p_role: fRole.value,
        p_company_id: fCo.value ? +fCo.value : null, p_password: pw, p_require_change: fReq.checked
      }).then(function () {
        A.users = null;
        showCredentials('Account created', uname, pw, fReq.checked);
        renderAdmin(true);
      }).catch(function (e2) {
        err.textContent = e2.message; err.hidden = false; btn.disabled = false; btn.textContent = 'Create account';
      });
    });
    body.append(form);
    var listCard = h('div', { class: 'card' }, h('h2', { text: 'Accounts' }));
    body.append(listCard);
    if (refetch || !A.users) {
      var loading = h('p', { class: 'small muted', text: 'Loading accounts…' });
      listCard.append(loading);
      // fill in only the list when it arrives, so that nothing typed in the form above is lost
      call('admin_list_users').then(function (d) {
        A.users = d.users;
        if (listCard.isConnected) { loading.remove(); fillAccountList(listCard); }
      }).catch(function (e) { loading.remove(); listCard.append(h('p', { class: 'form-error', text: e.message })); });
      return;
    }
    fillAccountList(listCard);
  }
  function fillAccountList(listCard) {
    var A = S.admin;
    listCard.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Username', 'Name', 'Role', 'Company', 'Status', 'Last sign-in', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, A.users.map(function (u) {
        var st = !u.is_active ? h('span', { class: 'pill off', text: 'Disabled' })
          : u.locked ? h('span', { class: 'pill warn', text: 'Locked 10 min' })
            : u.must_change_password ? h('span', { class: 'pill warn', text: 'Must set password' })
              : h('span', { class: 'pill on', text: 'Active' });
        return h('tr', null,
          h('td', null, h('strong', { class: 'mono', text: u.username })), h('td', { text: u.full_name || '—' }),
          h('td', { class: 'nowrap' }, ROLE_LABEL[u.role], u.can_assign ? h('div', { class: 'small muted', text: '+ can assign' }) : null,
            u.can_record_cci && u.role !== 'admin' ? h('div', { class: 'small muted', text: '+ records CCI results' }) : null),
          h('td', null, u.company_id ? cchip(u.company_id) : '—'), h('td', null, st),
          h('td', { class: 'nowrap', text: u.last_login_at ? fmtTime(u.last_login_at) : 'Never' }),
          h('td', { class: 'nowrap' }, h('div', { class: 'btn-row nowrap' },
            h('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: function () { editUser(u); } }),
            h('button', { type: 'button', class: 'btn small', text: 'Reset password', onclick: function () { resetPassword(u); } }))));
      })))));
  }

  function showCredentials(title, username, password, mustChange) {
    var link = location.origin + location.pathname;
    var text = 'Solar PV Installation Monitoring\nLink: ' + link + '\nUsername: ' + username + '\nPassword: ' + password +
      (mustChange ? '\n(You will be asked to choose a new password when you sign in.)' : '');
    var pre = h('pre', { class: 'cred', text: text });
    var copyBtn = h('button', { type: 'button', class: 'btn primary', text: 'Copy', onclick: function () { copyText(text, copyBtn); } });
    openModal(title, [
      h('p', { text: 'Send these details to the user privately (for example by direct message). Copy them now: the password is stored only in encrypted form and cannot be shown again.' }),
      pre, h('div', { class: 'btn-row' }, copyBtn, h('button', { type: 'button', class: 'btn', text: 'Done', onclick: closeModal }))]);
  }

  function editUser(u) {
    var fName = h('input', { id: 'e-name', maxlength: 120 }); fName.value = u.full_name || '';
    var fRole = h('select', { id: 'e-role' }, roleOptions(u.role));
    var fCo = h('select', { id: 'e-company' }, companyOptions(u.company_id, true));
    var fAct = h('input', { id: 'e-active', type: 'checkbox', checked: u.is_active });
    var fAsg = h('input', { id: 'e-assign', type: 'checkbox', checked: !!u.can_assign });
    var asgRow = h('label', { class: 'check' }, fAsg, h('span', { text: 'Allow this subcontractor to assign and reassign contractors' }));
    var fCci = h('input', { id: 'e-cci', type: 'checkbox', checked: !!u.can_record_cci });
    var cciRow = h('label', { class: 'check' }, fCci, h('span', { text: 'May record official CCI inspection and approval results' }));
    function syncRole() { asgRow.hidden = fRole.value !== 'subcontractor'; cciRow.hidden = fRole.value !== 'viewer'; }
    fRole.addEventListener('change', syncRole); syncRole();
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save changes' });
    save.addEventListener('click', function () {
      save.disabled = true; err.hidden = true;
      call('admin_update_user', { p_user_id: u.id, p_full_name: fName.value.trim(), p_role: fRole.value, p_company_id: fCo.value ? +fCo.value : null, p_is_active: fAct.checked, p_can_assign: fRole.value === 'subcontractor' && fAsg.checked })
        .then(function () { return fRole.value === 'viewer' || u.can_record_cci ? call('admin_set_cci_permission', { p_user_id: u.id, p_allowed: fRole.value === 'viewer' && fCci.checked }) : null; })
        .then(function () { closeModal(); toast('Account ' + u.username + ' updated.', 'ok'); S.admin.users = null; renderAdmin(true); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Edit ' + u.username, [
      h('div', { class: 'field' }, h('label', { for: 'e-name', text: 'Full name' }), fName),
      h('div', { class: 'field' }, h('label', { for: 'e-role', text: 'Role' }), fRole),
      h('div', { class: 'field' }, h('label', { for: 'e-company', text: 'Company' }), fCo),
      asgRow, cciRow,
      h('label', { class: 'check' }, fAct, h('span', { text: 'Account active (untick to block sign-in; this also signs the user out)' })),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function resetPassword(u) {
    var fPw = h('input', { id: 'r-pass', type: 'text', maxlength: 72, autocomplete: 'off', spellcheck: 'false' }); fPw.value = genPassword();
    var fReq = h('input', { id: 'r-req', type: 'checkbox' });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Set password' });
    save.addEventListener('click', function () {
      save.disabled = true; err.hidden = true;
      var pw = fPw.value;
      call('admin_set_password', { p_user_id: u.id, p_new_password: pw, p_require_change: fReq.checked })
        .then(function () { S.admin.users = null; showCredentials('New password for ' + u.username, u.username, pw, fReq.checked); renderAdmin(true); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Reset password · ' + u.username, [
      h('p', { text: 'The user is signed out on all devices and must use the new password.' }),
      h('div', { class: 'field' }, h('label', { for: 'r-pass', text: 'New password' }),
        h('div', { class: 'pw-wrap' }, fPw, h('button', { type: 'button', class: 'pw-toggle', text: 'New', 'aria-label': 'Generate a new password', onclick: function () { fPw.value = genPassword(); } }))),
      h('label', { class: 'check' }, fReq, h('span', { text: 'Ask the user to choose their own password at next sign-in' })),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function renderCompanies(body) {
    var fName = h('input', { id: 'c-name', maxlength: 120, autocomplete: 'off', placeholder: 'Company name as it should appear' });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var btn = h('button', { type: 'submit', class: 'btn primary', text: 'Add company' });
    var form = h('form', { class: 'card', novalidate: true }, h('h2', { text: 'Add a contractor or subcontractor' }),
      h('p', { class: 'card-sub', text: 'Each company gets its own colour for the Contractors view. You can change it with Edit.' }),
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'c-name', text: 'Company name' }), fName), h('div', null, btn)), err);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      call('admin_save_company', { p_company_id: null, p_name: fName.value, p_is_active: true, p_color: null })
        .then(function () { toast('Company added.', 'ok'); return loadBootstrap(); })
        .then(function () { renderAdmin(); })
        .catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; });
    });
    body.append(form);
    var use = new Map();
    S.assign.forEach(function (a) {
      var s = S.sections.get(a.section_id); if (!s || !counted(s)) return;
      var u = use.get(a.company_id) || { mounting: 0, module: 0 };
      u[a.activity]++; use.set(a.company_id, u);
    });
    var card = h('div', { class: 'card' }, h('h2', { text: 'Companies' }));
    if (!S.companies.length) card.append(h('div', { class: 'empty-state', text: 'No companies yet. Add the first one above.' }));
    else card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Company', 'Status', 'Mounting Structure sections', 'PV Module sections', ''].map(function (x, i) { return h('th', { class: i === 2 || i === 3 ? 'num' : null, text: x }); }))),
      h('tbody', null, S.companies.map(function (c) {
        var u = use.get(c.id) || { mounting: 0, module: 0 };
        return h('tr', null, h('td', null, cchip(c.id)),
          h('td', null, h('span', { class: 'pill ' + (c.is_active ? 'on' : 'off'), text: c.is_active ? 'Active' : 'Inactive' })),
          h('td', { class: 'num', text: String(u.mounting) }),
          h('td', { class: 'num', text: String(u.module) }),
          h('td', { class: 'nowrap' }, h('div', { class: 'btn-row nowrap' },
            h('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: function () { editCompany(c); } }),
            h('button', {
              type: 'button', class: 'btn small' + (c.is_active ? ' danger' : ''), text: c.is_active ? 'Deactivate' : 'Activate',
              onclick: function () { saveCompany(c, c.name, !c.is_active, c.color); }
            }))));
      })))));
    card.append(h('p', { class: 'hint', text: 'A company with assigned sections (for either activity) cannot be deactivated until they are reassigned. Past records stay unchanged. Every active company has its own colour.' }));
    body.append(card);
  }
  function saveCompany(c, name, active, color) {
    return call('admin_save_company', { p_company_id: c.id, p_name: name, p_is_active: active, p_color: color })
      .then(function () { toast('Company saved.', 'ok'); return loadBootstrap(); })
      .then(function () { closeModal(); renderAdmin(); })
      .catch(function (e) { toast(e.message, 'err', 8000); throw e; });
  }
  function editCompany(c) {
    var f = h('input', { id: 'rc-name', maxlength: 120 }); f.value = c.name;
    var chosen = (c.color || '').toLowerCase();
    var pal = h('div', { class: 'palette', role: 'group', 'aria-label': 'Colour' });
    var colours = PALETTE.slice();
    if (chosen && colours.indexOf(chosen) < 0) colours.push(chosen); // keep a colour from an older palette selectable
    function drawPal() {
      pal.textContent = '';
      colours.forEach(function (col) {
        var used = S.companies.filter(function (x) { return x.id !== c.id && x.is_active && (x.color || '').toLowerCase() === col; }).map(function (x) { return x.name; });
        pal.append(h('button', {
          type: 'button', color: col, 'aria-pressed': String(chosen === col), disabled: used.length > 0 && c.is_active,
          'aria-label': col + (used.length ? ' (used by ' + used.join(', ') + ')' : ''), title: used.length ? 'Used by ' + used.join(', ') : 'Free',
          onclick: function () { chosen = col; drawPal(); }
        }));
      });
    }
    drawPal();
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save' });
    save.addEventListener('click', function () { save.disabled = true; saveCompany(c, f.value, c.is_active, chosen).catch(function () { save.disabled = false; }); });
    openModal('Edit company', [h('div', { class: 'field' }, h('label', { for: 'rc-name', text: 'Company name' }), f),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Colour on the keyplan (Contractors view)' }), pal,
        h('p', { class: 'hint', text: 'Colours used by another active company are greyed out, so each contractor stays easy to tell apart in both activities.' })),
      h('p', { class: 'hint', text: 'A new name is shown everywhere, including earlier records by this company.' }),
      h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function renderAssignments(body, refetch) {
    var A = S.admin, F = A.afilter;
    var all = allSections();
    // summary: sections per contractor, per activity and block
    var summary = new Map(), un = { mounting: { 1: 0, 5: 0 }, module: { 1: 0, 5: 0 } };
    all.forEach(function (s) {
      if (!counted(s)) return; // same sections as the dashboard: with an ID and in monitoring
      ACTS.forEach(function (act) {
        var a = asgOf(s.id, act);
        if (!a) { un[act][s.block]++; return; }
        var r = summary.get(a.company_id) || { mounting: { 1: 0, 5: 0 }, module: { 1: 0, 5: 0 }, areas: new Set() };
        r[act][s.block]++; if (a.area) r.areas.add(a.area);
        summary.set(a.company_id, r);
      });
    });
    function nums(r) {
      return [h('td', { class: 'num grp-start', text: String(r.mounting[1]) }), h('td', { class: 'num', text: String(r.mounting[5]) }),
        h('td', { class: 'num grp-start', text: String(r.module[1]) }), h('td', { class: 'num', text: String(r.module[5]) })];
    }
    var sumBody = h('tbody');
    Array.from(summary.keys()).sort(function (x, y) { return companyName(x).localeCompare(companyName(y)); }).forEach(function (cid) {
      var r = summary.get(cid);
      sumBody.append(h('tr', { 'data-company': String(cid) }, h('td', null, cchip(cid)), nums(r),
        h('td', { class: 'small', text: Array.from(r.areas).sort().join(', ') || '—' }),
        h('td', { class: 'nowrap' }, h('button', { type: 'button', class: 'btn small', text: 'Show on keyplan', onclick: function () { showCompanyOnKeyplan(cid); } }))));
    });
    sumBody.append(h('tr', { 'data-company': 'none' }, h('td', null, cchip(null)), nums(un), h('td', { text: '' }), h('td', { text: '' })));
    body.append(h('div', { class: 'card' }, h('h2', { text: 'Assignments by contractor' }),
      h('p', { class: 'card-sub', text: 'Each activity is assigned separately: a section can have one contractor for Mounting Structure and another for PV Module. To assign, open the keyplan Contractors view, choose the activity, then tap sections or draw an area.' }),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn primary small', text: 'Open the Contractors view', onclick: function () { S.highlight = null; setPage('keyplan'); setDisp('assign'); setPick('area'); } }),
        h('button', { type: 'button', class: 'btn small', text: 'Download assignments (CSV)', onclick: exportAssignments })),
      h('div', { class: 'table-wrap' }, h('table', { class: 'dtable co-table', id: 'asg-summary' },
        h('thead', null,
          h('tr', null, h('th', { rowspan: 2, text: 'Contractor' }), h('th', { colspan: 2, class: 'grp', text: 'Mounting Structure' }),
            h('th', { colspan: 2, class: 'grp', text: 'PV Module' }), h('th', { rowspan: 2, text: 'Areas' }), h('th', { rowspan: 2, text: '' })),
          h('tr', null, ['Block 1', 'Block 5', 'Block 1', 'Block 5'].map(function (x, i) { return h('th', { class: 'num' + (i % 2 === 0 ? ' grp-start' : ''), text: x }); }))),
        sumBody))));

    // list with filters: one row per section and activity
    var areas = areaNames();
    function fsel(id, label, val, opts, key) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { F[key] = e.target.value; F.page = 0; renderAdmin(); } },
          opts.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(val) === String(o[0]) }); })));
    }
    var acts = F.act === 'all' ? ACTS : [F.act];
    var rows = [];
    all.slice().sort(cmpSec).forEach(function (s) {
      if (F.block !== 'all' && String(s.block) !== F.block) return;
      acts.forEach(function (act) {
        var a = asgOf(s.id, act);
        if (F.company === 'none') { if (a) return; } else if (F.company !== 'all' && (!a || String(a.company_id) !== F.company)) return;
        if (F.area !== 'all' && (!a || a.area !== F.area)) return;
        rows.push({ s: s, act: act, a: a });
      });
    });
    var per = 50, pages = Math.max(1, Math.ceil(rows.length / per));
    if (F.page >= pages) F.page = pages - 1;
    var lb = h('tbody');
    rows.slice(F.page * per, F.page * per + per).forEach(function (r) {
      var a = r.a;
      lb.append(h('tr', null,
        h('td', null, h('button', { type: 'button', class: 'link-btn tid', text: secLabel(r.s), onclick: function () { locate(r.s, r.act, 'assign'); } })),
        h('td', { class: 'nowrap', text: 'Block ' + r.s.block }), h('td', { class: 'nowrap', text: ACT_SHORT[r.act] }), h('td', null, cchip(a && a.company_id)),
        h('td', { text: a && a.area ? a.area : '—' }), h('td', { class: 'nowrap', text: a ? a.assigned_by_name : '—' }),
        h('td', { class: 'nowrap', text: a ? fmtTime(a.assigned_at) : '—' })));
    });
    var listCard = h('div', { class: 'card' }, h('h2', { text: 'Sections and activities' }),
      h('div', { class: 'filters' },
        fsel('af-block', 'Block', F.block, [['all', 'Both blocks'], ['1', 'Block 1'], ['5', 'Block 5']], 'block'),
        fsel('af-act', 'Activity', F.act, [['all', 'Both activities'], ['mounting', ACT_SHORT.mounting], ['module', ACT_SHORT.module]], 'act'),
        fsel('af-company', 'Contractor', F.company, [['all', 'All'], ['none', 'Unassigned']].concat(S.companies.map(function (c) { return [String(c.id), c.name]; })), 'company'),
        fsel('af-area', 'Area', F.area, [['all', 'All areas']].concat(areas.map(function (a) { return [a, a]; })), 'area')),
      h('p', { class: 'small muted list-count', text: rows.length + ' section-activit' + (rows.length === 1 ? 'y' : 'ies') }));
    if (rows.length) {
      listCard.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable', id: 'asg-list' },
        h('thead', null, h('tr', null, ['Section ID', 'Block', 'Activity', 'Contractor', 'Area', 'Assigned by', 'Assigned on'].map(function (x) { return h('th', { text: x }); }))), lb)));
      if (pages > 1) listCard.append(h('div', { class: 'pager' }, h('span', { text: 'Page ' + (F.page + 1) + ' of ' + pages }),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn small', text: '← Previous', disabled: F.page === 0, onclick: function () { F.page--; renderAdmin(); } }),
          h('button', { type: 'button', class: 'btn small', text: 'Next →', disabled: F.page >= pages - 1, onclick: function () { F.page++; renderAdmin(); } }))));
    }
    body.append(listCard);

    var logCard = h('div', { class: 'card' }, h('h2', { text: 'Assignment changes' }),
      h('p', { class: 'card-sub', text: 'Every assignment, reassignment and unassignment, with the activity, the previous contractor, the administrator and the date. Newest first.' }));
    body.append(logCard);
    if (refetch || !A.log) {
      logCard.append(h('p', { class: 'small muted', text: 'Loading…' }));
      call('get_assignment_log', { p_limit: 100 }).then(function (d) { A.log = d.batches; if (S.page === 'admin' && A.tab === 'assignments') renderAdmin(false); })
        .catch(function (e) { logCard.append(h('p', { class: 'form-error', text: e.message })); });
      return;
    }
    if (!A.log.length) { logCard.append(h('div', { class: 'empty-state', text: 'No assignments made yet.' })); return; }
    logCard.append(h('ul', { class: 'asg-log', id: 'asg-log' }, A.log.map(function (b) {
      var prev = Object.keys(b.prev || {}).map(function (k) { return k + ': ' + b.prev[k]; }).join(' · ');
      return h('li', { 'data-act': b.activity || 'both' },
        h('div', { class: 'sibling' }, h('strong', { text: fmtTime(b.at) }), h('span', { text: '· by ' + b.username }),
          h('span', { class: 'pill act', text: b.activity ? ACT_SHORT[b.activity] : 'Both activities (before update 3)' })),
        h('div', { class: 'sibling' }, h('span', { text: (b.new_company_id ? 'Assigned ' : 'Unassigned ') + plural(b.count, 'section') + (b.new_company_id ? ' to' : '') }),
          b.new_company_id ? cchip(b.new_company_id) : null, b.new_area ? h('span', { class: 'small', text: '· area: ' + b.new_area }) : null),
        h('div', { class: 'small muted', text: 'Before: ' + prev }),
        h('div', { class: 'sel-list', text: (b.codes || []).join(', ') + (b.count > (b.codes || []).length ? ' …' : '') }));
    })));
  }
  // Highlight one contractor's sections on the keyplan (Contractors view). The highlight
  // follows the activity selector, so both of its scopes can be checked.
  function showCompanyOnKeyplan(cid) {
    var cnt = { mounting: { 1: 0, 5: 0 }, module: { 1: 0, 5: 0 } };
    S.assign.forEach(function (a) { if (a.company_id === cid) { var s = S.sections.get(a.section_id); if (s) cnt[a.activity][s.block]++; } });
    var act = S.act;
    if (!cnt[act][1] && !cnt[act][5] && (cnt[otherAct(act)][1] || cnt[otherAct(act)][5])) act = otherAct(act);
    S.highlight = { cid: cid };
    setPage('keyplan'); setDisp('assign'); setAct(act);
    var ob = S.block === 1 ? 5 : 1;
    if (!cnt[act][S.block] && cnt[act][ob]) setBlock(ob); else paintStatuses();
    toast('Showing ' + companyName(cid) + ' · ' + ACT_SHORT[act] + '. Switch the activity to see its other scope. Show all clears it.', 'ok', 6000);
    renderPanel();
  }

  function renderReview(body) {
    var A = S.admin;
    var items = [];
    S.tables.forEach(function (t) {
      if ((t.flags && t.flags.length) || !t.is_active || t.review_status !== 'none') items.push({ kind: 'table', t: t });
    });
    S.sections.forEach(function (s) {
      if ((s.flags && s.flags.length) || s.review_status !== 'none') items.push({ kind: 'section', s: s, t: parentOf(s) });
    });
    var list = items.filter(function (it) { var x = it.kind === 'table' ? it.t : it.s; return A.reviewAll || x.review_status === 'open'; });
    var toggle = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: A.reviewAll, onchange: function (e) { A.reviewAll = e.target.checked; renderAdmin(); } }),
      h('span', { text: 'Also show items already marked as checked' }));
    var card = h('div', { class: 'card' }, h('h2', { text: 'Drawing items to review' }),
      h('p', { class: 'card-sub', text: 'Found while reading “BLOCK 1 AND BLOCK 5 - KEYPLAN.dwg” and splitting each table into West and East sections. Nothing was guessed: sections without an ID stay out of all counts until you resolve them.' }),
      toggle);
    if (!list.length) card.append(h('div', { class: 'empty-state', text: 'Nothing open for review.' }));
    else card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Block', 'Table / section', 'Issue', 'Details', 'Review', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, list.sort(function (x, y) { return x.t.block - y.t.block || cmpCode(x.t.code || 'zzz', y.t.code || 'zzz'); }).map(function (it) {
        var x = it.kind === 'table' ? it.t : it.s;
        var firstSec = it.kind === 'table' ? S.sections.get(it.t.sections[0]) : it.s;
        return h('tr', null, h('td', { class: 'nowrap', text: 'Block ' + it.t.block }),
          h('td', null, h('strong', { class: 'tid', text: it.kind === 'table' ? (it.t.code || 'NO ID') + ' (table)' : secLabel(it.s) + ' (section)' })),
          h('td', null, (x.flags || []).map(function (f) { return h('div', { text: FLAG_LABEL[f] || f }); }), !x.is_active ? h('div', { text: 'Excluded from monitoring' }) : null),
          h('td', { class: 'small', text: [x.flag_notes, x.review_note ? 'Review note: ' + x.review_note : ''].filter(Boolean).join(' ') }),
          h('td', null, h('span', { class: 'pill ' + (x.review_status === 'resolved' ? 'on' : 'warn'), text: x.review_status === 'resolved' ? 'Checked' : x.review_status === 'open' ? 'Open' : 'None' })),
          h('td', { class: 'nowrap' }, h('div', { class: 'btn-row nowrap' },
            firstSec ? h('button', { type: 'button', class: 'btn small', text: 'Locate', onclick: function () { locate(firstSec); } }) : null,
            h('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: function () { if (it.kind === 'table') openTableEditor(it.t); else openSectionEditor(it.s); } }))));
      })))));
    body.append(card);
  }

  function openTableEditor(t) {
    if (!t) return;
    var fCode = h('input', { id: 't-code', maxlength: 40, autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Leave empty if unknown' }); fCode.value = t.code || '';
    var fRev = h('select', { id: 't-review' },
      h('option', { value: 'none', text: 'No review needed', selected: t.review_status === 'none' }),
      h('option', { value: 'open', text: 'Open – needs checking', selected: t.review_status === 'open' }),
      h('option', { value: 'resolved', text: 'Checked', selected: t.review_status === 'resolved' }));
    var fNote = h('textarea', { id: 't-note', maxlength: 500 }); fNote.value = t.review_note || '';
    var fAct = h('input', { id: 't-active', type: 'checkbox', checked: t.is_active });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save table info' });
    save.addEventListener('click', function () {
      save.disabled = true; err.hidden = true;
      call('admin_update_table', { p_table_id: t.id, p_code: fCode.value.trim(), p_review_status: fRev.value, p_review_note: fNote.value.trim(), p_is_active: fAct.checked })
        .then(function () { return loadBootstrap(); })
        .then(function () { closeModal(); toast('Table info saved.', 'ok'); refreshAll(); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    var flagsTxt = (t.flags || []).map(function (f) { return FLAG_LABEL[f] || f; }).join(' · ');
    openModal('Table info · ' + (t.code || 'table without ID'), [
      h('p', { class: 'small muted', text: 'Block ' + t.block + ' · DWG object handles ' + String(t.dwg_ref || '').replace(/\+/g, ' + ') }),
      flagsTxt ? h('div', { class: 'notice warn' }, h('strong', { text: flagsTxt }), t.flag_notes || '') : null,
      h('div', { class: 'field' }, h('label', { for: 't-code', text: 'Table ID (exactly as on the drawing)' }), fCode,
        h('p', { class: 'hint', text: 'Its sections become this ID + W and this ID + E. Earlier records keep the ID they were saved with.' })),
      h('div', { class: 'field' }, h('label', { for: 't-review', text: 'Review status' }), fRev),
      h('div', { class: 'field' }, h('label', { for: 't-note', text: 'Review note' }), fNote),
      h('label', { class: 'check' }, fAct, h('span', { text: 'Include both sections of this table in monitoring and counts' })),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function openSectionEditor(s) {
    var p = parentOf(s);
    var fSide = h('select', { id: 's-side' },
      h('option', { value: '', text: 'Not confirmed (no section ID)', selected: !s.side }),
      h('option', { value: 'W', text: 'West (W)', selected: s.side === 'W' }),
      h('option', { value: 'E', text: 'East (E)', selected: s.side === 'E' }));
    var fRev = h('select', { id: 's-review' },
      h('option', { value: 'none', text: 'No review needed', selected: s.review_status === 'none' }),
      h('option', { value: 'open', text: 'Open – needs checking', selected: s.review_status === 'open' }),
      h('option', { value: 'resolved', text: 'Checked', selected: s.review_status === 'resolved' }));
    var fNote = h('textarea', { id: 's-note', maxlength: 500 }); fNote.value = s.review_note || '';
    var fAct = h('input', { id: 's-active', type: 'checkbox', checked: s.is_active });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save section' });
    save.addEventListener('click', function () {
      save.disabled = true; err.hidden = true;
      call('admin_update_section', { p_section_id: s.id, p_side: fSide.value, p_review_status: fRev.value, p_review_note: fNote.value.trim(), p_is_active: fAct.checked })
        .then(function () { return loadBootstrap(); })
        .then(function () { closeModal(); toast('Section saved.', 'ok'); refreshAll(); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Section · ' + secLabel(s), [
      h('p', { class: 'small muted', text: 'Table ' + (p.code || '(no ID)') + ' · Block ' + s.block + ' · DWG object handle ' + s.dwg_ref }),
      s.flag_notes ? h('div', { class: 'notice warn', text: s.flag_notes }) : null,
      h('div', { class: 'field' }, h('label', { for: 's-side', text: 'Side' }), fSide,
        h('p', { class: 'hint', text: 'Only change this after checking the drawing or the site. The section ID becomes the table ID + W or E.' })),
      h('div', { class: 'field' }, h('label', { for: 's-review', text: 'Review status' }), fRev),
      h('div', { class: 'field' }, h('label', { for: 's-note', text: 'Review note' }), fNote),
      h('label', { class: 'check' }, fAct, h('span', { text: 'Include this section in monitoring and counts' })),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  // ------------------------------------------------------------------
  // Modal, toast, help, password
  // ------------------------------------------------------------------
  var lastFocus = null;
  function openModal(title, nodes) {
    lastFocus = document.activeElement;
    $('#modal-title').textContent = title;
    var b = $('#modal-body'); b.textContent = ''; append(b, nodes);
    $('#modal').hidden = false;
    var first = b.querySelector('input, select, textarea, button'); if (first) first.focus();
  }
  function closeModal() {
    $('#modal').hidden = true; $('#modal-body').textContent = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  var toastTimer = null;
  function toast(msg, kind, ms) {
    var el = $('#toast'); el.textContent = msg; el.className = 'toast ' + (kind || ''); el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, ms || 4500);
  }
  function showHelp() {
    openModal('How to use the keyplan', [
      h('p', { class: 'small', text: 'Every table is split into a West (W, left) and an East (E, right) section, for example M01-R02-T20W and M01-R02-T20E. Each section has, for each activity, its own contractor, status and history.' }),
      h('ol', { class: 'steps' },
        h('li', { text: 'Choose Block 1 or Block 5 at the top.' }),
        h('li', { text: 'Choose what the colours show: Contractors (who is responsible) or Status (progress), and the activity: Mounting Structure or PV Module.' }),
        h('li', { text: 'Find the section: zoom in (pinch or scroll) and tap it, or type its ID in the search box. Tapping only selects it; nothing is saved.' }),
        h('li', { text: 'Press Update status on the activity card and choose the new status. The contractor comes from that activity\'s assignment. Add a remark if needed.' }),
        h('li', { text: 'Press Review update, check the summary, then press Confirm and save. Wait for the green “Saved” message.' })),
      h('div', { class: 'summary-grid' }, ST.map(function (s) {
        var d = { not_started: 'Work not started (or nothing recorded yet)', ongoing: 'Work in progress', completed: 'Work finished', on_hold: 'Work stopped or waiting' }[s];
        return [h('span', { class: 'sw s-' + s }), h('strong', { text: ST_LABEL[s] }), h('span', { class: 'small muted', text: d })];
      })),
      h('p', { class: 'small', text: 'Subcontractors can update only the sections and the activity assigned to their company: a Mounting Structure assignment does not allow PV Module updates, and the other way round. Use the My scope button to fade everything else. West and East are tracked separately: completing one does not change the other.' }),
      h('p', { class: 'small', text: 'Every save records your username, the contractor and the server date and time. Earlier statuses stay in the history, also when a section is reassigned.' })]);
  }
  function openChangePassword() {
    var fCur = h('input', { id: 'cp-cur', type: 'password', autocomplete: 'current-password', maxlength: 100 });
    var fNew = h('input', { id: 'cp-new', type: 'password', autocomplete: 'new-password', maxlength: 72 });
    var fCon = h('input', { id: 'cp-con', type: 'password', autocomplete: 'new-password', maxlength: 72 });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Change password' });
    save.addEventListener('click', function () {
      err.hidden = true;
      if (fNew.value !== fCon.value) { err.textContent = 'The two new passwords do not match.'; err.hidden = false; return; }
      save.disabled = true;
      call('change_password', { p_current_password: fCur.value, p_new_password: fNew.value })
        .then(function (d) { applyUser(d.user); closeModal(); toast('Password changed. Your other devices were signed out.', 'ok'); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Change my password', [
      h('div', { class: 'field' }, h('label', { for: 'cp-cur', text: 'Current password' }), fCur),
      h('div', { class: 'field' }, h('label', { for: 'cp-new', text: 'New password (at least 8 characters)' }), fNew),
      h('div', { class: 'field' }, h('label', { for: 'cp-con', text: 'Type the new password again' }), fCon),
      err, h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }
  function logout() {
    var tok = S.token;
    stopPolling();
    S.token = null; S.user = null; store.set(LS_TOKEN, null);
    resetScreenState();
    if (tok) rpc('logout', { p_token: tok }).catch(function () { /* already invalid */ });
    $('#user-pop').hidden = true;
    showLogin();
    toast('You are logged out.', 'ok');
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wire() {
    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var u = $('#login-user').value.trim(), p = $('#login-pass').value, err = $('#login-error'), btn = $('#login-btn');
      err.hidden = true;
      if (!u || !p) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Signing in…';
      rpc('login', { p_username: u, p_password: p }).then(function (d) {
        if (!d || !d.ok) { err.textContent = (d && d.message) || 'Sign in failed.'; err.hidden = false; return; }
        S.token = d.token; store.set(LS_TOKEN, d.token); S.user = d.user;
        $('#login-pass').value = '';
        if (d.user.must_change_password) { showPasswordScreen(true); return; }
        return loadBootstrap().then(function () { S.page = 'keyplan'; afterLogin(); showApp(); });
      }).catch(function (e2) {
        err.textContent = e2.message; err.hidden = false;
      }).then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
    });
    $$('.pw-toggle[data-for]').forEach(function (b) {
      b.addEventListener('click', function () {
        var inp = $('#' + b.dataset.for), show = inp.type === 'password';
        inp.type = show ? 'text' : 'password'; b.textContent = show ? 'Hide' : 'Show';
        b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      });
    });
    $('#pw-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var cur = $('#pw-current').value, nw = $('#pw-new').value, con = $('#pw-confirm').value, err = $('#pw-error'), btn = $('#pw-btn');
      err.hidden = true;
      if (nw !== con) { err.textContent = 'The two new passwords do not match.'; err.hidden = false; return; }
      btn.disabled = true;
      rpc('change_password', { p_token: S.token, p_current_password: cur, p_new_password: nw })
        .then(function (d) { S.user = d.user; return loadBootstrap(); })
        .then(function () { toast('Password saved.', 'ok'); afterLogin(); showApp(); })
        .catch(function (e2) {
          if (e2.hint === 'session') { signedOut(e2.message); return; }
          err.textContent = e2.message; err.hidden = false;
        })
        .then(function () { btn.disabled = false; });
    });
    $('#pw-logout').addEventListener('click', logout);
    $$('.tab').forEach(function (b) { b.addEventListener('click', function () { if (b.dataset.view !== 'keyplan') S.highlight = null; setPage(b.dataset.view); }); });
    $$('#seg-block button').forEach(function (b) { b.addEventListener('click', function () { setBlock(+b.dataset.block); }); });
    $$('#seg-view button').forEach(function (b) { b.addEventListener('click', function () { setDisp(b.dataset.disp); }); });
    $$('#seg-act button').forEach(function (b) { b.addEventListener('click', function () { setAct(b.dataset.act); if (isSub() && S.scopeOnly && S.page === 'keyplan') fitScope(true); }); });
    $('#btn-scope').addEventListener('click', function () {
      S.scopeOnly = !S.scopeOnly; renderToolbar(); paintStatuses(); renderPanel();
      if (S.scopeOnly) fitScope(true);
    });
    var ub = $('#user-btn'), pop = $('#user-pop');
    ub.addEventListener('click', function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; ub.setAttribute('aria-expanded', String(!pop.hidden)); });
    document.addEventListener('click', function (e) { if (!pop.hidden && !pop.contains(e.target)) { pop.hidden = true; ub.setAttribute('aria-expanded', 'false'); } });
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-help').addEventListener('click', function () { pop.hidden = true; showHelp(); });
    $('#btn-change-pw').addEventListener('click', function () { pop.hidden = true; openChangePassword(); });
    $('#modal-close').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && S.user) poll(true); });
    window.addEventListener('online', function () { if (S.user) poll(true); });
    wireCanvas();
    wireSearch();
  }
})();
