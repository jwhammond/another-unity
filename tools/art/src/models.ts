// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { ArtCache } from './cache';

export const ROLES = ['checkpoint', 'vae', 'lora', 'controlnet', 'upscaler', 'annotator', 'ipadapter', 'clip_vision', 'experimental'] as const;
/** Licences a model the game's art may use can have (R4). */
export const LICENCES = ['Apache-2.0', 'MIT', 'BSD-3-Clause', 'CC-BY-4.0', 'OpenRAIL-M', 'OpenRAIL++-M'] as const;
/** Non-commercial or gated licences: the user allows them for this personal project, on `experimental` models only (models.yaml's header). */
export const EXPERIMENTAL_LICENCES = ['FLUX.1-dev-Non-Commercial', 'InsightFace-Non-Commercial', 'Civitai-Non-Commercial', 'Civitai-Custom', 'Krea-2-Community'] as const;
/** The model families a repaint or card recipe can name (`model:`); sdxl is the default and uses `selected`. */
export const FAMILIES = ['sdxl', 'qwen-image', 'flux'] as const;
export type Family = (typeof FAMILIES)[number];
/** What an experimental file is for: a repaint recipe's family, or krea2 (Krea 2 Turbo: an avatar variant's model only). */
export const MODEL_FAMILIES = [...FAMILIES, 'krea2'] as const;

const INSIGHTFACE = /faceid|instantid|insightface|photomaker/i;

export const modelSchema = z
  .object({
    role: z.enum(ROLES),
    /** Relative to the cache's models/: ComfyUI's folder for the role, then the file. */
    // annotators/ may nest (<repo>/<subfolder>/<file>): that is the layout comfyui_controlnet_aux looks for.
    file: z
      .string()
      .regex(/^(?:(?:checkpoints|vae|loras|controlnet|upscale_models|ipadapter|clip_vision|diffusion_models|text_encoders|style_models)\/[^/]+|annotators(?:\/[^/]+)+)$/)
      .refine(f => !f.split('/').some(seg => seg === '..' || seg === '.'), 'no . or .. segments'),
    url: z.string().url(),
    /** 'pending' until the first fetch records it; after that, a mismatch refuses the file. */
    sha256: z.union([z.string().regex(/^[0-9a-f]{64}$/), z.literal('pending')]),
    licence: z.enum([...LICENCES, ...EXPERIMENTAL_LICENCES]),
    licenceUrl: z.string().url(),
    /** Why it is a candidate, and what the benchmark found. */
    note: z.string().optional(),
    /** An experimental model's family (role `experimental` only). */
    family: z.enum(MODEL_FAMILIES).optional(),
    /**
     * The file lives only on the COMFY_URL server: it is never fetched here, and its sha256 (from Hugging Face's LFS oid) can't be
     * checked against a local file, only recorded. The server's loader lists it by name.
     */
    remoteOnly: z.boolean().optional(),
  })
  .strict()
  // InsightFace's weights are non-commercial: the user allows the FaceID family for this personal project (2026-10-19), as experimental
  // models only, so the published art's allow-list never names one (a model saved under an innocent name is still known by its URL)
  .refine(m => m.role === 'experimental' || !INSIGHTFACE.test(m.file) && !INSIGHTFACE.test(m.url), { message: 'FaceID, InstantID and other InsightFace-based models are experimental only (non-commercial weights)', path: ['role'] })
  .refine(m => m.role === 'experimental' || (LICENCES as readonly string[]).includes(m.licence), m => ({ message: `licence ${m.licence} is allowed for role experimental only`, path: ['licence'] }))
  .refine(m => m.role !== 'experimental' || m.family !== undefined, { message: 'an experimental model names its family', path: ['family'] })
  .refine(m => m.role === 'experimental' || (!m.family && !m.remoteOnly), { message: 'family and remoteOnly are for experimental models', path: ['role'] })
  .refine(m => !m.file.startsWith('annotators/') || m.role === 'annotator', { message: 'an experimental model is a loader file, not an annotator', path: ['file'] });

export const modelsFileSchema = z
  .object({
    models: z.record(modelSchema),
    /** Task 3's choice per job; every key names a model above. */
    selected: z
      .object({
        checkpoint: z.string(),
        vae: z.string().optional(),
        lora: z.string().optional(),
        depth: z.string(),
        lineart: z.string(),
        depthAnnotator: z.string(),
        lineartAnnotator: z.string(),
        upscaler: z.string(),
        /** Plan 15 R4: the IP-Adapter for rooms (style) and crew (face), and the CLIP vision encoder both need. */
        ipadapterStyle: z.string().optional(),
        ipadapterFace: z.string().optional(),
        clipVision: z.string().optional(),
        /** ComfyUI flags the benchmark chose, e.g. --force-fp16. */
        comfyFlags: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ModelsFile = z.infer<typeof modelsFileSchema>;
export type Model = ModelsFile['models'][string];

export function loadModels(text: string): ModelsFile {
  const file = modelsFileSchema.parse(parseYaml(text));
  for (const [job, key] of Object.entries(file.selected ?? {})) {
    if (typeof key === 'string' && !(key in file.models)) throw new Error(`selected.${job} names "${key}", which is not in models`);
    if (typeof key === 'string' && file.models[key]!.role === 'experimental') throw new Error(`selected.${job} names "${key}", an experimental model: experimental models are named by a recipe's \`model\` family only`);
  }
  return file;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', c => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** Downloads to <models>/<file>.part, hashes it while streaming, then renames; refuses a mismatch with a recorded hash. */
export async function fetchModel(
  cache: ArtCache,
  id: string,
  m: Model,
  fetchFn: typeof fetch = fetch,
): Promise<{ sha256: string; bytes: number }> {
  const dest = join(cache.models, m.file);
  const part = `${dest}.part`;
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetchFn(m.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${id}: ${m.url} answered ${res.status}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (c: Buffer) => {
    hash.update(c);
    bytes += c.length;
  });
  try {
    await pipeline(body, createWriteStream(part));
    const sha256 = hash.digest('hex');
    if (m.sha256 !== 'pending' && m.sha256 !== sha256) {
      throw new Error(`${id}: sha256 ${sha256} does not match the recorded ${m.sha256}`);
    }
    await rename(part, dest);
    return { sha256, bytes };
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
}
