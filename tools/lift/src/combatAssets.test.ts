// SPDX-License-Identifier: GPL-3.0-or-later
import { decodeBase64, makeTacticsBin } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { liftModels, liftTactics } from './combatAssets';
import { Problems } from './problems';
import { makeSpaceMaterials, makeSpaceModel } from './testing/space-files';

const page = (name: string, target = 0) => ({ cls: 3, opcode: 0x1f, page: name, args: [target] });
const good = makeTacticsBin([page('MAIN'), { cls: 1, opcode: 0x2b, args: [0] }, page('KERNEL', 0x6b)]);

describe('liftTactics (loadScript, tactics.cpp:157-183)', () => {
  it('keeps each named file whole, once, with its kernel and pages', () => {
    const problems = new Problems();
    const out = liftTactics(new Map([['zap.bin', good]]), ['zap.bin', 'zap.bin'], problems);
    expect(Object.keys(out)).toEqual(['zap.bin']);
    expect(out['zap.bin']).toMatchObject({ file: 'zap.bin', size: good.length, kernel: 0x6b, pages: [{ name: 'MAIN', offset: 7 }, { name: 'KERNEL', offset: 0x7b }] });
    expect(decodeBase64(out['zap.bin']!.code)).toEqual(good);
    expect(problems.warnings).toEqual([]);
  });

  it('warns about and leaves out a file the export lacks or load refuses, and keeps one whose tokens overrun, with a warning', () => {
    const problems = new Problems();
    const notTactics = good.slice();
    notTactics[0] = 0x58;
    const out = liftTactics(new Map([['bad.bin', notTactics], ['cut.bin', good.subarray(0, good.length - 2)]]), ['gone.bin', 'bad.bin', 'cut.bin'], problems);
    expect(Object.keys(out)).toEqual(['cut.bin']);
    const text = problems.warnings.join('\n');
    expect(text).toMatch(/gone\.bin isn't in the export's verbatim files/);
    expect(text).toMatch(/bad\.bin isn't a tactics file TacticScript::load accepts/);
    expect(text).toMatch(/cut\.bin: the tokens end at/);
  });
});

describe('liftModels (SpaceResources::model, space3d.cpp:519-535)', () => {
  const part = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] as [number, number, number][], faces: [{ material: 0, v: [0, 1, 2] as [number, number, number] }] };
  const files = new Map([
    ['zap.3dv', makeSpaceModel({ size: [100, 50, 200.5], centre: [0, 1.25, 0], parts: [part, part] })],
    // (a part of quads: SpaceModel::load keeps it without its vertices, space3d.cpp:152-156)
    ['quad.3dv', makeSpaceModel({ parts: [{ ...part, faceType: 3 }, part] })],
    ['zap.mtl', makeSpaceMaterials([{ flags: 1, texture: 'ZAP.IMG' }])],
    ['bad.3dv', makeSpaceModel({ parts: [part], version: 0x6f })],
  ]);

  it('records each model\'s url, files, size, centre, part count and each part\'s vertices, once per key, in key order', () => {
    const problems = new Problems();
    const out = liftModels(files, [
      { key: 'zap.dmg', geometry: 'zap.3dv', materials: 'zap.mtl' },
      { key: 'zap.3dv', geometry: 'zap.3dv', materials: 'zap.mtl' },
      { key: 'zap.3dv', geometry: 'zap.3dv', materials: 'zap.mtl' },
    ], problems);
    expect(Object.keys(out)).toEqual(['zap.3dv', 'zap.dmg']);
    expect(out['zap.3dv']).toEqual({ url: 'space/zap.3dv.glb', geometry: 'zap.3dv', materials: 'zap.mtl', size: [100, 50, 200.5], centre: [0, 1.25, 0], parts: 2, vertices: [3, 3] });
    expect(out['zap.dmg']!.url).toBe('space/zap.dmg.glb');
    expect(liftModels(files, [{ key: 'quad.3dv', geometry: 'quad.3dv', materials: null }], problems)['quad.3dv']!.vertices).toEqual([0, 3]);
    expect(problems.warnings).toEqual([]);
  });

  it('warns about and leaves out a model the export lacks or load refuses, and draws one without materials it lacks', () => {
    const problems = new Problems();
    const out = liftModels(files, [
      { key: 'gone.3dv', geometry: 'gone.3dv', materials: null },
      { key: 'bad.3dv', geometry: 'bad.3dv', materials: null },
      { key: 'zap.pc1', geometry: 'zap.3dv', materials: 'zap.mtr' },
    ], problems);
    expect(Object.keys(out)).toEqual(['zap.pc1']);
    expect(out['zap.pc1']!.materials).toBeNull();
    expect(problems.warnings).toHaveLength(3);
  });
});
