/* PV Module Serial Numbers — camera barcode scanning, label photos and OCR */
/* global Html5Qrcode, Html5QrcodeSupportedFormats */
(function () {
  'use strict';
  var SN = window.SN;
  var cap = (SN.capture = {});
  var PHOTO_MAX = 1400, PHOTO_Q = 0.8, THUMB_MAX = 360, THUMB_Q = 0.72;

  function formats() {
    var F = window.Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    return [F.CODE_128, F.CODE_39, F.CODE_93, F.CODABAR, F.ITF, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.QR_CODE, F.DATA_MATRIX, F.PDF_417]
      .filter(function (x) { return x !== undefined; });
  }

  cap.liveSupported = function () {
    return !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.Html5Qrcode);
  };


  // ---------- decoder (ZXing via html5-qrcode, or the phone's native BarcodeDetector) ----------
  var decoderHost = 'sn-decoder-host', decoder = null;
  function getDecoder() {
    if (decoder) return decoder;
    if (!window.Html5Qrcode) return null;
    if (!document.getElementById(decoderHost)) {
      var d = document.createElement('div'); d.id = decoderHost; d.className = 'offscreen'; document.body.appendChild(d);
    }
    var h = new Html5Qrcode(decoderHost, { formatsToSupport: formats(), useBarCodeDetectorIfSupported: true, verbose: false });
    decoder = h.qrcode;
    return decoder;
  }
  function decodeCanvas(canvas) {
    var dec = getDecoder();
    if (!dec) return Promise.resolve(null);
    return dec.decodeAsync(canvas).then(function (r) {
      if (!r || !r.text) return null;
      var f = (r.format && (r.format.formatName || r.format.format)) || (r.result && r.result.format && r.result.format.formatName) || '';
      return { text: String(r.text).trim(), format: typeof f === 'string' ? f : String(f) };
    }, function () { return null; });
  }

  // Live scanner: our own camera loop so every frame is decoded at the camera's full
  // resolution (dense 15-character Code 128 labels need it), inside the centre band.
  cap.startLive = function (containerId, onDecoded) {
    var host = document.getElementById(containerId);
    var video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.muted = true; video.autoplay = true;
    var guide = document.createElement('div'); guide.className = 'scan-guide';
    var laser = document.createElement('div'); laser.className = 'scan-laser'; guide.appendChild(laser);
    host.innerHTML = '';
    host.appendChild(video); host.appendChild(guide);
    var stream = null, stopped = false, done = false, timer = 0, busy = false, frames = 0;
    var work = document.createElement('canvas');
    function stopAll() {
      stopped = true; clearTimeout(timer);
      if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      stream = null;
      try { video.srcObject = null; } catch (e) { /* ignore */ }
    }
    function tick() {
      if (stopped || done) return;
      if (busy || video.readyState < 2 || !video.videoWidth) { timer = setTimeout(tick, 80); return; }
      busy = true; frames++;
      var vw = video.videoWidth, vh = video.videoHeight;
      // centre band; every third frame use a taller band in case the label is further away
      var bandH = frames % 3 === 0 ? 0.8 : 0.5;
      var sx = Math.round(vw * 0.03), sw = Math.round(vw * 0.94), sh = Math.round(vh * bandH), sy = Math.round((vh - sh) / 2);
      var k = Math.min(1, 1600 / sw);
      work.width = Math.round(sw * k); work.height = Math.round(sh * k);
      work.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, work.width, work.height);
      decodeCanvas(work).then(function (r) {
        busy = false;
        if (stopped || done) return;
        if (r && r.text) {
          done = true;
          var frame = document.createElement('canvas');
          frame.width = vw; frame.height = vh;
          frame.getContext('2d').drawImage(video, 0, 0);
          if (navigator.vibrate) { try { navigator.vibrate(80); } catch (e) { /* ignore */ } }
          onDecoded(r.text, r.format, frame);
          return;
        }
        timer = setTimeout(tick, 60);
      });
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (s) {
      stream = s;
      if (stopped) { stopAll(); throw new Error('stopped'); }
      var track = s.getVideoTracks()[0];
      try {
        var caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
      } catch (e) { /* optional */ }
      video.srcObject = s;
      return video.play().catch(function () {});
    }).then(function () {
      getDecoder();
      tick();
      var track = stream && stream.getVideoTracks()[0];
      return {
        stop: function () { stopAll(); host.innerHTML = ''; return Promise.resolve(); },
        resume: function () { done = false; tick(); },
        grab: function () { var c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; c.getContext('2d').drawImage(video, 0, 0); return c; },
        hasTorch: function () { try { var c = track.getCapabilities(); return !!(c && c.torch); } catch (e) { return false; } },
        torch: function (on) { return track.applyConstraints({ advanced: [{ torch: !!on }] }).then(function () { return true; }, function () { return false; }); }
      };
    }, function (e) { stopAll(); host.innerHTML = ''; throw e; });
  };

  // ---------- photos ----------
  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { resolve(img); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file is not a readable photo.')); };
      img.src = url;
    });
  }
  function scaled(src, max) {
    var w = src.naturalWidth || src.videoWidth || src.width, h = src.naturalHeight || src.videoHeight || src.height;
    var k = Math.min(1, max / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    var g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('Could not encode the photo.')); }, 'image/jpeg', q);
    });
  }
  // source: File/Blob from the camera, or a canvas grabbed from the live video
  cap.processPhoto = function (source) {
    var p = source instanceof HTMLCanvasElement ? Promise.resolve(source) : loadImage(source);
    return p.then(function (img) {
      var full = scaled(img, PHOTO_MAX), thumb = scaled(img, THUMB_MAX);
      return Promise.all([toBlob(full, PHOTO_Q), toBlob(thumb, THUMB_Q)]).then(function (b) {
        return { full: b[0], thumb: b[1], width: full.width, height: full.height, source: img };
      });
    });
  };

  // ---------- barcode from a still photo ----------
  function rotated(src) {
    var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    var c = document.createElement('canvas'); c.width = h; c.height = w;
    var g = c.getContext('2d'); g.translate(h, 0); g.rotate(Math.PI / 2); g.drawImage(src, 0, 0);
    return c;
  }
  function viaNative(canvas) {
    if (!('BarcodeDetector' in window)) return Promise.resolve(null);
    var det;
    try { det = new window.BarcodeDetector(); } catch (e) { return Promise.resolve(null); }
    return det.detect(canvas).then(function (res) {
      if (!res || !res.length) return null;
      res.sort(function (a, b) { return (b.rawValue || '').length - (a.rawValue || '').length; });
      return { text: String(res[0].rawValue || '').trim(), format: String(res[0].format || '').toUpperCase() };
    }, function () { return null; });
  }
  function viaZxing(canvas) { return decodeCanvas(canvas); }
  // Tries the fast native detector, then ZXing on a reduced copy, a rotated copy and the full image.
  cap.decodeStill = function (img) {
    var small = scaled(img, 1800);
    var tries = [function () { return viaNative(small); }, function () { return viaZxing(small); },
                 function () { return viaZxing(rotated(small)); }];
    var big = img.naturalWidth || img.width;
    if (big > 1900) tries.push(function () { return viaZxing(scaled(img, 3200)); });
    var i = 0;
    function next() {
      if (i >= tries.length) return Promise.resolve(null);
      return tries[i++]().then(function (r) { return r && r.text ? r : next(); }, next);
    }
    return next();
  };

  // ---------- OCR ----------
  var worker = null, seq = 0, pending = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('js/ocr-worker.js?v=' + (SN.version || '1'));
    worker.onmessage = function (e) {
      var d = e.data || {}, p = pending.get(d.id);
      if (!p) return;
      if (d.progress) { if (p.onProgress) p.onProgress(d.progress); return; }
      pending.delete(d.id);
      if (d.ok) p.resolve(d); else p.reject(new Error(d.error || 'OCR failed'));
    };
    worker.onerror = function () {
      pending.forEach(function (p) { p.reject(new Error('The OCR engine could not start on this device.')); });
      pending.clear(); worker = null;
    };
    return worker;
  }
  // Finds the barcode in a photo (strong vertical edges, weak horizontal ones) so OCR can
  // read the printed line right above/below it. Returns a box in the image's pixels, or null.
  function locateBarcode(img) {
    var c = scaled(img, 640), W = c.width, H = c.height;
    var d = c.getContext('2d').getImageData(0, 0, W, H).data, n = W * H, i, x, y;
    var g = new Float32Array(n);
    for (i = 0; i < n; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    var m = new Float32Array(n);
    for (y = 1; y < H - 1; y++) for (x = 1; x < W - 1; x++) {
      i = y * W + x;
      var gx = Math.abs(g[i + 1] - g[i - 1]), gy = Math.abs(g[i + W] - g[i - W]);
      m[i] = Math.max(0, gx - gy);
    }
    function blur(src, rx, ry) {
      var tmp = new Float32Array(n), out = new Float32Array(n), xx, yy, acc;
      for (yy = 0; yy < H; yy++) { acc = 0; for (xx = -rx; xx < W; xx++) {
        if (xx + rx < W) acc += src[yy * W + xx + rx];
        if (xx - rx - 1 >= 0) acc -= src[yy * W + xx - rx - 1];
        if (xx >= 0) tmp[yy * W + xx] = acc / (2 * rx + 1);
      } }
      for (xx = 0; xx < W; xx++) { acc = 0; for (yy = -ry; yy < H; yy++) {
        if (yy + ry < H) acc += tmp[(yy + ry) * W + xx];
        if (yy - ry - 1 >= 0) acc -= tmp[(yy - ry - 1) * W + xx];
        if (yy >= 0) out[yy * W + xx] = acc / (2 * ry + 1);
      } }
      return out;
    }
    var b = blur(m, 7, 4), max = 0;
    for (i = 0; i < n; i++) if (b[i] > max) max = b[i];
    if (max < 8) return null;
    var th = max * 0.35, lab = new Int32Array(n), best = null, id = 0, stack = [];
    for (i = 0; i < n; i++) {
      if (b[i] < th || lab[i]) continue;
      id++; var x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0;
      stack.push(i); lab[i] = id;
      while (stack.length) {
        var k = stack.pop(), kx = k % W, ky = (k / W) | 0; cnt++;
        if (kx < x0) x0 = kx; if (kx > x1) x1 = kx; if (ky < y0) y0 = ky; if (ky > y1) y1 = ky;
        [k - 1, k + 1, k - W, k + W].forEach(function (q) {
          if (q >= 0 && q < n && !lab[q] && b[q] >= th && Math.abs((q % W) - kx) <= 1) { lab[q] = id; stack.push(q); }
        });
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      if (bw > W * 0.12 && bw > bh * 1.2 && (!best || cnt > best.cnt)) best = { x: x0, y: y0, w: bw, h: bh, cnt: cnt };
    }
    if (!best) return null;
    var k2 = (img.naturalWidth || img.width) / W;
    return { x: best.x * k2, y: best.y * k2, w: best.w * k2, h: best.h * k2 };
  }
  cap.locateBarcode = locateBarcode;

  function crop(img, x, y, w, h, maxW) {
    var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    x = Math.max(0, x); y = Math.max(0, y); w = Math.min(iw - x, w); h = Math.min(ih - y, h);
    if (w < 20 || h < 10) return null;
    var k = Math.min(3, Math.max(1, 900 / w), (maxW || 1800) / w);
    var c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    var g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
    g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return c;
  }
  function ocrPrep(canvas) {
    // grayscale + contrast stretch helps Tesseract on glossy labels
    var g = canvas.getContext('2d');
    var d = g.getImageData(0, 0, canvas.width, canvas.height), px = d.data, hist = new Uint32Array(256), n = px.length / 4, i;
    for (i = 0; i < px.length; i += 4) {
      var y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0;
      px[i] = y; hist[y]++;
    }
    var lo = 0, hi = 255, acc = 0;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.02) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.02) { hi = i; break; } }
    var span = Math.max(1, hi - lo);
    for (i = 0; i < px.length; i += 4) {
      var v = Math.max(0, Math.min(255, ((px[i] - lo) * 255) / span));
      px[i] = px[i + 1] = px[i + 2] = v;
    }
    g.putImageData(d, 0, 0);
    return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); })
      .then(function (blob) { return blob.arrayBuffer(); });
  }
  function ocrRun(canvas, psm, want, onProgress) {
    return ocrPrep(canvas).then(function (buf) {
      return new Promise(function (resolve, reject) {
        var id = ++seq, w;
        try { w = getWorker(); } catch (e) { reject(new Error('OCR is not supported in this browser.')); return; }
        pending.set(id, { resolve: resolve, reject: reject, onProgress: onProgress });
        var base = new URL('vendor/tesseract/', location.href).href;
        w.postMessage({ id: id, base: base, image: buf, want: want || null, psm: psm }, [buf]);
        setTimeout(function () {
          if (pending.has(id)) { pending.delete(id); reject(new Error('OCR took too long on this device.')); }
        }, 120000);
      });
    });
  }
  // Reads the printed serial: first the text lines just below and above the barcode
  // (single-line mode, enlarged), then the whole label as a fallback. Stops early when a
  // reading matches the barcode.
  cap.ocr = function (img, opts) {
    opts = opts || {};
    var want = opts.want ? SN.u.normSerial(opts.want) : null;
    var box = locateBarcode(img), jobs = [];
    if (box) {
      var padX = box.w * 0.12;
      jobs.push({ c: crop(img, box.x - padX, box.y + box.h * 0.98, box.w + padX * 2, box.h * 0.55), psm: '7', where: 'below' });
      jobs.push({ c: crop(img, box.x - padX, box.y - box.h * 0.55, box.w + padX * 2, box.h * 0.57), psm: '7', where: 'above' });
    }
    jobs.push({ c: scaled(img, 1800), psm: '11', where: 'label' });
    jobs = jobs.filter(function (j) { return j.c; });
    var results = [];
    var chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function (stop) {
        if (stop) return true;
        return ocrRun(j.c, j.psm, want, opts.onProgress).then(function (r) {
          r.where = j.where; results.push(r);
          return !!(want && r.text.replace(/\s+/g, '').toUpperCase().indexOf(want) >= 0);
        });
      });
    });
    return chain.then(function () {
      if (!results.length) throw new Error('OCR found no text.');
      // merge: the text of every run (so candidates can come from any of them), the
      // confidence of the run that produced the best candidate
      var text = results.map(function (r) { return r.text; }).join('\n');
      var words = [].concat.apply([], results.map(function (r) { return r.words || []; }));
      var conf = Math.max.apply(null, results.map(function (r) { return r.conf; }));
      return { text: text, words: words, conf: conf, runs: results.length, located: !!box };
    });
  };
  // Picks serial-number-like strings from OCR text, best first. Neighbouring tokens on a
  // line are also tried joined ("H 0624..." -> "H0624..."), since OCR often splits them.
  cap.candidates = function (text, words, barcode) {
    var want = SN.u.normSerial(barcode || '');
    var conf = {};
    (words || []).forEach(function (w) { conf[SN.u.normSerial(w.t)] = w.c; });
    var found = new Map();
    String(text || '').toUpperCase().split(/\n+/).forEach(function (line) {
      var toks = line.split(/[^A-Z0-9]+/).filter(Boolean);
      for (var i = 0; i < toks.length; i++) {
        for (var j = i; j < Math.min(toks.length, i + 3); j++) {
          var parts = toks.slice(i, j + 1), t = parts.join('');
          if (t.length < 8 || !/\d{4,}/.test(t) || found.has(t)) continue;
          var cs = parts.map(function (p) { return conf[p]; }).filter(function (c) { return c !== undefined; });
          found.set(t, { value: t, parts: parts.length, conf: cs.length ? Math.min.apply(null, cs) : null });
        }
      }
    });
    var out = Array.from(found.values());
    out.forEach(function (c) {
      c.score = want ? 100 - SN.u.levenshtein(c.value, want) * 10 + (c.value === want ? 50 : 0) - c.parts
        : c.value.length + c.value.replace(/\D/g, '').length * 0.5 - (c.parts - 1) * 3;
    });
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  };
})();
