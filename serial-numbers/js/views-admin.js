/* PV Module Serial Numbers — QA/QC review queues, activity log, administration, help and sync panel */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, el = u.el, api = SN.api, S = SN.state;
  function cfg() { return S.settings.numbering || {}; }

  // ======================================================================
  //  Review
  // ======================================================================
  var R = { tab: 'review', block: '', built: false, seq: 0, audit: { rows: [], before: null, action: '', user: '' } };
  var TABS = [
    { id: 'review', label: 'Needs review' },
    { id: 'pending', label: 'Awaiting verification' },
    { id: 'manual', label: 'Typed manually' },
    { id: 'recent', label: 'Recent registrations' },
    { id: 'log', label: 'Activity log' }
  ];
  function buildReview() {
    var v = u.clear(u.$('#view-review'));
    var tabs = el('div.tabs', { role: 'tablist' });
    TABS.forEach(function (t) {
      if (t.id === 'log' && !SN.can.audit()) return;
      var b = el('button.tab', { type: 'button', role: 'tab', dataset: { tab: t.id } }, t.label, el('span.badge.tcount', { hidden: true }));
      b.addEventListener('click', function () { SN.go('#/review/' + t.id); });
      tabs.appendChild(b);
    });
    var block = el('select#rv-block', { 'aria-label': 'Block' });
    block.appendChild(el('option', { value: '' }, 'All blocks'));
    S.blocks.forEach(function (b) { block.appendChild(el('option', { value: b.name }, 'Block ' + b.name)); });
    block.addEventListener('change', function () { R.block = block.value; loadQueue(); });
    v.appendChild(el('div.page',
      el('div.page-head', el('div', el('h1', 'Review'), el('p.muted', SN.can.review() ? 'Check flagged records, verify registrations and resolve duplicates.' : 'Read-only view of records and activity.')), block),
      tabs, el('div#rv-body')));
    R.built = true;
    if (R.bound) return;
    R.bound = true;
    SN.bus.on('tables', u.debounce(function () { if (R.built && S.view === 'review' && R.tab !== 'log' && S.online !== false) loadQueue(true); }, 2000));
    SN.bus.on('online', function (on) { if (on && R.built && S.view === 'review') showTab(R.tab); });
  }
  function offlineBox(what) {
    return el('div.empty-state', u.icon('wifi', 36), el('h3', 'No signal'),
      el('p', what + ' needs a connection. It loads by itself when the signal is back.'));
  }
  function showTab(tab) {
    R.tab = TABS.some(function (t) { return t.id === tab; }) ? tab : 'review';
    u.$$('#view-review .tab').forEach(function (b) { var on = b.dataset.tab === R.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    if (R.tab === 'log') loadLog(true); else loadQueue();
  }
  function loadQueue(quiet) {
    var body = u.$('#rv-body');
    if (!quiet) u.clear(body).appendChild(el('p.muted', 'Loading…'));
    var my = ++R.seq;
    if (S.online === false) { u.clear(body).appendChild(offlineBox('This list')); return; }
    api.call('sn_queue', { p_kind: R.tab, p_filter: { block: R.block || null }, p_limit: 200 }).then(function (r) {
      if (my !== R.seq) return;
      u.clear(body);
      var cnt = u.$('#view-review .tab[data-tab="' + R.tab + '"] .tcount');
      if (cnt) { cnt.hidden = false; cnt.textContent = r.total; }
      if (R.tab === 'review') setNavCount(r.total);
      if (!r.records.length) { body.appendChild(el('div.empty-state', u.icon('check', 36), el('p', { review: 'Nothing needs review.', pending: 'No records are waiting for verification.', manual: 'No manually typed serial numbers.', recent: 'No registrations yet.' }[R.tab]))); return; }
      if (r.total > r.records.length) body.appendChild(el('p.small.muted', 'Showing ' + r.records.length + ' of ' + u.num(r.total) + '.'));
      var list = el('ul.reclist');
      var lastSerial = null;
      r.records.forEach(function (rec) {
        var grouped = R.tab === 'review' && rec.dups && rec.serial === lastSerial;
        lastSerial = rec.serial;
        list.appendChild(recCard(rec, grouped));
      });
      body.appendChild(list);
    }, function (e) {
      if (my !== R.seq || e.code === 'SESSION') return;
      u.clear(body).appendChild(api.isOffline(e) ? offlineBox('This list') : el('p.warn-text', e.message));
    });
  }
  function setNavCount(n) {
    u.$$('.nav-count').forEach(function (b) { b.hidden = !n; b.textContent = n > 99 ? '99+' : String(n); });
  }
  SN.setReviewCount = setNavCount;
  function recCard(rec, grouped) {
    var thumb = el('span.thumb', u.icon('camera', 20));
    if (rec.thumb || rec.photo) api.photoUrl(rec.thumb || rec.photo).then(function (url) { u.clear(thumb).appendChild(el('img', { src: url, alt: '' })); }, function () {});
    var issues = (rec.issues || []).filter(function (i) { return i !== 'manual' || R.tab === 'manual'; });
    var li = el('li' + (grouped ? '.grouped' : ''), el('button.rec', { type: 'button' },
      thumb,
      el('span.rec-body',
        el('span.rec-top', el('strong.mono', rec.label + ' · P' + u.posNo(rec.r, rec.c, cfg())), SN.recStatusBadge(rec)),
        el('span.mono.rec-serial', rec.serial),
        issues.length ? el('span.rec-issues', issues.map(function (i) { return u.ISSUE[i] || i; }).join(' · ')) : null,
        rec.dups ? el('span.rec-dups', 'Also at ' + rec.dups.map(function (d) { return d.label + ' P' + u.posNo(d.r, d.c, cfg()); }).join(', ')) : null,
        el('span.small.muted', SN.userName(rec.orig_by) + ' · ' + u.fmtDateTime(rec.orig_captured_at) + (rec.review_note ? ' · “' + rec.review_note + '”' : '')))));
    li.querySelector('button').addEventListener('click', function () { SN.openModule(rec.table_id, rec.r, rec.c); });
    return li;
  }

  function loadLog(reset) {
    var body = u.$('#rv-body'), A = R.audit;
    if (reset) { A.rows = []; A.before = null; }
    if (reset) {
      u.clear(body);
      var act = el('select', { 'aria-label': 'Action' });
      [['', 'All actions'], ['register', 'Registered'], ['correct', 'Corrected'], ['void', 'Removed'], ['verify', 'Verified'], ['flag', 'Flagged'],
        ['table_completed', 'Table completed'], ['table_reopened', 'Table reopened'], ['set_installed', 'Installation status'], ['assign', 'Assignment'],
        ['rename', 'Table ID changed'], ['drawing_check', 'Drawing check'], ['settings', 'Settings'], ['user_create', 'User created'],
        ['user_update', 'User changed'], ['password_reset', 'Password reset'], ['login', 'Sign-in']].forEach(function (o) { act.appendChild(el('option', { value: o[0] }, o[1])); });
      act.value = A.action;
      var usr = el('select', { 'aria-label': 'User' });
      usr.appendChild(el('option', { value: '' }, 'All users'));
      Array.from(S.users.values()).forEach(function (x) { usr.appendChild(el('option', { value: x.id }, x.full_name || x.username)); });
      usr.value = A.user;
      act.addEventListener('change', function () { A.action = act.value; loadLog(true); });
      usr.addEventListener('change', function () { A.user = usr.value; loadLog(true); });
      body.appendChild(el('div.filters.card', el('label.f', el('span', 'Action'), act), el('label.f', el('span', 'User'), usr)));
      body.appendChild(el('ul.activity.log#log-list'));
      body.appendChild(el('button.btn.ghost#log-more', { type: 'button', hidden: true, on: { click: function () { loadLog(false); } } }, 'Load older entries'));
    }
    api.call('sn_audit', { p_filter: { action: A.action || null, user_id: A.user ? parseInt(A.user, 10) : null }, p_before: A.before, p_limit: 100 }).then(function (r) {
      var ul = u.$('#log-list');
      r.rows.forEach(function (a) {
        var li = SN.activityItem(a);
        if (a.label) li.appendChild(el('a.small', { href: '#/keyplan/t/' + a.table_id }, a.label));
        if (a.action === 'login') li.querySelector('span:last-child').lastChild.textContent = ' signed in';
        if (a.action === 'settings') li.querySelector('span:last-child').lastChild.textContent = ' changed settings: ' + ((a.details || {}).key || '');
        if (/^user_|password_reset/.test(a.action)) li.querySelector('span:last-child').lastChild.textContent = ' ' + a.action.replace('_', ' ') + ': ' + ((a.details || {}).user || '') + ((a.details || {}).role ? ' (' + u.ROLE[a.details.role] + ')' : '');
        ul.appendChild(li);
        A.before = a.id;
      });
      u.$('#log-more').hidden = r.rows.length < 100;
      if (!ul.children.length) ul.appendChild(el('li.muted', 'No entries.'));
    }, function (e) {
      if (api.isOffline(e)) { var ul = u.$('#log-list'); if (ul && !ul.children.length) ul.parentNode.replaceChild(offlineBox('The activity log'), ul); }
      else u.toast(e.message, 'error');
    });
  }

  SN.views.register('review', {
    show: function (args) { buildReview(); showTab(args[0] || 'review'); },
    reset: function () { R.built = false; }
  });

  // ======================================================================
  //  Admin
  // ======================================================================
  var A = { tab: 'users' };
  var ATABS = [{ id: 'users', label: 'Users' }, { id: 'settings', label: 'Settings' }, { id: 'drawing', label: 'Drawing check' }];
  function buildAdmin(tab) {
    A.tab = ATABS.some(function (t) { return t.id === tab; }) ? tab : 'users';
    var v = u.clear(u.$('#view-admin'));
    var tabs = el('div.tabs', { role: 'tablist' });
    ATABS.forEach(function (t) {
      var b = el('button.tab' + (t.id === A.tab ? '.on' : ''), { type: 'button', role: 'tab', 'aria-selected': String(t.id === A.tab) }, t.label);
      b.addEventListener('click', function () { SN.go('#/admin/' + t.id); });
      tabs.appendChild(b);
    });
    var body = el('div#ad-body');
    v.appendChild(el('div.page', el('div.page-head', el('div', el('h1', 'Administration'), el('p.muted', 'Users, numbering and validation rules, and the drawing check.'))), tabs, body));
    if (A.tab === 'users') usersTab(body);
    else if (A.tab === 'settings') settingsTab(body);
    else drawingTab(body);
  }

  // ---------- users ----------
  function usersTab(body) {
    body.appendChild(el('div.row.between', el('p.muted', 'Each person signs in with their own account. Share the app link, then give each person their username and temporary password privately.'),
      el('button.btn.primary', { type: 'button', on: { click: function () { userDialog(null); } } }, u.icon('plus'), 'Add user')));
    var box = el('div.card', el('p.muted', 'Loading…'));
    body.appendChild(box);
    api.call('sn_admin_users', {}).then(function (rows) {
      u.clear(box);
      var tbl = el('table.data');
      tbl.appendChild(el('thead', el('tr', el('th', 'Name'), el('th', 'Username'), el('th', 'Role'), el('th', 'Status'), el('th', 'Last sign-in'), el('th.num', 'Assigned'), el('th.num', 'Registered'), el('th', ''))));
      var tb = el('tbody');
      rows.forEach(function (x) {
        tb.appendChild(el('tr' + (x.active ? '' : '.inactive'),
          el('td', x.full_name || '—'), el('td.mono', x.username), el('td', u.ROLE[x.role]),
          el('td', !x.active ? el('span.chip', 'Deactivated') : x.must_change ? el('span.chip.warn', 'Temporary password') : x.locked_until && new Date(x.locked_until) > new Date() ? el('span.chip.bad', 'Locked') : el('span.chip.ok', 'Active')),
          el('td.small', x.last_login_at ? u.fmtDateTime(x.last_login_at) : 'never'),
          el('td.num', x.assigned), el('td.num', x.registered),
          el('td', el('button.btn.small', { type: 'button', on: { click: function () { userDialog(x); } } }, 'Edit'))));
      });
      tbl.appendChild(tb);
      box.appendChild(el('div.table-scroll', tbl));
      box.appendChild(el('div.roles', el('h3', 'What each role can do'), el('dl.kv',
        el('dt', 'Administrator'), el('dd', 'Everything: users, installation status, table IDs, numbering, validation rules, corrections.'),
        el('dt', 'Field Encoder'), el('dd', 'Scans barcodes, takes label photos and registers serial numbers on installed tables. Sees assigned tables.'),
        el('dt', 'QA/QC Reviewer'), el('dd', 'Registers too, verifies records, flags problems, corrects or removes registrations with a reason.'),
        el('dt', 'Construction Manager'), el('dd', 'Views the keyplan, dashboard, daily reports, photos and activity log, and exports reports. Cannot change data.'))));
    }, function (e) { u.clear(box).appendChild(api.isOffline(e) ? offlineBox('User management') : el('p.warn-text', e.message)); });
  }
  function userDialog(x) {
    var isNew = !x;
    var uname = el('input.mono', { type: 'text', maxlength: 40, autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. juan.cruz', value: x ? x.username : '', disabled: !isNew, autofocus: isNew });
    var name = el('input', { type: 'text', maxlength: 80, value: x ? x.full_name : '', placeholder: 'Full name' });
    var role = el('select');
    Object.keys(u.ROLE).forEach(function (k) { role.appendChild(el('option', { value: k }, u.ROLE[k])); });
    role.value = x ? x.role : 'encoder';
    var active = el('input', { type: 'checkbox', id: 'u-active', checked: x ? x.active : true });
    var pw = el('input.mono', { type: 'text', value: isNew ? u.tempPassword() : '', readonly: true });
    var msg = el('p.form-error', { hidden: true });
    var body = el('div',
      el('label.field', el('span', 'Username'), uname),
      el('label.field', el('span', 'Full name'), name),
      el('label.field', el('span', 'Role'), role),
      !isNew ? el('label.check', { for: 'u-active' }, active, el('span', 'Account active', el('small.muted', 'Deactivating signs the person out everywhere and blocks sign-in. Their records stay.'))) : null,
      isNew ? el('label.field', el('span', 'Temporary password (they must change it at first sign-in)'), el('div.row', pw,
        el('button.btn.small', { type: 'button', on: { click: function () { pw.value = u.tempPassword(); } } }, 'New'),
        el('button.btn.small', { type: 'button', on: { click: function () { copy(pw.value); } } }, 'Copy'))) : null,
      msg);
    var actions = [{ label: 'Cancel' }];
    if (!isNew) actions.push({ label: 'Reset password', onClick: function (m) { m.close(); resetPassword(x); } });
    actions.push({ label: isNew ? 'Create user' : 'Save', kind: 'primary', onClick: function (m) {
      var payload = isNew ? { username: uname.value.trim().toLowerCase(), full_name: name.value.trim(), role: role.value, password: pw.value }
        : { id: x.id, full_name: name.value.trim(), role: role.value, active: active.checked };
      api.call('sn_admin_save_user', { p_user: payload }).then(function () {
        m.close();
        if (isNew) showCredentials(payload.username, payload.password, payload.full_name);
        else u.toast('User saved.', 'ok');
        SN.poll(true); buildAdmin('users');
      }, function (e) { msg.hidden = false; msg.textContent = e.message; });
      return false;
    } });
    u.openModal({ title: isNew ? 'Add user' : 'Edit ' + (x.full_name || x.username), body: body, actions: actions });
  }
  function resetPassword(x) {
    var pw = u.tempPassword();
    u.confirmBox('Reset password for ' + (x.full_name || x.username) + '?', 'They will be signed out on all devices and must choose a new password at the next sign-in.', 'Reset password').then(function (ok) {
      if (!ok) return;
      api.call('sn_admin_set_password', { p_user_id: x.id, p_password: pw }).then(function () {
        showCredentials(x.username, pw, x.full_name);
        buildAdmin('users');
      }, function (e) { u.toast(e.message, 'error'); });
    });
  }
  function showCredentials(username, pw, name) {
    var link = location.origin + location.pathname;
    var text = 'PV module serial-number app\n' + link + '\nUsername: ' + username + '\nTemporary password: ' + pw + '\nYou will be asked to choose your own password.';
    u.openModal({
      title: 'Sign-in details for ' + (name || username),
      body: el('div', el('p', 'Send these privately (for example in a direct message). The temporary password is shown only now.'),
        el('pre.creds', text)),
      actions: [{ label: 'Copy', onClick: function () { copy(text); return false; } }, { label: 'Done', kind: 'primary' }]
    });
  }
  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { u.toast('Copied.', 'ok'); }, function () { u.toast('Select the text and copy it manually.', 'warn'); });
  }

  // ---------- settings ----------
  function settingsTab(body) {
    var P = S.settings.project || {}, N = cfg(), Vd = S.settings.validation || {};
    // project
    var pname = el('input', { type: 'text', maxlength: 80, value: P.name || '' });
    var psub = el('input', { type: 'text', maxlength: 120, value: P.subtitle || '' });
    body.appendChild(el('section.card',
      el('h2', 'Project'),
      el('label.field', el('span', 'Project name (shown in the header)'), pname),
      el('label.field', el('span', 'Subtitle'), psub),
      el('div.row.end', el('button.btn.primary', { type: 'button', on: { click: function () {
        saveSetting('project', { name: pname.value, subtitle: psub.value });
      } } }, 'Save'))));

    // numbering
    var start = el('select');
    [['TL', 'Top-left'], ['TR', 'Top-right'], ['BL', 'Bottom-left'], ['BR', 'Bottom-right']].forEach(function (o) { start.appendChild(el('option', { value: o[0] }, o[1])); });
    start.value = N.start || 'TL';
    var order = el('select');
    [['rows', 'Along the rows (7 per row)'], ['cols', 'Down the columns (4 per column)']].forEach(function (o) { order.appendChild(el('option', { value: o[0] }, o[1])); });
    order.value = N.order || 'rows';
    var serp = el('input', { type: 'checkbox', id: 'n-serp', checked: !!N.serpentine });
    var conf = el('input', { type: 'checkbox', id: 'n-conf', checked: !!N.confirmed });
    var preview = el('div.mgrid.preview');
    function drawPreview() {
      u.clear(preview);
      var c = { start: start.value, order: order.value, serpentine: serp.checked };
      for (var r = 1; r <= 4; r++) {
        var row = el('div.mrow');
        for (var col = 1; col <= 7; col++) row.appendChild(el('div.mcell.empty', el('span.mno', String(u.posNo(r, col, c)))));
        preview.appendChild(row);
      }
    }
    [start, order, serp].forEach(function (x) { x.addEventListener('change', drawPreview); });
    drawPreview();
    body.appendChild(el('section.card',
      el('h2', 'Module numbering within a table'),
      el('p.muted', 'The grid is always shown as drawn on the keyplan: 4 rows × 7 columns, row 1 is the top edge of the table outline. Each module is stored by its row and column, so changing the numbering never moves a serial number. The default follows the Word reference (1–7 top row, 22–28 bottom row).'),
      el('div.grid2',
        el('div', el('label.field', el('span', 'Position 1 is at the'), start), el('label.field', el('span', 'Count'), order),
          el('label.check', { for: 'n-serp' }, serp, el('span', 'Zig-zag (each row or column reverses direction)')),
          el('label.check', { for: 'n-conf' }, conf, el('span', 'Numbering verified on site', el('small.muted', 'Removes the "not yet verified" note.')))),
        el('div', el('div.grid-cap', el('span', 'Top edge as drawn'), el('span.muted', 'Preview')), preview)),
      el('div.row.end', el('button.btn.primary', { type: 'button', on: { click: function () {
        saveSetting('numbering', { start: start.value, order: order.value, serpentine: serp.checked, confirmed: conf.checked });
      } } }, 'Save numbering'))));

    // validation
    var pat = el('input.mono', { type: 'text', value: Vd.serial_pattern || '' });
    var hint = el('input', { type: 'text', maxlength: 120, value: Vd.serial_hint || '' });
    var bcs = el('input', { type: 'checkbox', id: 'v-bcs', checked: Vd.barcode_is_serial !== false });
    var rph = el('input', { type: 'checkbox', id: 'v-rph', checked: Vd.require_photo !== false });
    var rqa = el('input', { type: 'checkbox', id: 'v-rqa', checked: !!Vd.require_qa_for_completion });
    var ocrc = el('input', { type: 'number', min: 0, max: 100, value: Vd.ocr_min_confidence === undefined ? 70 : Vd.ocr_min_confidence });
    var test = el('input.mono', { type: 'text', placeholder: 'Try a serial number', value: 'H06240702723802' });
    var testOut = el('span.small');
    function runTest() {
      try { var ok = new RegExp(pat.value).test(u.normSerial(test.value)); testOut.textContent = ok ? '✓ accepted' : '✗ would be flagged "unexpected format"'; testOut.className = 'small ' + (ok ? 'ok-text' : 'warn-text'); }
      catch (e) { testOut.textContent = 'Invalid pattern'; testOut.className = 'small bad-text'; }
    }
    [pat, test].forEach(function (x) { x.addEventListener('input', runTest); });
    runTest();
    body.appendChild(el('section.card',
      el('h2', 'Validation rules'),
      el('label.field', el('span', 'Serial-number pattern (regular expression, checked on the upper-case serial)'), pat),
      el('div.row', test, testOut),
      el('label.field', el('span', 'Hint shown to encoders'), hint),
      el('label.check', { for: 'v-bcs' }, bcs, el('span', 'The barcode encodes the serial number', el('small.muted', 'If the typed serial differs from the barcode, the record goes to review. Turn off if the label barcode carries a different code.'))),
      el('label.check', { for: 'v-rph' }, rph, el('span', 'A label photo is required for every registration')),
      el('label.check', { for: 'v-rqa' }, rqa, el('span', 'A table counts as completed only after QA/QC verifies all 28 records', el('small.muted', 'Off: 28 valid, confirmed records complete a table; QA/QC verification is tracked separately.'))),
      el('label.field.narrow', el('span', 'Minimum OCR confidence (%)'), ocrc),
      el('div.row.end', el('button.btn.primary', { type: 'button', on: { click: function () {
        saveSetting('validation', { serial_pattern: pat.value.trim(), serial_hint: hint.value.trim(), barcode_is_serial: bcs.checked, require_photo: rph.checked,
          require_qa_for_completion: rqa.checked, ocr_min_confidence: parseInt(ocrc.value || '70', 10) });
      } } }, 'Save rules'))));
    var L = S.settings.layout || {};
    body.appendChild(el('section.card', el('h2', 'Layout source'), el('dl.kv',
      el('dt', 'Master keyplan'), el('dd', L.source_dwg || '—'),
      el('dt', 'Cross-checked with'), el('dd', L.source_pdf || '—'),
      el('dt', 'Module reference'), el('dd', L.module_reference || '—'),
      el('dt', 'Ignored'), el('dd', (L.duplicate_outline_copies_ignored || 0) + ' outlines that were exact duplicate copies in the DWG'),
      el('dt', 'Table size'), el('dd', (L.table_w || '?') + ' m × ' + (L.table_h || '?') + ' m (7 modules across, 4 rows)'))));
  }
  function saveSetting(key, value, ack) {
    if (ack) value.ack = true;
    api.call('sn_admin_settings', { p_key: key, p_value: value }).then(function (r) {
      S.settings = r.settings; SN.bus.emit('settings');
      u.toast('Saved.', 'ok');
      if (key === 'project') { u.$('#proj-name').textContent = r.settings.project.name; u.$('#proj-sub').textContent = r.settings.project.subtitle; }
      if (key === 'validation') SN.poll(true);
    }, function (e) {
      if (e.code === 'ACK') {
        u.confirmBox('Renumber positions?', e.message, 'Renumber').then(function (ok) { if (ok) saveSetting(key, value, true); });
      } else u.toast(e.message, 'error');
    });
  }

  // ---------- drawing check ----------
  function drawingTab(body) {
    var issues = S.list.filter(function (t) { return t.flags && t.flags.length; })
      .sort(function (a, b) { return (a.flags_cleared - b.flags_cleared) || (u.natKey(a.label) < u.natKey(b.label) ? -1 : 1); });
    var open = issues.filter(function (t) { return !t.flags_cleared; }).length;
    body.appendChild(el('div.notice', u.icon('layers'), el('div',
      el('strong', open + ' of ' + issues.length + ' drawing items still to check'),
      el('p.small', 'These come from EXPANSION PV FARM - GEENRAL LAYOUT.dwg (cross-checked with the PDF). Nothing was renamed or invented: tables keep the ID as drawn until you change it here or in the table panel.'))));
    var tbl = el('table.data');
    tbl.appendChild(el('thead', el('tr', el('th', 'Table ID'), el('th', 'Block'), el('th', 'Issue'), el('th', 'Status'), el('th', 'Check'), el('th', ''))));
    var tb = el('tbody');
    issues.forEach(function (t) {
      tb.appendChild(el('tr' + (t.flags_cleared ? '.inactive' : ''),
        el('td.mono', t.label || '(no ID)'), el('td', t.block),
        el('td.small', t.flags.map(function (f) { return u.FLAG[f] || f; }).join('; ')),
        el('td', SN.stateBadge(SN.tableState(t))),
        el('td', t.flags_cleared ? el('span.chip.ok', 'Done') : el('span.chip.warn', 'Open')),
        el('td', el('button.btn.small', { type: 'button', on: { click: function () { SN.K.filters.issues = true; SN.go('#/keyplan/t/' + t.id); } } }, 'Show on keyplan'))));
    });
    tbl.appendChild(tb);
    body.appendChild(el('div.card', el('div.table-scroll', tbl)));
  }

  SN.views.register('admin', {
    show: function (args) { if (!SN.can.admin()) { SN.go('#/keyplan'); return; } buildAdmin(args[0]); }
  });

  // ======================================================================
  //  Help and sync panels
  // ======================================================================
  SN.views.help = function () {
    var sw = function (st) { return el('i.sw', { style: { background: SN.COLORS[st] } }); };
    u.openModal({ title: 'How to use the app', wide: true, body: el('div.help',
      el('h3', 'Register a module'),
      el('ol',
        el('li', 'Find the table: type its ID in the search box or tap it on the keyplan.'),
        el('li', 'Tap the module position in the 4 × 7 grid (or "Register next empty position").'),
        el('li', 'Tap ', el('strong', 'Scan barcode'), ' and hold the phone 15–25 cm from the label. The barcode is read and a frame is kept as the label photo. Use ', el('strong', 'Take label photo'), ' for a sharper photo.'),
        el('li', 'Check the serial number against the label, tick the confirmation and save. The app moves to the next empty position.')),
      el('h3', 'No signal'),
      el('p', 'The app keeps a copy of the project on the phone, so it opens and works without signal: keyplan, table grids, scanning, photos and saving. ' +
        'Registrations are saved on the phone first and upload by themselves when the signal is back (on Android even with the app closed). ' +
        'Positions saved on the phone are shown in yellow until they upload.'),
      el('ul',
        el('li', 'Before going to an area without signal: open the app once with signal and check "Connection and uploads" (top right) shows everything ready.'),
        el('li', 'Add the app to the home screen (browser menu › Add to Home screen) and stay signed in.'),
        el('li', 'Do not clear the browser data or sign out while registrations are waiting to upload.'),
        el('li', 'Reviews, corrections, exports and administration need a connection.')),
      el('h3', 'Keyplan colours'),
      el('ul.stlist',
        el('li', sw('not_installed'), el('span', 'Gray — Not installed: wait until the administrator marks it installed')),
        el('li', sw('ready'), el('span', 'Blue — Installed, ready for scanning')),
        el('li', sw('in_progress'), el('span', 'Orange — In progress: some modules registered')),
        el('li', sw('completed'), el('span', 'Green — Completed: all 28 modules valid')),
        el('li', sw('needs_review'), el('span', 'Red, striped — Needs review: duplicate or questionable record'))),
      el('p.small.muted', 'Tap a colour in the legend to show only those tables.'),
      el('h3', 'Duplicates and corrections'),
      el('p', 'A serial number already registered elsewhere is never overwritten: both records are marked Needs review. QA/QC corrects or removes the wrong one; every change keeps the old record, photo and reason in the history.')) });
  };
  // ---------- "Connection and uploads": readiness for no signal + registrations waiting on this phone ----------
  var syncPanel = null;
  function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function check(state, title, detail, extra) {
    var ic = state === 'ok' ? 'check' : state === 'busy' ? 'refresh' : state === 'bad' ? 'alert' : 'clock';
    return el('li.ready-' + state, el('span.ready-ic', u.icon(ic, 16)), el('div', el('strong', title), detail ? el('div.small.muted', detail) : null, extra || null));
  }
  SN.views.syncPanel = function () {
    if (syncPanel) { syncPanel.refresh(); return syncPanel.modal; }
    var body = el('div.syncp');
    var m = u.openModal({ title: 'Connection and uploads', body: body, onClose: function () { syncPanel = null; } });
    var seq = 0;
    function refresh() {
      var my = ++seq;
      Promise.all([SN.sync.status(), api.outbox.list()]).then(function (a) {
        if (my !== seq || !syncPanel) return;
        render(a[0], a[1]);
      });
    }
    syncPanel = { modal: m, refresh: refresh };
    function render(st, all) {
      var items = all.filter(function (i) { return S.me && i.user_id === S.me.id; }), others = all.length - items.length;
      u.clear(body);
      // connection
      var on = S.online !== false;
      body.appendChild(el('div.conn-line.' + (S.online === false ? 'off' : S.online ? 'on' : 'wait'),
        el('span.sync-dot'), el('div',
          el('strong', S.online === false ? 'No signal' : S.online ? 'Connected' : 'Connecting…'),
          el('div.small.muted', (S.lastSync ? 'Last update from the server ' + u.ago(S.lastSync) : 'No update from the server yet') +
            (S.online === false && S.lastContact ? ' · last contact ' + u.fmtDateTime(S.lastContact) : '')))));

      // readiness for working without signal
      var ul = el('ul.ready');
      if (!st.swSupported) ul.appendChild(check('bad', 'App files', 'This browser cannot keep the app for offline use. Use Chrome (Android) or Safari (iPhone).'));
      else if (st.shellReady) ul.appendChild(check('ok', 'App saved on this phone', 'Opens without signal' + (st.worker && st.worker.version ? ' · version ' + st.worker.version : '')));
      else if (st.controlled || st.worker) ul.appendChild(check('busy', 'Saving the app on this phone…', 'Keep the app open with signal for a moment.'));
      else ul.appendChild(check('wait', 'App not saved on this phone yet', 'Reload the app once with signal; it saves itself.'));
      ul.appendChild(check(S.lastSync ? 'ok' : 'wait', 'Keyplan and table status', S.lastSync ? 'Updated ' + u.fmtDateTime(S.lastSync) : 'Not downloaded yet'));
      var rec = st.rec;
      if (st.noRecordSync) ul.appendChild(check('bad', 'Module records on this phone', 'Not available: the administrator needs to run database update 2 in Supabase. Until then the grids need a connection.'));
      else if (rec && rec.complete) ul.appendChild(check(st.recRunning ? 'busy' : 'ok', 'Module records on this phone', u.num(st.recCount) + ' current records · updated ' + u.fmtDateTime(rec.at)));
      else if (rec && rec.count) ul.appendChild(check('busy', 'Downloading module records…', u.num(rec.count) + (rec.total ? ' of ' + u.num(rec.total) : '') + ' so far. Keep the app open with signal.'));
      else ul.appendChild(check(st.recRunning ? 'busy' : 'wait', 'Module records on this phone', st.recError ? 'Last try: ' + st.recError : 'Download starts with signal.'));
      if (SN.can.register()) {
        var ocrBtn = !st.ocrReady && st.swSupported ? el('button.btn.small', { type: 'button', disabled: !on, on: { click: function () {
          ocrBtn.disabled = true; ocrBtn.textContent = 'Downloading…';
          SN.sync.warmOcr(true).then(function (r) { if (r && !r.ok) u.toast('OCR download failed: ' + r.error, 'error'); refresh(); });
        } } }, 'Download now (about 6 MB)') : null;
        ul.appendChild(check(st.ocrReady ? 'ok' : 'wait', 'Reading label text (OCR) without signal',
          st.ocrReady ? 'On this phone' : 'Not on this phone yet. Barcode scanning works offline anyway.', ocrBtn));
        ul.appendChild(check(st.bgSync ? 'ok' : 'wait', 'Uploading in the background',
          st.bgSync ? 'Uploads continue when the signal is back, even with the app closed.' : 'This browser uploads only while the app is open: open the app when you have signal again.'));
      }
      if (SN.sync.standalone()) ul.appendChild(check('ok', 'Installed on this phone', 'Opens from the home screen like an app.'));
      else if (SN.sync.canInstall()) {
        var instBtn = el('button.btn.small.primary', { type: 'button', on: { click: function () { SN.sync.install().then(function () { refresh(); }); } } }, 'Install the app');
        ul.appendChild(check('wait', 'Install on the home screen (recommended)', 'It then opens like an app, also without signal, and the phone keeps its data.', instBtn));
      } else {
        ul.appendChild(check('wait', 'Add to the home screen (recommended)', SN.sync.isIOS()
          ? 'In Safari: Share button › "Add to Home Screen". Then open the app from that icon.'
          : 'Browser menu (⋮) › "Add to Home screen" or "Install app". Then open the app from that icon.'));
      }
      if (st.usage) {
        ul.appendChild(check(st.persisted ? 'ok' : 'wait', 'Storage on this phone', mb(st.usage) + ' used' +
          (st.persisted ? ' · protected from automatic clean-up' : ' · installing the app on the home screen protects it from clean-up')));
      }
      body.appendChild(el('h3', 'Ready to work without signal'));
      body.appendChild(ul);

      // waiting registrations
      body.appendChild(el('h3', 'Saved on this phone, not uploaded (' + items.length + ')'));
      if (!items.length) body.appendChild(el('p.muted', 'Nothing waiting. Every registration from this phone has reached the server.'));
      else {
        var list = el('ul.reclist');
        items.forEach(function (it) {
          var err = it.state === 'error', th = el('span.thumb', u.icon('camera', 20));
          if (it.thumb || it.photo) {
            var url = URL.createObjectURL(it.thumb || it.photo), img = el('img', { src: url, alt: '' });
            img.addEventListener('load', function () { setTimeout(function () { URL.revokeObjectURL(url); }, 1000); });
            u.clear(th).appendChild(img);
          }
          var acts = el('span.rec-acts',
            el('button.btn.small', { type: 'button', on: { click: function () { m.close(); SN.go('#/keyplan/t/' + it.table_id + '/m/' + it.r + '-' + it.c); } } }, 'Open'),
            err ? el('button.btn.small', { type: 'button', disabled: !on, on: { click: function () { SN.retryItem(it).then(refresh); } } }, 'Upload again') : null,
            el('button.btn.small.danger', { type: 'button', on: { click: function () { SN.discardItem(it).then(function () { refresh(); }); } } }, 'Discard'));
          list.appendChild(el('li', el('div.rec', th, el('span.rec-body',
            el('span.rec-top', el('strong.mono', it.label + ' · P' + it.pos), el('span.rbadge.' + (err ? 'review' : 'queued'), err ? 'Refused' : S.sending === it.uid ? 'Uploading' : 'Waiting')),
            el('span.mono', it.data.serial),
            err ? el('span.rec-issues', it.error) : it.lastError ? el('span.small.muted', 'Last try: ' + it.lastError) : null,
            err ? el('span.small.muted', SN.itemExplain(it)) : null,
            el('span.small.muted', 'Saved ' + u.fmtDateTime(it.data.captured_at || it.created)), acts))));
        });
        body.appendChild(list);
      }
      if (others) body.appendChild(el('p.small.muted', others + ' registration' + (others === 1 ? '' : 's') + ' saved by another account on this phone. They upload when that person signs in here again.'));
      body.appendChild(el('div.row', el('button.btn.primary', { type: 'button', disabled: !on, on: { click: function () {
        SN.sync.flush({ retryErrors: true }).then(refresh, refresh);
        SN.poll(true); SN.sync.syncRecords();
      } } }, u.icon('refresh'), 'Sync now'), on ? null : el('span.small.muted', 'Starts by itself when the signal is back.')));
      body.appendChild(el('details.more', el('summary', 'Before going to an area without signal'), el('ol.small',
        el('li', 'Open the app with signal and wait until the list above shows everything ready (green ticks).'),
        el('li', 'Add the app to the home screen: browser menu › "Add to Home screen" (Android) or Share › "Add to Home Screen" (iPhone).'),
        el('li', 'Stay signed in. Without signal the app opens from the phone; registrations are saved on the phone.'),
        el('li', 'Back in signal, uploads start by themselves. Open the app if this list still shows waiting items.'),
        el('li', 'Never clear the browser data while registrations are waiting.'))));
    }
    refresh();
    return m;
  };
  ['outbox-list', 'records-sync', 'online', 'uploaded', 'installable'].forEach(function (ev) {
    SN.bus.on(ev, u.debounce(function () { if (syncPanel) syncPanel.refresh(); }, 250));
  });
})();
