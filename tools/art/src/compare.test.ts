// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { compareSchema, passed, pickBest, resultsYaml, sheetHtml, variantCard, variantRoom, type VariantResult } from './compare';
import { recipeSchema, type CardRecipe, type RepaintRecipe } from './recipe';

const REPO = join(__dirname, '..', '..', '..');
const FILE = compareSchema.parse(parseYaml(readFileSync(join(REPO, 'art', 'compare', '2026-10-18-models.yaml'), 'utf8')));
const ROOM = recipeSchema.parse(parseYaml(readFileSync(join(REPO, FILE.room.recipe), 'utf8'))) as RepaintRecipe;
const CARD = recipeSchema.parse(parseYaml(readFileSync(join(REPO, FILE.card.recipe), 'utf8'))) as CardRecipe;

describe('the comparison file', () => {
  it('names three settings per family, at the recipes\' seeds', () => {
    expect(Object.keys(FILE.families)).toEqual(['sdxl', 'qwen-image', 'flux']);
    for (const [family, variants] of Object.entries(FILE.families)) {
      expect(variants.length, family).toBe(family === 'sdxl' ? 4 : 3);
      for (const v of variants) {
        const room = variantRoom(ROOM, family as never, FILE.defaults[family as 'flux'], v);
        const card = variantCard(CARD, family as never, FILE.defaults[family as 'flux'], v);
        expect(room.sampling.seed).toBe(ROOM.sampling.seed);
        expect(card.sampling.seed).toBe(CARD.sampling.seed);
        expect(room.mask).toBeDefined();
        expect(room.model).toBe(family);
      }
    }
  });

  it('keeps the sdxl baseline as the committed recipe', () => {
    const v = FILE.families.sdxl![0]!;
    expect(v.name).toBe('recipe');
    const room = variantRoom(ROOM, 'sdxl', undefined, v);
    expect(room).toEqual({ ...ROOM, model: 'sdxl', guidance: undefined, shift: undefined });
    expect(variantCard(CARD, 'sdxl', undefined, v).reference).toEqual(CARD.reference);
  });

  it('gives flux Redux at the variant\'s strength, qwen-image no references, and the flow families their sampler and prompts', () => {
    const f = FILE.families.flux![0]!;
    const room = variantRoom(ROOM, 'flux', FILE.defaults.flux, f);
    expect(room.reference.map(r => r.weight)).toEqual([0.4]);
    expect(room.sampling).toMatchObject({ sampler: 'euler', scheduler: 'simple', cfg: 1, steps: 28 });
    expect(room.guidance).toBe(4.5);
    expect(room.prompt).not.toBe(ROOM.prompt);
    const q = variantCard(CARD, 'qwen-image', FILE.defaults['qwen-image'], FILE.families['qwen-image']![1]!);
    expect(q.reference).toEqual([]);
    expect(q).toMatchObject({ denoise: 0.65, shift: 3.1, lineart: { strength: 1 } });
  });

  // the 2026-10-18 comparison ran under the old rule (no show or actor names); prompts may name them since 2026-10-19
  it('the 2026-10-18 comparison\'s prompts name no show or actor', () => {
    const text = readFileSync(join(REPO, 'art', 'compare', '2026-10-18-models.yaml'), 'utf8');
    expect(text).not.toMatch(/star ?trek|enterprise|next generation|frakes|stewart|riker\b.*prompt/i);
  });
});

const result = (variant: string, ok: boolean, denoise: [number, number], worst = 1): VariantResult => ({
  family: 'flux',
  variant,
  settings: 's',
  key: 'k',
  denoise,
  room: { ok, worstShift: worst, worstPoint: 'p', worstPeak: 0.9, measured: 50, total: 57, seconds: 30 },
  cards: [{ anim: 6, frames: 4, ok: true, worstShift: 1, medianShift: 0.5, flickerMedian: 3, flickerMax: 4, deltaEMax: 5, silhouette: true, seconds: 20 }],
});

describe('pickBest', () => {
  it('takes a passing variant with the most repaint, then the smaller worst shift; the file\'s choice wins', () => {
    const rs = [result('a', true, [0.5, 0.45]), result('b', false, [0.7, 0.65]), result('c', true, [0.6, 0.55], 1.8), result('d', true, [0.6, 0.55], 1.2)];
    expect(pickBest(rs, r => r.denoise)!.variant).toBe('d');
    expect(pickBest(rs, r => r.denoise, 'a')!.variant).toBe('a');
    expect(pickBest([rs[1]!], r => r.denoise)).toBeUndefined();
    expect(passed({ ...rs[0]!, cards: [] })).toBe(false);
    expect(passed({ ...rs[0]!, error: 'x' })).toBe(false);
  });
});

describe('the review sheet', () => {
  it('shows the originals, the show crops, each family\'s best with its numbers, and every variant', () => {
    const rs = [result('a', true, [0.5, 0.45]), result('b', false, [0.7, 0.65])];
    const html = sheetHtml({ file: FILE, results: rs, dir: '/c/compare/x', html: '/c/sheets/model-compare.html' });
    expect(html).toContain('flux: best passing (a');
    expect(html).toContain('alignment worst <b>1 px</b>');
    expect(html).toContain('flux b: fails');
    expect(html).toContain('sdxl: no passing result');
    expect(sheetHtml({ file: FILE, results: [{ ...rs[1]!, family: 'sdxl', variant: 'recipe' }], dir: '/c/x', html: '/c/s.html' })).toContain('showing recipe, which FAILS');
    expect(html).toContain('prefers-color-scheme');
    const y = resultsYaml(FILE, rs);
    expect(y).toMatch(/^# Numbers and ids only/);
    expect(parseYaml(y).results).toHaveLength(2);
  });
});
