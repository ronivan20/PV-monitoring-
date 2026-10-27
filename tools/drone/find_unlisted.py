"""Installed PV modules on a drone photo that are outside every keyplan section (tables the keyplan may be missing).

The photo's dark blue-grey module areas (as in align.py) are drawn in keyplan metres with the fit; whatever lies more
than 1.5 m away from every section and covers at least --min-area m2 is listed (inside the keyplan sheet plus
--margin metres). Trees and deep shadows can also be listed: check every result on the photo.

usage: python3 -I find_unlisted.py --src photo.png --fit fit.json --kp kp.json [--margin 5] [--min-area 60] [--out list.json]
"""
import argparse, json
import numpy as np, cv2

ap = argparse.ArgumentParser()
ap.add_argument('--src', required=True)
ap.add_argument('--fit', required=True)
ap.add_argument('--kp', required=True)
ap.add_argument('--margin', type=float, default=5.0, help='metres around the keyplan sheet to search')
ap.add_argument('--min-area', type=float, default=60.0, help='smallest module area listed, m2 (one section is about 100 m2)')
ap.add_argument('--out')
a = ap.parse_args()

F = np.array(json.load(open(a.fit))['F'], float)
d = json.load(open(a.kp)); secs = d['secs']; KW, KH = float(d['kp']['width']), float(d['kp']['height'])
src = cv2.imread(a.src, cv2.IMREAD_UNCHANGED)
if src.shape[2] == 3: src = cv2.cvtColor(src, cv2.COLOR_BGR2BGRA)
ph, pw = (-src.shape[0]) % 4, (-src.shape[1]) % 4
if ph or pw: src = cv2.copyMakeBorder(src, 0, ph, 0, pw, cv2.BORDER_REPLICATE)
q = cv2.resize(src, (src.shape[1] // 4, src.shape[0] // 4), interpolation=cv2.INTER_AREA)
del src
bgr = q[:, :, :3].astype(np.int16); alpha = q[:, :, 3] > 200
b, g, r = bgr[:, :, 0], bgr[:, :, 1], bgr[:, :, 2]; v = bgr.max(axis=2); sat = v - bgr.min(axis=2)
m = ((v < 120) & (b >= r) & (b >= g - 6) & (sat < 80) & alpha).astype(np.uint8)
m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)); m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
Q4 = np.array([[4, 0, 1.5], [0, 4, 1.5], [0, 0, 1.0]]); R = 0.1; M = a.margin
Wk, Hk = int((KW + 2 * M) / R), int((KH + 2 * M) / R)
A = np.array([[1 / R, 0, M / R - 0.5], [0, 1 / R, M / R - 0.5], [0, 0, 1]]) @ F @ Q4
Mw = cv2.warpAffine(m.astype(np.float32), A[:2], (Wk, Hk), flags=cv2.INTER_LINEAR) > 0.5
S = np.zeros((Hk, Wk), np.uint8)
for s in secs:
    x, y, w, h = s['geom']
    S[int((y + M) / R):int((y + h + M) / R), int((x + M) / R):int((x + w + M) / R)] = 1
S = cv2.dilate(S, np.ones((15, 15), np.uint8))
rest = cv2.morphologyEx((Mw & (S == 0)).astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
n, lab, st, cen = cv2.connectedComponentsWithStats(rest, 8)
found = []
for i in range(1, n):
    x, y, w, h, area = st[i]
    if area * R * R < a.min_area: continue
    found.append({'x_m': round(float(x * R - M), 1), 'y_m': round(float(y * R - M), 1), 'w_m': round(float(w * R), 1),
                  'h_m': round(float(h * R), 1), 'area_m2': round(float(area * R * R), 1)})
found.sort(key=lambda f: (f['y_m'], f['x_m']))
for f in found: print(f)
print('%d areas with modules outside the sections' % len(found))
if a.out: json.dump(found, open(a.out, 'w'), indent=1)
