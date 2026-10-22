/* PV Module Serial Numbers — app core: session, data, start-up (also without signal), layout shell, routing */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, api = SN.api, el = u.el;
  SN.version = '20261023070906';

  var S = (SN.state = {
    me: null, settings: {}, users: new Map(), tables: new Map(), list: [], blocks: [],
    serverTime: null, view: 'keyplan', online: null, lastSync: 0, outbox: 0, booted: false
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
      source: a[16], handle: a[17], drawn_label: a[18] || '', flags_cleared: !!a[19], updated: a[20], raw: a
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
  SN.applyUsers = applyUsers;
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

  // Starts from the copy saved on this device when there is one (instant, works without signal),
  // then brings it up to date from the server in the background.
  function boot() {
    document.title = 'PV Module Serial Numbers';
    var sess = api.session();
    if (!sess || !sess.token) { showLogin(); return; }
    if (sess.user && sess.user.must_change) { showPassword(true); return; }
    show('boot');
    SN.store.loadSnapshot(sess.user && sess.user.id).then(function (snap) {
      if (snap) start(snap, true);
      else fetchBootstrap();
    }, fetchBootstrap);
  }
  function fetchBootstrap() {
    api.call('sn_bootstrap', {}, { quietSession: true, timeout: 40000 }).then(function (b) {
      start(b, false);
      SN.store.saveSnapshot(b);
    }, function (e) {
      if (e.code === 'SESSION') { api.setSession(null); showLogin(e.message); }
      else if (e.code === 'MUST_CHANGE') { showPassword(true); }
      else if (e.code === 'NOT_SET_UP') { showSetup(); }
      else if (api.isOffline(e)) {
        showBootError('No connection yet',
          'This phone has no saved copy of the project yet. Connect once (mobile data or Wi-Fi) and open the app; after that it also opens and works without signal.');
      } else { showBootError('Cannot reach the server', e.message); }
    });
  }
  function showBootError(title, msg) {
    show('boot');
    var b = document.getElementById('boot');
    u.clear(b).appendChild(el('div.boot-card',
      el('h1', title), el('p', msg),
      el('div.row', el('button.btn.primary', { type: 'button', on: { click: function () { boot(); } } }, 'Try again'),
        el('button.btn', { type: 'button', on: { click: function () { signOut(); } } }, 'Sign out'))));
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
      api.rpc('sn_login', { p_username: user, p_password: pass, p_agent: navigator.userAgent.slice(0, 180) }, { timeout: 30000 }).then(function (r) {
        btn.disabled = false; btn.textContent = 'Sign in';
        if (!r || !r.ok) { err.hidden = false; err.textContent = (r && r.error) || 'Sign-in failed.'; return; }
        document.getElementById('login-pass').value = '';
        api.setSession({ token: r.token, user: r.user, expires_at: r.expires_at });
        if (r.user.must_change) showPassword(true); else boot();
      }, function (e) {
        btn.disabled = false; btn.textContent = 'Sign in';
        if (e.code === 'NOT_SET_UP') { showSetup(); return; }
        err.hidden = false;
        err.textContent = api.isOffline(e)
          ? 'No connection. Signing in needs signal (mobile data or Wi-Fi). Once signed in, the app also works without signal.'
          : e.message;
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
    document.getElementById('pw-signout').addEventListener('click', function () { confirmSignOut(); });
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
      }, function (e2) {
        btn.disabled = false; err.hidden = false;
        err.textContent = api.isOffline(e2) ? 'No connection. Changing the password needs signal.' : e2.message;
      });
    });
  }
  SN.showPassword = showPassword;

  // Sign-out clears the copy of the project on this device. Registrations that are still waiting
  // to upload stay on the device and upload after the same person signs in again.
  function signOut(message) {
    var tok = api.token();
    if (SN.sync) SN.sync.stop();
    api.setSession(null);
    api.clearPhotoCache();
    if (tok) api.rpc('sn_logout', { p_token: tok }, { timeout: 8000 }).catch(function () {});
    SN.store.clearAll();
    S.booted = false; S.tables = new Map(); S.list = []; S.me = null; S.online = null;
    if (SN.views && SN.views.reset) SN.views.reset();
    showLogin(message);
  }
  SN.signOut = signOut;
  function confirmSignOut() {
    var n = S.outbox || 0;
    if (!n) return signOut();
    u.confirmBox('Sign out with ' + n + ' registration' + (n === 1 ? '' : 's') + ' not uploaded?',
      (n === 1 ? 'It stays' : 'They stay') + ' on this phone and upload' + (n === 1 ? 's' : '') + ' after you sign in again with this account (with signal). Do not clear the browser data of this phone until then.',
      'Sign out').then(function (ok) { if (ok) signOut(); });
  }
  SN.bus.on('session-ended', function (msg) { if (S.booted || api.token()) signOut(msg); });
  SN.bus.on('must-change', function () { showPassword(true); });

  function start(b, fromCache) {
    S.me = b.user;
    var s = api.session(); s.user = b.user; api.setSession(s);
    S.settings = b.settings || {};
    S.serverTime = b.server_time;
    S.lastSync = fromCache ? (b.saved_at || 0) : Date.now();
    S.online = fromCache ? null : true;
    applyUsers(b.users);
    S.tables = new Map(); S.list = [];
    applyTables(b.tables);
    S.booted = true;
    buildShell();
    show('screen-app');
    SN.views.init();
    route();
    SN.sync.start(fromCache);
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
      u.$('#menu-password').addEventListener('click', function () {
        u.$('#me-menu').hidden = true;
        if (S.online === false) { u.toast('Changing the password needs a connection.', 'warn'); return; }
        showPassword(false);
      });
      u.$('#menu-signout').addEventListener('click', function () { u.$('#me-menu').hidden = true; confirmSignOut(); });
      u.$('#menu-help').addEventListener('click', function () { u.$('#me-menu').hidden = true; SN.views.help(); });
      u.$('#sync-btn').addEventListener('click', function () { SN.views.syncPanel(); });
    }
    SN.sync.render();
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

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.SN_CONFIG || !window.SN_CONFIG.supabaseUrl) { showBootError('Cannot start', 'The app is missing its connection settings (config.js).'); return; }
    boot();
  });
})();
