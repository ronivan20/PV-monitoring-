/* PV Module Serial Numbers — service worker. Makes the app open and work without signal:
   - keeps every app file on the device (installed together, one version at a time) and serves
     them from there first, so the app starts instantly even with a weak signal; a new version is
     installed in the background and used from the next start;
   - keeps the OCR engine on the device after it is fetched once;
   - uploads registrations saved offline when the connection returns, even with the app closed
     (Background Sync, Android/Chrome).
   Never caches or touches the Supabase requests (data and photos stay private and live). */
/* global PVSN_SYNC */
var V = '20261023070906';
var SHELL = 'pvsn-shell-' + V;
var OCR = 'pvsn-ocr-v1';
var PRECACHE = ["index.html", "config.js", "css/app.css", "icon-192.png", "icon-512.png", "icon.svg", "js/api.js", "js/app.js", "js/capture.js", "js/keyplan.js", "js/ocr-worker.js", "js/store.js", "js/sync-core.js", "js/sync.js", "js/util.js", "js/views-admin.js", "js/views-capture.js", "js/views-dash.js", "js/views-keyplan.js", "js/xlsx.js", "manifest.webmanifest", "vendor/html5-qrcode.min.js"];
var SCOPE = self.registration.scope;                 // e.g. https://host/PV-monitoring-/serial-numbers/
var SCOPE_PATH = new URL(SCOPE).pathname;

try { importScripts('config.js?v=' + V, 'js/sync-core.js?v=' + V); } catch (e) { /* uploads only from the page */ }

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(PRECACHE.map(function (p) {
      var clean = new URL(p, SCOPE).href;
      // the version in the query string skips any stale copy in the browser or CDN caches
      return fetch(clean + (clean.indexOf('?') < 0 ? '?' : '&') + 'v=' + V, { cache: 'reload' }).then(function (res) {
        if (!res.ok) throw new Error('could not fetch ' + p + ' (' + res.status + ')');
        return c.put(clean, res);
      });
    }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('pvsn-shell-') === 0 && k !== SHELL; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function fromNetworkInto(cacheName, req, key) {
  return fetch(req).then(function (res) {
    if (res && res.ok && res.type === 'basic') {
      var copy = res.clone();
      caches.open(cacheName).then(function (c) { return c.put(key, copy); }).catch(function () {});
    }
    return res;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.indexOf(SCOPE_PATH) !== 0) return;
  var clean = url.origin + url.pathname;
  if (url.pathname.indexOf(SCOPE_PATH + 'vendor/tesseract/') === 0) {
    e.respondWith(caches.open(OCR).then(function (c) {
      return c.match(clean).then(function (hit) { return hit || fromNetworkInto(OCR, req, clean); });
    }));
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(caches.open(SHELL).then(function (c) {
      return c.match(SCOPE + 'index.html').then(function (hit) {
        return hit || fetch(req);
      });
    }).catch(function () { return fetch(req); }));
    return;
  }
  e.respondWith(caches.open(SHELL).then(function (c) {
    return c.match(clean).then(function (hit) { return hit || fetch(req); });
  }).catch(function () { return fetch(req); }));
});

// ---------- uploads in the background ----------
function flushFromWorker(retryOnNetwork) {
  if (typeof PVSN_SYNC === 'undefined' || !self.SN_CONFIG) return Promise.resolve(null);
  return PVSN_SYNC.getAuth().then(function (auth) {
    if (!auth || !auth.token) return null;
    return PVSN_SYNC.flush(self.SN_CONFIG, auth).then(function (r) {
      // throwing makes the browser try the sync again later
      if (retryOnNetwork && r && (r.stopped === 'NETWORK' || r.stopped === 'TIMEOUT' || r.stopped === 'UNAVAILABLE')) throw new Error('no connection yet');
      return r;
    });
  });
}
self.addEventListener('sync', function (e) {
  if (e.tag === 'pvsn-outbox') e.waitUntil(flushFromWorker(true));
});

// ---------- messages from the page ----------
self.addEventListener('message', function (e) {
  var m = e.data || {}, port = e.ports && e.ports[0];
  function reply(x) { if (port) port.postMessage(x); }
  if (m.type === 'status') {
    e.waitUntil(Promise.all([
      caches.open(SHELL).then(function (c) { return c.keys(); }),
      caches.open(OCR).then(function (c) { return c.keys(); })
    ]).then(function (k) {
      reply({ version: V, shell: { have: k[0].length, want: PRECACHE.length },
        ocr: k[1].map(function (r) { return new URL(r.url).pathname.split('/').pop(); }) });
    }, function (err) { reply({ version: V, error: String(err) }); }));
  } else if (m.type === 'warm-ocr') {
    var files = (m.files || []).filter(function (f) { return /^[\w.-]+$/.test(f); });
    e.waitUntil(caches.open(OCR).then(function (c) {
      return Promise.all(files.map(function (f) {
        var url = SCOPE + 'vendor/tesseract/' + f;
        return c.match(url).then(function (hit) {
          if (hit) return true;
          return fetch(url).then(function (res) { if (!res.ok) throw new Error(f + ' ' + res.status); return c.put(url, res); }).then(function () { return true; });
        });
      }));
    }).then(function () { reply({ ok: true }); }, function (err) { reply({ ok: false, error: String(err) }); }));
  } else if (m.type === 'flush') {
    e.waitUntil(flushFromWorker(false).then(function (r) { reply({ ok: true, result: r }); }, function (err) { reply({ ok: false, error: String(err) }); }));
  }
});
