/* PV Module Serial Numbers — interactive keyplan (canvas). World units are metres, y grows downwards. */
(function () {
  'use strict';
  var SN = window.SN;

  function Keyplan(canvas, o) {
    var ctx = canvas.getContext('2d', { alpha: false });
    var view = { s: 1, tx: 0, ty: 0 };
    var dpr = 1, W = 0, H = 0, raf = 0, anim = null;
    var tables = [], byId = new Map(), grid = new Map(), CELL = 40;
    var selected = null, hover = null, box = null;
    var minS = 0.05, maxS = 60;
    var TW = o.tw, TH = o.th;

    function invalidate() { if (!raf) raf = requestAnimationFrame(function () { raf = 0; draw(); }); }

    function resize() {
      var r = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      if (w === W && h === H && canvas.width === Math.round(w * dpr)) return;
      var cx = (W / 2 - view.tx) / view.s, cy = (H / 2 - view.ty) / view.s; // keep centre
      W = w; H = h;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      if (tables.length && view.s !== 1) { view.tx = W / 2 - cx * view.s; view.ty = H / 2 - cy * view.s; }
      invalidate();
    }

    function setTables(list) {
      tables = list; byId = new Map(); grid = new Map();
      list.forEach(function (t) {
        byId.set(t.id, t);
        var x0 = Math.floor((t.x - TW / 2) / CELL), x1 = Math.floor((t.x + TW / 2) / CELL);
        var y0 = Math.floor((t.y - TH / 2) / CELL), y1 = Math.floor((t.y + TH / 2) / CELL);
        for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
          var k = gx + ':' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(t);
        }
      });
      invalidate();
    }

    function toWorld(px, py) { return { x: (px - view.tx) / view.s, y: (py - view.ty) / view.s }; }

    function hit(px, py) {
      var w = toWorld(px, py), tol = Math.max(0, 6 / view.s), best = null, bd = 1e9;
      var gx0 = Math.floor((w.x - tol - TW) / CELL), gx1 = Math.floor((w.x + tol + TW) / CELL);
      var gy0 = Math.floor((w.y - tol - TH) / CELL), gy1 = Math.floor((w.y + tol + TH) / CELL);
      var seen = new Set();
      for (var gx = gx0; gx <= gx1; gx++) for (var gy = gy0; gy <= gy1; gy++) {
        (grid.get(gx + ':' + gy) || []).forEach(function (t) {
          if (seen.has(t.id)) return; seen.add(t.id);
          if (o.isHidden && o.isHidden(t)) return;
          var dx = Math.abs(w.x - t.x) - TW / 2, dy = Math.abs(w.y - t.y) - TH / 2;
          if (dx <= tol && dy <= tol) {
            var d = Math.hypot(w.x - t.x, (w.y - t.y) * 2);
            if (d < bd) { bd = d; best = t; }
          }
        });
      }
      return best;
    }

    var hatch = null;
    function hatchPattern() {
      if (hatch) return hatch;
      var c = document.createElement('canvas'); c.width = c.height = 8;
      var g = c.getContext('2d');
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
      hatch = ctx.createPattern(c, 'repeat');
      return hatch;
    }

    function textColor(fill) {
      var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill || '');
      if (!m) return '#111';
      var l = 0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16);
      return l > 165 ? '#14202b' : '#ffffff';
    }

    function draw() {
      if (!W) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = o.background ? o.background() : '#eef2f5';
      ctx.fillRect(0, 0, W, H);
      var s = view.s, tw = TW * s, th = TH * s;
      var vis = [];
      var minX = -tw, maxX = W + tw, minY = -th, maxY = H + th;
      // fills, grouped by colour
      var groups = new Map();
      for (var i = 0; i < tables.length; i++) {
        var t = tables[i];
        if (o.isHidden && o.isHidden(t)) continue;
        var cx = t.x * s + view.tx, cy = t.y * s + view.ty;
        if (cx < minX || cx > maxX || cy < minY || cy > maxY) continue;
        var dim = o.isDim ? o.isDim(t) : false;
        var fill = o.colorFor(t);
        var key = fill + (dim ? '|d' : '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
        vis.push(t);
      }
      groups.forEach(function (list, key) {
        var parts = key.split('|');
        ctx.globalAlpha = parts[1] ? 0.16 : 1;
        ctx.fillStyle = parts[0];
        ctx.beginPath();
        list.forEach(function (t) {
          var x = t.x * s + view.tx - tw / 2, y = t.y * s + view.ty - th / 2;
          if (parts[0] === 'none') return;
          ctx.rect(x, y, Math.max(tw, 1.2), Math.max(th, 1.2));
        });
        if (parts[0] !== 'none') ctx.fill();
      });
      ctx.globalAlpha = 1;
      // diagonal hatch = second cue for "needs review" (not colour alone)
      if (o.hatch && tw >= 5) {
        ctx.fillStyle = hatchPattern();
        ctx.beginPath();
        vis.forEach(function (t) {
          if (!o.hatch(t) || (o.isDim && o.isDim(t))) return;
          ctx.rect(t.x * s + view.tx - tw / 2, t.y * s + view.ty - th / 2, tw, th);
        });
        ctx.fill();
      }
      // outlines when big enough
      if (tw > 7) {
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(20,32,43,0.35)';
        ctx.beginPath();
        vis.forEach(function (t) {
          if (o.isDim && o.isDim(t)) return;
          var x = t.x * s + view.tx - tw / 2, y = t.y * s + view.ty - th / 2;
          ctx.rect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(tw) - 1, Math.round(th) - 1);
        });
        ctx.stroke();
      }
      // special markers: dashed (unconfirmed / no id / drawing issue)
      ctx.setLineDash([4, 3]);
      vis.forEach(function (t) {
        var mk = o.markerFor ? o.markerFor(t) : null;
        if (!mk) return;
        var x = t.x * s + view.tx - tw / 2, y = t.y * s + view.ty - th / 2;
        ctx.strokeStyle = mk; ctx.lineWidth = Math.max(1.5, Math.min(3, tw / 25));
        ctx.strokeRect(x - 1.5, y - 1.5, Math.max(tw, 2) + 3, Math.max(th, 2) + 3);
      });
      ctx.setLineDash([]);
      // assigned-to-me / multi-selection rings
      if (o.isMarked) {
        ctx.lineWidth = Math.max(2, Math.min(4, tw / 14)); ctx.strokeStyle = o.markColor || '#7b2cbf';
        vis.forEach(function (t) {
          if (!o.isMarked(t)) return;
          var x = t.x * s + view.tx - tw / 2, y = t.y * s + view.ty - th / 2;
          ctx.strokeRect(x - 2, y - 2, Math.max(tw, 2) + 4, Math.max(th, 2) + 4);
        });
      }
      // labels
      if (tw >= 58) {
        var fs = Math.max(9, Math.min(15, th * 0.42, tw / 7.2));
        ctx.font = '600 ' + fs + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        vis.forEach(function (t) {
          if (o.isDim && o.isDim(t)) return;
          var cx = t.x * s + view.tx, cy = t.y * s + view.ty;
          var fill = o.colorFor(t);
          ctx.fillStyle = fill === 'none' ? '#14202b' : textColor(fill);
          var lab = t.label || 'no ID';
          ctx.fillText(lab, cx, cy - (th > 34 ? fs * 0.45 : 0));
          if (th > 34 && o.subLabel) {
            ctx.font = '500 ' + Math.round(fs * 0.85) + 'px system-ui, sans-serif';
            ctx.fillText(o.subLabel(t), cx, cy + fs * 0.7);
            ctx.font = '600 ' + fs + 'px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          }
        });
      }
      // block names when zoomed out
      if (o.blocks && tw < 40) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        o.blocks().forEach(function (b) {
          var cx = b.x * s + view.tx, cy = b.y * s + view.ty;
          var fs = Math.max(13, Math.min(30, 70 * s));
          ctx.font = '800 ' + fs + 'px system-ui, sans-serif';
          ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.strokeText(b.name, cx, cy);
          ctx.fillStyle = 'rgba(20,32,43,0.78)';
          ctx.fillText(b.name, cx, cy);
        });
      }
      // hover + selection
      [hover, selected].forEach(function (t, i) {
        if (!t || (o.isHidden && o.isHidden(t))) return;
        var x = t.x * s + view.tx - tw / 2, y = t.y * s + view.ty - th / 2;
        var pad = i ? 4 : 2;
        ctx.lineWidth = i ? 3 : 2;
        ctx.strokeStyle = i ? '#0b1620' : 'rgba(11,22,32,0.6)';
        ctx.strokeRect(x - pad, y - pad, Math.max(tw, 3) + pad * 2, Math.max(th, 3) + pad * 2);
        if (i) {
          ctx.lineWidth = 2; ctx.strokeStyle = '#ffd60a';
          ctx.strokeRect(x - pad - 2.5, y - pad - 2.5, Math.max(tw, 3) + pad * 2 + 5, Math.max(th, 3) + pad * 2 + 5);
        }
      });
      // selection box
      if (box) {
        ctx.fillStyle = 'rgba(123,44,191,0.10)'; ctx.strokeStyle = '#7b2cbf'; ctx.lineWidth = 1.5;
        var bx = Math.min(box.x0, box.x1), by = Math.min(box.y0, box.y1);
        ctx.fillRect(bx, by, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
        ctx.strokeRect(bx, by, Math.abs(box.x1 - box.x0), Math.abs(box.y1 - box.y0));
      }
      if (o.afterDraw) o.afterDraw(view);
    }

    function bounds(list) {
      var b = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
      (list || tables).forEach(function (t) {
        if (o.isHidden && o.isHidden(t)) return;
        b.x0 = Math.min(b.x0, t.x - TW / 2); b.x1 = Math.max(b.x1, t.x + TW / 2);
        b.y0 = Math.min(b.y0, t.y - TH / 2); b.y1 = Math.max(b.y1, t.y + TH / 2);
      });
      return b;
    }
    function viewFor(b, padPx) {
      padPx = padPx === undefined ? 24 : padPx;
      var bw = Math.max(b.x1 - b.x0, 1), bh = Math.max(b.y1 - b.y0, 1);
      var s = Math.min((W - padPx * 2) / bw, (H - padPx * 2) / bh);
      s = Math.max(minS, Math.min(maxS, s));
      return { s: s, tx: W / 2 - ((b.x0 + b.x1) / 2) * s, ty: H / 2 - ((b.y0 + b.y1) / 2) * s };
    }
    function animateTo(v, ms) {
      if (anim) cancelAnimationFrame(anim.raf);
      var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduce || !ms) { view = v; invalidate(); emitView(); return; }
      var from = { s: view.s, tx: view.tx, ty: view.ty }, t0 = performance.now();
      // interpolate in world-centre space so the zoom feels natural
      var c0 = { x: (W / 2 - from.tx) / from.s, y: (H / 2 - from.ty) / from.s };
      var c1 = { x: (W / 2 - v.tx) / v.s, y: (H / 2 - v.ty) / v.s };
      anim = {};
      (function step() {
        var k = Math.min(1, (performance.now() - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        var s = Math.exp(Math.log(from.s) + (Math.log(v.s) - Math.log(from.s)) * e);
        var cx = c0.x + (c1.x - c0.x) * e, cy = c0.y + (c1.y - c0.y) * e;
        view = { s: s, tx: W / 2 - cx * s, ty: H / 2 - cy * s };
        draw();
        if (k < 1) anim.raf = requestAnimationFrame(step); else { anim = null; emitView(); }
      })();
    }
    function fit(animate) {
      var b = bounds();
      if (b.x0 > b.x1) return;
      var v = viewFor(b, W < 600 ? 10 : 28);
      minS = v.s * 0.6;
      animateTo(v, animate ? 320 : 0);
    }
    function focusTable(t, zoom) {
      var targetS = zoom || Math.max(view.s, Math.min(maxS, 7));
      var v = { s: targetS, tx: W / 2 - t.x * targetS, ty: H / 2 - t.y * targetS };
      if (o.focusOffset) { var off = o.focusOffset(); v.tx += off.x; v.ty += off.y; }
      animateTo(v, 380);
    }
    function zoomAt(px, py, f) {
      var s = Math.max(minS, Math.min(maxS, view.s * f));
      var w = toWorld(px, py);
      view = { s: s, tx: px - w.x * s, ty: py - w.y * s };
      invalidate(); emitView();
    }
    var emitView = SN.u.debounce(function () { if (o.onView) o.onView(view); }, 120);

    // ---------- pointer interaction ----------
    var pointers = new Map(), down = null, pinch = null, lastTap = 0;
    canvas.addEventListener('pointerdown', function (e) {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (anim) { cancelAnimationFrame(anim.raf); anim = null; }
      if (pointers.size === 1) {
        down = { x: e.offsetX, y: e.offsetY, tx: view.tx, ty: view.ty, t: Date.now(), moved: false,
                 boxing: !!(o.boxSelect && o.boxSelect() && (e.shiftKey || e.pointerType === 'mouse' && e.button === 0 && o.boxSelect() === 'always')) };
        if (down.boxing) box = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY };
      } else if (pointers.size === 2) {
        var p = Array.from(pointers.values());
        pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2,
                  s: view.s, tx: view.tx, ty: view.ty };
        if (down) down.moved = true;
        box = null;
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') {
          var h = hit(e.offsetX, e.offsetY);
          if (h !== hover) { hover = h; invalidate(); canvas.style.cursor = h ? 'pointer' : 'grab'; if (o.onHover) o.onHover(h, e.offsetX, e.offsetY); }
          else if (h && o.onHover) o.onHover(h, e.offsetX, e.offsetY);
        }
        return;
      }
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pinch && pointers.size >= 2) {
        var p = Array.from(pointers.values());
        var d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx = (p[0].x + p[1].x) / 2, my = (p[0].y + p[1].y) / 2;
        var s = Math.max(minS, Math.min(maxS, pinch.s * d / Math.max(pinch.d, 1)));
        var wx = (pinch.mx - pinch.tx) / pinch.s, wy = (pinch.my - pinch.ty) / pinch.s;
        view = { s: s, tx: mx - wx * s, ty: my - wy * s };
        invalidate();
        return;
      }
      if (!down) return;
      var dx = e.offsetX - down.x, dy = e.offsetY - down.y;
      if (Math.abs(dx) + Math.abs(dy) > 6) down.moved = true;
      if (down.boxing) { box.x1 = e.offsetX; box.y1 = e.offsetY; invalidate(); return; }
      if (down.moved) {
        view.tx = down.tx + dx; view.ty = down.ty + dy; invalidate();
        if (hover) { hover = null; if (o.onHover) o.onHover(null); }
      }
    });
    function end(e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (pinch && pointers.size < 2) { pinch = null; emitView(); if (pointers.size === 1) { down = null; } return; }
      if (!down) return;
      var d = down; down = null;
      if (d.boxing && box) {
        var b = box; box = null; invalidate();
        if (Math.abs(b.x1 - b.x0) > 6 && Math.abs(b.y1 - b.y0) > 6 && o.onBoxSelect) {
          var a = toWorld(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1)), c = toWorld(Math.max(b.x0, b.x1), Math.max(b.y0, b.y1));
          o.onBoxSelect(tables.filter(function (t) {
            return !(o.isHidden && o.isHidden(t)) && t.x >= a.x && t.x <= c.x && t.y >= a.y && t.y <= c.y;
          }), e);
          return;
        }
      }
      if (d.moved) { emitView(); return; }
      if (e.type === 'pointercancel') return;
      var now = Date.now();
      if (now - lastTap < 300 && e.pointerType !== 'mouse') { lastTap = 0; zoomAt(e.offsetX, e.offsetY, 2.2); return; }
      lastTap = now;
      var t = hit(e.offsetX, e.offsetY);
      if (o.onTap) o.onTap(t, e);
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', function () { if (hover) { hover = null; invalidate(); if (o.onHover) o.onHover(null); } });
    canvas.addEventListener('dblclick', function (e) { zoomAt(e.offsetX, e.offsetY, 2.2); });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.offsetX, e.offsetY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
    canvas.addEventListener('keydown', function (e) {
      var step = 60;
      if (e.key === '+' || e.key === '=') zoomAt(W / 2, H / 2, 1.4);
      else if (e.key === '-' || e.key === '_') zoomAt(W / 2, H / 2, 1 / 1.4);
      else if (e.key === 'ArrowLeft') { view.tx += step; invalidate(); }
      else if (e.key === 'ArrowRight') { view.tx -= step; invalidate(); }
      else if (e.key === 'ArrowUp') { view.ty += step; invalidate(); }
      else if (e.key === 'ArrowDown') { view.ty -= step; invalidate(); }
      else if (e.key === '0') fit(true);
      else return;
      e.preventDefault();
    });

    if (window.ResizeObserver) new ResizeObserver(function () { resize(); }).observe(canvas);
    window.addEventListener('resize', resize);
    resize();

    return {
      setTables: setTables, invalidate: invalidate, fit: fit, focusTable: focusTable,
      select: function (t) { selected = t || null; invalidate(); },
      selected: function () { return selected; },
      zoom: function (f) { zoomAt(W / 2, H / 2, f); },
      resize: resize, view: function () { return view; },
      setView: function (v) { if (v && v.s) { view = { s: v.s, tx: v.tx, ty: v.ty }; invalidate(); } },
      size: function () { return { w: W, h: H }; },
      hit: hit
    };
  }
  SN.Keyplan = Keyplan;
})();
