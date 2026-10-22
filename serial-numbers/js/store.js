/* PV Module Serial Numbers — the offline copy on this device (IndexedDB "pvsn-data"):
   the project snapshot (tables, users, settings) and the current module records, kept up to date
   by sync.js. Cleared when the user signs out. Registrations waiting to upload are NOT here; they
   live in the outbox (sync-core.js) so a sign-out never loses work. */
(function () {
  'use strict';
  var SN = window.SN, u = SN.u;
  var NAME = 'pvsn-data', VER = 1, SNAP_V = 1, dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no IndexedDB')); return; }
      var rq;
      try { rq = indexedDB.open(NAME, VER); } catch (e) { reject(e); return; }
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('tables')) d.createObjectStore('tables');
        if (!d.objectStoreNames.contains('records')) {
          var r = d.createObjectStore('records', { keyPath: 'i' });
          r.createIndex('t', 't');
          r.createIndex('n', 'n');
        }
      };
      rq.onsuccess = function () {
        var d = rq.result;
        d.onversionchange = function () { d.close(); dbp = null; };
        resolve(d);
      };
      rq.onerror = function () { reject(rq.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  // tx(['kv','tables'], 'readwrite', function (t) { ... return value or IDBRequest })
  function tx(stores, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t, out;
        try { t = d.transaction(stores, mode); out = fn(t); } catch (e) { reject(e); return; }
        t.oncomplete = function () { resolve(out && typeof out === 'object' && 'readyState' in out ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('storage aborted')); };
      });
    });
  }
  function ms(v) { if (v === null || v === undefined || v === '') return null; var t = typeof v === 'number' ? v : Date.parse(v); return isNaN(t) ? null : t; }

  // ---------- record formats ----------
  // sync row (see pvsn.sync_row) -> local object
  function fromRow(a) {
    return { i: a[0], t: a[1], r: a[2], c: a[3], s: a[4], n: u.normSerial(a[4]), st: a[5] | 0, is: a[6] || [], m: a[7] || 'm',
      ob: a[8], oa: a[9], by: a[10], ca: a[11], rb: a[12], ra: a[13], rm: a[15] || null, ph: !!a[16], bc: a[17] || null, rn: a[18] || null };
  }
  // record_json from the server (sn_table, sn_register) -> local object
  function fromServer(rec) {
    var st = rec.stored_status || (rec.status === 'verified' ? 'verified' : 'pending');
    return { i: rec.id, t: rec.table_id, r: rec.r, c: rec.c, s: rec.serial, n: u.normSerial(rec.serial),
      st: st === 'verified' ? 1 : st === 'needs_review' ? 2 : 0,
      is: (rec.issues || []).filter(function (x) { return x !== 'duplicate'; }),
      m: rec.method === 'barcode' ? 'b' : rec.method === 'ocr' ? 'o' : 'm',
      ob: rec.orig_by, oa: ms(rec.orig_captured_at), by: rec.by, ca: ms(rec.captured_at), rb: rec.reviewed_by, ra: ms(rec.reviewed_at),
      rm: rec.remarks || null, ph: !!rec.photo, bc: rec.barcode && u.normSerial(rec.barcode) !== u.normSerial(rec.serial) ? rec.barcode : null,
      rn: rec.review_note || null };
  }
  // local object -> the record shape the screens use (same keys as record_json)
  function display(x, dups) {
    var st = x.st === 2 ? 'needs_review' : x.st === 1 ? 'verified' : 'pending';
    var issues = (x.is || []).slice();
    if (dups && dups.length && issues.indexOf('duplicate') < 0) issues.push('duplicate');
    return { id: x.i, table_id: x.t, r: x.r, c: x.c, serial: x.s, stored_status: st,
      status: dups && dups.length ? 'needs_review' : st, issues: issues, dups: dups && dups.length ? dups : null,
      method: x.m === 'b' ? 'barcode' : x.m === 'o' ? 'ocr' : 'manual', barcode: x.bc || (x.m === 'b' ? x.s : null),
      orig_by: x.ob, orig_captured_at: x.oa, by: x.by, captured_at: x.ca, reviewed_by: x.rb, reviewed_at: x.ra,
      review_note: x.rn, remarks: x.rm, has_photo: x.ph, photo: null, thumb: null, is_current: true, local: true };
  }

  var store = (SN.store = {
    available: function () { return open().then(function () { return true; }, function () { return false; }); },
    get: function (k) { return tx('kv', 'readonly', function (t) { return t.objectStore('kv').get(k); }); },
    set: function (k, v) { return tx('kv', 'readwrite', function (t) { return t.objectStore('kv').put(v, k); }); },
    del: function (k) { return tx('kv', 'readwrite', function (t) { return t.objectStore('kv').delete(k); }); },

    // ---------- project snapshot ----------
    // b = sn_bootstrap result {user, settings, users, tables, server_time}
    saveSnapshot: function (b) {
      return tx(['kv', 'tables'], 'readwrite', function (t) {
        t.objectStore('kv').put({ v: SNAP_V, user_id: b.user.id, user: b.user, settings: b.settings, users: b.users,
          server_time: b.server_time, saved_at: Date.now() }, 'snap');
        var ts = t.objectStore('tables');
        ts.clear();
        (b.tables || []).forEach(function (row) { ts.put(row, row[0]); });
      }).catch(function () { return null; });
    },
    // after each successful update from the server: changed table rows + newer meta
    patchSnapshot: function (rows, meta) {
      return tx(['kv', 'tables'], 'readwrite', function (t) {
        var kv = t.objectStore('kv'), ts = t.objectStore('tables');
        (rows || []).forEach(function (row) { ts.put(row, row[0]); });
        var g = kv.get('snap');
        g.onsuccess = function () {
          var s = g.result;
          if (!s || s.v !== SNAP_V) return;
          Object.keys(meta).forEach(function (k) { if (meta[k] !== undefined) s[k] = meta[k]; });
          s.saved_at = Date.now();
          kv.put(s, 'snap');
        };
      }).catch(function () { return null; });
    },
    loadSnapshot: function (userId) {
      if (!userId) return Promise.resolve(null);
      return tx(['kv', 'tables'], 'readonly', function (t) {
        var out = {};
        var g = t.objectStore('kv').get('snap');
        g.onsuccess = function () { out.snap = g.result; };
        var a = t.objectStore('tables').getAll();
        a.onsuccess = function () { out.tables = a.result; };
        return out;
      }).then(function (o) {
        var s = o.snap;
        if (!s || s.v !== SNAP_V || s.user_id !== userId || !o.tables || !o.tables.length) return null;
        return { user: s.user, settings: s.settings || {}, users: s.users || [], tables: o.tables, server_time: s.server_time, saved_at: s.saved_at };
      }).catch(function () { return null; });
    },

    // ---------- module records ----------
    // rows from sn_sync; returns the set of table ids that changed
    applySync: function (rows) {
      var tids = new Set();
      if (!rows || !rows.length) return Promise.resolve(tids);
      return tx('records', 'readwrite', function (t) {
        var s = t.objectStore('records');
        rows.forEach(function (a) {
          tids.add(a[1]);
          if (a[14] === false) s.delete(a[0]); else s.put(fromRow(a));
        });
      }).then(function () { return tids; });
    },
    putServerRecords: function (recs) {
      if (!recs || !recs.length) return Promise.resolve();
      return tx('records', 'readwrite', function (t) {
        var s = t.objectStore('records');
        recs.forEach(function (rec) { if (rec.is_current === false) s.delete(rec.id); else s.put(fromServer(rec)); });
      }).catch(function () { return null; });
    },
    // the server's current records of one table (sn_table): replaces the local ones
    replaceTable: function (tid, recs) {
      var keep = new Set((recs || []).map(function (r) { return r.id; }));
      return tx('records', 'readwrite', function (t) {
        var s = t.objectStore('records');
        var k = s.index('t').getAllKeys(tid);
        k.onsuccess = function () { (k.result || []).forEach(function (id) { if (!keep.has(id)) s.delete(id); }); };
        (recs || []).forEach(function (rec) { s.put(fromServer(rec)); });
      }).catch(function () { return null; });
    },
    tableRecords: function (tid) {
      return tx('records', 'readonly', function (t) { return t.objectStore('records').index('t').getAll(tid); }).then(function (r) { return r || []; });
    },
    bySerial: function (norm) {
      if (!norm) return Promise.resolve([]);
      return tx('records', 'readonly', function (t) { return t.objectStore('records').index('n').getAll(norm); }).then(function (r) { return r || []; });
    },
    // other current records with the same serial, for each of the given records: Map id -> [dup]
    dupsFor: function (recs) {
      var out = new Map();
      if (!recs.length) return Promise.resolve(out);
      return tx('records', 'readonly', function (t) {
        var idx = t.objectStore('records').index('n');
        recs.forEach(function (x) {
          var q = idx.getAll(x.n);
          q.onsuccess = function () {
            var d = (q.result || []).filter(function (o) { return o.i !== x.i; }).map(function (o) {
              var tt = SN.state.tables.get(o.t);
              return { record_id: o.i, table_id: o.t, label: tt ? tt.label : '?', r: o.r, c: o.c };
            });
            if (d.length) out.set(x.i, d);
          };
        });
      }).then(function () { return out; });
    },
    recordCount: function () {
      return tx('records', 'readonly', function (t) { return t.objectStore('records').count(); }).catch(function () { return 0; });
    },
    clearRecords: function () {
      return tx(['records', 'kv'], 'readwrite', function (t) { t.objectStore('records').clear(); t.objectStore('kv').delete('recsync'); });
    },
    clearAll: function () {
      return tx(['kv', 'tables', 'records'], 'readwrite', function (t) {
        t.objectStore('kv').clear(); t.objectStore('tables').clear(); t.objectStore('records').clear();
      }).catch(function () { return null; });
    },
    fromServer: fromServer, display: display
  });

  // A table's detail built from the copy on this device (same shape as sn_table, plus local: true).
  SN.localDetail = function (tid) {
    var t = SN.state.tables.get(tid);
    if (!t) return Promise.resolve(null);
    return store.tableRecords(tid).then(function (recs) {
      return store.dupsFor(recs).then(function (dmap) {
        return { table: t.raw, records: recs.map(function (x) { return display(x, dmap.get(x.i)); }), audit: [], history: {}, local: true };
      });
    });
  };
})();
