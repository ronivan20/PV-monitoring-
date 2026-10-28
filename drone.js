/* Solar PV Installation Monitoring — drone photo under the keyplans (update 11; Block 5 from update 12).
   A drone photo is resampled to keyplan metres (true size, 5 cm per pixel at the finest level) and cut
   into 512 px picture tiles: drone/<photo>/r<n>/<level>/<col>_<row>.bin, listed in drone/photos.json.
   The tiles sit on the public web site encrypted (AES-256-GCM, each tile bound to its own place).
   The key comes with the sign-in (get_bootstrap, database update 11), so only signed-in users can see
   the photo; photos.json names each photo's key by the start of its SHA-256 ("kid"), so a photo the key
   does not open is left out instead of drawn blank. Tiles are decrypted in the browser, kept on the
   device once seen (or all at once with "Save for use without signal") and drawn under the sections of
   both keyplans. */
(function () {
  'use strict';
  var D = window.PVMDrone = {};
  var CACHE = 'pvm-drone-v1';
  var MEM_MIN = 160;               // decoded tiles kept in memory (about 1 MB each)
  var RETRY_MS = 20000;            // a tile that could not be loaded is tried again after this
  var idx = null, key = null, keyB64 = null, keyId = null, keyGen = 0, listeners = [];
  var mem = new Map(), failed = new Map(), useCounter = 0, memMax = MEM_MIN, idxLoading = null, idxText = null;
  function noop() { /* nothing */ }

  function P() { return window.PVM || {}; }
  function prefs() { var p = P(); return p.prefs ? p.prefs() : {}; }
  function save(o) { var p = P(); if (p.savePrefs) p.savePrefs(o); }
  // listeners get the kind of change: 'tint' (colour strength only) or 'all'
  D.on = function (fn) { listeners.push(fn); };
  function changed(kind) { listeners.forEach(function (f) { try { f(kind || 'all'); } catch (e) { if (window.console) console.error(e); } }); }
  function baseUrl(path) { return new URL(path, document.baseURI).href; }

  // ------------------------------------------------------------------
  // Key (from the sign-in) and the list of photos
  // ------------------------------------------------------------------
  function bytes(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  D.setKey = function (k) {
    k = typeof k === 'string' && k ? k : null;
    if (k === keyB64) return;
    D.clear();
    keyB64 = k; key = null; keyId = null;
    var gen = ++keyGen;
    if (k && window.crypto && window.crypto.subtle) {
      var raw; try { raw = bytes(k); } catch (e) { raw = null; }
      if (raw && raw.length === 32) {
        // the key id (start of its SHA-256) tells which photos this key opens (index.json "kid")
        Promise.all([window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']),
                     window.crypto.subtle.digest('SHA-256', raw)]).then(function (r) {
          if (gen !== keyGen) return;
          key = r[0]; keyId = hex(r[1]).slice(0, 16); changed();
        }, function () { /* the photo stays off */ });
      }
    }
    changed();
  };
  // forget everything decoded (sign-out, other key)
  D.clear = function () { mem.forEach(drop); mem.clear(); failed.clear(); };
  function drop(e) { e.dead = true; if (e.bmp && e.bmp.close) e.bmp.close(); if (e.url) URL.revokeObjectURL(e.url); e.bmp = null; }
  D.hasKey = function () { return !!key; };
  D.keyGiven = function () { return !!keyB64; };
  function cacheOpen() { return window.caches ? window.caches.open(CACHE) : Promise.reject(new Error('no cache storage')); }
  // the list of photos (public, small); refreshed with every data load, so new photos appear without a reload.
  // drone/photos.json is the list this version reads (it checks each photo's keyplan sheet, update 12);
  // drone/index.json is the older list (Block 1 only), kept for app copies that have not reloaded yet: they cannot
  // check the sheet, so they must not see a photo made for a newer drawing.
  var OLD_LIST = baseUrl('drone/index.json');
  D.loadIndex = function () {
    if (idxLoading) return idxLoading;
    var url = baseUrl('drone/photos.json');
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 10000) : null;
    idxLoading = fetch(url, { cache: 'no-cache', credentials: 'omit', signal: ctl ? ctl.signal : undefined }).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('index ' + res.status);
      var copy = res.clone();
      cacheOpen().then(function (c) { return c.put(url, copy); }).catch(noop);
      return res.text();
    }).catch(function () {
      clearTimeout(timer);
      // no signal: the list kept on this device (the older list if this version has not loaded its own yet)
      return cacheOpen().then(function (c) { return c.match(url).then(function (r) { return r || c.match(OLD_LIST); }); })
        .then(function (r) { return r ? r.text() : null; }).catch(function () { return null; });
    }).then(function (txt) {
      idxLoading = null;
      if (!txt || txt === idxText) return idx;
      var j; try { j = JSON.parse(txt); } catch (e) { j = null; }
      if (j && Array.isArray(j.shots)) { idx = j; idxText = txt; prune(); changed(); }
      return idx;
    });
    return idxLoading;
  };
  // tiles of photos that are no longer listed are removed from the device (a re-made photo gets a new folder)
  function prune() {
    var keep = idx.shots.map(function (s) { return baseUrl(s.path); });
    cacheOpen().then(function (c) {
      return c.keys().then(function (reqs) {
        reqs.forEach(function (rq) {
          if (/\.bin$/.test(rq.url) && !keep.some(function (k) { return rq.url.indexOf(k) === 0; })) c.delete(rq);
        });
      });
    }).catch(noop);
  }
  function newestFirst(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }
  // every photo of a block, whatever key it needs
  function allShots(block) { return idx ? idx.shots.filter(function (s) { return s.block === block; }).sort(newestFirst) : []; }
  // the photos the key from the sign-in opens (a photo made with another key is left out, never shown as blank)
  function opens(s) { return !!key && (!s.kid || s.kid === keyId); }
  // a photo is placed on one keyplan sheet (index.json "kp": its width and height in metres). If the block's keyplan
  // in the database is another drawing (a database update not run yet), the photo would not sit on the tables, so it
  // is left out until the keyplan matches (update 12: the new Block 5 drawing).
  function sheetOf(block) { var p = P(); return p.S && p.S.kp ? p.S.kp[block] : null; }
  function fits(s) {
    if (!s.kp) return true;
    var k = sheetOf(s.block);
    return !!k && Math.abs(+k.width - s.kp[0]) < 0.05 && Math.abs(+k.height - s.kp[1]) < 0.05;
  }
  D.shots = function (block) { return allShots(block).filter(function (s) { return opens(s) && fits(s); }); };
  D.shot = function (block) {
    var list = D.shots(block); if (!list.length) return null;
    var want = prefs()['shot' + block];
    return list.filter(function (s) { return s.id === want; })[0] || list[0];
  };
  D.setShot = function (block, id) { var o = {}; o['shot' + block] = id; save(o); changed(); };
  D.available = function (block) { return !!(key && D.shot(block)); };
  D.isOn = function (block) { return D.available(block) && prefs().photo !== false; };
  D.setOn = function (on) { save({ photo: !!on }); changed(); };
  D.tint = function () { var t = prefs().tint; return typeof t === 'number' && t >= 0 && t <= 1 ? t : 0.4; };
  D.setTint = function (t) { save({ tint: Math.max(0, Math.min(1, t)) }); changed('tint'); };
  D.label = function (s) {
    if (!s) return '';
    var d = new Date(s.date + 'T00:00:00');
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // ------------------------------------------------------------------
  // Tiles: fetch (or take from the device), decrypt, decode
  // ------------------------------------------------------------------
  function levelFor(shot, pxPerM) {
    // the coarsest level that still has at least one picture pixel per screen pixel (a little enlargement is fine)
    var target = 1 / Math.max(pxPerM, 1e-6), best = 0;
    shot.levels.forEach(function (l, i) { if (l.mpp <= target * 1.3) best = i; });
    return best;
  }
  function tileUrl(shot, li, c, r) { return baseUrl(shot.path + li + '/' + c + '_' + r + '.bin'); }
  function fetchBytes(url) {
    return cacheOpen().then(function (c) {
      return c.match(url).then(function (hit) {
        if (hit) return hit.arrayBuffer();
        return fetch(url, { credentials: 'omit' }).then(function (res) {
          if (!res.ok) throw new Error('tile ' + res.status);
          c.put(url, res.clone()).catch(noop);       // kept for use without signal
          return res.arrayBuffer();
        });
      });
    }, function () {
      return fetch(url, { credentials: 'omit' }).then(function (res) { if (!res.ok) throw new Error('tile ' + res.status); return res.arrayBuffer(); });
    });
  }
  function decodeImg(blob, e) {
    return new Promise(function (res, rej) {
      var im = new Image(); e.url = URL.createObjectURL(blob);
      im.onload = function () { res(im); }; im.onerror = rej; im.src = e.url;
    });
  }
  // createImageBitmap where it works; some older browsers have it but cannot read WebP with it
  function decode(blob, e) {
    if (!window.createImageBitmap) return decodeImg(blob, e);
    return window.createImageBitmap(blob).catch(function () { return decodeImg(blob, e); });
  }
  function entry(shot, li, c, r, create) {
    var url = tileUrl(shot, li, c, r), e = mem.get(url);
    if (e) { e.used = ++useCounter; return e; }
    if (!create || !key) return null;
    var f = failed.get(url);
    if (f && Date.now() - f < RETRY_MS) return null;
    e = { bmp: null, url: null, dead: false, waiters: [], used: ++useCounter };
    mem.set(url, e);
    var k = key;
    fetchBytes(url).then(function (buf) {
      var iv = new Uint8Array(buf, 0, 12), data = new Uint8Array(buf, 12);
      var aad = new TextEncoder().encode(shot.id + '/' + li + '/' + c + '_' + r);
      return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: aad }, k, data);
    }).then(function (plain) {
      return decode(new Blob([plain], { type: 'image/' + (shot.fmt || 'webp') }), e);
    }).then(function (bmp) {
      if (e.dead) { if (bmp.close) bmp.close(); return; }
      e.bmp = bmp;
      var w = e.waiters; e.waiters = [];
      w.forEach(function (fn) { fn(); });
    }, function () {
      if (mem.get(url) === e) mem.delete(url);
      failed.set(url, Date.now());
      var w = e.waiters; e.waiters = [];
      setTimeout(function () { w.forEach(function (fn) { fn(); }); }, RETRY_MS + 50);
    });
    trim();
    return e;
  }
  // tiles still on their way (for a loading hint and for tests)
  D.loading = function () { var n = 0; mem.forEach(function (e) { if (!e.bmp && !e.dead) n++; }); return n; };
  function trim() {
    if (mem.size <= memMax) return;
    var list = Array.from(mem.entries()).sort(function (a, b) { return a[1].used - b[1].used; });
    list.slice(0, mem.size - memMax).forEach(function (x) { drop(x[1]); mem.delete(x[0]); });
  }

  // ------------------------------------------------------------------
  // Drawing: the photo for the view v (metres) on a canvas of cssW x cssH CSS pixels.
  // Tiles are placed on whole device pixels, so they join without seams. While the detail
  // loads, the coarser levels already in memory fill in (the coarsest one is always loaded).
  // Returns false when the photo is off for this block.
  // ------------------------------------------------------------------
  D.draw = function (ctx, block, v, cssW, cssH, dpr, onNeed) {
    var shot = D.isOn(block) ? D.shot(block) : null;
    if (!shot || !cssW || !v || !(v.w > 0)) return false;
    var k = cssW / v.w * dpr;                                   // device pixels per metre
    var base = shot.levels.length - 1, li = levelFor(shot, cssW / v.w * Math.min(dpr, 2));
    var ox = shot.origin[0], oy = shot.origin[1];
    function each(L, fn) {
      var l = shot.levels[L], ts = shot.tile * l.mpp;
      var c0 = Math.max(0, Math.floor((v.x - ox) / ts)), c1 = Math.min(l.cols - 1, Math.floor((v.x + v.w - ox) / ts));
      var r0 = Math.max(0, Math.floor((v.y - oy) / ts)), r1 = Math.min(l.rows - 1, Math.floor((v.y + v.h - oy) / ts));
      for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) if (l.have.charAt(r * l.cols + c) === '1') fn(c, r, ts);
    }
    function put(bmp, c, r, ts) {
      var X0 = Math.round((ox + c * ts - v.x) * k), X1 = Math.round((ox + (c + 1) * ts - v.x) * k);
      var Y0 = Math.round((oy + r * ts - v.y) * k), Y1 = Math.round((oy + (r + 1) * ts - v.y) * k);
      if (X1 > X0 && Y1 > Y0) ctx.drawImage(bmp, X0, Y0, X1 - X0, Y1 - Y0);
    }
    function wait(e) { if (e && onNeed && e.waiters.indexOf(onNeed) < 0) e.waiters.push(onNeed); }
    // the detail level: start loading what is missing
    var detail = [], ready = true;
    each(li, function (c, r, ts) {
      var e = entry(shot, li, c, r, true);
      detail.push([e, c, r, ts]);
      if (!e || !e.bmp) { ready = false; wait(e); }
    });
    memMax = Math.max(MEM_MIN, detail.length * 3);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
    if (!ready) {
      for (var L = base; L > li; L--) {
        each(L, function (c, r, ts) {
          var e = entry(shot, L, c, r, L === base);
          if (e && e.bmp) put(e.bmp, c, r, ts); else if (L === base) wait(e);
        });
      }
    }
    detail.forEach(function (d) { if (d[0] && d[0].bmp) put(d[0].bmp, d[1], d[2], d[3]); });
    ctx.restore();
    return true;
  };

  // ------------------------------------------------------------------
  // Use without signal: every tile of a photo kept on the device
  // ------------------------------------------------------------------
  function allTiles(shot) {
    var out = [];
    shot.levels.forEach(function (l, li) {
      for (var r = 0; r < l.rows; r++) for (var c = 0; c < l.cols; c++) if (l.have.charAt(r * l.cols + c) === '1') out.push(tileUrl(shot, li, c, r));
    });
    return out;
  }
  D.savedCount = function (shot) {
    var list = allTiles(shot);
    return cacheOpen().then(function (c) {
      return Promise.all(list.map(function (u) { return c.match(u).then(function (hit) { return hit ? 1 : 0; }); }));
    }).then(function (a) { return { saved: a.reduce(function (x, y) { return x + y; }, 0), total: list.length }; },
      function () { return { saved: 0, total: list.length }; });
  };
  D.saveOffline = function (shot, onProgress) {
    var list = allTiles(shot), i = 0, done = 0, failedN = 0;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(noop);
    return cacheOpen().then(function (c) {
      function next() {
        if (i >= list.length) return Promise.resolve();
        var url = list[i++];
        return c.match(url).then(function (hit) {
          if (hit) return null;
          return fetch(url, { credentials: 'omit' }).then(function (res) { if (!res.ok) throw new Error('tile'); return c.put(url, res); });
        }).then(function () { done++; }, function () { failedN++; }).then(function () {
          if (onProgress) onProgress(done + failedN, list.length);
          return next();
        });
      }
      return Promise.all([next(), next(), next(), next()]);
    }).then(function () { return { done: done, failed: failedN, total: list.length }; },
      function () { return { done: 0, failed: list.length, total: list.length }; });
  };

  // ------------------------------------------------------------------
  // The background button (top left of each keyplan) and its menu. Where the menu does not fit
  // (small phones), the same settings open in the app's dialog instead.
  // ------------------------------------------------------------------
  function icon() {
    var NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 20 20'); s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'layer-ico');
    ['M10 2.5 2 6.5l8 4 8-4z', 'M2 10l8 4 8-4', 'M2 13.5l8 4 8-4'].forEach(function (d) {
      var p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    });
    return s;
  }
  var openBox = null, saving = {};
  // a click outside closes the menu (a control replaced while handling the click is not "outside")
  document.addEventListener('click', function (e) {
    if (openBox && document.documentElement.contains(e.target) && !openBox.contains(e.target)) closePop(openBox);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !openBox) return;
    var b = openBox; closePop(b);
    var t = b.querySelector('.layer-btn'); if (t) t.focus();
  });
  function closePop(box) {
    if (box._pop) { box._pop.hidden = true; box._pop.textContent = ''; var b = box.querySelector('.layer-btn'); if (b) b.setAttribute('aria-expanded', 'false'); }
    box.classList.remove('open');
    if (openBox === box) openBox = null;
  }
  function saveText(id) { var x = saving[id]; return x ? x.msg : ''; }
  function showSave(id) { $$q('[data-save-st="' + id + '"]').forEach(function (el) { el.textContent = saveText(id); }); $$q('[data-save-btn="' + id + '"]').forEach(function (b) { b.disabled = !!(saving[id] && saving[id].busy); }); }
  function $$q(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function startSave(s) {
    if (saving[s.id] && saving[s.id].busy) return;
    saving[s.id] = { busy: true, msg: 'Saving… 0%' }; showSave(s.id);
    D.saveOffline(s, function (n, t) { saving[s.id].msg = 'Saving… ' + Math.floor(100 * n / t) + '%'; showSave(s.id); }).then(function (r) {
      saving[s.id] = { busy: false, msg: r.failed ? 'Saved ' + (r.total - r.failed) + ' of ' + r.total + ' parts. Connect and press again for the rest.'
        : 'Saved on this device: the photo also shows without signal.' };
      showSave(s.id);
    });
  }
  // the settings, into a menu or the dialog
  function fill(target, block, inDialog) {
    var h = P().h;
    target.textContent = '';
    var s = D.shot(block), isOn = D.isOn(block), shots = D.shots(block);
    if (!s) return;
    if (!inDialog) target.appendChild(h('div', { class: 'layer-head', text: 'Keyplan background' }));
    target.appendChild(h('div', { class: 'seg layer-seg', role: 'group', 'aria-label': 'Background' },
      h('button', { type: 'button', 'aria-pressed': String(isOn), 'data-layer': 'photo', text: 'Drone photo', onclick: function () { D.setOn(true); } }),
      h('button', { type: 'button', 'aria-pressed': String(!isOn), 'data-layer': 'drawing', text: 'Drawing only', onclick: function () { D.setOn(false); } })));
    var sel = h('select', { id: 'layer-date-' + block, disabled: !isOn },
      shots.map(function (x, i) { return h('option', { value: x.id, text: D.label(x) + (i === 0 ? ' (latest)' : ''), selected: x.id === s.id }); }));
    sel.addEventListener('change', function () { D.setShot(block, sel.value); });
    target.appendChild(h('label', { class: 'layer-row', for: 'layer-date-' + block }, h('span', { text: 'Photo date' }), sel));
    var rng = h('input', { type: 'range', id: 'layer-tint-' + block, min: 0, max: 100, step: 5, value: Math.round(D.tint() * 100), disabled: !isOn });
    var rv = h('output', { class: 'layer-val', for: 'layer-tint-' + block, text: Math.round(D.tint() * 100) + '%' });
    rng.addEventListener('input', function () { rv.textContent = rng.value + '%'; D.setTint(rng.value / 100); });
    target.appendChild(h('label', { class: 'layer-row', for: 'layer-tint-' + block }, h('span', { text: 'Status colours' }), rng, rv));
    var off = h('button', { type: 'button', class: 'btn small', id: 'layer-save-' + block, 'data-save-btn': s.id, disabled: !!(saving[s.id] && saving[s.id].busy),
      text: 'Save for use without signal (' + Math.max(1, Math.round(s.bytes / 1e6)) + ' MB)', onclick: function () { startSave(s); } });
    var st = h('p', { class: 'small muted layer-st', role: 'status', 'data-save-st': s.id, text: saveText(s.id) });
    target.appendChild(h('div', { class: 'layer-save' }, off, st));
    if (!saving[s.id]) D.savedCount(s).then(function (c) { if (c.total && c.saved === c.total && !saving[s.id]) { saving[s.id] = { busy: false, msg: 'Already saved on this device.' }; showSave(s.id); } });
    var q = s.fit || {};
    target.appendChild(h('p', { class: 'small muted layer-about', text: 'Drone photo of Block ' + block + ' taken ' + D.label(s) + ', placed on the keyplan at true size (' +
      Math.round(s.levels[0].mpp * 100) + ' cm per pixel' + (q.median_m ? '; sections match the photo within about ' + (Math.max(0.05, Math.round(q.median_m * 20) / 20)).toFixed(2) + ' m' : '') +
      '). Status colours stay on top; lower them to see more of the photo.' }));
  }
  D.control = function (box, block) {
    if (!box) return;
    var h = P().h; if (!h) return;
    var wasOpen = !!(box._pop && !box._pop.hidden);
    box.textContent = ''; box._pop = null; box.classList.remove('open');
    if (openBox === box) openBox = null;
    var list = D.shots(block), user = P().S && P().S.user, admin = !!(user && user.role === 'admin');
    // the settings dialog of this block, if open, follows the change
    var dlg = document.getElementById('layer-dialog-' + block);
    if (dlg) { if (key && list.length) fill(dlg, block, true); else if (P().closeModal) P().closeModal(); }
    if (!allShots(block).length) { box.hidden = true; return; }
    function note(text) {
      box.hidden = false;
      box.appendChild(h('div', { class: 'layer-note', role: 'note', text: text }));
    }
    if (!key) {
      // the administrator sees why the photo is missing until database update 11 is installed
      if (admin && !keyB64) note('Drone photo: needs database update 11'); else box.hidden = true;
      return;
    }
    if (!list.length) {
      // the photo is made for a newer keyplan than the database has (update 12 for Block 5), or with a newer key
      // than the database has (the latest update 11 file)
      var later = allShots(block).filter(function (s) { return opens(s) && !fits(s); })[0];
      if (admin) note(later ? 'Drone photo: run database update ' + (later.update || 12) + ' (new keyplan)' : 'Drone photo: run the latest database update 11');
      else box.hidden = true;
      return;
    }
    box.hidden = false;
    var cur = D.shot(block), on = D.isOn(block);
    var btn = h('button', { type: 'button', class: 'layer-btn' + (on ? ' on' : ''), 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-label': 'Keyplan background: ' + (on ? 'drone photo of ' + D.label(cur) : 'drawing only') + '. Change', title: 'Keyplan background' },
      icon(), h('span', { class: 'layer-txt', text: on ? D.label(cur) : 'Photo off' }));
    var pop = h('div', { class: 'layer-pop', hidden: true, role: 'dialog', 'aria-label': 'Keyplan background' });
    box._pop = pop;
    function openPop() {
      if (openBox && openBox !== box) closePop(openBox);
      fill(pop, block, false); pop.hidden = false;
      var r = pop.getBoundingClientRect();
      if ((r.bottom > window.innerHeight - 8 || r.right > window.innerWidth - 4) && P().openModal) {
        // not enough room next to the button: the same settings in the dialog
        pop.hidden = true; pop.textContent = '';
        var body = h('div', { class: 'layer-dialog', id: 'layer-dialog-' + block });
        P().openModal('Keyplan background', body);
        fill(body, block, true);
        var first = body.querySelector('button'); if (first) first.focus();
        return;
      }
      btn.setAttribute('aria-expanded', 'true'); openBox = box; box.classList.add('open');
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (pop.hidden) openPop(); else closePop(box);
    });
    box.appendChild(btn); box.appendChild(pop);
    if (wasOpen) { fill(pop, block, false); pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); openBox = box; box.classList.add('open'); }
  };
})();
