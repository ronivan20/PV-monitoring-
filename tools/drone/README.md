# Drone photos for the keyplan

How a drone orthophoto becomes the encrypted photo layer of the keyplan (app update 11).

1. **Align** the photo to the keyplan (photo pixel → keyplan metres):
   - first photo of a block: `python3 -I align.py --src photo.png --out fit.json --kp kp.json --look look/`
     (`kp.json` = the block's keyplan size and sections `{"kp": {"width", "height"}, "secs": [{"id", "geom": [x, y, w, h]}]}`,
     taken from the database; it is project data and is not kept in the public repository)
   - later photo of the same block: `python3 -I align.py --src new.png --out fit.json --ref <site> --ref-shot b1-20261026 --key drone_key.b64 [--kp kp.json] --look look/`
     (matched with SIFT features to the photo already published; `--kp` adds the check against the sections)
   - look at `look/*.jpg` (keyplan sections drawn on the photo) and the quality numbers before publishing.
   - accuracy seen on the Block 1 photo of 26 Oct 2026: the later-photo mode recovered a known test transform within
     0.02 m (median, 0.06 m at most); the first-photo mode came within about 0.2 m of the published Block 1 fit
     (its module mask also catches some dark shadows), so check its overlays closely and correct if needed.
2. **Tile and encrypt**: `python3 -I make_tiles.py --src photo.png --fit fit.json --kp kp.json --block 1 --date 2026-10-26 --key drone_key.b64 --site <site> --quality 90`
   writes `drone/b<block>-<date>/r<rev>/<level>/<col>_<row>.bin` (512 px WebP tiles, 5 cm per pixel at level 0, AES-256-GCM,
   each tile bound to its place) and adds the photo to `drone/index.json`. Raise `--rev` when the same photo is made again.
3. **Publish**: commit `drone/` with the site. No database change is needed after update 11.

The key (`drone_key.b64`, 32 random bytes, base64) must never be committed. It is stored in the database by update 11
(`pvm.settings.drone_key`; read it back in the Supabase SQL editor with `select drone_key from pvm.settings;`).
