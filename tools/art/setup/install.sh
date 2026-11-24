#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# The local art stack (Plan 14 Task 1). Idempotent. Never uses sudo: if anything asks for a password, stop and ask.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/pins.env"          # PYTHON_VERSION, COMFYUI_REPO, COMFYUI_COMMIT, AUX_REPO, AUX_COMMIT, IPADAPTER_REPO, IPADAPTER_COMMIT
ART_CACHE=${ART_CACHE:-$HOME/pcode/unity-art-cache}
command -v brew >/dev/null || { echo 'Homebrew is missing: ask the controller' >&2; exit 2; }
[ -x /Applications/Blender.app/Contents/MacOS/Blender ] || brew install --cask blender </dev/null
command -v uv >/dev/null || brew install uv </dev/null
mkdir -p "$ART_CACHE/models/checkpoints" "$ART_CACHE/models/vae" "$ART_CACHE/models/loras" \
  "$ART_CACHE/models/controlnet" "$ART_CACHE/models/upscale_models" "$ART_CACHE/models/ipadapter" "$ART_CACHE/models/clip_vision" "$ART_CACHE/models/annotators" \
  "$ART_CACHE/comfy-io/input" "$ART_CACHE/comfy-io/output" "$ART_CACHE/work" "$ART_CACHE/bench"
uv python install "$PYTHON_VERSION"
[ -x "$ART_CACHE/venv/bin/python" ] || uv venv --python "$PYTHON_VERSION" "$ART_CACHE/venv"
clone() { [ -d "$2/.git" ] || git clone --quiet "$1" "$2"; git -C "$2" fetch --quiet --tags; git -C "$2" checkout --quiet "$3"; }
clone "$COMFYUI_REPO" "$ART_CACHE/ComfyUI" "$COMFYUI_COMMIT"
aux="$ART_CACHE/ComfyUI/custom_nodes/comfyui_controlnet_aux"
clone "$AUX_REPO" "$aux" "$AUX_COMMIT"
# GPL-3.0: a local server node in the cache, never vendored into this repo
clone "$IPADAPTER_REPO" "$ART_CACHE/ComfyUI/custom_nodes/ComfyUI_IPAdapter_plus" "$IPADAPTER_COMMIT"
sed "s|@ART_CACHE@|$ART_CACHE|g" "$here/extra_model_paths.yaml.in" > "$ART_CACHE/extra_model_paths.yaml"
# the aux nodes read their annotator weights from here
sed "s|^annotator_ckpts_path:.*|annotator_ckpts_path: \"$ART_CACHE/models/annotators\"|" "$aux/config.example.yaml" > "$aux/config.yaml"
export VIRTUAL_ENV="$ART_CACHE/venv"
if [ "${1:-}" = --bootstrap ]; then
  # first install only: the newest that resolve, then frozen into requirements.txt for review and commit
  uv pip install torch torchvision torchaudio -r "$ART_CACHE/ComfyUI/requirements.txt" -r "$aux/requirements.txt"
  uv pip freeze > "$here/requirements.txt"
else
  uv pip install -r "$here/requirements.txt"
fi
"$ART_CACHE/venv/bin/python" -c 'import torch; assert torch.backends.mps.is_available(), "no MPS"; print("torch", torch.__version__, "mps ok")'
