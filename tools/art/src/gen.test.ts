// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { gen, parseSize } from './gen';
import { decodePng } from './image';
import { modelsFor, defaultChoice } from './select';
import { loadModels } from './models';
import { FakeGenerator } from './testing/fakeGenerator';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = loadModels(readFileSync(join(__dirname, '..', '..', '..', 'art', 'models.yaml'), 'utf8'));

describe('art gen', () => {
  it('writes an image of the size asked for, with the seed in the graph', async () => {
    const g = new FakeGenerator();
    const png = decodePng(await gen(g, modelsFor(file, defaultChoice(file)), { prompt: 'a lab', seed: 5, size: [1024, 1024] }));
    expect([png.width, png.height]).toEqual([1024, 1024]);
    const ks = Object.values(g.jobs[0]!.graph).find(n => n.class_type === 'KSampler')!;
    expect(ks.inputs.seed).toBe(5);
  });

  it('parses sizes strictly', () => {
    expect(parseSize('1024x768')).toEqual([1024, 768]);
    expect(() => parseSize('1001x1000')).toThrow(/multiples of 8/);
    expect(() => parseSize('big')).toThrow();
  });

  it('resolves model keys to the names ComfyUI lists, with the union flag only for the union net', () => {
    const m = modelsFor(file, defaultChoice(file));
    expect(m.checkpoint).toBe('sd_xl_base_1.0.safetensors');
    expect(m.depth).toMatchObject({ annotator: 'depth_anything_v2_vits.pth', union: true });
    expect(m.lineart?.annotator).toBe('AnyLineArtPreprocessor_aux');
    const split = modelsFor(file, { ...defaultChoice(file), depth: 'cn-depth-sdxl-small', lineart: 'cn-mistoline' });
    expect(split.depth?.union).toBe(false);
    expect(split.lineart?.union).toBe(false);
  });
});
