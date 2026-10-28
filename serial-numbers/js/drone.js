/* PV Module Serial Numbers — drone photo under the keyplan.
   The photo is a pyramid of 512 px WebP tiles that was resampled into keyplan metres beforehand
   (so it lines up with the tables at every zoom). The tiles sit in the private bucket "pvsn-drone";
   every request carries the app session. Tiles shown once, or saved with "Keep on this phone", are
   kept in the browser's Cache Storage, so the photo also shows without signal. */
(function () {
  'use strict';
  var SN = window.SN, C = window.SN_CONFIG;
  var BUCKET = 'pvsn-drone', CACHE_PREFIX = 'pvsn-drone-', PREF_KEY = 'pvsn.drone.prefs';
  var ID_RE = /^d[0-9]{8}-[0-9a-f]{8}$/;
  var D = (SN.drone = { man: null, on: true, alpha: 0.45, onLoad: null });

  try {
    var pr = JSON.parse(localStorage.getItem(PREF_KEY)) || {};
    if (typeof pr.on === 'boolean') D.on = pr.on;
    if (typeof pr.alpha === 'number') D.alpha = Math.max(0.1, Math.min(1, pr.alpha));
  } catch (e) { /* storage blocked */ }
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ on: D.on, alpha: D.alpha })); } catch (e) { /* ignore */ } }

  var levels = {};            // z -> { cols, rows, ppm, have: Uint8Array }
  var mem = new Map();        // tile key -> ImageBitmap | HTMLImageElement   (insertion order = LRU)
  var MAX_MEM = 80;
  var pending = new Map();    // tile key -> true while queued or loading
  var failed = new Map();     // tile key -> time of the last failure
  var queue = [], active = 0, wanted = new Set();
  var hasCaches = typeof caches !== 'undefined';

  function b64(s) { var bin = atob(s || ''), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
  function valid(m) {
    return !!(m && !m.off && m.kind === 'pvsn-drone' && ID_RE.test(m.id || '') && Array.isArray(m.levels) && m.levels.length &&
      isFinite(m.x0) && isFinite(m.y0) && m.ppm > 0 && m.tile > 0);
  }
  function dropMem() { mem.forEach(function (b) { if (b && b.close) b.close(); }); mem.clear(); }

  D.setManifest = function (m) {
    if (!valid(m)) {
      if (D.man) { D.man = null; levels = {}; dropMem(); queue = []; pending.clear(); if (D.onLoad) D.onLoad(); }
      return;
    }
    if (D.man && D.man.id === m.id) return;
    D.man = m; levels = {}; dropMem(); queue = []; pending.clear(); failed.clear();
    m.levels.forEach(function (L) { levels[L.z] = { cols: L.cols, rows: L.rows, ppm: L.ppm, have: b64(L.have) }; });
    // tiles of an older photo are no longer needed on this device
    if (hasCaches) caches.keys().then(function (keys) {
      keys.forEach(function (k) { if (k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_PREFIX + m.id) caches.delete(k); });
    }).catch(function () {});
    ov.done = false;
    setTimeout(keepOverview, 4000);               // after the keyplan has drawn
    if (D.onLoad) D.onLoad();
  };
  D.available = function () { return !!D.man; };
  D.visible = function () { return !!D.man && D.on; };
  D.setOn = function (on) { D.on = !!on; savePrefs(); if (D.onLoad) D.onLoad(); SN.bus.emit('drone'); };
  D.setAlpha = function (a) { D.alpha = Math.max(0.1, Math.min(1, a)); savePrefs(); if (D.onLoad) D.onLoad(); };
  D.extent = function () {
    var m = D.man; if (!m) return null;
    return { x0: m.x0, y0: m.y0, x1: m.x0 + m.w / m.ppm, y1: m.y0 + m.h / m.ppm };
  };
  D.totalTiles = function () {
    var n = 0;
    Object.keys(levels).forEach(function (z) { var h = levels[z].have; for (var i = 0; i < h.length; i++) { var v = h[i]; while (v) { n += v & 1; v >>= 1; } } });
    return n;
  };
  D.clearDevice = function () {
    dropMem(); ov.done = false;
    if (!hasCaches) return Promise.resolve();
    return caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; }).map(function (k) { return caches.delete(k); }));
    }).catch(function () {});
  };

  function has(z, x, y) {
    var L = levels[z];
    if (!L || x < 0 || y < 0 || x >= L.cols || y >= L.rows) return false;
    var i = y * L.cols + x;
    return !!((L.have[i >> 3] >> (i & 7)) & 1);
  }
  function key(z, x, y) { return z + '/' + x + '_' + y; }
  function cacheKey(id, k) { return 'https://pvsn-drone.invalid/' + id + '/' + k + '.webp'; }
  function remoteUrl(id, k) { return C.supabaseUrl + '/storage/v1/object/authenticated/' + BUCKET + '/' + id + '/' + k + '.webp'; }

  function fromCache(id, k) {
    if (!hasCaches) return Promise.resolve(null);
    return caches.open(CACHE_PREFIX + id).then(function (c) { return c.match(cacheKey(id, k)); })
      .then(function (r) { return r ? r.blob() : null; }).catch(function () { return null; });
  }
  function toCache(id, k, blob) {
    if (!hasCaches) return Promise.resolve();
    return caches.open(CACHE_PREFIX + id).then(function (c) {
      return c.put(cacheKey(id, k), new Response(blob, { headers: { 'Content-Type': 'image/webp' } }));
    }).catch(function () {});
  }
  function fromServer(id, k) {
    if (navigator.onLine === false) return Promise.reject(new Error('offline'));
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 40000) : null;
    return fetch(remoteUrl(id, k), {
      headers: { apikey: C.supabaseKey, 'x-sn-token': (SN.api && SN.api.token()) || '' }, signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    }).then(function (b) {
      clearTimeout(timer);
      b = new Blob([b], { type: 'image/webp' });
      return toCache(id, k, b).then(function () { return b; });
    }, function (e) { clearTimeout(timer); throw e; });
  }
  function decode(blob) {
    var viaImg = function () {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(blob), img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
      });
    };
    if (typeof createImageBitmap === 'function') return createImageBitmap(blob).catch(viaImg);
    return viaImg();
  }
  function getBlob(id, k) { return fromCache(id, k).then(function (b) { return b || fromServer(id, k); }); }

  function pump() {
    while (active < 6 && queue.length) {
      var job = queue.pop();                       // newest first: what is on screen now
      if (!D.man || job.id !== D.man.id || !wanted.has(job.k)) { pending.delete(job.k); continue; }
      active++;
      (function (job) {
        getBlob(job.id, job.k).then(decode).then(function (img) {
          active--; pending.delete(job.k);
          if (!D.man || job.id !== D.man.id) { if (img.close) img.close(); return; }
          mem.set(job.k, img);
          while (mem.size > MAX_MEM) {
            var old = mem.keys().next().value, ob = mem.get(old);
            if (ob && ob.close) ob.close();
            mem.delete(old);
          }
          if (D.onLoad) D.onLoad();
          pump();
        }, function () {
          active--; pending.delete(job.k); failed.set(job.k, Date.now()); pump();
        });
      })(job);
    }
  }
  function request(z, x, y) {
    var k = key(z, x, y);
    wanted.add(k);
    if (mem.has(k) || pending.has(k)) return;
    var f = failed.get(k);
    if (f && Date.now() - f < (navigator.onLine === false ? 5000 : 20000)) return;
    pending.set(k, true);
    queue.push({ k: k, id: D.man.id });
  }
  function hit(k) {                                 // LRU touch
    var b = mem.get(k); if (!b) return null;
    mem.delete(k); mem.set(k, b);
    return b;
  }

  // Draws the photo for the current view. Returns true when the photo layer is on.
  D.draw = function (ctx, view, W, H, dpr) {
    if (!D.visible()) return false;
    var m = D.man, s = view.s, TS = m.tile;
    var need = s * dpr, z = m.zmax;
    for (var i = 0; i <= m.zmax; i++) { if (levels[i] && levels[i].ppm >= need * 0.85) { z = i; break; } }
    wanted = new Set();
    var wx0 = -view.tx / s, wy0 = -view.ty / s, wx1 = (W - view.tx) / s, wy1 = (H - view.ty) / s;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    // a coarse level first, so the screen is never empty while sharper tiles load
    var zc = Math.max(0, Math.min(z - 2, 2));
    if (zc < z) drawLevel(ctx, view, m, zc, wx0, wy0, wx1, wy1, false);
    drawLevel(ctx, view, m, z, wx0, wy0, wx1, wy1, true);
    ctx.restore();
    pump();
    return true;
  };
  function drawLevel(ctx, view, m, z, wx0, wy0, wx1, wy1, fallback) {
    var L = levels[z]; if (!L) return;
    var s = view.s, TM = m.tile / L.ppm;              // tile size in metres
    var tx0 = Math.max(0, Math.floor((wx0 - m.x0) / TM)), tx1 = Math.min(L.cols - 1, Math.floor((wx1 - m.x0) / TM));
    var ty0 = Math.max(0, Math.floor((wy0 - m.y0) / TM)), ty1 = Math.min(L.rows - 1, Math.floor((wy1 - m.y0) / TM));
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        if (!has(z, tx, ty)) continue;
        var X0 = (m.x0 + tx * TM) * s + view.tx, Y0 = (m.y0 + ty * TM) * s + view.ty;
        var X1 = (m.x0 + (tx + 1) * TM) * s + view.tx, Y1 = (m.y0 + (ty + 1) * TM) * s + view.ty;
        var dx = Math.floor(X0), dy = Math.floor(Y0), dw = Math.ceil(X1) - dx, dh = Math.ceil(Y1) - dy;
        var k = key(z, tx, ty), img = hit(k);
        if (img) { ctx.drawImage(img, dx, dy, dw, dh); continue; }
        request(z, tx, ty);
        if (!fallback) continue;
        for (var up = 1; up <= z; up++) {            // nearest coarser tile that is already here
          var pz = z - up, px = tx >> up, py = ty >> up, pk = key(pz, px, py), pimg = mem.get(pk);
          if (!pimg) continue;
          var sub = m.tile / (1 << up);
          ctx.drawImage(pimg, (tx - (px << up)) * sub, (ty - (py << up)) * sub, sub, sub, dx, dy, dw, dh);
          break;
        }
      }
    }
  }

  // ---------- the whole-plant overview stays on every phone (areas without signal) ----------
  // The coarse levels (about 2 px per metre and below, ~2 MB) are saved in the background once
  // per photo; sharper parts are saved as they are shown (fromServer keeps every tile it gets).
  var ov = { running: false, done: false, id: null };
  function overviewKeys() {
    var m = D.man, out = [], zo = Math.max(0, m.zmax - 2);
    for (var z = 0; z <= zo; z++) {
      var L = levels[z]; if (!L) continue;
      for (var y = 0; y < L.rows; y++) for (var x = 0; x < L.cols; x++) if (has(z, x, y)) out.push(key(z, x, y));
    }
    return out;
  }
  function keepOverview() {
    var m = D.man;
    if (!m || !hasCaches || ov.running || (ov.done && ov.id === m.id)) return;
    ov.running = true; ov.id = m.id;
    var id = m.id, keys = overviewKeys(), bad = 0;
    caches.open(CACHE_PREFIX + id).then(function (c) { return c.keys(); }).then(function (have) {
      var got = new Set(have.map(function (r) { return r.url; }));
      var todo = keys.filter(function (k) { return !got.has(cacheKey(id, k)); }), i = 0, running = 0;
      // without signal (or signed out) only check what is already on the phone
      if (todo.length && (navigator.onLine === false || !(SN.api && SN.api.token()))) { bad = todo.length; return; }
      return new Promise(function (resolve) {
        function next() {
          if (!D.man || D.man.id !== id || i >= todo.length) { if (!running) resolve(); return; }
          var k = todo[i++]; running++;
          fromServer(id, k).catch(function () { bad++; }).then(function () { running--; next(); });
        }
        next(); next();
      });
    }).then(function () { ov.done = !bad && !!D.man && D.man.id === id; }, function () {})
      .then(function () { ov.running = false; if (SN.bus) SN.bus.emit('drone-device'); });
  }
  D.overviewKept = function () { return !!(ov.done && D.man && ov.id === D.man.id); };
  if (SN.bus) SN.bus.on('online', function (on) { if (on) setTimeout(keepOverview, 2000); });

  // ---------- keep the whole photo on this device (for areas without signal) ----------
  function allKeys() {
    var out = [];
    Object.keys(levels).map(Number).sort(function (a, b) { return a - b; }).forEach(function (z) {
      var L = levels[z];
      for (var y = 0; y < L.rows; y++) for (var x = 0; x < L.cols; x++) if (has(z, x, y)) out.push(key(z, x, y));
    });
    return out;
  }
  D.countOnDevice = function () {
    if (!D.man || !hasCaches) return Promise.resolve(0);
    return caches.open(CACHE_PREFIX + D.man.id).then(function (c) { return c.keys(); }).then(function (k) { return k.length; }).catch(function () { return 0; });
  };
  D.keepOnDevice = function (progress, stop) {
    if (!D.man) return Promise.reject(new Error('No drone photo.'));
    if (!hasCaches) return Promise.reject(new Error('This browser cannot keep files for offline use.'));
    var id = D.man.id, keys = allKeys(), i = 0, done = 0, failedN = 0;
    return caches.open(CACHE_PREFIX + id).then(function (c) {
      return c.keys().then(function (have) {
        var got = new Set(have.map(function (r) { return r.url; }));
        keys = keys.filter(function (k) { if (got.has(cacheKey(id, k))) { done++; return false; } return true; });
        var total = done + keys.length;
        if (progress) progress(done, total);
        return new Promise(function (resolve) {
          var running = 0;
          function next() {
            if (stop && stop()) { if (!running) resolve({ done: done, total: total, failed: failedN, stopped: true }); return; }
            if (i >= keys.length) { if (!running) resolve({ done: done, total: total, failed: failedN }); return; }
            var k = keys[i++]; running++;
            fromServer(id, k).then(function () { done++; }, function () { failedN++; }).then(function () {
              running--; if (progress) progress(done, total); next();
            });
          }
          for (var n = 0; n < 4; n++) next();
        });
      });
    });
  };

  // ---------- administrator: read the package (.zip) and upload it ----------
  function u16(d, o) { return d.getUint16(o, true); }
  function u32(d, o) { return d.getUint32(o, true); }
  function readZip(file) {
    var tail = Math.min(file.size, 65557);
    return file.slice(file.size - tail).arrayBuffer().then(function (buf) {
      var d = new DataView(buf), i;
      for (i = buf.byteLength - 22; i >= 0; i--) if (u32(d, i) === 0x06054b50) break;
      if (i < 0) throw new Error('This file is not a .zip package.');
      var n = u16(d, i + 10), size = u32(d, i + 12), off = u32(d, i + 16);
      return file.slice(off, off + size).arrayBuffer().then(function (cd) {
        var v = new DataView(cd), p = 0, out = [], td = new TextDecoder();
        for (var k = 0; k < n; k++) {
          if (u32(v, p) !== 0x02014b50) throw new Error('The .zip file is damaged.');
          var nl = u16(v, p + 28), xl = u16(v, p + 30), cl = u16(v, p + 32);
          out.push({ name: td.decode(new Uint8Array(cd, p + 46, nl)), method: u16(v, p + 10),
                     csize: u32(v, p + 20), usize: u32(v, p + 24), off: u32(v, p + 42) });
          p += 46 + nl + xl + cl;
        }
        return out;
      });
    });
  }
  function entryBlob(file, e, type) {
    return file.slice(e.off, e.off + 30).arrayBuffer().then(function (h) {
      var d = new DataView(h);
      if (u32(d, 0) !== 0x04034b50) throw new Error('The .zip file is damaged.');
      var start = e.off + 30 + u16(d, 26) + u16(d, 28);
      var raw = file.slice(start, start + e.csize, type);
      if (e.method === 0) return raw;
      if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
        return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob().then(function (b) { return new Blob([b], { type: type }); });
      }
      throw new Error('The .zip file uses a compression this browser cannot read. Use the package as it was delivered.');
    });
  }
  // -> { manifest, tiles: [{ path, entry }], file }
  D.readPackage = function (file) {
    return readZip(file).then(function (entries) {
      var me = entries.filter(function (e) { return /(^|\/)drone\.json$/.test(e.name); })[0];
      if (!me) throw new Error('drone.json is missing: this is not a drone photo package.');
      var root = me.name.slice(0, me.name.length - 'drone.json'.length);
      return entryBlob(file, me, 'application/json').then(function (b) { return b.text(); }).then(function (txt) {
        var man;
        try { man = JSON.parse(txt); } catch (e) { throw new Error('drone.json cannot be read.'); }
        if (!valid(man) || man.format !== 1) throw new Error('This drone photo package was not made for this app.');
        var tiles = [], re = /^tiles\/(\d{1,2})\/(\d{1,4})_(\d{1,4})\.webp$/;
        entries.forEach(function (e) {
          if (e.name.indexOf(root) !== 0) return;
          var mm = re.exec(e.name.slice(root.length));
          if (mm) tiles.push({ path: man.id + '/' + mm[1] + '/' + mm[2] + '_' + mm[3] + '.webp', entry: e });
        });
        if (man.tiles && tiles.length !== man.tiles) throw new Error('The package is incomplete: ' + tiles.length + ' of ' + man.tiles + ' tiles.');
        return { manifest: man, tiles: tiles, file: file, bytes: tiles.reduce(function (a, t) { return a + t.entry.usize; }, 0) };
      });
    });
  };
  function uploadOne(path, blob) {
    return fetch(C.supabaseUrl + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'POST', body: blob,
      headers: { apikey: C.supabaseKey, 'x-sn-token': SN.api.token() || '', 'Content-Type': 'image/webp' }
    }).then(function (res) {
      if (res.ok) return true;
      return res.text().then(function (t) {
        var b = null; try { b = JSON.parse(t); } catch (e) { b = null; }
        var msg = (b && (b.message || b.error)) || ('HTTP ' + res.status);
        if (b && (String(b.statusCode) === '409' || /already exists|duplicate/i.test(msg))) return true;
        var e = new Error(/bucket not found/i.test(msg) ? 'The drone-photo storage is missing: run database update 3 (pv-serial-update-3.sql) in Supabase first.'
          : /row-level security|unauthori[sz]ed/i.test(msg) ? 'The server refused the upload. Only an administrator can upload, and the sign-in must still be valid.'
          : 'Upload failed: ' + msg);
        e.fatal = res.status < 500;
        throw e;
      });
    });
  }
  // progress(done, total); stop() -> true to stop. Resolves with the server settings.
  D.uploadPackage = function (pkg, progress, stop) {
    var tiles = pkg.tiles, i = 0, done = 0, total = tiles.length, fatal = null;
    return SN.api.rpc('sn_ping', {}).then(function (p) {
      if (!p || !(p.schema_version >= 3)) throw new Error('Run database update 3 (pv-serial-update-3.sql) in Supabase first, then upload again.');
    }).then(function () {
      return new Promise(function (resolve, reject) {
        var running = 0;
        function next() {
          if (fatal) { if (!running) reject(fatal); return; }
          if (stop && stop()) { if (!running) reject(new Error('Upload stopped. Upload the same package again to continue.')); return; }
          if (i >= total) { if (!running) resolve(); return; }
          var t = tiles[i++], tries = 0; running++;
          (function attempt() {
            entryBlob(pkg.file, t.entry, 'image/webp').then(function (b) { return uploadOne(t.path, b); }).then(function () {
              running--; done++; if (progress) progress(done, total); next();
            }, function (e) {
              if (!e.fatal && ++tries < 4) { setTimeout(attempt, 1500 * tries); return; }
              running--; fatal = fatal || e; next();
            });
          })();
        }
        for (var n = 0; n < 4; n++) next();
      });
    }).then(function () {
      return SN.api.call('sn_admin_settings', { p_key: 'drone', p_value: pkg.manifest });
    });
  };
  D.remove = function () { return SN.api.call('sn_admin_settings', { p_key: 'drone', p_value: { off: true } }); };

  if (SN.bus) SN.bus.on('settings', function () { D.setManifest((SN.state.settings || {}).drone); });
})();
