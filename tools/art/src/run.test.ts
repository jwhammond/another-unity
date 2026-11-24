// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWarp } from './warp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { artCache, type ArtCache } from './cache';
import { areaResize, decodePng, encodePng, type Rgba } from './image';
import { loadModels } from './models';
import { parseRecipe } from './recipe';
import { checkPins, runRecipe, verifyRecipe, type RunDeps } from './run';
import { defaultChoice } from './select';
import { FakeGenerator } from './testing/fakeGenerator';

// (these write real PNGs: under load the default 5 s is too short)
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const FILES: Record<string, [string, string, string]> = {
  ck: ['checkpoint', 'checkpoints/ck.safetensors', 'CK'],
  vae: ['vae', 'vae/v.safetensors', 'VAE'],
  cn: ['controlnet', 'controlnet/cn.safetensors', 'CN'],
  dep: ['annotator', 'annotators/o/r/d.pth', 'DEP'],
  'anyline-mteed': ['annotator', 'annotators/o/r/l.pth', 'LINE'],
  up: ['upscaler', 'upscale_models/up.pth', 'UP'],
  ips: ['ipadapter', 'ipadapter/ips.safetensors', 'IPS'],
  cv: ['clip_vision', 'clip_vision/cv.safetensors', 'CV'],
};
const modelsYaml = (): string =>
  `models:\n${Object.entries(FILES)
    .map(([k, [role, file, body]]) => `  ${k}: {role: ${role}, file: ${file}, url: "https://example.com/${k}", sha256: "${sha(body)}", licence: MIT, licenceUrl: "https://example.com/l"}`)
    .join('\n')}\nselected: {checkpoint: ck, vae: vae, depth: cn, lineart: cn, depthAnnotator: dep, lineartAnnotator: anyline-mteed, upscaler: up, ipadapterStyle: ips, clipVision: cv}\n`;
const RECIPE = `id: t.s01
kind: repaint
source: { background: s_0001 }
sampling: { seed: 9, steps: 5, cfg: 4.5, sampler: euler, scheduler: normal }
prompt: a room
denoise: 0.3
depth: { strength: 0.6, end: 0.9 }
post: [ { depth: {} } ]
`;
const ALIGN_RECIPE = RECIPE.replace('{ depth: {} }', '{ depth: {} }, { align: {} }');

let tmp: string;
let cache: ArtCache;
let deps: RunDeps;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'art-run-'));
  cache = artCache({ ART_CACHE: join(tmp, 'cache') });
  for (const [, file, body] of Object.values(FILES)) {
    await mkdir(join(cache.models, file, '..'), { recursive: true });
    await writeFile(join(cache.models, file), body);
  }
  const images = join(tmp, 'media');
  await mkdir(join(images, 'images', 'backgrounds'), { recursive: true });
  await writeFile(join(images, 'images', 'manifest.json'), JSON.stringify({ backgrounds: [{ screen: 's_0001', png: 'images/backgrounds/s_0001.png' }] }));
  await writeFile(join(images, 'images', 'backgrounds', 's_0001.png'), encodePng({ width: 640, height: 480, data: new Uint8Array(640 * 480 * 4).fill(60) }));
  await writeFile(join(tmp, 'pins.env'), 'COMFYUI_COMMIT=abc123\n');
  deps = { generator: new FakeGenerator(), models: loadModels(modelsYaml()), cache, imagesDir: images, pinsFile: join(tmp, 'pins.env'), comfyCommit: async () => 'abc123', now: () => 1_700_000_000_000 };
});
/** 640x480 with a few high-contrast rectangles. */
function drawn(): Rgba {
  const data = new Uint8Array(640 * 480 * 4).fill(90);
  for (let i = 0; i < 640 * 480; i++) data[i * 4 + 3] = 255;
  for (const [x0, y0, x1, y1, v] of [[100, 100, 220, 200, 230], [300, 60, 380, 260, 20], [60, 320, 180, 420, 200]] as const) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.fill(v, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3);
  }
  return { width: 640, height: 480, data };
}
const POINTS = [[100, 100], [220, 200], [300, 60], [380, 260], [60, 320], [180, 420]].map(([x, y], i) => ({ x: x!, y: y!, source: `p${i}` }));
/** Answers every output with the drawn scene at the size asked for, so the plate is the original and lines up. */
class SceneGenerator extends FakeGenerator {
  override async run(job: Parameters<FakeGenerator['run']>[0]): Promise<Record<string, Uint8Array>> {
    const out = await super.run(job);
    for (const [k, png] of Object.entries(out)) {
      const d = decodePng(png);
      out[k] = encodePng(areaResize(drawn(), d.width, d.height));
    }
    return out;
  }
}
afterEach(() => rm(tmp, { recursive: true, force: true }));

const recipe = () => parseRecipe(RECIPE, '/x/t.s01.yaml');

describe('runRecipe', () => {
  it('writes the plate, the intermediates and meta.json into a fresh run directory, and updates last.json', async () => {
    const { dir, meta } = await runRecipe(recipe(), RECIPE, deps);
    expect(dir.startsWith(join(cache.work, 't.s01'))).toBe(true);
    for (const f of ['plate', 'upscaled', 'work', 'repainted', 'depth']) {
      const d = decodePng(new Uint8Array(await readFile(join(dir, `${f}.png`))));
      expect(d.width).toBeGreaterThan(0);
    }
    expect(meta.outputs.plate).toMatchObject({ width: 2560, height: 1920 });
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toEqual(meta);
    expect(JSON.parse(await readFile(join(cache.work, 't.s01', 'last.json'), 'utf8')).dir).toBe(dir);
  });

  it("records every model's file and sha256, the recipe's sha256, ComfyUI's commit-checked version and the flags", async () => {
    const { meta } = await runRecipe(recipe(), RECIPE, { ...deps, flags: ['--force-fp16'] });
    expect(meta.models.ck).toEqual({ file: 'checkpoints/ck.safetensors', sha256: sha('CK') });
    expect(Object.keys(meta.models).sort()).toEqual(['anyline-mteed', 'ck', 'cn', 'dep', 'up', 'vae']);
    expect(meta.recipeSha256).toBe(sha(RECIPE));
    expect(meta.flags).toEqual(['--force-fp16']);
    expect(meta.comfyui).toBe('fake');
  });

  it('records each ControlNet\'s window and the fraction of the sampled steps it was active on', async () => {
    const { meta } = await runRecipe(recipe(), RECIPE, deps);
    expect(meta.controls).toHaveLength(1);
    expect(meta.controls![0]).toMatchObject({ name: 'depth', strength: 0.6, start: 0, end: 0.9 });
    expect(meta.controls![0]!.activeFraction).toBeGreaterThan(0.5);
    expect(meta.controls![0]!.activeFraction).toBeLessThanOrEqual(1);
  });

  describe('references', () => {
    const REF = `${RECIPE}reference:\n  - { refs: [set.x.1, set.x.2], model: style, weight: 0.6, weightType: style transfer }\n`;
    const refRecipe = (text = REF) => parseRecipe(text, '/x/t.s01.yaml', new Set(['set.x.1', 'set.x.2']));
    const crop = (v: number): Uint8Array => encodePng({ width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(v) });
    beforeEach(async () => {
      await mkdir(join(cache.root, 'refs', 'crops'), { recursive: true });
      await writeFile(join(cache.root, 'refs', 'crops', 'set.x.1.png'), crop(10));
      await writeFile(join(cache.root, 'refs', 'crops', 'set.x.2.png'), crop(200));
    });

    it("meta.json records each reference crop's sha256 and use, and the IP-Adapter weights are pinned too", async () => {
      const g = deps.generator as FakeGenerator;
      const { meta } = await runRecipe(refRecipe(), REF, deps);
      expect(meta.references).toEqual({ 'set.x.1': createHash('sha256').update(crop(10)).digest('hex'), 'set.x.2': createHash('sha256').update(crop(200)).digest('hex') });
      expect(meta.referenceUse).toHaveLength(1);
      expect(meta.referenceUse![0]).toMatchObject({ model: 'style', refs: ['set.x.1', 'set.x.2'], weight: 0.6, weightType: 'style transfer', start: 0, end: 1 });
      expect(meta.models.ips).toEqual({ file: 'ipadapter/ips.safetensors', sha256: sha('IPS') });
      expect(meta.models.cv).toBeDefined();
      const rep = g.jobs.find(j => Object.values(j.graph).some(n => n.class_type === 'IPAdapterAdvanced'))!;
      expect(Object.keys(rep.inputs).filter(n => n.includes('art-ref-'))).toHaveLength(2);
    });

    it('a changed crop changes the recorded hashes, so verify refuses the old baseline', async () => {
      await runRecipe(refRecipe(), REF, deps);
      await writeFile(join(cache.root, 'refs', 'crops', 'set.x.2.png'), crop(201));
      await expect(verifyRecipe(refRecipe(), REF, deps)).rejects.toThrow(/reference hashes differ/);
    });

    it('a recipe without references records none and does not require the IP-Adapter files', async () => {
      await rm(join(cache.models, FILES.ips![1]));
      const { meta } = await runRecipe(recipe(), RECIPE, deps);
      expect(meta.references).toBeUndefined();
      expect(meta.models.ips).toBeUndefined();
    });

    it('names the missing crop and how to grab it', async () => {
      await rm(join(cache.root, 'refs', 'crops', 'set.x.2.png'));
      await expect(runRecipe(refRecipe(), REF, deps)).rejects.toThrow(/set\.x\.2.*refs grab/);
    });
  });

  it('stamps the names it uploads with the run stamp (M8)', async () => {
    const g = deps.generator as FakeGenerator;
    await runRecipe(recipe(), RECIPE, deps);
    const names = g.jobs.flatMap(j => Object.keys(j.inputs));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toContain('2023-11-14T22-13-20-000Z');
  });

  it("refuses a model whose file hash doesn't match models.yaml, before generating anything", async () => {
    await writeFile(join(cache.models, FILES.ck![1]), 'tampered');
    const g = deps.generator as FakeGenerator;
    await expect(runRecipe(recipe(), RECIPE, deps)).rejects.toThrow(/ck.*sha256/);
    expect(g.jobs).toHaveLength(0);
  });

  it("refuses a ComfyUI whose commit isn't pins.env's", async () => {
    const g = deps.generator as FakeGenerator;
    await expect(runRecipe(recipe(), RECIPE, { ...deps, comfyCommit: async () => 'def456' })).rejects.toThrow(/def456.*abc123/);
    expect(g.jobs).toHaveLength(0);
  });
});

describe('the align post-step', () => {
  beforeEach(async () => {
    await writeFile(join(tmp, 'media', 'images', 'backgrounds', 's_0001.png'), encodePng(drawn()));
    deps = { ...deps, alignPoints: async () => POINTS };
  });

  it('writes align.json and the overlay, and records the check in meta', async () => {
    const { dir, meta } = await runRecipe(parseRecipe(ALIGN_RECIPE, '/x/t.s01.yaml'), ALIGN_RECIPE, { ...deps, generator: new SceneGenerator() });
    expect(meta.checks.align).toMatchObject({ ok: true, measured: 6, total: 6 });
    expect(JSON.parse(await readFile(join(dir, 'align.json'), 'utf8')).ok).toBe(true);
    expect(decodePng(new Uint8Array(await readFile(join(dir, 'align-overlay.png')))).width).toBe(1280);
  });

  it('fails the run for a plate that does not line up, keeping the evidence but not updating last.json', async () => {
    const r = parseRecipe(ALIGN_RECIPE, '/x/t.s01.yaml');
    await runRecipe(r, ALIGN_RECIPE, { ...deps, generator: new SceneGenerator() });
    const before = await readFile(join(cache.work, 't.s01', 'last.json'), 'utf8');
    // a flat plate has none of the original's structure
    await expect(runRecipe(r, ALIGN_RECIPE, { ...deps, now: () => 1_700_000_100_000 })).rejects.toThrow(/misaligned/);
    expect(await readFile(join(cache.work, 't.s01', 'last.json'), 'utf8')).toBe(before);
    const dirs = (await readdir(join(cache.work, 't.s01'))).filter(d => d !== 'last.json');
    expect(dirs).toHaveLength(2);
  }, 60_000);
});

describe('verifyRecipe', () => {
  it('passes within 1/255 mean difference and fails beyond it, naming both hashes', async () => {
    await runRecipe(recipe(), RECIPE, deps);
    const same = await verifyRecipe(recipe(), RECIPE, deps);
    expect(same.ok).toBe(true);
    expect(same.meanAbsDiff).toBe(0);
    await runRecipe(recipe(), RECIPE, deps);
    const drift = await verifyRecipe(recipe(), RECIPE, { ...deps, generator: new FakeGenerator([140, 140, 140, 255]), now: () => 1_700_000_100_000 });
    expect(drift.ok).toBe(false);
    expect(drift.meanAbsDiff).toBeGreaterThan(1);
    const lastFile = join(cache.work, 't.s01', 'last.json');
    const lastBefore = await readFile(lastFile, 'utf8');
    const last = JSON.parse(lastBefore).meta.outputs.plate.sha256;
    expect(drift.detail).toContain(last);
    expect(drift.detail).toMatch(/last [0-9a-f]{64}, now [0-9a-f]{64}/);
    // a drifted verify leaves the baseline alone, so the next verify still sees the drift
    const again = await verifyRecipe(recipe(), RECIPE, { ...deps, generator: new FakeGenerator([140, 140, 140, 255]), now: () => 1_700_000_200_000 });
    expect(again.ok).toBe(false);
    expect(await readFile(lastFile, 'utf8')).toBe(lastBefore);
    // a passing verify moves it to its own run
    const pass = await verifyRecipe(recipe(), RECIPE, { ...deps, now: () => 1_700_000_300_000 });
    expect(pass.ok).toBe(true);
    expect(JSON.parse(await readFile(lastFile, 'utf8')).dir).toContain('2023-11-14T22-18-20');
  }, 60_000);

  it('refuses to compare runs with a different recipe or model hashes (M4)', async () => {
    await runRecipe(recipe(), RECIPE, deps);
    const g = deps.generator as FakeGenerator;
    const n = g.jobs.length;
    const edited = RECIPE.replace('a room', 'another room');
    await expect(verifyRecipe(parseRecipe(edited, '/x/t.s01.yaml'), edited, deps)).rejects.toThrow(/recipe/);
    expect(g.jobs).toHaveLength(n);
    // the model files change under the same names (models.yaml updated to match): the baseline's hashes no longer apply
    const last = JSON.parse(await readFile(join(cache.work, 't.s01', 'last.json'), 'utf8'));
    last.meta.models.ck.sha256 = 'f'.repeat(64);
    await writeFile(join(cache.work, 't.s01', 'last.json'), JSON.stringify(last));
    await expect(verifyRecipe(recipe(), RECIPE, { ...deps, now: () => 1_700_000_100_000 })).rejects.toThrow(/model ck/);
    // a different reference hash is refused the same way
    last.meta.models.ck.sha256 = sha('CK');
    last.meta.references = { 'ref-a': 'a'.repeat(64) };
    await writeFile(join(cache.work, 't.s01', 'last.json'), JSON.stringify(last));
    await expect(verifyRecipe(recipe(), RECIPE, { ...deps, now: () => 1_700_000_200_000 })).rejects.toThrow(/reference/);
  }, 60_000);

  it('refuses a COMFY_URL server, whose execution cache would answer the re-run from memory', async () => {
    await runRecipe(recipe(), RECIPE, deps);
    const g = deps.generator as FakeGenerator;
    const n = g.jobs.length;
    await expect(verifyRecipe(recipe(), RECIPE, { ...deps, external: true })).rejects.toThrow(/COMFY_URL/);
    expect(g.jobs).toHaveLength(n);
  });

  it('says to run first when there is no previous run', async () => {
    await expect(verifyRecipe(recipe(), RECIPE, deps)).rejects.toThrow(/run it first/);
  });
});

describe('checkPins', () => {
  it("under COMFY_URL checks the server's version against pins.env's tag, and warns that the commit is unproved", async () => {
    await writeFile(join(tmp, 'pins.env'), 'COMFYUI_TAG=v0.41.3\nCOMFYUI_COMMIT=abc123\n');
    const warnings: string[] = [];
    const bad = { ...deps, external: true, comfyCommit: async () => 'never asked' };
    await expect(checkPins(defaultChoice(deps.models), bad)).rejects.toThrow(/reports version fake, pins.env says 0.41.3/);
    const good = { ...bad, generator: Object.assign(new FakeGenerator(), { info: async () => ({ comfyui: '0.41.3', torch: 'x', device: 'x', vramTotal: 0 }) }), warn: (l: string) => warnings.push(l) };
    await expect(checkPins(defaultChoice(deps.models), good)).resolves.toBeDefined();
    expect(warnings.join('\n')).toMatch(/can't be proved/);
  });

  it("refuses a dirty ComfyUI tree, or an aux or IP-Adapter checkout that isn't at pins.env's commit (M5)", async () => {
    await writeFile(join(tmp, 'pins.env'), 'COMFYUI_COMMIT=abc123\nAUX_COMMIT=aux1\nIPADAPTER_COMMIT=ipa1\n');
    const good = { ...deps, auxCommit: async (name: string) => (name === 'aux' ? 'aux1' : 'ipa1'), dirty: async () => '' };
    const choice = defaultChoice(deps.models);
    await expect(checkPins(choice, good)).resolves.toBeDefined();
    await expect(checkPins(choice, { ...good, auxCommit: async (name: string) => (name === 'aux' ? 'aux9' : 'ipa1') })).rejects.toThrow(/aux.*aux9.*aux1/);
    await expect(checkPins(choice, { ...good, auxCommit: async (name: string) => (name === 'aux' ? 'aux1' : 'ipa9') })).rejects.toThrow(/IP-Adapter.*ipa9.*ipa1/);
    await expect(checkPins(choice, { ...good, dirty: async (dir: string) => (dir === cache.comfy ? ' M comfy/samplers.py' : '') })).rejects.toThrow(/ComfyUI.*uncommitted.*samplers/);
    await expect(checkPins(choice, { ...good, dirty: async (dir: string) => (dir.endsWith('comfyui_controlnet_aux') ? '?? x.py' : '') })).rejects.toThrow(/aux.*uncommitted/);
  });

  it('checks only the asked-for models (card: the upscaler; gen: the text-to-image ones)', async () => {
    await writeFile(join(cache.models, FILES.ck![1]), 'tampered');
    const used = await checkPins(defaultChoice(deps.models), deps, ['upscaler']);
    expect(Object.keys(used)).toEqual(['up']);
    await expect(checkPins(defaultChoice(deps.models), deps, ['checkpoint', 'vae', 'lora'])).rejects.toThrow(/ck.*sha256/);
  });
});

describe('a ship-source recipe (plate)', () => {
  const SHIP_RECIPE = `id: plate.bridge
kind: repaint
source: { ship: bridge }
sampling: { seed: 9, steps: 5, cfg: 4.5, sampler: euler, scheduler: normal }
prompt: a room
denoise: 0.3
keep: [[0, 364, 640, 116]]
post: [ { align: {} } ]
`;
  const shipRecipe = () => parseRecipe(SHIP_RECIPE, '/x/plate.bridge.yaml', new Set());
  const LIFT = {
    bridge: {
      items: [
        { object: 'a', x: 100, y: 100, width: 120, height: 100, action: 1 },
        { object: 'b', x: 300, y: 60, width: 80, height: 200, action: 2 },
        { object: 'c', x: 60, y: 320, width: 120, height: 100, action: 3 },
      ],
      objects: [],
    },
  };
  /** The first job upscales the original (value 200), the rest are the repaint's (100). */
  class TwoTone extends FakeGenerator {
    constructor() {
      super([100, 100, 100, 255]);
    }
    override async run(job: Parameters<FakeGenerator['run']>[0]): Promise<Record<string, Uint8Array>> {
      const first = this.jobs.length === 0;
      const out = await super.run(job);
      if (first) for (const [k, png] of Object.entries(out)) {
        const d = decodePng(png);
        d.data.fill(200);
        for (let i = 3; i < d.data.length; i += 4) d.data[i] = 255;
        out[k] = encodePng(d);
      }
      return out;
    }
  }
  async function putOriginal(img: Rgba): Promise<void> {
    await mkdir(join(cache.root, 'originals', 'ship'), { recursive: true });
    await writeFile(join(cache.root, 'originals', 'ship', 'bridge.png'), encodePng(img));
  }

  it("reads originals/ship/<stem>.png from the cache with no IMAGES_DIR, records source and keep in meta.json, and aligns with shipInputs' points", async () => {
    await putOriginal(drawn());
    const text = SHIP_RECIPE;
    const gen = new SceneGenerator();
    const { dir, meta } = await runRecipe(shipRecipe(), text, { ...deps, imagesDir: undefined, generator: gen, shipLift: async () => LIFT });
    expect(meta.source).toBe(sha256Of(encodePng(drawn())));
    expect(meta.keep).toEqual([[0, 364, 640, 116]]);
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')).keep).toEqual([[0, 364, 640, 116]]);
    const align = JSON.parse(await readFile(join(dir, 'align.json'), 'utf8')) as { ok: boolean; points: { source: string }[] };
    expect(align.ok).toBe(true);
    expect(align.points.filter(p => p.source.startsWith('item ')).length).toBe(12);
    expect((meta.checks.align as { ok: boolean }).ok).toBe(true);
  });

  it("the published plate.png is keepComposite of the repaint and the run's upscale", async () => {
    await putOriginal(drawn());
    const { dir } = await runRecipe(parseRecipe(SHIP_RECIPE.replace('post: [ { align: {} } ]', 'post: []'), '/x/plate.bridge.yaml', new Set()), SHIP_RECIPE, { ...deps, imagesDir: undefined, generator: new TwoTone(), shipLift: async () => LIFT });
    const plate = decodePng(new Uint8Array(await readFile(join(dir, 'plate.png'))));
    const at = (x: number, y: number): number => plate.data[(y * plate.width + x) * 4]!;
    expect([plate.width, plate.height]).toEqual([2560, 1920]);
    expect(at(1280, 1700)).toBe(200);
    expect(at(2559, 1919)).toBe(200);
    expect(at(1280, 1000)).toBe(100);
    expect(at(1280, 364 * 4 - 1)).toBe(100);
    const edge = at(1280, 364 * 4 + 4);
    expect(edge).toBeGreaterThan(100);
    expect(edge).toBeLessThan(200);
    // the repaint itself is kept for a look
    expect(decodePng(new Uint8Array(await readFile(join(dir, 'repaint.png')))).data[0]).toBe(100);
  });

  it('the denoise mask is 0 inside the keep rect', async () => {
    await putOriginal(drawn());
    const { dir } = await runRecipe(parseRecipe(SHIP_RECIPE.replace('post: [ { align: {} } ]', 'post: []').replace('denoise: 0.3', 'denoise: 0.3\nmask: { protect: 0.2 }'), '/x/plate.bridge.yaml', new Set()), SHIP_RECIPE, { ...deps, imagesDir: undefined, shipLift: async () => LIFT });
    const m = decodePng(new Uint8Array(await readFile(join(dir, 'mask.png'))));
    expect(m.data[(800 * m.width + 500) * 4]).toBe(0);
    expect(m.data[(300 * m.width + 500) * 4]).toBeGreaterThan(200);
  });

  it('a room recipe still needs IMAGES_DIR, and a ship recipe needs the decoded original', async () => {
    await expect(runRecipe(recipe(), RECIPE, { ...deps, imagesDir: undefined })).rejects.toThrow(/IMAGES_DIR/);
    await expect(runRecipe(shipRecipe(), SHIP_RECIPE, { ...deps, imagesDir: undefined, shipLift: async () => LIFT })).rejects.toThrow(/art ship originals/);
  });
});
describe('a space-source recipe (Plan 30 R3, R5)', () => {
  const CONSOLE = `id: plate.tactical
kind: repaint
source: { space: console }
sampling: { seed: 9, steps: 5, cfg: 4.5, sampler: euler, scheduler: normal }
prompt: a console
denoise: 0.3
areas: { radar: [5, 21, 310, 275] }
post: [ { align: {} } ]
`;
  const PAGES = CONSOLE.replace('plate.tactical', 'pages.tactical').replace('space: console', 'space: pages').replace(/areas: .*\n/, '');
  async function put(which: 'console' | 'pages', img: Rgba, places?: object[]): Promise<void> {
    await mkdir(join(cache.root, 'originals', 'space'), { recursive: true });
    await writeFile(join(cache.root, 'originals', 'space', `${which}.png`), encodePng(img));
    if (places) await writeFile(join(cache.root, 'originals', 'space', 'pages.json'), JSON.stringify(places));
  }

  it('reads originals/space/console.png from the cache with no IMAGES_DIR or lift, and checks the areas\' corners and the original\'s edges', async () => {
    await put('console', drawn());
    const { dir, meta } = await runRecipe(parseRecipe(CONSOLE, '/x/plate.tactical.yaml', new Set()), CONSOLE, { ...deps, imagesDir: undefined, generator: new SceneGenerator() });
    expect(meta.source).toBe(sha256Of(encodePng(drawn())));
    const align = JSON.parse(await readFile(join(dir, 'align.json'), 'utf8')) as { ok: boolean; points: { source: string }[] };
    expect(align.points.filter(p => p.source.startsWith('area radar')).length).toBe(4);
    expect(align.points.some(p => p.source.startsWith('edge'))).toBe(true);
  });

  it('takes the pages\' atlas\'s pictures as its points, and says how to decode a missing original', async () => {
    await expect(runRecipe(parseRecipe(PAGES, '/x/pages.tactical.yaml', new Set()), PAGES, { ...deps, imagesDir: undefined })).rejects.toThrow(/art:space -- originals/);
    await put('pages', drawn(), [{ image: 7, x: 100, y: 100, width: 120, height: 100 }]);
    const { dir, meta } = await runRecipe(parseRecipe(PAGES, '/x/pages.tactical.yaml', new Set()), PAGES, { ...deps, imagesDir: undefined, generator: new SceneGenerator() });
    // (the layout it was made from, so publish can refuse a run whose atlas pages.json no longer describes: Plan 30 R14)
    expect([meta.source, meta.layout]).toEqual([sha256Of(encodePng(drawn())), sha256Of(new TextEncoder().encode(JSON.stringify([{ image: 7, x: 100, y: 100, width: 120, height: 100 }])))]);
    const align = JSON.parse(await readFile(join(dir, 'align.json'), 'utf8')) as { points: { source: string }[] };
    expect(align.points.filter(p => p.source.startsWith('picture 7')).length).toBe(4);
  });
});
describe('an admin-source recipe (Plan 32 Task 12)', () => {
  // (a picture smaller than the screen, as the console (420 by 478) and final.spr (562 by 334) are; an area on its right edge)
  const RECIPE_ADMIN = `id: plate.final
kind: repaint
source: { admin: final }
sampling: { seed: 9, steps: 5, cfg: 4.5, sampler: euler, scheduler: normal }
prompt: a console
denoise: 0.3
keep: [[10, 10, 40, 30]]
areas: { side: [290, 20, 30, 60] }
size: { work: [640, 480], out: [1280, 960] }
post: [ { align: {} } ]
`;
  const small = (): Rgba => areaResize(drawn(), 320, 240);

  it('reads originals/admin/<which>.png from the cache with no IMAGES_DIR, GAMEDATA_DIR or lift, and keeps its points inside the picture', async () => {
    const r = parseRecipe(RECIPE_ADMIN, '/x/plate.final.yaml', new Set());
    await expect(runRecipe(r, RECIPE_ADMIN, { ...deps, imagesDir: undefined, gameData: undefined })).rejects.toThrow(/GAMEDATA_DIR/);
    await mkdir(join(cache.root, 'originals', 'admin'), { recursive: true });
    await writeFile(join(cache.root, 'originals', 'admin', 'final.png'), encodePng(small()));
    const { dir, meta } = await runRecipe(r, RECIPE_ADMIN, { ...deps, imagesDir: undefined, gameData: undefined, generator: new SceneGenerator() });
    expect([meta.source, meta.keep]).toEqual([sha256Of(encodePng(small())), [[10, 10, 40, 30]]]);
    expect(meta.outputs.plate).toMatchObject({ width: 1280, height: 960 });
    const align = JSON.parse(await readFile(join(dir, 'align.json'), 'utf8')) as { ok: boolean; points: { x: number; y: number; source: string }[] };
    expect(align.ok).toBe(true);
    expect(align.points.filter(p => p.source.startsWith('area side')).map(p => [p.x, p.y])).toEqual([[290, 20], [319, 20], [290, 80], [319, 80]]);
    expect(align.points.every(p => p.x < 320 && p.y < 240)).toBe(true);
    expect(JSON.parse(await readFile(join(cache.work, 'plate.final', 'last.json'), 'utf8')).dir).toBe(dir);
  });
});
const sha256Of = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('the warp post-step', () => {
  const WARP_RECIPE = RECIPE.replace('{ depth: {} }', '{ depth: {} }, { warp: { radius: 24 } }, { align: {} }');
  /** The drawn scene with the plate's content near (220, 200) moved 4 px to the right. */
  class DisplacedGenerator extends FakeGenerator {
    override async run(job: Parameters<FakeGenerator['run']>[0]): Promise<Record<string, Uint8Array>> {
      const out = await super.run(job);
      for (const [k, png] of Object.entries(out)) {
        const d = decodePng(png);
        out[k] = encodePng(applyWarp(areaResize(drawn(), d.width, d.height), d.width / 640, [{ x: 220, y: 200, dx: -4, dy: 0 }], 24));
      }
      return out;
    }
  }
  beforeEach(async () => {
    await writeFile(join(tmp, 'media', 'images', 'backgrounds', 's_0001.png'), encodePng(drawn()));
    deps = { ...deps, alignPoints: async () => POINTS };
  });

  it('moves a locally displaced point back before the check, records which point and by how much, and keeps the unwarped plate', async () => {
    const lines: string[] = [];
    const { dir, meta } = await runRecipe(parseRecipe(WARP_RECIPE, '/x/t.s01.yaml'), WARP_RECIPE, { ...deps, generator: new DisplacedGenerator(), warn: l => lines.push(l) });
    expect(meta.checks.align).toMatchObject({ ok: true });
    const warp = meta.checks.warp as { changed: boolean; passes: { warped: { source: string; dx: number }[] }[] };
    expect(warp.changed).toBe(true);
    expect(warp.passes[0]!.warped.map(p => p.source)).toEqual(['p1']);
    expect(warp.passes[0]!.warped[0]!.dx).toBeGreaterThan(3);
    expect(meta.outputs.prewarp).toBeDefined();
    expect(meta.outputs.plate!.sha256).not.toBe(meta.outputs.prewarp!.sha256);
    expect(lines.some(l => /warp moved 1 point/.test(l))).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'))).toEqual(meta);
  }, 60_000);

  it('without the warp step the same plate is misaligned', async () => {
    await expect(runRecipe(parseRecipe(ALIGN_RECIPE, '/x/t.s01.yaml'), ALIGN_RECIPE, { ...deps, generator: new DisplacedGenerator() })).rejects.toThrow(/misaligned/);
  }, 60_000);

  it('refuses a warp step without an align step after it, or after the align', () => {
    expect(() => parseRecipe(RECIPE.replace('{ depth: {} }', '{ warp: {} }'), '/x/t.s01.yaml')).toThrow(/needs an align step/);
    expect(() => parseRecipe(RECIPE.replace('{ depth: {} }', '{ align: {} }, { warp: {} }'), '/x/t.s01.yaml')).toThrow(/before align/);
  });
});

describe('an upscale-only room plate', () => {
  const UP_RECIPE = `${RECIPE.replace('post: [ { depth: {} } ]', 'repaint: false\npost: [ { align: { skip: true, reason: "flat grey original, no x edges" } } ]')}`;

  it('publishes the upscale with no diffusion pass, skips the check only as the recipe says, and logs the reason loudly', async () => {
    const lines: string[] = [];
    const gen = new FakeGenerator();
    const { meta } = await runRecipe(parseRecipe(UP_RECIPE, '/x/t.s01.yaml'), UP_RECIPE, { ...deps, generator: gen, warn: l => lines.push(l) });
    expect(meta.upscaleOnly).toBe(true);
    expect(meta.checks.align).toMatchObject({ skipped: true, reason: 'flat grey original, no x edges' });
    expect(meta.outputs.plate).toMatchObject({ width: 2560, height: 1920 });
    expect(meta.outputs.repainted).toBeUndefined();
    expect(lines.some(l => /ALIGNMENT CHECK SKIPPED.*flat grey original/.test(l))).toBe(true);
  });

  it('a repainted plate with align skip is refused, and a skip needs its reason', () => {
    expect(() => parseRecipe(RECIPE.replace('{ depth: {} }', '{ align: { skip: true, reason: "x" } }'), '/x/t.s01.yaml')).toThrow(/only for an upscale-only plate/);
    expect(() => parseRecipe(UP_RECIPE.replace(', reason: "flat grey original, no x edges"', ''), '/x/t.s01.yaml')).toThrow(/needs a reason/);
  });
});
