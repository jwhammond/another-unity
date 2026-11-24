// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignCheck } from './align';
import { artCache, liveReady } from './cache';
import { decodePng } from './image';
import { originalBackground } from './originals';
import { loadScreenInputs } from './screen';

const ready = liveReady();
const images = process.env.IMAGES_DIR;
const REPO = join(__dirname, '..', '..', '..');
const GAME = join(REPO, 'games', 'unity');
const lifted = existsSync(join(GAME, 'rooms', 'lab', 's01.json'));
const skip = !ready.ok || !images || !lifted;
if (skip) console.info(`live-align skipped: ${!ready.ok ? ready.why : !images ? 'IMAGES_DIR is not set' : 'games/unity/rooms is not lifted'}`);

describe.skipIf(skip)('live alignment of lab.s01', () => {
  it("lab.s01's last plate passes against s_0401 at every measurable point", async () => {
    const last = JSON.parse(readFileSync(join(artCache().work, 'lab.s01', 'last.json'), 'utf8')) as { meta: { outputs: { plate: { file: string } } } };
    const inputs = await loadScreenInputs(GAME, 'lab.s01');
    const original = decodePng(await originalBackground(images!, 's_0401'));
    const plate = decodePng(new Uint8Array(readFileSync(last.meta.outputs.plate.file)));
    const r = alignCheck(original, plate, inputs.points);
    expect(r.ok, r.why).toBe(true);
    expect(r.measured / r.total).toBeGreaterThanOrEqual(0.6);
  });
});
