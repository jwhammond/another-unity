# SPDX-License-Identifier: GPL-3.0-or-later
"""Prints ComfyUI's own sampled sigmas and percent_to_sigma for SDXL, for pinning tools/art/src/sigmas.test.ts.
Run with the cache venv: ~/pcode/unity-art-cache/venv/bin/python tools/art/setup/sigmas_ref.py [ComfyUI dir]"""
import os, sys
comfy = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/pcode/unity-art-cache/ComfyUI')
sys.path.insert(0, comfy)
import comfy.samplers, comfy.model_sampling


import comfy.supported_models as supported
# SDXL's own sampling_settings (empty: ModelSamplingDiscrete's defaults, beta_schedule "linear" = squared-sqrt, 0.00085-0.012, 1000 steps)
Cfg = supported.SDXL


ms = comfy.model_sampling.ModelSamplingDiscrete(Cfg)


def sampled(steps, denoise, scheduler):
    # KSampler.set_steps: int(steps / denoise) steps, the last steps + 1 sigmas
    s = comfy.samplers.calculate_sigmas(ms, scheduler, int(steps / denoise))
    return s[-(steps + 1):].tolist()


print('sigmas[0], sigmas[-1]:', float(ms.sigmas[0]), float(ms.sigmas[-1]))
for d in (0.25, 0.5):
    print('sampled(30, %s, karras) =' % d, [round(x, 6) for x in sampled(30, d, 'karras')])
print('sampled(30, 0.5, normal) =', [round(x, 6) for x in sampled(30, 0.5, 'normal')])
for p in (0, 0.5, 0.8, 0.9, 1):
    print('percent_to_sigma(%s) =' % p, ms.percent_to_sigma(p))
