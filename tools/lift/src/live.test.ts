// SPDX-License-Identifier: GPL-3.0-or-later
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SHIP_FLAGS } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { ALL_AWAY } from './cli';
import { HARDCODED } from './hardcoded';
import { worldSlug } from './ids';
import { liftGame } from './lift';
import { readOverrides } from './overrides';
import { readRaw } from './raw';
import { loadSpriteBounds } from './room';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw (Plan 3: sh tools/rawcheck/run-harness.sh export 300)
// IMAGES_DIR=$HOME/pcode/unity-raw/runs/images/media is optional (hotspot sizes)
const RAW = process.env.RAW_DIR ?? '';
const IMAGES = process.env.IMAGES_DIR ?? '';
if (!RAW) console.info('live.test.ts: skipped; set RAW_DIR to Plan 3\'s export (…/runs/export/raw) to lift Horst III from the real data');

// (each test lifts the real export, which takes 5-10 s: more under the other live suites running beside it)
describe.skipIf(!RAW)('lifting Horst III from the real export (needs RAW_DIR)', { timeout: 120_000 }, () => {
  async function lift() {
    const raw = await readRaw(RAW);
    const overrides = await readOverrides('games/unity/overrides');
    return liftGame(raw, { worlds: [7], sprites: IMAGES ? await loadSpriteBounds(IMAGES) : undefined }, overrides);
  }

  it('lifts the ship\'s computer: subentries and readings\' entries are in range', async () => {
    const result = await lift();
    const tree = result.lifted.computer;
    expect(tree).toBeDefined();
    const n = tree!.entries.length;
    console.info(`computer: ${n} entries, ${tree!.entryIds.length} entry ids, ${Object.keys(tree!.readingParents).length} readings`);
    for (const e of tree!.entries) for (const sub of e.subentries) expect(sub).toBeLessThan(n);
    const raw = await readRaw(RAW);
    for (const r of raw.executable._tricorderReadings) expect(r.entry).toBeLessThan(n);
  });

  it('lifts the universe: 512 sectors, one flag per thing, and the star at (90, 90, 90)', async () => {
    const u = (await lift()).lifted.universe;
    expect(u).toBeDefined();
    expect(u!.sectors).toHaveLength(512);
    const things = u!.stars.length + u!.phenomena.length + u!.stations.length + u!.specials.length;
    expect(u!.flags).toHaveLength(things);
    const home = 4 + 4 * 8 + 4 * 64;
    expect(u!.sectors[home].numStars).toBeGreaterThan(0);
    expect(u!.stars.some(s => Math.floor(s.x / 20) === 4 && Math.floor(s.y / 20) === 4 && Math.floor(s.z / 20) === 4)).toBe(true);
    console.info(`universe: ${u!.stars.length} stars, ${u!.phenomena.length} phenomena, ${u!.stations.length} stations, ${u!.specials.length} specials, ${u!.flags.length} flags`);
  });

  it('lifts the ship: item and team counts match the export, and no team lists the phaser', async () => {
    const result = await lift();
    const ship = result.lifted.ship;
    const raw = await readRaw(RAW);
    expect(ship.bridge.items).toHaveLength(raw.executable._bridgeItems.length);
    expect(ship.bridge.turbolift).toHaveLength(raw.executable._bridgeScreenEntries.length);
    expect(ship.transporter.teams).toHaveLength(raw.executable._awayTeamScreenData.length);
    expect(ship.transporter.teams.map(t => t.world)).toEqual(raw.executable._awayTeamScreenData.map((_, i) => i + 1));
    const phaser = result.lifted.ids.objects[HARDCODED.items.phaser];
    // the phaser kit isn't in the team rows: TransporterScreen::start builds it from shipEquipment() (transporter.cpp:166-200; Plan 11 Task 9)
    expect(phaser).toBeDefined();
    for (const t of ship.transporter.teams) expect(t.items).not.toContain(phaser);
    expect(result.problems.errors).toEqual([]);
    console.info(`ship: ${ship.bridge.items.length} bridge items, ${ship.bridge.objects.length} objects, ${ship.bridge.turbolift.length} turbolift, ` +
      `${ship.transporter.exits.length} exits, ${ship.transporter.teams.length} teams, ${ship.units.length} units, ${ship.speeds.warp.length}/${ship.speeds.impulse.length} speeds`);
  });

  it('lifts the rest of the ship: reveals, warp movies, the computer\'s start, the space world\'s battles and the bridge\'s contacts (Plan 12 Task 1)', async () => {
    const result = await lift();
    const raw = await readRaw(RAW);
    const { ship, universe, computer, presentation } = result.lifted;
    expect(result.problems.errors).toEqual([]);
    expect(universe!.reveals).toHaveLength(raw.executable._astroReveals.length);
    expect(presentation.opening).toHaveLength(2);
    expect(presentation.warpMovies).toHaveLength(raw.executable._warpMovies.length);
    expect(presentation.warpMovies!.slice(1).every(m => m !== null)).toBe(true);
    expect(computer!.readings).toHaveLength(raw.executable._tricorderReadings.length);
    for (const e of [...computer!.hidden]) expect(e).toBeLessThan(computer!.entries.length);
    const scenarios = [...raw.screens.values()].filter(s => s.world === 0x10).map(s => s.screen);
    // (the space world's battles are combat.yaml's: Plan 23)
    const combat = result.lifted.combat!;
    expect(Object.keys(combat.battles).map(Number).sort((a, b) => a - b)).toEqual(scenarios.sort((a, b) => a - b));
    const ships = Object.values(combat.battles).flatMap(b => b.ships);
    // (Enter, Exit and Warp aren't ships, and a name that matches no kind is left out; the friendly kinds by kShipKinds' flags)
    expect(ships.length).toBeGreaterThan(0);
    expect(ships.every(x => ((combat.kinds[x.type]!.flags & SHIP_FLAGS.friendly) !== 0) === ['klingon', 'ferengi', 'starbase', 'shuttle', 'mother'].includes(combat.kinds[x.type]!.name))).toBe(true);
    expect(ship.contacts.lounge.length).toBeGreaterThan(0);
    expect(ship.contacts.comms.length).toBeGreaterThan(ship.contacts.comms.filter(c => c.sprite).length);
    console.info(`rest of the ship: ${universe!.reveals.length} reveals, ${presentation.warpMovies!.length - 1} warp movies, ${computer!.hidden.length} hidden entries, ` +
      `${computer!.startReadings.length} start readings, ${computer!.readings.length} readings, ${Object.keys(combat.battles).length} battles, ${ships.length} ships, ` +
      `${ship.contacts.comms.length} comms and ${ship.contacts.lounge.length} lounge contacts`);
  });

  it('lifts world 7 with every IR field accounted for, and the engine loads it', async () => {
    const result = await lift();
    expect(result.problems.errors).toEqual([]);
    const cov = result.lifted.coverage.get('horst3')!;
    expect(cov.fields.consumed + cov.fields.ignored).toBe(cov.fields.total);
    console.info(`horst3: ${cov.objects} objects, ${cov.stubs} stubs, ${cov.rules.groups} groups, ${cov.rules.noops} no-ops, ` +
      `hooks: ${cov.hooks.map(h => h.name).join(', ') || 'none'}; ${cov.warnings.length} warnings`);

    const c = result.content!;
    const slug = (id: string) => result.lifted.ids.objects[id];
    expect(c.start.screen).toBe('horst3.s01');
    // (world 7 has two "rubble" objects, 070103 and 07010c, so their slugs carry their ids: look them up)
    const rubble = slug('070103');
    expect(rubble).toBe('horst3.rubble.0103');
    expect(c.objects[rubble]).toMatchObject({ screen: 'horst3.s01', at: rubble });
    expect(Object.keys(c.objects[rubble].descriptions ?? {}).length).toBeGreaterThan(0);
    for (const item of ['007000', '007001', '007003', '007004']) expect(c.objects[slug(item)].inventory).toBe(true);
    const setup = c.objects[slug('070100')];
    const first = setup?.on?.use?.[0].do ?? [];
    expect('trigger' in first[0]).toBe(true);
    expect('act' in first[first.length - 1] || 'call' in first[first.length - 1]).toBe(true);
    for (const s of ['horst3.s01', 'horst3.s02', 'horst3.s03', 'horst3.s04']) expect(c.screens[s]).toBeDefined();
    const s01 = c.screens['horst3.s01'];
    expect(Object.keys(s01.markers).filter(m => m.startsWith('entrance_'))).toHaveLength(8);
    expect(Object.keys(s01.regions ?? {})).toHaveLength(8);
    // (fitted to the walkable polygons only: Decision 7)
    expect(result.lifted.coords.screens['horst3.s01'].projection.slope).toBeCloseTo(1.438, 3);
    expect(Object.keys(result.lifted.rooms.get('horst3.s01')!.room.regions)).toHaveLength(7);
    expect(c.conversations['ship.c034']?.ship).toBe(true);
    expect(c.conversations['frigis.c015']).toBeDefined();
    for (const marker of Object.values(s01.markers)) expect(Number.isFinite(marker.x) && Number.isFinite(marker.z)).toBe(true);
  }, 180_000);

  it('gives the same files twice', async () => {
    const [a, b] = [await lift(), await lift()];
    expect([...a.files]).toEqual([...b.files]);
  }, 300_000);

  it('calls no hook that still throws NotPorted (spec §9, Done when 4)', async () => {
    const result = await lift();
    const cov = result.lifted.coverage.get('horst3')!;
    console.info(`horst3 hooks: ${JSON.stringify(cov.hooks)}`);
    expect(cov.hooks.filter(h => !h.ported)).toEqual([]);
    expect(result.files.get('hooks/generated.ts')).not.toContain('throw new NotPorted(');
  }, 180_000);

  it('names no hook anywhere in the export: CommandBlocks are 2-6, GeneralBlock types are known (Plan 6 Decision 1)', async () => {
    const found: string[] = [];
    const visit = (value: unknown, where: string): void => {
      if (Array.isArray(value)) {
        value.forEach((v, i) => visit(v, `${where}/${i}`));
        return;
      }
      if (value === null || typeof value !== 'object') return;
      const o = value as Record<string, unknown>;
      const command = Number(o.command_id);
      if (o.class === 'CommandBlock' && !(command >= 2 && command <= 6)) found.push(`${where}: CommandBlock ${command}`);
      const general = Number(o.command);
      if (o.class === 'GeneralBlock' && general !== 0xffff && ![1, 2, 3, 4, 7, 8, 9, 10].includes(Math.floor(general / 1000))) {
        found.push(`${where}: GeneralBlock command ${general}`);
      }
      for (const [k, v] of Object.entries(o)) visit(v, `${where}/${k}`);
    };
    for (const dir of ['objects', 'conversations']) {
      for (const file of (await readdir(join(RAW, dir))).sort()) visit(JSON.parse(await readFile(join(RAW, dir, file), 'utf8')), `${file}#`);
    }
    expect(found).toEqual([]);
  }, 180_000);

  it('keeps the team in place coming back from the close-up', async () => {
    const result = await lift();
    const exit = result.content!.objects[result.lifted.ids.objects['070404']];
    expect(JSON.stringify(exit.on)).toContain('"stay":true');
    expect(result.problems.warnings.filter(w => w.includes('entrance 0xff'))).toEqual([]);
  }, 180_000);
});

describe.skipIf(!RAW)('lifting every away world from the real export (needs RAW_DIR; M3 §6 Done when 1)', () => {
  async function lift(worlds: readonly number[], start?: number) {
    const raw = await readRaw(RAW);
    const overrides = await readOverrides('games/unity/overrides');
    return liftGame(raw, { worlds: [...worlds], start, sprites: IMAGES ? await loadSpriteBounds(IMAGES) : undefined }, overrides);
  }
  const summary = (slug: string, c: { objects: number; stubs: number; rules: { groups: number; noops: number }; warnings: string[]; fields: { consumed: number; ignored: number; total: number } }) =>
    `${slug}: ${c.objects} objects, ${c.stubs} stubs, ${c.rules.groups} groups, ${c.rules.noops} no-ops, fields ${c.fields.consumed}+${c.fields.ignored}/${c.fields.total}, ${c.warnings.length} warnings`;

  it.each(ALL_AWAY)('lifts world %i alone: no errors, every IR field accounted for, no hook', async w => {
    const result = await lift([w]);
    expect(result.problems.errors).toEqual([]);
    const cov = result.lifted.coverage.get(worldSlug(w))!;
    console.info(summary(worldSlug(w), cov));
    expect(cov.fields.consumed + cov.fields.ignored).toBe(cov.fields.total);
    expect(cov.hooks).toEqual([]);
  }, 300_000);

  it('lifts worlds 2-7 together, starting in Horst III, and the engine loads it', async () => {
    const result = await lift(ALL_AWAY, 7);
    expect(result.problems.errors).toEqual([]);
    const c = result.content!;
    expect(c.start.screen).toBe('horst3.s01');
    for (const w of ALL_AWAY) {
      const cov = result.lifted.coverage.get(worldSlug(w))!;
      console.info(summary(worldSlug(w), cov));
      expect(cov.fields.consumed + cov.fields.ignored).toBe(cov.fields.total);
      expect(cov.hooks).toEqual([]);
      expect(Object.values(c.screens).some(s => s.id.startsWith(`${worldSlug(w)}.`))).toBe(true);
    }
    expect(result.files.get('hooks/generated.ts')).not.toContain('throw new NotPorted(');
  }, 600_000);

  it('lifts Horst III the same alone as with the other worlds', async () => {
    const own = (files: Map<string, string>) => [...files].filter(([p]) => /^(screens|objects|conversations|rooms)\/horst3\//.test(p));
    const [alone, all] = [await lift([7]), await lift(ALL_AWAY, 7)];
    expect(own(all.files)).toEqual(own(alone.files));
  }, 600_000);

  it('starts each mission where its ship script beams the team down (M3 Plan 8 R6)', async () => {
    const raw = await readRaw(RAW!);
    const beams = (o: unknown): [number, number][] => {
      if (Array.isArray(o)) return o.flatMap(beams);
      if (o === null || typeof o !== 'object') return [];
      const b = o as Record<string, unknown>;
      const here: [number, number][] = b.class === 'BeamBlock' ? [[b.world_id as number, b.screen_id as number]] : [];
      return [...here, ...Object.values(b).flatMap(beams)];
    };
    for (const m of HARDCODED.missions) {
      for (const source of m.source.match(/(o_5f[0-9a-f]{4}|w05fc\d{3})/g) ?? []) {
        const file = source.startsWith('o_') ? raw.objects.get(source.slice(2)) : raw.conversations.get(source);
        expect(beams(file), source).toContainEqual([m.world, m.screen]);
      }
    }
    const result = await lift(ALL_AWAY);
    expect(result.content!.start.screen).toBe('horst3.s01');
    expect(result.content!.missions!.map(m => m.screen)).toEqual(['horst3.s01', 'allanor.s01', 'zoo.s03', 'lab.s01', 'frigis.s01', 'unity.s01']);
  }, 300_000);

  it('gives the same files twice', async () => {
    const [a, b] = [await lift(ALL_AWAY, 7), await lift(ALL_AWAY, 7)];
    expect([...a.files]).toEqual([...b.files]);
  }, 900_000);
});
