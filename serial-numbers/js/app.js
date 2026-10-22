/* PV Module Serial Numbers — app core: session, data, sync, layout shell, routing */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, api = SN.api, el = u.el;
  SN.version = '2026.10.22';

  var S = (SN.state = {
    me: null, settings: {}, users: new Map(), tables: new Map(), list: [], blocks: [],
    serverTime: null, view: 'keyplan', online: true, lastSync: 0, outbox: 0, booted: false
  });

  // ---------- permissions ----------
  SN.can = {
    register: function () { return S.me && ['admin', 'encoder', 'qaqc'].indexOf(S.me.role) >= 0; },
    review: function () { return S.me && ['admin', 'qaqc'].indexOf(S.me.role) >= 0; },
    admin: function () { return S.me && S.me.role === 'admin'; },
    export: function () { return S.me && ['admin', 'qaqc', 'manager'].indexOf(S.me.role) >= 0; },
    audit: function () { return S.me && ['admin', 'qaqc', 'manager'].indexOf(S.me.role) >= 0; }
  };

  // ---------- data model ----------
  function rowToTable(a) {
    return {
      id: a[0], label: a[1] || '', block: a[2], x: +a[3], y: +a[4], flags: a[5] || [], confirmed: !!a[6],
      installed: !!a[7], in_scope: !!a[8], assigned_to: a[9], n_reg: a[10] | 0, n_ok: a[11] | 0,
      n_review: a[12] | 0, n_verified: a[13] | 0, first_completed: a[14], completed: a[15],
      source: a[16], handle: a[17], drawn_label: a[18] || '', flags_cleared: !!a[19], updated: a[20]
    };
  }
  function tableState(t) {
    if (!t.confirmed) return 'unconfirmed';
    if (!t.installed) return 'not_installed';
    if (!t.label) return 'no_id';
    if (!t.in_scope) return 'excluded';
    if (t.n_review > 0) return 'needs_review';
    if (t.completed) return 'completed';
    if (t.n_reg === 0) return 'ready';
    return 'in_progress';
  }
  SN.tableState = tableState;
  SN.issues = function (t) { return (t.flags && t.flags.length && !t.flags_cleared) ? t.flags : []; };
  SN.inScope = function (t) { return t.confirmed && t.installed && t.in_scope && !!t.label; };

  SN.COLORS = { not_installed: '#A3ACB6', ready: '#2F7FE8', in_progress: '#F5AA1F', completed: '#146C38',
    needs_review: '#F06B70', excluded: '#D7DDE3', no_id: '#C9D2DC', unconfirmed: 'none' };

  function applyTables(rows) {
    var changed = [];
    (rows || []).forEach(function (a) {
      var t = rowToTable(a), old = S.tables.get(t.id);
      if (old) { Object.assign(old, t); changed.push(old); } else { S.tables.set(t.id, t); changed.push(t); }
    });
    if (changed.length) {
      if (changed.length > 50 || !S.list.length) {
        S.list = Array.from(S.tables.values()).sort(function (a, b) { return a.id - b.id; });
      }
      computeBlocks();
      SN.bus.emit('tables', changed);
    }
    return changed;
  }
  SN.applyTables = applyTables;
  function applyUsers(rows) {
    S.users = new Map();
    (rows || []).forEach(function (a) { S.users.set(a[0], { id: a[0], username: a[1], full_name: a[2], role: a[3], active: a[4] }); });
    SN.bus.emit('users');
  }
  SN.userName = function (id) {
    var x = S.users.get(id);
    return x ? (x.full_name || x.username) : (id ? 'User #' + id : '—');
  };
  function computeBlocks() {
    var m = new Map();
    S.list.forEach(function (t) {
      if (!t.confirmed) return;
      var b = m.get(t.block) || { name: t.block, sx: 0, sy: 0, n: 0 };
      b.sx += t.x; b.sy += t.y; b.n++; m.set(t.block, b);
    });
    S.blocks = Array.from(m.values()).sort(function (a, b) { return a.name < b.name ? -1 : 1; })
      .map(function (b) { return { name: b.name, x: b.sx / b.n, y: b.sy / b.n, n: b.n }; });
  }
  SN.findTables = function (q, limit) {
    q = String(q || '').trim().toUpperCase();
    if (!q) return [];
    var lq = u.looseId(q), out = [];
    S.list.forEach(function (t) {
      if (!t.label && q.indexOf('NO') !== 0) return;
      var lab = t.label || 'NO ID', score = -1;
      if (lab === q) score = 100;
      else if (u.looseId(lab) === lq) score = 95;
      else if (lab.indexOf(q) === 0) score = 80;
      else if (u.looseId(lab).indexOf(lq) === 0) score = 70;
      else if (lab.indexOf(q) > 0) score = 50;
      else if ((t.handle || '').toUpperCase() === q) score = 40;
      if (score >= 0) out.push({ t: t, s: score });
    });
    out.sort(function (a, b) { return b.s - a.s || (u.natKey(a.t.label) < u.natKey(b.t.label) ? -1 : 1); });
    return out.slice(0, limit || 8).map(function (x) { return x.t; });
  };

  // ---------- boot / session ----------
  function show(id) {
    ['boot', 'screen-login', 'screen-password', 'screen-app', 'screen-setup'].forEach(function (s) {
      var n = document.getElementById(s); if (n) n.hidden = s !== id;
    });
  }
  SN.show = show;

  function boot() {
    document.title = 'PV Module Serial Numbers';
    var sess = api.session();
    if (!sess || !sess.token) { showLogin(); return; }
    if (sess.user && sess.user.must_change) { showPassword(true); return; }
    show('boot');
    api.call('sn_bootstrap', {}, { quietSession: true }).then(start, function (e) {
      if (e.code === 'SESSION') { api.setSession(null); showLogin(e.message); }
      else if (e.code === 'MUST_CHANGE') { showPassword(true); }
      else if (e.code === 'NOT_SET_UP') { showSetup(); }
      else if (e.code === 'NETWORK') { showBootError(e.message); }
      else { showBootError(e.message); }
    });
  }
  function showBootError(msg) {
    show('boot');
    var b = document.getElementById('boot');
    u.clear(b).appendChild(el('div.boot-card',
      el('h1', 'Cannot reach the server'), el('p', msg),
      el('div.row', el('button.btn.primary', { type: 'button', on: { click: function () { boot(); } } }, 'Try again'),
        el('button.btn', { type: 'button', on: { click: function () { api.setSession(null); location.reload(); } } }, 'Sign out'))));
  }
  function showSetup() {
    show('screen-setup');
    var b = document.getElementById('setup-reload');
    if (b && !b.dataset.bound) { b.dataset.bound = '1'; b.addEventListener('click', function () { location.reload(); }); }
  }

  function showLogin(message) {
    show('screen-login');
    var f = document.getElementById('login-form');
    var err = document.getElementById('login-error');
    err.hidden = !message; err.textContent = message || '';
    setTimeout(function () { var x = document.getElementById('login-user'); if (x && !x.value) x.focus(); }, 50);
    if (f.dataset.bound) return;
    f.dataset.bound = '1';
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var user = document.getElementById('login-user').value.trim(), pass = document.getElementById('login-pass').value;
      var btn = document.getElementById('login-btn');
      if (!user || !pass) { err.hidden = false; err.textContent = 'Enter your username and password.'; return; }
      btn.disabled = true; btn.textContent = 'Signing in…'; err.hidden = true;
      api.rpc('sn_login', { p_username: user, p_password: pass, p_agent: navigator.userAgent.slice(0, 180) }).then(function (r) {
        btn.disabled = false; btn.textContent = 'Sign in';
        if (!r || !r.ok) { err.hidden = false; err.textContent = (r && r.error) || 'Sign-in failed.'; return; }
        document.getElementById('login-pass').value = '';
        api.setSession({ token: r.token, user: r.user, expires_at: r.expires_at });
        if (r.user.must_change) showPassword(true); else boot();
      }, function (e) {
        btn.disabled = false; btn.textContent = 'Sign in';
        if (e.code === 'NOT_SET_UP') { showSetup(); return; }
        err.hidden = false; err.textContent = e.message;
      });
    });
    u.$$('.pw-toggle').forEach(bindPwToggle);
  }
  function bindPwToggle(b) {
    if (b.dataset.bound) return; b.dataset.bound = '1';
    b.addEventListener('click', function () {
      var i = document.getElementById(b.dataset.for);
      var showIt = i.type === 'password';
      i.type = showIt ? 'text' : 'password';
      b.textContent = showIt ? 'Hide' : 'Show';
      b.setAttribute('aria-label', showIt ? 'Hide password' : 'Show password');
    });
  }

  function showPassword(forced) {
    show('screen-password');
    var f = document.getElementById('pw-form'), err = document.getElementById('pw-error');
    document.getElementById('pw-sub').textContent = forced
      ? 'Your account uses a temporary password. Choose your own password to continue.'
      : 'Choose a new password.';
    document.getElementById('pw-cancel').hidden = forced;
    err.hidden = true;
    u.$$('.pw-toggle').forEach(bindPwToggle);
    if (f.dataset.bound) return;
    f.dataset.bound = '1';
    document.getElementById('pw-cancel').addEventListener('click', function () { show('screen-app'); });
    document.getElementById('pw-signout').addEventListener('click', function () { signOut(); });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var oldp = document.getElementById('pw-old').value, n1 = document.getElementById('pw-new').value, n2 = document.getElementById('pw-new2').value;
      err.hidden = true;
      if (n1.length < 8) { err.hidden = false; err.textContent = 'The new password must have at least 8 characters.'; return; }
      if (n1 !== n2) { err.hidden = false; err.textContent = 'The two new passwords do not match.'; return; }
      var btn = document.getElementById('pw-btn'); btn.disabled = true;
      api.call('sn_change_password', { p_old: oldp, p_new: n1 }).then(function (r) {
        btn.disabled = false;
        var s = api.session(); s.user = r.user; api.setSession(s);
        f.reset();
        u.toast('Password changed.', 'ok');
        if (S.booted) show('screen-app'); else boot();
      }, function (e2) { btn.disabled = false; err.hidden = false; err.textContent = e2.message; });
    });
  }
  SN.showPassword = showPassword;

  function signOut(message) {
    var tok = api.token();
    stopSync();
    api.setSession(null);
    api.clearPhotoCache();
    if (tok) api.rpc('sn_logout', { p_token: tok }).catch(function () {});
    S.booted = false; S.tables = new Map(); S.list = [];
    if (SN.views && SN.views.reset) SN.views.reset();
    showLogin(message);
  }
  SN.signOut = signOut;
  SN.bus.on('session-ended', function (msg) { if (S.booted || api.token()) signOut(msg); });
  SN.bus.on('must-change', function () { showPassword(true); });

  function start(b) {
    S.me = b.user;
    var s = api.session(); s.user = b.user; api.setSession(s);
    S.settings = b.settings || {};
    S.serverTime = b.server_time;
    applyUsers(b.users);
    S.tables = new Map(); S.list = [];
    applyTables(b.tables);
    S.booted = true;
    S.lastSync = Date.now();
    buildShell();
    show('screen-app');
    SN.views.init();
    route();
    startSync();
    api.outbox.flush().then(updateOutboxBadge, updateOutboxBadge);
  }

  // ---------- shell ----------
  var NAV = [
    { id: 'keyplan', label: 'Keyplan', icon: 'map' },
    { id: 'dashboard', label: 'Dashboard', icon: 'chart' },
    { id: 'review', label: 'Review', icon: 'shield', when: function () { return SN.can.review() || SN.can.audit(); } },
    { id: 'admin', label: 'Admin', icon: 'gear', when: function () { return SN.can.admin(); } }
  ];
  function buildShell() {
    var proj = S.settings.project || {};
    u.$('#proj-name').textContent = proj.name || 'PV Module Serial Numbers';
    u.$('#proj-sub').textContent = proj.subtitle || 'PV module serial-number register';
    document.title = (proj.name ? proj.name + ' · ' : '') + 'PV Module Serial Numbers';
    var me = S.me;
    u.$('#me-name').textContent = me.full_name || me.username;
    u.$('#me-role').textContent = u.ROLE[me.role] || me.role;
    ['#nav-top', '#nav-bottom'].forEach(function (sel) {
      var host = u.clear(u.$(sel));
      NAV.forEach(function (n) {
        if (n.when && !n.when()) return;
        var a = el('a.nav-item', { href: '#/' + n.id, dataset: { view: n.id } }, u.icon(n.icon, 20), el('span', n.label),
          n.id === 'review' ? el('span.badge.nav-count', { hidden: true }) : null);
        host.appendChild(a);
      });
    });
    var menuBtn = u.$('#me-btn');
    if (!menuBtn.dataset.bound) {
      menuBtn.dataset.bound = '1';
      menuBtn.addEventListener('click', function () { toggleMenu(); });
      document.addEventListener('click', function (e) {
        var m = u.$('#me-menu');
        if (!m.hidden && !m.contains(e.target) && !menuBtn.contains(e.target)) m.hidden = true;
      });
      u.$('#menu-password').addEventListener('click', function () { u.$('#me-menu').hidden = true; showPassword(false); });
      u.$('#menu-signout').addEventListener('click', function () { u.$('#me-menu').hidden = true; signOut(); });
      u.$('#menu-help').addEventListener('click', function () { u.$('#me-menu').hidden = true; SN.views.help(); });
      u.$('#sync-btn').addEventListener('click', function () { SN.views.syncPanel(); });
    }
    updateSyncChip();
  }
  function toggleMenu() { var m = u.$('#me-menu'); m.hidden = !m.hidden; }

  // ---------- routing ----------
  function route() {
    var h = (location.hash || '').replace(/^#\/?/, '').split('/');
    var view = h[0] || 'keyplan';
    var allowed = NAV.filter(function (n) { return !n.when || n.when(); }).map(function (n) { return n.id; });
    if (allowed.indexOf(view) < 0) view = 'keyplan';
    S.view = view;
    u.$$('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + view; });
    u.$$('.nav-item').forEach(function (a) {
      var on = a.dataset.view === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    SN.views.show(view, h.slice(1));
  }
  SN.route = route;
  SN.go = function (hash) { if (location.hash === hash) route(); else location.hash = hash; };
  window.addEventListener('hashchange', function () { if (S.booted) route(); });

  // ---------- sync ----------
  var timer = null, polling = false;
  function startSync() {
    stopSync();
    timer = setInterval(poll, (window.SN_CONFIG.pollSeconds || 15) * 1000);
  }
  function stopSync() { if (timer) clearInterval(timer); timer = null; }
  function poll(force) {
    if (!S.booted || polling || (!force && document.hidden)) return Promise.resolve();
    polling = true;
    return api.call('sn_changes', { p_since: S.serverTime }).then(function (r) {
      polling = false;
      S.serverTime = r.server_time; S.lastSync = Date.now(); setOnline(true);
      if (r.user && (r.user.role !== S.me.role)) { u.toast('Your role was changed by the administrator. Reloading…'); setTimeout(function () { location.reload(); }, 1500); }
      if (r.users) applyUsers(r.users);
      if (r.settings) { S.settings = r.settings; SN.bus.emit('settings'); }
      applyTables(r.tables);
      updateSyncChip();
    }, function (e) {
      polling = false;
      if (e.code === 'NETWORK') setOnline(false);
      updateSyncChip();
    });
  }
  SN.poll = poll;
  function setOnline(v) {
    if (S.online === v) return;
    S.online = v; updateSyncChip();
    if (v) api.outbox.flush().then(updateOutboxBadge, updateOutboxBadge);
  }
  window.addEventListener('online', function () { poll(true); api.outbox.flush().then(updateOutboxBadge, updateOutboxBadge); });
  window.addEventListener('offline', function () { setOnline(false); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { poll(true); api.outbox.flush().then(updateOutboxBadge, updateOutboxBadge); } });
  setInterval(function () { if (S.booted && S.outbox && navigator.onLine) api.outbox.flush().then(updateOutboxBadge, updateOutboxBadge); }, 20000);

  function updateOutboxBadge() {
    return api.outbox.list().then(function (items) {
      var mine = items.filter(function (i) { return S.me && i.user_id === S.me.id; });
      S.outbox = mine.length; S.outboxErrors = mine.filter(function (i) { return i.state === 'error'; }).length;
      updateSyncChip();
      SN.bus.emit('outbox-list', mine);
    });
  }
  SN.updateOutboxBadge = updateOutboxBadge;
  SN.bus.on('outbox', function () { updateOutboxBadge(); });
  SN.bus.on('registered', function (ev) {
    if (ev && ev.res && ev.res.tables) applyTables(ev.res.tables);
    SN.bus.emit('detail-stale', ev && ev.item && ev.item.table_id);
  });
  function updateSyncChip() {
    var chip = u.$('#sync-btn');
    if (!chip) return;
    var txt = u.$('#sync-text');
    chip.classList.remove('ok', 'warn', 'bad');
    if (!S.online) { chip.classList.add('bad'); txt.textContent = 'Offline' + (S.outbox ? ' · ' + S.outbox + ' waiting' : ''); }
    else if (S.outboxErrors) { chip.classList.add('bad'); txt.textContent = S.outboxErrors + ' not uploaded'; }
    else if (S.outbox) { chip.classList.add('warn'); txt.textContent = S.outbox + ' uploading'; }
    else { chip.classList.add('ok'); txt.textContent = 'Live'; }
    chip.title = 'Last update from the server: ' + (S.lastSync ? u.ago(S.lastSync) : 'never');
  }
  setInterval(updateSyncChip, 30000);

  // ---------- service worker (keeps the app shell available with weak signal) ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.SN_CONFIG || !window.SN_CONFIG.supabaseUrl) { showBootError('The app is missing its connection settings (config.js).'); return; }
    boot();
  });
})();
