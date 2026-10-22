/* PV Module Serial Numbers — OCR worker. Runs Tesseract (LSTM engine, English) from the app's own
   vendor folder; nothing is sent to any other server. */
/* global TesseractCore */
'use strict';
var M = null, api = null, loading = null;

function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch (e) { return false; }
}

function progress(id, p, label) { self.postMessage({ id: id, progress: { p: p, label: label } }); }

function load(id, base) {
  if (loading) return loading;
  loading = (async function () {
    progress(id, 0.05, 'Loading OCR engine');
    importScripts(base + (simdSupported() ? 'tesseract-core-simd-lstm.js' : 'tesseract-core-lstm.js'));
    M = await TesseractCore({ locateFile: function (p) { return base + p; } });
    progress(id, 0.4, 'Loading language data');
    var res = await fetch(base + 'eng.traineddata.gz');
    if (!res.ok) throw new Error('language data ' + res.status);
    var data;
    if (typeof DecompressionStream !== 'undefined') {
      data = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    } else {
      throw new Error('This browser cannot unpack the OCR language data.');
    }
    M.FS.writeFile('eng.traineddata', data);
    api = new M.TessBaseAPI();
    var st = api.Init(null, 'eng', 1);
    if (st !== 0) throw new Error('OCR engine did not start (' + st + ')');
    api.SetVariable('tessedit_char_whitelist', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/:.');
    api.SetVariable('user_defined_dpi', '300');
    progress(id, 0.7, 'Reading text');
  })();
  loading.catch(function () { loading = null; });
  return loading;
}

function words() {
  var out = [];
  try {
    var ri = api.GetIterator(), level = M.RIL_WORD;
    if (!ri || level === undefined) return out;
    ri.Begin();
    do {
      var w = ri.GetUTF8Text(level);
      if (w) out.push({ t: w, c: ri.Confidence(level) });
    } while (ri.Next(level));
  } catch (e) { /* word-level details are optional */ }
  return out;
}

self.onmessage = async function (e) {
  var msg = e.data || {};
  try {
    await load(msg.id, msg.base);
    var best = null;
    var modes = msg.psm ? [msg.psm] : ['11', '6'];
    api.SetVariable('tessedit_char_whitelist', msg.whitelist === false ? '' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/:.');
    for (var i = 0; i < modes.length; i++) {
      api.SetVariable('tessedit_pageseg_mode', modes[i]);
      M.FS.writeFile('/input', new Uint8Array(msg.image));
      api.SetImageFile(1, 0);
      api.Recognize(null);
      var r = { text: api.GetUTF8Text() || '', conf: api.MeanTextConf(), words: words(), psm: modes[i] };
      if (!best || r.conf > best.conf) best = r;
      if (msg.want && r.text.replace(/\s+/g, '').toUpperCase().indexOf(msg.want) >= 0) { best = r; break; }
    }
    self.postMessage({ id: msg.id, ok: true, text: best.text, conf: best.conf, words: best.words, psm: best.psm });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
};
