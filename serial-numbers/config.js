// Connection settings for this deployment. supabaseKey is the project's public
// "publishable" key: it identifies the project but grants nothing by itself.
// Every read and write is checked inside the database against a signed-in
// app session, and label photos sit in a private bucket.
window.SN_CONFIG = {
  supabaseUrl: 'https://hfxebicujwzcxekldygv.supabase.co',
  supabaseKey: 'sb_publishable_H11OwGDsFLqfslJMyUHsWA_lLjAuJqH',
  bucket: 'pvsn-photos',
  pollSeconds: 15
};
