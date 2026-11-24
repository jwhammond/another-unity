// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { artCache, comfyLockHeld, liveReady } from './cache';
import { withGenerator } from './comfy';
import { depthGraph, inpaintGraph, repaintGraph, txt2imgGraph, upscaleGraph, type Models, type Sampling } from './graphs';
import { decodePng } from './image';

const ready = liveReady();
const held = ready.ok && comfyLockHeld();
if (!ready.ok) console.info(`live-comfy skipped: ${ready.why}`);
if (held) console.info('live-comfy skipped: the ComfyUI lock (.comfy.lock) is held by another run');

const M: Models = {
  checkpoint: 'sd_xl_base_1.0.safetensors',
  vae: 'sdxl_vae_fp16_fix.safetensors',
  lora: { file: 'sdxl_lightning_8step_lora.safetensors', strength: 1 },
  upscaler: 'RealESRGAN_x4plus.pth',
  depth: { controlnet: 'controlnet_union_sdxl_promax.safetensors', annotator: 'depth_anything_v2_vits.pth', union: true },
  lineart: { controlnet: 'mistoline_fp16.safetensors', annotator: 'AnyLineArtPreprocessor_aux' },
  ipadapter: { style: 'ip-adapter-plus_sdxl_vit-h.safetensors', clipVision: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors' },
};
const S: Sampling = { seed: 1, steps: 4, cfg: 1.5, sampler: 'euler', scheduler: 'sgm_uniform' };

describe.skipIf(!ready.ok || held)('live ComfyUI', () => {
  it('every class_type the graphs use is in /object_info', async () => {
    const jobs = [
      txt2imgGraph(M, S, 'p', 'n', [64, 64]),
      repaintGraph(M, S, { prompt: 'p', negative: 'n', denoise: 0.3, size: [64, 64], depth: { strength: 1, end: 1 }, lineart: { strength: 1, end: 1 } }, 'a', 'b'),
      repaintGraph(M, S, { prompt: 'p', negative: 'n', denoise: 0.3, size: [64, 64], references: [{ params: { ipadapter: 'x', clipVision: 'y', weight: 0.5, weightType: 'style transfer' }, images: ['r1', 'r2'], startPercent: 0, endPercent: 1 }] }, 'a', 'b'),
      inpaintGraph(M, S, { prompt: 'p', negative: 'n', denoise: 0.7, growMask: 8 }, 'a', 'b'),
      upscaleGraph(M, 'a'),
      depthGraph('depth_anything_v2_vits.pth', 'a', 512),
    ];
    const used = new Set(jobs.flatMap(j => Object.values(j.graph).map(n => n.class_type)));
    const known = await withGenerator(artCache(), g => g.nodeTypes());
    expect([...used].filter(t => !known.has(t))).toEqual([]);
  }, 180_000);

  it('a 512x512 txt2img with a fixed seed makes a PNG of that size', async () => {
    const job = txt2imgGraph(M, S, 'a plain grey wall', 'text', [512, 512]);
    const out = await withGenerator(artCache(), g => g.run(job));
    const img = decodePng(out.image!);
    expect([img.width, img.height]).toEqual([512, 512]);
  }, 300_000);
});
