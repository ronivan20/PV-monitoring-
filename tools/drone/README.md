# Drone photos for the keyplan

How a drone orthophoto becomes the encrypted photo layer of the keyplan (app update 11).

1. **Align** the photo to the keyplan (photo pixel → keyplan metres):
   - first photo of a block: `python3 -I align.py --src photo.png --out fit.json --kp kp.json --look look/`
     (`kp.json` = the block's keyplan size and sections `{"kp": {"width", "height"}, "secs": [{"id", "geom": [x, y, w, h]}]}`,
     taken from the database; it is project data and is not kept in the public repository)
   - optional check: `python3 -I refine.py --src photo.png --fit fit.json --kp kp.json --out fit2.json --look look/`
     measures the local shifts between the photo's tables and the sections in 30 m windows (`look/shifts.png`, arrows 50x)
     and keeps an affine correction only if it improves the match
   - later photo of the same block: `python3 -I align.py --src new.png --out fit.json --ref <site> --ref-shot b1-20261026 --key drone_key.b64 [--kp kp.json] --look look/`
     (matched with SIFT features to the photo already published; `--kp` adds the check against the sections)
   - look at `look/*.jpg` (keyplan sections drawn on the photo) and the quality numbers before publishing.
   - Block 1, photo of 26 Oct 2026: 0.0509 m per photo pixel, rotation 0.48°, sections match the photo's tables within
     0.09 m (median of 130 windows, 90% within 0.22 m, 202 sections with modules used). The remaining shifts are local
     (partly installed tables, shadows), not a pattern, so the plain affine fit is kept: the photo is not bent.
2. **Look for installed tables the keyplan does not have**: `python3 -I find_unlisted.py --src photo.png --fit fit.json --kp kp.json`
   lists module-covered areas outside every section (inside the sheet). Dark trees and shadows also appear; check each one
   on the photo. Block 1 (26 Oct 2026): 2 tables in row R14 between T07 and T10, added as M01-R14-T08 and M01-R14-T09
   (database update 11) on the project's request.
3. **Tile and encrypt**: `python3 -I make_tiles.py --src photo.png --fit fit.json --kp kp.json --block 1 --date 2026-10-26 --key drone_key.b64 --site <site> --quality 90 --rev 2`
   writes `drone/b<block>-<date>/r<rev>/<level>/<col>_<row>.bin` (512 px WebP tiles, 5 cm per pixel at level 0, resampled
   with Lanczos, AES-256-GCM, each tile bound to its place) and adds the photo to `drone/index.json` with the key id
   (`kid`, the first 16 hex digits of the key's SHA-256). Raise `--rev` when the same photo is made again.
4. **Publish**: commit `drone/` with the site. The app shows only photos whose `kid` matches the key it receives at sign-in,
   so a photo made with a new key stays hidden (administrators see a note) until the matching update 11 file is run.

The key (`drone_key.b64`, 32 random bytes, base64) must never be committed. It is stored in the database by update 11
(`pvm.settings.drone_key`; read it back in the Supabase SQL editor with `select drone_key from pvm.settings;`).
