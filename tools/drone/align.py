"""Align a drone orthophoto to the keyplan: fit F = photo pixel (centre) -> keyplan metres, for make_tiles.py.

Two ways, as the situation allows:

  --kp KP.json      The first photo of a block. Installed PV modules are found in the photo (dark blue-grey,
                    closed into table shapes) and matched to the keyplan sections: FFT search over scale and
                    rotation, then overlap (IoU) refinement as a similarity and an affine transform.
                    KP.json = {"kp": {"width", "height"}, "secs": [{"id", "geom": [x, y, w, h], "inst": true?}, ...]}
                    (the block's keyplan and sections from the database; not stored in the public repository).
                    "inst": the drawing marks this section as installed (Block 5: red hatch = PV modules). When
                    given, the photo's modules are matched to those sections only: rows of similar tables can
                    otherwise also fit one column off.

  --ref SITE --ref-shot ID --key KEY
                    A later photo of a block that already has one: matched to the published (encrypted) photo
                    tiles of that shot with SIFT features and RANSAC. Needs no keyplan data.

Both write a fit JSON (F, scale, rotation, quality) and overlay pictures to look at before publishing.
With --kp the quality is measured as local shifts in 30 m windows between the photo's tables and the sections.

usage:
  python3 -I align.py --src photo.png --out fit.json --kp kp.json [--mpp 0.045 0.056] [--look DIR]
  python3 -I align.py --src photo.png --out fit.json --ref SITE --ref-shot b1-20261026 --key KEY [--kp kp.json] [--look DIR]
"""
import argparse, base64, io, json, math, os, sys, time
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--kp')
ap.add_argument('--mpp', type=float, nargs=2, default=[0.045, 0.056], help='range of metres per photo pixel to search')
ap.add_argument('--rot', type=float, default=3.0, help='+- degrees of rotation to search')
ap.add_argument('--ref'); ap.add_argument('--ref-shot'); ap.add_argument('--key')
ap.add_argument('--look', help='folder for overlay pictures')
ap.add_argument('--src-mpp', type=float, default=0.05, help='approximate metres per pixel of the new photo (--ref; a GeoTIFF states it)')
a = ap.parse_args()
t0 = time.time()
def log(*x): print('[%4.0fs]' % (time.time() - t0), *x, flush=True)
Tr = lambda x, y: np.array([[1, 0, x], [0, 1, y], [0, 0, 1.0]])

src = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
if src is None: sys.exit('cannot read ' + a.src)
if src.ndim == 2: src = cv2.cvtColor(src, cv2.COLOR_GRAY2BGRA)
if src.shape[2] == 3: src = cv2.cvtColor(src, cv2.COLOR_BGR2BGRA)
H0, W0 = src.shape[:2]
log('photo %dx%d' % (W0, H0))

def reduce4(img):
    # exact 4x box reduction: quarter pixel u covers full pixels 4u..4u+3 (centre 4u+1.5)
    ph, pw = (-img.shape[0]) % 4, (-img.shape[1]) % 4
    if ph or pw: img = cv2.copyMakeBorder(img, 0, ph, 0, pw, cv2.BORDER_REPLICATE)
    return cv2.resize(img, (img.shape[1] // 4, img.shape[0] // 4), interpolation=cv2.INTER_AREA)
Q4 = np.array([[4, 0, 1.5], [0, 4, 1.5], [0, 0, 1.0]])           # quarter pixel centre -> full pixel centre

kp = secs = None
if a.kp:
    d = json.load(open(a.kp)); kp = d['kp']; secs = d['secs']
    KW, KH = float(kp['width']), float(kp['height'])
    MARKED = set(s['id'] for s in secs if s.get('inst')) or None     # sections the drawing shows installed

def module_mask(q):
    """installed PV modules at quarter size: dark, blue-grey; closed over the white cell lines into tables"""
    bgr = q[:, :, :3].astype(np.int16); alpha = q[:, :, 3] > 200
    b, g, r = bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2]
    v = bgr.max(axis=2); sat = v - bgr.min(axis=2)
    # dark and blue-grey: excludes shadows on grass (greener) and on soil (redder)
    dark_blue = (v < 120) & (b >= r) & (b >= g - 6) & (sat < 80) & alpha
    m = dark_blue.astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))      # ~1 m: across cell lines and frames
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = st[i]
        fill = area / float(w * h)
        keep[i] = area >= 400 and fill > 0.55          # >= ~16 m2 at 0.2 m per quarter pixel, compact shapes
    return keep[lab]

def sections_raster(R, pad, only=None):
    Wk, Hk = int(KW / R) + 1 + 2 * pad, int(KH / R) + 1 + 2 * pad
    out = np.zeros((Hk, Wk), np.float32)
    for s in secs:
        if only is not None and s['id'] not in only: continue
        x, y, w, h = s['geom']
        out[int(round(y / R)) + pad:int(round((y + h) / R)) + pad, int(round(x / R)) + pad:int(round((x + w) / R)) + pad] = 1
    return out

def coarse_search(M, mpp_q, rots, R):
    """M: module mask at some reduction; mpp_q: metres per mask pixel to try; rots: degrees to try; R: metres per
    keyplan raster pixel. FFT cross-correlation of the mask with the sections (+1 inside, -1 outside)."""
    PAD = int(80 / R)
    K = np.where(sections_raster(R, PAD, MARKED) > 0, 1.0, -1.0).astype(np.float32)
    hm, wm = M.shape
    t = np.radians(max(abs(r) for r in rots)); f = max(mpp_q) / R
    big = (int((hm * np.cos(t) + wm * np.sin(t)) * f) + 4, int((wm * np.cos(t) + hm * np.sin(t)) * f) + 4)
    sh = (cv2.getOptimalDFTSize(K.shape[0] + big[0]), cv2.getOptimalDFTSize(K.shape[1] + big[1]))
    FK = np.fft.rfft2(K, sh)                            # the keyplan's transform, once for every scale and rotation
    best = None
    for s in mpp_q:
        for th in rots:
            A = cv2.getRotationMatrix2D((0, 0), th, s / R)
            c = np.array([[0, 0, 1], [wm, 0, 1], [0, hm, 1], [wm, hm, 1]], np.float32) @ A.T
            mn, mx = c.min(0), c.max(0); A[:, 2] -= mn
            ow, oh = int(np.ceil(mx[0] - mn[0])) + 1, int(np.ceil(mx[1] - mn[1])) + 1
            Mw = cv2.warpAffine(M, A, (ow, oh), flags=cv2.INTER_LINEAR)
            C = np.fft.irfft2(FK * np.fft.rfft2(Mw[::-1, ::-1], sh), sh)
            iy, ix = np.unravel_index(np.argmax(C), C.shape)
            if best is None or C[iy, ix] > best[0]:
                best = (C[iy, ix], s, th, A.copy(), ix - (ow - 1), iy - (oh - 1))
    val, s, th, A, ox, oy = best
    T = np.vstack([A, [0, 0, 1]])
    S = np.array([[R, 0, R * (ox - PAD)], [0, R, R * (oy - PAD)], [0, 0, 1]])
    return S @ T, s, th          # mask pixel -> metres

def installed(M4, F):
    """sections more than half covered by modules in the photo, under F"""
    R = 0.1
    Wk, Hk = int(KW / R) + 1, int(KH / R) + 1
    A = np.array([[1 / R, 0, -0.5], [0, 1 / R, -0.5], [0, 0, 1]]) @ F @ Q4
    Mw = cv2.warpAffine(M4, A[:2], (Wk, Hk), flags=cv2.INTER_LINEAR)
    out = set()
    for s in secs:
        x, y, w, h = s['geom']
        p = Mw[int(y / R):int((y + h) / R), int(x / R):int((x + w) / R)]
        if p.size and p.mean() > 0.5: out.add(s['id'])
    return out

def iou_refine(M4, F, inst=None):
    """refine F (full pixel centre -> metres) by maximising the overlap of the quarter-size mask with the sections"""
    from scipy.optimize import minimize
    R = 0.1
    Wk, Hk = int(KW / R) + 1, int(KH / R) + 1
    def warp(Fm):
        A = np.array([[1 / R, 0, -0.5], [0, 1 / R, -0.5], [0, 0, 1]]) @ Fm @ Q4
        return cv2.warpAffine(M4, A[:2], (Wk, Hk), flags=cv2.INTER_LINEAR)
    if inst is None: inst = MARKED or installed(M4, F)
    T = cv2.GaussianBlur(sections_raster(R, 0, inst)[:Hk, :Wk], (0, 0), 1.0)
    def cost(Fm):
        Mw = warp(Fm); i = float((Mw * T).sum()); return 1 - i / float(Mw.sum() + T.sum() - i)
    sc = math.hypot(F[0, 0], F[0, 1])
    Fs = lambda p: np.array([[p[0], p[1], p[2]], [-p[1], p[0], p[3]], [0, 0, 1]])
    p0 = np.array([F[0, 0], F[0, 1], F[0, 2], F[1, 2]]); st = np.array([sc * .002, sc * .002, .05, .05])
    r = minimize(lambda q: cost(Fs(p0 + q * st)), np.zeros(4), method='Powell', options={'xtol': 1e-3, 'ftol': 1e-6, 'maxfev': 3000})
    F1 = Fs(p0 + r.x * st)
    Fa = lambda p: np.array([[p[0], p[1], p[2]], [p[3], p[4], p[5]], [0, 0, 1]])
    pa = F1[:2].reshape(-1); sa = np.array([sc * .002, sc * .002, .05, sc * .002, sc * .002, .05])
    r2 = minimize(lambda q: cost(Fa(pa + q * sa)), np.zeros(6), method='Powell', options={'xtol': 1e-3, 'ftol': 1e-6, 'maxfev': 4000})
    F2 = Fa(pa + r2.x * sa)
    log('overlap refinement: 1-IoU %.4f -> similarity %.4f -> affine %.4f' % (cost(F), r.fun, r2.fun))
    return F2, inst

def residuals(M4, F, inst):
    """local shifts between the photo's tables and the installed sections, 30 m windows (metres)"""
    R = 0.05
    Wk, Hk = int(KW / R) + 1, int(KH / R) + 1
    A = np.array([[1 / R, 0, -0.5], [0, 1 / R, -0.5], [0, 0, 1]]) @ F @ Q4
    Mw = cv2.warpAffine(M4, A[:2], (Wk, Hk), flags=cv2.INTER_LINEAR)
    T = sections_raster(R, 0, inst)[:Hk, :Wk]
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
            if abs(dx) < 0.9 and abs(dy) < 0.9: out.append((dx, dy))
    if not out: return {}
    d = np.hypot(*np.array(out).T)
    return {'rms_m': round(float(np.sqrt((d ** 2).mean())), 3), 'median_m': round(float(np.median(d)), 3),
            'p90_m': round(float(np.percentile(d, 90)), 3), 'windows': len(out)}

def ref_mosaic(level):
    """the published photo of --ref-shot at one level, decrypted: (image BGR, alpha, metres per pixel, origin)"""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from PIL import Image
    s = None
    for name in ('photos.json', 'index.json'):           # photos.json lists every block (update 12); index.json is the older list
        fn = os.path.join(a.ref, 'drone', name)
        if os.path.exists(fn):
            s = ([x for x in json.load(open(fn))['shots'] if x['id'] == a.ref_shot] or [None])[0]
            if s: break
    if not s: sys.exit('photo %s is not listed in %s/drone' % (a.ref_shot, a.ref))
    aes = AESGCM(base64.b64decode(open(a.key).read().strip()))
    l = s['levels'][level]; T = s['tile']
    img = np.zeros((l['rows'] * T, l['cols'] * T, 4), np.uint8)
    for r in range(l['rows']):
        for c in range(l['cols']):
            if l['have'][r * l['cols'] + c] != '1': continue
            b = open(os.path.join(a.ref, s['path'], str(level), '%d_%d.bin' % (c, r)), 'rb').read()
            pim = Image.open(io.BytesIO(aes.decrypt(b[:12], b[12:], ('%s/%d/%d_%d' % (s['id'], level, c, r)).encode()))).convert('RGBA')
            img[r * T:(r + 1) * T, c * T:(c + 1) * T] = cv2.cvtColor(np.array(pim), cv2.COLOR_RGBA2BGRA)
    return img, l['mpp'], s['origin'], s

def sift_fit():
    """new photo -> published photo of the same block: SIFT + RANSAC affine at 0.2 m per pixel, then a check and
    correction from local shifts (phase correlation in 40 m windows) at 0.1 m per pixel"""
    sift = cv2.SIFT_create(nfeatures=40000)
    ref2, mpp2, org2, shot = ref_mosaic(2)
    sc = a.src_mpp / mpp2                              # the new photo reduced to about the published level's pixel size
    new = cv2.resize(src, (int(W0 * sc), int(H0 * sc)), interpolation=cv2.INTER_AREA)
    g1 = cv2.cvtColor(new, cv2.COLOR_BGRA2GRAY); g2 = cv2.cvtColor(ref2, cv2.COLOR_BGRA2GRAY)
    k1, d1 = sift.detectAndCompute(g1, (new[:, :, 3] > 0).astype(np.uint8))
    k2, d2 = sift.detectAndCompute(g2, (ref2[:, :, 3] > 0).astype(np.uint8))
    del new, g1, g2, ref2
    mt = cv2.BFMatcher(cv2.NORM_L2).knnMatch(d1, d2, k=2)
    good = [m for m, n in mt if m.distance < 0.75 * n.distance]
    p1 = np.float32([k1[m.queryIdx].pt for m in good]); p2 = np.float32([k2[m.trainIdx].pt for m in good])
    A, inl = cv2.estimateAffine2D(p1, p2, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=20000, confidence=0.999)
    inl = inl.ravel().astype(bool)
    Sn = np.array([[sc, 0, 0.5 * sc - 0.5], [0, sc, 0.5 * sc - 0.5], [0, 0, 1]])          # full pixel centre -> reduced
    D2 = np.array([[mpp2, 0, org2[0] + 0.5 * mpp2], [0, mpp2, org2[1] + 0.5 * mpp2], [0, 0, 1]])   # ref pixel -> metres
    F = D2 @ np.vstack([A, [0, 0, 1]]) @ Sn
    e = np.hypot(*(cv2.transform(p1[inl][None], A)[0] - p2[inl]).T) * mpp2
    log('SIFT at %.2f m/px: %d matches, %d inliers, inlier error median %.3f m' % (mpp2, len(good), inl.sum(), np.median(e)))
    q = {'matches': int(inl.sum())}
    # local shifts at 0.1 m per pixel: the new photo drawn in the published photo's grid with F
    ref1, mpp1, org1, _ = ref_mosaic(1)
    g_ref = cv2.cvtColor(ref1, cv2.COLOR_BGRA2GRAY).astype(np.float32); a_ref = ref1[:, :, 3] == 255
    del ref1
    half = cv2.resize(src, ((W0 + 1) // 2, (H0 + 1) // 2), interpolation=cv2.INTER_AREA)     # about 0.1 m per pixel
    S2 = np.array([[0.5, 0, -0.25], [0, 0.5, -0.25], [0, 0, 1]])                              # full centre -> half
    D1 = np.array([[mpp1, 0, org1[0] + 0.5 * mpp1], [0, mpp1, org1[1] + 0.5 * mpp1], [0, 0, 1]])
    def warped(Fm):
        M = S2 @ np.linalg.inv(Fm) @ D1                                                       # ref pixel -> half pixel
        w = cv2.warpAffine(half, M[:2], (g_ref.shape[1], g_ref.shape[0]), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=(0, 0, 0, 0))
        return cv2.cvtColor(w, cv2.COLOR_BGRA2GRAY).astype(np.float32), w[:, :, 3] == 255
    def shifts(Fm):
        g_new, a_new = warped(Fm)
        Wn, out = 400, []
        hann = cv2.createHanningWindow((Wn, Wn), cv2.CV_32F)
        for y in range(0, g_ref.shape[0] - Wn, Wn // 2):
            for x in range(0, g_ref.shape[1] - Wn, Wn // 2):
                if a_ref[y:y + Wn, x:x + Wn].mean() < 0.9 or a_new[y:y + Wn, x:x + Wn].mean() < 0.9: continue
                (dx, dy), resp = cv2.phaseCorrelate(g_new[y:y + Wn, x:x + Wn], g_ref[y:y + Wn, x:x + Wn], hann)
                if resp > 0.08 and abs(dx) < 20 and abs(dy) < 20: out.append((x + Wn / 2, y + Wn / 2, dx, dy))
        return np.array(out)
    sh = shifts(F)
    if len(sh) >= 6:
        src_pts = np.float32(sh[:, :2]); dst_pts = np.float32(sh[:, :2] + sh[:, 2:])
        C, inl2 = cv2.estimateAffine2D(src_pts, dst_pts, method=cv2.RANSAC, ransacReprojThreshold=1.5, maxIters=5000)
        # content at ref pixel c of the warped photo belongs at C(c): photo -> metres becomes D1 C D1^-1 F
        F = D1 @ np.vstack([C, [0, 0, 1]]) @ np.linalg.inv(D1) @ F
        sh2 = shifts(F)
        d = np.hypot(sh2[:, 2], sh2[:, 3]) * mpp1
        q.update({'windows': int(len(sh2)), 'median_m': round(float(np.median(d)), 3), 'p90_m': round(float(np.percentile(d, 90)), 3),
                  'rms_m': round(float(np.sqrt((d ** 2).mean())), 3)})
        log('local shifts at %.2f m/px in %d windows: median %.3f m, 90%% within %.3f m' % (mpp1, len(sh2), q['median_m'], q['p90_m']))
    else:
        log('too few windows for the local check (%d); keeping the SIFT fit' % len(sh))
    return F, q

# ---------------------------------------------------------------------------------------------
if a.ref:
    if not (a.ref_shot and a.key): sys.exit('--ref needs --ref-shot and --key')
    F, q = sift_fit(); q['method'] = 'features matched to the published photo ' + a.ref_shot
    if kp is not None:
        M4 = module_mask(reduce4(src)).astype(np.float32)
        inst = installed(M4, F); r = residuals(M4, F, inst)
        q['sections_check'] = r; q['installed_sections_seen'] = len(inst)
elif kp is not None:
    M4 = module_mask(reduce4(src)).astype(np.float32)
    log('module mask: %.1f%% of the photo' % (100 * M4.mean()))
    # stage 1 at 1/16 size over the whole range, stage 2 at 1/4 size around the best
    M16 = cv2.resize(M4, (M4.shape[1] // 4, M4.shape[0] // 4), interpolation=cv2.INTER_AREA)
    lo, hi = a.mpp
    F16, s16, th16 = coarse_search(M16, np.exp(np.arange(np.log(lo * 16), np.log(hi * 16) + 1e-9, 0.015)), np.arange(-a.rot, a.rot + 1e-9, 0.25), 0.8)
    log('stage 1 (1/16 size): %.4f m/px, %.2f deg' % (s16 / 16, th16))
    F4, s4, th4 = coarse_search(M4, np.exp(np.arange(np.log(s16 / 4) - 0.015, np.log(s16 / 4) + 0.015 + 1e-9, 0.003)), np.arange(th16 - 0.5, th16 + 0.5 + 1e-9, 0.1), 0.25)
    log('stage 2 (1/4 size): %.4f m/px, %.2f deg' % (s4 / 4, th4))
    F0 = F4 @ np.linalg.inv(Q4)                          # full pixel centre -> metres
    F, inst = iou_refine(M4, F0)
    q = residuals(M4, F, inst); q['method'] = 'installed modules matched to the keyplan sections'; q['installed_sections_used'] = len(inst)
else:
    sys.exit('give --kp (first photo of a block) or --ref/--ref-shot/--key (later photo)')

U, Sv, Vt = np.linalg.svd(F[:2, :2])
fit = {'F': F.tolist(), 'source': os.path.basename(a.src), 'size_px': [W0, H0],
       'scale_m_per_px': [round(float(Sv[0]), 6), round(float(Sv[1]), 6)], 'rotation_deg': round(float(np.degrees(np.arctan2(F[0, 1], F[0, 0]))), 4),
       'quality': q}
json.dump(fit, open(a.out, 'w'), indent=1)
log('fit written: %.4f m/px, rotation %.2f deg, quality %s' % (Sv.mean(), fit['rotation_deg'], json.dumps(q)))

if a.look and kp is not None:
    os.makedirs(a.look, exist_ok=True)
    img = src[:, :, :3]
    def crop(x0, y0, w, h, R, name):
        Wc, Hc = int(w / R), int(h / R)
        D = np.array([[R, 0, x0 + R / 2], [0, R, y0 + R / 2], [0, 0, 1]])
        out = cv2.warpAffine(img, (np.linalg.inv(F) @ D)[:2], (Wc, Hc), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=(255, 255, 255))
        for s in secs:
            x, y, ww, hh = s['geom']
            cv2.rectangle(out, (int(round((x - x0) / R * 8)), int(round((y - y0) / R * 8))), (int(round((x + ww - x0) / R * 8)), int(round((y + hh - y0) / R * 8))), (0, 0, 255), 1, cv2.LINE_AA, 3)
        cv2.imwrite(os.path.join(a.look, name), out, [cv2.IMWRITE_JPEG_QUALITY, 88])
    crop(-20, -20, KW + 40, KH + 40, 0.3, 'all.jpg')
    for i, (fx, fy) in enumerate([(0.3, 0.2), (0.7, 0.3), (0.3, 0.8), (0.7, 0.8), (0.5, 0.5)]):
        crop(KW * fx - 20, KH * fy - 15, 40, 30, 0.05, 'detail%d.jpg' % (i + 1))
    log('overlays in', a.look)
