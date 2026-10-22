/* PV Module Serial Numbers — registration / correction form (scan, photo, OCR, validate, save) */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, el = u.el, api = SN.api, S = SN.state;

  function cfg() { return S.settings.numbering || {}; }
  function vset() { return S.settings.validation || {}; }
  function pref(key, def) { try { var v = localStorage.getItem('pvsn.' + key); return v === null ? def : v === '1'; } catch (e) { return def; } }
  function setPref(key, on) { try { localStorage.setItem('pvsn.' + key, on ? '1' : '0'); } catch (e) { /* ignore */ } }

  function cameraError(err) {
    var n = err && (err.name || '') , m = String((err && err.message) || err || '');
    if (/NotAllowed|Permission/i.test(n + m)) return 'Camera permission was refused. Allow camera access for this site in the browser settings, or use "Take label photo".';
    if (/NotFound|Requested device not found|no camera/i.test(n + m)) return 'No camera was found on this device. Use "Take label photo" or type the serial number.';
    if (/NotReadable|in use|Could not start/i.test(n + m)) return 'The camera is busy (another app may be using it). Close other camera apps and try again.';
    if (/secure|https/i.test(m)) return 'The camera needs a secure (https) page.';
    return 'The camera could not start: ' + m;
  }

  SN.captureForm = function (sheet, t, oldRec) {
    var body = sheet.modal.body;
    var correcting = !!oldRec, r = sheet.r, c = sheet.c, pos = u.posNo(r, c, cfg());
    var st = {
      barcode: correcting ? (oldRec.barcode || '') : '', format: correcting ? (oldRec.barcode_format || '') : '',
      photo: null, photoUrl: null, ocr: null, ocrApplied: false, dups: null, live: null, usedLive: false, saving: false
    };
    sheet.busy = false;
    sheet.cleanup = function () { stopLive(); if (st.photoUrl) URL.revokeObjectURL(st.photoUrl); };
    sheet.modal.setTitle((t.label || 'No ID') + ' · Position ' + pos + (correcting ? ' · Correct' : ''));

    if (correcting) {
      body.appendChild(el('div.notice', u.icon('edit'), el('div', el('strong', 'Correcting ' + oldRec.serial),
        el('p.small', 'The current record stays in the history. Keep the existing photo or take a new one.'))));
    }
    var banner = el('div.save-banner', { hidden: true, role: 'status' });
    body.appendChild(banner);
    if (sheet.flash && sheet.flashUntil > Date.now()) {
      banner.hidden = false; banner.textContent = sheet.flash;
      setTimeout(function () { banner.hidden = true; }, Math.max(0, sheet.flashUntil - Date.now()));
    }

    // ---------- step 1: capture ----------
    var scanBtn = el('button.btn.primary.big', { type: 'button' }, u.icon('barcode', 22), el('span', 'Scan barcode'));
    var photoBtn = el('button.btn.big', { type: 'button' }, u.icon('camera', 22), el('span', 'Take label photo'));
    var fileIn = el('input.offscreen', { type: 'file', accept: 'image/*', capture: 'environment', tabindex: '-1', 'aria-hidden': 'true' });
    var galleryIn = el('input.offscreen', { type: 'file', accept: 'image/jpeg,image/png,image/heic,image/*', tabindex: '-1', 'aria-hidden': 'true' });
    var galleryLink = el('button.linkbtn', { type: 'button' }, 'or choose a photo already taken');
    var torchBtn = el('button.btn.small', { type: 'button', hidden: true, 'aria-pressed': 'false' }, u.icon('flash'), 'Light');
    var stopBtn = el('button.btn.small', { type: 'button' }, 'Stop camera');
    var liveHost = el('div.live-host#live-scan');
    var liveBox = el('div.live', { hidden: true }, liveHost,
      el('div.live-bar', el('span.small', 'Fill the box with the barcode. Hold steady 15–25 cm away.'), el('span.grow'), torchBtn, stopBtn));
    var capStatus = el('div.cap-status', { role: 'status', 'aria-live': 'polite' });
    var photoPrev = el('div.photo-prev', { hidden: !correcting || !oldRec.photo });
    body.appendChild(el('section.step',
      el('h3.step-title', el('span.step-no', '1'), 'Read the label'),
      el('div.cap-btns', scanBtn, photoBtn), el('div.center', galleryLink), fileIn, galleryIn, liveBox, capStatus, photoPrev));
    if (correcting && oldRec.photo) {
      photoPrev.appendChild(el('div.small.muted', 'Current photo (kept unless you take a new one)'));
      var curImg = el('img', { alt: 'Current label photo' });
      api.photoUrl(oldRec.thumb || oldRec.photo).then(function (url) { curImg.src = url; }, function () {});
      photoPrev.appendChild(curImg);
    }

    // ---------- step 2: serial ----------
    var bcLine = el('div.bc-line');
    var serialIn = el('input#serial-in.serial.mono', { type: 'text', maxlength: 60, autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text',
      'aria-describedby': 'serial-msg', placeholder: 'Scan, or type the serial number' });
    serialIn.value = correcting ? oldRec.serial : '';
    var serialMsg = el('div.field-msg#serial-msg', { 'aria-live': 'polite' });
    var ocrBtn = el('button.btn', { type: 'button', disabled: !(correcting && oldRec.photo) }, u.icon('text'), 'Read text from photo (OCR)');
    var ocrOut = el('div.ocr-out', { 'aria-live': 'polite' });
    body.appendChild(el('section.step',
      el('h3.step-title', el('span.step-no', '2'), 'Check the serial number'),
      bcLine,
      el('label.field', el('span', 'Serial number'), serialIn), serialMsg,
      el('div.ocr-row', ocrBtn, el('span.small.muted', 'Optional: compares the printed text with the barcode.')), ocrOut));

    // ---------- step 3: confirm ----------
    var unread = el('input', { type: 'checkbox', id: 'cb-unread' });
    var remarks = el('textarea', { rows: 2, maxlength: 500, placeholder: 'Optional — e.g. label scratched, sticker partly missing' });
    remarks.value = correcting ? (oldRec.remarks || '') : '';
    var reasonIn = correcting ? el('input', { type: 'text', maxlength: 300, placeholder: 'Required — e.g. wrong digit typed', 'aria-required': 'true' }) : null;
    var confirm = el('input', { type: 'checkbox', id: 'cb-confirm' });
    var autoNext = el('input', { type: 'checkbox', id: 'cb-auto', checked: pref('autoNext', true) });
    var err = el('div.notice.bad', { hidden: true, role: 'alert' });
    var saveBtn = el('button.btn.primary.big.block', { type: 'button' }, u.icon('check', 22), el('span', correcting ? 'Save correction' : 'Save position ' + pos));
    body.appendChild(el('section.step',
      el('h3.step-title', el('span.step-no', '3'), 'Confirm and save'),
      el('label.check', { for: 'cb-unread' }, unread, el('span', 'Label is unreadable or damaged', el('small.muted', 'The record is sent to QA/QC review.'))),
      el('label.field', el('span', 'Remarks'), remarks),
      correcting ? el('label.field', el('span', 'Reason for the correction'), reasonIn) : null,
      el('label.check.confirm', { for: 'cb-confirm' }, confirm, el('span', el('strong', 'I confirm the serial number above matches the label on this module.'))),
      err, saveBtn,
      !correcting ? el('label.check.small', { for: 'cb-auto' }, autoNext, el('span', 'After saving, go to the next empty position')) : null));
    if (correcting) {
      var cancel = el('button.btn.ghost.block', { type: 'button', on: { click: function () { sheet.mode = 'auto'; sheet.render(); } } }, 'Cancel correction');
      body.appendChild(cancel);
    }
    autoNext.addEventListener('change', function () { setPref('autoNext', autoNext.checked); });

    // ---------- behaviour ----------
    function status(msg, kind) {
      u.clear(capStatus);
      if (!msg) return;
      capStatus.className = 'cap-status' + (kind ? ' ' + kind : '');
      capStatus.appendChild(document.createTextNode(msg));
    }
    function showErr(msg) { err.hidden = !msg; u.clear(err); if (msg) { err.appendChild(u.icon('alert')); err.appendChild(el('div', msg)); err.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }
    function renderBarcode() {
      u.clear(bcLine);
      if (!st.barcode) { bcLine.appendChild(el('span.muted', 'No barcode read yet.')); return; }
      bcLine.appendChild(el('span', 'Barcode: '));
      bcLine.appendChild(el('strong.mono', st.barcode));
      if (st.format) bcLine.appendChild(el('span.muted', '  ' + st.format.replace(/_/g, ' ')));
    }
    function stopLive() {
      if (st.live) { var h = st.live; st.live = null; h.stop(); }
      liveBox.hidden = true; scanBtn.disabled = false;
    }
    function startLive() {
      showErr(null);
      if (!SN.capture.liveSupported()) { status('Live scanning is not available in this browser. Use "Take label photo".', 'warn'); return; }
      liveBox.hidden = false; scanBtn.disabled = true; status('Starting camera…');
      SN.capture.startLive('live-scan', onDecoded).then(function (h) {
        if (!sheet.modal.wrap.isConnected) { h.stop(); return; }
        st.live = h; st.usedLive = true; status('');
        if (h.hasTorch()) torchBtn.hidden = false;
      }, function (e) {
        liveBox.hidden = true; scanBtn.disabled = false; status('');
        showErr(cameraError(e));
      });
    }
    function onDecoded(text, fmt, frame) {
      var prev = st.barcode;
      st.barcode = text; st.format = fmt;
      var cur = serialIn.value.trim();
      if (!cur || u.normSerial(cur) === u.normSerial(prev)) serialIn.value = text;
      stopLive(); renderBarcode(); checkSerial();
      status('Barcode read.', 'ok');
      if (frame && !st.photo) setPhoto(frame, true);
    }
    function setPhoto(src, fromScan) {
      status(fromScan ? 'Saving the camera frame as the label photo…' : 'Processing photo…');
      return SN.capture.processPhoto(src).then(function (p) {
        st.photo = p;
        if (st.photoUrl) URL.revokeObjectURL(st.photoUrl);
        st.photoUrl = URL.createObjectURL(p.full);
        u.clear(photoPrev); photoPrev.hidden = false;
        photoPrev.appendChild(el('img', { src: st.photoUrl, alt: 'Label photo to be saved' }));
        photoPrev.appendChild(el('div.small.muted', (fromScan ? 'Frame from the barcode scan' : 'New photo') + ' · ' + p.width + '×' + p.height + ' · ' + Math.round(p.full.size / 1024) + ' KB'));
        photoPrev.appendChild(el('button.linkbtn', { type: 'button', on: { click: function () { fileIn.click(); } } }, 'Retake photo'));
        ocrBtn.disabled = false;
        if (!st.barcode) {
          status('Looking for the barcode in the photo…');
          return SN.capture.decodeStill(p.source).then(function (res) {
            if (res && res.text) {
              st.barcode = res.text; st.format = res.format;
              if (!serialIn.value.trim()) serialIn.value = res.text;
              renderBarcode(); checkSerial(); status('Barcode read from the photo.', 'ok');
            } else {
              status('No barcode found in the photo. Scan it live, use OCR, or type the serial number.', 'warn');
            }
          });
        }
        status(fromScan ? 'Barcode read and photo saved from the camera. Take a sharper photo if the label text is hard to read.' : 'Photo added.', 'ok');
      }).catch(function (e) { status(''); showErr(e.message); });
    }
    function runOcr() {
      var src = st.photo ? st.photo.source : null;
      var p = src ? Promise.resolve(src) : (correcting && oldRec.photo ? api.photoUrl(oldRec.photo).then(function (url) {
        return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = url; });
      }) : Promise.reject(new Error('Take a photo first.')));
      ocrBtn.disabled = true; u.clear(ocrOut).appendChild(el('span.muted', 'Starting OCR (first use downloads about 6 MB)…'));
      p.then(function (img) {
        return SN.capture.ocr(img, { want: st.barcode || serialIn.value, onProgress: function (pr) { u.clear(ocrOut).appendChild(el('span.muted', pr.label + '…')); } });
      }).then(function (res) {
        var cands = SN.capture.candidates(res.text, res.words, st.barcode || serialIn.value);
        var best = cands[0] || null;
        st.ocr = { text: (res.text || '').trim().slice(0, 600), conf: best && best.conf !== null ? best.conf : res.conf, best: best ? best.value : null };
        renderOcr();
      }, function (e) {
        u.clear(ocrOut).appendChild(el('span.warn-text', S.online === false
          ? 'OCR is not on this phone yet: it downloads once (about 6 MB) when there is signal. Use the barcode or type the serial number.'
          : 'OCR could not run: ' + e.message));
      })
        .then(function () { ocrBtn.disabled = false; });
    }
    function renderOcr() {
      u.clear(ocrOut);
      if (!st.ocr) return;
      var o = st.ocr, conf = o.conf !== null && o.conf !== undefined ? Math.round(o.conf) + '%' : '?';
      if (!o.best) { ocrOut.appendChild(el('div.warn-text', 'No serial-like text found in the photo (confidence ' + conf + ').')); return; }
      var line = el('div', 'OCR read: ', el('strong.mono', o.best), el('span.muted', ' · confidence ' + conf));
      ocrOut.appendChild(line);
      var bc = u.normSerial(st.barcode);
      if (bc && o.best === bc) ocrOut.appendChild(el('div.ok-text', u.icon('check', 14), ' Matches the barcode.'));
      else if (bc) ocrOut.appendChild(el('div.warn-text', u.icon('alert', 14), ' Differs from the barcode. Check the label; the record will go to QA/QC review.'));
      if (u.normSerial(serialIn.value) !== o.best) {
        ocrOut.appendChild(el('button.btn.small', { type: 'button', on: { click: function () {
          serialIn.value = o.best; st.ocrApplied = true; checkSerial(); renderOcr();
        } } }, 'Use OCR result as serial number'));
      }
      if (o.conf !== null && o.conf < (vset().ocr_min_confidence || 70)) ocrOut.appendChild(el('div.small.muted', 'Low OCR confidence — rely on the barcode or check the label by eye.'));
    }
    // Duplicate check: the server when it answers, otherwise the copy of the records on this phone.
    // Registrations saved on this phone but not uploaded yet are always checked too.
    var dupSeq = 0;
    var dupCheck = u.debounce(function () {
      var v = serialIn.value.trim(), n = u.normSerial(v), my = ++dupSeq;
      if (!n) return;
      var server = S.online === false ? Promise.resolve(null)
        : api.call('sn_check_serial', { p_serial: v, p_table_id: t.id, p_r: r, p_c: c }, { timeout: 8000 }).then(function (res) { return res.dups || []; }, function () { return null; });
      Promise.all([server, SN.store.bySerial(n).catch(function () { return []; }), api.outbox.list()]).then(function (a) {
        if (my !== dupSeq) return;
        var same = function (tid, rr, cc) { return tid === t.id && rr === r && cc === c; };
        var dups = a[0] !== null ? a[0].slice() : a[1].filter(function (x) { return !same(x.t, x.r, x.c); }).map(function (x) {
          var tt = S.tables.get(x.t);
          return { table_id: x.t, label: tt ? tt.label : '?', r: x.r, c: x.c };
        });
        a[2].forEach(function (it) {
          if (u.normSerial(it.data && it.data.serial) !== n || same(it.table_id, it.r, it.c)) return;
          if (dups.some(function (d) { return d.table_id === it.table_id && d.r === it.r && d.c === it.c; })) return;
          dups.push({ table_id: it.table_id, label: it.label, r: it.r, c: it.c, queued: true });
        });
        st.dups = dups; st.dupSource = a[0] !== null ? 'server' : 'phone';
        renderSerialMsg();
      });
    }, 450);
    function renderSerialMsg() {
      u.clear(serialMsg);
      var v = u.normSerial(serialIn.value);
      if (!v) return;
      var pat = vset().serial_pattern;
      var okFmt = true;
      try { okFmt = !pat || new RegExp(pat).test(v); } catch (e) { okFmt = true; }
      if (!okFmt) serialMsg.appendChild(el('div.warn-text', u.icon('alert', 14), ' Unexpected format' + (vset().serial_hint ? ' (expected ' + vset().serial_hint + ')' : '') + '. It will go to QA/QC review.'));
      if (st.barcode && vset().barcode_is_serial !== false && u.normSerial(st.barcode) !== v) {
        serialMsg.appendChild(el('div.warn-text', u.icon('alert', 14), ' Differs from the barcode. It will go to QA/QC review.'));
      }
      if (st.dups && st.dups.length) {
        serialMsg.appendChild(el('div.bad-text', u.icon('alert', 14), ' Already registered at ',
          st.dups.map(function (d, i) { return [i ? ', ' : '', el('strong', d.label + ' position ' + u.posNo(d.r, d.c, cfg()) + (d.queued ? ' (saved on this phone)' : ''))]; }),
          '. Saving marks both records Needs review.'));
      } else if (st.dups) {
        var rs = SN.sync.rs.st;
        serialMsg.appendChild(el('div.ok-text', u.icon('check', 14), st.dupSource === 'phone'
          ? ' Not found in the copy on this phone' + (rs && rs.complete ? '' : ' (copy not complete yet)') + '. The server checks again when it uploads.'
          : ' Not registered anywhere else.'));
      }
    }
    function checkSerial() { st.dups = null; renderSerialMsg(); dupCheck(); }

    scanBtn.addEventListener('click', startLive);
    stopBtn.addEventListener('click', function () { stopLive(); status(''); });
    torchBtn.addEventListener('click', function () {
      if (!st.live) return;
      var on = torchBtn.getAttribute('aria-pressed') !== 'true';
      st.live.torch(on).then(function (ok) { if (ok) torchBtn.setAttribute('aria-pressed', String(on)); });
    });
    photoBtn.addEventListener('click', function () { stopLive(); fileIn.click(); });
    galleryLink.addEventListener('click', function () { stopLive(); galleryIn.click(); });
    [fileIn, galleryIn].forEach(function (inp) {
      inp.addEventListener('change', function () { var f = inp.files && inp.files[0]; inp.value = ''; if (f) setPhoto(f, false); });
    });
    ocrBtn.addEventListener('click', runOcr);
    serialIn.addEventListener('input', function () {
      var pos0 = serialIn.selectionStart, up = serialIn.value.toUpperCase();
      if (up !== serialIn.value) { serialIn.value = up; try { serialIn.setSelectionRange(pos0, pos0); } catch (e) { /* ignore */ } }
      st.ocrApplied = st.ocr && st.ocr.best === u.normSerial(serialIn.value);
      checkSerial();
    });
    renderBarcode();
    if (correcting) checkSerial();

    saveBtn.addEventListener('click', save);
    function save() {
      if (st.saving) return;
      showErr(null);
      var serial = serialIn.value.trim();
      if (!u.normSerial(serial)) return showErr('Enter the serial number: scan the barcode, use OCR, or type it.');
      if (vset().require_photo !== false && !st.photo && !(correcting && oldRec.photo)) return showErr('Take a photo of the serial-number label first. It is kept as evidence.');
      if (!confirm.checked) return showErr('Check the serial number against the label, then tick the confirmation box.');
      if (correcting && reasonIn.value.trim().length < 3) return showErr('Give a reason for the correction.');
      var go = function () { doSave(serial); };
      if (st.dups && st.dups.length) {
        u.confirmBox('Duplicate serial number', serial + ' is already registered at ' + st.dups.map(function (d) { return d.label + ' position ' + u.posNo(d.r, d.c, cfg()); }).join(', ') +
          '. If you save, both records are marked Needs review for QA/QC. Save anyway?', 'Save anyway', 'danger').then(function (ok) { if (ok) go(); });
      } else go();
    }
    function setSaving(on, label) {
      st.saving = on; sheet.busy = on; saveBtn.disabled = on;
      saveBtn.querySelector('span').textContent = on ? (label || 'Saving…') : (correcting ? 'Save correction' : 'Save position ' + pos);
    }
    function doSave(serial) {
      stopLive();
      var data = {
        serial: serial, barcode: st.barcode || null, barcode_format: st.format || null,
        ocr: st.ocr ? st.ocr.text : null, ocr_conf: st.ocr && st.ocr.conf !== null ? Math.round(st.ocr.conf * 10) / 10 : null,
        method: st.barcode ? 'barcode' : (st.ocrApplied ? 'ocr' : 'manual'),
        photo_bytes: st.photo ? st.photo.full.size : null, device_time: new Date().toISOString(),
        // registration time on site, corrected for a wrong phone clock (the server keeps it within the last 30 days)
        captured_at: new Date(SN.now()).toISOString(),
        remarks: remarks.value.trim(), unreadable: unread.checked, confirmed: true
      };
      var uid = u.uuid(), base = 't' + t.id + '/r' + r + 'c' + c + '/' + uid;
      if (correcting) {
        if (S.online === false) { showErr('Corrections need a connection. Try again when there is signal.'); return; }
        setSaving(true, st.photo ? 'Uploading photo…' : 'Saving…');
        var p = Promise.resolve();
        if (st.photo) {
          p = api.upload(base + '.jpg', st.photo.full).then(function () { return api.upload(base + '_t.jpg', st.photo.thumb); })
            .then(function () { data.photo = base + '.jpg'; data.thumb = base + '_t.jpg'; });
        }
        p.then(function () { setSaving(true, 'Saving…'); return api.call('sn_correct', { p_record_id: oldRec.id, p_data: data, p_reason: reasonIn.value.trim() }); })
          .then(function (res) {
            SN.applyTables(res.tables);
            u.toast('Correction saved: ' + res.record.serial, 'ok');
            sheet.mode = 'auto'; st.saving = false; sheet.busy = false;
            SN.loadDetail(t.id, true);
          }, function (e) {
            setSaving(false); showErr(e.message);
            if (e.code === 'STALE') SN.loadDetail(t.id, true);
          });
        return;
      }
      var item = { uid: uid, user_id: S.me.id, table_id: t.id, r: r, c: c, label: t.label, pos: pos, data: data,
        photo: st.photo ? st.photo.full : null, thumb: st.photo ? st.photo.thumb : null,
        photoPath: base + '.jpg', thumbPath: base + '_t.jpg', created: Date.now(), state: 'waiting' };
      setSaving(true, 'Saving…');
      // Saved on this phone first (instant, works without signal), then uploaded in the background.
      api.outbox.available().then(function (ok) {
        if (ok) {
          return api.outbox.add(item).then(function () {
            SN.sync.queued(item);
            saved(serial, S.online === false ? 'offline' : 'queued');
          });
        }
        // this browser cannot keep data on the device (e.g. some private windows): upload directly
        setSaving(true, st.photo ? 'Uploading photo…' : 'Saving…');
        return api.sendRegistration(item).then(function (res) {
          SN.applyTables(res.tables);
          patchDetail(res.record);
          saved(res.record.serial, res.record.status);
        });
      }).catch(function (e) {
        setSaving(false);
        if (api.isOffline(e)) showErr('No connection, and this browser cannot keep registrations on the device (private window?). Open the app in a normal browser window, or try again with signal.');
        else if (e && e.name === 'QuotaExceededError') showErr('The phone storage is full. Free some space (old photos, videos or apps), then save again.');
        else showErr((e && e.message) || 'The registration could not be saved on this phone.');
        if (e.code === 'TAKEN' || e.code === 'TABLE') SN.loadDetail(t.id, true);
      });
    }
    function patchDetail(rec) {
      var K = SN.K;
      if (K.detail && K.detail.table[0] === rec.table_id) {
        K.detail.records = K.detail.records.filter(function (x) { return !(x.r === rec.r && x.c === rec.c); }).concat([rec]);
      }
    }
    function saved(serial, statusCode) {
      st.saving = false; sheet.busy = false;
      var msg = statusCode === 'offline' ? 'Saved on this phone: position ' + pos + ' · ' + serial + ' (uploads when there is signal)'
        : 'Saved position ' + pos + ' · ' + serial + (statusCode === 'needs_review' ? ' — sent to QA/QC review' : '');
      u.toast(msg, statusCode === 'offline' ? 'warn' : 'ok');
      var K = SN.K, recs = new Map();
      ((K.detail && K.detail.table[0] === t.id && K.detail.records) || []).forEach(function (x) { recs.set(x.r + '-' + x.c, x); });
      var q = K.queued.get(t.id) || new Map();
      var order = u.posOrder(cfg()), next = null;
      for (var k = 1; k <= 28; k++) {
        var rc = order[(pos - 1 + k) % 28], key = rc[0] + '-' + rc[1];
        if (!recs.has(key) && !q.has(key) && !(rc[0] === r && rc[1] === c)) { next = rc; break; }
      }
      if (autoNext.checked && next) {
        var useLive = st.usedLive;
        SN.go('#/keyplan/t/' + t.id + '/m/' + next[0] + '-' + next[1]);
        setTimeout(function () {
          var sh = SN.K.sheet;
          if (sh && sh.tableId === t.id) {
            sh.flash = '✓ ' + msg; sh.flashUntil = Date.now() + 5000;
            sh.render();
            if (useLive) { var b = sh.modal.body.querySelector('.cap-btns .btn.primary'); if (b) b.click(); }
          }
        }, 60);
      } else {
        sheet.close(true);
        SN.go('#/keyplan/t/' + t.id);
        if (!next) u.toast('All 28 positions of ' + t.label + ' have a record.', 'ok');
      }
    }
  };
})();
