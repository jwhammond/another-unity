// SPDX-License-Identifier: GPL-3.0-or-later
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { layerResident, type ResidentStrip } from '../../../engine/src/view/layerMemory';
import { act, artAnimatedRooms, artLayer, artMasks, crewFires, GAME_DIR, stripFiles, button, clickObject, hold, poll, scummvmPlayer, settled, state, watchConsole } from './helpers';

// (the rooms are independent pages: the workers share the file's tests, so a file of many rooms is not the tail of the run)
test.describe.configure({ mode: 'parallel' });

// Sprite placement against the original (docs/unity-sprite-placement.md): the layers the original draws over the actors, in the rooms where
// `art masks` once missed them. Each is skipped until the room's masks are published.

const shots = `${homedir()}/pcode/unity-raw/runs/placement`;

// Layers the original draws that `art masks` once missed: sprites named for a mask with no `mask` entry in their file (one still, drawn over the
// actors like a marked mask), and Mertens' woman, who lies in three rooms as the trapped, injured and dead woman and was a card in one object only.
const UNMARKED: [string, string[]][] = [
  ['lab.s01', ['lab.dead_woman.0102', 'lab.piece_of_cable.0101']],
  ['lab.s02', ['lab.cable_mask.0216', 'lab.trapped_woman.0200', 'lab.dead_woman.020c']],
  ['lab.s08', ['lab.dr_griems', 'lab.dead_crewman']],
  ['lab.s03', ['lab.cable_mask.031c', 'lab.injured_woman.0302', 'lab.dead_woman.0309']],
  ['frigis.s01', ['frigis.mask_small_pyramd', 'frigis.chancellor_laraq.0100', 'frigis.chancellor_laraq.010c']],
  // Allanor's drones and chodak, the characters that had no card (not here: s0d's are drawn at 2/256 of their size, no layer; s0e is below, with the cutscenes)
  ['allanor.s01', ['allanor.drone.011e', 'allanor.alloy_seal.0100', 'allanor.alloy_seal.0109', 'allanor.alloy_seal.0121', 'allanor.ashes.0116', 'allanor.foreign_object']],
  ['allanor.s04', ['allanor.drone.040b', 'allanor.sheet_of_metal.0404']],
  ['allanor.s05', ['allanor.drone.050a', 'allanor.logic_inhibitor.0507', 'allanor.sheet_of_metal.0510']],
  ['allanor.s06', ['allanor.alien.061a', 'allanor.alien.061b']],
  ['allanor.s0b', ['allanor.optimator_one.0b10', 'allanor.dead_optimator.0b11']],
  ['allanor.s0c', ['allanor.chodak_master.0c06', 'allanor.optimator_one.0c07', 'allanor.optimator_two.0c08', 'allanor.pedestal.0c05']],
  // Frigis' characters (batch 2): a card is drawn even when its sorting row is above the horizon, as the dead optimator's
  ['frigis.s06', ['frigis.pluvoids', 'frigis.golden_ring.0603']],
  ['frigis.s07', ['frigis.aelont.071e']],
  ['frigis.s09', ['frigis.aelont.090a', 'frigis.stasis_field.0909', 'frigis.stasis_field.0910']],
  ['frigis.s0a', ['frigis.gatekeeper.0a13']],
  // Zoo characters (batch 3): the constable (030e shares the 0325 card) and the sultis reptile (the carcasses and the deer failed the card check twice)
  ['zoo.s03', ['zoo.constable_lliksze.030e']],
  ['zoo.s09', ['zoo.sultis_reptile', 'zoo.harmonic_collector']],
  // The carcasses and the deer: upscale-only cards (`repaint: false`), the repaint failed the card check on speckle; the deer is off at entry
  ['zoo.s02', ['zoo.deer']],
  ['zoo.s04', ['zoo.carcass.0417', 'zoo.carcass.0418', 'zoo.carcass.0419', 'zoo.bioprobe']],
  // Unity's characters (batch 4): the guardian (Picard's s0b is below, with the cutscenes; the Borg's cube failed the card check twice)
  ['unity.s0a', ['unity.guardian.0a07']],
  // the Borg's cubes: an upscale-only card
  ['unity.s0f', ['unity.borg']],
  // Mertens' props (batch 7, `placement triage`: static-missing; `lab.piece_of_cable.0101`, above, is a decal on the far wall, its foot row 100 above the horizon: `maskQuad` stands it on its own rectangle): the hull breach and left turbolift pillar, and the six tools on the shelf (two are upscale-only)
  ['lab.s06', ['lab.hull_breach', 'lab.turbolift_l_t']],
  ['lab.s07', ['lab.flux_router', 'lab.inverter_coupling', 'lab.pulse_negator', 'lab.wave_converter', 'lab.plasma_shunt', 'lab.graviton_probe']],
  // Small batch 7b (static-missing): Allanor's seals, ashes, logic inhibitor, sheets of metal, shell, phaser, pedestal and star chart, and the zoo's fruit, bioprobe, flock and harmonic collector (the six upscale-only: seals, phaser, flock, fruit)
  ['allanor.s0a', ['allanor.chodak_shell', 'allanor.phaser']],
  ['allanor.s0f', ['allanor.star_chart']],
  ['zoo.s01', ['zoo.fruit']],
  ['zoo.s06', ['zoo.flock']],
  // Small batch 7c (static-missing): Frigis' orchestrion parts, golden ring, the items on the table of s0d, and Unity's disks and disk halves (the seven upscale-only: orchestrion 044b/044c, both talismans, the two staffs, the statuette)
  // (batch 8e adds Frigis' 22 floor tiles and the touch pad: stills of one frame that scripts turn on and off; the touch pad and the stasis fields' sprite are upscale-only)
  ['frigis.s04', ['frigis.orchestrion.044a', 'frigis.orchestrion.044b', 'frigis.orchestrion.044c', 'frigis.orchestrion.044d', 'frigis.touchpad.0434', 'frigis.floor_tile_06', 'frigis.floor_tile_08', 'frigis.floor_tile_0a', 'frigis.floor_tile_0c', 'frigis.floor_tile_0e', 'frigis.floor_tile_10', 'frigis.floor_tile_12', 'frigis.floor_tile_14', 'frigis.floor_tile_16', 'frigis.floor_tile_18', 'frigis.floor_tile_1a', 'frigis.floor_tile_1c', 'frigis.floor_tile_1e', 'frigis.floor_tile_20', 'frigis.floor_tile_22', 'frigis.floor_tile_24', 'frigis.floor_tile_26', 'frigis.floor_tile_28', 'frigis.floor_tile_2a', 'frigis.floor_tile_2c', 'frigis.floor_tile_2e', 'frigis.floor_tile_30']],
  ['frigis.s0d', ['frigis.talisman.0d06', 'frigis.talisman.0d07', 'frigis.staff.0d08', 'frigis.golden_ring.0d09', 'frigis.device.0d0a', 'frigis.stasis_jar', 'frigis.staff.0d0c', 'frigis.statuette']],
  ['unity.s0c', ['unity.disks']],
  ['unity.s0d', ['unity.disk_half.0d0b', 'unity.disk_half.0d0c']],
  ['frigis.s03', ['frigis.mask_pillar1', 'frigis.mask_pillar2', 'frigis.mask_pillar3', 'frigis.mask_pillar4']],
];

for (const [room, masks] of UNMARKED) {
  test(`${room}: the layers the original draws over the plate are all there`, async ({ page }) => {
    test.skip(!masks.every(m => artMasks(room).includes(m)), `the masks of ${room} are not published (art masks ${room})`);
    test.setTimeout(120_000);
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await settled(page);
    await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
    const art = await page.evaluate(() => window.__au!.art());
    for (const m of masks) expect(art.masks).toContain(m);
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${room}-masks.png` });
    expect(errors).toEqual([]);
  });
}

/** The phaser's power bar at a position 0-14 (5 is the low setting, 9 the medium one), as a player clicks it. */
async function setPhaser(page: import('@playwright/test').Page, position: number): Promise<void> {
  const box = (await page.getByRole('slider', { name: 'Phaser setting' }).boundingBox())!;
  await page.mouse.click(box.x + ((414 + 14 * position + 7 - 410) / 230) * box.width, box.y + box.height / 2);
}

// The rubble that blocks Horst III's first passage is a patch the original draws over the background, and the repainted plate has the passage open:
// without its card the obstacle was not there with art on. It shows until the phaser clears it (a low shot stuns it, a medium one clears it).
test('horst3.s01: the rubble pile is drawn until the phaser clears it', async ({ page }) => {
  test.skip(!artMasks('horst3.s01').includes('horst3.rubble.0103'), 'the rubble of horst3.s01 is not published (art batch art/recipes/card.horst3_rubble.yaml, then art masks horst3.s01)');
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=horst3.s01&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().shown.includes('horst3.rubble.0103')), 20_000);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/horst3-s01-rubble.png` });
  for (const position of [5, 9]) {
    await setPhaser(page, position);
    await act(page, async () => {
      await hold(page, 'phaser');
      await clickObject(page, 'horst3.rubble.0103');
    });
    await settled(page);
  }
  expect((await state(page)).objects['horst3.rubble.0103']!.active).toBe(false);
  expect((await page.evaluate(() => window.__au!.art())).shown).not.toContain('horst3.rubble.0103');
  expect(errors).toEqual([]);
});

// Batch 10: a crew member who fires the phaser plays the firing animation (kAnimFirePhaser + the direction), the beam is drawn from the frame the executable's muzzle table
// names and the animation holds there while it is (UnityEngine::phaserShot). Skipped until a crew card has the firing animations (art batch the crew's card recipes, art strips).
test('horst3.s01: the crew member who fires the phaser plays the firing animation, and the beam comes from the muzzle frame', async ({ page }) => {
  test.skip(!artMasks('horst3.s01').includes('horst3.rubble.0103'), 'the rubble of horst3.s01 is not published (art batch art/recipes/card.horst3_rubble.yaml, then art masks horst3.s01)');
  test.skip(!crewFires(), 'no crew card has the firing animations published (art batch art/recipes/card.riker.yaml, art strips picard --upscale-only)');
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=horst3.s01&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().cards.length > 0), 20_000);
  await setPhaser(page, 5);
  // (watched from inside the page every 30 ms: each card's animation, and whether a beam is up)
  await page.evaluate(() => {
    const log: { t: number; anims: Record<string, number>; shots: number }[] = [];
    (window as unknown as { __fire: typeof log }).__fire = log;
    const t0 = performance.now();
    const look = (): void => {
      const a = window.__au!.art();
      log.push({ t: performance.now() - t0, anims: a.cardAnims, shots: a.shots.length });
      setTimeout(look, 30);
    };
    look();
  });
  await act(page, async () => {
    await hold(page, 'phaser');
    await clickObject(page, 'horst3.rubble.0103');
  });
  // (the picture of the pose, while the beam is up)
  mkdirSync(shots, { recursive: true });
  if (await poll(() => page.evaluate(() => window.__au!.art().shots.length > 0), 15_000)) await page.screenshot({ path: `${shots}/horst3-s01-phaser-firing.png` });
  await settled(page);
  const log = await page.evaluate(() => (window as unknown as { __fire: { t: number; anims: Record<string, number>; shots: number }[] }).__fire);
  const firing = log.filter(l => Object.values(l.anims).some(a => a >= 12 && a <= 23));
  expect(firing.length, 'a crew member plays a firing animation').toBeGreaterThan(0);
  const beam = log.find(l => l.shots > 0);
  expect(beam, 'the beam is drawn').toBeDefined();
  // the beam waits for the muzzle frame: the animation has been playing for a while before it, and goes on while it is drawn
  expect(firing[0]!.t).toBeLessThan(beam!.t);
  await page.screenshot({ path: `${shots}/horst3-s01-phaser-fired.png` });
  expect(errors).toEqual([]);
});

// Batch 8a: layers whose picture follows the sprite's animation (docs/unity-sprite-placement.md, "Batch 8a"). `art().layers` says, for each animated layer
// shown, the animation it draws and the frame, or `still` where it falls back to the still. ScummVM's dump (`placement scummvm`, if it is there) says which
// animation the original's sprite player is on at entry and whether it has ended (a loop never does); the published strip must agree.
type Sample = { t: number; object: string; anim: number; frame: number | null; still: boolean } | { t: number; object?: undefined };

/** The layer's animation and frame every 30 ms for `ms`, from inside the page, each with the time the animations play on (`animationTime`, not the wall clock: slow frames slow the game, they do not skip it ahead). */
async function sampleLayer(page: import('@playwright/test').Page, object: string, ms: number): Promise<Extract<Sample, { object: string }>[]> {
  const samples = await page.evaluate(([id, span]) => new Promise<Sample[]>(resolve => {
    const out: Sample[] = [];
    const t0 = window.__au!.animationTime();
    const look = (): void => {
      const l = window.__au!.art().layers.find(x => x.object === id);
      const t = window.__au!.animationTime() - t0;
      out.push({ t, ...(l ?? {}) } as Sample);
      if (t < (span as number)) setTimeout(look, 30);
      else resolve(out);
    };
    look();
  }), [object, ms] as const);
  return samples.filter((s): s is Extract<Sample, { object: string }> => s.object !== undefined);
}

// Looping props: the lights of Mertens' walls (batch 8a and 8b) and the glow of Horst III's crystal (8b): one animation, never ends, no script plays it.
const LOOPING: [room: string, object: string, what: string, recipe: string][] = [
  ['lab.s08', 'lab.lights.080a', 'the chasing lights', 'card.lab_lights_080a'],
  ['lab.s07', 'lab.lights.070f', 'the chasing lights', 'card.lab_lights_070f'],
  ['horst3.s03', 'horst3.glow', 'the crystal\'s glow', 'card.horst3_glow'],
  // Allanor (batch 8d): the alien devices, the leaking pipes, the magma, the light and water of the cave, the crystal and the ambient lights
  ['allanor.s01', 'allanor.alien_device.0101', 'the alien device\'s lights', 'card.allanor_sniffer_a'],
  ['allanor.s01', 'allanor.alien_device.0102', 'the second alien device\'s lights', 'card.allanor_sniffer_b'],
  ['allanor.s01', 'allanor.pipe.0122', 'the leaking pipe\'s drops', 'card.allanor_pipe_leak_a'],
  ['allanor.s01', 'allanor.magma.0125', 'the magma\'s flow', 'card.allanor_magma_0125'],
  ['allanor.s03', 'allanor.o0302', 'the light shaft', 'card.allanor_s03_light_down'],
  ['allanor.s03', 'allanor.o0310', 'the water\'s reflections', 'card.allanor_s03_reflections'],
  ['allanor.s07', 'allanor.chodalite', 'the chodalite\'s glow', 'card.allanor_chodalite'],
  ['allanor.s09', 'allanor.amb.090d', 'the ambient light', 'card.allanor_amb_090d'],
  ['allanor.s09', 'allanor.amb.090c', 'the first ambient light', 'card.allanor_amb_090c'],
  ['allanor.s09', 'allanor.amb.090e', 'the third ambient light', 'card.allanor_amb_090e'],
  ['allanor.s0b', 'allanor.ambient', 'the ambient light', 'card.allanor_ambient_s0b'],
  // Frigis (batch 8e): the haze over the volcanoes and the canyon, the force field, the blinking lights of the puzzle room and the gas in the pipe
  ['frigis.s01', 'frigis.volcanoes', 'the haze over the volcanoes', 'card.frigis_volcanoes_s01'],
  ['frigis.s02', 'frigis.steam.0206', 'the heat haze', 'card.frigis_heat_0206'],
  ['frigis.s02', 'frigis.steam.0207', 'the second heat haze', 'card.frigis_heat_0207'],
  ['frigis.s03', 'frigis.force_field', 'the force field', 'card.frigis_force_field_s03'],
  ['frigis.s04', 'frigis.light_1', 'the first blinking light', 'card.frigis_light_1_s04'],
  ['frigis.s04', 'frigis.light_4', 'the fourth blinking light', 'card.frigis_light_4_s04'],
  ['frigis.s05', 'frigis.mask_pipe_gas', 'the gas in the pipe', 'card.frigis_pipe_gas_s05'],
  // Unity (batch 8f): the glow of the hall, the smoke and force fields of the tower, the zap, the force fields and key symbol, the panel buttons, the energy current and
  // emitter, the dome, the side light and the sun (the lights of `s02` failed the card check twice)
  ['unity.s03', 'unity.glow', 'the hall\'s glow', 'card.unity_glow_s03'],
  ['unity.s05', 'unity.force_field_anim.0519', 'the force field', 'card.unity_force_field_0519'],
  ['unity.s06', 'unity.smoke1', 'the smoke', 'card.unity_smoke1_s06'],
  ['unity.s06', 'unity.forcefield_bm_1', 'the first force field', 'card.unity_forcefield_bm_1'],
  ['unity.s06', 'unity.forcefield_bm_2', 'the second force field', 'card.unity_forcefield_bm_2'],
  ['unity.s06', 'unity.forcefield_bm_3', 'the third force field', 'card.unity_forcefield_bm_3'],
  ['unity.s06', 'unity.little_gen_zap', 'the zap', 'card.unity_little_gen_zap'],
  ['unity.s07', 'unity.force_field_anim.0720', 'the force field', 'card.unity_force_field_0720'],
  ['unity.s07', 'unity.symbol.0706', 'the key symbol', 'card.unity_symbol_0706'],
  ['unity.s08', 'unity.panel.0806', 'the panel button', 'card.unity_panel_button'],
  ['unity.s0c', 'unity.energy_current', 'the energy current', 'card.unity_energy_current_s0c'],
  ['unity.s0c', 'unity.force_field', 'the force field emitter', 'card.unity_force_field_s0c'],
  ['unity.s0d', 'unity.w6s6grin', 'the dome', 'card.unity_grin_s0d'],
  ['unity.s0f', 'unity.side_light.0f02', 'the side light', 'card.unity_side_light_0f02'],
  // Zoo (batch 8g): the leaf, the comm port light, the screen, the microgenerator in its charger, the lights and corals of the marine habitats, the worm and the grid display
  ['zoo.s01', 'zoo.leaf', 'the leaf', 'card.zoo_leaf_s01'],
  ['zoo.s03', 'zoo.com_port_light', 'the comm port light', 'card.zoo_com_port_light_s03'],
  ['zoo.s04', 'zoo.screen.041c', 'the screen', 'card.zoo_screen_041c'],
  ['zoo.s05', 'zoo.microgenerator.050c', 'the microgenerator\'s indicator', 'card.zoo_microgenerator_s05'],
  ['zoo.s08', 'zoo.habitat272.0816', 'the first habitat light', 'card.zoo_habitat272_s08'],
  ['zoo.s08', 'zoo.habitat273.081a', 'the second habitat light', 'card.zoo_habitat273_s08'],
  ['zoo.s08', 'zoo.jelly_corals_1', 'the first jelly coral', 'card.zoo_jelly_corals_12_s08'],
  ['zoo.s08', 'zoo.jell_corals_3', 'the third jelly coral', 'card.zoo_jelly_corals_34_s08'],
  ['zoo.s09', 'zoo.worm.090e', 'the worm', 'card.zoo_worm_s09'],
  ['zoo.s10', 'zoo.grid_overview', 'the grid display', 'card.zoo_grid_overview_s10'],
];

for (const [room, object, what, recipe] of LOOPING) {
test(`${room}: ${what} loop through their frames, in order and at the sprite's pace`, async ({ page }) => {
  const layer = artLayer(room, object);
  test.skip(!layer, `${object} of ${room} is not published as an animated layer (art batch art/recipes/${recipe}.yaml, then art masks ${room})`);
  test.setTimeout(120_000);
  const errors = watchConsole(page);
  await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute`);
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  // (an atlas layer draws the still until its first cell is decoded: wait for the cell, then watch it go round)
  await poll(() => page.evaluate(obj => window.__au!.art().layers.some(l => l.object === obj && !l.still), object), 20_000);
  const strip = layer!.strips![String(layer!.anim)]!;
  // the original's sprite is on the animation the layer starts on, and it loops (never ends)
  const original = scummvmPlayer(room, object);
  if (original) {
    expect(original.playing).toBe(layer!.anim);
    expect(original.stopped).toBe(!strip.loop);
  }
  expect(strip.loop).toBe(true);
  // (long enough for a dozen frames of a slow strip)
  const mean = strip.delays.reduce((a, b) => a + b, 0) / strip.delays.length;
  const samples = await sampleLayer(page, object, Math.min(20_000, Math.max(4_000, mean * 14)));
  expect(samples.every(s => !s.still && s.anim === layer!.anim && s.frame! >= 0 && s.frame! < strip.frames)).toBe(true);
  // the frame changes over time: every change is the next frame (round, as the loop does), and the pace is the strip's own
  // (the animation runs on time, not on frames drawn: a slow software renderer may skip a frame, never go back or stand still for long)
  const steps: number[] = [];
  // (a step may skip no more frames than the time between its two samples holds: the page's main thread can stall for a moment beside other browsers, and the layer, which
  // runs on time, is then ahead when it is next looked at. Three frames at least, as before.)
  const shortest = Math.min(...strip.delays);
  const unsteady: string[] = [];
  samples.forEach((s, i) => {
    if (i > 0 && s.frame !== samples[i - 1]!.frame) {
      const d = (s.frame! - samples[i - 1]!.frame! + strip.frames) % strip.frames;
      steps.push(d);
      const allowed = Math.max(3, Math.ceil((s.t - samples[i - 1]!.t) / shortest) + 1);
      if (d < 1 || d > allowed) unsteady.push(`frame ${samples[i - 1]!.frame} to ${s.frame} in ${Math.round(s.t - samples[i - 1]!.t)} ms (at most ${allowed})`);
    }
  });
  expect(steps.length).toBeGreaterThan(8);
  expect(unsteady).toEqual([]);
  const changes = samples.filter((s, i) => i > 0 && s.frame !== samples[i - 1]!.frame);
  const span = changes.at(-1)!.t - changes[0]!.t;
  const wanted = steps.slice(1).reduce((a, b) => a + b, 0) * (strip.delays.reduce((a, b) => a + b, 0) / strip.delays.length);
  expect(Math.abs(span - wanted) / wanted).toBeLessThan(0.25);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/${room.replace('.', '-')}-${object.replace(/\./g, '-')}.png` });
  expect(errors).toEqual([]);
});
}

// Batch 10, idle loops: a character, an animal or a figure that was a still of one frame now plays the loop ScummVM's sprite player is on at entry (docs/unity-sprite-placement.md,
// "Batch 10"). Some loops are slow (a constable's eyes, the bird's head), so the pace is not timed as the lights' is: the layer is drawn from the strip, on the original's animation,
// and where the loop is short enough to see it goes round in order.
// (Nachyl, who greets the team as the room loads and then stands, is under "talking" below)
// (`entry`: the room runs a cutscene as it loads, so it never settles: the layer is watched from the first frame)
const IDLE: [room: string, object: string, who: string, recipe: string, entry?: true][] = [
  ['frigis.s06', 'frigis.stamblyr.0601', 'the stamblyr', 'card.frigis_stamblyr_s06'],
  ['frigis.s06', 'frigis.pluvoids', 'the pluvoids', 'card.frigis_pluvoids_s06'],
  ['zoo.s10', 'zoo.constable_lliksze.1010', 'the constable', 'card.zoo_constable_s10'],
  ['zoo.s06', 'zoo.flock', 'the flock', 'card.zoo_flock_s06'],
  ['zoo.s01', 'zoo.ticulpus_snake', 'the snake', 'card.zoo_snake_s01'],
  ['zoo.s04', 'zoo.field_unit_a', 'the field unit', 'card.zoo_fieldunit_s04'],
  ['zoo.s03', 'zoo.veronda_bird', 'the bird', 'card.zoo_bird_s03'],
  ['lab.s08', 'lab.dr_griems', 'Dr. Griems', 'card.lab_dr_griems'],
  ['lab.s0a', 'lab.o0a04', 'the transporter console\'s ship', 'card.lab_o0a04'],
  ['unity.s0c', 'unity.disks', 'the disks', 'card.unity_disks_s0c'],
  ['unity.s0b', 'unity.captain_picard.0b04', 'Picard', 'card.unity_picard_s0b_b04'],
  ['unity.s0f', 'unity.borg', 'the Borg cube', 'card.unity_borg_s0f'],
  ['unity.s0a', 'unity.guardian.0a07', 'the guardian', 'card.unity_guardian_s0a'],
  // (the walking-type objects, drawn at the floor's scale where they stand: Unity's admiral and Pentara, Allanor's chodak and brodnack, Dr. Hyunh. The creatures of `s08` and `s0e` are published as well, but the first is off at entry and the original's player has the second stopped with nothing shown)
  ['unity.s04', 'unity.admiral_brodnack', 'Admiral Brodnack', 'card.unity_brodnack_s04', true],
  ['unity.s04', 'unity.captain_pentara.0405', 'Captain Pentara', 'card.unity_pentara_s04', true],
  ['allanor.s07', 'allanor.alien.0705', 'the chodak', 'card.allanor_chodak_s07'],
  ['allanor.s07', 'allanor.alien.0704', 'the brodnack-sprite alien', 'card.allanor_brodnack_s07'],
  ['zoo.s09', 'zoo.dr_hyunh_foertsch.0900', 'Dr. Hyunh-Foertsch', 'card.zoo_hyunh_s09'],
];
for (const [room, object, who, recipe, entry] of IDLE) {
  test(`${room}: ${who} plays the loop the original does, not a still`, async ({ page }) => {
    const layer = artLayer(room, object);
    test.skip(!layer, `${object} of ${room} is not published as an animated layer (art batch art/recipes/${recipe}.yaml, then art masks ${room})`);
    test.setTimeout(120_000);
    const strip = layer!.strips![String(layer!.anim)]!;
    // (a loop, or a few frames that fall into one: Dr. Hyunh's start animation runs into the loop the original keeps her on)
    expect(strip.loop || strip.next !== undefined).toBe(true);
    expect(strip.frames).toBeGreaterThan(1);
    const original = scummvmPlayer(room, object);
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute`);
    await page.waitForFunction(() => window.__au?.ready === true);
    if (!entry) await settled(page);
    const on = original ? original.active : (await state(page)).objects[object]?.active === true;
    test.skip(!on, `${object} is off at entry in ${room}: a script turns it on`);
    // the original's sprite is on this animation at entry, and never stops (the dump says nothing of an object that is off)
    if (original) {
      expect(original.playing).toBe(layer!.anim);
      expect(original.stopped).toBe(false);
    }
    await poll(() => page.evaluate(obj => window.__au!.art().layers.some(l => l.object === obj && !l.still), object), 30_000);
    const length = strip.delays.reduce((a, b) => a + b, 0);
    const samples = await sampleLayer(page, object, Math.min(12_000, Math.max(2_500, length * 1.5)));
    expect(samples.every(s => !s.still && s.anim === layer!.anim && s.frame! >= 0 && s.frame! < strip.frames)).toBe(true);
    if (length <= 8_000) {
      // (a loop of a few seconds: the frames come in order, round, on the strip's own clock)
      const frames = samples.map(s => s.frame!);
      expect(new Set(frames).size).toBeGreaterThan(Math.min(strip.frames, 2) - 1);
      frames.forEach((f, i) => {
        if (i > 0 && f !== frames[i - 1]) expect((f - frames[i - 1]! + strip.frames) % strip.frames).toBeLessThanOrEqual(Math.max(3, Math.ceil(strip.frames / 4)));
      });
    }
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${room.replace('.', '-')}-${object.replace(/\./g, '-')}-idle.png` });
    expect(errors).toEqual([]);
  });
}

// Batch 10, talking: a character plays its talk animation while it replies (UnityEngine::replyAnims: animation 2, back to the idle one when the line ends), the mouths
// of its speech sprites drawn over its body by the layer's strip, and says nothing else of it: Picard's own lines leave it as it is.
// (`entry`: the character speaks as the room loads, before the player can talk to anyone: the lines are watched from the first frame)
const TALKERS: [room: string, object: string, who: string, recipe: string, entry?: true][] = [
  ['frigis.s07', 'frigis.nachyl', 'Nachyl', 'card.frigis_nachyl_s07', true],
  ['frigis.s01', 'frigis.chancellor_laraq.0100', 'Chancellor Laraq', 'card.frigis_laraq_s01'],
  ['zoo.s03', 'zoo.constable_lliksze.030e', 'the constable', 'card.zoo_constable_s03'],
  // (Madia, the gatekeeper and the Aelont of `s09` talk in the original too, but their talk animations failed the card check: they are still, see the docs)
];
for (const [room, object, who, recipe, entry] of TALKERS) {
  test(`${room}: ${who} plays her talk animation while she replies, and her idle one after`, async ({ page }) => {
    const layer = artLayer(room, object);
    test.skip(!layer?.talk || !layer.strips?.[String(layer.talk.anim)], `${object} of ${room} has no talk animation published (art batch art/recipes/${recipe}.yaml, then art masks ${room})`);
    test.setTimeout(180_000);
    const talk = layer!.talk!;
    expect(talk.anim).toBe(2);
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&team=picard,riker,data,troi&mute&speed=4&panel=0`);
    await page.waitForFunction(() => window.__au?.ready === true);
    const layerNow = (): Promise<{ anim: number; frame: number | null } | undefined> => page.evaluate(obj => window.__au!.art().layers.find(l => l.object === obj), object);
    if (!entry) {
      await settled(page);
      await poll(() => page.evaluate(obj => window.__au!.art().layers.some(l => l.object === obj && !l.still), object), 20_000);
      expect(await layerNow()).toBeDefined();
      await button(page, 'Talk').click();
      await clickObject(page, object);
    } else await page.locator('.au-subtitle').waitFor({ timeout: 30_000 });
    // (the lines, one by one: the character's own while the subtitle is its, and the leader's)
    const seen = { theirs: [] as { anim: number; frame: number | null }[], others: [] as number[] };
    for (let i = 0; i < 400; i++) {
      const sub = page.locator('.au-subtitle');
      if (await sub.isVisible()) {
        const speaker = await sub.getAttribute('data-speaker');
        // (sampled from inside the page while the line is up, every 25 ms: a sample taken across the protocol's round trip, as it was, can all fall after a short line at 4x has gone
        // when the machine is busy)
        const taken = await page.evaluate(obj => new Promise<{ anim: number; frame: number | null }[]>(resolve => {
          const out: { anim: number; frame: number | null }[] = [];
          const up = (): boolean => { const el = document.querySelector('.au-subtitle'); return !!el && el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden'; };
          const look = (): void => {
            const l = window.__au!.art().layers.find(x => x.object === obj);
            if (l) out.push({ anim: l.anim, frame: l.frame });
            if (up() && out.length < 80) setTimeout(look, 25);
            else resolve(out);
          };
          look();
        }), object);
        for (const l of taken) (speaker === object ? seen.theirs.push(l) : seen.others.push(l.anim));
        if (speaker === object && seen.theirs.length > 0) mkdirSync(shots, { recursive: true }), await page.screenshot({ path: `${shots}/${room.replace('.', '-')}-${object.replace(/\./g, '-')}-talking.png` });
        await page.evaluate(() => window.__au!.skipLine());
      } else if (await page.locator('.au-menu').isVisible()) await page.locator('.au-menu').getByRole('button').nth(0).click().catch(() => {});
      else if (await page.evaluate(() => window.__au!.idle())) break;
      await page.waitForTimeout(80);
    }
    expect(seen.theirs.length, `${who} said something`).toBeGreaterThan(0);
    // while she talks the layer is on the talk animation (or the one it falls into when it ends, as Nachyl's falls into her loop), from its strip, and it goes through frames
    const talkStrip = layer!.strips![String(talk.anim)]!;
    // (the first sample can be the frame drawn before the line went up: the layer changes on the next frame)
    const during = seen.theirs.slice(1);
    expect(during.some(l => l.anim === talk.anim)).toBe(true);
    expect(during.every(l => l.anim === talk.anim || l.anim === talkStrip.next)).toBe(true);
    expect(new Set(during.map(l => `${l.anim}:${l.frame}`)).size).toBeGreaterThan(1);
    // (the leader's own lines do not move her)
    expect(seen.others.every(a => a !== talk.anim)).toBe(true);
    await settled(page);
    // after the line: the animation the original goes back to (the sprite's own, else the one it started on)
    const after = (await layerNow())!;
    expect(after.anim).toBe(talk.idle >= 0 && layer!.strips![String(talk.idle)] ? talk.idle : layer!.anim);
    expect(errors).toEqual([]);
  });
}

// Script-changed layers (Allanor's in batch 8d, Frigis' in 8e): the animations each is published with (frames, and L where it loops) and the one it starts on, against what the original's
// player is on at entry. Each room is entered once: the layers are in `art().masks`, the ones on at entry are drawn from their first frame, the rest are off.
const SCRIPTED: [room: string, objects: { object: string; start: number; strips: Record<string, number>; on: boolean }[]][] = [
  ['allanor.s01', [{ object: 'allanor.ventilation_duct.0108', start: 0, strips: { 0: 1, 1: 9, 2: 1 }, on: true }]],
  ['allanor.s05', [{ object: 'allanor.door.0504', start: 0, strips: { 0: 1, 1: 21, 2: 1, 3: 21 }, on: true }]],
  ['allanor.s0a', [{ object: 'allanor.lens', start: 1, strips: { 0: 1, 1: 8, 2: 8 }, on: true }]],
  ['allanor.s0e', [
    { object: 'allanor.gun', start: 1, strips: { 0: 1, 1: 8, 2: 8 }, on: true },
    // (batch 10, the walking-type objects drawn at the floor's scale where they stand: the optimators and the chodak master of the third cave, off at entry, and the optimator the cutscene moves, on)
    { object: 'allanor.optimator_one.0e0b', start: 0, strips: { 0: 12 }, on: false },
    { object: 'allanor.chodak_master.0e0a', start: 0, strips: { 0: 13 }, on: false },
    { object: 'allanor.optimator_two.0e04', start: 3, strips: { 3: 12 }, on: true },
  ]],
  // Batch 10: the walking-type objects of Allanor's other caves, drawn at the floor's scale where they stand and off at entry (`s0d`'s are under a pixel: no layer)
  ['allanor.s08', [
    { object: 'allanor.optimator_one.0810', start: 0, strips: { 0: 12 }, on: false },
    { object: 'allanor.optimator_two.0811', start: 0, strips: { 0: 12 }, on: false },
  ]],
  ['allanor.s09', [
    { object: 'allanor.chodak_master.0907', start: 0, strips: { 0: 13 }, on: false },
    { object: 'allanor.optimator_one.0908', start: 0, strips: { 0: 12 }, on: false },
    { object: 'allanor.optimator_two.0909', start: 0, strips: { 0: 12 }, on: false },
  ]],
  ['allanor.s0b', [
    { object: 'allanor.admiral_brodnack', start: 0, strips: { 0: 13 }, on: false },
    { object: 'allanor.optimator_one.0b10', start: 0, strips: { 0: 12 }, on: false },
  ]],
  ['allanor.s0c', [
    { object: 'allanor.chodak_master.0c06', start: 0, strips: { 0: 13 }, on: false },
    { object: 'allanor.optimator_one.0c07', start: 0, strips: { 0: 12 }, on: false },
    { object: 'allanor.optimator_two.0c08', start: 0, strips: { 0: 12 }, on: false },
  ]],
  // The zoo's second Dr. Hyunh (it runs animation 3, a loop, after its first frame) and the balls Picard, Pentara and Brodnack become (Brodnack's failed the card check twice: not published)
  ['zoo.s03', [{ object: 'zoo.dr_hyunh_foertsch.030a', start: 0, strips: { 0: 1, 3: 6 }, on: false }]],
  ['unity.s07', [
    ...['picard', 'pentara'].flatMap(who => [1, 2].map(n => ({ object: `unity.${who}_ball_${n}`, start: 0, strips: { 0: 6 }, on: false }))),
  ]],
  ['allanor.s0f', [{ object: 'allanor.isolinear_rod.0f0f', start: 0, strips: { 0: 11, 1: 1, 2: 10 }, on: false }]],
  ['allanor.s10', [{ object: 'allanor.isolinear_rod.1006', start: 0, strips: { 0: 11, 1: 1, 2: 10 }, on: false }]],
  ['allanor.s13', [{ object: 'allanor.isolinear_rod.1303', start: 0, strips: { 0: 11, 1: 1, 2: 10 }, on: false }]],
  ['allanor.s11', [...['1103', '1105', '1106', '1107', '1108'].map(n => ({ object: `allanor.button.${n}`, start: 0, strips: { 0: 1, 1: 1 }, on: true })), ...['1100', '1110'].map(n => ({ object: `allanor.button.${n}`, start: 0, strips: { 0: 6 }, on: false }))]],
  ['allanor.s12', [
    { object: 'allanor.isolinear_rod.120c', start: 0, strips: { 0: 11, 1: 1, 2: 10 }, on: false },
    { object: 'allanor.security_rod.1202', start: 1, strips: { 1: 1, 2: 9 }, on: false },
    ...[1, 2, 3, 4, 5, 6].map(n => ({ object: `allanor.sc${n}`, start: 0, strips: { 0: 1, 1: 5, 2: 5 }, on: false })),
  ]],
  // Frigis (batch 8e): the transporter doorways (off until a timer or the doorway turns them on), the puzzle room's two doors (`open_door` turns them on and plays the yellow door's
  // animation 1; the blue door's sprite has no animation 1, the play is ignored) and the red light of the manuscript room
  ['frigis.s01', [{ object: 'frigis.anim_transporter.011e', start: 0, strips: { 0: 19 }, on: false }]],
  ['frigis.s02', [{ object: 'frigis.anim_transporter.020c', start: 0, strips: { 0: 7 }, on: false }]],
  ['frigis.s04', [
    { object: 'frigis.blue_door_anim', start: 0, strips: { 0: 65 }, on: false },
    { object: 'frigis.yellow_door_anim', start: 0, strips: { 0: 1, 1: 65 }, on: false },
  ]],
  ['frigis.s05', [
    { object: 'frigis.red_light.0506', start: 0, strips: { 0: 8 }, on: false },
    { object: 'frigis.manuscript.050b', start: 0, strips: { 0: 16, 1: 17 }, on: true },
    { object: 'frigis.anim_manuscript', start: 0, strips: { 0: 16, 1: 17 }, on: false },
  ]],
  // Unity (batch 8f): the shuttle's door and the other shuttle (`as_inside_shuttle` and `screen_startup`), the door of `s05`, the chips of the table (they start on animation 1), the vortex halves (off
  // at entry), the door, panel and stasis chambers of `s0e` (the chambers of Pentara and Picard are off at entry), the side light of `s0f` that `done` plays; the shuttle hatch
  // `050f` failed the card check twice
  // Mertens' strange machine (batch 9: its flame loops 30 frames, on at entry; the pace is not timed here, the 15 MB layer is too slow to time on a loaded machine)
  // Mertens' woman of the third screen (batch 10: her waking, animation 3, 14 distinct frames, failed the card check twice at denoise 0.3 and passed at 0.2): the trapped woman is on at entry,
  // the injured one the med kit turns on plays animation 3 and then sits her up (1), and the dead one and the doctor's own are off
  ['lab.s03', ['lab.trapped_woman.0301', 'lab.injured_woman.0302', 'lab.dead_woman.0309', 'lab.injured_woman.030c'].map((object, i) => ({ object, start: 0, strips: { 0: 1, 1: 1, 3: 14 }, on: i === 0 }))],
  ['lab.s06', [{ object: 'lab.strange_machine', start: 0, strips: { 0: 30 }, on: true }]],
  ['unity.s03', [{ object: 'unity.glow', start: 2, strips: { 2: 8, 3: 6, 4: 16 }, on: true }]],
  ['unity.s05', [
    { object: 'unity.door.0504', start: 0, strips: { 0: 1, 1: 23 }, on: true },
    { object: 'unity.shuttle.0508', start: 1, strips: { 1: 42, 2: 1 }, on: true },
  ]],
  ['unity.s06', [
    { object: 'unity.left_chip_on_table', start: 1, strips: { 0: 1, 1: 1 }, on: true },
    { object: 'unity.right_chip_on_table', start: 1, strips: { 0: 1, 1: 1 }, on: true },
  ]],
  ['unity.s08', [{ object: 'unity.panel.0806', start: 0, strips: { 0: 2, 1: 1 }, on: true }]],
  ['unity.s0a', [
    { object: 'unity.top', start: 0, strips: { 0: 26 }, on: false },
    { object: 'unity.bottom', start: 0, strips: { 0: 16 }, on: false },
  ]],
  ['unity.s0e', [
    { object: 'unity.door.0e00', start: 0, strips: { 0: 1, 1: 26, 2: 1 }, on: true },
    { object: 'unity.panel_anim', start: 0, strips: { 0: 2, 1: 1 }, on: true },
    { object: 'unity.stasis_chamber.0e03', start: 0, strips: { 0: 1, 1: 16 }, on: true },
    { object: 'unity.captain_pentara.0e0f', start: 0, strips: { 0: 1, 1: 16, 2: 16 }, on: false },
    { object: 'unity.stasis_chamber.0e18', start: 0, strips: { 0: 1, 2: 16 }, on: false },
  ]],
  ['unity.s0f', [
    { object: 'unity.side_light.0f02', start: 0, strips: { 0: 5, 1: 1 }, on: true },
    { object: 'unity.side_light.0f03', start: 0, strips: { 0: 5, 1: 1 }, on: true },
  ]],
  // (s04 and s10 run a cutscene on entry: published here, drawn at entry in the test after the table)
  ['unity.s04', [
    { object: 'unity.shuttle_door', start: 0, strips: { 0: 1, 1: 10 }, on: true },
    { object: 'unity.shuttle.0400', start: 0, strips: { 0: 1, 1: 1, 2: 42 }, on: true },
  ]],
  ['unity.s10', [{ object: 'unity.big_sun', start: 0, strips: { 0: 21 }, on: true }]],
  // Zoo (batch 8g): the monkey (it starts on animation 0 and stops), the jellybird (off at entry), the worm of `s02`, the scans and the sensory array of `s04` (off until
  // a script turns them on), the door and shuttle of `s05`, the sensors and maps (off at entry); the flock of `s01` and the canyon and bog forest maps are in (the maps upscale-only)
  ['zoo.s01', [
    { object: 'zoo.atol_tree_monkey', start: 0, strips: { 0: 5, 1: 8, 2: 4, 3: 6 }, on: true },
    { object: 'zoo.luginumo_jellybird', start: 0, strips: { 0: 59 }, on: false },
    { object: 'zoo.akire_flock', start: 0, strips: { 0: 40 }, on: false },
  ]],
  ['zoo.s02', [{ object: 'zoo.worm.021c', start: 0, strips: { 0: 45 }, on: false }]],
  ['zoo.s04', [
    { object: 'zoo.mole_scan', start: 0, strips: { 0: 10 }, on: false },
    { object: 'zoo.gibbon_scan', start: 0, strips: { 0: 14 }, on: false },
    { object: 'zoo.boar_scan', start: 0, strips: { 0: 14 }, on: false },
    { object: 'zoo.glowing_sensory_ary', start: 0, strips: { 0: 9 }, on: false },
  ]],
  ['zoo.s05', [
    { object: 'zoo.door', start: 0, strips: { 0: 1, 1: 1 }, on: true },
    { object: 'zoo.shuttle', start: 0, strips: { 0: 1, 1: 45 }, on: true },
  ]],
  ['zoo.s06', [
    { object: 'zoo.sensor.0604', start: 0, strips: { 0: 7 }, on: false },
    { object: 'zoo.canyon_map', start: 0, strips: { 0: 42, 1: 1 }, on: false },
  ]],
  ['zoo.s07', [
    { object: 'zoo.sensor.0712', start: 0, strips: { 0: 7 }, on: false },
    { object: 'zoo.bogforest_map', start: 0, strips: { 0: 35, 1: 1 }, on: false },
  ]],
  ['zoo.s08', [
    { object: 'zoo.marine_map', start: 0, strips: { 0: 37, 1: 1 }, on: false },
    { object: 'zoo.sensor.0814', start: 0, strips: { 0: 7 }, on: false },
  ]],
];
for (const [room, objects] of SCRIPTED) {
  test(`${room}: the script-changed layers are published with the animations their scripts play`, async ({ page }) => {
    const layers = objects.map(o => ({ ...o, layer: artLayer(room, o.object) }));
    test.skip(layers.some(l => !l.layer), `${room}'s script-changed layers are not published (art batch the card.* recipes of its objects, then art masks ${room})`);
    test.setTimeout(120_000);
    for (const { object, start, strips, layer } of layers) {
      expect(layer!.anim, object).toBe(start);
      expect(Object.fromEntries(Object.entries(layer!.strips!).map(([a, s]) => [a, s.frames])), object).toEqual(strips);
      const original = scummvmPlayer(room, object);
      if (original) expect(original.playing, object).toBe(start);
    }
    // (allanor.s0e, unity.s04 and unity.s10 run a cutscene on entry, so `settled` never comes: its gun is checked by the cutscene test's room, not entered again here)
    if (room === 'allanor.s0e' || room === 'unity.s04' || room === 'unity.s10') return;
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await settled(page);
    // (the room's art loads after it is up: wait for the plate before reading the masks, as the layers table above does)
    await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
    const art = await page.evaluate(() => window.__au!.art());
    for (const { object, on } of layers) {
      expect(art.masks, object).toContain(object);
      expect(art.shown.includes(object), `${object} drawn at entry`).toBe(on);
    }
    expect(errors).toEqual([]);
  });
}

// Unity's shuttle (`as_inside_shuttle`) and its last room (the sun) run a cutscene on entry, so `settled` never comes: the layer is there at entry (batch 8f).
for (const [room, object] of [['unity.s04', 'unity.shuttle_door'], ['unity.s10', 'unity.big_sun']] as const) {
  test(`${room}: ${object} is published and is drawn at entry, in the room a cutscene runs in`, async ({ page }) => {
    test.skip(!artLayer(room, object), `${object} of ${room} is not published as an animated layer (art batch its recipe, then art masks ${room})`);
    test.setTimeout(120_000);
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
    expect(await poll(() => page.evaluate(obj => window.__au!.art().masks.includes(obj), object), 20_000)).toBe(true);
    expect(await poll(() => page.evaluate(obj => window.__au!.art().shown.includes(obj), object), 20_000)).toBe(true);
    expect(errors).toEqual([]);
  });
}

// Horst III's isolinear rod (batch 8b): off at entry; `aperture` turns it on and plays animation 0, the rod's own script plays animation 2 and turns it off.
test('horst3.s04: the isolinear rod is published with the animations its scripts play, off until the aperture turns it on', async ({ page }) => {
  const layer = artLayer('horst3.s04', 'horst3.isolinear_rod');
  test.skip(!layer, 'the isolinear rod of horst3.s04 is not published as an animated layer (art batch art/recipes/card.horst3_isolinear_rod.yaml, then art masks horst3.s04)');
  test.setTimeout(120_000);
  expect(Object.keys(layer!.strips!).sort()).toEqual(['0', '2']);
  expect(layer!.anim).toBe(0);
  expect([layer!.strips!['0']!.frames, layer!.strips!['2']!.frames]).toEqual([6, 5]);
  const original = scummvmPlayer('horst3.s04', 'horst3.isolinear_rod');
  if (original) expect(original.playing).toBe(0);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=horst3.s04&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
  const art = await page.evaluate(() => window.__au!.art());
  expect(art.masks).toContain('horst3.isolinear_rod');
  expect((await state(page)).objects['horst3.isolinear_rod']!.active).toBe(false);
  expect(art.shown).not.toContain('horst3.isolinear_rod');
  expect(art.layers.some(l => l.object === 'horst3.isolinear_rod')).toBe(false);
  expect(errors).toEqual([]);
});

// Mertens' hologram (batch 8c, the first layer that needs the streaming): 119 distinct frames of one looping animation, off at entry, and `holotable` turns it on.
test('lab.s05: the hologram is published as every frame of its loop, and is off and not drawn until the holotable turns it on', async ({ page }) => {
  const layer = artLayer('lab.s05', 'lab.hologram');
  test.skip(!layer, 'the hologram of lab.s05 is not published as an animated layer (art batch art/recipes/card.lab_hologram.yaml, then art masks lab.s05)');
  test.setTimeout(120_000);
  expect(Object.keys(layer!.strips!)).toEqual(['0']);
  const strip = layer!.strips!['0']!;
  expect([layer!.anim, strip.frames, strip.loop, strip.cells!.length]).toEqual([0, 119, true, 119]);
  const original = scummvmPlayer('lab.s05', 'lab.hologram');
  if (original) expect(original.playing).toBe(0);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=lab.s05&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
  const art = await page.evaluate(() => window.__au!.art());
  expect(art.masks).toContain('lab.hologram');
  expect((await state(page)).objects['lab.hologram']!.active).toBe(false);
  expect(art.shown).not.toContain('lab.hologram');
  expect(art.layers.some(l => l.object === 'lab.hologram')).toBe(false);
  expect(errors).toEqual([]);
});

// Batch 8b: strips are atlases of cropped cells, no side over 4096, and a room's animated layers stay inside the budget (docs/unity-sprite-placement.md, "Batch 8b"). Skipped until a room is published.
const STRIP_BUDGET = 64 * 1024 * 1024;
test('every published animated layer is an atlas of pages no side over 4096, and each room\'s layers keep inside the budget resident', () => {
  const rooms = artAnimatedRooms();
  test.skip(Object.keys(rooms).length === 0, 'no animated layers are published (art batch the card recipes with a prop.animate, then art masks)');
  for (const [room, layers] of Object.entries(rooms)) {
    // (resident: each page file once as its encoded bytes, and per layer its one texture and its ring of decoded cells: batch 8c)
    const files = new Map<string, number>();
    const decoded = new Map<string, number>();
    const streamed = new Set<string>();
    let extra = 0;
    for (const layer of layers) {
      const resident: ResidentStrip[] = [];
      for (const [anim, strip] of Object.entries(layer.strips!)) {
        const names = stripFiles(strip);
        // (an animation whose every cell is clear, a door gone from its frame, has no page at all)
        const clear = strip.images?.length === 0 && (strip.cells ?? []).length > 0 && strip.cells!.every(c => c[3] === 0 || c[4] === 0);
        if (!clear) expect(names.length, `${room} ${layer.object} animation ${anim}`).toBeGreaterThan(0);
        for (const f of names) {
          expect(existsSync(`${GAME_DIR}${f}`), `${f} is published`).toBe(true);
          files.set(f, statSync(`${GAME_DIR}${f}`).size);
        }
        if (strip.images) {
          expect(strip.pages?.length).toBe(strip.images.length);
          strip.pages!.forEach(([w, h]) => expect(Math.max(w, h)).toBeLessThanOrEqual(4096));
          // every distinct cell lies inside its page, and every frame names one
          const cells = strip.cells!;
          expect(cells.length).toBe(strip.of ? Math.max(...strip.of) + 1 : strip.frames);
          for (const [p, x, y, w, h] of cells as [number, number, number, number, number][]) {
            if (w === 0 || h === 0) continue;
            expect(x + w).toBeLessThanOrEqual(strip.pages![p]![0]);
            expect(y + h).toBeLessThanOrEqual(strip.pages![p]![1]);
          }
          resident.push({ cells, pages: strip.pages, files: strip.images });
        } else {
          // (a one-cell animation published as a grid: the still of an animation the recipe does not animate)
          expect(strip.frames).toBeGreaterThan(0);
          resident.push({ gridBytes: strip.cell ? strip.cell[0] * strip.cell[1] * 4 * strip.frames : 0 });
        }
      }
      // (the engine's own choice per layer: streamed pages count encoded, whole ones decoded)
      const kept = layerResident(resident);
      extra += kept.ring + kept.surface + kept.grid;
      if (kept.mode === 'whole') for (const [f, b] of kept.pages) decoded.set(f, b);
      else for (const strip of Object.values(layer.strips!)) for (const f of strip.images ?? []) streamed.add(f);
    }
    const bytes = [...files].filter(([f]) => streamed.has(f)).reduce((a, [, b]) => a + b, 0) + [...decoded.values()].reduce((a, b) => a + b, 0) + extra;
    expect(bytes, `${room}'s animated layers resident`).toBeLessThanOrEqual(STRIP_BUDGET);
  }
});

// Allanor's first door: closed (animation 0, a still) until a use of it plays animation 1, 30 frames of it opening and closing again (the original's player pauses on the
// closed frame it began with; the script then ends the mission, so the room is left a few seconds on).
test('allanor.s01: the Chodak door is drawn closed, then plays its opening and closing frames after the script', async ({ page }) => {
  const layer = artLayer('allanor.s01', 'allanor.door.011b');
  test.skip(!layer, 'the door of allanor.s01 is not published as an animated layer (art batch art/recipes/card.allanor_door_011b.yaml, then art masks allanor.s01)');
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=allanor.s01&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'allanor.door.011b')), 20_000);
  const original = scummvmPlayer('allanor.s01', 'allanor.door.011b');
  if (original) {
    expect(original.playing).toBe(layer!.anim);
    // (one frame and a pause: the original's player has stopped)
    expect(original.stopped).toBe(!layer!.strips![String(layer!.anim)]!.loop);
  }
  // (the still stands until the first cell is decoded)
  await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'allanor.door.011b' && !l.still)), 20_000);
  const closed = await page.evaluate(() => window.__au!.art().layers.find(l => l.object === 'allanor.door.011b'));
  expect(closed).toMatchObject({ anim: 0, frame: 0, still: false });
  expect((await state(page)).objects['allanor.door.011b']!.anim).toBeUndefined();
  // a use of the door by Picard: the script plays animation 1 on it
  await button(page, 'Use').click();
  await clickObject(page, 'allanor.door.011b');
  await poll(async () => (await state(page)).objects['allanor.door.011b']!.anim === 1, 60_000);
  const opening = layer!.strips!['1']!;
  // (the picture in the middle of the opening, before the script leaves the room)
  await poll(() => page.evaluate(() => (window.__au!.art().layers.find(l => l.object === 'allanor.door.011b')?.frame ?? 0) >= 8), 20_000);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/allanor-s01-door-open.png` });
  const samples = await sampleLayer(page, 'allanor.door.011b', 6_000);
  const played = samples.filter(s => s.anim === 1);
  expect(played.length).toBeGreaterThan(0);
  // the frames of animation 1 run in order to the last, and the last is held
  expect(played[0]!.frame).toBeGreaterThanOrEqual(8);
  for (let i = 1; i < played.length; i++) expect(played[i]!.frame! - played[i - 1]!.frame!).toBeGreaterThanOrEqual(0);
  expect(played.at(-1)!.frame).toBe(opening.frames - 1);
  expect(played.every(s => !s.still)).toBe(true);
  const total = opening.delays.reduce((a, b) => a + b, 0);
  const held = played.filter(s => s.frame === opening.frames - 1);
  expect(held.length).toBeGreaterThan(2);
  expect(total).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});

// Horst III's rock pile endstate: the rubble before the phaser; the kill turns the rubble off and plays animation 4 on this object (the rock coming down), then the
// original falls into animation 5, the open passage, and holds it.
test('horst3.s01: the rock pile endstate shows the rubble, then the rock coming down after the phaser, then the open passage', async ({ page }) => {
  const layer = artLayer('horst3.s01', 'horst3.rock_pile_endstate');
  test.skip(!layer, 'the rock pile endstate of horst3.s01 is not published as an animated layer (art batch art/recipes/card.horst3_rock_pile_endstate.yaml, then art masks horst3.s01)');
  test.setTimeout(300_000);
  const errors = watchConsole(page);
  await page.goto('/play/afu/?game=unity&dev&start=horst3.s01&mute');
  await page.waitForFunction(() => window.__au?.ready === true);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'horst3.rock_pile_endstate')), 20_000);
  const original = scummvmPlayer('horst3.s01', 'horst3.rock_pile_endstate');
  if (original) {
    expect(original.playing).toBe(layer!.anim);
    expect(original.stopped).toBe(true);
  }
  await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'horst3.rock_pile_endstate' && !l.still)), 20_000);
  expect(await page.evaluate(() => window.__au!.art().layers.find(l => l.object === 'horst3.rock_pile_endstate'))).toMatchObject({ anim: 0, frame: 0, still: false });
  // the strips are the ones the original plays: 0 the rubble, 4 the fall (it falls into 5), 5 the open passage
  expect(Object.keys(layer!.strips!).sort()).toEqual(['0', '4', '5']);
  expect(layer!.strips!['4']!.next).toBe(5);
  for (const position of [5, 9]) {
    await setPhaser(page, position);
    await act(page, async () => {
      await hold(page, 'phaser');
      await clickObject(page, 'horst3.rubble.0103');
    });
    await settled(page);
  }
  const w = await state(page);
  expect(w.objects['horst3.rubble.0103']!.active).toBe(false);
  expect(w.objects['horst3.rock_pile_endstate']!.anim).toBe(4);
  // (the script's wait is the presentation's, not the sprite's: the fall may be playing still. It ends in the animation it falls into, which holds its one frame)
  expect(await poll(() => page.evaluate(() => window.__au!.art().layers.find(l => l.object === 'horst3.rock_pile_endstate')?.anim === 5), 30_000)).toBe(true);
  const after = await sampleLayer(page, 'horst3.rock_pile_endstate', 1_000);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every(s => s.anim === 5 && s.frame === 0 && !s.still)).toBe(true);
  expect(errors).toEqual([]);
});

// Two rooms that run a cutscene on entry and are left by it, so `settled` never returns while the room is up. ScummVM does the same (traced with
// `start 6 11 0` and `start 2 14 0`: its `screen` events go to s06 after Picard's and Brodnack's lines, and to allanor.s09 entrance 4 a few seconds in),
// so the test looks at the layers at entry, then waits for the original's move instead of for stillness.
const CUTSCENES: [string, string[], string][] = [
  ['unity.s0b', ['unity.captain_picard.0b00', 'unity.captain_picard.0b04'], 'unity.s06'],
  ['allanor.s0e', ['allanor.optimator_two.0e04', 'allanor.chodak_master.0e0a', 'allanor.optimator_one.0e0b'], 'allanor.s09'],
];
for (const [room, masks, next] of CUTSCENES) {
  test(`${room}: the layers are there at entry, then the original's cutscene moves the team to ${next}`, async ({ page }) => {
    test.skip(!masks.every(m => artMasks(room).includes(m)), `the masks of ${room} are not published (art masks ${room})`);
    test.setTimeout(150_000);
    const errors = watchConsole(page);
    await page.goto(`/play/afu/?game=unity&dev&start=${room}&mute&speed=8`);
    await page.waitForFunction(() => window.__au?.ready === true);
    await poll(() => page.evaluate(() => window.__au!.art().plate), 20_000);
    const art = await page.evaluate(() => window.__au!.art());
    for (const m of masks) expect(art.masks).toContain(m);
    expect(await page.evaluate(() => window.__au!.state().screen)).toBe(room);
    expect(await poll(async () => (await page.evaluate(() => window.__au!.state().screen)) === next, 100_000)).toBe(true);
    expect(errors).toEqual([]);
  });
}
