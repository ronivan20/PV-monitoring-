# Solar PV Installation Monitoring (Block 1 and Block 5)

Web app for recording Mounting Structure and PV Module installation status per table on an interactive keyplan.

- **This repository holds only the web page code.** Table IDs, keyplan geometry, statuses, users and companies are stored in the project's Supabase database and are shown only after login.
- `config.js` contains the Supabase project URL and its public *publishable* key. That key is designed to be public: every read and write is checked inside the database and needs a valid login.
- Hosted with GitHub Pages (Settings → Pages → Deploy from a branch → `main` / root).

Files: `index.html` (page), `app.js` (logic), `styles.css` (layout), `config.js` (connection), `favicon.svg`.
