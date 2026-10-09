/* Solar PV Installation Monitoring — browser client.
   Talks only to the database functions (Supabase RPC). No other services. */
(function () {
  'use strict';

  var CFG = window.PVM_CONFIG || {};
  var ACT = { mounting: 'Mounting Structure Installation', module: 'PV Module Installation' };
  var ACT_SHORT = { mounting: 'Mounting Structure', module: 'PV Module' };
  var ACTS = ['mounting', 'module'];
  var ST = ['not_started', 'ongoing', 'completed', 'on_hold'];
  var ST_LABEL = { not_started: 'Not Started', ongoing: 'Ongoing', completed: 'Completed', on_hold: 'On Hold' };
  var ROLE_LABEL = { admin: 'Administrator', subcontractor: 'Subcontractor', viewer: 'Viewer (read only)' };
  var FLAG_LABEL = {
    no_id: 'No table ID in drawing',
    id_format: 'ID written differently',
    duplicate_label: 'Drawn twice in DWG',
    half_outline: 'Half-width outline'
  };
  var BLOCKS = [1, 5];
  var POLL_MS = 20000;
  var LS_TOKEN = 'pvm.token';
  var LS_PREFS = 'pvm.prefs';
  var SVGNS = 'http://www.w3.org/2000/svg';

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

  // ------------------------------------------------------------------
  // API
  // ------------------------------------------------------------------
  function ApiError(message, hint, status) {
    var e = new Error(message); e.hint = hint || null; e.status = status || 0; return e;
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
            throw ApiError(msg, data && data.hint, res.status);
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
    token: null, user: null, kp: {}, tables: new Map(), byBlock: { 1: [], 5: [] }, companies: [],
    cur: new Map(), history: new Map(), metaVersion: 0, serverTime: null,
    block: 1, act: 'mounting', view: 'keyplan', selected: null, mode: 'details', form: null,
    highlight: null, pollTimer: null, polling: false, lastSync: null,
    dash: { block: 'all', act: 'all', status: 'all', company: 'all', page: 0 },
    admin: { tab: 'accounts', users: null, reviewAll: false }
  };
  function curOf(tableId, act) { return S.cur.get(tableId + '|' + act) || null; }
  function statusOf(tableId, act) { var u = curOf(tableId, act); return u ? u.status : 'not_started'; }
  function canEdit() { return S.user && (S.user.role === 'admin' || S.user.role === 'subcontractor'); }
  function isAdmin() { return S.user && S.user.role === 'admin'; }
  function activeCompanies() { return S.companies.filter(function (c) { return c.is_active; }); }
  function companyName(id) { var c = S.companies.find(function (x) { return x.id === id; }); return c ? c.name : ''; }
  function counted(t) { return !!t.code && t.is_active; }

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
  function signedOut(message) {
    S.token = null; S.user = null; store.set(LS_TOKEN, null);
    closeModal();
    showLogin(message || 'You have been logged out.');
  }
  function showApp() {
    showOnly('screen-app');
    setView(S.view || 'keyplan', true);
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
    if (ACTS.indexOf(p.act) >= 0) S.act = p.act;
    var tok = store.get(LS_TOKEN);
    if (!tok) { showLogin(); return; }
    S.token = tok;
    loadBootstrap().then(function () { showApp(); }).catch(function (e) {
      if (e.hint === 'password') return showPasswordScreen(true);
      if (e.hint === 'session') { store.set(LS_TOKEN, null); S.token = null; return showLogin(); }
      showLogin(e.message);
    });
  }

  function loadBootstrap() {
    return rpc('get_bootstrap', { p_token: S.token }).then(function (d) {
      S.kp = {};
      d.keyplans.forEach(function (k) { S.kp[k.block] = k; });
      S.tables = new Map(); S.byBlock = { 1: [], 5: [] };
      d.tables.forEach(function (t) {
        S.tables.set(t.id, t);
        (S.byBlock[t.block] = S.byBlock[t.block] || []).push(t);
      });
      S.companies = d.companies || [];
      S.cur = new Map();
      d.current.forEach(function (u) { S.cur.set(u.table_id + '|' + u.activity, u); });
      S.history = new Map();
      S.metaVersion = d.meta_version;
      S.serverTime = d.server_time;
      S.lastSync = new Date();
      if (S.selected && !S.tables.has(S.selected)) { S.selected = null; S.mode = 'details'; }
      applyUser(d.user);
      KP.block = null; // force rebuild
    });
  }

  function applyUser(u) {
    var prevRole = S.user && S.user.role;
    S.user = u;
    $('#user-name').textContent = u.full_name || u.username;
    $('#user-avatar').textContent = initials(u);
    $('#user-pop-name').textContent = userLabel(u);
    $('#user-pop-role').textContent = ROLE_LABEL[u.role] + (u.company_name ? ' · ' + u.company_name : '');
    $('#tab-admin').hidden = u.role !== 'admin';
    if (prevRole && prevRole !== u.role) {
      if (S.view === 'admin' && u.role !== 'admin') setView('keyplan');
      if (!canEdit() && S.mode !== 'details') { S.mode = 'details'; }
      renderPanel();
    }
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  function setView(v, force) {
    if (v === 'admin' && !isAdmin()) v = 'keyplan';
    var changed = v !== S.view;
    S.view = v;
    $$('.tab').forEach(function (b) {
      if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $('#view-keyplan').hidden = v !== 'keyplan';
    $('#view-dashboard').hidden = v !== 'dashboard';
    $('#view-admin').hidden = v !== 'admin';
    if (v === 'keyplan') {
      renderToolbar();
      if (KP.block !== S.block) buildKeyplan(); else { paintStatuses(); requestAnimationFrame(onResize); }
      renderPanel();
    } else if (v === 'dashboard') {
      renderDashboard(changed || force);
    } else if (v === 'admin') {
      renderAdmin(changed || force);
    }
  }

  function renderToolbar() {
    $$('#seg-block button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.block === S.block)); });
    $$('#seg-act button').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.act === S.act)); });
    renderSync();
  }
  function setBlock(b) {
    if (b === S.block) return;
    S.block = b; savePrefs({ block: b });
    var t = S.tables.get(S.selected);
    if (t && t.block !== b) { S.selected = null; S.mode = 'details'; }
    renderToolbar(); buildKeyplan(); renderPanel();
  }
  function setAct(a) {
    if (a === S.act) return;
    S.act = a; savePrefs({ act: a });
    renderToolbar(); paintStatuses(); renderPanel();
  }

  // ------------------------------------------------------------------
  // Keyplan drawing, zoom and pan
  // ------------------------------------------------------------------
  var KP = { svg: null, block: null, groups: new Map(), view: { x: 0, y: 0, w: 100, h: 100 }, upp: null, sel: null, pointers: new Map(), gesture: null, anim: null };

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
    (S.byBlock[S.block] || []).forEach(function (t) {
      var g = svg('g', { class: 't', 'data-id': t.id });
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      t.geom.h.forEach(function (r) {
        g.append(svg('rect', { class: 'h', x: r[0], y: r[1], width: r[2], height: r[3] }));
        x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]);
      });
      g.append(svg('rect', { class: 'hit', x: x0, y: y0, width: x1 - x0, height: y1 - y0 }));
      t._bb = [x0, y0, x1, y1];
      gt.append(g); KP.groups.set(t.id, g);
      var c = t.geom.c;
      var lb = svg('text', { class: 'lbl' + (t.code ? '' : ' noid'), transform: 'translate(' + c[0] + ' ' + c[1] + ') scale(0.1)', 'font-size': t.code ? 13 : 16 });
      lb.textContent = t.code || 'NO ID';
      glb.append(lb);
    });
    el.append(gt, glb);
    KP.sel = svg('g', { class: 'sel-layer' });
    el.append(KP.sel);
    KP.block = S.block;
    paintStatuses();
    var tok = KP.fitToken = {};
    requestAnimationFrame(function () { if (KP.fitToken === tok) fitView(false); });
  }

  function tableClass(t) {
    var c = 't';
    if (!t.code) c += ' noid';
    else if (!t.is_active) c += ' off';
    else c += ' s-' + statusOf(t.id, S.act);
    if (t.id === S.selected) c += ' sel';
    if (S.highlight && !S.highlight.has(t.id)) c += ' dim';
    return c;
  }
  function paintStatuses() {
    (S.byBlock[S.block] || []).forEach(function (t) {
      var g = KP.groups.get(t.id); if (g) g.setAttribute('class', tableClass(t));
    });
    renderTitleblock();
    drawSelMarker();
  }

  function canvasRect() { return KP.svg ? KP.svg.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 }; }
  function setVB(v) {
    KP.view = v;
    var r = canvasRect();
    if (r.width) KP.upp = v.w / r.width;
    KP.svg.setAttribute('viewBox', v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
    var ppu = r.width ? r.width / v.w : 1;
    KP.svg.classList.toggle('show-labels', ppu >= 6.2);
    drawSelMarker(ppu);
  }
  function zoomLimits() {
    var kp = S.kp[S.block]; var r = canvasRect(); var aspect = r.width / Math.max(1, r.height);
    return { min: 12, max: Math.max(+kp.width, +kp.height * aspect) * 2.5 };
  }
  function clampCenter(v) {
    var kp = S.kp[S.block]; if (!kp) return v;
    var cx = v.x + v.w / 2, cy = v.y + v.h / 2;
    var ncx = Math.min(Math.max(cx, 0), +kp.width), ncy = Math.min(Math.max(cy, 0), +kp.height);
    return { x: v.x + (ncx - cx), y: v.y + (ncy - cy), w: v.w, h: v.h };
  }
  function fitView(animate) {
    var kp = S.kp[S.block]; var r = canvasRect();
    if (!kp || !r.width || !r.height) return;
    var W = +kp.width, H = +kp.height;
    // keep the drawing clear of the legend, zoom buttons and phone panel
    var padL = 14, padR = 14, padT = 14, padB = 14;
    if (window.innerWidth > 900) {
      var tb = $('#titleblock').getBoundingClientRect();
      padL = Math.max(padL, tb.width + 24);
      padR = 70;
    } else {
      padR = 58;
      padB = Math.max(padB, panelCover() + 8);
    }
    var availW = Math.max(60, r.width - padL - padR), availH = Math.max(60, r.height - padT - padB);
    var ppu = Math.min(availW / W, availH / H);
    var x = -(padL + (availW - W * ppu) / 2) / ppu, y = -(padT + (availH - H * ppu) / 2) / ppu;
    var v = { x: x, y: y, w: r.width / ppu, h: r.height / ppu };
    if (animate) animateTo(v); else setVB(v);
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
    KP.fitToken = null; // a pending initial fit must not override this move
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
    // height of the bottom sheet covering the canvas on phones
    if (window.innerWidth > 900) return 0;
    var p = $('#panel'); if (!p || p.hidden) return 0;
    return p.getBoundingClientRect().height;
  }
  function zoomToTable(t, animate) {
    if (!t || !t._bb) return;
    var r = canvasRect(); if (!r.width) return;
    var aspect = r.width / r.height;
    var w = Math.max(70, (t._bb[2] - t._bb[0]) * 6), hh = w / aspect;
    var cx = (t._bb[0] + t._bb[2]) / 2, cy = (t._bb[1] + t._bb[3]) / 2;
    var cover = panelCover(), upp = w / r.width;
    var visibleH = Math.max(120, r.height - cover);
    var y = cy - (visibleH / 2) * upp;
    var v = { x: cx - w / 2, y: y, w: w, h: hh };
    KP.fitToken = null;
    if (animate) animateTo(v); else setVB(v);
  }
  function ensureVisible(t) {
    var r = canvasRect(), v = KP.view, bb = t._bb; if (!bb || !r.width) return;
    var cover = panelCover() * (v.h / r.height);
    var inside = bb[0] >= v.x && bb[2] <= v.x + v.w && bb[1] >= v.y && bb[3] <= v.y + v.h - cover;
    if (!inside) zoomToTable(t, true);
  }
  function drawSelMarker(ppu) {
    var L = KP.sel; if (!L) return;
    L.textContent = '';
    var t = S.tables.get(S.selected);
    if (!t || t.block !== S.block || !t._bb) return;
    var r = canvasRect();
    ppu = ppu || (r.width ? r.width / KP.view.w : 1);
    var bb = t._bb, pad = 5 / ppu;
    L.append(svg('rect', { class: 'selring', x: bb[0] - pad, y: bb[1] - pad, width: bb[2] - bb[0] + 2 * pad, height: bb[3] - bb[1] + 2 * pad }));
    if (ppu < 6.2) {
      var text = t.code || 'NO ID', k = 1 / ppu, tw = text.length * 13 * 0.62 + 16, th = 24;
      var cx = (bb[0] + bb[2]) / 2, ty = bb[1] - pad - (th / 2 + 4) * k;
      var g = svg('g', { class: 'seltag', transform: 'translate(' + cx + ' ' + ty + ') scale(' + k + ')' });
      g.append(svg('rect', { x: -tw / 2, y: -th / 2, width: tw, height: th, rx: 4 }));
      var tx = svg('text', { x: 0, y: 0, 'font-size': 13 }); tx.textContent = text;
      g.append(tx); L.append(g);
    }
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
        KP.gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, view: Object.assign({}, KP.view), moved: 0, target: tg };
      } else if (KP.pointers.size === 2) {
        var pts = Array.from(KP.pointers.values());
        KP.gesture = { type: 'pinch', d0: Math.max(10, dist(pts[0], pts[1])), m0: mid(pts[0], pts[1]), view: Object.assign({}, KP.view), moved: 99 };
      }
      hideHint();
    });
    el.addEventListener('pointermove', function (e) {
      if (!KP.pointers.has(e.pointerId)) return;
      KP.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var g = KP.gesture; if (!g) return;
      var r = canvasRect();
      if (g.type === 'pan' && KP.pointers.size === 1) {
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
      if (g && g.type === 'pan' && KP.pointers.size === 0 && g.moved < 6 && e.type === 'pointerup') {
        if (g.target) selectTable(+g.target.getAttribute('data-id'), { source: 'map' });
        else if (S.selected && S.mode === 'details') selectTable(null);
      }
      if (KP.pointers.size === 0) { KP.gesture = null; el.classList.remove('dragging'); }
      else if (KP.pointers.size === 1) {
        var p = Array.from(KP.pointers.values())[0];
        KP.gesture = { type: 'pan', sx: p.x, sy: p.y, view: Object.assign({}, KP.view), moved: 99, target: null };
      }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
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
      else if (e.key === 'ArrowLeft') setVB(clampCenter({ x: v.x - v.w * step, y: v.y, w: v.w, h: v.h }));
      else if (e.key === 'ArrowRight') setVB(clampCenter({ x: v.x + v.w * step, y: v.y, w: v.w, h: v.h }));
      else if (e.key === 'ArrowUp') setVB(clampCenter({ x: v.x, y: v.y - v.h * step, w: v.w, h: v.h }));
      else if (e.key === 'ArrowDown') setVB(clampCenter({ x: v.x, y: v.y + v.h * step, w: v.w, h: v.h }));
      else return;
      e.preventDefault();
    });
    $('#zoom-in').addEventListener('click', function () { zoomCenter(1.6); });
    $('#zoom-out').addEventListener('click', function () { zoomCenter(1 / 1.6); });
    $('#zoom-fit').addEventListener('click', function () { fitView(true); });
    window.addEventListener('resize', function () { requestAnimationFrame(onResize); });
  }
  function hideHint() { var hEl = $('#canvas-hint'); if (hEl) hEl.classList.add('gone'); }

  // Legend drawn like a drawing title block
  function renderTitleblock() {
    var tb = $('#titleblock'); if (!tb) return;
    var list = S.byBlock[S.block] || [];
    var counts = { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 }, total = 0, noid = 0, off = 0;
    list.forEach(function (t) {
      if (!t.code) { noid++; return; }
      if (!t.is_active) { off++; return; }
      total++; counts[statusOf(t.id, S.act)]++;
    });
    tb.textContent = '';
    var head = h('div', { class: 'tb-head' },
      h('div', { class: 'tb-blk', text: 'Block ' + S.block }),
      h('div', { class: 'tnum', text: total + ' tables' }),
      h('div', { class: 'tb-act', text: ACT[S.act] }));
    var rows = h('div', { class: 'tb-rows' });
    ST.forEach(function (st) {
      rows.append(h('div', null, h('span', { class: 'sw s-' + st })), h('div', { text: ST_LABEL[st] }), h('div', { class: 'num', text: String(counts[st]) }));
    });
    if (noid) rows.append(h('div', null, h('span', { class: 'sw noid' })), h('div', { text: 'No ID in drawing' }), h('div', { class: 'num', text: String(noid) }));
    var foot = h('div', { class: 'tb-foot' }, h('span', { text: 'Completed' }), h('strong', { class: 'tnum', text: fmtPct(counts.completed, total) }));
    tb.append(head, rows, foot);
    // phone version: one line under the toolbar, never over the drawing
    var strip = $('#legend-strip');
    if (strip) {
      strip.textContent = '';
      strip.append(h('span', { class: 'ls-title', text: 'B' + S.block + ' · ' + (S.act === 'mounting' ? 'Mounting' : 'PV Module') }));
      ST.forEach(function (st) {
        strip.append(h('span', { class: 'ls-item' }, h('span', { class: 'sw s-' + st }), ST_LABEL[st] + ' ', h('b', { text: String(counts[st]) })));
      });
      if (noid) strip.append(h('span', { class: 'ls-item' }, h('span', { class: 'sw noid' }), 'No ID ', h('b', { text: String(noid) })));
    }
  }

  // ------------------------------------------------------------------
  // Selection and side panel
  // ------------------------------------------------------------------
  function selectTable(id, opts) {
    opts = opts || {};
    if (S.mode !== 'details' && S.selected && id !== S.selected && S.form && S.form.dirty) {
      toast('Finish or cancel the update for ' + (S.tables.get(S.selected).code || 'this table') + ' first.', 'err');
      return;
    }
    var prev = S.selected;
    S.selected = id;
    S.mode = 'details'; S.form = null;
    [prev, id].forEach(function (x) {
      var t = S.tables.get(x), g = KP.groups.get(x);
      if (t && g) g.setAttribute('class', tableClass(t));
    });
    drawSelMarker();
    renderPanel();
    var t = S.tables.get(id);
    if (t) {
      loadHistory(t.id);
      if (opts.zoom) zoomToTable(t, true);
      else if (opts.source === 'map' && window.innerWidth <= 900) requestAnimationFrame(function () { ensureVisible(t); });
    }
  }

  function renderPanel() {
    var P = $('#panel'); if (!P) return;
    P.textContent = '';
    var t = S.tables.get(S.selected);
    P.classList.toggle('collapsed', !t);
    if (!t) { renderPanelSummary(P); return; }
    if (S.mode === 'form') renderForm(P, t);
    else if (S.mode === 'confirm') renderConfirm(P, t);
    else renderDetails(P, t);
  }

  function renderPanelSummary(P) {
    var list = (S.byBlock[S.block] || []).filter(counted);
    var c = { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 };
    list.forEach(function (t) { c[statusOf(t.id, S.act)]++; });
    var mobile = window.innerWidth <= 900;
    if (mobile) {
      P.append(h('p', { class: 'panel-sub' }, h('strong', { text: 'Tap a table' }), ' to see its status' + (canEdit() ? ' and update it.' : '.')));
      return;
    }
    P.append(
      h('div', { class: 'stack' },
        h('div', null, h('h2', { text: 'Block ' + S.block + ' · ' + ACT_SHORT[S.act] }),
          h('p', { class: 'panel-sub', text: list.length + ' tables with an ID in the drawing' })),
        statusBar(c, list.length),
        h('div', { class: 'summary-grid' }, ST.map(function (st) {
          return [h('span', { class: 'sw s-' + st }), h('span', { text: ST_LABEL[st] }), h('span', { class: 'num', text: c[st] + ' · ' + fmtPct(c[st], list.length) })];
        })),
        h('div', { class: 'notice info' },
          h('strong', { text: canEdit() ? 'To update a table' : 'View-only access' }),
          canEdit()
            ? h('ol', { class: 'steps' },
              h('li', { text: 'Choose Block 1 or Block 5 above.' }),
              h('li', { text: 'Tap the table on the keyplan, or type its ID in the search box.' }),
              h('li', { text: 'Press Update status, choose the activity, status and company.' }),
              h('li', { text: 'Check the summary, then press Confirm and save.' }))
            : h('p', { class: 'small', text: 'Tap a table to see its status, responsible company and history.' }))
      ));
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

  function flagNotice(t) {
    if (!t.flags || !t.flags.length) return null;
    if (t.flags.indexOf('no_id') >= 0 && !t.code) {
      return h('div', { class: 'notice err' }, h('strong', { text: 'No table ID in the drawing' }),
        'This outline has no ID in the DWG or the PDF keyplan, so it is not counted and cannot be updated. ' +
        (isAdmin() ? 'You can assign the correct ID with Edit table info.' : 'Ask the administrator to assign its ID.'));
    }
    var label = t.flags.map(function (f) { return FLAG_LABEL[f] || f; }).join(' · ');
    return h('div', { class: 'notice warn' }, h('strong', { text: 'Drawing note: ' + label + (t.review_status === 'resolved' ? ' (checked)' : '') }),
      t.flag_notes || '', t.review_note ? h('div', { class: 'small', text: 'Review: ' + t.review_note }) : null);
  }

  function renderDetails(P, t) {
    var head = h('div', { class: 'panel-head' },
      h('div', null, h('h2', { text: 'Table' }), h('div', { class: 'panel-tid', text: t.code || 'NO ID' }),
        h('p', { class: 'panel-sub', text: 'Block ' + t.block + (t.is_active ? '' : ' · excluded from monitoring') })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', text: '×', onclick: function () { selectTable(null); } }));
    var stack = h('div', { class: 'stack' }, head, flagNotice(t));
    if (t.code) {
      ACTS.forEach(function (a) { stack.append(actCard(t, a)); });
      stack.append(historyBox(t));
    }
    if (isAdmin()) stack.append(h('button', { type: 'button', class: 'btn small', text: 'Edit table info', onclick: function () { openTableEditor(t); } }));
    P.append(stack);
  }

  function actCard(t, a) {
    var u = curOf(t.id, a), st = u ? u.status : 'not_started';
    var card = h('section', { class: 'act-card', 'aria-label': ACT[a] },
      h('h3', { text: ACT[a] }),
      h('div', null, chip(st)));
    if (u) {
      card.append(h('dl', { class: 'kv' },
        h('dt', { text: 'Company' }), h('dd', null, h('strong', { text: u.company_name })),
        h('dt', { text: 'Updated by' }), h('dd', { text: u.full_name ? u.full_name + ' (' + u.username + ')' : u.username }),
        h('dt', { text: 'Date & time' }), h('dd', { text: fmtTime(u.created_at) }),
        u.remarks ? [h('dt', { text: 'Remarks' }), h('dd', { text: u.remarks })] : null));
    } else {
      card.append(h('p', { class: 'small muted', text: 'No update recorded yet.' }));
    }
    if (canEdit() && t.is_active) {
      card.append(h('button', { type: 'button', class: 'btn primary small', text: 'Update status', onclick: function () { openForm(t, a); } }));
    }
    return card;
  }

  function historyBox(t) {
    var hist = S.history.get(t.id);
    var box = h('details', { class: 'hist-box' });
    if (prefs().histOpen) box.open = true;
    box.addEventListener('toggle', function () { savePrefs({ histOpen: box.open }); });
    box.append(h('summary', { text: 'History' + (Array.isArray(hist) ? ' (' + hist.length + ')' : '') }));
    if (hist === undefined || hist === 'loading') box.append(h('p', { class: 'small muted', text: 'Loading history…' }));
    else if (hist === 'error') box.append(h('p', { class: 'small muted', text: 'Could not load the history. It will retry on the next refresh.' }));
    else if (!hist.length) box.append(h('p', { class: 'small muted', text: 'No changes recorded yet.' }));
    else {
      box.append(h('ul', { class: 'hist' }, hist.map(function (u) {
        return h('li', null,
          h('div', { class: 'hist-top' }, h('strong', { text: ACT_SHORT[u.activity] }), chip(u.status)),
          h('div', { class: 'hist-meta', text: fmtTime(u.created_at) + ' · ' + u.company_name + ' · by ' + u.username }),
          u.remarks ? h('div', { class: 'hist-rem', text: u.remarks }) : null);
      })));
    }
    return box;
  }

  function loadHistory(id, force) {
    if (!force && Array.isArray(S.history.get(id))) return;
    S.history.set(id, 'loading');
    call('get_table_history', { p_table_id: id }).then(function (d) {
      S.history.set(id, d.history || []);
    }).catch(function () {
      S.history.set(id, 'error');
    }).then(function () {
      if (S.selected === id && S.mode === 'details') renderPanel();
    });
  }

  // ----- update form -----
  function openForm(t, a) {
    if (!canEdit()) return;
    var u = curOf(t.id, a);
    var mine = S.user.company_id && S.companies.some(function (c) { return c.id === S.user.company_id && c.is_active; }) ? S.user.company_id : null;
    var curCompany = u && S.companies.some(function (c) { return c.id === u.company_id && c.is_active; }) ? u.company_id : null;
    S.form = { tableId: t.id, act: a, status: null, company: curCompany || mine || null, remarks: '', base: u ? u.id : null, dirty: false };
    S.mode = 'form';
    renderPanel();
    if (window.innerWidth <= 900) ensureVisible(t);
  }
  function setFormAct(a) {
    var f = S.form, t = S.tables.get(f.tableId), u = curOf(t.id, a);
    f.act = a; f.base = u ? u.id : null;
    if (u && !f.dirty && S.companies.some(function (c) { return c.id === u.company_id && c.is_active; })) f.company = u.company_id;
    if (S.act !== a) setAct(a); else renderPanel();
  }
  function renderForm(P, t) {
    var f = S.form, u = curOf(t.id, f.act), cur = u ? u.status : 'not_started';
    var companies = activeCompanies();
    var head = h('div', { class: 'panel-head' },
      h('div', null, h('h2', { text: 'Update status' }), h('div', { class: 'panel-tid', text: t.code }), h('p', { class: 'panel-sub', text: 'Block ' + t.block })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cancel update', text: '×', onclick: cancelForm }));
    var actPick = h('div', { class: 'act-pick', role: 'group', 'aria-label': 'Activity' }, ACTS.map(function (a) {
      return h('button', { type: 'button', 'aria-pressed': String(f.act === a), text: ACT_SHORT[a], onclick: function () { setFormAct(a); } });
    }));
    var stPick = h('div', { class: 'status-pick', role: 'group', 'aria-label': 'New status' }, ST.map(function (st) {
      return h('button', {
        type: 'button', 'aria-pressed': String(f.status === st),
        onclick: function () { f.status = st; f.dirty = true; renderPanel(); }
      }, h('span', { class: 'sw s-' + st }), ST_LABEL[st]);
    }));
    var sel = h('select', { id: 'f-company', onchange: function (e) { f.company = e.target.value ? +e.target.value : null; f.dirty = true; renderPanel(); } },
      h('option', { value: '', text: companies.length ? 'Choose the company…' : 'No companies yet' }),
      companies.map(function (c) { return h('option', { value: c.id, text: c.name, selected: f.company === c.id }); }));
    var rem = h('textarea', { id: 'f-remarks', maxlength: 500, placeholder: 'Optional. For example: waiting for materials.' });
    rem.value = f.remarks;
    rem.addEventListener('input', function () { f.remarks = rem.value; f.dirty = true; });
    var ready = f.status && f.company;
    var stack = h('div', { class: 'stack' }, head,
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'Activity' }), actPick),
      h('p', { class: 'small' }, 'Current: ', chip(cur), u ? ' · ' + u.company_name + ' · ' + fmtTime(u.created_at) : ' · no update yet'),
      h('div', { class: 'field' }, h('span', { class: 'label', text: 'New status' }), stPick),
      h('div', { class: 'field' }, h('label', { for: 'f-company', text: 'Company responsible for this work' }), sel,
        companies.length ? null : h('p', { class: 'hint', text: 'The administrator must add contractor and subcontractor names first.' })),
      h('div', { class: 'field' }, h('label', { for: 'f-remarks', text: 'Remarks (optional)' }), rem),
      h('div', { class: 'form-actions' },
        h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: cancelForm }),
        h('button', { type: 'button', class: 'btn primary', text: 'Review update', disabled: !ready, onclick: function () { S.mode = 'confirm'; renderPanel(); } })),
      !ready ? h('p', { class: 'hint', text: !f.status ? 'Choose the new status.' : 'Choose the responsible company.' }) : null);
    P.append(stack);
  }
  function cancelForm() { S.mode = 'details'; S.form = null; renderPanel(); }

  function renderConfirm(P, t) {
    var f = S.form, u = curOf(t.id, f.act), cur = u ? u.status : 'not_started';
    var same = u && u.status === f.status && u.company_id === f.company;
    var btnSave = h('button', { type: 'button', class: 'btn primary', id: 'btn-save', text: 'Confirm and save', onclick: function () { saveUpdate(btnSave); } });
    P.append(h('div', { class: 'stack' },
      h('div', null, h('h2', { text: 'Confirm update' }), h('p', { class: 'panel-sub', text: 'Check the details. Nothing is saved until you press Confirm and save.' })),
      h('table', { class: 'confirm-tbl' }, h('tbody', null,
        h('tr', null, h('th', { text: 'Table' }), h('td', null, h('strong', { class: 'tid', text: t.code }), ' · Block ' + t.block)),
        h('tr', null, h('th', { text: 'Activity' }), h('td', { text: ACT[f.act] })),
        h('tr', null, h('th', { text: 'Status' }), h('td', null, chip(cur), h('span', { class: 'arrow', text: '→' }), chip(f.status))),
        h('tr', null, h('th', { text: 'Company' }), h('td', null, h('strong', { text: companyName(f.company) }))),
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
    var f = S.form, t = S.tables.get(f.tableId);
    btn.disabled = true; btn.textContent = 'Saving…';
    $$('#panel button').forEach(function (b) { b.disabled = true; });
    call('submit_update', {
      p_table_id: t.id, p_activity: f.act, p_status: f.status, p_company_id: f.company,
      p_remarks: f.remarks.trim() || null, p_expected_update_id: f.base
    }).then(function (d) {
      var u = d.update;
      S.cur.set(u.table_id + '|' + u.activity, u);
      S.mode = 'details'; S.form = null;
      var hist = S.history.get(t.id);
      if (Array.isArray(hist)) hist.unshift(u);
      paintStatuses(); renderPanel();
      toast('Saved. ' + t.code + ' · ' + ACT_SHORT[u.activity] + ' is now ' + ST_LABEL[u.status] + ' (' + fmtTime(u.created_at) + ').', 'ok', 6000);
      if (S.view === 'dashboard') renderDashboard();
    }).catch(function (e) {
      if (e.hint === 'session' || e.hint === 'password') return;
      if (e.hint === 'conflict') {
        toast(e.message, 'err', 9000);
        S.mode = 'details'; S.form = null;
        poll(true).then(function () { loadHistory(t.id, true); renderPanel(); });
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
    S.tables.forEach(function (t) {
      if (!t.code) return;
      var c = normId(t.code), cl = looseId(t.code), score;
      if (c === n) score = 0; else if (cl === l) score = 1; else if (c.indexOf(n) === 0) score = 2;
      else if (c.indexOf(n) > 0) score = 3; else if (l.length >= 2 && cl.indexOf(l) >= 0) score = 4; else return;
      out.push({ t: t, score: score });
    });
    out.sort(function (a, b) {
      return a.score - b.score || (a.t.block === S.block ? 0 : 1) - (b.t.block === S.block ? 0 : 1) || cmpCode(a.t.code, b.t.code);
    });
    return out.slice(0, 10).map(function (x) { return x.t; });
  }
  function renderSearchList(q) {
    var ul = $('#search-list'); ul.textContent = '';
    SR.items = searchMatches(q); SR.idx = SR.items.length ? 0 : -1;
    if (!q.trim()) { ul.hidden = true; return; }
    if (!SR.items.length) {
      ul.append(h('li', { class: 'empty', text: 'No table with ID “' + q.trim() + '”.' }));
    } else {
      SR.items.forEach(function (t, i) {
        ul.append(h('li', {
          role: 'option', 'aria-selected': String(i === SR.idx), id: 'sr-' + i,
          onmousedown: function (e) { e.preventDefault(); chooseSearch(t); }
        }, h('span', { text: t.code }), h('span', { class: 'blk', text: 'Block ' + t.block })));
      });
    }
    ul.hidden = false;
  }
  function chooseSearch(t) {
    var inp = $('#search');
    inp.value = ''; $('#search-list').hidden = true; inp.blur();
    if (S.view !== 'keyplan') setView('keyplan');
    if (t.block !== S.block) setBlock(t.block);
    selectTable(t.id, { zoom: true });
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
        var exact = SR.items.filter(function (t) { return normId(t.code) === normId(inp.value) || looseId(t.code) === looseId(inp.value); });
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
      if (d.meta_version !== S.metaVersion) {
        return loadBootstrap().then(function () { refreshAll(); });
      }
      var changed = [];
      d.current.forEach(function (u) {
        var k = u.table_id + '|' + u.activity, prev = S.cur.get(k);
        if (!prev || prev.id < u.id) { S.cur.set(k, u); changed.push(u); }
      });
      if (changed.length) {
        changed.forEach(function (u) {
          var hist = S.history.get(u.table_id);
          if (Array.isArray(hist) && !hist.some(function (x) { return x.id === u.id; })) hist.unshift(u);
        });
        if (S.view === 'keyplan') {
          paintStatuses();
          if (S.selected && changed.some(function (u) { return u.table_id === S.selected; })) {
            if (S.mode === 'details') renderPanel();
            else toast('Someone just updated ' + S.tables.get(S.selected).code + '. Check its status before saving.', 'err', 7000);
          } else if (!S.selected) renderPanel();
        } else if (S.view === 'dashboard') renderDashboard();
      }
    }).catch(function (e) {
      S.syncErr = e.hint === 'network' || e.status >= 500;
    }).then(function () { S.polling = false; renderSync(); });
  }
  function refreshAll() {
    if (S.view === 'keyplan') { if (KP.block !== S.block) buildKeyplan(); else { rebuildIfNeeded(); } renderPanel(); }
    else if (S.view === 'dashboard') renderDashboard();
    else if (S.view === 'admin') renderAdmin();
  }
  function rebuildIfNeeded() {
    var keep = Object.assign({}, KP.view);
    buildKeyplan();
    requestAnimationFrame(function () { setVB(keep); });
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
  function renderDashboard(resetPage) {
    var root = $('#dash'); if (!root) return;
    var F = S.dash; if (resetPage) F.page = 0;
    var scrollY = root.parentElement.scrollTop;
    root.textContent = '';
    var blocks = F.block === 'all' ? BLOCKS : [+F.block];
    var acts = F.act === 'all' ? ACTS : [F.act];
    var all = []; BLOCKS.forEach(function (b) { all = all.concat(S.byBlock[b] || []); });
    var inScope = all.filter(function (t) { return counted(t) && blocks.indexOf(t.block) >= 0; });

    root.append(h('div', { class: 'page-head' },
      h('div', null, h('h1', { text: 'Project overview' }),
        h('p', { text: 'Counts use only tables that have an ID in the drawing. A table with no saved update counts as Not Started.' })),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn small', text: 'Download current status (CSV)', onclick: exportCurrent }),
        h('button', { type: 'button', class: 'btn small', text: 'Download full history (CSV)', onclick: exportHistory }))));

    // filters
    function sel(id, label, value, options, key) {
      return h('div', { class: 'field' }, h('label', { for: id, text: label }),
        h('select', { id: id, onchange: function (e) { F[key] = e.target.value; renderDashboard(true); } },
          options.map(function (o) { return h('option', { value: o[0], text: o[1], selected: String(value) === String(o[0]) }); })));
    }
    root.append(h('div', { class: 'card' }, h('div', { class: 'filters' },
      sel('f-block', 'Block', F.block, [['all', 'Both blocks'], ['1', 'Block 1'], ['5', 'Block 5']], 'block'),
      sel('f-act', 'Activity', F.act, [['all', 'Both activities'], ['mounting', ACT_SHORT.mounting], ['module', ACT_SHORT.module]], 'act'),
      sel('f-status', 'Status', F.status, [['all', 'All statuses']].concat(ST.map(function (s) { return [s, ST_LABEL[s]]; })), 'status'),
      sel('f-company', 'Company', F.company, [['all', 'All companies']].concat(S.companies.map(function (c) { return [String(c.id), c.name + (c.is_active ? '' : ' (inactive)')]; })), 'company'))));

    // KPIs
    var counts = {};
    acts.forEach(function (a) {
      counts[a] = { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 };
      inScope.forEach(function (t) { counts[a][statusOf(t.id, a)]++; });
    });
    var nAct = inScope.length * acts.length;
    var tot = { ongoing: 0, on_hold: 0, completed: 0 };
    acts.forEach(function (a) { tot.ongoing += counts[a].ongoing; tot.on_hold += counts[a].on_hold; tot.completed += counts[a].completed; });
    var b1 = (S.byBlock[1] || []).filter(counted).length, b5 = (S.byBlock[5] || []).filter(counted).length;
    var noid1 = (S.byBlock[1] || []).filter(function (t) { return !t.code; }).length;
    var noid5 = (S.byBlock[5] || []).filter(function (t) { return !t.code; }).length;
    function kpi(label, num, note, cls) {
      return h('div', { class: 'kpi' + (cls ? ' ' + cls : '') }, h('div', { class: 'k-label', text: label }), h('div', { class: 'k-num' }, num), note ? h('div', { class: 'k-note', text: note }) : null);
    }
    var kp = h('div', { class: 'kpis' },
      kpi('Total tables · Block 1', String(b1), noid1 ? noid1 + ' outline' + (noid1 > 1 ? 's' : '') + ' without ID not counted' : 'All outlines have an ID'),
      kpi('Total tables · Block 5', String(b5), noid5 ? noid5 + ' outline' + (noid5 > 1 ? 's' : '') + ' without ID not counted' : 'All outlines have an ID'));
    acts.forEach(function (a) {
      kp.append(kpi(ACT_SHORT[a] + ' completed', [String(counts[a].completed), h('small', { text: ' / ' + inScope.length })], fmtPct(counts[a].completed, inScope.length) + ' of tables in view', 's-completed'));
    });
    kp.append(kpi('Ongoing activities', String(tot.ongoing), 'Tables × activities now in progress', 's-ongoing'));
    kp.append(kpi('Activities on hold', String(tot.on_hold), 'Tables × activities stopped or waiting', 's-on_hold'));
    kp.append(kpi('Remaining activities', [String(nAct - tot.completed), h('small', { text: ' / ' + nAct })], 'Not yet completed (' + acts.length + ' activit' + (acts.length > 1 ? 'ies' : 'y') + ' × ' + inScope.length + ' tables)', 's-not_started'));
    var today = new Date().toDateString(), todayN = 0;
    inScope.forEach(function (t) { acts.forEach(function (a) { var u = curOf(t.id, a); if (u && new Date(u.created_at).toDateString() === today) todayN++; }); });
    kp.append(kpi('Updated today', String(todayN), 'Tables × activities with a status saved today'));
    if (kp.children.length % 2) kp.lastChild.classList.add('span2');
    root.append(kp);

    // progress bars per block and activity
    var prog = h('div', { class: 'prog' });
    blocks.forEach(function (b) {
      var list = (S.byBlock[b] || []).filter(counted);
      acts.forEach(function (a) {
        var c = { not_started: 0, ongoing: 0, completed: 0, on_hold: 0 };
        list.forEach(function (t) { c[statusOf(t.id, a)]++; });
        prog.append(h('div', { class: 'prog-row' },
          h('div', { class: 'p-label', text: 'Block ' + b + ' · ' + ACT_SHORT[a] }), statusBar(c, list.length),
          h('div', { class: 'p-nums' }, ST.map(function (s) { return h('span', { text: ST_LABEL[s] + ': ' + c[s] }); }),
            h('strong', { text: fmtPct(c.completed, list.length) + ' completed' }))));
      });
    });
    root.append(h('div', { class: 'card' }, h('h2', { text: 'Progress' }),
      h('div', { class: 'card-stack' },
        h('div', { class: 'legend-inline' }, ST.map(function (s) { return h('span', null, h('i', { class: 'sw s-' + s }), ST_LABEL[s]); })),
        prog)));

    // responsibility by company
    var byCo = new Map();
    inScope.forEach(function (t) {
      acts.forEach(function (a) {
        var u = curOf(t.id, a); if (!u) return;
        var row = byCo.get(u.company_id) || { name: u.company_name, c: {} };
        var key = a + '|' + u.status; row.c[key] = (row.c[key] || 0) + 1; byCo.set(u.company_id, row);
      });
    });
    var coRows = Array.from(byCo.entries()).sort(function (x, y) { return x[1].name.localeCompare(y[1].name); });
    var coHead1 = h('tr', null, h('th', { rowspan: 2, text: 'Company' }));
    var coHead2 = h('tr');
    acts.forEach(function (a) {
      coHead1.append(h('th', { colspan: 3, class: 'grp', text: ACT_SHORT[a] }));
      ['completed', 'ongoing', 'on_hold'].forEach(function (s) { coHead2.append(h('th', { class: 'num', text: ST_LABEL[s] })); });
    });
    var coBody = h('tbody');
    coRows.forEach(function (e) {
      var tr = h('tr', null, h('td', null, h('strong', { text: e[1].name })));
      acts.forEach(function (a) { ['completed', 'ongoing', 'on_hold'].forEach(function (s) { tr.append(h('td', { class: 'num', text: String(e[1].c[a + '|' + s] || 0) })); }); });
      if (F.company !== 'all' && String(e[0]) !== F.company) tr.className = 'muted';
      coBody.append(tr);
    });
    root.append(h('div', { class: 'card' }, h('h2', { text: 'Responsible companies' }),
      h('p', { class: 'card-sub', text: 'Company named in the latest update of each table and activity.' }),
      coRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'dtable co-table' }, h('thead', null, coHead1, coHead2), coBody))
        : h('div', { class: 'empty-state', text: 'No updates have been saved yet.' })));

    // filtered list
    var rows = [];
    inScope.forEach(function (t) {
      acts.forEach(function (a) {
        var u = curOf(t.id, a), st = u ? u.status : 'not_started';
        if (F.status !== 'all' && st !== F.status) return;
        if (F.company !== 'all' && (!u || String(u.company_id) !== F.company)) return;
        rows.push({ t: t, a: a, u: u, st: st });
      });
    });
    rows.sort(function (x, y) { return x.t.block - y.t.block || cmpCode(x.t.code, y.t.code) || ACTS.indexOf(x.a) - ACTS.indexOf(y.a); });
    var per = 50, pages = Math.max(1, Math.ceil(rows.length / per));
    if (F.page >= pages) F.page = pages - 1;
    var slice = rows.slice(F.page * per, F.page * per + per);
    var body = h('tbody');
    slice.forEach(function (r) {
      body.append(h('tr', null,
        h('td', null, h('button', { type: 'button', class: 'link-btn tid', text: r.t.code, title: 'Show on keyplan', onclick: function () { locate(r.t, r.a); } })),
        h('td', { class: 'nowrap', text: 'Block ' + r.t.block }),
        h('td', { class: 'nowrap', text: ACT_SHORT[r.a] }),
        h('td', null, chip(r.st)),
        h('td', { text: r.u ? r.u.company_name : '—' }),
        h('td', { class: 'nowrap', text: r.u ? r.u.username : '—' }),
        h('td', { class: 'nowrap', text: r.u ? fmtTime(r.u.created_at) : '—' }),
        h('td', { text: r.u && r.u.remarks ? r.u.remarks : '' })));
    });
    var listCard = h('div', { class: 'card' }, h('h2', { text: 'Tables matching the filters' }),
      h('p', { class: 'card-sub', text: rows.length + ' table-activit' + (rows.length === 1 ? 'y' : 'ies') + '. Select a table ID to show it on the keyplan.' }));
    if (rows.length) {
      listCard.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['Table ID', 'Block', 'Activity', 'Status', 'Company', 'Updated by', 'Date & time', 'Remarks'].map(function (x) { return h('th', { text: x }); }))),
        body)));
      if (pages > 1) {
        listCard.append(h('div', { class: 'pager' },
          h('span', { text: 'Page ' + (F.page + 1) + ' of ' + pages }),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn small', text: '← Previous', disabled: F.page === 0, onclick: function () { F.page--; renderDashboard(); } }),
            h('button', { type: 'button', class: 'btn small', text: 'Next →', disabled: F.page >= pages - 1, onclick: function () { F.page++; renderDashboard(); } }))));
      }
    } else listCard.append(h('div', { class: 'empty-state', text: 'No tables match these filters.' }));
    root.append(listCard);

    // recent updates log
    var logCard = h('div', { class: 'card' }, h('h2', { text: 'Latest saved updates' }),
      h('p', { class: 'card-sub', text: 'Every change is kept. Newest first, using the same filters.' }), h('div', { id: 'dash-log' }, h('p', { class: 'small muted', text: 'Loading…' })));
    root.append(logCard);
    loadLog();
    root.parentElement.scrollTop = scrollY;
  }
  function loadLog() {
    var F = S.dash;
    call('get_updates', {
      p_block: F.block === 'all' ? null : +F.block, p_activity: F.act === 'all' ? null : F.act,
      p_status: F.status === 'all' ? null : F.status, p_company_id: F.company === 'all' ? null : +F.company,
      p_limit: 30, p_before_id: null
    }).then(function (d) {
      var box = $('#dash-log'); if (!box) return;
      box.textContent = '';
      if (!d.updates.length) { box.append(h('div', { class: 'empty-state', text: 'No saved updates yet.' })); return; }
      box.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
        h('thead', null, h('tr', null, ['Date & time', 'Table ID', 'Activity', 'Status', 'Company', 'Saved by', 'Remarks'].map(function (x) { return h('th', { text: x }); }))),
        h('tbody', null, d.updates.map(function (u) {
          return h('tr', null, h('td', { class: 'nowrap', text: fmtTime(u.created_at) }),
            h('td', null, h('span', { class: 'tid', text: u.table_code })), h('td', { class: 'nowrap', text: ACT_SHORT[u.activity] }),
            h('td', null, chip(u.status)), h('td', { text: u.company_name }), h('td', { class: 'nowrap', text: u.username }),
            h('td', { text: u.remarks || '' }));
        })))));
    }).catch(function (e) {
      var box = $('#dash-log'); if (box) box.textContent = 'Could not load updates: ' + e.message;
    });
  }
  function locate(t, a) {
    setView('keyplan');
    if (a && a !== S.act) setAct(a);
    if (t.block !== S.block) setBlock(t.block);
    selectTable(t.id, { zoom: true });
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
  function exportCurrent() {
    var rows = [['Block', 'Table ID', 'In monitoring', 'Drawing note',
      'Mounting Structure status', 'Mounting Structure company', 'Mounting Structure updated by', 'Mounting Structure updated at', 'Mounting Structure remarks',
      'PV Module status', 'PV Module company', 'PV Module updated by', 'PV Module updated at', 'PV Module remarks']];
    var list = [];
    BLOCKS.forEach(function (b) { list = list.concat((S.byBlock[b] || []).slice().sort(function (x, y) { return cmpCode(x.code, y.code); })); });
    list.forEach(function (t) {
      var r = [t.block, t.code || '(no ID in drawing)', counted(t) ? 'Yes' : 'No', (t.flags || []).map(function (f) { return FLAG_LABEL[f] || f; }).join('; ')];
      ACTS.forEach(function (a) {
        var u = curOf(t.id, a);
        r.push(counted(t) ? ST_LABEL[u ? u.status : 'not_started'] : '', u ? u.company_name : '', u ? u.username : '', u ? fmtTime(u.created_at) : '', u && u.remarks ? u.remarks : '');
      });
      rows.push(r);
    });
    download('pv-installation-status-' + stamp() + '.csv', rows);
  }
  function exportHistory(e) {
    var btn = e && e.target; if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
    call('get_updates', { p_block: null, p_activity: null, p_status: null, p_company_id: null, p_limit: 20000, p_before_id: null })
      .then(function (d) {
        var rows = [['Update no.', 'Date & time', 'Date & time (UTC, ISO)', 'Block', 'Table ID', 'Activity', 'Status', 'Company', 'Username', 'Name', 'Remarks']];
        d.updates.slice().reverse().forEach(function (u) {
          rows.push([u.id, fmtTime(u.created_at), new Date(u.created_at).toISOString(), u.block, u.table_code, ACT[u.activity], ST_LABEL[u.status], u.company_name, u.username, u.full_name || '', u.remarks || '']);
        });
        download('pv-installation-history-' + stamp() + '.csv', rows);
      })
      .catch(function (err) { toast('Download failed. ' + err.message, 'err'); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = 'Download full history (CSV)'; } });
  }

  // ------------------------------------------------------------------
  // Administration
  // ------------------------------------------------------------------
  function renderAdmin(refetch) {
    var root = $('#admin'); if (!root || !isAdmin()) return;
    root.textContent = '';
    var A = S.admin;
    root.append(h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Administration' }),
      h('p', { text: 'Accounts, contractor names and table information. Only administrators see this page.' }))));
    root.append(h('div', { class: 'subtabs', role: 'group', 'aria-label': 'Administration sections' },
      [['accounts', 'Accounts'], ['companies', 'Companies'], ['review', 'Table review']].map(function (x) {
        return h('button', { type: 'button', 'aria-pressed': String(A.tab === x[0]), text: x[1], onclick: function () { A.tab = x[0]; renderAdmin(x[0] === 'accounts'); } });
      })));
    var body = h('div', { class: 'stack', id: 'admin-body' });
    root.append(body);
    if (A.tab === 'accounts') renderAccounts(body, refetch || !A.users);
    else if (A.tab === 'companies') renderCompanies(body);
    else renderReview(body);
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
      h('p', { class: 'card-sub', text: 'Subcontractors can update tables. Viewers can only look. Administrators manage everything.' }),
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
      listCard.append(h('p', { class: 'small muted', text: 'Loading accounts…' }));
      call('admin_list_users').then(function (d) { A.users = d.users; if (S.view === 'admin' && A.tab === 'accounts') renderAdmin(false); })
        .catch(function (e) { listCard.append(h('p', { class: 'form-error', text: e.message })); });
      return;
    }
    listCard.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Username', 'Name', 'Role', 'Company', 'Status', 'Last sign-in', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, A.users.map(function (u) {
        var st = !u.is_active ? h('span', { class: 'pill off', text: 'Disabled' })
          : u.locked ? h('span', { class: 'pill warn', text: 'Locked 10 min' })
            : u.must_change_password ? h('span', { class: 'pill warn', text: 'Must set password' })
              : h('span', { class: 'pill on', text: 'Active' });
        return h('tr', null,
          h('td', null, h('strong', { class: 'mono', text: u.username })), h('td', { text: u.full_name || '—' }),
          h('td', { class: 'nowrap', text: ROLE_LABEL[u.role] }), h('td', { text: u.company_name || '—' }), h('td', null, st),
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
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save changes' });
    save.addEventListener('click', function () {
      save.disabled = true; err.hidden = true;
      call('admin_update_user', { p_user_id: u.id, p_full_name: fName.value.trim(), p_role: fRole.value, p_company_id: fCo.value ? +fCo.value : null, p_is_active: fAct.checked })
        .then(function () { closeModal(); toast('Account ' + u.username + ' updated.', 'ok'); S.admin.users = null; renderAdmin(true); })
        .catch(function (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; });
    });
    openModal('Edit ' + u.username, [
      h('div', { class: 'field' }, h('label', { for: 'e-name', text: 'Full name' }), fName),
      h('div', { class: 'field' }, h('label', { for: 'e-role', text: 'Role' }), fRole),
      h('div', { class: 'field' }, h('label', { for: 'e-company', text: 'Company' }), fCo),
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
      h('p', { class: 'card-sub', text: 'These names appear in the company list when a status is saved.' }),
      h('div', { class: 'grid-form' }, h('div', { class: 'field' }, h('label', { for: 'c-name', text: 'Company name' }), fName), h('div', null, btn)), err);
    form.addEventListener('submit', function (e) {
      e.preventDefault(); err.hidden = true; btn.disabled = true;
      call('admin_save_company', { p_company_id: null, p_name: fName.value, p_is_active: true })
        .then(function () { toast('Company added.', 'ok'); return loadBootstrap(); })
        .then(function () { renderAdmin(); })
        .catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; });
    });
    body.append(form);
    var use = new Map();
    S.cur.forEach(function (u) { use.set(u.company_id, (use.get(u.company_id) || 0) + 1); });
    var card = h('div', { class: 'card' }, h('h2', { text: 'Companies' }));
    if (!S.companies.length) card.append(h('div', { class: 'empty-state', text: 'No companies yet. Add the first one above.' }));
    else card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Company', 'Status', 'Current responsibilities', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, S.companies.map(function (c) {
        return h('tr', null, h('td', null, h('strong', { text: c.name })),
          h('td', null, h('span', { class: 'pill ' + (c.is_active ? 'on' : 'off'), text: c.is_active ? 'Active' : 'Inactive' })),
          h('td', { class: 'num', text: String(use.get(c.id) || 0) }),
          h('td', { class: 'nowrap' }, h('div', { class: 'btn-row nowrap' },
            h('button', { type: 'button', class: 'btn small', text: 'Rename', onclick: function () { renameCompany(c); } }),
            h('button', {
              type: 'button', class: 'btn small' + (c.is_active ? ' danger' : ''), text: c.is_active ? 'Deactivate' : 'Activate',
              onclick: function () { saveCompany(c, c.name, !c.is_active); }
            }))));
      })))));
    card.append(h('p', { class: 'hint', text: 'Deactivated companies disappear from the list for new updates. Their past records stay unchanged.' }));
    body.append(card);
  }
  function saveCompany(c, name, active) {
    return call('admin_save_company', { p_company_id: c.id, p_name: name, p_is_active: active })
      .then(function () { toast('Company saved.', 'ok'); return loadBootstrap(); })
      .then(function () { closeModal(); renderAdmin(); })
      .catch(function (e) { toast(e.message, 'err'); throw e; });
  }
  function renameCompany(c) {
    var f = h('input', { id: 'rc-name', maxlength: 120 }); f.value = c.name;
    var save = h('button', { type: 'button', class: 'btn primary', text: 'Save name' });
    save.addEventListener('click', function () { save.disabled = true; saveCompany(c, f.value, c.is_active).catch(function () { save.disabled = false; }); });
    openModal('Rename company', [h('div', { class: 'field' }, h('label', { for: 'rc-name', text: 'Company name' }), f),
      h('p', { class: 'hint', text: 'The new name is shown everywhere, including earlier updates by this company.' }),
      h('div', { class: 'btn-row' }, save, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeModal }))]);
  }

  function renderReview(body) {
    var A = S.admin;
    var all = [];
    BLOCKS.forEach(function (b) { all = all.concat(S.byBlock[b] || []); });
    var flagged = all.filter(function (t) { return (t.flags && t.flags.length) || !t.is_active || t.review_status !== 'none'; });
    var list = flagged.filter(function (t) { return A.reviewAll || t.review_status === 'open'; });
    var toggle = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: A.reviewAll, onchange: function (e) { A.reviewAll = e.target.checked; renderAdmin(); } }),
      h('span', { text: 'Also show items already marked as checked' }));
    var card = h('div', { class: 'card' }, h('h2', { text: 'Drawing items to review' }),
      h('p', { class: 'card-sub', text: 'Found while reading “BLOCK 1 AND BLOCK 5 - KEYPLAN.dwg” and checked against both PDF keyplans. Nothing was guessed. Outlines without an ID stay out of all counts until you assign the ID.' }),
      toggle);
    if (!list.length) card.append(h('div', { class: 'empty-state', text: 'Nothing open for review.' }));
    else card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable' },
      h('thead', null, h('tr', null, ['Block', 'Table ID', 'Issue', 'Details', 'Review', ''].map(function (x) { return h('th', { text: x }); }))),
      h('tbody', null, list.sort(function (x, y) { return x.block - y.block || cmpCode(x.code || 'zzz', y.code || 'zzz'); }).map(function (t) {
        return h('tr', null, h('td', { class: 'nowrap', text: 'Block ' + t.block }),
          h('td', null, h('strong', { class: 'tid', text: t.code || 'NO ID' })),
          h('td', null, (t.flags || []).map(function (f) { return h('div', { text: FLAG_LABEL[f] || f }); }), !t.is_active ? h('div', { text: 'Excluded from monitoring' }) : null),
          h('td', { class: 'small', text: [t.flag_notes, t.review_note ? 'Review note: ' + t.review_note : ''].filter(Boolean).join(' ') }),
          h('td', null, h('span', { class: 'pill ' + (t.review_status === 'resolved' ? 'on' : 'warn'), text: t.review_status === 'resolved' ? 'Checked' : 'Open' })),
          h('td', { class: 'nowrap' }, h('div', { class: 'btn-row nowrap' },
            h('button', { type: 'button', class: 'btn small', text: 'Locate', onclick: function () { locate(t); } }),
            h('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: function () { openTableEditor(t); } }))));
      })))));
    body.append(card);
  }

  function openTableEditor(t) {
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
    openModal('Table info · ' + (t.code || 'outline without ID'), [
      h('p', { class: 'small muted', text: 'Block ' + t.block + (t.dwg_ref ? ' · DWG object handle ' + String(t.dwg_ref).replace(/\+/g, ' + ') : '') }),
      flagNotice(t),
      h('div', { class: 'field' }, h('label', { for: 't-code', text: 'Table ID (exactly as on the drawing)' }), fCode,
        h('p', { class: 'hint', text: 'Earlier status records keep the ID they were saved with.' })),
      h('div', { class: 'field' }, h('label', { for: 't-review', text: 'Review status' }), fRev),
      h('div', { class: 'field' }, h('label', { for: 't-note', text: 'Review note' }), fNote),
      h('label', { class: 'check' }, fAct, h('span', { text: 'Include this table in monitoring and counts' })),
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
    openModal('How to update a table', [
      h('ol', { class: 'steps' },
        h('li', { text: 'Sign in with the username and password from the administrator.' }),
        h('li', { text: 'Choose Block 1 or Block 5 at the top.' }),
        h('li', { text: 'Find the table: zoom in (pinch or scroll) and tap it, or type its ID in the search box. Tapping only selects the table; nothing is saved.' }),
        h('li', { text: 'Check the table ID shown in the panel. Press Update status.' }),
        h('li', { text: 'Choose the activity (Mounting Structure or PV Module), the new status, and the company responsible for the work. Add a remark if needed.' }),
        h('li', { text: 'Press Review update, check the summary, then press Confirm and save. Wait for the green “Saved” message.' })),
      h('div', { class: 'summary-grid' }, ST.map(function (s) {
        var d = { not_started: 'Work not started (or nothing recorded yet)', ongoing: 'Work in progress', completed: 'Work finished', on_hold: 'Work stopped or waiting' }[s];
        return [h('span', { class: 'sw s-' + s }), h('strong', { text: ST_LABEL[s] }), h('span', { class: 'small muted', text: d })];
      })),
      h('p', { class: 'small', text: 'Mounting Structure and PV Module are tracked separately: completing one does not change the other. Every save records your username, the company and the server date and time. Earlier statuses stay in the history.' }),
      h('p', { class: 'small', text: 'Hatched red outlines have no table ID in the drawing. They cannot be updated until the administrator assigns the ID.' })]);
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
    S.selected = null; S.mode = 'details'; S.form = null; S.admin.users = null;
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
        return loadBootstrap().then(function () { S.view = 'keyplan'; showApp(); });
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
        .then(function () { toast('Password saved.', 'ok'); showApp(); })
        .catch(function (e2) {
          if (e2.hint === 'session') { signedOut(e2.message); return; }
          err.textContent = e2.message; err.hidden = false;
        })
        .then(function () { btn.disabled = false; });
    });
    $('#pw-logout').addEventListener('click', logout);
    $$('.tab').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
    $$('#seg-block button').forEach(function (b) { b.addEventListener('click', function () { setBlock(+b.dataset.block); }); });
    $$('#seg-act button').forEach(function (b) { b.addEventListener('click', function () { setAct(b.dataset.act); }); });
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
