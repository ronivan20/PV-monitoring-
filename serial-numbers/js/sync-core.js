/* PV Module Serial Numbers — the outbox: registrations saved on this device and uploaded when there
   is a connection. Shared by the page and the service worker (which can upload in the background
   on Android even when the app is closed). No DOM code here.

   An item holds the serial-number data and the label photo (+ thumbnail) as Blobs. Upload order:
   photo, thumbnail, then the record (sn_register). The record carries the item's client_uid, so a
   retry after a lost answer never creates a second record, and a photo that already arrived is
   accepted as uploaded. */
(function (G) {
  'use strict';
  var DB = 'pvsn-outbox', VER = 2, ITEMS = 'items', META = 'meta';
  var CTX = Math.random().toString(36).slice(2);
  // Stop the whole upload run (not the item's fault): no connection, server busy or sign-in needed.
  var STOP = { NETWORK: 1, TIMEOUT: 1, UNAVAILABLE: 1, SESSION: 1, MUST_CHANGE: 1, UPLOAD_AUTH: 1, NOT_SET_UP: 1 };
  var dbp = null, listeners = [], channel = null;

  try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('pvsn-sync'); } catch (e) { channel = null; }
  if (channel) channel.onmessage = function (ev) { var m = ev.data || {}; if (m.ctx !== CTX) deliver(m); };
  function deliver(m) { listeners.slice().forEach(function (fn) { try { fn(m); } catch (e) { /* listener error */ } }); }
  function emit(m) {
    m.ctx = CTX;
    deliver(m);
    if (channel) { try { channel.postMessage(m); } catch (e) { /* closed */ } }
  }

  // ---------- IndexedDB ----------
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!G.indexedDB) { reject(new Error('This browser cannot store data on the device.')); return; }
      var rq;
      try { rq = G.indexedDB.open(DB, VER); } catch (e) { reject(e); return; }
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains(ITEMS)) d.createObjectStore(ITEMS, { keyPath: 'uid' });
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
      };
      rq.onsuccess = function () {
        var d = rq.result;
        d.onversionchange = function () { d.close(); dbp = null; };
        resolve(d);
      };
      rq.onerror = function () { reject(rq.error || new Error('The device storage could not be opened.')); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function run(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t, out;
        try { t = d.transaction(store, mode); out = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && typeof out === 'object' && 'readyState' in out ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('The device storage refused the change (it may be full).')); };
      });
    });
  }
  function byCreated(a, b) { return (a.created || 0) - (b.created || 0); }
  function list() { return run(ITEMS, 'readonly', function (s) { return s.getAll(); }).then(function (r) { return (r || []).sort(byCreated); }); }
  function get(uid) { return run(ITEMS, 'readonly', function (s) { return s.get(uid); }); }
  function put(item) { return run(ITEMS, 'readwrite', function (s) { return s.put(item); }).then(function () { emit({ type: 'changed' }); }); }
  function remove(uid) { return run(ITEMS, 'readwrite', function (s) { return s.delete(uid); }).then(function () { emit({ type: 'changed' }); }); }
  function setAuth(a) { return run(META, 'readwrite', function (s) { return a ? s.put(a, 'auth') : s.delete('auth'); }); }
  function getAuth() { return run(META, 'readonly', function (s) { return s.get('auth'); }); }

  // ---------- network ----------
  function err(message, code, status) {
    var e = new Error(message);
    e.name = 'ApiError'; e.code = code || 'SERVER'; e.status = status || 0;
    return e;
  }
  // fetch + read the whole body, with a time limit (a weak signal often hangs instead of failing)
  function timed(url, init, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false, timer = null;
    if (ctl) { init.signal = ctl.signal; timer = setTimeout(function () { timedOut = true; ctl.abort(); }, ms); }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (text) { clearTimeout(timer); return { res: res, text: text }; });
    }).catch(function (e) {
      clearTimeout(timer);
      // (an AbortError also has a numeric "code"; only our own errors pass through unchanged)
      if (e && e.name === 'ApiError') throw e;
      throw err(timedOut ? 'The connection is too slow right now. It will try again.' : 'No connection to the server.', 'NETWORK', 0);
    });
  }
  function parse(text) { try { return text ? JSON.parse(text) : null; } catch (e) { return null; } }

  function rpc(cfg, fn, args, ms) {
    return timed(cfg.supabaseUrl + '/rest/v1/rpc/' + fn, {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', apikey: cfg.supabaseKey },
      body: JSON.stringify(args || {})
    }, ms || 25000).then(function (x) {
      var res = x.res, body = parse(x.text);
      if (res.ok) return body;
      var code = (body && body.hint) || 'SERVER';
      var msg = (body && body.message) || ('Server error (' + res.status + ').');
      if (res.status === 404 && body && /Could not find the function/i.test(body.message || '')) {
        code = 'NOT_SET_UP';
        msg = 'The database for this app is not set up (or not updated) yet. The administrator needs to run the setup SQL in Supabase.';
      } else if (body && body.code === '57014') {
        code = 'TIMEOUT'; msg = 'The server took too long to answer. It will try again.';
      } else if (res.status >= 500 && !(body && body.hint)) {
        code = 'UNAVAILABLE';
        msg = 'The server is not responding (' + res.status + '). If the Supabase project was paused, the administrator can restore it.';
      }
      throw err(msg, code, res.status);
    });
  }

  function objectUrl(cfg, path) {
    return cfg.supabaseUrl + '/storage/v1/object/' + cfg.bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
  }
  function upload(cfg, token, path, blob, ms) {
    return timed(objectUrl(cfg, path), {
      method: 'POST',
      headers: { apikey: cfg.supabaseKey, 'x-sn-token': token || '', 'Content-Type': 'image/jpeg' },
      body: blob
    }, ms || 90000).then(function (x) {
      if (x.res.ok) return true;
      var b = parse(x.text);
      var m = (b && (b.message || b.error)) || ('HTTP ' + x.res.status);
      if (b && (String(b.statusCode) === '409' || /already exists|duplicate/i.test(m))) return true; // arrived on an earlier try
      if (/row-level security|unauthori[sz]ed|jwt/i.test(m)) throw err('The server refused the photo. Sign in again; the registration stays on this phone.', 'UPLOAD_AUTH', x.res.status);
      if (x.res.status >= 500) throw err('The photo store is not responding (' + x.res.status + '). It will try again.', 'UNAVAILABLE', x.res.status);
      throw err('Photo upload failed: ' + m, 'UPLOAD', x.res.status);
    });
  }

  function sendItem(cfg, token, it, save) {
    save = save || function () { return null; };
    var p = Promise.resolve();
    if (it.photo && !it.photoUp) p = p.then(function () { return upload(cfg, token, it.photoPath, it.photo); }).then(function () { it.photoUp = true; return save(it); });
    if (it.thumb && !it.thumbUp) p = p.then(function () { return upload(cfg, token, it.thumbPath, it.thumb); }).then(function () { it.thumbUp = true; return save(it); });
    return p.then(function () {
      var data = Object.assign({}, it.data, { client_uid: it.uid, photo: it.photo ? it.photoPath : null, thumb: it.thumb ? it.thumbPath : null });
      return rpc(cfg, 'sn_register', { p_token: token, p_table_id: it.table_id, p_r: it.r, p_c: it.c, p_data: data }, 30000);
    });
  }

  function summary(it) {
    return { uid: it.uid, table_id: it.table_id, r: it.r, c: it.c, label: it.label, pos: it.pos, serial: it.data && it.data.serial };
  }

  // Uploads this user's waiting items, oldest first. Stops at the first connection problem
  // (everything stays saved); an item the server refuses is kept with the server's message.
  function flushNow(cfg, auth, opts) {
    var out = { sent: 0, failed: 0, stopped: null, message: null };
    return list().then(function (items) {
      items = items.filter(function (i) { return i.user_id === auth.user_id && (opts.retryErrors || i.state !== 'error'); });
      out.total = items.length;
      var chain = Promise.resolve();
      items.forEach(function (it) {
        chain = chain.then(function () {
          if (out.stopped) return null;
          if (it.state === 'error') { it.state = 'waiting'; it.error = null; it.code = null; }
          emit({ type: 'sending', uid: it.uid });
          return attempt(it, 0);
        });
      });
      return chain.then(function () { return out; });
    });
    function attempt(it, n) {
      return sendItem(cfg, auth.token, it, put).then(function (res) {
        out.sent++;
        return remove(it.uid).then(function () {
          var m = summary(it); m.type = 'sent'; m.res = res;
          emit(m);
        });
      }, function (e) {
        if (e.code === 'PHOTO' && n === 0 && it.photo) { it.photoUp = false; it.thumbUp = false; return attempt(it, 1); }
        if (STOP[e.code]) {
          out.stopped = e.code; out.message = e.message;
          it.lastError = e.message; it.lastTry = Date.now();
          return put(it);
        }
        out.failed++;
        it.state = 'error'; it.error = e.message; it.code = e.code; it.attempts = (it.attempts || 0) + 1; it.lastTry = Date.now();
        return put(it).then(function () {
          var m = summary(it); m.type = 'failed'; m.code = e.code; m.message = e.message;
          emit(m);
        });
      });
    }
  }
  function flush(cfg, auth, opts) {
    opts = opts || {};
    if (!auth || !auth.token) return Promise.resolve({ sent: 0, failed: 0, stopped: 'SESSION' });
    var locks = G.navigator && G.navigator.locks;
    if (locks && locks.request) {
      // one upload run at a time across the page(s) and the service worker
      return locks.request('pvsn-outbox-flush', { ifAvailable: true }, function (lock) {
        if (!lock) return { sent: 0, failed: 0, stopped: 'BUSY' };
        return flushNow(cfg, auth, opts);
      });
    }
    return flushNow(cfg, auth, opts);
  }

  G.PVSN_SYNC = {
    STOP: STOP,
    available: function () { return open().then(function () { return true; }, function () { return false; }); },
    list: list, get: get, put: put, remove: remove,
    setAuth: setAuth, getAuth: getAuth,
    rpc: rpc, upload: upload, objectUrl: objectUrl, sendItem: sendItem, flush: flush, err: err,
    on: function (fn) { listeners.push(fn); },
    emit: emit
  };
})(typeof self !== 'undefined' ? self : this);
