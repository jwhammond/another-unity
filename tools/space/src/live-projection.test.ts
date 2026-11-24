// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { builtModel, samplePoses, threeProject } from '../../../engine/src/testing/projection';
import { v3, type V3 } from '../../../engine/src/sim/combat/math';
import { FULL_RECT, scummProject, SPLIT_RECT } from '../../../engine/src/view/combat/projection';

// (games/unity/space after npm run unity:build, docs/unity-local.md)
const SPACE = fileURLToPath(new URL('../../../games/unity/space', import.meta.url));
const built = existsSync(SPACE) && readdirSync(SPACE).some(f => f.endsWith('.glb'));
if (!built) console.info('live-projection.test.ts: skipped; run npm run unity:build for games/unity/space (docs/unity-local.md)');

describe.skipIf(!built)('every model of the space build, projected (M8 spec §3.1)', () => {
  it('lands every vertex where ScummVM\'s projection puts it, within half a pixel, at every sample pose, in Split and in Full', async () => {
    const io = new NodeIO();
    let models = 0, compared = 0, worst = 0, billboards = 0;
    for (const file of readdirSync(SPACE).filter(f => f.endsWith('.glb')).sort()) {
      const doc = await io.read(`${SPACE}/${file}`);
      // (the root node the space build turns, and every part's vertices as the file has them: no part node moves its mesh)
      const root = doc.getRoot().getDefaultScene()!.listChildren()[0]!;
      const vertices: V3[] = [];
      // (a billboard part's vertices are steps in the camera's axes: drawObject, space3d.cpp:299-300. The scene places a model
      // whose parts are billboards with the camera's axes; no model mixes the two (measured: bboard's and photon's one part each))
      const kinds = new Set<boolean>();
      for (const part of root.listChildren()) {
        expect([part.getTranslation(), part.getRotation(), part.getScale()], `${file} ${part.getName()}`).toEqual([[0, 0, 0], [0, 0, 0, 1], [1, 1, 1]]);
        const position = part.getMesh()?.listPrimitives()[0]?.getAttribute('POSITION');
        if (!position) continue;
        kinds.add((part.getExtras() as { billboard?: boolean }).billboard === true);
        for (let i = 0; i < position.getCount(); i++) {
          const [x, y, z] = position.getElement(i, [0, 0, 0]) as [number, number, number];
          vertices.push(v3(x, y, z));
        }
      }
      expect(kinds.size, `${file} mixes billboard and model parts`).toBeLessThanOrEqual(1);
      const billboard = kinds.has(true);
      if (billboard) billboards++;
      const model = builtModel(vertices, root.getRotation());
      for (const { pos, m, cam } of samplePoses()) {
        for (const [w, h] of [[SPLIT_RECT.width, SPLIT_RECT.height], [FULL_RECT.width, FULL_RECT.height]] as const) {
          const three = threeProject(model, vertices, pos, billboard ? cam.axes : m, cam, w, h);
          vertices.forEach((v, i) => {
            const s = scummProject(v, pos, m, cam, w, h, billboard);
            // (in front of the near plane (space3d.cpp:370), and on the window or within a window of it: far off it, both are
            // tens of thousands of pixels out, where float32's rounding alone is pixels)
            if (s.z < 1 || s.x < -w || s.x > 2 * w || s.y < -h || s.y > 2 * h) return;
            worst = Math.max(worst, Math.abs(three[i]!.x - s.x), Math.abs(three[i]!.y - s.y));
            compared++;
          });
        }
      }
      models++;
    }
    console.info(`live-projection.test.ts: ${models} models (${billboards} billboards), ${compared} vertex projections, the worst ${worst.toExponential(2)} px apart`);
    expect([models, billboards]).toEqual([85, 2]);
    expect(worst).toBeLessThan(0.5);
    expect(worst).toBeLessThan(0.01);
  });
});
