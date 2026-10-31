/* Solar PV Installation Monitoring — Admin > Drone photos (database update 13).
   An administrator adds a new drone photo from the browser: block, the date the photo was taken, the file
   (GeoTIFF from the drone software, or PNG / JPG). Everything happens in this browser:
     1. the photo is read (GeoTIFF: its position in WGS 84 / UTM is read too),
     2. it is placed on the block's keyplan: automatically from the GeoTIFF position when the block's GPS
        position is known (pvm.drone_georef), otherwise by two points the user marks on the photo and on the
        keyplan; the result is shown over the sections (and the previous photo) and can be nudged,
     3. it is resampled to keyplan metres (5 cm per pixel at the finest level, then 10, 20 ... cm), cut into
        512 px WebP pieces, each encrypted with the photo key (AES-256-GCM, bound to its place: same format as
        the published photos, drone.js), and uploaded to Supabase Storage (bucket pvm-drone, folder = photo id),
     4. the photo is listed for everyone (admin_drone_finish) and appears in the keyplan's photo date list.
   Loaded only when an administrator opens Admin > Drone photos. */
(function () {
  'use strict';
  var U = window.PVMDroneUpload = {};
  var TILE = 512, MPP0 = 0.05, MARGIN = 100;
  var MAX_SIDE = 16384, MAX_AREA = 150e6;           // the largest picture the browser is asked to hold
  function P() { return window.PVM; }
  function D() { return window.PVMDrone; }
  function h() { return P().h.apply(null, arguments); }
  function cfg() { return window.PVM_CONFIG || {}; }
  function noop() { /* nothing */ }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function mb(n) { return n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.max(0.1, Math.round(n / 1e5) / 10) + ' MB'; }
  function nextFrame() { return new Promise(function (r) { (window.requestAnimationFrame || setTimeout)(function () { r(); }); }); }

  // ==================================================================
  // 1. Reading the photo
  // ==================================================================
  // ---- TIFF / GeoTIFF (baseline strips or tiles, 8 bit, gray / RGB / RGBA; none, LZW, Deflate, PackBits, JPEG)
  var T_TYPES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
  function readBytes(file, off, len) { return file.slice(off, off + len).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
  function tiffInfo(file) {
    return readBytes(file, 0, 16).then(function (hd) {
      var le = hd[0] === 0x49 && hd[1] === 0x49, be = hd[0] === 0x4d && hd[1] === 0x4d;
      if (!le && !be) throw new Error('This is not a TIFF file.');
      var dv = new DataView(hd.buffer), magic = dv.getUint16(2, le), big = magic === 43;
      if (magic !== 42 && !big) throw new Error('This is not a TIFF file.');
      var first = big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le);
      function u(d, o, size) {
        return size === 1 ? d.getUint8(o) : size === 2 ? d.getUint16(o, le) : size === 4 ? d.getUint32(o, le) : Number(d.getBigUint64(o, le));
      }
      function vals(type, count, d, o) {
        var out = [], size = T_TYPES[type] || 1;
        for (var i = 0; i < count; i++) {
          var p = o + i * size;
          if (type === 12) out.push(d.getFloat64(p, le));
          else if (type === 11) out.push(d.getFloat32(p, le));
          else if (type === 5 || type === 10) out.push((type === 5 ? d.getUint32(p, le) : d.getInt32(p, le)) / ((type === 5 ? d.getUint32(p + 4, le) : d.getInt32(p + 4, le)) || 1));
          else if (type === 6) out.push(d.getInt8(p));
          else if (type === 8) out.push(d.getInt16(p, le));
          else if (type === 9) out.push(d.getInt32(p, le));
          else out.push(u(d, p, size));
        }
        return out;
      }
      function readIfd(off) {
        var cntSize = big ? 8 : 2, entSize = big ? 20 : 12;
        return readBytes(file, off, cntSize).then(function (cb) {
          var n = u(new DataView(cb.buffer), 0, cntSize);
          if (n > 4000) throw new Error('This TIFF file could not be read.');
          return readBytes(file, off + cntSize, n * entSize + (big ? 8 : 4)).then(function (eb) {
            var d = new DataView(eb.buffer), tags = {}, waits = [];
            for (var i = 0; i < n; i++) {
              var o = i * entSize, tag = d.getUint16(o, le), type = d.getUint16(o + 2, le);
              var count = big ? Number(d.getBigUint64(o + 4, le)) : d.getUint32(o + 4, le);
              var bytes = (T_TYPES[type] || 1) * count, inl = big ? 8 : 4, vo = o + (big ? 12 : 8);
              if (bytes <= inl) {
                tags[tag] = type === 2 ? new TextDecoder().decode(new Uint8Array(eb.buffer, vo, count)).replace(/\0+$/, '') : vals(type, count, d, vo);
              } else {
                (function (tag, type, count, bytes, ptr) {
                  waits.push(readBytes(file, ptr, bytes).then(function (vb) {
                    tags[tag] = type === 2 ? new TextDecoder().decode(vb).replace(/\0+$/, '') : vals(type, count, new DataView(vb.buffer), 0);
                  }));
                })(tag, type, count, bytes, u(d, vo, inl));
              }
            }
            var nextOff = u(d, n * entSize, big ? 8 : 4);
            return Promise.all(waits).then(function () { return { tags: tags, next: nextOff }; });
          });
        });
      }
      // the first full-resolution image (overviews and masks are skipped)
      function find(off, guard) {
        if (!off || guard > 50) throw new Error('This TIFF file has no readable image.');
        return readIfd(off).then(function (r) {
          var sub = r.tags[254] ? r.tags[254][0] : 0;
          if (sub & 5) return find(r.next, guard + 1);
          return r.tags;
        });
      }
      return find(first, 0).then(function (t) {
        var g = function (k, d) { return t[k] !== undefined ? t[k] : d; };
        var W = g(256)[0], H = g(257)[0], spp = g(277, [1])[0], bps = g(258, [8]), comp = g(259, [1])[0];
        var info = {
          le: le, W: W, H: H, spp: spp, comp: comp, photometric: g(262, [spp >= 3 ? 2 : 1])[0], planar: g(284, [1])[0],
          predictor: g(317, [1])[0], extra: g(338, []), tiled: !!t[322],
          tw: t[322] ? t[322][0] : W, th: t[323] ? t[323][0] : g(278, [H])[0],
          offsets: t[322] ? t[324] : t[273], counts: t[322] ? t[325] : t[279], jpegTables: t[347] || null,
          date: typeof t[306] === 'string' ? t[306] : null, nodata: typeof t[42113] === 'string' ? parseFloat(t[42113]) : null, geo: null
        };
        if (bps.some(function (b) { return b !== 8; })) throw new Error('This TIFF has ' + bps[0] + '-bit colours; export the photo with 8-bit colours (RGB or RGBA).');
        if ([1, 5, 7, 8, 32946, 32773].indexOf(comp) < 0) throw new Error('This TIFF uses a compression the browser cannot read (' + comp + '). Export it uncompressed, LZW or Deflate, or as PNG.');
        if (info.planar !== 1 && spp > 1) throw new Error('This TIFF stores each colour separately (planar). Export it with interleaved pixels, or as PNG.');
        if ([1, 2, 6, 0].indexOf(info.photometric) < 0) throw new Error('This TIFF colour type is not supported. Export it as RGB, or as PNG.');
        if (!info.offsets || !info.counts) throw new Error('This TIFF file has no readable image.');
        // GeoTIFF: pixel corner (u, v) -> projected metres, and the projection (EPSG)
        var keys = t[34735], epsg = null, rasterPoint = false;
        if (keys) {
          for (var i = 4; i + 3 < keys.length; i += 4) {
            if ((keys[i] === 3072 || keys[i] === 2048) && keys[i + 1] === 0 && keys[i] === 3072) epsg = keys[i + 3];
            if (keys[i] === 1025 && keys[i + 1] === 0) rasterPoint = keys[i + 3] === 2;
          }
        }
        var A = null;
        if (t[34264] && t[34264].length >= 8) { var m = t[34264]; A = [m[0], m[1], m[3], m[4], m[5], m[7]]; }
        else if (t[33550] && t[33922]) {
          var s = t[33550], tp = t[33922];
          A = [s[0], 0, tp[3] - tp[0] * s[0], 0, -s[1], tp[4] + tp[1] * s[1]];
        }
        if (A && rasterPoint) { A[2] -= 0.5 * (A[0] + A[1]); A[5] -= 0.5 * (A[3] + A[4]); }
        if (A) info.geo = { A: A, epsg: epsg, mpp: Math.sqrt(Math.abs(A[0] * A[4] - A[1] * A[3])), name: typeof t[34737] === 'string' ? t[34737].split('|')[0] : '' };
        return info;
      });
    });
  }
  function lzw(input, outLen) {
    var out = new Uint8Array(outLen), op = 0;
    var prefix = new Int32Array(4096), suffix = new Uint8Array(4096), len = new Int32Array(4096), firstB = new Uint8Array(4096);
    for (var i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; len[i] = 1; firstB[i] = i; }
    var next = 258, width = 9, bit = 0, old = -1, n = input.length;
    function read() {
      var p = bit >>> 3; if (p >= n) return 257;
      var v = (input[p] << 16) | ((p + 1 < n ? input[p + 1] : 0) << 8) | (p + 2 < n ? input[p + 2] : 0);
      var s = bit & 7; bit += width;
      return (v >>> (24 - s - width)) & ((1 << width) - 1);
    }
    function emit(c) {
      var l = len[c], end = op + l;
      for (var k = end - 1; k >= op; k--) { if (k < outLen) out[k] = suffix[c]; c = prefix[c]; }
      op = end;
    }
    function add(p, b) {
      if (next < 4096) { prefix[next] = p; suffix[next] = b; len[next] = len[p] + 1; firstB[next] = firstB[p]; next++; }
      if (next + 1 >= (1 << width) && width < 12) width++;
    }
    while (op < outLen) {
      var code = read();
      if (code === 257) break;
      if (code === 256) {
        next = 258; width = 9; code = read();
        if (code === 257) break;
        emit(code); old = code; continue;
      }
      if (old < 0) { emit(code); old = code; continue; }
      if (code < next) { emit(code); add(old, firstB[code]); }
      else { add(old, firstB[old]); emit(code); }
      old = code;
    }
    return out;
  }
  function packbits(input, outLen) {
    var out = new Uint8Array(outLen), i = 0, o = 0;
    while (i < input.length && o < outLen) {
      var n = input[i++]; if (n > 127) n -= 256;
      if (n >= 0) { for (var k = 0; k <= n && o < outLen; k++) out[o++] = input[i++]; }
      else if (n !== -128) { var b = input[i++]; for (var k2 = 0; k2 < 1 - n && o < outLen; k2++) out[o++] = b; }
    }
    return out;
  }
  function inflate(input) {
    if (!window.DecompressionStream) return Promise.reject(new Error('This browser cannot read Deflate TIFF files. Use Chrome or Edge, or export LZW / PNG.'));
    var ds = new DecompressionStream('deflate');
    return new Response(new Blob([input]).stream().pipeThrough(ds)).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }
  // one strip / tile of raw bytes -> RGBA pixels (w x h)
  function decodeBlock(info, raw, w, h) {
    var spp = info.spp, need = w * h * spp;
    var p = info.comp === 1 ? Promise.resolve(raw) : info.comp === 5 ? Promise.resolve(lzw(raw, need))
      : info.comp === 32773 ? Promise.resolve(packbits(raw, need)) : inflate(raw);
    return p.then(function (b) {
      if (info.predictor === 2) {
        for (var y = 0; y < h; y++) {
          var r0 = y * w * spp;
          for (var x = spp; x < w * spp; x++) b[r0 + x] = (b[r0 + x] + b[r0 + x - spp]) & 255;
        }
      }
      var out = new Uint8ClampedArray(w * h * 4), alpha = spp >= 4 || (spp === 2);
      var nd = info.nodata, gray = spp <= 2, inv = info.photometric === 0;
      for (var i = 0, j = 0; i < w * h; i++, j += spp) {
        var r, g, bl, a;
        if (gray) { r = g = bl = inv ? 255 - b[j] : b[j]; a = spp === 2 ? b[j + 1] : 255; }
        else { r = b[j]; g = b[j + 1]; bl = b[j + 2]; a = spp >= 4 ? b[j + 3] : 255; }
        if (!alpha && nd !== null && r === nd && g === nd && bl === nd) a = 0;
        out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = bl; out[i * 4 + 3] = a;
      }
      return out;
    });
  }
  function jpegBlock(info, raw) {
    var parts = [];
    if (info.jpegTables) { var t = new Uint8Array(info.jpegTables); parts.push(t.subarray(0, t.length - 2)); parts.push(raw.subarray(2)); }
    else parts.push(raw);
    return createImageBitmap(new Blob(parts, { type: 'image/jpeg' }));
  }

  // The picture into a canvas (reduced by a whole factor k when it is too large for the browser).
  // onProgress(fraction)
  function tiffToCanvas(file, info, k, onProgress) {
    var W = info.W, H = info.H, oW = Math.ceil(W / k), oH = Math.ceil(H / k);
    var cv = makeCanvas(oW, oH), ctx = cv.getContext('2d');
    if (!ctx) throw new Error('The browser could not make room for this photo. Close other tabs and try again, or use a computer with more memory.');
    var tw = info.tw, th = info.th, across = Math.ceil(W / tw), down = Math.ceil(H / th);
    var offs = info.offsets, cnts = info.counts, done = 0, total = across * down;
    // the reduced rows are built from k source rows at a time
    var acc = k > 1 ? new Float32Array(oW * 4) : null, accRows = 0, outY = 0;
    var band = null, bandY0 = 0;
    function flushRow(rowRGBA) {
      if (k === 1) return;
      for (var x = 0; x < W; x++) {
        var o = Math.floor(x / k) * 4, s = x * 4;
        acc[o] += rowRGBA[s]; acc[o + 1] += rowRGBA[s + 1]; acc[o + 2] += rowRGBA[s + 2]; acc[o + 3] += rowRGBA[s + 3];
      }
      accRows++;
    }
    function emitReduced(lastRow) {
      if (k === 1 || !accRows) return;
      var row = new Uint8ClampedArray(oW * 4);
      for (var x = 0; x < oW; x++) {
        var n = Math.min(k, W - x * k) * accRows;
        for (var c = 0; c < 4; c++) row[x * 4 + c] = acc[x * 4 + c] / n;
      }
      ctx.putImageData(new ImageData(row, oW, 1), 0, outY++);
      acc.fill(0); accRows = 0;
    }
    // a band of rows (one strip row / tile row) is complete: put it into the canvas
    function putBand(rgba, y0, rows) {
      if (k === 1) { ctx.putImageData(new ImageData(rgba, W, rows), 0, y0); return; }
      for (var r = 0; r < rows; r++) {
        flushRow(rgba.subarray(r * W * 4, (r + 1) * W * 4));
        if ((y0 + r + 1) % k === 0 || y0 + r + 1 === H) emitReduced();
      }
    }
    var CHUNK = 48 * 1024 * 1024;
    var cache = { start: -1, end: -1, buf: null };
    function bytesAt(off, len) {
      if (off >= cache.start && off + len <= cache.end) return Promise.resolve(cache.buf.subarray(off - cache.start, off - cache.start + len));
      var size = Math.min(Math.max(len, CHUNK), file.size - off);
      return readBytes(file, off, size).then(function (b) { cache = { start: off, end: off + b.length, buf: b }; return b.subarray(0, len); });
    }
    // a band: one row of tiles, or several strips together (about 256 rows), decoded then put into the canvas at once
    var g = info.tiled ? 1 : Math.max(1, Math.floor(256 / th)), bandH = th * g, bands = Math.ceil(H / bandH);
    function doBand(bi) {
      if (bi >= bands) return Promise.resolve();
      var y0 = bi * bandH, rows = Math.min(bandH, H - y0);
      var rgba = new Uint8ClampedArray(W * rows * 4);
      var parts = [];
      if (info.tiled) { for (var bx = 0; bx < across; bx++) parts.push({ i: bi * across + bx, x: bx * tw, y: 0, w: tw, h: th }); }
      else { for (var s = bi * g; s < Math.min(down, bi * g + g); s++) parts.push({ i: s, x: 0, y: (s - bi * g) * th, w: W, h: Math.min(th, H - s * th) }); }
      var chain = Promise.resolve();
      parts.forEach(function (pt) {
        chain = chain.then(function () {
          return bytesAt(offs[pt.i], cnts[pt.i]).then(function (raw) {
            if (info.comp === 7) {
              return jpegBlock(info, raw).then(function (bmp) {
                var c2 = makeCanvas(pt.w, pt.h), x2 = c2.getContext('2d'); x2.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
                return x2.getImageData(0, 0, pt.w, pt.h).data;
              });
            }
            return decodeBlock(info, raw, pt.w, pt.h);
          }).then(function (px) {
            var cw = Math.min(pt.w, W - pt.x), rh = Math.min(pt.h, rows - pt.y);
            if (cw === W && pt.w === W) rgba.set(px.subarray(0, rh * W * 4), pt.y * W * 4);
            else for (var r = 0; r < rh; r++) rgba.set(px.subarray(r * pt.w * 4, r * pt.w * 4 + cw * 4), ((pt.y + r) * W + pt.x) * 4);
            done++;
          });
        });
      });
      return chain.then(function () {
        putBand(rgba, y0, rows);
        if (onProgress) onProgress(done / total);
        return sleep(0).then(function () { return doBand(bi + 1); });
      });
    }
    return doBand(0).then(function () { cache = null; return cv; });
  }
  function makeCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  // PNG / JPEG size from the file header (to reduce very large pictures while decoding)
  function imageSize(file) {
    return readBytes(file, 0, 65536).then(function (b) {
      var dv = new DataView(b.buffer);
      if (b[0] === 0x89 && b[1] === 0x50) return { W: dv.getUint32(16), H: dv.getUint32(20), type: 'png' };
      if (b[0] === 0xff && b[1] === 0xd8) {
        var p = 2;
        while (p + 9 < b.length) {
          if (b[p] !== 0xff) { p++; continue; }
          var m = b[p + 1], l = dv.getUint16(p + 2);
          if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { W: dv.getUint16(p + 7), H: dv.getUint16(p + 5), type: 'jpeg' };
          p += 2 + l;
        }
      }
      return null;
    });
  }
  function factorFor(W, H, mpp) {
    var k = Math.max(1, Math.ceil(Math.max(W / MAX_SIDE, H / MAX_SIDE, Math.sqrt(W * H / MAX_AREA))));
    if (mpp && mpp > 0 && mpp < MPP0 * 0.9) k = Math.max(k, Math.floor(MPP0 * 0.9 / mpp));     // finer than needed for 5 cm
    return k;
  }
  // -> { canvas, k, W, H, geo, date, name }
  function readPhoto(file, onStatus) {
    var name = file.name || 'photo';
    return readBytes(file, 0, 4).then(function (b) {
      var isTiff = (b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d);
      if (isTiff) {
        return tiffInfo(file).then(function (info) {
          var k = factorFor(info.W, info.H, info.geo && info.geo.mpp);
          onStatus('Reading the photo (' + info.W + ' × ' + info.H + ' pixels' + (k > 1 ? ', reduced ' + k + '×' : '') + ')… 0%');
          return tiffToCanvas(file, info, k, function (f) { onStatus('Reading the photo… ' + Math.round(f * 100) + '%'); })
            .then(function (cv) { return { canvas: cv, k: k, W: info.W, H: info.H, geo: info.geo, date: info.date, name: name, hasAlpha: info.spp === 4 || info.spp === 2 || info.nodata !== null }; });
        });
      }
      return imageSize(file).then(function (sz) {
        if (!sz) throw new Error('Choose a GeoTIFF (.tif), PNG or JPG photo.');
        var k = factorFor(sz.W, sz.H, null);
        onStatus('Reading the photo (' + sz.W + ' × ' + sz.H + ' pixels' + (k > 1 ? ', reduced ' + k + '×' : '') + ')…');
        var opts = k > 1 ? { resizeWidth: Math.ceil(sz.W / k), resizeHeight: Math.ceil(sz.H / k), resizeQuality: 'high' } : undefined;
        return createImageBitmap(file, opts).then(function (bmp) {
          var cv = makeCanvas(bmp.width, bmp.height); cv.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
          return { canvas: cv, k: sz.W / cv.width, W: sz.W, H: sz.H, geo: null, date: null, name: name, hasAlpha: sz.type === 'png' };
        }, function () { throw new Error('The browser could not open this photo (it may be too large). Use a computer, or export the photo smaller or as GeoTIFF.'); });
      });
    });
  }
  // halving copies of the picture (for drawing small views and the coarse levels with good quality)
  function pyramid(cv) {
    var out = [cv];
    while (Math.max(out[out.length - 1].width, out[out.length - 1].height) > 1024) {
      var s = out[out.length - 1], c = makeCanvas(Math.ceil(s.width / 2), Math.ceil(s.height / 2)), x = c.getContext('2d');
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(s, 0, 0, c.width, c.height);
      out.push(c);
    }
    return out;
  }
  // a photo without transparency: the plain white or black page around the mosaic becomes transparent
  function maskBackground(pyr) {
    var m = pyr.filter(function (c) { return Math.max(c.width, c.height) <= 2400; })[0] || pyr[pyr.length - 1];
    var w = m.width, hgt = m.height, d = m.getContext('2d').getImageData(0, 0, w, hgt).data;
    var bg = new Uint8Array(w * hgt), stack = [], n = 0;
    function plain(i) { var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3]; return a < 8 || (r >= 245 && g >= 245 && b >= 245) || (r <= 6 && g <= 6 && b <= 6); }
    function seed(i) { if (!bg[i] && plain(i)) { bg[i] = 1; stack.push(i); } }
    for (var x = 0; x < w; x++) { seed(x); seed((hgt - 1) * w + x); }
    for (var y = 0; y < hgt; y++) { seed(y * w); seed(y * w + w - 1); }
    while (stack.length) {
      var i = stack.pop(), px = i % w, py = (i - px) / w; n++;
      if (px > 0) seed(i - 1); if (px < w - 1) seed(i + 1); if (py > 0) seed(i - w); if (py < hgt - 1) seed(i + w);
    }
    if (n < w * hgt * 0.01) return;                       // no page around the photo
    var mc = makeCanvas(w, hgt), mx = mc.getContext('2d'), id = mx.createImageData(w, hgt);
    for (var j = 0; j < w * hgt; j++) {
      // a pixel next to the page is dropped too (the light fringe of the mosaic edge)
      var near = bg[j] || (j % w > 0 && bg[j - 1]) || (j % w < w - 1 && bg[j + 1]) || (j >= w && bg[j - w]) || (j < w * (hgt - 1) && bg[j + w]);
      id.data[j * 4 + 3] = near ? 0 : 255;
    }
    mx.putImageData(id, 0, 0);
    pyr.forEach(function (c) {
      var x2 = c.getContext('2d'); x2.save(); x2.globalCompositeOperation = 'destination-in'; x2.imageSmoothingEnabled = true;
      x2.drawImage(mc, 0, 0, c.width, c.height); x2.restore();
    });
  }
  // the photographed part (opaque pixels) in full-resolution pixels
  function opaqueBox(pyr, scaleFull) {
    var m = pyr[pyr.length - 1], w = m.width, hgt = m.height, d = m.getContext('2d').getImageData(0, 0, w, hgt).data;
    var x0 = w, y0 = hgt, x1 = -1, y1 = -1;
    for (var y = 0; y < hgt; y++) for (var x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) return null;
    var f = scaleFull * (pyr[0].width / w);
    return [Math.max(0, (x0 - 1) * f), Math.max(0, (y0 - 1) * f), (x1 + 2) * f, (y1 + 2) * f];
  }

  // ==================================================================
  // 2. Geometry: affine maps as [a, b, c, d, e, f]: x' = a x + b y + c, y' = d x + e y + f
  // ==================================================================
  function mul(M, N) {
    return [M[0] * N[0] + M[1] * N[3], M[0] * N[1] + M[1] * N[4], M[0] * N[2] + M[1] * N[5] + M[2],
            M[3] * N[0] + M[4] * N[3], M[3] * N[1] + M[4] * N[4], M[3] * N[2] + M[4] * N[5] + M[5]];
  }
  function inv(M) {
    var det = M[0] * M[4] - M[1] * M[3];
    return [M[4] / det, -M[1] / det, (M[1] * M[5] - M[4] * M[2]) / det, -M[3] / det, M[0] / det, (M[3] * M[2] - M[0] * M[5]) / det];
  }
  function ap(M, x, y) { return [M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5]]; }
  function scaleOf(M) { return Math.sqrt(Math.abs(M[0] * M[4] - M[1] * M[3])); }
  function rotOf(M) { return Math.atan2(M[3], M[0]) * 180 / Math.PI; }
  // two point pairs -> similarity (photo full pixels -> keyplan metres)
  function fromPoints(p1, k1, p2, k2) {
    var dpx = p2[0] - p1[0], dpy = p2[1] - p1[1], dkx = k2[0] - k1[0], dky = k2[1] - k1[1];
    var den = dpx * dpx + dpy * dpy; if (!den) return null;
    var a = (dkx * dpx + dky * dpy) / den, b = (dky * dpx - dkx * dpy) / den;      // complex ratio (dk / dp)
    return [a, -b, k1[0] - (a * p1[0] - b * p1[1]), b, a, k1[1] - (b * p1[0] + a * p1[1])];
  }

  // ==================================================================
  // 3. A pan / zoom view on a canvas (world units: photo pixels or keyplan metres)
  // ==================================================================
  function Viewer(canvas, opts) {
    var V = { x: 0, y: 0, k: 1 }, ptrs = new Map(), moved = 0, start = null, pinch = null, raf = 0;
    function size() { var r = canvas.getBoundingClientRect(); return { w: r.width, h: r.height }; }
    function draw() {
      raf = 0;
      var s = size(), dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(s.w * dpr) || canvas.height !== Math.round(s.h * dpr)) { canvas.width = Math.round(s.w * dpr); canvas.height = Math.round(s.h * dpr); }
      var ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#e9edf1'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      opts.draw(ctx, V, s.w, s.h, dpr);
    }
    var api = {
      redraw: function () { if (!raf) raf = requestAnimationFrame(draw); },
      fit: function (x0, y0, x1, y1) {
        var s = size(); if (!s.w) return;
        V.k = Math.min(s.w / (x1 - x0), s.h / (y1 - y0)) * 0.94;
        V.x = (x0 + x1) / 2 - s.w / 2 / V.k; V.y = (y0 + y1) / 2 - s.h / 2 / V.k; api.redraw();
      },
      view: V,
      zoom: function (f, cx, cy) {
        var s = size(); if (cx === undefined) { cx = s.w / 2; cy = s.h / 2; }
        var wx = V.x + cx / V.k, wy = V.y + cy / V.k;
        V.k = Math.max(opts.minK || 1e-4, Math.min(opts.maxK || 1e4, V.k * f));
        V.x = wx - cx / V.k; V.y = wy - cy / V.k; api.redraw();
      },
      toWorld: function (cx, cy) { return [V.x + cx / V.k, V.y + cy / V.k]; }
    };
    function local(e) { var r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); var p = local(e); api.zoom(Math.exp(-e.deltaY * 0.0015), p[0], p[1]); }, { passive: false });
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, local(e));
      if (ptrs.size === 1) { moved = 0; start = local(e); }
      if (ptrs.size === 2) { var a = Array.from(ptrs.values()); pinch = { d: Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]), k: V.k }; moved = 99; }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!ptrs.has(e.pointerId)) return;
      var p = local(e), q = ptrs.get(e.pointerId); ptrs.set(e.pointerId, p);
      if (ptrs.size === 2 && pinch) {
        var a = Array.from(ptrs.values()), d = Math.hypot(a[0][0] - a[1][0], a[0][1] - a[1][1]);
        api.zoom((pinch.k * d / pinch.d) / V.k, (a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2); return;
      }
      moved += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]);
      V.x -= (p[0] - q[0]) / V.k; V.y -= (p[1] - q[1]) / V.k; api.redraw();
    });
    function up(e) {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null;
      if (!ptrs.size && moved < 6 && start && opts.onPick) { var w = api.toWorld(start[0], start[1]); opts.onPick(w[0], w[1]); }
    }
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', function (e) { ptrs.delete(e.pointerId); pinch = null; });
    if (window.ResizeObserver) new ResizeObserver(function () { api.redraw(); }).observe(canvas);
    return api;
  }
  function zoomButtons(v, fitFn) {
    return h('div', { class: 'du-zoom' },
      h('button', { type: 'button', class: 'btn small', text: '+', 'aria-label': 'Zoom in', onclick: function () { v.zoom(1.6); } }),
      h('button', { type: 'button', class: 'btn small', text: '−', 'aria-label': 'Zoom out', onclick: function () { v.zoom(1 / 1.6); } }),
      h('button', { type: 'button', class: 'btn small', text: 'Fit', onclick: fitFn }));
  }

  // keyplan drawing helpers (sections and background lines of a block, in metres)
  function drawSections(ctx, block, toPx, lw, color) {
    var S = P().S, kp = S.kp[block];
    ctx.lineWidth = lw; ctx.strokeStyle = color || 'rgba(255, 214, 0, .95)';
    ctx.beginPath();
    (S.secByBlock[block] || []).forEach(function (s) {
      var g = s.geom; if (!g) return;
      var a = toPx(g[0], g[1]), b = toPx(g[0] + g[2], g[1] + g[3]);
      ctx.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    });
    ctx.stroke();
    if (kp && kp.lines) {
      ctx.strokeStyle = 'rgba(30, 30, 30, .55)'; ctx.lineWidth = Math.max(1, lw * 0.8); ctx.beginPath();
      kp.lines.forEach(function (l) { var a = toPx(l[0], l[1]), b = toPx(l[2], l[3]); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); });
      ctx.stroke();
    }
  }
  function marker(ctx, x, y, label, color) {
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 16, y); ctx.lineTo(x - 11, y); ctx.moveTo(x + 11, y); ctx.lineTo(x + 16, y);
    ctx.moveTo(x, y - 16); ctx.lineTo(x, y - 11); ctx.moveTo(x, y + 11); ctx.lineTo(x, y + 16); ctx.strokeStyle = color; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x, y + 0.5);
    ctx.restore();
  }

  // ==================================================================
  // 4. Pieces: make, encrypt, upload
  // ==================================================================
  function webpOk() {
    var c = makeCanvas(2, 2); return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  }
  function toBlob(c, type, q) { return new Promise(function (res, rej) { c.toBlob(function (b) { if (b) res(b); else rej(new Error('The browser could not make a photo piece.')); }, type, q); }); }
  function storageBase() { return String(cfg().supabaseUrl || '').replace(/\/+$/, '') + '/storage/v1/object/'; }
  function sHeaders(extra) {
    var hd = { apikey: cfg().supabaseKey }; if (/^eyJ/.test(cfg().supabaseKey || '')) hd.Authorization = 'Bearer ' + cfg().supabaseKey;
    return Object.assign(hd, extra || {});
  }
  function storageError(res, txt) {
    var j = null; try { j = JSON.parse(txt); } catch (e) { j = null; }
    var code = j && (j.statusCode || j.status), msg = j && (j.message || j.error) || ('error ' + res.status);
    return { code: String(code || res.status), msg: msg };
  }
  function putPiece(path, body) {
    return fetch(storageBase() + 'pvm-drone/' + path, { method: 'POST', headers: sHeaders({ 'Content-Type': 'application/octet-stream' }), body: body, credentials: 'omit', cache: 'no-store' })
      .then(function (res) {
        if (res.ok) return true;
        return res.text().then(function (txt) {
          var e = storageError(res, txt);
          if (res.status === 409 || e.code === '409') return true;          // already there (sent before)
          if (e.code === '404' && /bucket/i.test(e.msg)) throw Object.assign(new Error('The photo storage is missing: run database update 13 in Supabase.'), { fatal: true });
          if (res.status === 403 || e.code === '403' || /row-level security/i.test(e.msg)) throw Object.assign(new Error('The photo storage refused the upload (the upload may have been closed after 6 hours, or database update 13 is not installed).'), { fatal: true });
          throw new Error('Upload failed (' + e.msg + ').');
        });
      });
  }
  function listFolder(prefix) {
    var all = [];
    function page(off) {
      return fetch(storageBase() + 'list/pvm-drone', { method: 'POST', headers: sHeaders({ 'Content-Type': 'application/json' }), credentials: 'omit', cache: 'no-store',
        body: JSON.stringify({ prefix: prefix, limit: 1000, offset: off, sortBy: { column: 'name', order: 'asc' } }) })
        .then(function (res) { return res.text().then(function (txt) { if (!res.ok) throw new Error('Could not list the photo pieces (' + storageError(res, txt).msg + ').'); return JSON.parse(txt || '[]'); }); })
        .then(function (list) { all = all.concat(list); return list.length === 1000 ? page(off + 1000) : all; });
    }
    return page(0);
  }
  function removePieces(names) {
    var i = 0;
    function next() {
      if (i >= names.length) return Promise.resolve();
      var part = names.slice(i, i + 500); i += 500;
      return fetch(storageBase() + 'pvm-drone', { method: 'DELETE', headers: sHeaders({ 'Content-Type': 'application/json' }), credentials: 'omit', cache: 'no-store', body: JSON.stringify({ prefixes: part }) })
        .then(function (res) { if (!res.ok) return res.text().then(function (txt) { throw new Error('Could not remove the photo pieces (' + storageError(res, txt).msg + ').'); }); })
        .then(next);
    }
    return next();
  }
  function pieceNames(id, info) {
    var out = [];
    (info.levels || []).forEach(function (l, li) {
      for (var r = 0; r < l.rows; r++) for (var c = 0; c < l.cols; c++) if (l.have.charAt(r * l.cols + c) === '1') out.push(id + '/' + li + '/' + c + '_' + r + '.bin');
    });
    return out;
  }
  // every piece of a photo folder (unfinished uploads have no description to name them)
  function folderNames(id) {
    return listFolder(id + '/').then(function (levels) {
      var dirs = levels.filter(function (x) { return !x.id && /^\d+$/.test(x.name); }).map(function (x) { return x.name; });
      return Promise.all(dirs.map(function (d) { return listFolder(id + '/' + d + '/').then(function (fs) { return fs.filter(function (f) { return f.id; }).map(function (f) { return id + '/' + d + '/' + f.name; }); }); }));
    }).then(function (lists) { return [].concat.apply([], lists); });
  }

  // the job: resample to keyplan metres, cut, encrypt, upload.
  // job = { id, block, F (full photo px -> keyplan m), pyr (halving copies), k (canvas px -> full px), box (photographed part, full px) }
  function makePieces(job, onStatus, isCancelled) {
    var S = P().S, kp = S.kp[job.block], fmt = webpOk() ? 'webp' : 'png', mime = 'image/' + fmt;
    var F = job.F, srcMpp = scaleOf(F);
    var b = job.box, cs = [ap(F, b[0], b[1]), ap(F, b[2], b[1]), ap(F, b[0], b[3]), ap(F, b[2], b[3])];
    function mn(i) { return Math.min.apply(null, cs.map(function (p) { return p[i]; })); }
    function mx(i) { return Math.max.apply(null, cs.map(function (p) { return p[i]; })); }
    var x0 = Math.floor(Math.max(-MARGIN, mn(0)) / MPP0) * MPP0, y0 = Math.floor(Math.max(-MARGIN, mn(1)) / MPP0) * MPP0;
    var x1 = Math.ceil(Math.min(+kp.width + MARGIN, mx(0)) / MPP0) * MPP0, y1 = Math.ceil(Math.min(+kp.height + MARGIN, mx(1)) / MPP0) * MPP0;
    x0 = Math.round(x0 * 1e4) / 1e4; y0 = Math.round(y0 * 1e4) / 1e4;
    if (!(x1 > x0 && y1 > y0)) return Promise.reject(new Error('The photo does not cover the Block ' + job.block + ' keyplan. Check the placement.'));
    var W0 = Math.round((x1 - x0) / MPP0), H0 = Math.round((y1 - y0) / MPP0), levels = [];
    for (var L = 0; ; L++) {
      var w = Math.ceil(W0 / Math.pow(2, L)), hh = Math.ceil(H0 / Math.pow(2, L));
      levels.push({ mpp: Math.round(MPP0 * Math.pow(2, L) * 1e4) / 1e4, w: w, h: hh, cols: Math.ceil(w / TILE), rows: Math.ceil(hh / TILE), have: '' });
      if (w <= TILE && hh <= TILE) break;
    }
    var total = levels.reduce(function (n, l) { return n + l.cols * l.rows; }, 0), seen = 0, made = 0, bytes = 0, sent = 0;
    var tc = makeCanvas(TILE, TILE), tx = tc.getContext('2d', { willReadFrequently: true });
    var key = null, done = job.done || (job.done = new Set());
    var queue = [], uploading = 0, failure = null, waiters = [];
    function status() { onStatus('Making and uploading the photo pieces: ' + made + ' made, ' + sent + ' uploaded (' + Math.min(100, Math.round(100 * seen / total)) + '% of the area done)…', seen / total); }
    function wake() { var w = waiters; waiters = []; w.forEach(function (f) { f(); }); }
    function pump() {
      while (uploading < 4 && queue.length && !failure) {
        (function (it) {
          uploading++;
          var tries = 0;
          (function attempt() {
            putPiece(it.path, it.body).then(function () {
              uploading--; sent++; done.add(it.path); status(); pump(); wake();
            }, function (e) {
              if (!e.fatal && ++tries < 4) { setTimeout(attempt, 1500 * tries); return; }
              uploading--; failure = failure || e; wake();
            });
          })();
        })(queue.shift());
      }
    }
    function room() { return queue.length < 8 || failure ? Promise.resolve() : new Promise(function (r) { waiters.push(r); }).then(room); }
    function drained() { return (!queue.length && !uploading) || failure ? Promise.resolve() : new Promise(function (r) { waiters.push(r); }).then(drained); }
    var raw = Uint8Array.from(atob(D().keyB64()), function (ch) { return ch.charCodeAt(0); });
    return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']).then(function (k) {
      key = k;
      var chain = Promise.resolve();
      levels.forEach(function (l, li) {
        var have = new Array(l.cols * l.rows).fill('0');
        var si = 0;
        job.pyr.forEach(function (cv, i) { if (srcMpp * job.k * (job.pyr[0].width / cv.width) <= l.mpp * 1.01) si = i; });
        var src = job.pyr[si], f = job.k * (job.pyr[0].width / src.width);
        var M0 = mul(F, [f, 0, 0, 0, f, 0]);
        for (var r = 0; r < l.rows; r++) for (var c = 0; c < l.cols; c++) {
          (function (c, r) {
            chain = chain.then(function () {
              if (failure) throw failure;
              if (isCancelled()) throw Object.assign(new Error('Upload stopped.'), { cancelled: true });
              seen++;
              var tx0 = x0 + c * TILE * l.mpp, ty0 = y0 + r * TILE * l.mpp;
              var M = mul([1 / l.mpp, 0, -tx0 / l.mpp, 0, 1 / l.mpp, -ty0 / l.mpp], M0);
              var Mi = inv(M), q = [ap(Mi, -2, -2), ap(Mi, TILE + 2, -2), ap(Mi, -2, TILE + 2), ap(Mi, TILE + 2, TILE + 2)];
              var sx0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0], q[3][0])));
              var sy0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1], q[3][1])));
              var sx1 = Math.min(src.width, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0], q[3][0])));
              var sy1 = Math.min(src.height, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1], q[3][1])));
              if (sx1 <= sx0 || sy1 <= sy0) return;
              tx.setTransform(1, 0, 0, 1, 0, 0); tx.clearRect(0, 0, TILE, TILE);
              tx.imageSmoothingEnabled = true; tx.imageSmoothingQuality = 'high';
              tx.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]);
              tx.drawImage(src, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
              tx.setTransform(1, 0, 0, 1, 0, 0);
              var a = tx.getImageData(0, 0, TILE, TILE).data, any = false;
              for (var i = 3; i < a.length; i += 12) if (a[i] > 4) { any = true; break; }
              if (!any) return;
              have[r * l.cols + c] = '1';
              var path = job.id + '/' + li + '/' + c + '_' + r + '.bin';
              if (done.has(path)) { made++; return; }                       // sent in an earlier try
              return toBlob(tc, mime, 0.9).then(function (blob) { return blob.arrayBuffer(); }).then(function (plain) {
                var iv = window.crypto.getRandomValues(new Uint8Array(12));
                var aad = new TextEncoder().encode(job.id + '/' + li + '/' + c + '_' + r);
                return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aad }, key, plain).then(function (ct) {
                  var body = new Uint8Array(12 + ct.byteLength); body.set(iv, 0); body.set(new Uint8Array(ct), 12);
                  made++; bytes += body.length;
                  queue.push({ path: path, body: body }); pump(); status();
                  return room();
                });
              });
            });
          })(c, r);
        }
        chain = chain.then(function () { l.have = have.join(''); return nextFrame(); });
      });
      return chain;
    }).then(drained).then(function () {
      if (failure) throw failure;
      job.bytes = (job.bytes || 0) + bytes;
      return { fmt: fmt, tile: TILE, origin: [x0, y0], levels: levels, kp: [+kp.width, +kp.height] };
    }, function (e) { return drained().then(function () { throw e; }); });
  }

  // ==================================================================
  // 5. The page
  // ==================================================================
  var st = { drones: null, busy: false, job: null };
  function Sx() { return P().S; }
  function blocks() { return Object.keys(Sx().kp || {}).map(Number).sort(); }
  function guessBlock(name) { var m = /block[\s_\-]*0*(\d+)/i.exec(name || ''); return m ? +m[1] : null; }
  function guessDate(name, tiffDate) {
    var s = name || '', m;
    if ((m = /(20\d\d)[\-_.]?([01]\d)[\-_.]?([0-3]\d)/.exec(s))) return m[1] + '-' + m[2] + '-' + m[3];
    // month day year as the last three numbers of the name (e.g. "Block_5_-_10_30_26")
    var nums = s.replace(/\.[a-z0-9]+$/i, '').match(/\d+/g) || [];
    if (nums.length >= 3) {
      var mo = +nums[nums.length - 3], da = +nums[nums.length - 2], yr = nums[nums.length - 1];
      if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && (yr.length === 2 || (yr.length === 4 && yr.slice(0, 2) === '20'))) {
        return (yr.length === 2 ? '20' + yr : yr) + '-' + ('0' + mo).slice(-2) + '-' + ('0' + da).slice(-2);
      }
    }
    if (tiffDate && (m = /^(\d{4}):(\d\d):(\d\d)/.exec(tiffDate))) return m[1] + '-' + m[2] + '-' + m[3];
    return '';
  }
  function today() { var S = Sx(); return S.siteDate || new Date().toISOString().slice(0, 10); }
  function shotsOf(block) {
    var list = [];
    (D().allShotsAny(block) || []).forEach(function (s) { list.push(s); });
    return list.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  }

  // The page keeps its state (a photo being placed or uploaded) when the admin page is drawn again (data refresh,
  // other tab and back): the same element is put back.
  var page = null;
  U.render = function (body) {
    var S = Sx();
    if (page && (S.dbVersion || 0) >= 13 && page.dataset.ok === '1') {
      body.append(page);
      var old = document.getElementById('du-list'); if (old && !st.busy) old.replaceWith(listCard());
      return;
    }
    page = h('div', { class: 'stack' });
    body.append(page);
    body = page;
    if ((S.dbVersion || 0) < 13) {
      body.append(h('div', { class: 'card' }, h('h2', { text: 'Drone photos' }),
        h('p', { class: 'notice', text: 'Run database update 13 (pv-monitoring-update-13.sql) in Supabase to add drone photos from here. Until then new photos are added with the app files.' })));
      return;
    }
    if (!D() || !D().keyB64()) {
      body.append(h('div', { class: 'card' }, h('h2', { text: 'Drone photos' }),
        h('p', { class: 'notice', text: 'The drone photo key is missing: run database update 11 in Supabase first.' })));
      return;
    }
    page.dataset.ok = '1';
    body.append(uploadCard());
    body.append(listCard());
  };

  // ---- the list of photos
  function listCard() {
    var pv = P(), card = h('div', { class: 'card', id: 'du-list' });
    card.append(h('h2', { text: 'Drone photos on the keyplans' }));
    var d = Sx().drones || { photos: [], pending: [] }, used = 0;
    (d.photos || []).forEach(function (p) { used += +(p.info && p.info.bytes) || 0; });
    card.append(h('p', { class: 'card-sub', text: 'The latest photo of a block shows by default; everyone can pick an older date on the keyplan. Uploaded photos use ' + mb(used) + ' of the Supabase storage (the free plan has 1 GB): delete photos that are no longer needed.' }));
    blocks().forEach(function (b) {
      var rows = shotsOf(b);
      card.append(h('h3', { class: 'du-block', text: 'Block ' + b }));
      if (!rows.length) { card.append(h('p', { class: 'small muted', text: 'No drone photo yet.' })); return; }
      var tb = h('tbody');
      rows.forEach(function (s, i) {
        var up = s.uploaded;
        tb.append(h('tr', null,
          h('td', null, h('strong', { text: D().label(s) }), i === 0 ? h('span', { class: 'du-tag', text: 'latest' }) : null),
          h('td', { class: 'small', text: up ? 'Uploaded by ' + (s.by || 'administrator') + ', ' + pv.fmtTime(s.ready_at || s.created_at) : 'Published with the app files' }),
          h('td', { class: 'small', text: mb(s.bytes || 0) }),
          h('td', null, up ? h('button', { type: 'button', class: 'btn small danger', text: 'Delete', onclick: function () { confirmDelete(s); } }) : null)));
      });
      card.append(h('div', { class: 'table-wrap' }, h('table', { class: 'dtable du-tbl' },
        h('thead', null, h('tr', null, h('th', { text: 'Photo date' }), h('th', { text: 'Added' }), h('th', { text: 'Size' }), h('th'))), tb)));
    });
    var pend = (d.pending || []);
    if (pend.length) {
      card.append(h('h3', { class: 'du-block', text: 'Unfinished or deleted uploads' }));
      card.append(h('p', { class: 'small muted', text: 'These are not shown on the keyplan. Remove them to free their storage.' }));
      pend.forEach(function (p) {
        var open = p.status === 'uploading' && p.expires_at && new Date(p.expires_at) > new Date();
        card.append(h('div', { class: 'du-pend' },
          h('span', { class: 'small', text: 'Block ' + p.block + ', ' + D().label({ date: p.date }) + ' — ' + (p.status === 'deleting' ? 'being deleted' : open ? 'upload in progress' : 'upload not finished') }),
          open && st.busy ? null : h('button', { type: 'button', class: 'btn small', text: 'Remove', onclick: function (e) { purge(p, e.target); } })));
      });
    }
    return card;
  }
  function refresh() {
    return P().loadDrones().then(function () {
      var old = document.getElementById('du-list'); if (old) old.replaceWith(listCard());
    });
  }
  function confirmDelete(s) {
    var pv = P(), err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var btn = h('button', { type: 'button', class: 'btn primary danger-btn', text: 'Delete photo' });
    btn.addEventListener('click', function () {
      btn.disabled = true; btn.textContent = 'Deleting…';
      pv.call('admin_drone_delete', { p_id: s.id }).then(function (r) {
        return removePieces(pieceNames(s.id, s.info || r.info || {})).then(function () { return pv.call('admin_drone_purge', { p_id: s.id }); });
      }).then(function () {
        pv.closeModal(); pv.toast('Drone photo of ' + D().label(s) + ' deleted.', 'ok'); refresh();
      }, function (e) {
        err.textContent = e.message + ' The photo is already hidden; press Remove under “Unfinished or deleted uploads” to finish.'; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Delete photo'; refresh();
      });
    });
    pv.openModal('Delete drone photo', [
      h('p', { text: 'Delete the Block ' + s.block + ' drone photo of ' + D().label(s) + '? It disappears from the keyplan for everyone. Section records are not affected.' }),
      err, h('div', { class: 'form-actions' }, h('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: pv.closeModal }), btn)]);
  }
  function purge(p, btn) {
    var pv = P();
    if (btn) { btn.disabled = true; btn.textContent = 'Removing…'; }
    (p.status === 'deleting' ? Promise.resolve() : pv.call('admin_drone_delete', { p_id: p.id }))
      .then(function () { return p.info && p.info.levels ? pieceNames(p.id, p.info) : folderNames(p.id); })
      .then(removePieces)
      .then(function () { return pv.call('admin_drone_purge', { p_id: p.id }); })
      .then(function (r) { if (r && r.removed === false) throw new Error(r.left + ' pieces are still stored; press Remove again.'); pv.toast('Removed.', 'ok'); return refresh(); })
      .catch(function (e) { pv.toast(e.message, 'err', 9000); if (btn) { btn.disabled = false; btn.textContent = 'Remove'; } });
  }

  // ---- adding a photo
  function uploadCard() {
    var pv = P(), card = h('div', { class: 'card', id: 'du-up' });
    card.append(h('h2', { text: 'Add a drone photo' }));
    card.append(h('p', { class: 'card-sub', text: 'Use a computer with Chrome or Edge: the photo is processed in this browser (a 250 MB photo needs about 2 GB of memory and a few minutes). Best file: the GeoTIFF (.tif) exported by the drone software; PNG and JPG also work. Nothing is shown to others until the upload is complete.' }));
    var fBlock = h('select', { id: 'du-block' }, blocks().map(function (b) { return h('option', { value: b, text: 'Block ' + b }); }));
    var fDate = h('input', { id: 'du-date', type: 'date', max: today(), required: true });
    var fFile = h('input', { id: 'du-file', type: 'file', accept: '.tif,.tiff,.png,.jpg,.jpeg,image/tiff,image/png,image/jpeg' });
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var stat = h('p', { class: 'small du-status', role: 'status' });
    var go = h('button', { type: 'button', class: 'btn primary', text: 'Read the photo' });
    var step = h('div', { class: 'du-step' });
    fFile.addEventListener('change', function () {
      var f = fFile.files[0]; if (!f) return;
      var b = guessBlock(f.name); if (b && blocks().indexOf(b) >= 0) fBlock.value = String(b);
      var d = guessDate(f.name); if (d && d <= today()) fDate.value = d;
    });
    function fail(e) { err.textContent = e.message || String(e); err.hidden = false; stat.textContent = ''; go.disabled = false; st.busy = false; }
    go.addEventListener('click', function () {
      err.hidden = true;
      var f = fFile.files[0], block = +fBlock.value, date = fDate.value;
      if (!f) return fail(new Error('Choose the drone photo file.'));
      if (!date) return fail(new Error('Enter the date the drone photo was taken.'));
      if (date > today()) return fail(new Error('The photo date cannot be in the future.'));
      var clash = shotsOf(block).filter(function (s) { return s.date === date; })[0];
      if (clash) return fail(new Error('Block ' + block + ' already has a drone photo dated ' + D().label(clash) + (clash.uploaded ? '. Delete it first to replace it.' : ' (published with the app files). Choose another date.')));
      go.disabled = true; st.busy = true; step.textContent = '';
      stat.textContent = 'Reading the photo…';
      readPhoto(f, function (t) { stat.textContent = t; }).then(function (ph) {
        stat.textContent = 'Preparing the photo…';
        return nextFrame().then(function () {
          ph.pyr = pyramid(ph.canvas);
          if (!ph.hasAlpha) maskBackground(ph.pyr);
          ph.box = opaqueBox(ph.pyr, ph.k);
          if (!ph.box) throw new Error('The photo is empty.');
          if (!fDate.value) { var g = guessDate('', ph.date); if (g) fDate.value = g; }
          stat.textContent = ''; go.disabled = false; st.busy = false;
          place(step, { file: f, block: block, date: date, ph: ph });
        });
      }).catch(fail);
    });
    card.append(h('div', { class: 'grid-form du-form' },
      h('div', { class: 'field' }, h('label', { for: 'du-block', text: 'Block' }), fBlock),
      h('div', { class: 'field' }, h('label', { for: 'du-date', text: 'Date the photo was taken' }), fDate),
      h('div', { class: 'field du-filefield' }, h('label', { for: 'du-file', text: 'Photo file' }), fFile)),
      h('div', { class: 'btn-row du-go' }, go), stat, err, step);
    return card;
  }

  // placing the photo: GPS position (GeoTIFF + known block position) or two points; then the check
  function place(root, ctx) {
    var S = Sx(), geo = ctx.ph.geo, ref = ((S.drones || {}).georef || {})[String(ctx.block)];
    root.textContent = '';
    if (geo && ref && geo.epsg && +ref.epsg === +geo.epsg) {
      ctx.F = mul(ref.m, geo.A); ctx.method = 'gps';
      return check(root, ctx);
    }
    pickPoints(root, ctx);
  }
  function pickPoints(root, ctx) {
    var S = Sx(), ph = ctx.ph, pre = ph.pyr.filter(function (c) { return Math.max(c.width, c.height) <= 4096; })[0] || ph.pyr[ph.pyr.length - 1];
    var f = ph.k * (ph.pyr[0].width / pre.width);          // preview px -> full px
    var pts = [{ p: null, k: null }, { p: null, k: null }], cur = 0, which = 'p';
    var cvP = h('canvas', { class: 'du-canvas', 'aria-label': 'Drone photo: click to mark a point' });
    var cvK = h('canvas', { class: 'du-canvas', 'aria-label': 'Keyplan: click to mark the same point' });
    var hint = h('p', { class: 'du-hint', role: 'status' });
    var okBtn = h('button', { type: 'button', class: 'btn primary', text: 'Place the photo', disabled: true });
    var colors = ['#e11d48', '#2563eb'];
    var vP = Viewer(cvP, { maxK: 8, draw: function (c, V, w, hh, dpr) {
      c.setTransform(dpr * V.k, 0, 0, dpr * V.k, -V.x * V.k * dpr, -V.y * V.k * dpr);
      c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(pre, 0, 0);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      pts.forEach(function (q, i) { if (q.p) marker(c, (q.p[0] / f - V.x) * V.k, (q.p[1] / f - V.y) * V.k, String(i + 1), colors[i]); });
    }, onPick: function (x, y) { if (which !== 'p') return; pts[cur].p = [x * f, y * f]; which = 'k'; upd(); } });
    var kp = S.kp[ctx.block];
    var vK = Viewer(cvK, { maxK: 400, draw: function (c, V, w, hh, dpr) {
      var v = { x: V.x, y: V.y, w: w / V.k, h: hh / V.k };
      if (D().available(ctx.block)) D().draw(c, ctx.block, v, w, hh, dpr, function () { vK.redraw(); });
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSections(c, ctx.block, function (x, y) { return [(x - V.x) * V.k, (y - V.y) * V.k]; }, 1);
      pts.forEach(function (q, i) { if (q.k) marker(c, (q.k[0] - V.x) * V.k, (q.k[1] - V.y) * V.k, String(i + 1), colors[i]); });
    }, onPick: function (x, y) { if (which !== 'k') return; pts[cur].k = [x, y]; if (cur === 0) { cur = 1; which = 'p'; } else which = ''; upd(); } });
    function upd() {
      vP.redraw(); vK.redraw();
      var n = cur + 1;
      hint.textContent = which === 'p' ? 'Point ' + n + ': click a sharp spot on the drone photo (a table corner, a road crossing, a building corner).' + (cur === 1 ? ' Choose it far from point 1.' : '')
        : which === 'k' ? 'Point ' + n + ': click the same spot on the keyplan (zoom in for accuracy).'
          : 'Both points are marked. Press Place the photo, or Start again.';
      okBtn.disabled = !(pts[1].p && pts[1].k);
    }
    okBtn.addEventListener('click', function () {
      var F = fromPoints(pts[0].p, pts[0].k, pts[1].p, pts[1].k);
      if (!F) return;
      ctx.F = F; ctx.method = 'points'; check(root, ctx);
    });
    root.textContent = '';
    root.append(h('h3', { text: 'Place the photo on the Block ' + ctx.block + ' keyplan' }),
      h('p', { class: 'small', text: (ctx.ph.geo ? 'This GeoTIFF is the first one for Block ' + ctx.block + ' (or uses another map projection), so its position on the keyplan is not known yet. ' : 'A PNG or JPG photo has no GPS position. ') +
        'Mark two points that you can see on both: first on the photo, then on the keyplan. The keyplan shows the sections' + (D().available(ctx.block) ? ' over the current drone photo' : '') + '. Drag to move, scroll or pinch to zoom.' }),
      hint,
      h('div', { class: 'du-pair' },
        h('div', { class: 'du-pane' }, h('div', { class: 'du-pane-head' }, h('strong', { text: 'New drone photo' }), zoomButtons(vP, function () { vP.fit(0, 0, pre.width, pre.height); })), cvP),
        h('div', { class: 'du-pane' }, h('div', { class: 'du-pane-head' }, h('strong', { text: 'Keyplan' }), zoomButtons(vK, function () { vK.fit(0, 0, +kp.width, +kp.height); })), cvK)),
      h('div', { class: 'btn-row' }, okBtn,
        h('button', { type: 'button', class: 'btn', text: 'Start again', onclick: function () { pts = [{ p: null, k: null }, { p: null, k: null }]; cur = 0; which = 'p'; upd(); } }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: function () { root.textContent = ''; } })));
    upd();
    nextFrame().then(function () { vP.fit(0, 0, pre.width, pre.height); vK.fit(0, 0, +kp.width, +kp.height); });
  }

  function check(root, ctx) {
    var S = Sx(), ph = ctx.ph, kp = S.kp[ctx.block], pv = P();
    var pre = ph.pyr.filter(function (c) { return Math.max(c.width, c.height) <= 6000; })[0] || ph.pyr[ph.pyr.length - 1];
    var fPre = ph.k * (ph.pyr[0].width / pre.width);
    var start = ctx.F.slice(), nudged = false, opacity = 0.85;
    var cv = h('canvas', { class: 'du-canvas du-big', 'aria-label': 'The new photo placed under the keyplan sections' });
    var v = Viewer(cv, { maxK: 400, draw: function (c, V, w, hh, dpr) {
      var vw = { x: V.x, y: V.y, w: w / V.k, h: hh / V.k };
      if (D().available(ctx.block)) D().draw(c, ctx.block, vw, w, hh, dpr, function () { v.redraw(); });
      var M = mul([dpr * V.k, 0, -V.x * V.k * dpr, 0, dpr * V.k, -V.y * V.k * dpr], mul(ctx.F, [fPre, 0, 0, 0, fPre, 0]));
      c.save(); c.globalAlpha = opacity; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
      c.setTransform(M[0], M[3], M[1], M[4], M[2], M[5]); c.drawImage(pre, 0, 0); c.restore();
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSections(c, ctx.block, function (x, y) { return [(x - V.x) * V.k, (y - V.y) * V.k]; }, 1);
    } });
    var info = h('p', { class: 'small du-hint' });
    function describe() {
      var s = scaleOf(ctx.F), txt = (ctx.method === 'gps' ? 'Placed from the GeoTIFF’s GPS position (' + (ph.geo.name || 'EPSG ' + ph.geo.epsg) + '), using the Block ' + ctx.block + ' position measured earlier.'
        : 'Placed by your two points.') + ' Photo pixel: ' + (s * 100).toFixed(1) + ' cm; turned ' + rotOf(ctx.F).toFixed(2) + '°.';
      if (ph.geo && ctx.method === 'points') {
        var diff = Math.abs(s / ph.geo.mpp - 1);
        if (diff > 0.02) txt += ' Warning: the GeoTIFF says ' + (ph.geo.mpp * 100).toFixed(1) + ' cm per pixel, ' + Math.round(diff * 100) + '% different: the points are probably not exact. Start again with points far apart.';
      }
      if (nudged) txt += ' Adjusted by hand.';
      info.textContent = txt;
    }
    // nudging: move in metres / turn about the view centre
    function nudge(dx, dy, rot) {
      var c = v.toWorld(cv.getBoundingClientRect().width / 2, cv.getBoundingClientRect().height / 2);
      var T = [1, 0, dx, 0, 1, dy];
      if (rot) { var a = rot * Math.PI / 180, co = Math.cos(a), si = Math.sin(a); T = [co, -si, c[0] - co * c[0] + si * c[1], si, co, c[1] - si * c[0] - co * c[1]]; }
      ctx.F = mul(T, ctx.F); nudged = true; describe(); v.redraw();
    }
    var stepSel = h('select', { 'aria-label': 'Step' }, [['0.05', '5 cm / 0.02°'], ['0.2', '20 cm / 0.1°'], ['1', '1 m / 0.5°']].map(function (x) { return h('option', { value: x[0], text: x[1], selected: x[0] === '0.2' }); }));
    function stepM() { return +stepSel.value; }
    function stepDeg() { return { '0.05': 0.02, '0.2': 0.1, '1': 0.5 }[stepSel.value]; }
    var op = h('input', { type: 'range', min: 0, max: 100, step: 5, value: 85, 'aria-label': 'New photo strength' });
    op.addEventListener('input', function () { opacity = op.value / 100; v.redraw(); });
    var hasRef = !!((S.drones || {}).georef || {})[String(ctx.block)];
    var saveRef = h('input', { type: 'checkbox', id: 'du-saveref', checked: !!(ph.geo && ph.geo.epsg && !hasRef) });
    var refRow = ph.geo && ph.geo.epsg ? h('label', { class: 'du-check', for: 'du-saveref' }, saveRef,
      h('span', { text: hasRef ? ' Also store this placement as the Block ' + ctx.block + ' GPS position (only if the earlier automatic placement was wrong)' : ' Store this placement as the Block ' + ctx.block + ' GPS position: the next GeoTIFF of this block is then placed automatically' })) : null;
    var err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
    var stat = h('p', { class: 'small du-status', role: 'status' });
    var bar = h('progress', { class: 'du-bar', max: 100, value: 0, hidden: true });
    var up = h('button', { type: 'button', class: 'btn primary', text: 'Upload the photo' });
    var stop = h('button', { type: 'button', class: 'btn', text: 'Stop', hidden: true });
    var cancelled = false;
    stop.addEventListener('click', function () { cancelled = true; stop.disabled = true; });
    up.addEventListener('click', function () {
      err.hidden = true; up.disabled = true; cancelled = false; stop.hidden = false; stop.disabled = false; bar.hidden = false; st.busy = true;
      var started = ctx.photo ? Promise.resolve(ctx.photo) : pv.call('admin_drone_begin', { p_block: ctx.block, p_date: ctx.date });
      started.then(function (row) {
        ctx.photo = row;
        var job = ctx.job || (ctx.job = { id: row.id, block: ctx.block, pyr: ph.pyr, k: ph.k, box: ph.box });
        job.F = ctx.F;
        return makePieces(job, function (t, frac) { stat.textContent = t; if (frac !== undefined) bar.value = Math.round(frac * 100); }, function () { return cancelled; }).then(function (desc) {
          stat.textContent = 'Finishing…';
          var kid = D().keyId();
          var info = Object.assign(desc, {
            kid: kid, bytes: job.bytes, source: { name: ctx.file.name, size: ctx.file.size, px: [ph.W, ph.H], mpp: Math.round(scaleOf(ctx.F) * 1e4) / 1e4, crs: ph.geo ? ph.geo.epsg : null },
            placement: { method: ctx.method, adjusted: nudged, F: ctx.F.map(function (x) { return +x.toPrecision(12); }), full_px: true },
            fit: { method: ctx.method === 'gps' ? 'GeoTIFF GPS position (Block ' + ctx.block + ' reference)' + (nudged ? ', adjusted by hand' : '') : 'two points marked by ' + (S.user && S.user.username) + (nudged ? ', adjusted by hand' : '') }
          });
          return pv.call('admin_drone_finish', { p_id: row.id, p_info: info });
        });
      }).then(function () {
        if (saveRef && saveRef.checked && ph.geo && ph.geo.epsg) {
          var G = mul(ctx.F, inv(ph.geo.A));
          return pv.call('admin_drone_save_georef', { p_block: ctx.block, p_epsg: ph.geo.epsg, p_m: G, p_source: ctx.file.name + ', ' + ctx.date }).catch(function (e) { pv.toast('Photo uploaded, but its GPS position was not stored: ' + e.message, 'err', 9000); });
        }
      }).then(function () {
        st.busy = false; bar.value = 100;
        D().setShot(ctx.block, ctx.photo.id);
        return refresh().then(function () {
          root.textContent = '';
          root.append(h('p', { class: 'notice ok', text: 'Done: the Block ' + ctx.block + ' drone photo of ' + D().label({ date: ctx.date }) + ' is on the keyplan for everyone (photo date list). Users see it after their next reload.' }));
          var fl = document.getElementById('du-file'); if (fl) fl.value = '';
          pv.toast('Drone photo uploaded.', 'ok');
        });
      }).catch(function (e) {
        st.busy = false; up.disabled = false; stop.hidden = true;
        if (e.cancelled) { stat.textContent = 'Stopped. Press Upload the photo to continue where it stopped, or Remove the unfinished upload in the list below.'; return; }
        err.textContent = e.message + (ctx.photo ? ' Press Upload the photo to try again: pieces already sent are not sent again.' : ''); err.hidden = false;
        stat.textContent = '';
      });
    });
    root.textContent = '';
    root.append(h('h3', { text: 'Check the placement' }),
      h('p', { class: 'small', text: 'The yellow outlines are the keyplan sections. Zoom in on several places: the tables of the photo must sit inside them' + (D().available(ctx.block) ? ', and match the previous photo (lower the new photo’s strength to compare)' : '') + '. Use the arrows to correct a small shift.' }),
      info,
      h('div', { class: 'du-pane' }, h('div', { class: 'du-pane-head' }, h('strong', { text: 'Block ' + ctx.block + ', photo of ' + D().label({ date: ctx.date }) }),
        zoomButtons(v, function () { v.fit(0, 0, +kp.width, +kp.height); })), cv),
      h('div', { class: 'du-tools' },
        h('label', { class: 'du-op' }, h('span', { class: 'small', text: 'New photo strength' }), op),
        h('div', { class: 'du-nudge', role: 'group', 'aria-label': 'Move the photo' },
          h('button', { type: 'button', class: 'btn small', text: '←', 'aria-label': 'Move left', onclick: function () { nudge(-stepM(), 0); } }),
          h('button', { type: 'button', class: 'btn small', text: '↑', 'aria-label': 'Move up', onclick: function () { nudge(0, -stepM()); } }),
          h('button', { type: 'button', class: 'btn small', text: '↓', 'aria-label': 'Move down', onclick: function () { nudge(0, stepM()); } }),
          h('button', { type: 'button', class: 'btn small', text: '→', 'aria-label': 'Move right', onclick: function () { nudge(stepM(), 0); } }),
          h('button', { type: 'button', class: 'btn small', text: '⟲', 'aria-label': 'Turn left', onclick: function () { nudge(0, 0, -stepDeg()); } }),
          h('button', { type: 'button', class: 'btn small', text: '⟳', 'aria-label': 'Turn right', onclick: function () { nudge(0, 0, stepDeg()); } }),
          stepSel,
          h('button', { type: 'button', class: 'btn small ghost', text: 'Undo moves', onclick: function () { ctx.F = start.slice(); nudged = false; describe(); v.redraw(); } }))),
      refRow,
      h('div', { class: 'btn-row' }, up, stop,
        h('button', { type: 'button', class: 'btn', text: 'Place by two points instead', onclick: function () { if (!st.busy) pickPoints(root, ctx); } }),
        h('button', { type: 'button', class: 'btn ghost', text: 'Cancel', onclick: function () { if (!st.busy) root.textContent = ''; } })),
      bar, stat, err);
    describe();
    nextFrame().then(function () {
      // start on the photographed part of the keyplan
      var b = ph.box, cs = [ap(ctx.F, b[0], b[1]), ap(ctx.F, b[2], b[3])];
      v.fit(Math.max(-20, Math.min(cs[0][0], cs[1][0])), Math.max(-20, Math.min(cs[0][1], cs[1][1])),
            Math.min(+kp.width + 20, Math.max(cs[0][0], cs[1][0])), Math.min(+kp.height + 20, Math.max(cs[0][1], cs[1][1])));
    });
  }

  // for tests
  U._t = { lzw: lzw, fromPoints: fromPoints, guessDate: guessDate, tiffInfo: tiffInfo, mul: mul, inv: inv, readPhoto: readPhoto, pyramid: pyramid, maskBackground: maskBackground };
})();
