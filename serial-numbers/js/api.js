/* PV Module Serial Numbers — server access (Supabase RPC + private photo storage) and the outbox */
(function () {
  'use strict';
  var SN = window.SN, C = window.SN_CONFIG, core = window.PVSN_SYNC;
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
    // the service worker uploads with the same sign-in when the app is closed
    core.setAuth(s && s.token && s.user ? { token: s.token, user_id: s.user.id } : null).catch(function () {});
  };

  api.ApiError = core.err;
  var TRANSIENT = { NETWORK: 1, TIMEOUT: 1, UNAVAILABLE: 1 };
  api.isOffline = function (e) { return !!(e && TRANSIENT[e.code]); };

  // opts: { timeout (ms), quietSession }
  api.rpc = function (fn, args, opts) {
    opts = opts || {};
    if (navigator.onLine === false) {
      SN.bus.emit('net', false);
      return Promise.reject(core.err('No connection (this device is offline).', 'NETWORK', 0));
    }
    return core.rpc(C, fn, args, opts.timeout).then(function (body) {
      SN.bus.emit('net', true);
      return body;
    }, function (e) {
      if (e.code === 'NETWORK') SN.bus.emit('net', false);
      else SN.bus.emit('net', true);
      if (e.code === 'SESSION' && !opts.quietSession) SN.bus.emit('session-ended', e.message);
      if (e.code === 'MUST_CHANGE') SN.bus.emit('must-change', e.message);
      throw e;
    });
  };
  api.call = function (fn, args, opts) {
    var a = { p_token: api.token() };
    Object.keys(args || {}).forEach(function (k) { a[k] = args[k]; });
    return api.rpc(fn, a, opts);
  };

  // ---------- photos (private bucket; every request carries the app session) ----------
  api.upload = function (path, blob) {
    return core.upload(C, api.token(), path, blob).then(function (ok) { SN.bus.emit('net', true); return ok; }, function (e) {
      if (e.code === 'NETWORK') SN.bus.emit('net', false);
      throw e;
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
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 45000) : null;
        return fetch(C.supabaseUrl + '/storage/v1/object/authenticated/' + C.bucket + '/' + path.split('/').map(encodeURIComponent).join('/'), {
          headers: { apikey: C.supabaseKey, 'x-sn-token': api.token() || '' }, signal: ctl ? ctl.signal : undefined
        }).then(function (res) {
          if (!res.ok) throw core.err('Photo not available (' + res.status + ').', 'PHOTO', res.status);
          return res.blob();
        }, function () {
          throw core.err('The photo can be viewed when there is a connection.', 'NETWORK', 0);
        }).then(function (b) {
          clearTimeout(timer);
          var url = URL.createObjectURL(b);
          cache.set(path, url);
          if (cache.size > 120) { var k = cache.keys().next().value; URL.revokeObjectURL(cache.get(k)); cache.delete(k); }
          inflight.delete(path); resolve(url);
        }).catch(function (e) { clearTimeout(timer); inflight.delete(path); reject(e); });
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

  // ---------- outbox (registrations saved on this device; see sync-core.js) ----------
  api.outbox = {
    available: core.available,
    add: function (item) { item.queued = true; item.state = item.state || 'waiting'; return core.put(item); },
    list: function () { return core.list().catch(function () { return []; }); },
    get: core.get,
    remove: core.remove,
    put: core.put,
    flush: function (opts) {
      var s = api.session();
      if (!s || !s.token || !s.user) return Promise.resolve({ sent: 0, failed: 0, stopped: 'SESSION' });
      return core.flush(C, { token: s.token, user_id: s.user.id }, opts).then(function (r) {
        if (r.sent) SN.bus.emit('net', true);
        if (r.stopped === 'NETWORK') SN.bus.emit('net', false);
        if (r.stopped === 'SESSION') SN.bus.emit('session-ended', r.message);
        if (r.stopped === 'MUST_CHANGE') SN.bus.emit('must-change', r.message);
        return r;
      });
    }
  };
  // Direct upload without the outbox (only when this browser cannot store data on the device).
  api.sendRegistration = function (it) {
    return core.sendItem(C, api.token(), it, null).then(function (r) { SN.bus.emit('net', true); return r; }, function (e) {
      if (e.code === 'NETWORK') SN.bus.emit('net', false);
      throw e;
    });
  };
})();
