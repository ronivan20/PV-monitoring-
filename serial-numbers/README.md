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

Files: `index.html` (page), `css/app.css`, `js/*.js` (app), `sw.js` (offline app shell),
`manifest.webmanifest` + icons (add to home screen), `config.js` (connection).
