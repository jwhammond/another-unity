// SPDX-License-Identifier: GPL-3.0-or-later
import { basename } from 'node:path';
import type { Models } from './graphs';
import type { ModelsFile } from './models';

/** The lineart annotators' ComfyUI nodes, by model key (the weights are found by the aux node itself). */
export const LINEART_NODES: Record<string, string> = {
  'anyline-mteed': 'AnyLineArtPreprocessor_aux',
};
const UNION_KEYS = new Set(['cn-union-sdxl']);

const name = (file: ModelsFile, key: string): string => {
  const m = file.models[key];
  if (!m) throw new Error(`no model "${key}" in art/models.yaml`);
  return basename(m.file);
};

export interface Choice {
  checkpoint: string;
  vae?: string;
  lora?: string;
  depth: string;
  lineart: string;
  depthAnnotator: string;
  lineartAnnotator: string;
  upscaler: string;
  ipadapterStyle?: string;
  ipadapterFace?: string;
  clipVision?: string;
  comfyFlags?: string[];
}

/** Turns model keys into the names ComfyUI lists. */
export function modelsFor(file: ModelsFile, c: Choice, loraStrength = 1): Models {
  const lineNode = LINEART_NODES[c.lineartAnnotator];
  if (!lineNode) throw new Error(`no ComfyUI node known for the lineart annotator "${c.lineartAnnotator}"`);
  return {
    checkpoint: name(file, c.checkpoint),
    vae: c.vae ? name(file, c.vae) : undefined,
    lora: c.lora ? { file: name(file, c.lora), strength: loraStrength } : undefined,
    upscaler: name(file, c.upscaler),
    depth: { controlnet: name(file, c.depth), annotator: name(file, c.depthAnnotator), union: UNION_KEYS.has(c.depth) },
    lineart: { controlnet: name(file, c.lineart), annotator: lineNode, union: UNION_KEYS.has(c.lineart) },
    ipadapter: c.clipVision
      ? { style: c.ipadapterStyle ? name(file, c.ipadapterStyle) : undefined, face: c.ipadapterFace ? name(file, c.ipadapterFace) : undefined, clipVision: name(file, c.clipVision) }
      : undefined,
  };
}

/** The benchmark's choice if `selected` is set, else the plain defaults (SDXL base, its VAE fix, Real-ESRGAN, the union ControlNet). */
export function defaultChoice(file: ModelsFile): Choice {
  return (
    file.selected ?? {
      checkpoint: 'sdxl-base-1.0',
      vae: 'sdxl-vae-fp16-fix',
      depth: 'cn-union-sdxl',
      lineart: 'cn-union-sdxl',
      depthAnnotator: 'depth-anything-v2-small',
      lineartAnnotator: 'anyline-mteed',
      upscaler: 'realesrgan-x4plus',
    }
  );
}
