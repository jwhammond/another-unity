// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, test, type Page } from '@playwright/test';
// (for its `window.__au` declaration; Playwright erases the import)
import type {} from '../src/debug';
import { act, artPresent, button, cardsPresent, clickObject, clickWhenIdle, drive, hold, expectFrames, goTo, poll, settled, state, station, watchConsole } from './helpers';

// The Mertens Station mission as a player plays it, with the art on: the transporter's effect on the way down, the cable on the way to the
// trapped woman, the phaser's beam, the cable beamed away and landing on the floor, the med kit, the probe. Each step's picture goes to
// $MERTENS_SHOTS (default: au-mertens in the temp directory). The art is local (Paramount's), so the file is skipped, naming what is missing, without it.

const shots = process.env.MERTENS_SHOTS ?? `${tmpdir()}/au-mertens`;
const rooms = artPresent(['lab.s01', 'lab.s02', 'lab.s03']);
const cards = cardsPresent(['beam_effect', 'picard', 'riker', 'data', 'troi', 'worf', 'crusher', 'la_forge']);
const missing = [rooms.why, cards.why].filter(Boolean).join('; ');
test.skip(missing !== '', `needs ${missing}`);
test.setTimeout(600_000);

/** The canvas, as a player sees the room. */
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.locator('canvas').first().screenshot({ path: `${shots}/${name}.png` });
}

async function toTransporter(page: Page): Promise<void> {
  await page.goto('/play/afu/?game=unity&speed=60&mute&dev');
  await page.waitForFunction(() => window.__au?.ready === true);
  await expect(station(page, 'bridge')).toBeVisible();
  await drive(page, async () => {
    const s = await state(page);
    return s.beamTarget !== null && s.pendingHail === null && s.ship.transit === null;
  }, 180_000, false, 1);
  if ((await station(page, 'astrogation').count()) > 0) {
    await drive(page, async () => {
      await clickWhenIdle(page.getByRole('button', { name: 'Back to the bridge' }));
      return (await station(page, 'bridge').count()) > 0;
    });
  }
  await goTo(page, 'Transporter room', 'transporter');
}

/** Records what the beam is doing every frame, until `stop` (a page-side loop, so a slow screenshot loses nothing). */
async function watchBeams(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __beams: { t: number; room: unknown; pads: unknown }[]; __watch: boolean };
    w.__beams = [];
    w.__watch = true;
    const tick = () => {
      const a = window.__au!.art();
      if (a.beams.length > 0 || a.ship.beam.cards.length > 0 || a.ship.beam.sparkles.length > 0) w.__beams.push({ t: performance.now(), room: a.beams, pads: a.ship.beam });
      if (w.__watch) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test('beaming down: the pads sparkle and dissolve in the transporter room, and the team materialises on arrival', async ({ page }) => {
  const errors = watchConsole(page);
  await toTransporter(page);
  // (the plate and the cards of the crew on the pads)
  await station(page, 'transporter').waitFor();
  await button(page, 'Recommended').click();
  await poll(() => page.evaluate(() => window.__au!.art().ship.kind === 'plate'), 30_000);
  // (the team walks in from the door, one after another, and the scan locks on: Energize waits for both)
  await page.waitForFunction(() => window.__au!.padWalks().length === 0, undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await shot(page, '01-pads');
  await page.evaluate(() => window.__au!.setSpeed(1));
  await watchBeams(page);
  const go = button(page, 'Energize');
  await expect(go).toBeEnabled({ timeout: 60_000 });
  await go.click();
  // 1. leaving: the pads' cards dissolve with the sparkle in front of them
  await page.waitForFunction(() => window.__au!.art().ship.beam.sparkles.length > 0, undefined, { timeout: 20_000, polling: 'raf' });
  await shot(page, '02-beam-out-sparkle');
  await page.waitForFunction(() => window.__au!.art().ship.beam.cards.some(c => c.level >= 1 && c.level <= 5), undefined, { timeout: 20_000, polling: 'raf' });
  await shot(page, '03-beam-out-dissolve');
  // 2. arriving: the team is on the screen but hidden, the sparkle plays, and they come up
  await page.waitForFunction(() => window.__au!.art().beams.some(b => !b.out), undefined, { timeout: 60_000, polling: 'raf' });
  expect((await state(page)).onShip).toBeNull();
  await shot(page, '04-beam-in-sparkle');
  await page.waitForFunction(() => window.__au!.art().beams.some(b => !b.out && b.sparkle === 1 && b.level >= 2 && b.level <= 5), undefined, { timeout: 20_000, polling: 'raf' });
  await shot(page, '05-beam-in-dissolve');
  await page.waitForFunction(() => window.__au!.art().beams.length === 0, undefined, { timeout: 30_000 });
  await page.evaluate(() => { (window as unknown as { __watch: boolean }).__watch = false; });
  await page.evaluate(() => window.__au!.setSpeed(60));
  await settled(page);
  await page.waitForTimeout(500);
  await shot(page, '06-arrived');
  const seen = await page.evaluate(() => (window as unknown as { __beams: { t: number; room: { out: boolean; level: number; sparkle: number }[]; pads: { cards: { level: number }[]; sparkles: string[] } }[] }).__beams);
  // the pads went from whole to hidden, one level at a time (the levels it drew, in order)
  const padLevels = seen.flatMap(s => s.pads.cards.map(c => c.level)).filter((l, i, a) => i === 0 || l !== a[i - 1]);
  expect(padLevels[0]).toBe(6);
  expect(padLevels.at(-1)).toBe(0);
  expect(padLevels.every((l, i) => i === 0 || l < padLevels[i - 1]!)).toBe(true);
  // the team came up from hidden to whole
  const teamLevels = seen.flatMap(s => s.room.filter(b => !b.out).map(b => b.level)).filter((l, i, a) => i === 0 || l !== a[i - 1]);
  expect(teamLevels[0]).toBe(0);
  expect(teamLevels.at(-1)).toBe(6);
  expect(teamLevels.every((l, i) => i === 0 || l > teamLevels[i - 1]!)).toBe(true);
  expect((await state(page)).screen).toMatch(/lab/);
  await expectFrames(page);
  expect(errors).toEqual([]);
});

// (the rest of the mission from Mertens' first room, with the team the beam-down gives, Crusher leading: she has the med kit)
const TEAM = 'crusher,riker,worf,la_forge';

async function openLab(page: Page, room: string): Promise<void> {
  await page.goto(`/play/afu/?game=unity&dev&start=${room}&team=${TEAM}&mute&speed=8`);
  await page.waitForFunction(() => window.__au?.ready === true, undefined, { timeout: 300_000 });
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().plate), 60_000);
  await poll(() => page.evaluate(t => t.every(id => window.__au!.art().cards.includes(id)), TEAM.split(',')), 60_000);
}

/** Goes through an exit by clicking its transition, as a player does, and waits for the screen. */
async function through(page: Page, exit: string | string[], screen: string): Promise<void> {
  const exits = Array.isArray(exit) ? exit : [exit];
  let n = 0;
  await drive(page, async () => {
    if ((await state(page)).screen === screen) return true;
    if (await page.evaluate(() => window.__au!.idle())) {
      // (a crew member can stand over the exit's middle: the click goes a little up it, to the part that is the exit)
      const id = exits[n % exits.length]!;
      const p = await page.evaluate(i => window.__au!.point(i), id);
      const tries = [0, -50, -90, 40];
      const at = p ? { x: p.x, y: p.y + tries[Math.floor(n / exits.length) % tries.length]! } : null;
      n++;
      if (at) await page.mouse.click(at.x, at.y).catch(() => {});
    }
    return (await state(page)).screen === screen;
  }, 120_000, false, 0);
  await settled(page);
  await poll(() => page.evaluate(() => window.__au!.art().plate), 60_000);
}

const lowPhaser = async (page: Page): Promise<void> => {
  const gauge = page.getByRole('slider', { name: 'Phaser setting' });
  const box = (await gauge.boundingBox())!;
  await page.mouse.click(box.x + ((414 + 14 * 5 + 7 - 410) / 230) * box.width, box.y + box.height / 2);
  expect((await state(page)).phaserSetting).toBe(1);
};

test('the walk to the trapped woman shows the cable, the phaser draws its beam, and the cut cable is the one the woman is under', async ({ page }) => {
  const errors = watchConsole(page);
  await openLab(page, 'lab.s01');
  await shot(page, '10-s01');
  await through(page, 'lab.door.0108', 'lab.s02');
  // the far view of the cable over the woman: the sprites the original draws and the plate lacks
  const s02 = await page.evaluate(() => window.__au!.art());
  expect(s02.shown).toEqual(expect.arrayContaining(['lab.big_cable.0203', 'lab.cable_mask.0216', 'lab.trapped_woman.0200']));
  expect(s02.layers.map(l => l.object)).toContain('lab.cable_mask.0216');
  await page.waitForTimeout(800);
  await shot(page, '11-s02-cable');
  await through(page, 'lab.trapped_woman.0200', 'lab.s03');
  await page.waitForTimeout(800);
  await shot(page, '12-s03-before-phaser');
  expect((await page.evaluate(() => window.__au!.art())).shown).toEqual(expect.arrayContaining(['lab.big_cable.0308', 'lab.trapped_woman.0301']));

  // the phaser, at its low setting, on the cable: the beam is drawn from the crew member to the cable's aim point
  await lowPhaser(page);
  // (at the game's own pace: the shot is a third of a second)
  await page.evaluate(() => window.__au!.setSpeed(1));
  await act(page, async () => {
    await hold(page, 'phaser');
    await clickObject(page, 'lab.big_cable.0308');
  });
  await page.waitForFunction(() => window.__au!.art().shots.length > 0, undefined, { timeout: 60_000, polling: 'raf' });
  const shotAt = await page.evaluate(() => window.__au!.art().shots[0]!);
  expect(shotAt).toMatchObject({ to: 'lab.big_cable.0308' });
  // (the aim point is on the cable's own rectangle)
  expect(shotAt.target[0]).toBeGreaterThan(400);
  expect(shotAt.target[0]).toBeLessThan(580);
  expect(shotAt.start[1]).toBeLessThan(shotAt.target[1] + 200);
  await shot(page, '13-phaser-beam');
  await page.evaluate(() => window.__au!.setSpeed(8));
  await drive(page, async () => (await state(page)).objects['lab.big_cable.0307']!.active && (await page.evaluate(() => window.__au!.idle())), 120_000, false, 0);
  const cut = await page.evaluate(() => window.__au!.art());
  expect(cut.shown).toContain('lab.big_cable.0307');
  expect(cut.shown).not.toContain('lab.big_cable.0308');
  await page.waitForTimeout(500);
  await shot(page, '14-cable-cut');
  expect(errors).toEqual([]);
});

/** Picks an option of the question a script asks (`choose`): by the text of the button. */
async function choose(page: Page, text: string): Promise<void> {
  await drive(page, async () => {
    const b = page.getByRole('button', { name: `› ${text}`, exact: true });
    if (await b.isVisible().catch(() => false)) {
      await b.click({ timeout: 2_000 }).catch(() => {});
      return true;
    }
    return false;
  }, 60_000, true);
}

test('the cable is beamed away: the transporter effect plays on it, it lands on the floor of the first room, and the woman is freed', async ({ page }) => {
  const errors = watchConsole(page);
  await openLab(page, 'lab.s03');
  await lowPhaser(page);
  await act(page, async () => {
    await hold(page, 'phaser');
    await clickObject(page, 'lab.big_cable.0308');
  });
  await drive(page, async () => (await state(page)).objects['lab.big_cable.0307']!.active && (await page.evaluate(() => window.__au!.idle())), 120_000, false, 0);
  // the cut cable, as the woman lies under it
  expect((await page.evaluate(() => window.__au!.art())).shown).toContain('lab.big_cable.0307');
  await shot(page, '20-cable-cut');

  // a tricorder scan of the piece that can be transported, then back to the first room's transporter panel
  await act(page, async () => {
    await hold(page, 'tricorder');
    await clickObject(page, 'lab.big_cable.0307');
  });
  await drive(page, () => page.evaluate(() => window.__au!.idle()), 120_000, false, 0);
  expect((await state(page)).objects['lab.lock_on.0a01']!.state).toBe(1);
  // (the tricorder is put down: a click walks again)
  await button(page, 'Walk').click();
  await through(page, 'lab.next_room.030e', 'lab.s02');
  await through(page, 'lab.passage', 'lab.s01');
  await act(page, async () => {
    await button(page, 'Use').click();
    await clickObject(page, 'lab.transporter_panel');
  });
  await drive(page, async () => (await state(page)).screen === 'lab.s0a' && (await page.evaluate(() => window.__au!.idle())), 120_000, false, 0);
  await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'lab.lock_on.0a01')), 30_000);
  await shot(page, '21-console');

  // lock on the cable: pressing the button plays the lit animation (1), then it goes back to 0
  await act(page, async () => { await clickObject(page, 'lab.lock_on.0a01'); });
  const sawLit = await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'lab.lock_on.0a01' && l.anim === 1)), 10_000);
  expect(sawLit).toBe(true);
  await choose(page, 'Data cable');
  await drive(page, () => page.evaluate(() => window.__au!.idle()), 120_000, false, 0);
  expect((await state(page)).objects['lab.energize.0a02']!.state).toBe(1);
  await act(page, async () => { await clickObject(page, 'lab.energize.0a02'); });
  // the transporter takes the cable: the sparkle and the dissolve play on it where it stands in the third room... and it lands in the first
  await page.waitForFunction(() => window.__au!.art().beams.some(b => b.objects.includes('lab.piece_of_cable.0101') && !b.out), undefined, { timeout: 120_000, polling: 'raf' });
  await shot(page, '22-cable-beam-in');
  await drive(page, async () => (await state(page)).screen === 'lab.s01' && (await page.evaluate(() => window.__au!.idle())), 180_000, false, 0);
  await page.waitForTimeout(800);
  const s01 = await page.evaluate(() => window.__au!.art());
  expect(s01.shown).toContain('lab.piece_of_cable.0101');
  // on the floor where the original puts it (p310_305, pixel 310, 305), not in the corner of the picture where its sprite starts (100, 100): its layer has moved by the difference
  const moved = s01.moved['lab.piece_of_cable.0101'];
  expect(moved).toBeDefined();
  expect(moved![0]).toBeGreaterThan(190);
  expect(moved![0]).toBeLessThan(230);
  expect(moved![1]).toBeGreaterThan(185);
  expect(moved![1]).toBeLessThan(225);
  await shot(page, '23-cable-on-the-floor');

  const w = await state(page);
  expect(w.objects['lab.piece_of_cable.0300']!.active).toBe(false);
  expect(w.objects['lab.piece_of_cable.0101']!.active).toBe(true);
  // (the rules turn off the whole cable and the length across the woman, and the woman under it; the cut cable stays, as the original's scripts leave it)
  expect([w.objects['lab.big_cable.0308']!.active, w.objects['lab.cable_mask.031c']!.active, w.objects['lab.trapped_woman.0301']!.active]).toEqual([false, false, false]);
  expect(w.objects['lab.injured_woman.030c']!.active).toBe(true);

  // back to the woman, freed: the doctor's med kit on her (her layer plays what the sprite has for it, then sits her up)
  await button(page, 'Walk').click();
  await through(page, 'lab.door.0108', 'lab.s02');
  await through(page, ['lab.injured_woman.0210', 'lab.big_cable.020f', 'lab.chamber'], 'lab.s03');
  await settled(page);
  await shot(page, '24-woman-freed-before-med-kit');
  await page.evaluate(() => window.__au!.setSpeed(1));
  await act(page, async () => {
    await hold(page, 'med kit');
    // (the cut cable lies over her middle: a click on her head, where the pick says it is her)
    const at = await page.evaluate(() => {
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      for (let dy = -30; dy <= 30; dy += 6) {
        for (let dx = -40; dx <= 40; dx += 6) {
          const x = c.left + c.width * 0.607 + dx;
          const y = c.top + c.height * 0.538 + dy;
          if (window.__au!.objectAt(x, y) === 'lab.injured_woman.030c') return { x, y };
        }
      }
      return null;
    });
    if (!at) throw new Error('no point where a click picks the woman');
    await page.mouse.click(at.x, at.y);
  });
  await page.waitForFunction(() => window.__au!.art().layers.some(l => l.object === 'lab.injured_woman.0302'), undefined, { timeout: 120_000, polling: 'raf' });
  await shot(page, '25-woman-after-med-kit');
  await page.evaluate(() => window.__au!.setSpeed(8));
  await drive(page, () => page.evaluate(() => window.__au!.idle()), 120_000, false, 0);
  const after = await state(page);
  expect(after.objects['lab.injured_woman.0302']!).toMatchObject({ active: true, anim: 1 });
  expect(after.objects['lab.injured_woman.030c']!.active).toBe(false);
  expect((await page.evaluate(() => window.__au!.art())).layers.find(l => l.object === 'lab.injured_woman.0302')).toMatchObject({ anim: 1, still: false });
  expect(errors).toEqual([]);
});

test('the probe is on the screen of the sixth room, playing its flame, and the console buttons light when pressed', async ({ page }) => {
  const errors = watchConsole(page);
  await openLab(page, 'lab.s06');
  await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'lab.strange_machine')), 60_000);
  // (its frames are streamed: the still is up until the first is decoded)
  expect(await poll(() => page.evaluate(() => window.__au!.art().layers.some(l => l.object === 'lab.strange_machine' && !l.still)), 60_000)).toBe(true);
  const first = await page.evaluate(() => window.__au!.art().layers.find(l => l.object === 'lab.strange_machine')!);
  await page.evaluate(() => window.__au!.setSpeed(1));
  await page.waitForTimeout(1200);
  const later = await page.evaluate(() => window.__au!.art().layers.find(l => l.object === 'lab.strange_machine')!);
  expect(later.frame).not.toBe(first.frame);
  await shot(page, '30-probe');
  expect(errors).toEqual([]);
});
