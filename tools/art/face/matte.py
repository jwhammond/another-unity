# SPDX-License-Identifier: GPL-3.0-or-later
"""Person mattes for art avatar's `grab` portrait: a soft alpha (rembg, a BiRefNet portrait model by default) and the foreground's own
colours under it (pymatting's multi-level foreground estimation), so the cut-out's hair and edges carry none of the old background.

Reads JSON on stdin: {"model": "birefnet-portrait", "images": [{"in": path, "alpha": path, "fg": path}]}. Writes each alpha as a
greyscale PNG and the foreground as an RGB PNG, both the input's size; prints {"done": n} to stdout. Deterministic (CPU onnxruntime).
Runs in the face venv (the user's ~/pcode/unity-art-cache/venv-face, with `rembg` and `pymatting` added). The models download on first
use into $U2NET_HOME (art avatar sets <cache>/models/rembg): BiRefNet (MIT) via rembg's GitHub releases.
"""
import json
import sys

import cv2
import numpy as np
from PIL import Image
from pymatting import estimate_foreground_ml
from rembg import new_session, remove

req = json.load(sys.stdin)
session = new_session(req.get("model", "birefnet-portrait"))
n = 0
for job in req["images"]:
    img = Image.open(job["in"]).convert("RGB")
    alpha = np.asarray(remove(img, session=session, only_mask=True, post_process_mask=False), dtype=np.float64) / 255.0
    rgb = np.asarray(img, dtype=np.float64) / 255.0
    fg = estimate_foreground_ml(rgb, alpha)
    cv2.imwrite(job["alpha"], np.clip(alpha * 255 + 0.5, 0, 255).astype(np.uint8))
    cv2.imwrite(job["fg"], cv2.cvtColor(np.clip(fg * 255 + 0.5, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
    n += 1
json.dump({"done": n}, sys.stdout)
