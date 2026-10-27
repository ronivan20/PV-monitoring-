/* Solar PV Installation Monitoring — keeps the app itself on the phone so it opens without signal.
   Only the app's own files are kept here. Project data is not handled by this file: the app keeps the
   data it downloaded, and updates saved without signal, in the phone's storage (offline.js).
   Requests to the database are never answered from here. */
'use strict';
var VERSION = '202610271410';
// this worker looks after the files directly in the app's folder only; other apps in subfolders of
// the same site (for example serial-numbers/) have their own worker and are left alone
var BASE = new URL('./', self.location.href).pathname;
var CACHE = 'pvm-shell-' + VERSION;
var SHELL = ['./', 'styles.css?v=' + VERSION, 'config.js?v=' + VERSION, 'offline.js?v=' + VERSION, 'install.js?v=' + VERSION, 'drone.js?v=' + VERSION,
  'app.js?v=' + VERSION, 'piles.js?v=' + VERSION, 'piles-pages.js?v=' + VERSION, 'qrcode.js?v=' + VERSION, 'favicon.svg',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: 'reload' }); }));
  }).then(function () { return self.skipWaiting(); }));
});

// the page asks which version this worker holds (to offer "Reload" when a newer one took over)
self.addEventListener('message', function (e) {
  if (e.data === 'pvm-version' && e.ports && e.ports[0]) e.ports[0].postMessage(VERSION);
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('pvm-shell-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// the page: the newest from the network when it answers within 4 s, otherwise the copy kept here
function page(req) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(res) { if (!done && res) { done = true; resolve(res); } }
    function kept() { return caches.match('./', { cacheName: CACHE }).then(function (hit) { return hit || caches.match('./'); }); }
    var timer = setTimeout(function () { kept().then(finish); }, 4000);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put('./', copy); }).catch(function () { /* storage full */ });
      }
      finish(res);
    }, function () {
      clearTimeout(timer);
      kept().then(function (hit) { finish(hit || Response.error()); });
    });
  });
}

// the app's files: the copy kept here, otherwise the network (kept for next time)
function file(req) {
  return caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () { /* storage full */ });
      }
      return res;
    });
  });
}

function own(url) {
  if (url.origin !== self.location.origin || url.pathname.indexOf(BASE) !== 0) return null;
  var rest = url.pathname.slice(BASE.length);
  return rest.indexOf('/') < 0 ? rest : null; // null: a subfolder (another app)
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url), rest = own(url);
  if (rest === null) return; // the database, other apps and anything else: straight to the network
  if (req.mode === 'navigate') {
    if (rest === '' || rest === 'index.html') e.respondWith(page(req));
    return;
  }
  e.respondWith(file(req));
});
