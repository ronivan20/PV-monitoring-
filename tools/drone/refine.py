"""Refine a fit from align.py with the local shifts between the photo's installed tables and the keyplan sections.

In every 30 m window that holds installed sections, the photo's module mask is matched to the sections
(sub-pixel template matching at 5 cm). An affine correction is fitted to all window shifts (robust,
with outliers dropped) and applied to the fit; this repeats while it improves the match. Writes the
refined fit, a CSV of the final window shifts and a picture of the shifts (arrows 50x enlarged).

usage: python3 -I refine.py --src photo.png --fit fit.json --kp kp.json --out fit2.json [--look DIR]
"""
import argparse, json, math, os, sys, time
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--fit', required=True)
ap.add_argument('--kp', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--look')
ap.add_argument('--rounds', type=int, default=4)
a = ap.parse_args()
t0 = time.time()
def log(*x): print('[%4.0fs]' % (time.time() - t0), *x, flush=True)

src = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
if src.shape[2] == 3: src = cv2.cvtColor(src, cv2.COLOR_BGR2BGRA)
d = json.load(open(a.kp)); kp = d['kp']; secs = d['secs']
KW, KH = float(kp['width']), float(kp['height'])
fit = json.load(open(a.fit)); F = np.array(fit['F'], float)

def reduce4(img):
    ph, pw = (-img.shape[0]) % 4, (-img.shape[1]) % 4
    if ph or pw: img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_REPLICATE)
    return cv2.resize(img, (img.shape[1] // 4, img.shape[0] // 4), interpolation=cv2.INTER_AREA)
Q4 = np.array([[4, 0, 1.5], [0, 4, 1.5], [0, 0, 1.0]])

def module_mask(q):
    bgr = q[:, :, :3].astype(np.int16); alpha = q[:, :, 3] > 200
    b, g, r = bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2]
    v = bgr.max(axis=2); sat = v - bgr.min(axis=2)
    dark_blue = (v < 120) & (b >= r) & (b >= g - 6) & (sat < 80) & alpha
    m = dark_blue.astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        keep[i] = area >= 400 and area / float(w * h) > 0.55
    return keep[lab]

M4 = module_mask(reduce4(src)).astype(np.float32)
del src
log('module mask ready')

R = 0.05
Wk, Hk = int(KW / R) + 1, int(KH / R) + 1
def warped(Fm):
    A = np.array([[1 / R, 0, -0.5], [0, 1 / R, -0.5], [0, 0, 1]]) @ Fm @ Q4
    return cv2.warpAffine(M4, A[:2], (Wk, Hk), flags=cv2.INTER_LINEAR)

def raster(only):
    out = np.zeros((Hk, Wk), np.float32)
    for s in secs:
        if s['id'] not in only: continue
        x, y, w, h = s['geom']
        out[int(round(y / R)):int(round((y + h) / R)), int(round(x / R)):int(round((x + w) / R))] = 1
    return out

def installed(Mw):
    out = set()
    for s in secs:
        x, y, w, h = s['geom']
        p = Mw[int(y / R):int((y + h) / R), int(x / R):int((x + w) / R)]
        if p.size and p.mean() > 0.5: out.add(s['id'])
    return out

def shifts(Fm):
    Mw = warped(Fm)
    inst = installed(Mw)
    T = raster(inst)
    WIN, S = int(30 / R), int(1.0 / R)
    out = []
    for y0 in range(0, Hk - WIN, WIN // 2):
        for x0 in range(0, Wk - WIN, WIN // 2):
            t = T[y0:y0 + WIN, x0:x0 + WIN]
            if t.mean() < 0.25 or y0 < S or x0 < S: continue
            m = Mw[y0 - S:y0 + WIN + S, x0 - S:x0 + WIN + S]
            if m.shape != (WIN + 2 * S, WIN + 2 * S): continue
            res = cv2.matchTemplate(m, t, cv2.TM_CCORR_NORMED)
            iy, ix = np.unravel_index(np.argmax(res), res.shape)
            def sub(v1, v0, v2):
                den = v1 - 2 * v0 + v2
                return 0.0 if abs(den) < 1e-12 else 0.5 * (v1 - v2) / den
            fy = iy + (sub(res[iy - 1, ix], res[iy, ix], res[iy + 1, ix]) if 0 < iy < res.shape[0] - 1 else 0)
            fx = ix + (sub(res[iy, ix - 1], res[iy, ix], res[iy, ix + 1]) if 0 < ix < res.shape[1] - 1 else 0)
            dx, dy = (fx - S) * R, (fy - S) * R
            if abs(dx) < 0.9 and abs(dy) < 0.9:
                out.append(((x0 + WIN / 2) * R, (y0 + WIN / 2) * R, dx, dy, float(res[iy, ix])))
    return np.array(out), len(inst)

def stats(sh):
    dd = np.hypot(sh[:, 2], sh[:, 3])
    return {'rms_m': round(float(np.sqrt((dd ** 2).mean())), 3), 'median_m': round(float(np.median(dd)), 3),
            'p90_m': round(float(np.percentile(dd, 90)), 3), 'max_m': round(float(dd.max()), 3), 'windows': int(len(sh))}

sh, ni = shifts(F)
best = (stats(sh), F, sh, ni)
log('start: %s, %d installed sections' % (json.dumps(best[0]), ni))
for k in range(a.rounds):
    # content seen at p + d belongs at p: fit A with A(p + d) = p (robust)
    P = sh[:, :2]; Dd = sh[:, 2:4]
    A, inl = cv2.estimateAffine2D((P + Dd).astype(np.float32), P.astype(np.float32), method=cv2.RANSAC,
                                  ransacReprojThreshold=0.35, maxIters=20000, confidence=0.999, refineIters=50)
    if A is None: break
    F2 = np.vstack([A, [0, 0, 1]]) @ F
    sh2, ni2 = shifts(F2)
    s2 = stats(sh2)
    log('round %d: %s, %d installed sections, %d of %d windows kept' % (k + 1, json.dumps(s2), ni2, int(inl.sum()), len(inl)))
    if s2['rms_m'] < best[0]['rms_m'] - 1e-4:
        best = (s2, F2, sh2, ni2); F, sh = F2, sh2
    else:
        break

q, F, sh, ni = best
U, Sv, Vt = np.linalg.svd(F[:2, :2])
q.update({'method': 'installed modules matched to the keyplan sections, refined with local shifts', 'installed_sections_used': ni})
out = dict(fit)
out.update({'F': F.tolist(), 'scale_m_per_px': [round(float(Sv[0]), 6), round(float(Sv[1]), 6)],
            'rotation_deg': round(float(np.degrees(np.arctan2(F[0, 1], F[0, 0]))), 4), 'quality': q})
json.dump(out, open(a.out, 'w'), indent=1)
log('refined fit written: %s' % json.dumps(q))

if a.look:
    os.makedirs(a.look, exist_ok=True)
    np.savetxt(os.path.join(a.look, 'shifts.csv'), sh, delimiter=',', header='x_m,y_m,dx_m,dy_m,score', fmt='%.3f')
    sc = 2.0  # px per metre in the picture
    img = np.full((int(KH * sc) + 1, int(KW * sc) + 1, 3), 255, np.uint8)
    for s in secs:
        x, y, w, h = s['geom']
        cv2.rectangle(img, (int(x * sc), int(y * sc)), (int((x + w) * sc), int((y + h) * sc)), (200, 200, 200), 1)
    for x, y, dx, dy, _ in sh:
        e = math.hypot(dx, dy)
        col = (40, 160, 40) if e < 0.15 else (0, 160, 230) if e < 0.3 else (0, 0, 220)
        cv2.arrowedLine(img, (int(x * sc), int(y * sc)), (int((x + dx * 50) * sc), int((y + dy * 50) * sc)), col, 2, cv2.LINE_AA, tipLength=0.25)
    cv2.imwrite(os.path.join(a.look, 'shifts.png'), img)
    log('shift picture in', a.look)
