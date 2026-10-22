/* PV Module Serial Numbers — shared helpers (no project data in this file) */
(function () {
  'use strict';
  var SN = (window.SN = window.SN || {});

  // ---------- DOM ----------
  // el('div.cls#id', {attr}, child, ...) — text children are always set as text, never HTML.
  function el(spec, attrs) {
    var m = /^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(spec || 'div');
    var node = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) {
      m[2].replace(/([.#])([\w-]+)/g, function (_, k, v) {
        if (k === '.') node.classList.add(v); else node.id = v;
      });
    }
    var start = 1;
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      start = 2;
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'on') {
          Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        } else if (k === 'class') {
          String(v).split(/\s+/).filter(Boolean).forEach(function (c) { node.classList.add(c); });
        } else if (k === 'style' && typeof v === 'object') {
          Object.keys(v).forEach(function (p) { node.style.setProperty(p, v[p]); });
        } else if (k === 'text') {
          node.textContent = v;
        } else if (k === 'dataset') {
          Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        } else if (k in node && typeof v !== 'string' && k !== 'list') {
          node[k] = v;
        } else {
          node.setAttribute(k, v === true ? '' : String(v));
        }
      });
    }
    for (var i = start; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(node, x); }); return; }
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); return node; }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  // Inline SVG icons (stroke style). Paths are static strings defined here.
  var ICONS = {
    map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z M9 3v15 M15 6v15',
    chart: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
    check: 'M5 12l5 5L20 7',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5',
    gear: 'M12 9a3 3 0 100 6 3 3 0 000-6z M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    search: 'M11 4a7 7 0 100 14 7 7 0 000-14z M21 21l-5-5',
    x: 'M6 6l12 12 M18 6L6 18',
    plus: 'M12 5v14 M5 12h14',
    minus: 'M5 12h14',
    fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4z M12 10.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7z',
    barcode: 'M4 5v14 M7 5v14 M10 5v14 M14 5v14 M16 5v14 M20 5v14 M4 3h3 M17 3h3 M4 21h3 M17 21h3',
    text: 'M4 7V5h16v2 M12 5v14 M9 19h6',
    upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
    download: 'M12 4v12 M7 11l5 5 5-5 M4 20h16',
    user: 'M12 12a4 4 0 100-8 4 4 0 000 8z M4 21c1-4 4.5-6 8-6s7 2 8 6',
    users: 'M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7z M2.5 20c.8-3.4 3.5-5 6.5-5s5.7 1.6 6.5 5 M16 4.3a3.5 3.5 0 010 6.4 M18 15c2 .6 3.2 2.3 3.5 5',
    alert: 'M12 3l10 18H2z M12 10v4 M12 17.5v.5',
    clock: 'M12 21a9 9 0 100-18 9 9 0 000 18z M12 7v5l3 2',
    flash: 'M13 2L4 14h7l-1 8 9-12h-7z',
    history: 'M3 12a9 9 0 103-6.7 M3 4v5h5 M12 8v4l3 2',
    edit: 'M4 20h4L19 9l-4-4L4 16z M14 6l4 4',
    trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
    list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
    layers: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
    logout: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
    key: 'M15 7a4 4 0 11-3.7 5.5L4 20v-3h3v-3h3l1.3-1.3A4 4 0 0115 7z',
    refresh: 'M20 12a8 8 0 11-2.3-5.7 M20 4v5h-5',
    next: 'M5 12h14 M13 6l6 6-6 6',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 100 6 3 3 0 000-6z',
    select: 'M4 4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M4 10v4 M20 10v4 M10 4h4 M10 20h4',
    wifi: 'M2 9a15 15 0 0120 0 M5 12.5a10 10 0 0114 0 M8.5 16a5 5 0 017 0 M12 19.5h.01'
  };
  function icon(name, size) {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size || 18);
    svg.setAttribute('height', size || 18);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ico');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', ICONS[name] || '');
    svg.appendChild(p);
    return svg;
  }

  // ---------- time (Philippine time for all reporting) ----------
  var TZ = 'Asia/Manila';
  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    var d = typeof v === 'number' ? new Date(v) : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function parts(d) {
    var o = {};
    new Intl.DateTimeFormat('en-PH', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(d).forEach(function (p) { o[p.type] = p.value; });
    if (o.hour === '24') o.hour = '00';
    return o;
  }
  function ymd(v) { var d = toDate(v); if (!d) return ''; var p = parts(d); return p.year + '-' + p.month + '-' + p.day; }
  function fmtDateTime(v) {
    var d = toDate(v); if (!d) return '—';
    var p = parts(d);
    return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
  }
  function fmtDateLong(s) {
    if (!s) return '';
    var d = new Date(s + 'T12:00:00+08:00');
    return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' });
  }
  function fmtDateShort(s) {
    var d = new Date(s + 'T12:00:00+08:00');
    return d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
  }
  function todayPH() { return ymd(new Date()); }
  function addDays(s, n) {
    var d = new Date(s + 'T12:00:00+08:00'); d.setUTCDate(d.getUTCDate() + n); return ymd(d);
  }
  function ago(v) {
    var d = toDate(v); if (!d) return '';
    var s = (Date.now() - d.getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return fmtDateTime(v);
  }

  // ---------- numbers / text ----------
  function num(n) { return (n || 0).toLocaleString('en-US'); }
  function pct(a, b, dp) {
    if (!b) return '—';
    var v = (a / b) * 100;
    if (v > 0 && v < 0.1) return '<0.1%';
    if (v < 100 && v > 99.9) return '>99.9%';
    return v.toFixed(dp === undefined ? 1 : dp) + '%';
  }
  function normSerial(s) { return String(s || '').replace(/\s+/g, '').toUpperCase(); }
  function natKey(label) {
    // M01-17-014 -> sortable key; handles irregular IDs
    return String(label || '').replace(/\d+/g, function (d) { return ('00000' + parseInt(d, 10)).slice(-5); });
  }
  function looseId(label) {
    // compare IDs ignoring leading zeros: M01-39-95 == M01-39-095
    return String(label || '').toUpperCase().replace(/\s+/g, '').replace(/\d+/g, function (d) { return String(parseInt(d, 10)); });
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function tempPassword() {
    var a = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', b = new Uint8Array(12);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < 12; i++) s += a[b[i] % a.length] + (i === 3 || i === 7 ? '-' : '');
    return s;
  }
  function debounce(fn, ms) {
    var t;
    return function () { var a = arguments, me = this; clearTimeout(t); t = setTimeout(function () { fn.apply(me, a); }, ms); };
  }
  function levenshtein(a, b) {
    a = a || ''; b = b || '';
    var m = a.length, n = b.length, d = [], i, j;
    for (i = 0; i <= m; i++) d[i] = [i];
    for (j = 0; j <= n; j++) d[0][j] = j;
    for (i = 1; i <= m; i++) for (j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }

  // ---------- module numbering (same formula as pvsn.pos_no in the database) ----------
  function posNo(r, c, cfg) {
    cfg = cfg || {};
    var st = cfg.start || 'TL', ord = cfg.order || 'rows', sp = !!cfg.serpentine;
    var rr = (st === 'TL' || st === 'TR') ? r : 5 - r;
    var cc = (st === 'TL' || st === 'BL') ? c : 8 - c;
    if (ord === 'cols') {
      if (sp && cc % 2 === 0) rr = 5 - rr;
      return (cc - 1) * 4 + rr;
    }
    if (sp && rr % 2 === 0) cc = 8 - cc;
    return (rr - 1) * 7 + cc;
  }
  function posOrder(cfg) {
    // list of [r,c] in position-number order 1..28
    var out = [];
    for (var r = 1; r <= 4; r++) for (var c = 1; c <= 7; c++) out[posNo(r, c, cfg) - 1] = [r, c];
    return out;
  }

  // ---------- labels for codes ----------
  var ROLE = { admin: 'Administrator', encoder: 'Field Encoder', qaqc: 'QA/QC Reviewer', manager: 'Construction Manager' };
  var ISSUE = {
    duplicate: 'Duplicate serial number',
    barcode_mismatch: 'Serial differs from barcode',
    ocr_mismatch: 'OCR text differs',
    low_ocr: 'Low OCR confidence',
    unreadable: 'Label unreadable / damaged',
    format: 'Unexpected serial format',
    no_photo: 'No label photo',
    manual: 'Typed manually',
    qa_flag: 'Flagged by QA/QC'
  };
  var STATE = {
    not_installed: 'Not installed', ready: 'Ready for scanning', in_progress: 'In progress',
    completed: 'Completed', needs_review: 'Needs review', excluded: 'Excluded from scope',
    unconfirmed: 'Not confirmed', no_id: 'No table ID'
  };
  var FLAG = {
    no_id: 'Outline has no table ID in the drawing',
    duplicate_id: 'Same table ID is drawn on more than one table',
    id_format: 'Table ID format differs from its neighbours',
    label_only: 'Table ID drawn without a table outline',
    layer_mismatch: 'Drawing layer does not match the block'
  };

  // ---------- toasts ----------
  function toast(msg, kind, ms) {
    var host = $('#toasts');
    if (!host) return;
    var t = el('div.toast' + (kind ? '.' + kind : ''), { role: kind === 'error' ? 'alert' : 'status' }, msg);
    host.appendChild(t);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 300); }, ms || (kind === 'error' ? 6000 : 3200));
  }

  // ---------- modal dialogs ----------
  var modalStack = [];
  function openModal(opts) {
    // opts: {title, body (Node), actions: [{label, kind, onClick, close}], wide, full, onClose, className}
    var host = $('#modals');
    var wrap = el('div.modal-wrap' + (opts.full ? '.full' : '') + (opts.className ? '.' + opts.className : ''), { role: 'dialog', 'aria-modal': 'true' });
    var card = el('div.modal' + (opts.wide ? '.wide' : ''));
    var closeBtn = el('button.icon-btn.modal-x', { type: 'button', 'aria-label': 'Close' }, icon('x', 20));
    var head = el('div.modal-head', el('h2', { text: opts.title || '' }), closeBtn);
    var body = el('div.modal-body', opts.body || null);
    var foot = null;
    var api = { wrap: wrap, card: card, body: body, head: head, close: close, setTitle: function (t) { head.querySelector('h2').textContent = t; } };
    if (opts.actions && opts.actions.length) {
      foot = el('div.modal-foot');
      opts.actions.forEach(function (a) {
        var b = el('button.btn' + (a.kind ? '.' + a.kind : ''), { type: 'button' }, a.label);
        b.addEventListener('click', function () {
          var r = a.onClick ? a.onClick(api, b) : null;
          if (a.close !== false && r !== false) close();
        });
        foot.appendChild(b);
      });
    }
    card.appendChild(head); card.appendChild(body); if (foot) card.appendChild(foot);
    wrap.appendChild(card);
    var closed = false;
    function close() {
      if (closed) return; closed = true;
      wrap.remove();
      modalStack = modalStack.filter(function (m) { return m !== api; });
      document.body.classList.toggle('modal-open', modalStack.length > 0);
      if (opts.onClose) opts.onClose();
    }
    closeBtn.addEventListener('click', close);
    wrap.addEventListener('mousedown', function (e) { if (e.target === wrap && !opts.full) close(); });
    host.appendChild(wrap);
    modalStack.push(api);
    document.body.classList.add('modal-open');
    setTimeout(function () {
      var f = card.querySelector('[autofocus]') || closeBtn;
      try { f.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }, 30);
    return api;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalStack.length) modalStack[modalStack.length - 1].close();
  });
  function confirmBox(title, message, okLabel, kind) {
    return new Promise(function (resolve) {
      var done = false;
      openModal({
        title: title, body: el('p.confirm-text', message),
        actions: [
          { label: 'Cancel', onClick: function () { done = true; resolve(false); } },
          { label: okLabel || 'OK', kind: kind || 'primary', onClick: function () { done = true; resolve(true); } }
        ],
        onClose: function () { if (!done) resolve(false); }
      });
    });
  }
  function promptBox(title, label, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      var input = opts.multiline ? el('textarea', { rows: 3, maxlength: opts.max || 500 }) : el('input', { type: 'text', maxlength: opts.max || 200 });
      input.value = opts.value || '';
      input.setAttribute('autofocus', '');
      var body = el('div', opts.message ? el('p.muted', opts.message) : null, el('label.field', el('span', label), input));
      openModal({
        title: title, body: body,
        actions: [
          { label: 'Cancel', onClick: function () { done = true; resolve(null); } },
          { label: opts.ok || 'Save', kind: opts.kind || 'primary', onClick: function () {
            var v = input.value.trim();
            if (opts.required && v.length < (opts.min || 1)) { input.classList.add('invalid'); input.focus(); return false; }
            done = true; resolve(v);
          } }
        ],
        onClose: function () { if (!done) resolve(null); }
      });
    });
  }

  function download(filename, blob) {
    var a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  SN.u = {
    el: el, append: append, clear: clear, $: $, $$: $$, icon: icon,
    toDate: toDate, ymd: ymd, fmtDateTime: fmtDateTime, fmtDateLong: fmtDateLong, fmtDateShort: fmtDateShort,
    todayPH: todayPH, addDays: addDays, ago: ago,
    num: num, pct: pct, normSerial: normSerial, natKey: natKey, looseId: looseId, uuid: uuid,
    tempPassword: tempPassword, debounce: debounce, levenshtein: levenshtein,
    posNo: posNo, posOrder: posOrder, ROLE: ROLE, ISSUE: ISSUE, STATE: STATE, FLAG: FLAG,
    toast: toast, openModal: openModal, confirmBox: confirmBox, promptBox: promptBox, download: download
  };
})();
