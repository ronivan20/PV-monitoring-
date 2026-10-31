# Drone photos for the keyplan

From database update 13, an administrator adds new photos in the app itself (Admin > Drone photos): choose the
block, the date the photo was taken and the file (the GeoTIFF from the drone software is best). The browser places
the photo (GPS position of a GeoTIFF, or two points), shows it over the sections for a check, makes the same
encrypted tiles as `make_tiles.py` and uploads them to Supabase Storage. The scripts below remain for photos that
need a closer fit than the browser can make.

How a drone orthophoto becomes the encrypted photo layer of the keyplan (app update 11; Block 5 with update 12).

1. **Align** the photo to the keyplan (photo pixel → keyplan metres):
   - first photo of a block: `python3 -I align.py --src photo.png --out fit.json --kp kp.json --look look/`
     (`kp.json` = the block's keyplan size and sections `{"kp": {"width", "height"}, "secs": [{"id", "geom": [x, y, w, h]}]}`,
     taken from the database; it is project data and is not kept in the public repository)
   - optional check: `python3 -I refine.py --src photo.png --fit fit.json --kp kp.json --out fit2.json --look look/`
     measures the local shifts between the photo's tables and the sections in 30 m windows (`look/shifts.png`, arrows 50x)
     and keeps an affine correction only if it improves the match
   - later photo of the same block: `python3 -I align.py --src new.png --out fit.json --ref <site> --ref-shot b1-20261026 --key drone_key.b64 [--kp kp.json] [--src-mpp 0.07] --look look/`
     (matched with SIFT features to the photo already published; `--kp` adds the check against the sections)
   - look at `look/*.jpg` (keyplan sections drawn on the photo) and the quality numbers before publishing.
   - Block 1, photo of 26 Oct 2026: 0.0509 m per photo pixel, rotation 0.48°, sections match the photo's tables within
     0.09 m (median of 130 windows, 90% within 0.22 m, 202 sections with modules used). The remaining shifts are local
     (partly installed tables, shadows), not a pattern, so the plain affine fit is kept: the photo is not bent.
   - sections can carry `"inst": true` in `kp.json` (the drawing marks them installed, e.g. the red hatch of the Block 5
     drawing); the modules are then matched to those sections only, as rows of similar tables can also fit one column off.
   - Block 5, photo of 26 Oct 2026 (keyplan of update 12, from BLOCK 5 KEYPLAN FOR WEB APP REV.01.dwg): 0.0493 m per
     photo pixel, rotation -0.48°, a similarity (no stretch). The PV modules were matched to the 69 tables REV.01 draws
     installed, from four starts one table pitch apart (the tables repeat every 17.17 m, so a fit on modules alone can lock
     one table off): only the right one puts modules on all 69 (overlap 0.88). Tables match within 0.09 m (median of 45,
     90% within 0.23 m); checked independently with the drawing's road centre lines on the photo's gravel roads, and the
     pile marks of 287 tables across the block (median 0.10 m). The first drawing (without REV.01) put new columns 1-5 one
     table too far south, which is why a fit on those columns alone came out one table off.
   - Block 5, GeoTIFF of 30 Oct 2026 (WGS 84 / UTM 51N, 0.07 m per pixel): matched with `--ref-shot b5-20261026 --src-mpp 0.07`
     within 0.05 m (median of 303 windows). Its GPS position on the keyplan is stored by database update 13, so the app
     places the next Block 5 GeoTIFF automatically.
2. **Look for installed tables the keyplan does not have**: `python3 -I find_unlisted.py --src photo.png --fit fit.json --kp kp.json`
   lists module-covered areas outside every section (inside the sheet). Dark trees and shadows also appear; check each one
   on the photo. Block 1 (26 Oct 2026): 2 tables in row R14 between T07 and T10, added as M01-R14-T08 and M01-R14-T09
   (database update 11) on the project's request. Block 5 (26 Oct 2026, REV.01): none inside the block boundary; the installed
   tables south of the road and fence belong to the neighbouring block.
3. **Tile and encrypt**: `python3 -I make_tiles.py --src photo.png --fit fit.json --kp kp.json --block 1 --date 2026-10-26 --key drone_key.b64 --site <site> --quality 90 --rev 2`
   writes `drone/b<block>-<date>/r<rev>/<level>/<col>_<row>.bin` (512 px WebP tiles, 5 cm per pixel at level 0, resampled
   with Lanczos, AES-256-GCM, each tile bound to its place) and adds the photo to `drone/photos.json` with the key id
   (`kid`, the first 16 hex digits of the key's SHA-256). Raise `--rev` when the same photo is made again.
   The entry also records the keyplan sheet size (`kp`): the app shows the photo only while the block's keyplan in the
   database has that size, so a photo made for a new drawing waits for its database update (`--update 12` names that
   update in the administrator's note). Block 5: `--block 5 --date 2026-10-26 --quality 90 --rev 2 --update 12`.
4. **Publish**: commit `drone/` with the site. (`drone/index.json` is the older photo list, Block 1 only, kept unchanged for
   app copies that have not reloaded since update 12; they cannot check a photo's keyplan sheet.) The app shows only photos whose `kid` matches the key it receives at sign-in,
   so a photo made with a new key stays hidden (administrators see a note) until the matching update 11 file is run.

The key (`drone_key.b64`, 32 random bytes, base64) must never be committed. It is stored in the database by update 11
(`pvm.settings.drone_key`; read it back in the Supabase SQL editor with `select drone_key from pvm.settings;`).
