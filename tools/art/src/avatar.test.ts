// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { avatarRecipe, blendDetail, blurred, cropOf, detailSquare, faceIdFile, loraFile, sheetRows, smallOf } from './avatar';
import { loadModels } from './models';
import { faceBoxes, scoreFaces, scoreLabel } from './face';

describe('avatar recipes', () => {
  it('art/recipes/avatar.riker.yaml parses, and names its references in a manifest', () => {
    const text = readFileSync(new URL('../../../art/recipes/avatar.riker.yaml', import.meta.url), 'utf8');
    const r = avatarRecipe.parse(parseYaml(text));
    expect(r.variants.length).toBeGreaterThanOrEqual(6);
    expect(r.pick).toBe('grab');
    expect(r.grab?.ref).toBe('crew.riker.face.3');
    const manifest = parseYaml(readFileSync(new URL('../../../art/refs/show.yaml', import.meta.url), 'utf8')) as { refs: Record<string, unknown> };
    const id = r.identity!;
    for (const x of [...id.refs, ...id.holdout, ...id.others, ...r.sheet.refs, ...r.variants.flatMap(v => v.references.map(y => y.ref))]) expect(manifest.refs[x]).toBeDefined();
    // the scoring frames are never given to the model, and the first try's crop is not a FaceID reference
    expect(id.refs.filter(x => id.holdout.includes(x))).toEqual([]);
    expect(id.refs).not.toContain('crew.riker.face.1');
    // every FaceID model the recipe names is an experimental sdxl entry
    const models = loadModels(readFileSync(new URL('../../../art/models.yaml', import.meta.url), 'utf8'));
    for (const f of r.variants.flatMap(v => v.faceid)) {
      expect(faceIdFile(models, f.model)).toMatch(/faceid/);
      if (f.lora) expect(faceIdFile(models, f.lora.model)).toMatch(/lora/);
    }
  });
  it('every crew member has an avatar recipe on its icon.map head, with show frames for the show\'s people only', () => {
    const manifest = parseYaml(readFileSync(new URL('../../../art/refs/show.yaml', import.meta.url), 'utf8')) as { refs: Record<string, unknown> };
    const heads: Record<string, string> = { picard: 'smhdpcrd', riker: 'smhdrikr', data: 'smhddata', troi: 'smhdtroi', worf: 'smhdworf', crusher: 'smhdbevy', la_forge: 'smhdgeor', carlstrom: 'smhdmale', butler: 'smhdfeml' };
    for (const [who, head] of Object.entries(heads)) {
      const r = avatarRecipe.parse(parseYaml(readFileSync(new URL(`../../../art/recipes/avatar.${who}.yaml`, import.meta.url), 'utf8')));
      expect(r.object).toBe(who);
      expect(r.base.sprite).toBe(`${head}.spr`);
      // the user's pick (2026-10-19): the grab portrait, the earlier variants kept
      expect(r.pick).toBe('grab');
      expect(r.pixel?.grid).toEqual([64, 64]);
      const g = r.grab!;
      expect(g.gameFace[2]).toBeGreaterThan(g.gameFace[0]);
      expect(g.gameFace[3]).toBeLessThanOrEqual(50);
      if (who === 'carlstrom' || who === 'butler') {
        expect(r.identity).toBeUndefined();
        // a game-only character's face is a Krea 2 picture, made by the recipe itself
        expect(g.from).toBe('krea2');
        expect(r.variants.find(v => v.name === 'krea2')).toMatchObject({ model: 'krea2', denoise: 0.8, sampling: { seed: 75001, steps: 8, cfg: 1, sampler: 'er_sde', scheduler: 'simple' } });
        continue;
      }
      expect(manifest.refs[g.ref!]).toBeDefined();
      expect(g.ref).toMatch(new RegExp(`^crew\\.${who}\\.face\\.`));
      const id = r.identity!;
      for (const x of [...id.refs, ...id.holdout, ...id.others]) expect(manifest.refs[x]).toBeDefined();
      expect(id.refs.filter(x => id.holdout.includes(x))).toEqual([]);
      expect(id.others.some(x => x.startsWith(`crew.${who}.`))).toBe(false);
    }
  });
  it('the pixel block is in the recipe, and the small picture follows it', () => {
    const r = avatarRecipe.parse(parseYaml(readFileSync(new URL('../../../art/recipes/avatar.riker.yaml', import.meta.url), 'utf8')));
    expect(r.pixel?.grid).toEqual([64, 64]);
    const img = { width: 128, height: 128, data: new Uint8Array(128 * 128 * 4).map((_, i) => ((i >> 2) * 7 + (i & 3) * 50) & 255) };
    const colours = (i: { width: number; height: number; data: Uint8Array }) => new Set(Array.from({ length: i.width * i.height }, (_, k) => i.data.subarray(k * 4, k * 4 + 3).join())).size;
    const v = r.variants[0]!;
    expect(colours(smallOf(img, r, v, img))).toBeLessThanOrEqual(32);
    expect(colours(smallOf(img, { ...r, pixel: undefined }, v, img))).toBeGreaterThan(32);
  });
  it('needs identity refs for a faceid variant, and one base at most', () => {
    const v = { name: 'a', sampling: { seed: 1, steps: 2, cfg: 1, sampler: 'euler', scheduler: 'normal' }, prompt: 'p', denoise: 0.9, faceid: [{ model: 'm', weight: 1 }] };
    const base = { id: 'avatar.x', kind: 'avatar', object: 'x', base: { sprite: 'x.spr' }, variants: [v] };
    expect(() => avatarRecipe.parse(base)).toThrow(/identity/);
    expect(avatarRecipe.parse({ ...base, identity: { refs: ['r'] } }).variants[0]!.faceid[0]).toMatchObject({ v2: 1, combine: 'average', weightType: 'linear', end: 1 });
    const likeness = { ref: 'r', crop: [0, 0, 1, 1], subject: [[0, 0], [1, 0], [1, 1]], light: { strength: 1, from: 0, to: 1, shadow: [1, 1, 1], key: [1, 1, 1] }, rim: { strength: 1, width: 1, side: [1, 1, 1], top: [1, 1, 1] } };
    expect(() => avatarRecipe.parse({ ...base, identity: { refs: ['r'] }, layout: { blur: 4 }, likeness })).toThrow(/two different bases/);
  });
  it('takes FaceID models from experimental sdxl entries only', () => {
    const entry = (role: string, extra = '') => `  m:\n    role: ${role}\n${extra}    file: ipadapter/ip-adapter-faceid-plusv2_sdxl.bin\n    url: https://example.com/ip-adapter-faceid-plusv2_sdxl.bin\n    sha256: pending\n    licence: InsightFace-Non-Commercial\n    licenceUrl: https://example.com\n`;
    expect(faceIdFile(loadModels(`models:\n${entry('experimental', '    family: sdxl\n')}`), 'm')).toBe('ip-adapter-faceid-plusv2_sdxl.bin');
    expect(() => faceIdFile(loadModels(`models:\n${entry('experimental', '    family: flux\n')}`), 'm')).toThrow(/experimental sdxl/);
    expect(() => faceIdFile(loadModels('models: {}\n'), 'm')).toThrow(/no model/);
  });
  it('takes style LoRAs from experimental loras of the variant\'s family, and a second stage from another first-stage variant', () => {
    const models = loadModels(readFileSync(new URL('../../../art/models.yaml', import.meta.url), 'utf8'));
    expect(loraFile(models, 'sdxl-retroart-lora', 'sdxl')).toBe('RetroArt-xl1024-v1a-_r3tr0.safetensors');
    expect(loraFile(models, 'flux-st25style-lora', 'flux')).toBe('flux_st25style_000000800.safetensors');
    expect(() => loraFile(models, 'flux-st25style-lora', 'sdxl')).toThrow(/experimental sdxl LoRA/);
    expect(() => loraFile(models, 'ip-adapter-faceid-plusv2-sdxl', 'sdxl')).toThrow(/LoRA/);
    const v = (name: string, from?: string) => ({ name, sampling: { seed: 1, steps: 2, cfg: 1, sampler: 'euler', scheduler: 'normal' }, prompt: 'p', denoise: 0.5, ...(from ? { from } : {}) });
    const base = { id: 'avatar.x', kind: 'avatar', object: 'x', base: { sprite: 'x.spr' } };
    expect(avatarRecipe.parse({ ...base, variants: [v('a'), v('b', 'a')] }).variants[1]!.from).toBe('a');
    expect(() => avatarRecipe.parse({ ...base, variants: [v('a'), v('b', 'ghost')] })).toThrow(/from/);
    // stages chain (FaceID, then a FLUX restyle, then FaceID again on the face), but never loop
    expect(avatarRecipe.parse({ ...base, variants: [v('a'), v('b', 'a'), v('c', 'b')] }).variants[2]!.from).toBe('b');
    expect(() => avatarRecipe.parse({ ...base, variants: [v('a', 'a')] })).toThrow(/from/);
    expect(() => avatarRecipe.parse({ ...base, variants: [v('a', 'b'), v('b', 'a')] })).toThrow(/loops/);
    expect(avatarRecipe.parse({ ...base, variants: [v('a'), { ...v('b', 'a'), detail: {} }] }).variants[1]!.detail).toEqual({ expand: 1.3, feather: 0.3 });
    expect(() => avatarRecipe.parse({ ...base, variants: [{ ...v('a'), model: 'flux', detail: {} }] })).toThrow(/sdxl only/);
  });
  it('places the detail square on the face inside the picture, and blends it through a feathered ellipse', () => {
    expect(detailSquare([400, 300, 600, 600], 1024, 1024, 1.5)).toEqual([275, 225, 450, 450]);
    // near an edge the square shifts in rather than shrinking
    expect(detailSquare([0, 0, 200, 100], 1024, 1024, 2)).toEqual([0, 0, 400, 400]);
    expect(detailSquare([0, 0, 1000, 1000], 1024, 1024, 2)).toEqual([0, 0, 1024, 1024]);
    const img = { width: 10, height: 10, data: new Uint8Array(400).fill(0) };
    const patch = { width: 10, height: 10, data: new Uint8Array(400).fill(200) };
    const out = blendDetail(img, patch, [0, 0, 10, 10], 0.3);
    expect(out.data[(5 * 10 + 5) * 4]).toBe(200);
    expect(out.data[0]).toBe(0);
    const mid = out.data[(5 * 10 + 9) * 4]!;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(200);
    expect(img.data[(5 * 10 + 5) * 4]).toBe(0);
  });
  it('asks the script for face boxes', () => {
    let input = '';
    const run = ((_c: string, _a: string[], opts: { input: string }) => {
      input = opts.input;
      return { status: 0, stdout: JSON.stringify({ boxes: { 'a.png': [1, 2, 3, 4], 'b.png': null } }), stderr: '' };
    }) as never;
    expect(faceBoxes('/py', ['a.png', 'b.png'], run)).toEqual({ 'a.png': [1, 2, 3, 4], 'b.png': null });
    expect(JSON.parse(input)).toEqual({ boxes: ['a.png', 'b.png'] });
  });
  it('blurs each channel and keeps the frame opaque', () => {
    const img = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4) };
    img.data.set([255, 0, 0, 0], (3 * 8 + 3) * 4);
    const b = blurred(img, 2);
    expect(b.data[(3 * 8 + 3) * 4]).toBeLessThan(255);
    expect(b.data[(3 * 8 + 4) * 4]).toBeGreaterThan(0);
    expect(b.data[(3 * 8 + 3) * 4 + 1]).toBe(0);
    expect(Array.from({ length: 64 }, (_, i) => b.data[i * 4 + 3]).every(a => a === 255)).toBe(true);
  });
  it('labels likeness scores, and passes the request to the script as JSON on stdin', () => {
    expect(scoreLabel({ sim: 0.5512, margin: 0.4401, nearestOther: 'data' })).toBe('0.55 +0.44');
    expect(scoreLabel({ sim: 0.1, margin: -0.05, nearestOther: 'data' })).toBe('0.10 -0.05');
    expect(scoreLabel(null)).toBe('no face');
    expect(scoreLabel(undefined)).toBe('');
    let seen: { args: string[]; input: string } | undefined;
    const run = ((cmd: string, args: string[], opts: { input: string }) => {
      seen = { args, input: opts.input };
      return { status: 0, stdout: JSON.stringify({ images: { 'a.png': { sim: 0.6, margin: 0.5, nearestOther: 'troi' }, 'b.png': null } }), stderr: '' };
    }) as never;
    const res = scoreFaces('/py', { target: ['t.png'], others: { troi: ['o.png'] }, images: ['a.png', ['b.png', 'a.png']] }, run);
    expect(res['a.png']!.sim).toBe(0.6);
    expect(res['b.png']).toBeNull();
    expect(seen!.args[0]).toBe('-I');
    expect(seen!.args[1]).toMatch(/face\/score\.py$/);
    expect(JSON.parse(seen!.input).images[1]).toEqual(['b.png', 'a.png']);
    const fail = (() => ({ status: 1, stdout: '', stderr: 'boom' })) as never;
    expect(() => scoreFaces('/py', { target: [], others: {}, images: [] }, fail)).toThrow(/boom/);
  });
  it('refuses a key it does not know', () => {
    expect(() => avatarRecipe.parse({ id: 'avatar.x', kind: 'avatar', object: 'x', base: { sprite: 'x.spr' }, variants: [], extra: 1 })).toThrow();
  });
  it('crops inside the image', () => {
    const img = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4).map((_, i) => i) };
    const c = cropOf(img, [2, 0, 5, 5]);
    expect([c.width, c.height]).toEqual([2, 2]);
    expect(c.data[0]).toBe(8);
  });
});

describe('speaker avatars for the game\'s own characters', () => {
  const dir = new URL('../../../art/recipes/', import.meta.url);
  const CREW = ['picard', 'riker', 'data', 'troi', 'worf', 'crusher', 'la_forge', 'carlstrom', 'butler'];
  // (icon.map's head for each: the dialog box's picture of whoever speaks)
  const HEADS: Record<string, string> = { lucana: 'w5shluca.spr', t_bak: 'w5shtbak.spr', avakar: 'w5shavak.spr', pentara: 'w5shpen3.spr', benyt: 'w4shbeny.spr', griems: 'w4shgrie.spr', hyunh_foertsch: 'w3shvihn.spr', iydia: 'w3shlyda.spr', laraq: 'w5shlara.spr', aelont: 'w5shaelo.spr', nachyl: 'w5shnach.spr', madia: 'w5shmadi.spr', stamblyr: 'w5shstam.spr' };
  // (heads that are not a person's face, repainted from the game's own picture with no grab: layout, img2img, the pixel step)
  const NONFACE: Record<string, string> = {
    gatekeeper: 'w5shgtgd.spr', lliksze: 'w3shllik.spr', tzudan: 'w3shtzud.spr', zzolis: 'w3shzzol.spr', veronda_bird: 'w3shbird.spr', melas: 'w3shmela.spr', brodnack: 'w6shbrod.spr',
    optimator_one: 'w2shopt1.spr', optimator_two: 'w2shopt2.spr', guardian: 'w6shanct.spr', creature: 'w6shgrun.spr', drone: 'w2shdrod.spr', zoo_computer: 'w3shcomp.spr',
    emblem_romulan: 'iromuemb.spr', emblem_ferengi: 'ifergemb.spr', emblem_klingon: 'iklinemb.spr', emblem_cymco: 'unitcymb.spr', emblem_morassia: 'unitmora.spr', emblem_chodak: 'ichodemb.spr', emblem_garidian: 'unitgari.spr',
  };
  const recipes = readdirSync(dir).flatMap(f => /^avatar\.([a-z0-9_]+)\.yaml$/.exec(f)?.[1] ?? []).filter(id => !CREW.includes(id));

  it('are made from the sprite icon.map gives them, with no show frames, and are shown under their object ids', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(Object.keys(HEADS).length + Object.keys(NONFACE).length);
    for (const id of recipes.filter(i => !NONFACE[i])) {
      const r = avatarRecipe.parse(parseYaml(readFileSync(new URL(`avatar.${id}.yaml`, dir), 'utf8')));
      expect(r.object).toBe(id);
      expect(r.pick).toBe('grab');
      expect(r.identity).toBeUndefined();
      expect(r.grab?.from).toBeDefined();
      expect(r.variants.some(v => v.name === r.grab?.from)).toBe(true);
      expect(r.speakers.length).toBeGreaterThan(0);
      if (HEADS[id]) expect(r.base.sprite).toBe(HEADS[id]);
    }
  });

  it('repaint a head that is no face from the game picture alone: no grab and no identity, a negative prompt (no pins) at a cfg that obeys it', () => {
    for (const [id, sprite] of Object.entries(NONFACE)) {
      const r = avatarRecipe.parse(parseYaml(readFileSync(new URL(`avatar.${id}.yaml`, dir), 'utf8')));
      expect(r.object).toBe(id);
      expect(r.base.sprite).toBe(sprite);
      expect(r.grab).toBeUndefined();
      expect(r.identity).toBeUndefined();
      expect(r.layout).toBeDefined();
      expect(r.pixel).toBeDefined();
      expect(r.variants.some(v => v.name === r.pick)).toBe(true);
      expect(r.speakers.length).toBeGreaterThan(0);
      for (const v of r.variants) {
        expect(v.model).toBe('krea2');
        // (Krea 2 Turbo ignores a negative prompt at cfg 1)
        expect(v.sampling.cfg).toBeGreaterThan(1);
        expect(v.negative).toMatch(/text/);
        if (!id.startsWith('emblem_')) expect(v.negative).toMatch(/insignia/);
      }
    }
  });

  it('give each object id one portrait only', () => {
    const seen = new Map<string, string>();
    for (const id of recipes) {
      for (const who of avatarRecipe.parse(parseYaml(readFileSync(new URL(`avatar.${id}.yaml`, dir), 'utf8'))).speakers) {
        expect(seen.get(who), `${who} is in ${seen.get(who)} and ${id}`).toBeUndefined();
        seen.set(who, id);
      }
    }
  });
});
