// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { liftGame } from './lift';
import { deepMerge, readOverrides } from './overrides';
import { LiftError } from './problems';
import { rawFromMini } from './testing/ctx';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function overridesDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'overrides-'));
  temps.push(dir);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

describe('deepMerge', () => {
  it('merges objects, replaces arrays and scalars, and deletes on null', () => {
    expect(deepMerge(
      { a: 1, b: { c: 2, d: 3 }, e: [1, 2], f: 'x' },
      { b: { c: 9 }, e: [3], f: null, g: true },
    )).toEqual({ a: 1, b: { c: 9, d: 3 }, e: [3], g: true });
  });
});

describe('overrides', () => {
  it('merges hand edits by stable id before the engine checks the result', async () => {
    const dir = await overridesDir({
      'objects/horst3/rubble.yaml': 'id: horst3.rubble\nname: Rocks\non: { get: [{ do: [{ alter: { object: horst3.rubble, get: true } }] }] }\n',
      'game.yaml': 'start: { awayTeam: [picard, data] }\n',
      'triggers.yaml': 't4: { enabled: false }\n',
      'coords.yaml': 'metersPerPixel: 0.02\n',
      'contexts.yaml': 'o_000001: { screen: s_0701 }\n',
    });
    const overrides = await readOverrides(dir);
    expect(overrides.coords.metersPerPixel).toBe(0.02);
    expect(overrides.contexts).toEqual({ o_000001: { screen: 's_0701' } });
    const result = liftGame(rawFromMini(), { worlds: [7] }, overrides);
    expect(result.problems.errors).toEqual([]);
    expect(result.applied).toEqual(['game.yaml', 'objects/horst3/rubble.yaml', 'triggers.yaml']);
    const c = result.content!;
    expect(c.objects['horst3.rubble'].name).toBe('Rocks');
    expect(c.objects['horst3.rubble'].on?.get).toHaveLength(1);
    expect(c.objects['horst3.rubble'].on?.use).toHaveLength(2);
    expect(c.start.awayTeam).toEqual(['picard', 'data']);
    expect(c.triggers.find(t => t.id === 't4')?.enabled).toBe(false);
    expect(c.rules.talkDistance).toBe(3.6);
  });

  it('fails on an override for an id the lifter did not generate', async () => {
    const dir = await overridesDir({ 'objects/old.yaml': 'id: horst3.gone\nname: Gone\n', 'advice.yaml': 'horst3.a9: {}\n' });
    const result = liftGame(rawFromMini(), { worlds: [7] }, await readOverrides(dir));
    expect(result.problems.errors).toEqual([
      'overrides/objects/old.yaml: no generated object "horst3.gone" to override',
      'overrides/advice.yaml: no generated advice "horst3.a9" to override',
    ]);
  });

  it('accepts an override that only names its id, and refuses one without an id', async () => {
    const changed = await overridesDir({ 'objects/rubble.yaml': 'id: horst3.rubble\n' });
    const result = liftGame(rawFromMini(), { worlds: [7] }, await readOverrides(changed));
    expect(result.problems.errors).toEqual([]);
    const missing = await overridesDir({ 'objects/rubble.yaml': 'name: Rocks\n' });
    const error = await readOverrides(missing).catch(e => e);
    expect(error).toBeInstanceOf(LiftError);
    expect((error as LiftError).problems).toEqual(['overrides/objects/rubble.yaml: needs a string "id"']);
  });

  it('reads every projection field of a screen in coords.yaml, topY included, and refuses others', async () => {
    const dir = await overridesDir({ 'coords.yaml': 'screens:\n  horst3.s01: { kind: perspective, slope: 0.01, horizonY: -40, meanScale: 1, topY: 210 }\n' });
    expect((await readOverrides(dir)).coords.screens).toEqual({ 'horst3.s01': { kind: 'perspective', slope: 0.01, horizonY: -40, meanScale: 1, topY: 210 } });
    const bad = await overridesDir({ 'coords.yaml': 'screens:\n  horst3.s01: { bottomY: 3 }\n' });
    await expect(readOverrides(bad)).rejects.toBeInstanceOf(LiftError);
  });

  it('reads nothing from a missing directory', async () => {
    const o = await readOverrides(join(tmpdir(), 'no-such-overrides-dir'));
    expect(o.objects.size).toBe(0);
    expect(o.contexts).toEqual({});
  });

  it('refuses keys that could poison a merge, and merges only own keys', async () => {
    const dir = await overridesDir({ 'objects/rubble.yaml': 'id: horst3.rubble\n__proto__: { polluted: true }\n' });
    const error = await readOverrides(dir).catch(e => e);
    expect(error).toBeInstanceOf(LiftError);
    expect((error as LiftError).problems).toEqual(['overrides/objects/rubble.yaml: key at /__proto__ is not allowed']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(deepMerge({}, JSON.parse('{"__proto__":{"x":1},"toString":{"y":2}}'))).toEqual({ toString: { y: 2 } });
  });

  it('reports malformed YAML and files that are not a kind of override', async () => {
    const dir = await overridesDir({ 'objects/bad.yaml': 'id: [unclosed\n', 'misc/other.yaml': 'a: 1\n', 'notes.txt': 'hi\n', '.gitkeep': '' });
    const error = await readOverrides(dir).catch(e => e);
    expect(error).toBeInstanceOf(LiftError);
    const problems = (error as LiftError).problems;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^overrides\/misc\/other\.yaml: not a kind of override/);
    expect(problems[1]).toMatch(/^overrides\/objects\/bad\.yaml: YAML error/);
    const ok = await readOverrides(await overridesDir({ 'notes.txt': 'hi\n', '.gitkeep': '' }));
    expect(ok.warnings).toEqual(['overrides/notes.txt: not a .yaml file, ignored']);
  });
});
