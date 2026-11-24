// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { manifestIds, parseRecipe, plateStation, type RepaintRecipe } from './recipe';

const FILE = join(__dirname, '..', '..', '..', 'art', 'recipes', 'lab.s01.yaml');
const text = readFileSync(FILE, 'utf8');

describe('parseRecipe', () => {
  it('parses lab.s01.yaml and fills defaults from the schema', () => {
    const r = parseRecipe(text, FILE) as RepaintRecipe;
    expect(r.kind).toBe('repaint');
    expect(r.id).toBe('lab.s01');
    expect((r.source as { background: string }).background).toBe('s_0401');
    expect(r.size).toEqual({ work: [1152, 864], out: [2560, 1920] });
    expect(r.models).toEqual({});
    expect(r.post).toEqual([{ depth: { resolution: 1024 } }, { align: { maxShift: 2 } }]);
  });

  it("refuses an id that isn't the file's stem, a denoise over 0.7, or an unknown key", () => {
    expect(() => parseRecipe(text, '/x/other.yaml')).toThrow(/stem/);
    expect(() => parseRecipe(text.replace(/^denoise: .*$/m, 'denoise: 0.75'), FILE)).toThrow();
    expect(() => parseRecipe(`${text}\nbogus: 1\n`, FILE)).toThrow();
    expect(() => parseRecipe(text.replace('s_0401', 'lab'), FILE)).toThrow();
  });

  it('a control is relative to the sampled steps: start defaults to 0, end to 1, and start must come before end', () => {
    const r = parseRecipe(text.replace(/^depth: .*$/m, 'depth: { strength: 0.5 }').replace(/^lineart: .*$/m, 'lineart: { strength: 0.4, start: 0.2, end: 0.8 }'), FILE) as RepaintRecipe;
    expect(r.depth).toEqual({ strength: 0.5, start: 0, end: 1 });
    expect(r.lineart).toEqual({ strength: 0.4, start: 0.2, end: 0.8 });
    expect(() => parseRecipe(text.replace(/^depth: .*$/m, 'depth: { strength: 0.5, start: 0.6, end: 0.4 }'), FILE)).toThrow(/start/);
  });

  it('a recipe whose control is active on zero steps fails to parse with the reason', () => {
    // a window over the last ~1% of the steps overlaps no sampled step at 30 steps
    const bad = text.replace(/^depth: .*$/m, 'depth: { strength: 0.5, start: 0.99, end: 1 }');
    expect(() => parseRecipe(bad, FILE)).toThrow(/depth.*no sampled step/);
    expect(() => parseRecipe(text.replace(/^sampling: .*$/m, 'sampling: { seed: 1, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: exponential }'), FILE)).toThrow(/scheduler/);
  });

  it('a recipe mask takes defaults, rejects unknown keys and a bad edge range; denoise may go to 0.7', () => {
    const noMask = text.replace(/^mask: .*$/m, '');
    const m = (extra: string): RepaintRecipe => parseRecipe(`${noMask}\nmask: ${extra}\n`.replace(/^denoise: .*$/m, 'denoise: 0.65'), FILE) as RepaintRecipe;
    expect(m('{}').mask).toMatchObject({ protect: 0.5, pointRadius: 18, feather: 4 });
    expect(m('{ protect: 0.4 }').denoise).toBe(0.65);
    expect(() => m('{ nope: 1 }')).toThrow();
    expect(() => m('{ edgeLow: 0.6, edgeHigh: 0.5 }')).toThrow();
  });
  it('a recipe reference names manifest ids; an unknown id fails at parse with the id', () => {
    const bare = text.replace(/^reference:\n(?:  - .*\n)+/m, '');
    const ref = (refs: string) => `${bare}\nreference:\n  - { refs: ${refs}, model: style, weight: 0.5, weightType: style transfer }\n`;
    const known = new Set(['set.a.1', 'set.b.1']);
    const r = parseRecipe(ref('[set.a.1, set.b.1]'), FILE, known) as RepaintRecipe;
    expect(r.reference).toEqual([{ refs: ['set.a.1', 'set.b.1'], model: 'style', weight: 0.5, weightType: 'style transfer', start: 0, end: 1, mask: 'none' }]);
    expect(() => parseRecipe(ref('[set.a.1, set.ghost.9]'), FILE, known)).toThrow(/set\.ghost\.9/);
    expect(() => parseRecipe(ref('[]'), FILE, known)).toThrow();
    expect(() => parseRecipe(ref('[set.a.1]').replace('weight: 0.5', 'weight: 2'), FILE, known)).toThrow();
    expect(() => parseRecipe(ref('[set.a.1]').replace('weightType: style transfer', 'weightType: composition'), FILE, known)).toThrow();
    // with no `known`, the committed manifest decides
    expect(() => parseRecipe(ref('[set.lab.1]'), FILE)).not.toThrow();
    expect(() => parseRecipe(ref('[set.ghost.9]'), FILE)).toThrow(/set\.ghost\.9/);
    expect((parseRecipe(bare, FILE) as RepaintRecipe).reference).toEqual([]);
    expect((parseRecipe(text, FILE) as RepaintRecipe).reference[0]).toMatchObject({ refs: ['mat.lcars.1', 'set.science.1.wall', 'set.lab.2.wall'], weightType: 'style transfer', weight: 1 });
  });
});

describe('model families', () => {
  const noRefs = text.replace(/^reference:\n(  - .*\n)+/m, '');
  const flux = (extra: string) => noRefs.replace(/^sampling: .*$/m, 'sampling: { seed: 401001, steps: 28, cfg: 1, sampler: euler, scheduler: simple }') + `model: flux\n${extra}`;

  it('defaults to sdxl; qwen-image and flux map their windows with the simple scheduler', () => {
    expect((parseRecipe(text, FILE) as RepaintRecipe).model).toBe('sdxl');
    const f = parseRecipe(flux('guidance: 4.5\n'), FILE) as RepaintRecipe;
    expect(f).toMatchObject({ model: 'flux', guidance: 4.5 });
    const q = parseRecipe(noRefs.replace(/^sampling: .*$/m, 'sampling: { seed: 1, steps: 30, cfg: 4, sampler: euler, scheduler: simple }') + 'model: qwen-image\nshift: 3.1\n', FILE) as RepaintRecipe;
    expect(q).toMatchObject({ model: 'qwen-image', shift: 3.1 });
  });

  it('refuses a karras schedule for a flow family, the other family\'s knob, qwen-image references and sdxl model keys', () => {
    expect(() => parseRecipe(`${noRefs}model: flux\n`, FILE)).toThrow(/simple/);
    expect(() => parseRecipe(flux('shift: 3\n'), FILE)).toThrow(/shift is for model: qwen-image/);
    expect(() => parseRecipe(`${text}guidance: 3\n`, FILE)).toThrow(/guidance is for model: flux/);
    const qwenRefs = text.replace(/^sampling: .*$/m, 'sampling: { seed: 1, steps: 30, cfg: 4, sampler: euler, scheduler: simple }') + 'model: qwen-image\n';
    expect(() => parseRecipe(qwenRefs, FILE)).toThrow(/qwen-image takes no references/);
    expect(() => parseRecipe(flux('models: { checkpoint: sdxl-base-1.0 }\n'), FILE)).toThrow(/models: is for sdxl/);
    // a flux recipe keeps its references (Redux takes them)
    expect((parseRecipe(text.replace(/^sampling: .*$/m, 'sampling: { seed: 1, steps: 28, cfg: 1, sampler: euler, scheduler: simple }') + 'model: flux\n', FILE) as RepaintRecipe).reference).toHaveLength(1);
  });
});

describe('plate recipes (ship source)', () => {
  const plate = (over: { id?: string; source?: string; extra?: string } = {}): string => `id: ${over.id ?? 'plate.bridge'}
kind: repaint
source: ${over.source ?? '{ ship: bridge }'}
sampling: { seed: 1, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a room
denoise: 0.6
${over.extra ?? ''}`;
  const parse = (t: string, id = 'plate.bridge'): RepaintRecipe => parseRecipe(t, `/x/${id}.yaml`, new Set()) as RepaintRecipe;
  it('accepts source.ship with plate.<station> ids paired with their stem, and refuses plate.bridge with source transp', () => {
    const r = parse(plate({ extra: 'keep: [[0, 364, 640, 116]]\nareas: { console: [165, 212, 195, 34] }' }));
    expect(r.source).toEqual({ ship: 'bridge' });
    expect(r.keep).toEqual([[0, 364, 640, 116]]);
    expect(r.areas).toEqual({ console: [165, 212, 195, 34] });
    const v = parse(plate({ id: 'plate.viewscreen', source: '{ ship: viewscr }', extra: 'window: { at: [320, 180] }' }), 'plate.viewscreen');
    expect(v.window).toEqual({ at: [320, 180] });
    // R15: a window is the viewscreen's alone, and "window" isn't an area a recipe may name (publish adds it)
    expect(() => parse(plate({ extra: 'window: { at: [10, 20] }' }))).toThrow(/plate\.viewscreen only/);
    expect(() => parse(plate({ id: 'plate.viewscreen', source: '{ ship: viewscr }', extra: 'areas: { window: [1, 2, 3, 4] }' }), 'plate.viewscreen')).toThrow(/not an area name/);
    expect(plateStation(r)).toBe('bridge');
    const t = parse(plate({ id: 'plate.transporter', source: '{ ship: transp }' }), 'plate.transporter');
    expect(plateStation(t)).toBe('transporter');
    expect(() => parse(plate({ source: '{ ship: transp }' }))).toThrow(/bridge/);
    expect(() => parse(plate({ id: 'plate.engine' }), 'plate.engine')).toThrow(/plate\.<station>/);
    expect(() => parse(plate({ source: '{ background: s_0401 }' }))).toThrow(/ship/);
    expect(plateStation(parseRecipe(text, FILE) as RepaintRecipe)).toBeNull();
  });
  it('refuses keep, areas or window on a background source, and rects or items keys anywhere (strict)', () => {
    const room = (extra: string): string => plate({ id: 'lab.s01', source: '{ background: s_0401 }', extra });
    expect(() => parse(room('keep: [[0, 0, 10, 10]]'), 'lab.s01')).toThrow(/ship source/);
    expect(() => parse(room('areas: { a: [0, 0, 10, 10] }'), 'lab.s01')).toThrow(/ship source/);
    expect(() => parse(room('window: { at: [1, 2] }'), 'lab.s01')).toThrow(/ship source/);
    expect(() => parse(room(''), 'lab.s01')).not.toThrow();
    expect(() => parse(plate({ extra: 'rects: [[0, 0, 1, 1]]' }))).toThrow();
    expect(() => parse(plate({ extra: 'items: []' }))).toThrow();
    expect(() => parse(plate({ extra: 'keep: [[0, 0, 0, 10]]' }))).toThrow();
  });
  it('a reference id from art/refs/ship.yaml parses; an id in no manifest is refused naming art/refs', () => {
    const withRef = (id: string): string => plate({ extra: `reference:\n  - { refs: [${id}], model: style, weight: 1.0, weightType: style transfer }` });
    expect(() => parseRecipe(withRef('set.bridge.wide.1'), '/x/plate.bridge.yaml')).not.toThrow();
    expect(() => parseRecipe(withRef('set.bridge.nope.9'), '/x/plate.bridge.yaml')).toThrow(/art\/refs/);
    expect(manifestIds().has('set.lab.1')).toBe(true);
    expect(manifestIds().has('set.bridge.carpet.1')).toBe(true);
  });
});

describe('upscale-only card recipes', () => {
  const card = (extra: string): string => `id: card.t
kind: card
object: t
sprite: w3s4myec.spr
prop: { screen: zoo.s04, objects: [zoo.carcass.0417] }
sampling: { seed: 1, steps: 20, cfg: 5, sampler: dpmpp_2m, scheduler: karras }
prompt: x
denoise: 0.3
${extra}
`;
  it('defaults to a repaint', () => {
    const r = parseRecipe(card(''), 'card.t.yaml');
    expect(r.kind === 'card' && r.repaint).toBe(true);
  });
  it('takes repaint: false, with an align skip and its reason', () => {
    const r = parseRecipe(card('repaint: false\nalign: { skip: true, reason: speckle }'), 'card.t.yaml');
    expect(r.kind === 'card' && r.repaint === false && r.align?.skip).toBe(true);
  });
  it('refuses an align skip on a repainted card, or without a reason', () => {
    expect(() => parseRecipe(card('align: { skip: true, reason: speckle }'), 'card.t.yaml')).toThrow(/upscale-only card/);
    expect(() => parseRecipe(card('repaint: false\nalign: { skip: true }'), 'card.t.yaml')).toThrow();
  });
});

describe('animated prop cards', () => {
  const card = (prop: string): string => `id: card.t
kind: card
object: t
sprite: 3db.spr
prop: ${prop}
anims: [0, 1]
sampling: { seed: 1, steps: 20, cfg: 5, sampler: dpmpp_2m, scheduler: karras }
prompt: x
denoise: 0.3
`;
  it('publishes no frame strips unless the recipe lists the animations (animate)', () => {
    const r = parseRecipe(card('{ screen: allanor.s01, objects: [allanor.door.011b] }'), 'card.t.yaml');
    expect(r.kind === 'card' && r.prop?.animate).toEqual([]);
  });
  it('takes the animations whose every frame is published, and refuses a repeat or a negative one', () => {
    const r = parseRecipe(card('{ screen: allanor.s01, objects: [allanor.door.011b], animate: [0, 1] }'), 'card.t.yaml');
    expect(r.kind === 'card' && r.prop?.animate).toEqual([0, 1]);
    expect(() => parseRecipe(card('{ screen: allanor.s01, objects: [allanor.door.011b], animate: [1, 1] }'), 'card.t.yaml')).toThrow(/once/);
    expect(() => parseRecipe(card('{ screen: allanor.s01, objects: [allanor.door.011b], animate: [-1] }'), 'card.t.yaml')).toThrow();
  });
});

describe('combat\'s console recipes (Plan 30 R3, R5)', () => {
  const head = (id: string, source: string, extra = '') => `id: ${id}
kind: repaint
source: ${source}
sampling: { seed: 1, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a console
denoise: 0.6
${extra}`;
  const parse = (t: string, id: string) => parseRecipe(t, `/x/${id}.yaml`, new Set());
  it('takes the console as plate.tactical and the pages\' atlas as pages.tactical, and only so', () => {
    const c = parse(head('plate.tactical', '{ space: console }', 'keep: [[0, 297, 127, 183]]\nareas: { view: [319, 23, 320, 220] }'), 'plate.tactical') as RepaintRecipe;
    expect([c.source, c.keep, c.areas, plateStation(c)]).toEqual([{ space: 'console' }, [[0, 297, 127, 183]], { view: [319, 23, 320, 220] }, null]);
    expect((parse(head('pages.tactical', '{ space: pages }'), 'pages.tactical') as RepaintRecipe).source).toEqual({ space: 'pages' });
    expect(() => parse(head('plate.bridge', '{ space: console }'), 'plate.bridge')).toThrow(/plate\.tactical/);
    expect(() => parse(head('pages.tactical', '{ space: pages }', 'areas: { view: [1, 2, 3, 4] }'), 'pages.tactical')).toThrow(/no keep or areas/);
    expect(() => parse(head('plate.tactical', '{ space: console }', 'window: { at: [1, 2] }'), 'plate.tactical')).toThrow(/viewscreen only/);
    expect(() => parse(head('plate.tactical', '{ ship: bridge }'), 'plate.tactical')).toThrow(/plate\.<station>/);
  });
});

describe('the admin console\'s recipes (Plan 32 Task 12)', () => {
  const head = (id: string, source: string, extra = '') => `id: ${id}
kind: repaint
source: ${source}
sampling: { seed: 1, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a console
denoise: 0.5
${extra}`;
  const parse = (t: string, id: string) => parseRecipe(t, `/x/${id}.yaml`, new Set());
  it('takes the console as plate.admin and final.spr as plate.final, with keep and areas, and only so', () => {
    const c = parse(head('plate.admin', '{ admin: console }', 'keep: [[33, 12, 354, 302]]\nareas: { screen: [35, 41, 348, 270] }'), 'plate.admin') as RepaintRecipe;
    expect([c.source, c.keep, c.areas, plateStation(c)]).toEqual([{ admin: 'console' }, [[33, 12, 354, 302]], { screen: [35, 41, 348, 270] }, null]);
    expect((parse(head('plate.final', '{ admin: final }'), 'plate.final') as RepaintRecipe).source).toEqual({ admin: 'final' });
    expect(() => parse(head('plate.admin', '{ admin: final }'), 'plate.admin')).toThrow(/plate\.final/);
    expect(() => parse(head('plate.final', '{ admin: pages }'), 'plate.final')).toThrow();
    expect(() => parse(head('plate.final', '{ admin: final }', 'window: { at: [1, 2] }'), 'plate.final')).toThrow(/viewscreen only/);
    expect(() => parse(head('plate.admin', '{ ship: bridge }'), 'plate.admin')).toThrow(/plate\.<station>/);
  });
  it('takes each screen page as plate.admin.<page> (Plan 33 Task 7)', () => {
    for (const page of ['load', 'save', 'new', 'quit', 'sound']) {
      const r = parse(head(`plate.admin.${page}`, `{ admin: ${page} }`, 'repaint: false\nkeep: [[44, 47, 332, 256]]\npost:\n  - align: { maxShift: 2 }'), `plate.admin.${page}`) as RepaintRecipe;
      expect([r.source, r.repaint, r.keep, plateStation(r)]).toEqual([{ admin: page }, false, [[44, 47, 332, 256]], null]);
    }
    expect(() => parse(head('plate.admin.save', '{ admin: load }'), 'plate.admin.save')).toThrow(/plate\.admin\.load/);
    expect(() => parse(head('plate.admin', '{ admin: sound }'), 'plate.admin')).toThrow(/plate\.admin\.sound/);
  });
});

describe('combat\'s texture and upscale recipes (Plan 30 R8, R11)', () => {
  const parse = (t: string, id: string) => parseRecipe(t, `/x/${id}.yaml`, new Set());
  it('takes one recipe for every combat texture, with its defaults, and one for the upscales', () => {
    const t = parse(`id: space.textures
kind: spacetex
sampling: { seed: 300001, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }
prompt: a hull
denoise: 0.3
seeds: { a.gif: 7 }
`, 'space.textures');
    expect(t).toMatchObject({ kind: 'spacetex', denoise: 0.3, minSide: 32, islands: { grow: 1, feather: 4 }, seeds: { 'a.gif': 7 }, upscaleOnly: [], align: { maxShift: 2 } });
    expect(() => parse('id: space.textures\nkind: spacetex\nsampling: { seed: 1, steps: 30, cfg: 4.5, sampler: dpmpp_2m, scheduler: karras }\nprompt: x\ndenoise: 0.6\n', 'space.textures')).toThrow();
    expect(parse('id: space.upscales\nkind: spaceup\n', 'space.upscales')).toMatchObject({ kind: 'spaceup', dedither: { method: 'bilateral' } });
  });
});
