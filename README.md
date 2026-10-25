# Solar PV Installation Monitoring (Block 1 and Block 5)

Web app for recording Mounting Structure and PV Module installation status per table on an interactive keyplan.

- **This repository holds only the web page code.** Table IDs, keyplan geometry, statuses, users and companies are stored in the project's Supabase database and are shown only after login.
- `config.js` contains the Supabase project URL and its public *publishable* key. That key is designed to be public: every read and write is checked inside the database and needs a valid login.
- Hosted with GitHub Pages (Settings → Pages → Deploy from a branch → `main` / root).

- **Installs like an app** on Android, iPhone, iPad and computers, straight from the browser (no app store): the menu item *Install the app on this device* shows the steps for each device and a QR code of the link.
- **Works without signal.** `sw.js` keeps the app's own files on the phone; `offline.js` keeps the data the user opened and the updates saved without signal in the phone's storage (IndexedDB) and sends them when the connection is back (database function `sync_offline`, update 10). Project data saved on a phone is removed when the user logs out.

Files: `index.html` (page), `app.js` (keyplan, dashboard, admin), `piles.js` and `piles-pages.js` (Piles module), `offline.js` (working without signal), `install.js` (install on phones, tablets and computers; QR code of the link; new-version notice), `sw.js` (app files kept on the phone), `qrcode.js` (QR code generator by Kazuhiko Arase, MIT licence, see `qrcode.LICENSE.txt`), `styles.css` (layout), `config.js` (connection), `manifest.webmanifest` and icons (Add to Home Screen).
