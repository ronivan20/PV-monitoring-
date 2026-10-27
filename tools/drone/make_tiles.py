"""Drone photo -> keyplan photo tiles for the web app (encrypted).

The photo is resampled into keyplan metres with the fitted transform (photo pixel -> keyplan metre),
cut into a pyramid of 512 px WebP tiles (0.05 m per pixel at the finest level, then 0.1, 0.2 ...),
and every tile is encrypted with AES-256-GCM. The tiles can then sit on the public web site: only
signed-in users receive the key (database update 11), so only they can see the photo.

usage:
  python3 -I make_tiles.py --src photo.png --fit fit.json --kp kp1.json --block 1 --date 2026-10-26 \
      --key secrets/drone_key.b64 --site <site folder> [--margin 100] [--quality 80]
writes <site>/drone/<id>/r<rev>/<level>/<col>_<row>.bin and updates <site>/drone/index.json
"""
import argparse, base64, io, json, math, os, time
import numpy as np, cv2
from PIL import Image
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TILE = 512
MPP0 = 0.05

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--fit', required=True, help='JSON with "F": 3x3 full-res pixel (centre) -> keyplan metres')
ap.add_argument('--kp', required=True, help='JSON with the keyplan: {"kp": {"width", "height"}}')
ap.add_argument('--block', type=int, required=True)
ap.add_argument('--date', required=True)
ap.add_argument('--key', required=True)
ap.add_argument('--site', required=True)
ap.add_argument('--margin', type=float, default=100.0, help='metres of photo kept around the keyplan sheet')
ap.add_argument('--quality', type=int, default=80)
ap.add_argument('--rev', type=int, default=1, help='version of this photo\'s tiles; raise it when the same photo is made again')
a = ap.parse_args()

t0 = time.time()
key = base64.b64decode(open(a.key).read().strip())
assert len(key) == 32
aes = AESGCM(key)
fit = json.load(open(a.fit))
F = np.array(fit['F'], float)
kp = json.load(open(a.kp))['kp']
KW, KH = float(kp['width']), float(kp['height'])
sid = 'b%d-%s' % (a.block, a.date.replace('-', ''))

# ---- the photo, with the white page around the mosaic made transparent
src = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
if src.shape[2] == 3:
    src = cv2.cvtColor(src, cv2.COLOR_BGR2BGRA)
h0, w0 = src.shape[:2]
white = ((src[:, :, 0] >= 250) & (src[:, :, 1] >= 250) & (src[:, :, 2] >= 250)).astype(np.uint8)
n, lab = cv2.connectedComponents(white, connectivity=8)
edge = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
edge = edge[edge > 0]
bg = np.isin(lab, edge)
del lab, white
alpha = np.where(bg, 0, src[:, :, 3]).astype(np.uint8)
alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8))          # trim the light fringe of the mosaic edge
src[:, :, 3] = alpha
del bg, alpha
print('photo %dx%d loaded, background removed, %.1f%% photographed (%.0fs)' % (w0, h0, 100.0 * (src[:, :, 3] > 0).mean(), time.time() - t0), flush=True)

# ---- the area kept: the keyplan sheet plus a margin, inside the photographed area
rows_any = np.flatnonzero(src[:, :, 3].any(axis=1)); cols_any = np.flatnonzero(src[:, :, 3].any(axis=0))
cx0, cx1, cy0, cy1 = cols_any[0] - 0.5, cols_any[-1] + 0.5, rows_any[0] - 0.5, rows_any[-1] + 0.5
corners = np.array([[cx0, cy0, 1], [cx1, cy0, 1], [cx0, cy1, 1], [cx1, cy1, 1]], float) @ F.T
px0, py0 = corners[:, 0].min(), corners[:, 1].min()
px1, py1 = corners[:, 0].max(), corners[:, 1].max()
x0 = math.floor(max(-a.margin, px0) / MPP0) * MPP0
y0 = math.floor(max(-a.margin, py0) / MPP0) * MPP0
x1 = math.ceil(min(KW + a.margin, px1) / MPP0) * MPP0
y1 = math.ceil(min(KH + a.margin, py1) / MPP0) * MPP0
x0, y0, x1, y1 = (round(v, 4) for v in (x0, y0, x1, y1))
W, H = int(round((x1 - x0) / MPP0)), int(round((y1 - y0) / MPP0))
print('kept %.1f x %.1f m from (%.2f, %.2f): %d x %d px at %.2f m/px' % (x1 - x0, y1 - y0, x0, y0, W, H, MPP0), flush=True)

# output pixel (i, j) centre -> metres -> photo pixel
D = np.array([[MPP0, 0, x0 + MPP0 / 2], [0, MPP0, y0 + MPP0 / 2], [0, 0, 1]])
Minv = np.linalg.inv(F) @ D
out = cv2.warpAffine(src, Minv[:2], (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
del src
print('resampled (%.0fs)' % (time.time() - t0), flush=True)

# ---- pyramid (premultiplied alpha so edges do not darken)
def half(img):
    # exact 2x reduction: pad odd sizes with a transparent pixel so every level keeps the same origin and scale
    ph, pw = img.shape[0] % 2, img.shape[1] % 2
    if ph or pw:
        img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_CONSTANT, value=(0, 0, 0, 0))
    af = img[:, :, 3:4].astype(np.float32) / 255.0
    pre = img[:, :, :3].astype(np.float32) * af
    nw, nh = img.shape[1] // 2, img.shape[0] // 2
    pre_s = cv2.resize(pre, (nw, nh), interpolation=cv2.INTER_AREA)
    a_s = cv2.resize(af, (nw, nh), interpolation=cv2.INTER_AREA)
    if a_s.ndim == 2:
        a_s = a_s[:, :, None]
    rgb = np.where(a_s > 1e-3, pre_s / np.maximum(a_s, 1e-3), 0)
    return np.dstack([np.clip(rgb, 0, 255), np.clip(a_s * 255, 0, 255)]).astype(np.uint8)

levels, img, mpp = [], out, MPP0
while True:
    levels.append((mpp, img))
    if max(img.shape[0], img.shape[1]) <= TILE:
        break
    img = half(img); mpp *= 2

# ---- tiles
rel = 'drone/%s/r%d/' % (sid, a.rev)
base = os.path.join(a.site, rel)
os.makedirs(base, exist_ok=True)
man_levels, total, count = [], 0, 0
for li, (mpp, img) in enumerate(levels):
    hh, ww = img.shape[:2]
    cols, rows = math.ceil(ww / TILE), math.ceil(hh / TILE)
    have = []
    os.makedirs(os.path.join(base, str(li)), exist_ok=True)
    for r in range(rows):
        for c in range(cols):
            t = np.zeros((TILE, TILE, 4), np.uint8)
            part = img[r * TILE:(r + 1) * TILE, c * TILE:(c + 1) * TILE]
            t[:part.shape[0], :part.shape[1]] = part
            if not t[:, :, 3].any():
                have.append('0'); continue
            rgba = cv2.cvtColor(t, cv2.COLOR_BGRA2RGBA)
            im = Image.fromarray(rgba, 'RGBA')
            if t[:, :, 3].min() == 255:
                im = im.convert('RGB')
            buf = io.BytesIO()
            im.save(buf, 'WEBP', quality=a.quality, method=4, alpha_quality=90)
            data = buf.getvalue()
            iv = os.urandom(12)
            aad = ('%s/%d/%d_%d' % (sid, li, c, r)).encode()
            enc = iv + aes.encrypt(iv, data, aad)
            with open(os.path.join(base, str(li), '%d_%d.bin' % (c, r)), 'wb') as f:
                f.write(enc)
            total += len(enc); count += 1
            have.append('1')
    man_levels.append({'mpp': round(mpp, 4), 'w': ww, 'h': hh, 'cols': cols, 'rows': rows, 'have': ''.join(have)})
    print('level %d: %.2f m/px, %dx%d px, %d of %d tiles' % (li, mpp, ww, hh, have.count('1'), cols * rows), flush=True)

shot = {'id': sid, 'block': a.block, 'date': a.date, 'path': rel, 'tile': TILE, 'fmt': 'webp',
        'origin': [round(x0, 4), round(y0, 4)], 'levels': man_levels, 'bytes': total, 'tiles': count,
        'source_mpp': round(float(np.sqrt(abs(np.linalg.det(F[:2, :2])))), 4), 'fit': fit.get('quality', {})}
idx_path = os.path.join(a.site, 'drone', 'index.json')
idx = json.load(open(idx_path)) if os.path.exists(idx_path) else {'v': 1, 'shots': []}
idx['shots'] = [s for s in idx['shots'] if s['id'] != sid] + [shot]
idx['shots'].sort(key=lambda s: (s['block'], s['date']))
json.dump(idx, open(idx_path, 'w'), separators=(',', ':'))
print('shot %s: %d tiles, %.1f MB, index updated (%.0fs)' % (sid, count, total / 1e6, time.time() - t0))
