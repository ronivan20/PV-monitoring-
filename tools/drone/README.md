# Drone photos for the keyplan

How a drone orthophoto becomes the encrypted photo layer of the keyplan (app update 11; Block 5 with update 12).

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
   - sections can carry `"inst": true` in `kp.json` (the drawing marks them installed, e.g. the red hatch of the Block 5
     drawing); the modules are then matched to those sections only, as rows of similar tables can also fit one column off.
   - Block 5, photo of 26 Oct 2026 (keyplan of update 12): 0.0493 m per photo pixel, rotation -0.50°, a similarity
     (no stretch); the tables match the photo within 0.09 m (median of 46 tables with modules, 90% within 0.17 m), and the
     pile marks of 286 tables across the whole block sit within 0.07 m of the drawn piles (median offset per table).
     The photo showed columns 6-9 of the new west tables built one table further south than drawn: the fit uses the
     modules where they are built, and update 12 places those columns as built (decided with the project).
2. **Look for installed tables the keyplan does not have**: `python3 -I find_unlisted.py --src photo.png --fit fit.json --kp kp.json`
   lists module-covered areas outside every section (inside the sheet). Dark trees and shadows also appear; check each one
   on the photo. Block 1 (26 Oct 2026): 2 tables in row R14 between T07 and T10, added as M01-R14-T08 and M01-R14-T09
   (database update 11) on the project's request. Block 5 (26 Oct 2026): 2 built tables not in the drawing, south of
   M05-R13-T01 (modules) and of M05-R09-T17 (mounting structure), added without an ID by update 12.
3. **Tile and encrypt**: `python3 -I make_tiles.py --src photo.png --fit fit.json --kp kp.json --block 1 --date 2026-10-26 --key drone_key.b64 --site <site> --quality 90 --rev 2`
   writes `drone/b<block>-<date>/r<rev>/<level>/<col>_<row>.bin` (512 px WebP tiles, 5 cm per pixel at level 0, resampled
   with Lanczos, AES-256-GCM, each tile bound to its place) and adds the photo to `drone/photos.json` with the key id
   (`kid`, the first 16 hex digits of the key's SHA-256). Raise `--rev` when the same photo is made again.
   The entry also records the keyplan sheet size (`kp`): the app shows the photo only while the block's keyplan in the
   database has that size, so a photo made for a new drawing waits for its database update (`--update 12` names that
   update in the administrator's note). Block 5: `--block 5 --date 2026-10-26 --quality 90 --rev 1 --update 12`.
4. **Publish**: commit `drone/` with the site. (`drone/index.json` is the older photo list, Block 1 only, kept unchanged for
   app copies that have not reloaded since update 12; they cannot check a photo's keyplan sheet.) The app shows only photos whose `kid` matches the key it receives at sign-in,
   so a photo made with a new key stays hidden (administrators see a note) until the matching update 11 file is run.

The key (`drone_key.b64`, 32 random bytes, base64) must never be committed. It is stored in the database by update 11
(`pvm.settings.drone_key`; read it back in the Supabase SQL editor with `select drone_key from pvm.settings;`).
