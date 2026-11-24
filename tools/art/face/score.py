# SPDX-License-Identifier: GPL-3.0-or-later
"""Likeness scores for art avatar: InsightFace (buffalo_l) embeddings, cosine similarity.

Reads JSON on stdin: {"target": [paths], "others": {"name": [paths]}, "images": [path | [path, guide]]}. For each image, the largest face's
embedding is compared with every target face (the held-out reference frames): `sim` is the mean cosine similarity. `margin` is
`sim` minus the highest mean similarity to any one of the other people. Writes {"images": {path: {...} | null}} to stdout (null:
no face found). An image given as [path, guide] is embedded at the face the detector finds in `guide` (the same picture before
pixelation, scaled to the same size): the detector does not find faces in a 64-pixel grid, the recognition model still reads them.
With {"boxes": [paths]} instead, it writes {"boxes": {path: [x0, y0, x1, y1] | null}}: each picture's largest face box in its own
pixels (the avatar's face-detail pass crops there).
Runs in its own venv (the user's ~/pcode/unity-art-cache/venv-face: insightface, onnxruntime, opencv-python-headless); InsightFace's
weights are non-commercial, allowed for this personal project only (art/models.yaml).
"""
import json
import sys

import cv2
import numpy as np
from insightface.app import FaceAnalysis

app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"], allowed_modules=["detection", "recognition"])
app.prepare(ctx_id=-1, det_size=(640, 640))


def read(path, size=None):
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    if size is None and min(img.shape[:2]) < 512:
        size = (512, 512)
    if size is not None and img.shape[:2] != (size[1], size[0]):
        img = cv2.resize(img, size, interpolation=cv2.INTER_LINEAR)
    # a face filling the frame is missed by the detector: room around it
    pad = img.shape[0] // 4
    return cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_REPLICATE)


def largest(img):
    faces = app.get(img)
    return max(faces, key=lambda x: (x.bbox[2] - x.bbox[0]) * (x.bbox[3] - x.bbox[1])) if faces else None


def embed(spec):
    if isinstance(spec, list):
        path, guide = spec
        g = cv2.imread(guide)
        face = largest(read(guide, (g.shape[1], g.shape[0])))
        if face is None:
            return None
        img = read(path, (g.shape[1], g.shape[0]))
        app.models["recognition"].get(img, face)
        return face.normed_embedding
    face = largest(read(spec))
    return face.normed_embedding if face is not None else None


def need(paths):
    out = [e for e in (embed(p) for p in paths) if e is not None]
    if not out:
        raise SystemExit(f"no face in any of {paths}")
    return np.stack(out)


def box(path):
    img = cv2.imread(path)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    h, w = img.shape[:2]
    # read()'s size and padding, undone
    rw, rh = (512, 512) if min(h, w) < 512 else (w, h)
    pad = rh // 4
    face = largest(read(path))
    if face is None:
        return None
    x0, y0, x1, y1 = (float(v) for v in face.bbox)
    return [round((x0 - pad) * w / rw, 1), round((y0 - pad) * h / rh, 1), round((x1 - pad) * w / rw, 1), round((y1 - pad) * h / rh, 1)]


req = json.load(sys.stdin)
if "boxes" in req:
    json.dump({"boxes": {p: box(p) for p in req["boxes"]}}, sys.stdout)
    sys.exit(0)
target = need(req["target"])
others = {k: need(v) for k, v in req["others"].items()}
res = {}
for spec in req["images"]:
    p = spec[0] if isinstance(spec, list) else spec
    e = embed(spec)
    if e is None:
        res[p] = None
        continue
    sim = float(np.mean(target @ e))
    other = {k: float(np.mean(v @ e)) for k, v in others.items()}
    best = max(other, key=other.get) if other else None
    res[p] = {"sim": round(sim, 4), "margin": round(sim - (other[best] if best else 0.0), 4), "nearestOther": best}
json.dump({"images": res}, sys.stdout)
