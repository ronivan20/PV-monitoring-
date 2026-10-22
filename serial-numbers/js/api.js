/* PV Module Serial Numbers — server access (Supabase RPC + private photo storage) and the offline outbox */
(function () {
  'use strict';
  var SN = window.SN, C = window.SN_CONFIG;
  var SESSION_KEY = 'pvsn.session.v1';
  var api = (SN.api = {});

  // ---------- tiny event bus ----------
  var handlers = {};
  SN.bus = {
    on: function (ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit: function (ev, data) { (handlers[ev] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }
  };

  // ---------- session ----------
  var session = null;
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch (e) { session = null; }
  api.session = function () { return session; };
  api.token = function () { return session && session.token; };
  api.setSession = function (s) {
    session = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ }
  };

  function ApiError(message, code, status) {
    var e = new Error(message);
    e.name = 'ApiError'; e.code = code || 'SERVER'; e.status = status || 0;
    return e;
  }
  api.ApiError = ApiError;

  api.rpc = function (fn, args, opts) {
    opts = opts || {};
    return fetch(C.supabaseUrl + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.supabaseKey },
      body: JSON.stringify(args || {}),
      signal: opts.signal,
      cache: 'no-store'
    }).catch(function () {
      throw ApiError('No connection to the server. Check the internet connection and try again.', 'NETWORK', 0);
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
        if (res.ok) return body;
        var code = (body && body.hint) || 'SERVER';
        var msg = (body && body.message) || ('Server error (' + res.status + ').');
        if (res.status === 404 && body && /Could not find the function/i.test(body.message || '')) {
          code = 'NOT_SET_UP';
          msg = 'The database for this app is not set up yet. The administrator needs to run the setup SQL in Supabase.';
        } else if (body && body.code === '57014') {
          msg = 'The server took too long to answer. Try again.';
        } else if (res.status >= 500 && !body) {
          msg = 'The server is not responding (' + res.status + '). If the Supabase project was paused, the administrator can restore it.';
        }
        var err = ApiError(msg, code, res.status);
        if (code === 'SESSION' && !opts.quietSession) SN.bus.emit('session-ended', msg);
        if (code === 'MUST_CHANGE') SN.bus.emit('must-change', msg);
        throw err;
      });
    });
  };
  api.call = function (fn, args, opts) {
    var a = { p_token: api.token() };
    Object.keys(args || {}).forEach(function (k) { a[k] = args[k]; });
    return api.rpc(fn, a, opts);
  };

  // ---------- photos (private bucket; every request carries the app session) ----------
  function objectUrl(path) {
    return C.supabaseUrl + '/storage/v1/object/' + C.bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
  }
  api.upload = function (path, blob) {
    return fetch(objectUrl(path), {
      method: 'POST',
      headers: { apikey: C.supabaseKey, 'x-sn-token': api.token() || '', 'Content-Type': 'image/jpeg' },
      body: blob
    }).catch(function () {
      throw ApiError('No connection: the label photo could not be uploaded.', 'NETWORK', 0);
    }).then(function (res) {
      if (res.ok) return true;
      return res.json().catch(function () { return null; }).then(function (b) {
        var m = b && (b.message || b.error) || ('HTTP ' + res.status);
        if (b && (String(b.statusCode) === '409' || /already exists|duplicate/i.test(m))) return true; // retried after a lost reply
        if (/row-level security|unauthori[sz]ed|jwt/i.test(m)) throw ApiError('The server refused the photo. Sign in again and retry.', 'UPLOAD_AUTH', res.status);
        throw ApiError('Photo upload failed: ' + m, 'UPLOAD', res.status);
      });
    });
  };

  var cache = new Map(), inflight = new Map(), queue = [], active = 0;
  function pump() {
    while (active < 4 && queue.length) {
      var job = queue.shift(); active++;
      job().then(function () { active--; pump(); }, function () { active--; pump(); });
    }
  }
  api.photoUrl = function (path) {
    if (!path) return Promise.resolve(null);
    if (cache.has(path)) { var v = cache.get(path); cache.delete(path); cache.set(path, v); return Promise.resolve(v); }
    if (inflight.has(path)) return inflight.get(path);
    var p = new Promise(function (resolve, reject) {
      queue.push(function () {
        return fetch(C.supabaseUrl + '/storage/v1/object/authenticated/' + C.bucket + '/' + path.split('/').map(encodeURIComponent).join('/'), {
          headers: { apikey: C.supabaseKey, 'x-sn-token': api.token() || '' }
        }).then(function (res) {
          if (!res.ok) throw ApiError('Photo not available (' + res.status + ').', 'PHOTO', res.status);
          return res.blob();
        }).then(function (b) {
          var url = URL.createObjectURL(b);
          cache.set(path, url);
          if (cache.size > 120) { var k = cache.keys().next().value; URL.revokeObjectURL(cache.get(k)); cache.delete(k); }
          inflight.delete(path); resolve(url);
        }).catch(function (e) { inflight.delete(path); reject(e); });
      });
      pump();
    });
    inflight.set(path, p);
    return p;
  };
  api.clearPhotoCache = function () {
    cache.forEach(function (url) { URL.revokeObjectURL(url); });
    cache.clear();
  };

  // ---------- offline outbox (IndexedDB) ----------
  var DB_NAME = 'pvsn-outbox', STORE = 'items', dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('no indexeddb'));
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE, { keyPath: 'uid' }); };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, mode), st = t.objectStore(STORE), out;
        out = fn(st);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }
  var outbox = (api.outbox = {
    available: function () { return db().then(function () { return true; }, function () { return false; }); },
    add: function (item) { item.queued = true; return tx('readwrite', function (s) { return s.put(item); }).then(function () { SN.bus.emit('outbox'); }); },
    list: function () { return tx('readonly', function (s) { return s.getAll(); }).then(function (r) { return (r || []).sort(function (a, b) { return a.created - b.created; }); }, function () { return []; }); },
    remove: function (uid) { return tx('readwrite', function (s) { return s.delete(uid); }).then(function () { SN.bus.emit('outbox'); }); },
    put: function (item) { return tx('readwrite', function (s) { return s.put(item); }).then(function () { SN.bus.emit('outbox'); }); }
  });

  var flushing = null;
  // Sends waiting registrations (oldest first). Stops at the first network
  // failure; anything the server refuses is kept with its message so the
  // user can decide.
  outbox.flush = function () {
    if (flushing) return flushing;
    if (!api.token() || !session || !session.user) return Promise.resolve({ sent: 0 });
    var me = session.user.id, sent = 0;
    flushing = outbox.list().then(function (items) {
      items = items.filter(function (i) { return i.user_id === me && i.state !== 'error'; });
      var chain = Promise.resolve();
      var stop = false;
      items.forEach(function (it) {
        chain = chain.then(function () {
          if (stop) return;
          return sendItem(it).then(function (res) {
            sent++;
            return outbox.remove(it.uid).then(function () { SN.bus.emit('registered', { item: it, res: res }); });
          }, function (e) {
            if (e.code === 'NETWORK' || e.code === 'SESSION' || e.code === 'MUST_CHANGE' || e.code === 'UPLOAD_AUTH') { stop = true; return; }
            it.state = 'error'; it.error = e.message; it.attempts = (it.attempts || 0) + 1;
            return outbox.put(it);
          });
        });
      });
      return chain;
    }).then(function () { flushing = null; return { sent: sent }; }, function (e) { flushing = null; throw e; });
    return flushing;
  };
  function sendItem(it) {
    var p = Promise.resolve();
    var keep = function () { return it.queued ? outbox.put(it) : null; };
    if (it.photo && !it.photoUp) p = p.then(function () { return api.upload(it.photoPath, it.photo); }).then(function () { it.photoUp = true; return keep(); });
    if (it.thumb && !it.thumbUp) p = p.then(function () { return api.upload(it.thumbPath, it.thumb); }).then(function () { it.thumbUp = true; return keep(); });
    return p.then(function () {
      var data = Object.assign({}, it.data, { client_uid: it.uid, photo: it.photo ? it.photoPath : null, thumb: it.thumb ? it.thumbPath : null });
      return api.call('sn_register', { p_table_id: it.table_id, p_r: it.r, p_c: it.c, p_data: data });
    });
  }
  api.sendRegistration = sendItem;
})();
