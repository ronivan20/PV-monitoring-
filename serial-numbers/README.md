# PV Module Serial Numbers (Expansion PV Farm)

Web app for registering the serial number of every PV module per table: interactive keyplan,
4 × 7 module grid, barcode scanning and label photos on phones, duplicate checks, QA/QC review,
dashboard, daily accomplishments and Excel/CSV exports.

- **This folder holds only the web page code.** Table IDs, keyplan geometry, users, serial numbers,
  photos and history live in the project's own Supabase database and private photo bucket, and are
  shown only after sign-in.
- `config.js` holds the Supabase project URL and its public *publishable* key. The key identifies the
  project but grants nothing by itself: every database call checks a signed-in app session and role,
  and photos are served only to requests carrying a valid session.
- Hosted with GitHub Pages from this repository (`main` branch, root), in the `serial-numbers/` folder.
- `vendor/` contains third-party code under their own licences: html5-qrcode 2.3.8 (Apache-2.0, with a
  one-line fix to its Code 128 reader, noted at the top of the file) and Tesseract (tesseract.js-core
  5.1.1, Apache-2.0; English LSTM data from tessdata, Apache-2.0).

## Works without signal

- `sw.js` (service worker) keeps the app files on the phone, so the app opens without signal; a new
  version installs in the background and is used from the next start. The OCR engine is kept too,
  after it is downloaded once.
- After sign-in the phone keeps a copy of the project (tables, users, settings) and of the current
  module records (`js/store.js`, IndexedDB `pvsn-data`), updated incrementally (`sn_sync`). Keyplan,
  4 × 7 grids and duplicate checks work from that copy when there is no connection.
- Every registration is saved on the phone first (`js/sync-core.js`, IndexedDB `pvsn-outbox`: data,
  label photo and thumbnail) and uploaded in the background as soon as the server answers — also by the
  service worker with the app closed (Background Sync, Android/Chrome). Uploads are idempotent, so a
  retry never creates a second record. A registration refused by the server (e.g. the position was
  taken meanwhile) stays on the phone with the reason until someone decides.
- Sign-out deletes the copy of the project from the phone; registrations still waiting to upload stay
  until the same person signs in again.

Files: `index.html` (page), `css/app.css`, `js/*.js` (app), `sw.js` (offline files and background
uploads), `manifest.webmanifest` + icons (add to home screen), `config.js` (connection).
