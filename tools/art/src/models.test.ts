// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artCache, type ArtCache } from './cache';
import { fetchModel, loadModels, type Model } from './models';

const SHA = 'a'.repeat(64);
const base = (over: Record<string, unknown> = {}) => ({
  role: 'checkpoint',
  file: 'checkpoints/x.safetensors',
  url: 'https://example.com/x',
  sha256: 'pending',
  licence: 'MIT',
  licenceUrl: 'https://example.com/licence',
  ...over,
});
const yamlOf = (models: Record<string, unknown>, extra = '') =>
  `models:\n${Object.entries(models)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n${extra}`;

describe('loadModels', () => {
  it('parses a models file and refuses an unknown role, a licence outside the list, or a file outside its role\'s folder', () => {
    expect(loadModels(yamlOf({ a: base() })).models.a!.licence).toBe('MIT');
    expect(() => loadModels(yamlOf({ a: base({ role: 'wizard' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ licence: 'other' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ licence: 'GPL-3.0' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ file: 'elsewhere/x.safetensors' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ file: 'checkpoints/../x' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ sha256: 'abc' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ role: 'annotator', file: 'annotators/o/r/f.pth' }) }))).not.toThrow();
    expect(() => loadModels(yamlOf({ a: base({ role: 'annotator', file: 'annotators/../x.pth' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ file: 'checkpoints/a/b.safetensors' }) }))).toThrow();
  });

  it('accepts ipadapter and clip_vision files and takes a FaceID file name as experimental only', () => {
    expect(() => loadModels(yamlOf({ a: base({ role: 'ipadapter', file: 'ipadapter/ip-adapter-plus_sdxl_vit-h.safetensors' }) }))).not.toThrow();
    expect(() => loadModels(yamlOf({ a: base({ role: 'clip_vision', file: 'clip_vision/enc.safetensors' }) }))).not.toThrow();
    expect(() => loadModels(yamlOf({ a: base({ role: 'ipadapter', file: 'ipadapter/ip-adapter-faceid-plusv2_sdxl.bin' }) }))).toThrow(/experimental only/);
    expect(() => loadModels(yamlOf({ a: base({ role: 'ipadapter', file: 'ipadapter/InstantID_ip-adapter.bin' }) }))).toThrow(/experimental only/);
    const face = base({ role: 'experimental', family: 'sdxl', remoteOnly: true, file: 'ipadapter/ip-adapter-faceid-plusv2_sdxl.bin', licence: 'InsightFace-Non-Commercial' });
    expect(loadModels(yamlOf({ a: face })).models.a!.licence).toBe('InsightFace-Non-Commercial');
    expect(() => loadModels(yamlOf({ a: base({ role: 'ipadapter', file: 'ipadapter/ip-adapter-faceid-plusv2_sdxl.bin', licence: 'InsightFace-Non-Commercial' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: base({ role: 'ipadapter', file: 'ipadapter/ip-adapter-plus-face_sdxl_vit-h.safetensors' }) }))).not.toThrow();
  });

  it('knows a FaceID model saved under an innocent name by its URL', () => {
    const url = 'https://huggingface.co/h94/IP-Adapter-FaceID/resolve/main/ip-adapter-faceid-plusv2_sdxl.bin';
    expect(() => loadModels(yamlOf({ a: base({ role: 'ipadapter', file: 'ipadapter/face.bin', url }) }))).toThrow(/experimental only/);
  });

  it('refuses `selected` naming a model that isn\'t listed', () => {
    const sel = (upscaler: string) =>
      `selected: {checkpoint: a, depth: a, lineart: a, depthAnnotator: a, lineartAnnotator: a, upscaler: ${upscaler}}\n`;
    expect(loadModels(yamlOf({ a: base() }, sel('a'))).selected!.upscaler).toBe('a');
    expect(() => loadModels(yamlOf({ a: base() }, sel('ghost')))).toThrow(/ghost/);
  });

  it('takes non-commercial licences and remote-only files for role experimental only, each with its family', () => {
    const exp = (over: Record<string, unknown> = {}) => base({ role: 'experimental', family: 'flux', remoteOnly: true, file: 'diffusion_models/f.safetensors', licence: 'FLUX.1-dev-Non-Commercial', ...over });
    expect(loadModels(yamlOf({ a: exp() })).models.a!.remoteOnly).toBe(true);
    expect(() => loadModels(yamlOf({ a: exp({ file: 'text_encoders/t5.safetensors', licence: 'Apache-2.0' }) }))).not.toThrow();
    expect(() => loadModels(yamlOf({ a: exp({ file: 'style_models/r.safetensors' }) }))).not.toThrow();
    // the allow-list still governs every other role
    expect(() => loadModels(yamlOf({ a: base({ licence: 'FLUX.1-dev-Non-Commercial' }) }))).toThrow(/experimental only/);
    expect(() => loadModels(yamlOf({ a: base({ remoteOnly: true }) }))).toThrow(/experimental/);
    expect(() => loadModels(yamlOf({ a: exp({ family: undefined }) }))).toThrow(/family/);
    expect(() => loadModels(yamlOf({ a: exp({ family: 'sd3' }) }))).toThrow();
    expect(() => loadModels(yamlOf({ a: exp({ family: 'krea2', file: 'loras/k.safetensors', licence: 'Civitai-Custom' }) }))).not.toThrow();
    expect(() => loadModels(yamlOf({ a: exp({ file: 'annotators/x/y.pth' }) }))).toThrow(/annotator/);
    expect(() => loadModels(yamlOf({ a: exp({ licence: 'other' }) }))).toThrow();
    // and no `selected` job may name one
    const sel = 'selected: {checkpoint: a, depth: a, lineart: a, depthAnnotator: a, lineartAnnotator: a, upscaler: a}\n';
    expect(() => loadModels(yamlOf({ a: exp() }, sel))).toThrow(/experimental/);
  });

  it('the committed art/models.yaml parses, with every experimental entry hashed and remote-only but the local FaceID files', async () => {
    const text = await readFile(join(__dirname, '..', '..', '..', 'art', 'models.yaml'), 'utf8');
    const exp = Object.values(loadModels(text).models).filter(m => m.role === 'experimental');
    expect(exp.length).toBe(19);
    for (const m of exp) {
      // the FaceID family (sdxl) is fetched and hash-checked locally: the remote server's insightface did not import
      const civitai = m.licence.startsWith('Civitai-');
      expect(m.remoteOnly).toBe(m.family === 'sdxl' && !civitai ? undefined : true);
      if (m.family === 'sdxl' && !civitai) expect(m.licence).toBe('InsightFace-Non-Commercial');
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('the committed art/models.yaml parses', async () => {
    const text = await readFile(join(__dirname, '..', '..', '..', 'art', 'models.yaml'), 'utf8');
    expect(Object.keys(loadModels(text).models).length).toBeGreaterThan(5);
  });
});

describe('fetchModel', () => {
  let dir: string;
  let cache: ArtCache;
  const bytes = Buffer.from('fake weights');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const fakeFetch = (async () => new Response(bytes, { status: 200 })) as typeof fetch;
  const model = (sha256: string): Model => base({ sha256 }) as Model;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'art-models-'));
    cache = artCache({ ART_CACHE: dir });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('streams to .part, renames, and returns the sha256 (fake fetch, temp dir)', async () => {
    const r = await fetchModel(cache, 'a', model('pending'), fakeFetch);
    expect(r).toEqual({ sha256: sha, bytes: bytes.length });
    expect(await readFile(join(cache.models, 'checkpoints/x.safetensors'))).toEqual(bytes);
    expect(await readdir(join(cache.models, 'checkpoints'))).toEqual(['x.safetensors']);
    expect((await fetchModel(cache, 'a', model(sha), fakeFetch)).sha256).toBe(sha);
  });

  it('refuses a file whose sha256 differs from the recorded one, and leaves no file', async () => {
    await expect(fetchModel(cache, 'a', model(SHA), fakeFetch)).rejects.toThrow(/does not match/);
    expect(await readdir(join(cache.models, 'checkpoints'))).toEqual([]);
    await expect(stat(join(cache.models, 'checkpoints/x.safetensors'))).rejects.toThrow();
  });
});
