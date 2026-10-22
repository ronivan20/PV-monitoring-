/* PV Module Serial Numbers — staying in sync with weak or no signal:
   connection state, polling for changes, the offline copy of the module records, uploading the
   registrations saved on this phone, the offline app files (service worker) and the status shown
   in the header chip, the offline banner and the "Connection and uploads" panel. */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, el = u.el, api = SN.api, S = SN.state, core = window.PVSN_SYNC;
  var Y = (SN.sync = {});
  var POLL_MS = ((window.SN_CONFIG || {}).pollSeconds || 15) * 1000;
  var REGISTER_ROLES = ['admin', 'encoder', 'qaqc'];

  S.online = null;          // null = not known yet, true = server reachable, false = no connection
  S.outbox = 0; S.outboxErrors = 0; S.outboxOthers = 0;

  // ---------- clock: the phone's time corrected to the server's ----------
  var clock = { o: 0, at: 0 };
  try { var c0 = JSON.parse(localStorage.getItem('pvsn.clock')); if (c0 && typeof c0.o === 'number') clock = c0; } catch (e) { /* none yet */ }
  function noteServerTime(iso, sentAt, gotAt) {
    var t = Date.parse(iso);
    if (isNaN(t) || gotAt - sentAt > 8000) return;          // too slow an answer to be precise
    var o = Math.round(t - (sentAt + gotAt) / 2);
    if (Math.abs(o) > 3.2e10) return;
    clock = { o: o, at: Date.now() };
    try { localStorage.setItem('pvsn.clock', JSON.stringify(clock)); } catch (e) { /* ignore */ }
  }
  SN.now = function () { return Date.now() + (clock.o || 0); };
  Y.clockOffset = function () { return clock.o || 0; };

  // ---------- connection state ----------
  function setOnline(v) {
    if (v) S.lastContact = Date.now();
    if (S.online === v) return;
    var was = S.online;
    S.online = v;
    render();
    SN.bus.emit('online', v);
    if (v && was === false && S.booted) onReconnect();
  }
  Y.setOnline = setOnline;
  SN.bus.on('net', function (ok) { setOnline(!!ok); });
  window.addEventListener('online', function () { if (S.booted) { nextAt = 0; poll(true); flushSoon(200); } });
  window.addEventListener('offline', function () { setOnline(false); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !S.booted) return;
    poll(true); flushSoon(500); checkForUpdate();
  });
  function onReconnect() {
    u.toast(S.outbox ? 'Back online · uploading ' + S.outbox + ' saved registration' + (S.outbox === 1 ? '' : 's') : 'Back online.', 'ok', 2500);
    flushSoon(100);
    poll(true);
  }

  // ---------- polling for changes (tables, users, settings) ----------
  var timer = null, polling = false, fails = 0, nextAt = 0;
  Y.start = function (fromCache) {
    Y.stop();
    nextAt = 0;
    timer = setInterval(function () { if (!document.hidden) tick(); }, 3000);
    updateOutboxBadge();
    poll(true);
    if (!fromCache) syncRecords();
    setTimeout(warmOcr, 8000);
    persistStorage();
    render();
  };
  Y.stop = function () { if (timer) clearInterval(timer); timer = null; };
  function tick() {
    if (!S.booted || Date.now() < nextAt) return;
    poll(false);
    if (S.outbox > S.outboxErrors && S.online !== false && !S.flushing && Date.now() - (S.lastFlush || 0) > 20000) flushSoon(0);
  }
  function backoff(ok) {
    fails = ok ? 0 : Math.min(fails + 1, 4);
    nextAt = Date.now() + (ok ? POLL_MS : Math.min(60000, POLL_MS * Math.pow(2, fails - 1)));
  }
  function poll(force) {
    if (!S.booted || polling) return Promise.resolve();
    if (!force && document.hidden) return Promise.resolve();
    if (navigator.onLine === false) { setOnline(false); backoff(false); return Promise.resolve(); }
    polling = true;
    var sent = Date.now();
    return api.call('sn_changes', { p_since: S.serverTime }, { timeout: 15000 }).then(function (r) {
      polling = false;
      noteServerTime(r.server_time, sent, Date.now());
      S.serverTime = r.server_time; S.lastSync = Date.now();
      if (r.user && S.me && r.user.role !== S.me.role) {
        u.toast('Your role was changed by the administrator. Reloading…');
        setTimeout(function () { location.reload(); }, 1500);
      }
      if (r.users) SN.applyUsers(r.users);
      if (r.settings) { S.settings = r.settings; SN.bus.emit('settings'); }
      var fresh = (r.tables || []).filter(function (a) { var t = S.tables.get(a[0]); return !t || t.updated !== a[20]; });
      SN.applyTables(r.tables);
      SN.store.patchSnapshot(fresh, { server_time: r.server_time, user: r.user || undefined, settings: r.settings || undefined, users: r.users || undefined });
      backoff(true);
      render();
      if (fresh.length || Date.now() - RS.lastRun > 60000) syncRecords();
    }, function () {
      polling = false;
      backoff(false);
      render();
    });
  }
  Y.poll = poll;
  SN.poll = function () { nextAt = 0; return poll(true); };

  // ---------- offline copy of the module records ----------
  var RS = (Y.rs = { running: false, lastRun: 0, st: null, error: null });
  function syncRecords() {
    if (RS.running || !S.booted || S.online === false || !S.me || S.noRecordSync) return Promise.resolve();
    RS.running = true; RS.error = null;
    render();
    var locks = navigator.locks, p;
    // one download at a time, also across several open tabs
    if (locks && locks.request) p = locks.request('pvsn-records-sync', { ifAvailable: true }, function (lock) { return lock ? runRecords() : null; });
    else p = runRecords();
    return Promise.resolve(p).then(function () {
      RS.running = false; RS.lastRun = Date.now(); render(); SN.bus.emit('records-sync');
    }, function (e) {
      RS.running = false; RS.lastRun = Date.now(); RS.error = e && e.message;
      // database update 2 not installed yet: the app works online, without the offline copy of the records
      if (e && e.code === 'NOT_SET_UP') S.noRecordSync = true;
      render();
    });
  }
  Y.syncRecords = syncRecords;
  function runRecords() {
    var me = S.me.id;
    return SN.store.get('recsync').then(function (st) {
      if (!st || st.v !== 1 || st.user_id !== me) st = freshState(me);
      RS.st = st;
      return step(st, 0);
    });
  }
  function freshState(me) { return { v: 1, user_id: me, mode: 'full', after: 0, since: null, count: 0, complete: false }; }
  function step(st, pages) {
    if (pages >= 60 || S.online === false || !S.booted || !S.me || S.me.id !== st.user_id) return SN.store.set('recsync', st);
    var full = st.mode === 'full';
    var args = full ? { p_since: null, p_after_xid: null, p_after_id: st.after || 0, p_limit: 3000 }
      : { p_since: st.since, p_after_xid: st.pageXid || null, p_after_id: st.pageId || null, p_limit: 2000 };
    return api.call('sn_sync', args, { timeout: 45000 }).then(function (r) {
      if (r.reset) {
        var fresh = freshState(st.user_id);
        RS.st = fresh;
        return SN.store.clearRecords().then(function () { return step(fresh, pages + 1); });
      }
      if (full && !st.after) { st.fullXmin = r.xmin; st.count = 0; st.total = r.total; }
      if (!full && !st.pageXid) st.pageXmin = r.xmin;
      return SN.store.applySync(r.rows).then(function (tids) {
        if (full) {
          st.after = r.last_id || st.after; st.count += (r.rows || []).length;
          if (r.done) { st.mode = 'changes'; st.since = st.fullXmin; st.complete = true; st.completedAt = Date.now(); st.pageXid = null; st.pageId = null; }
        } else if (r.done) {
          st.since = st.pageXmin || st.since; st.pageXid = null; st.pageId = null; st.pageXmin = null;
        } else {
          st.pageXid = r.last_xid; st.pageId = r.last_id;
        }
        st.at = Date.now();
        return SN.store.set('recsync', st).then(function () {
          if (tids.size) SN.bus.emit('records', tids);
          render();
          if (full || !r.done) return step(st, pages + 1);
          return null;
        });
      });
    });
  }

  // ---------- uploads (outbox) ----------
  var flushTimer = null;
  function flushSoon(ms) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(function () { flush(); }, ms === undefined ? 300 : ms);
  }
  Y.flushSoon = flushSoon;
  function flush(opts) {
    if (!S.booted || !api.token() || Y.paused) return Promise.resolve(null);
    if (S.flushing) return S.flushing;
    S.lastFlush = Date.now();
    if (navigator.onLine === false) { setOnline(false); bgSync(); return Promise.resolve(null); }
    S.flushing = api.outbox.flush(opts).then(function (r) {
      S.flushing = null;
      if (r && core.STOP[r.stopped] && r.stopped !== 'SESSION') bgSync();
      return updateOutboxBadge().then(function () { return r; });
    }, function (e) {
      S.flushing = null; updateOutboxBadge();
      throw e;
    });
    render();
    return S.flushing;
  }
  Y.flush = flush;
  function bgSync() {
    // Android/Chrome: let the browser upload later even if the app is closed
    if (!swOk || !S.outbox) return;
    navigator.serviceWorker.ready.then(function (reg) { if (reg.sync) return reg.sync.register('pvsn-outbox'); }).catch(function () { /* not supported */ });
  }
  Y.bgSync = bgSync;
  function updateOutboxBadge() {
    return api.outbox.list().then(function (items) {
      var mine = items.filter(function (i) { return S.me && i.user_id === S.me.id; });
      S.outbox = mine.length;
      S.outboxErrors = mine.filter(function (i) { return i.state === 'error'; }).length;
      S.outboxOthers = items.length - mine.length;
      render();
      SN.bus.emit('outbox-list', mine);
      return mine;
    });
  }
  SN.updateOutboxBadge = updateOutboxBadge;
  Y.queued = function (item) {
    // a registration was just saved on this phone
    return updateOutboxBadge().then(function () { bgSync(); flushSoon(150); });
  };

  // events from the outbox, whether this page or the service worker uploaded
  var review = [], failed = [], noteTimer = null;
  core.on(function (m) {
    if (m.type === 'changed') { if (S.booted) updateOutboxBadge(); return; }
    if (!S.booted) return;
    if (m.type === 'sending') { S.sending = m.uid; render(); return; }
    if (m.type === 'sent') {
      S.sending = null;
      SN.bus.emit('net', true);
      if (m.res && m.res.tables) SN.applyTables(m.res.tables);
      if (m.res && m.res.record) {
        SN.store.putServerRecords([m.res.record]);
        if (m.res.record.status === 'needs_review') review.push(m);
      }
      SN.bus.emit('uploaded', m);
      noteLater();
    } else if (m.type === 'failed') {
      S.sending = null;
      failed.push(m);
      noteLater();
    }
  });
  function noteLater() {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () {
      if (failed.length === 1) {
        var f = failed[0];
        u.toast('Not uploaded: ' + f.label + ' P' + f.pos + ' (' + f.serial + ') — ' + f.message, 'error', 9000);
      } else if (failed.length) {
        u.toast(failed.length + ' registrations were not accepted by the server. Open "Connection and uploads" (top right) to see why.', 'error', 9000);
      }
      if (review.length === 1) {
        var x = review[0], iss = ((x.res.record.issues || []).filter(function (i) { return i !== 'manual'; }).map(function (i) { return u.ISSUE[i] || i; }).join(', '));
        u.toast('Uploaded ' + x.label + ' P' + x.pos + ' — sent to QA/QC review' + (iss ? ' (' + iss + ')' : '') + '.', 'warn', 7000);
      } else if (review.length) {
        u.toast('Uploaded. ' + review.length + ' of them were sent to QA/QC review.', 'warn', 7000);
      }
      failed = []; review = [];
    }, 1200);
  }

  // ---------- header chip and offline banner ----------
  function render() {
    var chip = u.$('#sync-btn');
    if (!chip) return;
    var txt = u.$('#sync-text'), label;
    chip.classList.remove('ok', 'warn', 'bad', 'off');
    if (S.online === false) {
      chip.classList.add(S.outboxErrors ? 'bad' : 'off');
      label = S.outbox ? 'Offline · ' + S.outbox + ' saved' : 'Offline';
    } else if (S.outboxErrors) { chip.classList.add('bad'); label = S.outboxErrors + ' not uploaded'; }
    else if (S.outbox) { chip.classList.add('warn'); label = 'Uploading ' + S.outbox; }
    else if (S.online === null) { chip.classList.add('off'); label = 'Connecting…'; }
    else { chip.classList.add('ok'); label = 'Live'; }
    txt.textContent = label;
    chip.title = 'Last update from the server: ' + (S.lastSync ? u.ago(S.lastSync) : 'never') + '. Select for details.';
    var b = u.$('#net-banner');
    if (!b) return;
    var off = S.online === false && S.booted;
    b.hidden = !off;
    if (!off) return;
    u.clear(b).appendChild(el('button.net-btn', { type: 'button', on: { click: function () { SN.views.syncPanel(); } } },
      u.icon('wifi', 16),
      el('span', el('strong', 'No signal'), ' · working from the copy on this phone' + (S.lastSync ? ' (updated ' + u.ago(S.lastSync) + ')' : '') + '.',
        el('span.net-extra', SN.can.register() ? ' Saving still works; uploads start by themselves when the signal is back.' : ''))));
  }
  Y.render = render;
  setInterval(render, 30000);

  // ---------- app files on this phone (service worker) ----------
  var swOk = 'serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname));
  Y.swSupported = swOk;
  var lastUpdateCheck = Date.now();
  function checkForUpdate() {
    if (!swOk || !Y.reg || S.online === false || Date.now() - lastUpdateCheck < 30 * 60000) return;
    lastUpdateCheck = Date.now();
    Y.reg.update().catch(function () { /* offline */ });
  }
  if (swOk) {
    var hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function (reg) { Y.reg = reg; }).catch(function () { /* not available */ });
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadController) showUpdateBar();
      hadController = true;
    });
  }
  function showUpdateBar() {
    if (u.$('#update-bar')) return;
    document.body.appendChild(el('div.update-bar#update-bar', { role: 'status' },
      el('span', 'A new version of the app is ready.'),
      el('button.btn.small.primary', { type: 'button', on: { click: function () {
        if (S.flushing) { u.toast('Finishing an upload first…'); S.flushing.then(function () { location.reload(); }, function () { location.reload(); }); }
        else location.reload();
      } } }, 'Reload'),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Later', on: { click: function () { u.$('#update-bar').remove(); } } }, u.icon('x', 18))));
  }
  function askWorker(msg, ms) {
    return new Promise(function (resolve) {
      var c = navigator.serviceWorker && navigator.serviceWorker.controller;
      if (!c || typeof MessageChannel === 'undefined') { resolve(null); return; }
      var ch = new MessageChannel(), done = false;
      ch.port1.onmessage = function (e) { done = true; resolve(e.data); };
      setTimeout(function () { if (!done) resolve(null); }, ms || 2000);
      c.postMessage(msg, [ch.port2]);
    });
  }
  Y.askWorker = askWorker;

  // OCR engine (≈6 MB) for reading label text without signal: fetched once, in the background.
  function simd() {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  }
  function ocrFiles() {
    var core0 = simd() ? 'tesseract-core-simd-lstm' : 'tesseract-core-lstm';
    return [core0 + '.js', core0 + '.wasm', 'eng.traineddata.gz'];
  }
  function warmOcr(force) {
    if (!swOk || !S.me || REGISTER_ROLES.indexOf(S.me.role) < 0 || S.online === false) return Promise.resolve(null);
    var conn = navigator.connection || {};
    if (!force && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || ''))) return Promise.resolve(null);
    return askWorker({ type: 'warm-ocr', files: ocrFiles() }, 180000);
  }
  Y.warmOcr = warmOcr;

  // "Install" on the home screen (Android/Chrome offers it; iPhone: Share › Add to Home Screen).
  // Installed, the app opens like any other app and the browser keeps its saved data.
  var installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; SN.bus.emit('installable'); });
  window.addEventListener('appinstalled', function () { installEvt = null; SN.bus.emit('installable'); persistStorage(); });
  Y.standalone = function () {
    try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; }
  };
  Y.canInstall = function () { return !!installEvt; };
  Y.install = function () {
    if (!installEvt) return Promise.resolve(false);
    var e = installEvt; installEvt = null;
    e.prompt();
    return e.userChoice.then(function (c) { return !!(c && c.outcome === 'accepted'); }, function () { return false; });
  };
  Y.isIOS = function () { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); };

  function persistStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persisted().then(function (p) { if (!p) return navigator.storage.persist(); return p; }).then(function (p) { S.persisted = !!p; }, function () {});
      }
    } catch (e) { /* not supported */ }
  }

  // Everything the "Connection and uploads" panel shows about being ready for no signal.
  Y.status = function () {
    var est = navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().catch(function () { return null; }) : Promise.resolve(null);
    var ps = navigator.storage && navigator.storage.persisted ? navigator.storage.persisted().catch(function () { return null; }) : Promise.resolve(null);
    return Promise.all([
      swOk ? askWorker({ type: 'status' }, 2500) : Promise.resolve(null),
      SN.store.get('recsync').catch(function () { return null; }),
      SN.store.recordCount(),
      est, ps
    ]).then(function (a) {
      var w = a[0], want = ocrFiles();
      return {
        swSupported: swOk, controlled: !!(swOk && navigator.serviceWorker.controller),
        worker: w, shellReady: !!(w && w.shell && w.shell.have >= w.shell.want && w.shell.want > 0),
        ocrReady: !!(w && w.ocr && want.every(function (f) { return w.ocr.indexOf(f) >= 0; })),
        bgSync: !!(swOk && 'SyncManager' in window),
        rec: a[1] || RS.st, recCount: a[2] || 0, recRunning: RS.running, recError: RS.error, noRecordSync: !!S.noRecordSync,
        usage: a[3] && a[3].usage, quota: a[3] && a[3].quota, persisted: a[4]
      };
    });
  };
})();
