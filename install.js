/* Solar PV Installation Monitoring — install the app on phones, tablets and computers.
   The app installs from the browser (no app store): Android and computers (Chrome, Edge, Samsung
   Internet) through the browser's install prompt, iPhone and iPad through Share > Add to Home Screen.
   Installed, it opens from its own icon, full screen, and works without signal (sw.js, offline.js).
   Also: the link and a QR code to put the app on other devices, and a notice when a new version is ready. */
(function () {
  'use strict';
  var I = window.PVMInstall = {};
  var LS_TIP = 'pvm.installTip';
  var script = document.currentScript;
  var vm = script && script.src ? script.src.match(/[?&]v=([^&]+)/) : null;
  var PAGE_V = vm ? vm[1] : null;

  var ua = navigator.userAgent || '';
  var iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1; // iPad asking for the desktop site
  var isIOS = /iPhone|iPad|iPod/.test(ua) || iPadOS;
  var isIPad = /iPad/.test(ua) || iPadOS;
  var isAndroid = /Android/.test(ua);
  var isSamsung = /SamsungBrowser/.test(ua);
  var isMobile = isIOS || isAndroid;
  var deferred = null; // the browser's install prompt, kept for the Install button

  function mq(q) { return !!(window.matchMedia && window.matchMedia(q).matches); }
  I.installed = function () {
    return navigator.standalone === true || mq('(display-mode: standalone)') || mq('(display-mode: fullscreen)') || mq('(display-mode: minimal-ui)');
  };
  I.platform = function () { return isIOS ? (isIPad ? 'ipad' : 'iphone') : isAndroid ? 'android' : 'computer'; };
  I.canPrompt = function () { return !!deferred; };
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { return null; } return null; }
  function ui() { return window.PVM || {}; }
  I.appUrl = function () { return new URL('./', window.location.href).href; };

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); // the app shows its own Install button and tip instead of the browser's bar
    deferred = e; render();
  });
  window.addEventListener('appinstalled', function () {
    deferred = null; render();
    var U = ui(); if (U.toast) U.toast('The app is installed. Open it from its icon on the home screen or in the app list.', 'ok', 8000);
  });

  // ------------------------------------------------------------------
  // Buttons and the one-time tip
  // ------------------------------------------------------------------
  function render() {
    var inst = I.installed();
    ['btn-install', 'login-install'].forEach(function (id) { var b = document.getElementById(id); if (b) b.hidden = inst; });
    var bar = document.getElementById('installbar');
    if (!bar) return;
    var signed = !!(window.PVM && window.PVM.S && window.PVM.S.user);
    var show = signed && !inst && isMobile && !store(LS_TIP);
    bar.hidden = !show;
    if (!show || bar.childNodes.length) return;
    var go = document.createElement('button'); go.type = 'button'; go.className = 'btn small primary'; go.id = 'installbar-go';
    go.textContent = isIOS ? 'How to install' : 'Install';
    go.addEventListener('click', function () { if (deferred) I.prompt(); else I.open(); });
    var no = document.createElement('button'); no.type = 'button'; no.className = 'btn small ghost'; no.id = 'installbar-no'; no.textContent = 'Not now';
    no.addEventListener('click', function () { store(LS_TIP, String(Date.now())); bar.hidden = true; });
    var txt = document.createElement('span');
    txt.textContent = 'Install this app on your ' + (isIPad || (isAndroid && !/Mobile/.test(ua)) ? 'tablet' : 'phone') + ': it opens from the home screen, full screen, and works without signal.';
    var btns = document.createElement('div'); btns.className = 'ib-btns';
    btns.appendChild(go); btns.appendChild(no);
    bar.appendChild(txt); bar.appendChild(btns);
  }
  I.render = render;

  // the browser's own install dialog (Android, computers)
  I.prompt = function () {
    if (!deferred) { I.open(); return Promise.resolve(false); }
    var e = deferred; deferred = null;
    e.prompt();
    return e.userChoice.then(function (c) {
      render();
      if (c && c.outcome === 'accepted') { var U = ui(); if (U.closeModal) U.closeModal(); return true; }
      return false;
    }, function () { render(); return false; });
  };

  // ------------------------------------------------------------------
  // How to install, per device, and how to put it on other devices
  // ------------------------------------------------------------------
  var SVGNS = 'http://www.w3.org/2000/svg';
  function shareIcon() {
    // the iOS Share symbol: a box with an arrow pointing up
    var s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('class', 'inst-ico'); s.setAttribute('aria-label', 'Share');
    var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', 'M10 2v11M6.5 5.5 10 2l3.5 3.5M6 8H4.5v10h11V8H14');
    s.appendChild(p); return s;
  }
  function menuIcon() {
    var s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('class', 'inst-ico'); s.setAttribute('aria-label', 'Menu');
    [5, 10, 15].forEach(function (y) { var c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', '10'); c.setAttribute('cy', String(y)); c.setAttribute('r', '1.6'); s.appendChild(c); });
    return s;
  }
  function steps(h, kind) {
    var li = function () { return h.apply(null, ['li', null].concat(Array.prototype.slice.call(arguments))); };
    var b = function (t) { return h('strong', { text: t }); };
    if (kind === 'iphone' || kind === 'ipad') {
      return h('ol', { class: 'inst-steps' },
        li('Open the app link in ', b('Safari'), '. (With iOS 16.4 or later, Chrome and Edge also work, through their Share button.)'),
        li('Tap ', b('Share'), ' ', shareIcon(), kind === 'ipad' ? ' at the top right of the screen.' : ' at the bottom of the screen.'),
        li('Scroll down and tap ', b('Add to Home Screen'), '.'),
        li('Tap ', b('Add'), '. Open the app from its icon on the home screen.'));
    }
    if (kind === 'android') {
      return h('ol', { class: 'inst-steps' },
        li('Open the app link in ', b('Chrome'), '.'),
        li('Tap ', b('Install now'), ' above, or open the menu ', menuIcon(), ' and tap ', b('Install app'), ' (on some phones ', b('Add to Home screen'), ').'),
        li('Tap ', b('Install'), '. The app appears on the home screen and in the app list.'),
        li('Samsung Internet: menu ', b('≡'), ' → ', b('Add page to'), ' → ', b('Home screen'), '.'));
    }
    return h('ol', { class: 'inst-steps' },
      li('Open the app link in ', b('Chrome'), ' or ', b('Edge'), ' on the computer.'),
      li('Click ', b('Install now'), ' above, or the install icon at the right end of the address bar, or the browser menu → ', b('Install'), '.'),
      li('The app opens in its own window and gets an icon on the desktop or in the Start menu.'));
  }

  // QR code of the app link (qrcode.js, MIT), drawn as SVG; also saved as a picture
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'qrcode.js' + (PAGE_V ? '?v=' + PAGE_V : '');
      s.onload = function () { res(window.qrcode); }; s.onerror = function () { rej(new Error('QR code not available')); };
      document.head.appendChild(s);
    });
  }
  function qrMatrix(text) {
    var q = window.qrcode(0, 'M'); q.addData(text); q.make();
    var n = q.getModuleCount(), m = [];
    for (var r = 0; r < n; r++) { var row = []; for (var c = 0; c < n; c++) row.push(q.isDark(r, c)); m.push(row); }
    return m;
  }
  function qrSvg(m) {
    var n = m.length, pad = 4, d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) d += 'M' + (c + pad) + ' ' + (r + pad) + 'h1v1h-1z';
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 ' + (n + 2 * pad) + ' ' + (n + 2 * pad)); s.setAttribute('class', 'qr'); s.setAttribute('role', 'img');
    s.setAttribute('aria-label', 'QR code of the app link'); s.setAttribute('shape-rendering', 'crispEdges');
    var bg = document.createElementNS(SVGNS, 'rect'); bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#ffffff');
    var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); p.setAttribute('fill', '#15212c');
    s.appendChild(bg); s.appendChild(p); return s;
  }
  function qrPng(m, scale) {
    var n = m.length, pad = 4, size = (n + 2 * pad) * scale, cv = document.createElement('canvas');
    cv.width = size; cv.height = size + 14 * scale;
    var x = cv.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, cv.width, cv.height); x.fillStyle = '#15212c';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (m[r][c]) x.fillRect((c + pad) * scale, (r + pad) * scale, scale, scale);
    x.font = '600 ' + (5 * scale) + 'px sans-serif'; x.textAlign = 'center';
    x.fillText('Solar PV Installation Monitoring', size / 2, size + 6 * scale);
    return cv;
  }

  I.open = function (tab) {
    var U = ui(), h = U.h; if (!h) return;
    var inst = I.installed(), kind = tab || I.platform(), url = I.appUrl();
    var body = [];
    body.push(h('p', { class: 'small', text: 'Installed, the app opens from its own icon like other apps, full screen, and works without signal. It installs from the browser: no app store is needed, and it updates itself.' }));
    if (inst) body.push(h('div', { class: 'notice info', text: 'This app is already installed on this device.' }));
    else if (deferred) body.push(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn primary', id: 'inst-now', text: 'Install now', onclick: function () { I.prompt(); } })));
    if (!inst) {
      var tabs = [['iphone', 'iPhone'], ['ipad', 'iPad'], ['android', 'Android'], ['computer', 'Computer']];
      body.push(h('div', { class: 'seg inst-tabs', role: 'group', 'aria-label': 'Device' }, tabs.map(function (t) {
        return h('button', { type: 'button', 'aria-pressed': String(t[0] === kind), 'data-inst': t[0], text: t[1], onclick: function () { I.open(t[0]); } });
      })));
      body.push(steps(h, kind));
      body.push(h('p', { class: 'small muted', text: 'After installing, sign in once in the app. Open it once while connected (and the Piles tab), so it also works without signal.' }));
    }
    // other devices: QR code and link
    var qrBox = h('div', { class: 'qr-box', id: 'inst-qr' }, h('p', { class: 'small muted', text: 'Loading the QR code…' }));
    var acts = [];
    if (navigator.share) acts.push(h('button', { type: 'button', class: 'btn small', id: 'inst-share', text: 'Share link', onclick: function () {
      navigator.share({ title: 'Solar PV Installation Monitoring', text: 'Open this link, then install the app (Add to Home Screen).', url: url }).catch(function () { /* closed */ });
    } }));
    acts.push(h('button', { type: 'button', class: 'btn small', id: 'inst-copy', text: 'Copy link', onclick: function (e) {
      var btn = e.currentTarget;
      var done = function (ok) { btn.textContent = ok ? 'Copied' : 'Select the link and copy it'; setTimeout(function () { btn.textContent = 'Copy link'; }, 1800); };
      if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(false); }); else done(false);
    } }));
    var save = h('button', { type: 'button', class: 'btn small', id: 'inst-save', text: 'Save QR code as picture', disabled: true });
    acts.push(save);
    body.push(h('h3', { class: 'ph3', text: 'Put it on another phone or tablet' }),
      h('p', { class: 'small', text: 'Scan this code with the phone\'s camera, or send the link. Then install as shown above. Each person signs in with their own account.' }),
      qrBox, h('p', { class: 'inst-link', text: url }), h('div', { class: 'btn-row' }, acts));
    body.push(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', text: 'Close', onclick: U.closeModal })));
    U.openModal(inst ? 'The app on your devices' : 'Install the app', body);
    loadQr().then(function () {
      var m = qrMatrix(url);
      qrBox.textContent = ''; qrBox.appendChild(qrSvg(m));
      save.disabled = false;
      save.onclick = function () {
        var a = document.createElement('a'); a.download = 'pv-monitoring-app-qr.png'; a.href = qrPng(m, 10).toDataURL('image/png');
        document.body.appendChild(a); a.click(); a.remove();
      };
    }, function () { qrBox.textContent = 'The QR code needs a connection the first time. Use Share link or Copy link instead.'; });
  };

  // ------------------------------------------------------------------
  // A new version is ready (installed apps are rarely reloaded)
  // ------------------------------------------------------------------
  function askVersion() {
    return new Promise(function (res) {
      var c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!c || !window.MessageChannel) return res(null);
      var ch = new MessageChannel(), t = setTimeout(function () { res(null); }, 3000);
      ch.port1.onmessage = function (e) { clearTimeout(t); res(e.data); };
      c.postMessage('pvm-version', [ch.port2]);
    });
  }
  function showUpdate() {
    var bar = document.getElementById('updatebar'); if (!bar || !bar.hidden) return;
    bar.textContent = '';
    var t = document.createElement('span'); t.textContent = 'A new version of the app is ready. ';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn small primary'; b.id = 'update-reload'; b.textContent = 'Reload now';
    b.addEventListener('click', function () { window.location.reload(); });
    bar.appendChild(t); bar.appendChild(b); bar.hidden = false;
  }
  I.showUpdate = showUpdate;
  if ('serviceWorker' in navigator) {
    var had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!had) { had = true; return; } // first install: this page is already the newest
      askVersion().then(function (v) { if (v && PAGE_V && v !== PAGE_V) showUpdate(); });
    });
    // look for a new version now and then while the app stays open
    var lastCheck = Date.now();
    function check() {
      if (!navigator.onLine || Date.now() - lastCheck < 1800000) return;
      lastCheck = Date.now();
      navigator.serviceWorker.getRegistration().then(function (r) { if (r) r.update().catch(function () { /* offline */ }); });
    }
    document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
    setInterval(check, 600000);
  }

  document.addEventListener('DOMContentLoaded', function () {
    ['btn-install', 'login-install'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', function () { var pop = document.getElementById('user-pop'); if (pop) pop.hidden = true; I.open(); });
    });
    render();
    if (window.matchMedia) {
      var m = window.matchMedia('(display-mode: standalone)');
      if (m.addEventListener) m.addEventListener('change', render);
    }
  });
})();
