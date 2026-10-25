/* Solar PV Installation Monitoring — working without signal (update 10).
   - Keeps what the app downloaded in this phone's storage (IndexedDB), so the keyplans, piles and
     dashboards open without signal.
   - Keeps updates saved without signal in an outbox on this phone and sends them, in the order they
     were made, as soon as the connection is back. Each one carries a reference made here; the
     database saves each reference only once (sync_offline), so sending again after a dropped
     answer never saves twice.
   - Nothing is overwritten silently: when someone else changed the same section meanwhile, the
     server refuses the update and the user decides here (keep mine / discard mine).
   The app (app.js, piles.js) tells this file how to reach the server and what each save changes. */
(function () {
  'use strict';
  var O = window.PVMOffline = {};
  var DB_NAME = 'pvm-offline';
  var LS_WHO = 'pvm.who';
  var CACHE_MAX = 600;            // saved answers per user (screens, histories); the oldest go first
  var KEEP = { get_bootstrap: 1, get_quality: 1, get_comments: 1, get_piles: 1 };
  var RETRY_MS = 15000;

  var db = null, dbTried = false;
  O.items = [];                   // this user's outbox, oldest first
  O.uid = null; O.username = null; O.dbVersion = 0;
  O.online = navigator.onLine !== false;
  O.dataAt = null;                // time of the saved data shown while offline
  O.lastOnline = null;
  O.pend = emptyPend();
  O.hooks = {};                   // set by the app: transport, refresh, serverExpected
  var listeners = { change: [], synced: [] };
  O.on = function (ev, fn) { listeners[ev].push(fn); };
  function emit(ev, a, b) { listeners[ev].forEach(function (f) { try { f(a, b); } catch (e) { if (window.console) console.error(e); } }); }

  // ------------------------------------------------------------------
  // Storage on this phone
  // ------------------------------------------------------------------
  function openDb() {
    if (db || dbTried) return Promise.resolve(db);
    dbTried = true;
    return new Promise(function (res) {
      var req;
      try { req = window.indexedDB.open(DB_NAME, 1); } catch (e) { return res(null); }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'k' }).createIndex('uid', 'uid');
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'ref' }).createIndex('uid', 'uid');
      };
      req.onsuccess = function () {
        db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* closing */ } db = null; };
        res(db);
      };
      req.onerror = function () { res(null); };
      req.onblocked = function () { res(null); };
    });
  }
  function done(t) {
    return new Promise(function (res, rej) {
      t.oncomplete = function () { res(); };
      t.onerror = t.onabort = function () { rej(t.error || new Error('Storage error')); };
    });
  }
  function getAll(name, uid) {
    if (!db) return Promise.resolve([]);
    return new Promise(function (res) {
      try {
        var r = db.transaction(name).objectStore(name).index('uid').getAll(uid);
        r.onsuccess = function () { res(r.result || []); };
        r.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  }
  O.init = function () { return openDb().then(function (d) { O.ready = !!d; registerWorker(); return O.ready; }); };

  // who was signed in on this phone (to open the right saved data without signal)
  O.who = function () { try { return JSON.parse(window.localStorage.getItem(LS_WHO) || 'null'); } catch (e) { return null; } };
  function setWho(u) { try { window.localStorage.setItem(LS_WHO, JSON.stringify({ id: u.id, username: u.username, full_name: u.full_name || '' })); } catch (e) { /* blocked */ } }

  // ------------------------------------------------------------------
  // Saved answers (what the screens downloaded)
  // ------------------------------------------------------------------
  function argKey(args) {
    var a = args || {}, o = {};
    Object.keys(a).sort().forEach(function (k) { if (k !== 'p_token') o[k] = a[k]; });
    return JSON.stringify(o);
  }
  function ckey(uid, fn, args) { return uid + '|' + fn + '|' + argKey(args); }
  O.cacheable = function (fn) { return /^get_/.test(fn) && fn !== 'get_changes' && fn !== 'get_pile_changes' && fn !== 'get_pile_file'; };
  O.cachePut = function (fn, args, data, uid) {
    uid = uid || O.uid;
    if (!db || !uid) return Promise.resolve();
    try {
      var t = db.transaction('cache', 'readwrite');
      t.objectStore('cache').put({ k: ckey(uid, fn, args), uid: uid, fn: fn, at: Date.now(), data: data });
      return done(t).catch(function () { /* storage full: the app still works online */ });
    } catch (e) { return Promise.resolve(); }
  };
  O.cacheGet = function (fn, args, uid) {
    uid = uid || O.uid;
    if (!db || !uid) return Promise.resolve(null);
    return new Promise(function (res) {
      try {
        var r = db.transaction('cache').objectStore('cache').get(ckey(uid, fn, args));
        r.onsuccess = function () { res(r.result || null); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  };
  // keep the saved copy of a big answer up to date with what the app merged since (no extra download)
  var patchTimers = {};
  O.cachePatch = function (fn, args, mutate, delay) {
    var key = fn + argKey(args);
    clearTimeout(patchTimers[key]);
    patchTimers[key] = setTimeout(function () {
      O.cacheGet(fn, args).then(function (hit) {
        if (!hit) return;
        var d = mutate(hit.data);
        if (d) O.cachePut(fn, args, d);
      });
    }, delay == null ? 3000 : delay);
  };
  function pruneCache(uid) {
    if (!db) return;
    getAll('cache', uid).then(function (rows) {
      var extra = rows.filter(function (r) { return !KEEP[r.fn]; }).sort(function (a, b) { return a.at - b.at; });
      var n = extra.length - CACHE_MAX;
      if (n <= 0) return;
      try { var st = db.transaction('cache', 'readwrite').objectStore('cache'); extra.slice(0, n).forEach(function (r) { st.delete(r.k); }); } catch (e) { /* later */ }
    });
  }
  // saved answers of other accounts are removed when someone signs in (their unsent updates stay)
  function purgeOthers(uid) {
    if (!db) return;
    try {
      var st = db.transaction('cache', 'readwrite').objectStore('cache');
      var r = st.openCursor();
      r.onsuccess = function () { var c = r.result; if (!c) return; if (c.value.uid !== uid) c.delete(); c.continue(); };
    } catch (e) { /* later */ }
  }
  O.forgetCache = function (uid) {
    if (!db || !uid) return Promise.resolve();
    return getAll('cache', uid).then(function (rows) {
      try { var t = db.transaction('cache', 'readwrite'), st = t.objectStore('cache'); rows.forEach(function (r) { st.delete(r.k); }); return done(t); } catch (e) { return null; }
    }).catch(function () { /* ignore */ });
  };

  // ------------------------------------------------------------------
  // Connection state
  // ------------------------------------------------------------------
  O.noteOnline = function () {
    var was = O.online;
    O.online = true; O.lastOnline = new Date();
    if (!was) { O.dataAt = null; changed(); O.sync(); }
  };
  O.noteOffline = function () { if (O.online) { O.online = false; changed(); } scheduleRetry(); };
  O.markStale = function (at) { if (at && (!O.dataAt || at < O.dataAt)) O.dataAt = at; changed(); };
  // the screens show the server's current data again
  O.fresh = function () { if (O.dataAt) { O.dataAt = null; changed(); } };
  window.addEventListener('online', function () { O.sync(); if (O.hooks.refresh) O.hooks.refresh(); });
  window.addEventListener('offline', function () { O.noteOffline(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && O.items.length) O.sync(); });

  // ------------------------------------------------------------------
  // Signed-in user
  // ------------------------------------------------------------------
  O.setUser = function (u, dbVersion) {
    if (!u) return Promise.resolve();
    var same = O.uid === u.id;
    O.uid = u.id; O.username = u.username; O.dbVersion = dbVersion || 0;
    setWho(u);
    if (same && O.loaded) { changed(); return Promise.resolve(); }
    O.loaded = false;
    return openDb().then(function () {
      purgeOthers(u.id); pruneCache(u.id);
      return loadItems();
    }).then(function () {
      O.loaded = true; changed();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () { /* not granted */ });
      O.sync();
    });
  };
  O.clearUser = function () { O.uid = null; O.username = null; O.items = []; O.loaded = false; O.pend = emptyPend(); changed(); };
  O.enabled = function () { return !!db && !!O.uid && O.dbVersion >= 10; };
  function loadItems() {
    return getAll('outbox', O.uid).then(function (rows) {
      O.items = rows.sort(function (a, b) { return a.seq - b.seq; });
      O.items.forEach(function (i) { if (i.state === 'sending') i.state = 'queued'; });
      rebuild();
    });
  }
  // unsent updates of other accounts on this phone (shown on the sign-in screen)
  O.othersPending = function () {
    if (!db) return Promise.resolve([]);
    return new Promise(function (res) {
      try {
        var r = db.transaction('outbox').objectStore('outbox').getAll();
        r.onsuccess = function () {
          var by = {};
          (r.result || []).forEach(function (i) { if (i.uid !== O.uid) by[i.username] = (by[i.username] || 0) + 1; });
          res(Object.keys(by).map(function (k) { return { username: k, n: by[k] }; }));
        };
        r.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  };

  // ------------------------------------------------------------------
  // Outbox
  // ------------------------------------------------------------------
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    var b = new Uint8Array(16); window.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var x = Array.prototype.map.call(b, function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }
  function refsIn(v, out) {
    out = out || [];
    if (typeof v === 'string') { if (v.slice(0, 4) === 'ref:') out.push(v.slice(4)); }
    else if (Array.isArray(v)) v.forEach(function (x) { refsIn(x, out); });
    else if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { refsIn(v[k], out); });
    return out;
  }
  function depsOf(args) { var r = refsIn(args); return r.filter(function (x, i) { return r.indexOf(x) === i; }); }
  function find(ref) { for (var i = 0; i < O.items.length; i++) if (O.items[i].ref === ref) return O.items[i]; return null; }
  function persist(item) {
    if (!db) return Promise.reject(new Error('No storage'));
    try {
      var t = db.transaction('outbox', 'readwrite');
      var copy = Object.assign({}, item); delete copy._p;
      t.objectStore('outbox').put(copy);
      return done(t);
    } catch (e) { return Promise.reject(e); }
  }
  function unpersist(ref) {
    if (!db) return Promise.resolve();
    try { var t = db.transaction('outbox', 'readwrite'); t.objectStore('outbox').delete(ref); return done(t).catch(function () { /* gone */ }); } catch (e) { return Promise.resolve(); }
  }
  function removeLocal(ref) { O.items = O.items.filter(function (i) { return i.ref !== ref; }); rebuild(); }
  var seqBase = Date.now();
  function nextSeq() { seqBase = Math.max(seqBase + 1, Date.now()); return seqBase; }
  function transient(e) { return !e || e.hint === 'network' || !e.status || e.status >= 500 || e.status === 408 || e.status === 429; }
  function timeoutFor(fn) { return fn === 'upload_pile_file' ? 180000 : 30000; }

  O.count = function () { return O.items.length; };
  O.reviewCount = function () { return O.items.filter(function (i) { return i.state === 'conflict' || i.state === 'failed'; }).length; };

  // Saves one update. Online: sent at once and answered like before (a refusal comes back as an
  // error and nothing is kept). No signal: kept here and answered with { queued: true }.
  O.submit = function (fn, args, meta) {
    var send0 = O.hooks.transport;
    if (!O.enabled()) return send0(fn, args);
    meta = meta || {};
    var clean = Object.assign({}, args); delete clean.p_token;
    var item = { ref: uuid(), uid: O.uid, username: O.username, fn: fn, args: clean, label: meta.label || fn, fx: meta.fx || null,
                 keys: meta.keys || [], deps: depsOf(clean), at: new Date().toISOString(), seq: nextSeq(), state: 'queued', tries: 0 };
    return persist(item).then(function () {
      O.items.push(item); rebuild(); changed();
      // an earlier update of the same section still waiting: this one waits too (order is kept)
      var waiting = item.deps.some(function (r) { return !!find(r); }) || O.items.some(function (x) {
        return x !== item && x.seq < item.seq && x.keys.some(function (k) { return item.keys.indexOf(k) >= 0; });
      });
      if (!O.online || waiting) { O.sync(); return { queued: true, ref: item.ref }; }
      return send(item, true);
    }, function () { return send0(fn, args); });
  };

  function send(item, first) {
    item.state = 'sending'; changed();
    return O.hooks.transport('sync_offline', { p_ref: item.ref, p_fn: item.fn, p_args: item.args, p_client_time: item.at }, timeoutFor(item.fn))
      .then(function (res) {
        return unpersist(item.ref).then(function () {
          removeLocal(item.ref); O.noteOnline(); changed();
          emit('synced', item, res || {}, first);
          return res;
        });
      }, function (e) {
        if (transient(e) || e.hint === 'session' || e.hint === 'password' || e.hint === 'version') {
          item.state = 'queued'; item.tries = (item.tries || 0) + 1;
          if (transient(e)) O.noteOffline();
          return persist(item).catch(function () { /* kept in memory */ }).then(function () {
            changed();
            if (first) return { queued: true, ref: item.ref };
            throw e;
          });
        }
        if (first) {
          // refused while online: same as before update 10 (nothing kept, the error is shown)
          return unpersist(item.ref).then(function () { removeLocal(item.ref); changed(); throw e; });
        }
        item.state = e.hint === 'conflict' ? 'conflict' : 'failed';
        item.error = { hint: e.hint || null, message: e.message || 'Not accepted.', detail: e.details || null };
        return persist(item).catch(function () { /* kept in memory */ }).then(function () { changed(); throw e; });
      });
  }

  var syncing = null, retryTimer = null, again = false;
  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!O.items.length) return;
    retryTimer = setTimeout(function () { O.sync(); }, RETRY_MS);
  }
  // sends what is waiting, oldest first; an update waits while an earlier one of the same
  // section is waiting, needs a decision, or is not sent yet
  O.sync = function () {
    if (syncing) { again = true; return syncing; }
    if (!O.enabled() || !O.loaded || !O.items.length || !O.hooks.transport) return Promise.resolve();
    again = false;
    syncing = loop().then(fin, fin);
    function fin(stopped) {
      syncing = null; changed();
      if (again && O.online && stopped !== 'stopped') { again = false; setTimeout(function () { O.sync(); }, 0); return; }
      if (O.items.some(function (i) { return i.state === 'queued'; })) scheduleRetry();
    }
    return syncing;
  };
  function loop() {
    var blocked = {}, stop = false, sent = 0;
    var list = O.items.slice().sort(function (a, b) { return a.seq - b.seq; });
    var chain = Promise.resolve();
    list.forEach(function (it) {
      chain = chain.then(function () {
        if (stop || !find(it.ref)) return;
        var wait = it.state !== 'queued' || it.keys.some(function (k) { return blocked[k]; }) ||
          it.deps.some(function (r) { return !!find(r); });
        if (wait) { it.keys.forEach(function (k) { blocked[k] = 1; }); return; }
        return send(it, false).then(function () { sent++; }, function (e) {
          if (transient(e) || e.hint === 'session' || e.hint === 'password' || e.hint === 'version') { stop = true; return; }
          it.keys.forEach(function (k) { blocked[k] = 1; });
        });
      });
    });
    return chain.then(function () {
      if (sent && O.hooks.toast) O.hooks.toast(sent === 1 ? 'Sent 1 update that was waiting on this phone.' : 'Sent ' + sent + ' updates that were waiting on this phone.', 'ok', 6000);
      return stop ? 'stopped' : 'done';
    });
  }

  // ---- decisions on refused updates
  function expectedOf(item, key) {
    var a = item.args, m;
    if (item.fn === 'submit_update') return a.p_expected_update_id === undefined ? null : a.p_expected_update_id;
    if (item.fn === 'bulk_submit_update' && (m = /^s:(\d+)\|/.exec(key))) return a.p_expected && a.p_expected[m[1]] !== undefined ? a.p_expected[m[1]] : null;
    if (item.fn === 'submit_pile_updates' && (m = /^p:(\d+)$/.exec(key))) return a.p_expected && a.p_expected[m[1]] !== undefined ? a.p_expected[m[1]] : null;
    return null;
  }
  // a discarded update: the ones made after it on the same sections follow what it was based on
  function inherit(dead) {
    var tag = 'ref:' + dead.ref, gone = [];
    O.items.forEach(function (x) {
      if (x.deps.indexOf(dead.ref) < 0) return;
      var a = x.args;
      if (x.fn === 'reply_comment' && a.p_comment_id === tag) { gone.push(x); return; }
      if (x.fn === 'upload_pile_file' && a.p_case_id === tag) a.p_case_id = null;
      if (x.fn === 'submit_update' && a.p_expected_update_id === tag) a.p_expected_update_id = expectedOf(dead, 's:' + a.p_section_id + '|' + a.p_activity);
      if ((x.fn === 'bulk_submit_update' || x.fn === 'submit_pile_updates') && a.p_expected) {
        Object.keys(a.p_expected).forEach(function (id) {
          if (a.p_expected[id] === tag) a.p_expected[id] = expectedOf(dead, x.fn === 'bulk_submit_update' ? 's:' + id + '|' + a.p_activity : 'p:' + id);
        });
      }
      x.deps = depsOf(a);
      persist(x).catch(function () { /* memory */ });
    });
    return gone;
  }
  O.discard = function (ref) {
    var it = find(ref); if (!it) return Promise.resolve();
    var gone = inherit(it);
    return unpersist(ref).then(function () {
      removeLocal(ref);
      return Promise.all(gone.map(function (g) { return O.discard(g.ref); }));
    }).then(function () { changed(); O.sync(); });
  };
  // keep mine: send again based on the server's current records (the other change stays in the history)
  O.keepMine = function (ref) {
    var it = find(ref); if (!it) return Promise.resolve();
    var refresh = O.hooks.refresh ? O.hooks.refresh() : Promise.resolve();
    return Promise.resolve(refresh).catch(function () { /* use what is known */ }).then(function () {
      var fn = O.hooks.serverExpected && O.hooks.serverExpected[it.fn];
      if (fn) fn(it);
      it.deps = depsOf(it.args);
      it.state = 'queued'; it.error = null;
      return persist(it).catch(function () { /* memory */ });
    }).then(function () { changed(); return O.sync(); });
  };
  O.retry = function (ref) {
    var it = find(ref); if (!it) return Promise.resolve();
    it.state = 'queued'; it.error = null;
    return persist(it).catch(function () { /* memory */ }).then(function () { changed(); return O.sync(); });
  };
  // bulk refused for some sections: send the others only
  O.withoutRefused = function (ref) {
    var it = find(ref); if (!it || !it.error || !it.fx || !it.fx.list) return Promise.resolve();
    var codes = [];
    try { codes = JSON.parse(it.error.detail || '[]'); } catch (e) { codes = []; }
    var keep = it.fx.list.filter(function (x) { return codes.indexOf(x.code) < 0; });
    if (!keep.length) return O.discard(ref);
    var ids = keep.map(function (x) { return x.id; }), a = it.args;
    if (a.p_section_ids) a.p_section_ids = ids;
    if (a.p_pile_ids) a.p_pile_ids = ids;
    if (a.p_expected) { var e = {}; ids.forEach(function (id) { e[id] = a.p_expected[id] === undefined ? null : a.p_expected[id]; }); a.p_expected = e; }
    it.fx.list = keep;
    it.keys = it.keys.filter(function (k) { var m = /^[sqp]i?:(\d+)/.exec(k); return !m || ids.indexOf(+m[1]) >= 0; });
    it.label = it.label.replace(/\d+ (sections|piles)/, ids.length + ' $1');
    it.deps = depsOf(a); it.state = 'queued'; it.error = null;
    return persist(it).catch(function () { /* memory */ }).then(function () { rebuild(); changed(); return O.sync(); });
  };
  function refusedCodes(it) {
    if (!it.error || !it.error.detail) return [];
    try { var c = JSON.parse(it.error.detail); return Array.isArray(c) ? c : []; } catch (e) { return []; }
  }

  // ------------------------------------------------------------------
  // What the waiting updates change on screen
  // ------------------------------------------------------------------
  function emptyPend() { return { sec: new Map(), cci: new Map(), cm: new Map(), reply: new Map(), pile: new Map(), pinsp: new Map(), pcase: new Map(), pfile: new Map() }; }
  function rebuild() {
    var P = emptyPend();
    O.items.slice().sort(function (a, b) { return a.seq - b.seq; }).forEach(function (it) {
      var f = it.fx; if (!f) return;
      var base = { ref: it.ref, pending: true, state: it.state, created_at: it.at, client_time: it.at, username: it.username, full_name: '' };
      if (f.t === 'sec') {
        f.list.forEach(function (x) {
          P.sec.set(x.id + '|' + f.act, Object.assign({}, base, { id: 'ref:' + it.ref, section_id: x.id, activity: f.act, status: f.status,
            company_id: x.company_id, company_name: x.company_name || '', remarks: f.remarks || null }));
        });
      } else if (f.t === 'cci') {
        f.list.forEach(function (x) {
          P.cci.set(x.id + '|' + (f.act || 'both'), Object.assign({}, base, { id: 'ref:' + it.ref, section_id: x.id, activity: f.act || null, status: f.status,
            inspection_date: f.insp || null, approval_date: f.appr || null }));
        });
      } else if (f.t === 'cm') {
        var l = P.cm.get(f.section_id) || []; l.push(Object.assign({}, base, { section_id: f.section_id, activity: f.act || null, body: f.body })); P.cm.set(f.section_id, l);
      } else if (f.t === 'reply') {
        var k = String(f.comment_id), r = P.reply.get(k) || []; r.push(Object.assign({}, base, { body: f.body, status: f.status || null })); P.reply.set(k, r);
      } else if (f.t === 'pile') {
        f.list.forEach(function (x) { P.pile.set(x.id, Object.assign({}, base, { uid: 'ref:' + it.ref, sid: f.sid })); });
      } else if (f.t === 'pinsp') {
        f.list.forEach(function (x) {
          P.pinsp.set(x.id, Object.assign({}, base, { sid: f.sid, date: f.date || null }));
          if (f.set) P.pile.set(x.id, Object.assign({}, base, { uid: 'ref:' + it.ref, sid: f.set }));
        });
      } else if (f.t === 'pcase') {
        var c = P.pcase.get(f.pile_id) || []; c.push(Object.assign({}, base, { id: 'ref:' + it.ref, kind: f.kind, st: 'open' })); P.pcase.set(f.pile_id, c);
        if (f.set) P.pile.set(f.pile_id, Object.assign({}, base, { uid: 'ref:' + it.ref, sid: f.set }));
      } else if (f.t === 'pfile') {
        P.pfile.set(f.pile_id, (P.pfile.get(f.pile_id) || 0) + 1);
      }
    });
    O.pend = P;
  }
  var panelTimer = null;
  function panelOpen() { var m = document.getElementById('modal'); return !!(m && !m.hidden && m.querySelector('[data-outbox]')); }
  function changed() {
    renderChip(); emit('change');
    if (panelOpen()) { clearTimeout(panelTimer); panelTimer = setTimeout(function () { if (panelOpen()) O.openPanel(true); }, 250); }
  }

  // ------------------------------------------------------------------
  // On screen: chip in the top bar, bar under it, and the list of waiting updates
  // ------------------------------------------------------------------
  function ui() { return window.PVM || {}; }
  function clock(d) {
    if (!d) return '';
    var x = d instanceof Date ? d : new Date(d), now = new Date();
    var t = x.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return x.toDateString() === now.toDateString() ? t : x.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + t;
  }
  O.statusText = function () {
    var n = O.items.length, rv = O.reviewCount();
    if (rv) return rv + ' to review';
    if (!O.online) return n ? 'Offline · ' + n + ' to send' : 'Offline';
    if (n) return syncing ? 'Sending ' + n + '…' : n + ' to send';
    return '';
  };
  function renderChip() {
    var chip = document.getElementById('netchip'), bar = document.getElementById('netbar');
    if (!chip || !bar) return;
    var n = O.items.length, rv = O.reviewCount(), signed = !!O.uid;
    var txt = signed ? O.statusText() : '';
    chip.hidden = !txt;
    chip.className = 'netchip' + (rv ? ' review' : !O.online ? ' off' : n ? ' wait' : '');
    document.getElementById('netchip-text').textContent = txt;
    var sh = document.getElementById('netchip-short');
    if (sh) sh.textContent = rv ? '! ' + rv : n ? '\u2191 ' + n : 'Offline';
    chip.setAttribute('aria-label', txt || 'Connection');
    bar.textContent = '';
    var msg = null;
    if (signed && rv) msg = [rv === 1 ? '1 update saved without signal needs your decision.' : rv + ' updates saved without signal need your decision.', 'Review'];
    else if (signed && !O.online) {
      var parts = ['No signal' + (O.dataAt ? ' · data saved ' + clock(O.dataAt) : '') + '.'];
      parts.push(O.dbVersion >= 10 ? 'Your updates are kept on this phone and sent when the signal is back.' : 'Saving needs a connection until the administrator installs database update 10.');
      if (n) parts.push(n === 1 ? '1 waiting.' : n + ' waiting.');
      msg = [parts.join(' '), n ? 'Details' : null];
    }
    bar.hidden = !msg;
    bar.className = 'netbar' + (rv ? ' review' : '');
    if (msg) {
      bar.appendChild(document.createTextNode(msg[0] + ' '));
      if (msg[1]) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'link-btn'; b.textContent = msg[1];
        b.addEventListener('click', function () { O.openPanel(); }); bar.appendChild(b);
      }
    }
    var lo = document.getElementById('login-offline');
    if (lo && !signed) {
      O.othersPending().then(function (list) {
        lo.hidden = !list.length;
        lo.textContent = list.map(function (x) { return 'This phone has ' + (x.n === 1 ? '1 update' : x.n + ' updates') + ' saved without signal by ' + x.username + ' and not sent yet. Sign in as ' + x.username + ' to send ' + (x.n === 1 ? 'it' : 'them') + '.'; }).join(' ');
      });
    }
  }
  O.render = renderChip;

  var STATE = { queued: 'Waiting to send', sending: 'Sending…', conflict: 'Needs your decision', failed: 'Not accepted' };
  O.openPanel = function (refreshOnly) {
    var U = ui(), h = U.h; if (!h) return;
    if (refreshOnly && !panelOpen()) return;
    var list = O.items.slice().sort(function (a, b) { return a.seq - b.seq; });
    var body = [h('span', { 'data-outbox': '1', hidden: true })];
    body.push(h('p', { class: 'small', text: O.online ? 'Connected' + (O.lastOnline ? ' · last contact with the server ' + clock(O.lastOnline) : '') + '.'
      : 'No signal' + (O.dataAt ? ' · the screens show what this phone saved at ' + clock(O.dataAt) : '') + '.' }));
    if (O.dbVersion < 10) body.push(h('div', { class: 'notice warn', text: 'Saving without signal needs database update 10. Until the administrator installs it, saving needs a connection.' }));
    if (!list.length) body.push(h('p', { class: 'small muted', text: 'Nothing is waiting: every update made on this phone has been sent.' }));
    else {
      body.push(h('p', { class: 'small', text: 'Kept on this phone until sent, in the order they were made. Each one is saved once, with the time it was made here.' }));
      body.push(h('ul', { class: 'outbox' }, list.map(function (it) {
        var acts = [];
        if (it.state === 'conflict') {
          acts.push(h('button', { type: 'button', class: 'btn small primary', text: 'Save mine anyway', onclick: function () { O.keepMine(it.ref); } }));
          if (refusedCodes(it).length && it.fx && it.fx.list && it.fx.list.length > 1) acts.push(h('button', { type: 'button', class: 'btn small', text: 'Send the others only', onclick: function () { O.withoutRefused(it.ref); } }));
          acts.push(h('button', { type: 'button', class: 'btn small danger', text: 'Discard mine', onclick: function () { confirmDiscard(it); } }));
        } else if (it.state === 'failed') {
          if (refusedCodes(it).length && it.fx && it.fx.list && it.fx.list.length > 1) acts.push(h('button', { type: 'button', class: 'btn small', text: 'Send the others only', onclick: function () { O.withoutRefused(it.ref); } }));
          acts.push(h('button', { type: 'button', class: 'btn small', text: 'Try again', onclick: function () { O.retry(it.ref); } }));
          acts.push(h('button', { type: 'button', class: 'btn small danger', text: 'Discard', onclick: function () { confirmDiscard(it); } }));
        }
        var waitFor = it.state === 'queued' && it.deps.map(find).filter(Boolean)[0];
        return h('li', { class: 'ob-item ob-' + it.state, 'data-ref': it.ref },
          h('div', { class: 'ob-top' }, h('span', { class: 'ob-state', text: STATE[it.state] || it.state }), h('span', { class: 'ob-time', text: 'saved here ' + clock(it.at) })),
          h('div', { class: 'ob-label', text: it.label }),
          it.error ? h('div', { class: 'ob-msg', text: it.error.message }) : null,
          it.state === 'conflict' ? h('div', { class: 'small muted', text: 'Save mine anyway keeps the other change in the history and adds yours as the latest. Discard mine drops yours.' }) : null,
          waitFor ? h('div', { class: 'small muted', text: 'Waits for: ' + waitFor.label }) : null,
          acts.length ? h('div', { class: 'btn-row' }, acts) : null);
      })));
    }
    var row = [];
    if (list.some(function (i) { return i.state === 'queued'; })) row.push(h('button', { type: 'button', class: 'btn primary', id: 'ob-send', text: 'Send now', onclick: function () { O.sync(); } }));
    row.push(h('button', { type: 'button', class: 'btn', text: 'Close', onclick: U.closeModal }));
    body.push(h('div', { class: 'btn-row' }, row));
    body.push(h('p', { class: 'small muted', text: 'Updates saved without signal stay only on this phone until they are sent. Do not clear this browser\'s data or uninstall the app while any are waiting.' }));
    if (refreshOnly) {
      // refresh in place without moving the focus
      var b = document.getElementById('modal-body'), y = b ? b.scrollTop : 0;
      if (b) { b.textContent = ''; body.forEach(function (n) { if (n) b.appendChild(n); }); b.scrollTop = y; }
      return;
    }
    U.openModal('Saved on this phone', body);
  };
  function confirmDiscard(it) {
    var U = ui(), h = U.h;
    var btn = h('button', { type: 'button', class: 'btn danger', id: 'ob-discard-confirm', text: 'Discard this update', onclick: function () { O.discard(it.ref).then(function () { O.openPanel(); }); } });
    U.openModal('Discard this update?', [h('p', { text: it.label }),
      h('p', { class: 'small', text: 'It was saved on this phone ' + clock(it.at) + ' and has not reached the server. Discarding deletes it from this phone; it cannot be recovered.' }),
      h('div', { class: 'btn-row' }, btn, h('button', { type: 'button', class: 'btn', text: 'Back', onclick: function () { O.openPanel(); } }))]);
  }

  // ------------------------------------------------------------------
  // The app's own files on this phone (service worker)
  // ------------------------------------------------------------------
  function registerWorker() {
    if (O.swTried || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    O.swTried = true;
    navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' }).then(function (reg) { O.sw = reg; }, function () { /* not available */ });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var chip = document.getElementById('netchip');
    if (chip) chip.addEventListener('click', function () { O.openPanel(); });
  });
})();
