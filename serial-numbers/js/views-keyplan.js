/* PV Module Serial Numbers — keyplan view, table panel and the module sheet (register / review / correct) */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u, el = u.el, api = SN.api, S = SN.state, core0 = window.PVSN_SYNC;
  var V = (SN.views = SN.views || {});
  V.list = V.list || {};
  V.register = function (name, obj) { V.list[name] = obj; };
  V.init = function () { Object.keys(V.list).forEach(function (k) { if (V.list[k].init) V.list[k].init(); }); };
  V.show = function (view, args) {
    Object.keys(V.list).forEach(function (k) { if (k !== view && V.list[k].hide) V.list[k].hide(); });
    var v = V.list[view]; if (v && v.show) v.show(args || []);
  };
  V.reset = function () { Object.keys(V.list).forEach(function (k) { if (V.list[k].reset) V.list[k].reset(); }); };

  var K = {
    kp: null, built: false, filters: { block: '', states: new Set(), mine: false, issues: false },
    selectMode: false, sel: new Set(), table: null, detail: null, loading: null, queued: new Map(), sheet: null
  };
  SN.K = K;

  function cfg() { return S.settings.numbering || {}; }
  function recMap(d) {
    var m = new Map();
    ((d && d.records) || []).forEach(function (r) { m.set(r.r + '-' + r.c, r); });
    return m;
  }
  function stateBadge(st) {
    return el('span.badge.st-' + st, el('i.dot', { style: { background: SN.COLORS[st] === 'none' ? 'transparent' : SN.COLORS[st] } }), u.STATE[st] || st);
  }
  SN.stateBadge = stateBadge;
  function recStatusBadge(rec) {
    var map = { pending: ['ok', 'Registered'], verified: ['verified', 'Verified by QA/QC'], needs_review: ['review', 'Needs review'], ended: ['ended', 'Replaced'] };
    var m = map[rec.status] || ['ok', rec.status];
    return el('span.rbadge.' + m[0], m[1]);
  }
  SN.recStatusBadge = recStatusBadge;

  // ======================================================================
  //  Keyplan view
  // ======================================================================
  function build() {
    if (K.built) return;
    K.built = true;
    var view = u.$('#view-keyplan');
    var canvas = el('canvas#kp-canvas', { tabindex: '0', 'aria-label': 'Keyplan of the PV farm. Use the search box to find a table, or the filters to show one status.' });
    var search = el('input#kp-search', { type: 'search', placeholder: 'Find table ID (e.g. M01-17-014)', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': 'Find a table by ID' });
    var sugg = el('ul.suggest', { role: 'listbox', hidden: true });
    var filterBtn = el('button.btn.chip-btn#kp-filter-btn', { type: 'button', 'aria-expanded': 'false' }, u.icon('layers'), el('span', 'Filters'), el('span.badge.count#kp-filter-count', { hidden: true }));
    var selBtn = SN.can.admin() ? el('button.btn.chip-btn#kp-select-btn', { type: 'button', 'aria-pressed': 'false' }, u.icon('select'), el('span', 'Select tables')) : null;
    var top = el('div.kp-top',
      el('div.search-box', u.icon('search'), search, sugg),
      filterBtn, selBtn);
    var filters = el('div.kp-filters.card#kp-filters', { hidden: true });
    var legend = el('div.kp-legend#kp-legend', { role: 'group', 'aria-label': 'Table status legend. Select a status to show only those tables.' });
    var zoom = el('div.kp-zoom',
      el('button.icon-btn', { type: 'button', 'aria-label': 'Zoom in', on: { click: function () { K.kp.zoom(1.6); } } }, u.icon('plus', 20)),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Zoom out', on: { click: function () { K.kp.zoom(1 / 1.6); } } }, u.icon('minus', 20)),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Show the whole farm', on: { click: function () { K.kp.fit(true); } } }, u.icon('fit', 20)));
    var tip = el('div.kp-tip#kp-tip', { hidden: true, role: 'tooltip' });
    var selbar = el('div.kp-selbar.card#kp-selbar', { hidden: true });
    var panel = el('aside.panel#table-panel', { hidden: true, 'aria-label': 'Table details' });
    view.appendChild(canvas); view.appendChild(top); view.appendChild(filters); view.appendChild(legend);
    view.appendChild(zoom); view.appendChild(tip); view.appendChild(selbar); view.appendChild(panel);

    var L = S.settings.layout || { table_w: 16.808, table_h: 5.272 };
    K.kp = SN.Keyplan(canvas, {
      tw: +L.table_w || 16.808, th: +L.table_h || 5.272,
      background: function () { return document.documentElement.classList.contains('dark') ? '#0f171e' : '#eef2f5'; },
      colorFor: function (t) { return SN.COLORS[SN.tableState(t)] || '#cccccc'; },
      hatch: function (t) { return SN.tableState(t) === 'needs_review'; },
      isHidden: function (t) { return !t.confirmed && !K.filters.issues; },
      isDim: isDim,
      markerFor: function (t) {
        if (!t.confirmed) return '#7b2cbf';
        if (!t.label) return '#c62828';
        if (K.filters.issues && SN.issues(t).length) return '#c62828';
        return null;
      },
      isMarked: function (t) { return K.selectMode && K.sel.has(t.id); },
      markColor: '#7b2cbf',
      subLabel: function (t) {
        var q = K.queued.get(t.id), nq = q ? q.size : 0;
        return SN.inScope(t) ? t.n_ok + ' / 28' + (nq ? ' (+' + nq + ')' : '') : (u.STATE[SN.tableState(t)] || '');
      },
      blocks: function () { return S.blocks; },
      boxSelect: function () { return K.selectMode ? 'shift' : null; },
      onBoxSelect: function (list) {
        list.forEach(function (t) { K.sel.add(t.id); });
        renderSelbar(); K.kp.invalidate();
      },
      onTap: function (t) {
        if (K.selectMode) {
          if (!t) return;
          if (K.sel.has(t.id)) K.sel.delete(t.id); else K.sel.add(t.id);
          renderSelbar(); K.kp.invalidate(); return;
        }
        if (t) SN.go('#/keyplan/t/' + t.id);
        else if (K.table) SN.go('#/keyplan');
      },
      onHover: function (t, x, y) {
        if (!t) { tip.hidden = true; return; }
        u.clear(tip);
        var st = SN.tableState(t);
        tip.appendChild(el('strong.mono', t.label || 'No table ID'));
        tip.appendChild(el('span', u.STATE[st] + (SN.inScope(t) ? ' · ' + t.n_ok + '/28 valid' : '')));
        tip.hidden = false;
        var r = canvas.getBoundingClientRect();
        tip.style.left = Math.min(x + 14, r.width - 190) + 'px';
        tip.style.top = Math.max(y - 44, 8) + 'px';
      },
      focusOffset: function () {
        var p = u.$('#table-panel');
        if (!p || p.hidden) return { x: 0, y: 0 };
        if (window.innerWidth >= 960) return { x: -p.offsetWidth / 2, y: 0 };
        return { x: 0, y: -Math.min(p.offsetHeight, window.innerHeight * 0.55) / 2 };
      },
      onView: function (v) { try { sessionStorage.setItem('pvsn.view', JSON.stringify(v)); } catch (e) { /* ignore */ } }
    });
    K.kp.setTables(S.list);
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('pvsn.view')); } catch (e) { saved = null; }
    setTimeout(function () { if (saved) K.kp.setView(saved); else K.kp.fit(false); }, 0);

    // search
    var active = -1, results = [];
    function renderSugg() {
      u.clear(sugg);
      results = SN.findTables(search.value, 8);
      sugg.hidden = !results.length || !search.value.trim();
      results.forEach(function (t, i) {
        var st = SN.tableState(t);
        var li = el('li', { role: 'option', 'aria-selected': i === active ? 'true' : 'false', class: i === active ? 'active' : '' },
          el('i.dot', { style: { background: SN.COLORS[st] === 'none' ? '#fff' : SN.COLORS[st] } }),
          el('span.mono', t.label || 'No ID (' + t.handle + ')'), el('span.muted', u.STATE[st]));
        li.addEventListener('mousedown', function (e) { e.preventDefault(); pick(t); });
        sugg.appendChild(li);
      });
    }
    function pick(t) {
      search.value = t.label || '';
      sugg.hidden = true; active = -1; search.blur();
      if (!t.confirmed) { K.filters.issues = true; renderFilters(); K.kp.invalidate(); }
      SN.go('#/keyplan/t/' + t.id);
    }
    search.addEventListener('input', function () { active = -1; renderSugg(); });
    search.addEventListener('focus', renderSugg);
    search.addEventListener('blur', function () { setTimeout(function () { sugg.hidden = true; }, 150); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); renderSugg(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); renderSugg(); e.preventDefault(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        var t = results[active >= 0 ? active : 0];
        if (t) pick(t); else u.toast('No table found for "' + search.value + '".', 'warn');
      } else if (e.key === 'Escape') { sugg.hidden = true; }
    });

    filterBtn.addEventListener('click', function () {
      filters.hidden = !filters.hidden;
      filterBtn.setAttribute('aria-expanded', String(!filters.hidden));
      if (!filters.hidden) renderFilters();
    });
    if (selBtn) selBtn.addEventListener('click', function () { setSelectMode(!K.selectMode); });
    renderLegend();
    bindEvents();
  }

  var eventsBound = false;
  function bindEvents() {
    if (eventsBound) return;
    eventsBound = true;
    SN.bus.on('tables', function (changed) {
      if (!K.built) return;
      if (changed.length > 50) K.kp.setTables(S.list); else K.kp.invalidate();
      renderLegend();
      if (K.table) {
        var t = S.tables.get(K.table.id);
        var stale = changed.some(function (c) { return c.id === K.table.id; }) &&
          (!K.detail || K.detail.table[20] !== (t && t.updated));
        K.table = t;
        if (stale) loadDetail(K.table.id, true); else renderPanel();
      }
    });
    SN.bus.on('settings', function () { if (K.built) renderPanel(); });
    SN.bus.on('detail-stale', function (tid) { if (K.built && K.table && K.table.id === tid) loadDetail(tid, true); });
    SN.bus.on('outbox-list', function (items) {
      K.queued = new Map();
      items.forEach(function (it) {
        if (!K.queued.has(it.table_id)) K.queued.set(it.table_id, new Map());
        K.queued.get(it.table_id).set(it.r + '-' + it.c, it);
      });
      if (!K.built) return;
      renderPanel();
      if (K.sheet && K.sheet.refresh) K.sheet.refresh();
      K.kp.invalidate();
    });
    // the offline copy of the records changed (first download, or other people's registrations)
    SN.bus.on('records', function (tids) {
      if (K.built && K.table && tids.has(K.table.id) && (!K.detail || K.detail.local)) loadDetail(K.table.id, true);
    });
    // a registration saved on this phone reached the server
    SN.bus.on('uploaded', function (m) {
      var rec = m.res && m.res.record;
      if (!K.built || !rec || !K.detail || K.detail.table[0] !== rec.table_id) return;
      K.detail.records = K.detail.records.filter(function (x) { return !(x.r === rec.r && x.c === rec.c); }).concat([rec]);
      renderPanel();
      if (K.sheet && K.sheet.refresh) K.sheet.refresh();
    });
    SN.bus.on('online', function (on) {
      if (!K.built) return;
      if (on && K.table) loadDetail(K.table.id, true);
      else renderPanel();
      if (K.sheet && K.sheet.refresh) K.sheet.refresh();
    });
  }

  function isDim(t) {
    var f = K.filters;
    if (f.block && t.block !== f.block) return true;
    if (f.states.size && !f.states.has(SN.tableState(t))) return true;
    if (f.mine && t.assigned_to !== S.me.id) return true;
    return false;
  }

  function renderLegend() {
    var lg = u.$('#kp-legend'); if (!lg) return;
    var counts = {};
    S.list.forEach(function (t) {
      if (!t.confirmed) return;
      if (K.filters.block && t.block !== K.filters.block) return;
      var st = SN.tableState(t); counts[st] = (counts[st] || 0) + 1;
    });
    u.clear(lg);
    ['not_installed', 'ready', 'in_progress', 'completed', 'needs_review', 'excluded', 'no_id'].forEach(function (st) {
      if (!counts[st] && (st === 'excluded' || st === 'no_id')) return;
      var on = K.filters.states.has(st);
      var b = el('button.legend-item' + (on ? '.on' : ''), { type: 'button', 'aria-pressed': on ? 'true' : 'false',
        title: on ? 'Show all statuses' : 'Show only: ' + u.STATE[st] },
        el('i.sw.st-' + st, { style: { background: SN.COLORS[st] } }), el('span.lg-name', u.STATE[st]), el('b', u.num(counts[st] || 0)));
      b.addEventListener('click', function () {
        if (K.filters.states.has(st)) K.filters.states.delete(st); else K.filters.states.add(st);
        renderLegend(); renderFilters(); K.kp.invalidate();
      });
      lg.appendChild(b);
    });
  }

  function renderFilters() {
    var f = u.$('#kp-filters'), F = K.filters;
    var n = (F.block ? 1 : 0) + F.states.size + (F.mine ? 1 : 0) + (F.issues ? 1 : 0);
    var cnt = u.$('#kp-filter-count'); cnt.hidden = !n; cnt.textContent = n;
    if (f.hidden) return;
    u.clear(f);
    var blocks = el('div.seg', { role: 'group', 'aria-label': 'Block' });
    [''].concat(S.blocks.map(function (b) { return b.name; })).forEach(function (b) {
      var btn = el('button' + (F.block === b ? '.on' : ''), { type: 'button', 'aria-pressed': F.block === b ? 'true' : 'false' }, b || 'All blocks');
      btn.addEventListener('click', function () {
        F.block = b; renderFilters(); renderLegend(); K.kp.invalidate();
        if (b) { var bl = S.list.filter(function (t) { return t.block === b && t.confirmed; }); var bb = bl.reduce(function (a, t) { return { x0: Math.min(a.x0, t.x), x1: Math.max(a.x1, t.x), y0: Math.min(a.y0, t.y), y1: Math.max(a.y1, t.y) }; }, { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 }); K.kp.focusTable({ x: (bb.x0 + bb.x1) / 2, y: (bb.y0 + bb.y1) / 2 }, Math.min(K.kp.size().w / (bb.x1 - bb.x0 + 60), K.kp.size().h / (bb.y1 - bb.y0 + 40))); }
      });
      blocks.appendChild(btn);
    });
    f.appendChild(el('div.fgroup', el('div.flabel', 'Block'), blocks));
    var states = el('div.chips');
    ['not_installed', 'ready', 'in_progress', 'completed', 'needs_review'].forEach(function (st) {
      var on = F.states.has(st);
      var c = el('button.fchip' + (on ? '.on' : ''), { type: 'button', 'aria-pressed': on ? 'true' : 'false' }, el('i.dot', { style: { background: SN.COLORS[st] } }), u.STATE[st]);
      c.addEventListener('click', function () { if (on) F.states.delete(st); else F.states.add(st); renderFilters(); renderLegend(); K.kp.invalidate(); });
      states.appendChild(c);
    });
    f.appendChild(el('div.fgroup', el('div.flabel', 'Show only'), states));
    var toggles = el('div.fgroup');
    function tog(key, label, hint) {
      var id = 'f-' + key;
      var cb = el('input', { type: 'checkbox', id: id, checked: !!F[key] });
      cb.addEventListener('change', function () { F[key] = cb.checked; renderFilters(); renderLegend(); K.kp.invalidate(); });
      toggles.appendChild(el('label.check', { for: id }, cb, el('span', label, hint ? el('small.muted', hint) : null)));
    }
    if (S.me.role === 'encoder' || S.list.some(function (t) { return t.assigned_to === S.me.id; })) tog('mine', 'Only tables assigned to me');
    tog('issues', 'Show drawing issues', 'Outlines without ID, duplicate IDs and IDs drawn without a table (dashed)');
    f.appendChild(toggles);
    f.appendChild(el('div.row.end', el('button.btn.small', { type: 'button', on: { click: function () {
      F.block = ''; F.states.clear(); F.mine = false; F.issues = false; renderFilters(); renderLegend(); K.kp.invalidate();
    } } }, 'Clear filters'), el('button.btn.small.primary', { type: 'button', on: { click: function () { f.hidden = true; u.$('#kp-filter-btn').setAttribute('aria-expanded', 'false'); } } }, 'Done')));
  }

  // ---------- admin multi-select ----------
  function setSelectMode(on) {
    K.selectMode = on;
    var b = u.$('#kp-select-btn');
    if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.querySelector('span').textContent = on ? 'Selecting…' : 'Select tables'; }
    if (on) { if (K.table) SN.go('#/keyplan'); } else { K.sel.clear(); }
    renderSelbar(); K.kp.invalidate();
  }
  function renderSelbar() {
    var bar = u.$('#kp-selbar');
    if (!K.selectMode) { bar.hidden = true; return; }
    bar.hidden = false; u.clear(bar);
    var ids = Array.from(K.sel);
    bar.appendChild(el('div.selinfo', el('strong', ids.length + ' selected'),
      el('small.muted', window.matchMedia('(pointer: fine)').matches ? 'Click tables to add or remove them. Shift-drag to select an area.' : 'Tap tables to add or remove them.')));
    function act(label, set, kind) {
      var b = el('button.btn.small' + (kind ? '.' + kind : ''), { type: 'button', disabled: !ids.length }, label);
      b.addEventListener('click', function () { bulk(ids, set, label); });
      return b;
    }
    bar.appendChild(el('div.selacts',
      act('Mark installed', { installed: true }, 'primary'), act('Mark not installed', { installed: false }),
      el('button.btn.small', { type: 'button', disabled: !ids.length, on: { click: function () { assignDialog(ids); } } }, 'Assign to…'),
      act('Exclude from scope', { in_scope: false }), act('Include in scope', { in_scope: true }),
      el('button.btn.small.ghost', { type: 'button', disabled: !ids.length, on: { click: function () { K.sel.clear(); renderSelbar(); K.kp.invalidate(); } } }, 'Clear'),
      el('button.btn.small.ghost', { type: 'button', on: { click: function () { setSelectMode(false); } } }, 'Done')));
  }
  function bulk(ids, set, label) {
    var labels = ids.slice(0, 6).map(function (id) { var t = S.tables.get(id); return t && (t.label || 'no ID'); }).join(', ') + (ids.length > 6 ? ' and ' + (ids.length - 6) + ' more' : '');
    u.confirmBox(label + '?', label + ' for ' + ids.length + ' table' + (ids.length > 1 ? 's' : '') + ': ' + labels + '.', label).then(function (ok) {
      if (!ok) return;
      api.call('sn_admin_tables', { p_ids: ids, p_set: set }).then(function (r) {
        SN.applyTables(r.tables);
        u.toast(r.changed + ' change' + (r.changed === 1 ? '' : 's') + ' saved.', 'ok');
        K.sel.clear(); renderSelbar(); K.kp.invalidate();
      }, function (e) { u.toast(e.message, 'error'); });
    });
  }
  function assignDialog(ids) {
    var sel = el('select');
    sel.appendChild(el('option', { value: '' }, '— Not assigned —'));
    Array.from(S.users.values()).filter(function (x) { return x.active && x.role !== 'manager'; })
      .sort(function (a, b) { return (a.full_name || a.username) < (b.full_name || b.username) ? -1 : 1; })
      .forEach(function (x) { sel.appendChild(el('option', { value: x.id }, (x.full_name || x.username) + ' · ' + u.ROLE[x.role])); });
    var t0 = ids.length === 1 ? S.tables.get(ids[0]) : null;
    if (t0 && t0.assigned_to) sel.value = t0.assigned_to;
    u.openModal({
      title: 'Assign ' + ids.length + ' table' + (ids.length > 1 ? 's' : ''),
      body: el('div', el('p.muted', 'Encoders see their assigned tables with the "Only tables assigned to me" filter. Anyone allowed to register can still work on other tables.'),
        el('label.field', el('span', 'Assign to'), sel)),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: function () {
        var v = sel.value ? parseInt(sel.value, 10) : null;
        api.call('sn_admin_tables', { p_ids: ids, p_set: { assigned_to: v } }).then(function (r) {
          SN.applyTables(r.tables); u.toast('Assignment saved.', 'ok'); K.sel.clear(); renderSelbar(); K.kp.invalidate();
        }, function (e) { u.toast(e.message, 'error'); });
      } }]
    });
  }

  // ======================================================================
  //  Table panel
  // ======================================================================
  function openTable(id) {
    var t = S.tables.get(id);
    if (!t) { u.toast('That table does not exist.', 'warn'); SN.go('#/keyplan'); return; }
    var same = K.table && K.table.id === id;
    K.table = t;
    var p = u.$('#table-panel');
    var wasHidden = p.hidden;
    p.hidden = false;
    document.body.classList.add('panel-open');
    K.kp.select(t);
    if (!same || !K.detail || K.detail.table[0] !== id) { K.detail = null; renderPanel(); loadDetail(id); }
    else renderPanel();
    if (!same || wasHidden) setTimeout(function () { K.kp.focusTable(t); }, 30);
  }
  function closeTable() {
    K.table = null; K.detail = null;
    var p = u.$('#table-panel'); if (p) p.hidden = true;
    document.body.classList.remove('panel-open');
    if (K.kp) K.kp.select(null);
  }
  // Module records of one table: from the server when there is a connection (with photos and
  // activity), otherwise from the copy on this phone. The phone copy is shown first while the
  // server answers, so the grid appears at once even with a weak signal.
  function loadDetail(id, force) {
    if (!force && K.loading && K.loadingId === id) return K.loading;
    K.loadingId = id;
    function useLocal() {
      return SN.localDetail(id).then(function (d) {
        if (d && (!K.detail || K.detail.table[0] !== id || K.detail.local)) { K.detail = d; afterDetail(id); }
        return d;
      });
    }
    var p;
    if (S.online === false) p = useLocal();
    else {
      if (!K.detail || K.detail.table[0] !== id || K.detail.local) useLocal().catch(function () {});
      p = api.call('sn_table', { p_table_id: id }, { timeout: 20000 }).then(function (d) {
        K.detail = d;
        SN.applyTables([d.table]);
        SN.store.replaceTable(id, d.records);
        afterDetail(id);
        return d;
      }, function (e) {
        if (api.isOffline(e)) return useLocal();
        if (e.code !== 'SESSION') u.toast(e.message, 'error');
        throw e;
      });
    }
    var mine = K.loading = p.then(function (d) { if (K.loading === mine) K.loading = null; return d; },
      function (e) { if (K.loading === mine) K.loading = null; throw e; });
    mine.catch(function () {});
    return mine;
  }
  function afterDetail(id) {
    if (K.table && K.table.id === id) { K.table = S.tables.get(id); renderPanel(); }
    if (K.sheet && K.sheet.tableId === id && K.sheet.refresh) K.sheet.refresh();
  }
  SN.loadDetail = loadDetail;
  function offline() { return S.online === false; }
  function needsNet(btn) {
    if (offline()) { btn.disabled = true; btn.title = 'Needs a connection'; }
    return btn;
  }

  function renderPanel() {
    var p = u.$('#table-panel');
    if (!p || !K.table) return;
    var t = K.table, st = SN.tableState(t), d = (K.detail && K.detail.table[0] === t.id) ? K.detail : null;
    var recs = recMap(d), queued = K.queued.get(t.id) || new Map();
    var scroll = p.querySelector('.panel-scroll');
    var keep = scroll ? scroll.scrollTop : 0;
    u.clear(p);
    p.appendChild(el('div.panel-grip', { 'aria-hidden': 'true' }));
    var head = el('div.panel-head',
      el('div', el('div.kicker', 'Block ' + t.block + (t.source === 'label_only' ? ' · ID without outline' : '')),
        el('h2.panel-tid.mono', t.label || 'No table ID')),
      el('button.icon-btn', { type: 'button', 'aria-label': 'Close table details', on: { click: function () { SN.go('#/keyplan'); } } }, u.icon('x', 22)));
    p.appendChild(head);
    var body = el('div.panel-scroll');
    p.appendChild(body);

    var chips = el('div.chips.tight', stateBadge(st),
      t.installed && st !== 'not_installed' ? el('span.chip', 'Installed') : null,
      !t.in_scope ? el('span.chip.warn', 'Excluded from scope') : null,
      t.assigned_to ? el('span.chip', u.icon('user', 14), SN.userName(t.assigned_to)) : null);
    body.appendChild(chips);
    if (d && d.local) {
      var rs = SN.sync.rs.st, upto = rs && rs.at ? u.fmtDateTime(rs.at) : null;
      body.appendChild(el('p.small.offline-note', u.icon('wifi', 14), el('span',
        offline() ? 'No signal: records from the copy on this phone' : 'Records from the copy on this phone (waiting for the server)',
        upto ? ' (updated ' + upto + ')' : '', '.',
        rs && !rs.complete ? ' The copy is still downloading, so some positions may be missing.' : '')));
    }

    var iss = SN.issues(t);
    if (iss.length || !t.label || !t.confirmed) {
      var box = el('div.notice.warn', u.icon('alert'), el('div',
        el('strong', 'Check against the drawing'),
        el('ul', iss.map(function (f) { return el('li', u.FLAG[f] || f); })),
        t.drawn_label !== t.label ? el('div.muted', 'Drawn as: ' + (t.drawn_label || '(no ID)')) : null,
        SN.can.admin() ? el('div.muted', 'Fix it with the buttons below; the change is recorded in the activity log.') : el('div.muted', 'The administrator will confirm this table.')));
      body.appendChild(box);
    }

    if (SN.inScope(t) || t.n_reg) {
      var remaining = 28 - t.n_ok;
      body.appendChild(el('div.stats',
        stat('Registered', t.n_reg + ' / 28'), stat('Valid', t.n_ok), stat('Needs review', t.n_review, t.n_review ? 'bad' : ''),
        stat('Remaining', remaining), stat('Complete', Math.round(t.n_ok / 28 * 100) + '%')));
      if (queued.size) {
        var nerr = 0; queued.forEach(function (q) { if (q.state === 'error') nerr++; });
        body.appendChild(el('p.small.queued-note', u.icon('upload', 14), el('span',
          queued.size + ' more saved on this phone' + (nerr ? ' (' + nerr + ' refused by the server — open it to see why)' : offline() ? ', will upload when the signal is back' : ', uploading') + '. Not yet counted above.')));
      }
      body.appendChild(el('div.progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '28', 'aria-valuenow': String(t.n_ok), 'aria-label': 'Valid modules' },
        el('span', { style: { width: (t.n_ok / 28 * 100) + '%' } })));
      if (t.first_completed) {
        body.appendChild(el('p.small.muted', t.completed ? 'Completed ' + u.fmtDateTime(t.completed) : 'First completed ' + u.fmtDateTime(t.first_completed) + ' · reopened after a review or correction'));
      }
    } else if (st === 'not_installed') {
      body.appendChild(el('p.muted', 'This table is marked Not installed. Serial numbers can be registered after the administrator marks it installed.'));
    }

    // 4 x 7 grid
    var c = cfg();
    var grid = el('div.mgrid', { role: 'grid', 'aria-label': 'Module positions, 4 rows by 7 columns as drawn' });
    for (var r = 1; r <= 4; r++) {
      var row = el('div.mrow', { role: 'row' });
      for (var col = 1; col <= 7; col++) {
        row.appendChild(cell(t, r, col, recs.get(r + '-' + col), queued.get(r + '-' + col), d, c));
      }
      grid.appendChild(row);
    }
    if (t.confirmed) {
      body.appendChild(el('div.grid-wrap', el('div.grid-cap', el('span', 'Top edge as drawn'), el('span.muted', '4 × 7 = 28 modules')), grid));
      body.appendChild(el('p.small.muted.numnote', 'Numbering: ' + numberingText(c) + (c.confirmed ? '.' : '. Not yet verified on site — the administrator can change it in Admin › Settings.')));
    }

    // actions
    var acts = el('div.panel-actions');
    if (SN.can.register() && SN.inScope(t)) {
      var next = nextEmpty(t, recs, queued, 0);
      if (next) acts.appendChild(el('button.btn.primary.block', { type: 'button', on: { click: function () { SN.go('#/keyplan/t/' + t.id + '/m/' + next[0] + '-' + next[1]); } } },
        u.icon('camera'), 'Register next empty position (' + u.posNo(next[0], next[1], c) + ')'));
    }
    if (SN.can.admin()) {
      var adm = el('div.admin-acts');
      if (offline()) adm.appendChild(el('p.small.muted.fullrow', 'Changing table status needs a connection.'));
      if (!t.confirmed) adm.appendChild(abtn('Confirm this table', function () { adminSet(t, { confirmed: true }, 'Confirm table ' + t.label + '? It becomes a normal table (Not installed) that can be registered once installed.'); }, 'primary'));
      else {
        adm.appendChild(t.installed ? abtn('Mark not installed', function () { adminSet(t, { installed: false }); })
          : abtn('Mark installed', function () { adminSet(t, { installed: true }); }, 'primary'));
        adm.appendChild(abtn(t.label ? 'Change table ID' : 'Enter table ID', function () { renameDialog(t); }));
        adm.appendChild(abtn('Assign…', function () { assignDialog([t.id]); }));
        adm.appendChild(t.in_scope ? abtn('Exclude from scope', function () { adminSet(t, { in_scope: false }, 'Exclude ' + (t.label || 'this table') + ' from serial-number registration? It will not count in progress figures.'); })
          : abtn('Include in scope', function () { adminSet(t, { in_scope: true }); }));
      }
      if (t.flags && t.flags.length) {
        adm.appendChild(t.flags_cleared ? abtn('Reopen drawing check', function () { adminSet(t, { flags_cleared: false }); })
          : abtn('Mark drawing check done', function () {
            u.promptBox('Drawing check done', 'Note (what you verified)', { multiline: true, required: true, min: 3, ok: 'Save' }).then(function (v) {
              if (v) adminSet(t, { flags_cleared: true, reason: v }, null);
            });
          }));
      }
      acts.appendChild(adm);
    }
    body.appendChild(acts);

    // reference details
    body.appendChild(el('details.more',
      el('summary', 'Drawing reference'),
      el('dl.kv',
        el('dt', 'Table ID'), el('dd.mono', t.label || '—'),
        el('dt', 'ID in drawing'), el('dd.mono', t.drawn_label || '(none)'),
        el('dt', 'DWG handle'), el('dd.mono', t.handle),
        el('dt', 'Source'), el('dd', t.source === 'drawing' ? 'Table outline in the DWG' : 'Text label in the DWG (no outline)'),
        el('dt', 'Initial status'), el('dd', 'Green in the layout = installed; blank = not installed'))));

    // activity
    if (d && d.audit && d.audit.length) {
      var ul = el('ul.activity');
      d.audit.slice(0, 12).forEach(function (a) { ul.appendChild(activityItem(a)); });
      body.appendChild(el('details.more', el('summary', 'Recent activity (' + d.audit.length + ')'), ul));
    }
    if (!d) body.appendChild(el('p.small.muted.loading', 'Loading module records…'));
    scroll = body; scroll.scrollTop = keep;
  }
  function abtn(label, fn, kind) { return needsNet(el('button.btn.small' + (kind ? '.' + kind : ''), { type: 'button', on: { click: fn } }, label)); }
  function stat(label, value, kind) { return el('div.stat' + (kind ? '.' + kind : ''), el('b', String(value)), el('span', label)); }
  function numberingText(c) {
    var corner = { TL: 'top-left', TR: 'top-right', BL: 'bottom-left', BR: 'bottom-right' }[c.start || 'TL'];
    return 'position 1 at the ' + corner + ', counting along ' + (c.order === 'cols' ? 'columns' : 'rows') + (c.serpentine ? ' (zig-zag)' : '');
  }
  SN.numberingText = numberingText;
  function nextEmpty(t, recs, queued, afterPos) {
    var order = u.posOrder(cfg());
    for (var k = 0; k < 28; k++) {
      var idx = (afterPos + k) % 28, rc = order[idx];
      var key = rc[0] + '-' + rc[1];
      if (!recs.has(key) && !queued.has(key)) return rc;
    }
    return null;
  }
  function cell(t, r, c, rec, q, d, nb) {
    var pos = u.posNo(r, c, nb), cls = 'empty', icon = null, sn = '', aria;
    if (rec) {
      cls = rec.status === 'verified' ? 'verified' : rec.status === 'needs_review' ? 'review' : 'ok';
      sn = rec.serial.slice(-5);
      icon = rec.status === 'verified' ? u.icon('check', 14) : rec.status === 'needs_review' ? u.icon('alert', 14) : null;
      aria = 'Position ' + pos + ', row ' + r + ' column ' + c + ', serial ' + rec.serial + ', ' + (rec.status === 'needs_review' ? 'needs review' : rec.status === 'verified' ? 'verified' : 'registered');
      if (q) { cls += ' conflict'; icon = u.icon('alert', 14); aria += '. This phone also has a different registration for this position that was not uploaded'; }
    } else if (q) {
      var err = q.state === 'error';
      cls = err ? 'review' : 'queued';
      sn = err ? 'refused' : (S.sending === q.uid ? 'sending' : offline() ? 'saved' : 'waiting');
      icon = u.icon(err ? 'alert' : 'upload', 14);
      aria = 'Position ' + pos + ', serial ' + q.data.serial + (err ? ', saved on this phone but refused by the server' : ', saved on this phone, waiting to upload');
    } else {
      aria = 'Position ' + pos + ', row ' + r + ' column ' + c + ', not registered';
    }
    if (!d && !q) cls += ' loading';
    var b = el('button.mcell.' + cls.split(' ').join('.'), { type: 'button', role: 'gridcell', 'aria-label': aria, title: aria },
      el('span.mno', String(pos)), el('span.msn.mono', sn), icon ? el('span.mic', icon) : null);
    b.addEventListener('click', function () { SN.go('#/keyplan/t/' + t.id + '/m/' + r + '-' + c); });
    return b;
  }
  function activityItem(a) {
    var who = a.user_id ? SN.userName(a.user_id) : 'System';
    var d = a.details || {}, text;
    var pos = d.r ? ' position ' + u.posNo(d.r, d.c, cfg()) : '';
    switch (a.action) {
      case 'register': text = 'registered' + pos + ' (' + d.serial + ')'; break;
      case 'correct': text = 'corrected' + pos + ': ' + d.old_serial + ' → ' + d.serial + (d.reason ? ' — ' + d.reason : ''); break;
      case 'void': text = 'removed the registration at' + pos + ' (' + d.serial + ')' + (d.reason ? ' — ' + d.reason : ''); break;
      case 'verify': text = 'verified' + pos + (d.note ? ' — ' + d.note : ''); break;
      case 'flag': text = 'flagged' + pos + ' for review — ' + (d.note || ''); break;
      case 'set_installed': text = 'set the table to ' + (d.to ? 'Installed' : 'Not installed'); break;
      case 'set_scope': text = d.to ? 'included the table in the scope' : 'excluded the table from the scope'; break;
      case 'set_confirmed': text = d.to ? 'confirmed the table' : 'hid the table'; break;
      case 'assign': text = d.to ? 'assigned the table to ' + SN.userName(d.to) : 'removed the assignment'; break;
      case 'rename': text = 'changed the table ID ' + (d.from || '(none)') + ' → ' + d.to + (d.reason ? ' — ' + d.reason : ''); break;
      case 'drawing_check': text = d.cleared ? 'marked the drawing check done' + (d.note ? ' — ' + d.note : '') : 'reopened the drawing check'; break;
      case 'table_completed': text = 'table completed (all 28 modules valid)'; who = 'System'; break;
      case 'table_reopened': text = 'table no longer complete'; who = 'System'; break;
      default: text = a.action;
    }
    return el('li', el('span.when', u.fmtDateTime(a.at)), el('span', el('strong', who), ' ', text));
  }
  SN.activityItem = activityItem;

  function adminSet(t, set, question) {
    var go = function () {
      api.call('sn_admin_tables', { p_ids: [t.id], p_set: set }).then(function (r) {
        SN.applyTables(r.tables); u.toast('Saved.', 'ok'); loadDetail(t.id, true);
      }, function (e) { u.toast(e.message, 'error'); });
    };
    if (question === null) return go();
    u.confirmBox('Change table ' + (t.label || '(no ID)'), question || 'Save this change?', 'Save').then(function (ok) { if (ok) go(); });
  }
  function renameDialog(t) {
    var idIn = el('input.mono', { type: 'text', value: t.label, maxlength: 40, autocapitalize: 'characters', autocomplete: 'off', autofocus: true });
    var why = el('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Checked on site / per drawing revision B' });
    var msg = el('p.form-error', { hidden: true });
    u.openModal({
      title: t.label ? 'Change table ID' : 'Enter table ID',
      body: el('div', el('p.muted', 'Use the ID painted or tagged on site. The ID from the drawing (' + (t.drawn_label || 'none') + ') stays in the history.'),
        el('label.field', el('span', 'Table ID'), idIn), el('label.field', el('span', 'Reason'), why), msg),
      actions: [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', onClick: function (m) {
        var v = idIn.value.trim().toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(v)) { msg.hidden = false; msg.textContent = 'Use letters, digits and dashes only (for example M01-17-014).'; return false; }
        api.call('sn_admin_tables', { p_ids: [t.id], p_set: { label: v, reason: why.value.trim() } }).then(function (r) {
          SN.applyTables(r.tables); m.close(); u.toast('Table ID saved.', 'ok'); loadDetail(t.id, true);
        }, function (e) { msg.hidden = false; msg.textContent = e.message; });
        return false;
      } }]
    });
  }

  // ======================================================================
  //  Module sheet
  // ======================================================================
  function openModule(tid, r, c) {
    var t = S.tables.get(tid);
    if (!t || !(r >= 1 && r <= 4 && c >= 1 && c <= 7)) { SN.go('#/keyplan/t/' + tid); return; }
    if (K.sheet && K.sheet.tableId === tid && K.sheet.r === r && K.sheet.c === c) return;
    if (K.sheet) K.sheet.close(true);
    var pos = u.posNo(r, c, cfg());
    var modal = u.openModal({ title: (t.label || 'No ID') + ' · Position ' + pos, full: true, className: 'module-sheet',
      onClose: function () {
        if (sheet.cleanup) sheet.cleanup();
        if (K.sheet === sheet) K.sheet = null;
        if (!sheet.silent && /\/m\//.test(location.hash)) SN.go('#/keyplan/t/' + tid);
      } });
    var sheet = { tableId: tid, r: r, c: c, modal: modal, mode: 'auto', silent: false, sig: null };
    sheet.close = function (silent) { sheet.silent = !!silent; modal.close(); };
    function sigOf() {
      var d = K.detail && K.detail.table[0] === tid ? K.detail : null;
      if (!d) return 'loading';
      var rec = recMap(d).get(r + '-' + c), q = (K.queued.get(tid) || new Map()).get(r + '-' + c);
      // the capture form is never redrawn for a change of connection (it would lose the scan in progress)
      return sheet.mode + '|' + (rec ? rec.id + ':' + rec.status + ':' + (rec.reviewed_at || '') + ':' + (d.local ? 'L' : 'S') + ':' + (offline() ? 'off' : 'on') : 'none') +
        '|' + (q ? q.uid + ':' + q.state + ':' + (offline() ? 'off' : 'on') : '');
    }
    sheet.refresh = function () { if (sheet.busy) return; if (sigOf() === sheet.sig) return; render(); };
    K.sheet = sheet;
    function render() {
      if (sheet.cleanup) { sheet.cleanup(); sheet.cleanup = null; }
      sheet.sig = sigOf();
      var d = K.detail && K.detail.table[0] === tid ? K.detail : null;
      var body = u.clear(modal.body);
      var tt = S.tables.get(tid);
      body.appendChild(el('div.mod-meta',
        el('span.mono.modid', (tt.label || 'NO-ID') + '-R' + r + 'C' + c),
        el('span', 'Row ' + r + ' · Column ' + c + ' (as drawn)'),
        el('span', 'Position ' + u.posNo(r, c, cfg()) + ' of 28')));
      if (!d) { body.appendChild(el('p.muted.loading', 'Loading…')); return; }
      var rec = recMap(d).get(r + '-' + c);
      var q = (K.queued.get(tid) || new Map()).get(r + '-' + c);
      if (sheet.mode === 'correct' && rec) return SN.captureForm(sheet, tt, rec);
      if (rec) return recordView(sheet, tt, rec, q);
      if (q) return queuedView(sheet, tt, q);
      if (SN.can.register() && SN.inScope(tt)) return SN.captureForm(sheet, tt, null);
      var why = !SN.can.register() ? 'Your role can view records but not register serial numbers.'
        : !tt.confirmed ? 'This table is not confirmed in the layout yet.'
        : !tt.installed ? 'This table is marked Not installed. The administrator marks tables installed before registration.'
        : !tt.label ? 'This table has no table ID yet. The administrator must enter it first.'
        : 'This table is excluded from serial-number registration.';
      body.appendChild(el('div.empty-state', u.icon('barcode', 40), el('h3', 'Not registered'), el('p', why),
        offline() && SN.can.register() ? el('p.small.muted', 'This status comes from the copy on this phone (updated ' + (S.lastSync ? u.ago(S.lastSync) : 'earlier') + '). If the administrator changed it since, connect once to refresh.') : null));
    }
    sheet.render = render;
    if (!K.detail || K.detail.table[0] !== tid) loadDetail(tid).then(render, function () {});
    render();
  }
  SN.openModule = openModule;

  // the photo saved with a registration that has not reached the server yet
  function localPhoto(q, alt) {
    var blob = q.photo || q.thumb;
    if (!blob) return null;
    var url = URL.createObjectURL(blob), img = el('img', { src: url, alt: alt || 'Label photo saved on this phone' });
    img.addEventListener('load', function () { setTimeout(function () { URL.revokeObjectURL(url); }, 1000); });
    return img;
  }
  function retryItem(q) {
    q.state = 'waiting'; q.error = null; q.code = null;
    return api.outbox.put(q).then(function () { return SN.sync.flush(); }).then(function (r) {
      if (r && r.sent) u.toast('Uploaded.', 'ok');
      else if (r && core0.STOP[r.stopped]) u.toast(r.message || 'No connection. It stays on this phone and uploads later.', 'warn');
    });
  }
  function discardItem(q) {
    return u.confirmBox('Discard ' + q.data.serial + '?', 'The serial number and photo saved on this phone for ' + q.label + ' position ' + q.pos +
      ' will be deleted without uploading.', 'Discard', 'danger').then(function (ok) {
      if (ok) return api.outbox.remove(q.uid).then(function () { SN.updateOutboxBadge(); return true; });
      return false;
    });
  }
  SN.retryItem = retryItem; SN.discardItem = discardItem; SN.itemExplain = function (q) { return itemExplain(q); };
  function itemExplain(q) {
    if (q.code === 'TAKEN') return 'Someone else registered this position before this phone could upload. Compare both with the label on the module: if the other record is right, discard this one; if this one is right, ask QA/QC to correct the other record, then upload again.';
    if (q.code === 'TABLE') return 'The table was changed by the administrator (for example marked not installed or excluded). Ask the administrator, then upload again.';
    if (q.code === 'ROLE') return 'Your role no longer allows registering. Ask the administrator.';
    return 'Fix the cause, then upload again — or discard it.';
  }
  function queuedView(sheet, t, q) {
    var body = sheet.modal.body, err = q.state === 'error';
    var img = localPhoto(q);
    body.appendChild(el('div.rec-head', el('div.photo-box', img || el('span.muted', 'No photo')), el('div.rec-main',
      el('div.kicker', 'Serial number'),
      el('div.serial-big.mono', q.data.serial),
      el('div.chips.tight', el('span.rbadge.' + (err ? 'review' : 'queued'), err ? 'Refused by the server' : 'Saved on this phone')),
      el('div.small.muted', 'Saved ' + u.fmtDateTime(q.data.captured_at || q.created) + ' by you'))));
    body.appendChild(el('div.notice.' + (err ? 'bad' : 'warn'), u.icon(err ? 'alert' : 'upload'), el('div',
      el('strong', err ? 'Not uploaded: the server refused it' : offline() ? 'Waiting for signal' : 'Uploading…'),
      el('p', err ? q.error : offline() ? 'It uploads by itself when the connection is back. Keep this phone signed in; you can close the app.' : 'It uploads in the background.'),
      err ? el('p.small', itemExplain(q)) : null,
      !err && q.lastError ? el('p.small.muted', 'Last try: ' + q.lastError) : null)));
    var row = el('div.row.wrap');
    row.appendChild(needsNet(el('button.btn.primary', { type: 'button', on: { click: function () { retryItem(q).then(function () { sheet.render(); }); } } },
      u.icon('refresh'), err ? 'Upload again' : 'Upload now')));
    row.appendChild(el('button.btn.danger', { type: 'button', on: { click: function () { discardItem(q).then(function (ok) { if (ok) sheet.render(); }); } } }, u.icon('trash'), 'Discard'));
    body.appendChild(row);
    body.appendChild(el('dl.kv',
      el('dt', 'Barcode'), el('dd.mono', q.data.barcode || '—'),
      el('dt', 'Entry'), el('dd', q.data.method === 'barcode' ? 'From barcode' : q.data.method === 'ocr' ? 'From OCR' : 'Typed manually'),
      el('dt', 'Remarks'), el('dd', q.data.remarks || '—')));
  }

  function recordView(sheet, t, rec, q) {
    var body = sheet.modal.body;
    if (q) {
      // this phone also holds a registration for this position that the server did not take
      body.appendChild(el('div.notice.bad', u.icon('alert'), el('div',
        el('strong', 'This phone also has ' + q.data.serial + ' saved for this position'),
        el('p.small', q.state === 'error' ? q.error : 'It was saved on this phone while the position was empty here.'),
        el('p.small', 'Check the label on the module. If the record below is right, discard the one on this phone. If the phone is right, QA/QC corrects the record below, then upload again.'),
        el('div.row.wrap',
          localPhoto(q) ? el('div.photo-box.small', localPhoto(q, 'Photo saved on this phone')) : null,
          el('button.btn.small.danger', { type: 'button', on: { click: function () { discardItem(q).then(function (ok) { if (ok) sheet.render(); }); } } }, 'Discard the phone copy'),
          needsNet(el('button.btn.small', { type: 'button', on: { click: function () { retryItem(q).then(function () { sheet.render(); }); } } }, 'Upload again'))))));
    }
    var photoBox = el('button.photo-box', { type: 'button', 'aria-label': 'Open the label photo' },
      el('span.muted', rec.local ? (rec.has_photo ? 'Photo can be viewed with signal' : 'No photo') : rec.photo ? 'Loading photo…' : 'No photo'));
    if (rec.thumb || rec.photo) {
      api.photoUrl(rec.photo || rec.thumb).then(function (url) {
        u.clear(photoBox).appendChild(el('img', { src: url, alt: 'Label photo of ' + rec.serial }));
      }, function (e) { u.clear(photoBox).appendChild(el('span.muted', e.message)); });
      photoBox.addEventListener('click', function () { if (rec.photo) SN.photoViewer(rec.photo, rec.serial); });
    }
    var issues = (rec.issues || []).filter(function (i) { return i !== 'duplicate' || rec.dups; });
    var head = el('div.rec-head', photoBox, el('div.rec-main',
      el('div.kicker', 'Serial number'),
      el('div.serial-big.mono', rec.serial),
      el('div.chips.tight', recStatusBadge(rec), rec.method === 'manual' ? el('span.chip', 'Typed manually') : rec.method === 'ocr' ? el('span.chip', 'From OCR') : el('span.chip', 'From barcode')),
      issues.filter(function (i) { return i !== 'manual'; }).length ? el('ul.issues', issues.filter(function (i) { return i !== 'manual'; }).map(function (i) { return el('li', u.icon('alert', 14), u.ISSUE[i] || i); })) : null));
    body.appendChild(head);
    if (rec.dups && rec.dups.length) {
      var dl = el('div.notice.bad', u.icon('alert'), el('div', el('strong', 'Same serial number registered at:'),
        el('ul', rec.dups.map(function (d) {
          var a = el('a', { href: '#/keyplan/t/' + d.table_id + '/m/' + d.r + '-' + d.c }, d.label + ' · position ' + u.posNo(d.r, d.c, cfg()));
          return el('li', a);
        })), el('p.small', 'A serial number can exist only once. QA/QC must correct or remove one of the records.')));
      body.appendChild(dl);
    }
    var kv = el('dl.kv',
      el('dt', 'Barcode value'), el('dd.mono', rec.barcode ? rec.barcode + (rec.barcode_format ? '  (' + rec.barcode_format + ')' : '') : '—'),
      el('dt', 'OCR text'), el('dd', rec.ocr ? el('span.mono', rec.ocr.replace(/\s+/g, ' ').slice(0, 120)) : '—', rec.ocr_conf !== null && rec.ocr_conf !== undefined ? ' · ' + Math.round(rec.ocr_conf) + '% confidence' : ''),
      el('dt', 'Registered by'), el('dd', SN.userName(rec.orig_by) + ' · ' + u.fmtDateTime(rec.orig_captured_at)),
      rec.replaces_id ? [el('dt', 'Last corrected by'), el('dd', SN.userName(rec.by) + ' · ' + u.fmtDateTime(rec.captured_at))] : null,
      !rec.replaces_id && rec.captured_at && rec.orig_captured_at && u.toDate(rec.captured_at) - u.toDate(rec.orig_captured_at) > 120000
        ? [el('dt', 'Uploaded'), el('dd', u.fmtDateTime(rec.captured_at) + ' (saved offline on the phone first)')] : null,
      rec.device_time ? [el('dt', 'Phone time'), el('dd', u.fmtDateTime(rec.device_time))] : null,
      rec.reviewed_at ? [el('dt', rec.status === 'verified' ? 'Verified by' : 'Reviewed by'), el('dd', SN.userName(rec.reviewed_by) + ' · ' + u.fmtDateTime(rec.reviewed_at) + (rec.review_note ? ' — ' + rec.review_note : ''))] : null,
      el('dt', 'Remarks'), el('dd', rec.remarks || '—'),
      el('dt', 'Module ID'), el('dd.mono', (t.label || 'NO-ID') + '-R' + rec.r + 'C' + rec.c),
      el('dt', 'Photo'), el('dd', rec.local ? (rec.has_photo ? 'stored privately (view it with signal)' : 'none')
        : rec.photo ? (rec.photo_bytes ? Math.round(rec.photo_bytes / 1024) + ' KB · ' : '') + 'stored privately' : 'none'));
    body.appendChild(kv);

    var acts = el('div.row.wrap');
    if (SN.can.review()) {
      if (rec.status !== 'verified') {
        acts.appendChild(needsNet(el('button.btn.primary', { type: 'button', disabled: !!(rec.dups && rec.dups.length), title: rec.dups ? 'Resolve the duplicate first' : '',
          on: { click: function () { review(sheet, rec, 'verify'); } } }, u.icon('check'), 'Verify')));
      }
      acts.appendChild(needsNet(el('button.btn', { type: 'button', on: { click: function () { review(sheet, rec, 'flag'); } } }, u.icon('alert'), 'Flag for review')));
      acts.appendChild(needsNet(el('button.btn', { type: 'button', on: { click: function () { sheet.mode = 'correct'; sheet.render(); } } }, u.icon('edit'), 'Correct')));
      acts.appendChild(needsNet(el('button.btn.danger', { type: 'button', on: { click: function () { voidRec(sheet, rec); } } }, u.icon('trash'), 'Remove registration')));
      if (offline()) body.appendChild(el('p.small.muted', 'Reviewing, correcting and removing records need a connection.'));
    } else if (rec.status === 'needs_review') {
      body.appendChild(el('p.muted', 'QA/QC will review this record.'));
    }
    body.appendChild(acts);
    var histBtn = needsNet(el('button.btn.ghost', { type: 'button' }, u.icon('history'), 'Show history of this position'));
    var hist = el('div.history');
    histBtn.addEventListener('click', function () {
      histBtn.disabled = true;
      api.call('sn_position', { p_table_id: t.id, p_r: rec.r, p_c: rec.c }).then(function (h) {
        histBtn.remove();
        hist.appendChild(el('h3', 'History'));
        var ul = el('ul.timeline');
        h.records.forEach(function (x) {
          ul.appendChild(el('li' + (x.is_current ? '.cur' : ''),
            el('div', el('strong.mono', x.serial), ' ', x.is_current ? recStatusBadge(x) : el('span.rbadge.ended', x.end_kind === 'voided' ? 'Removed' : 'Replaced')),
            el('div.small.muted', 'Saved by ' + SN.userName(x.by) + ' · ' + u.fmtDateTime(x.captured_at)),
            !x.is_current ? el('div.small', (x.end_kind === 'voided' ? 'Removed' : 'Corrected') + ' by ' + SN.userName(x.ended_by) + ' · ' + u.fmtDateTime(x.ended_at) + (x.end_reason ? ' — ' + x.end_reason : '')) : null,
            x.photo && !x.is_current ? el('button.linkbtn', { type: 'button', on: { click: function () { SN.photoViewer(x.photo, x.serial); } } }, 'View photo') : null));
        });
        hist.appendChild(ul);
        if (h.audit.length) {
          var al = el('ul.activity'); h.audit.forEach(function (a) { al.appendChild(activityItem(a)); });
          hist.appendChild(el('h3', 'Activity')); hist.appendChild(al);
        }
      }, function (e) { histBtn.disabled = false; u.toast(e.message, 'error'); });
    });
    body.appendChild(histBtn); body.appendChild(hist);
  }

  function review(sheet, rec, action) {
    var p = action === 'verify'
      ? u.promptBox('Verify ' + rec.serial, 'Note (optional)', { multiline: true, ok: 'Verify' })
      : u.promptBox('Flag ' + rec.serial + ' for review', 'What needs checking?', { multiline: true, required: true, min: 3, ok: 'Flag', kind: 'danger' });
    p.then(function (note) {
      if (note === null) return;
      api.call('sn_review', { p_record_id: rec.id, p_action: action, p_note: note }).then(function (r) {
        SN.applyTables(r.tables); u.toast(action === 'verify' ? 'Verified.' : 'Flagged for review.', 'ok');
        loadDetail(sheet.tableId, true);
      }, function (e) { u.toast(e.message, 'error'); if (e.code === 'STALE') loadDetail(sheet.tableId, true); });
    });
  }
  function voidRec(sheet, rec) {
    u.promptBox('Remove registration ' + rec.serial, 'Reason (required)', { multiline: true, required: true, min: 3, ok: 'Remove', kind: 'danger',
      message: 'The position becomes empty and must be registered again. The record and its photo stay in the history.' }).then(function (reason) {
      if (!reason) return;
      api.call('sn_void', { p_record_id: rec.id, p_reason: reason }).then(function (r) {
        SN.applyTables(r.tables); u.toast('Registration removed.', 'ok'); loadDetail(sheet.tableId, true);
      }, function (e) { u.toast(e.message, 'error'); if (e.code === 'STALE') loadDetail(sheet.tableId, true); });
    });
  }

  SN.photoViewer = function (path, title) {
    var img = el('img.viewer-img', { alt: 'Label photo ' + (title || '') });
    var m = u.openModal({ title: title || 'Label photo', full: true, className: 'photo-viewer', body: el('div.viewer', el('p.muted', 'Loading…')) });
    api.photoUrl(path).then(function (url) { img.src = url; u.clear(m.body).appendChild(el('div.viewer', img)); },
      function (e) { u.clear(m.body).appendChild(el('p.muted', e.message)); });
  };

  // ======================================================================
  //  View registration
  // ======================================================================
  V.register('keyplan', {
    init: function () { build(); },
    show: function (args) {
      build();
      K.kp.resize();
      if (args[0] === 't' && args[1]) {
        var tid = parseInt(args[1], 10);
        if (K.selectMode) setSelectMode(false);
        openTable(tid);
        if (args[2] === 'm' && args[3]) {
          var rc = args[3].split('-').map(function (x) { return parseInt(x, 10); });
          openModule(tid, rc[0], rc[1]);
        } else if (K.sheet) K.sheet.close(true);
      } else {
        if (K.sheet) K.sheet.close(true);
        closeTable();
      }
    },
    hide: function () { if (K.sheet) K.sheet.close(true); },
    reset: function () { K.built = false; K.table = null; K.detail = null; K.sel.clear(); K.selectMode = false; u.clear(u.$('#view-keyplan')); }
  });
})();
