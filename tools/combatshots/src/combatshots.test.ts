// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { combatSim } from '@another-unity/engine';
import { runCombatshots } from './cli';
import { compareConsole, compareShots, consolePoints, contactSheet, dropStars, EDGE_TOLERANCE, MASK_REACH, maskStats, RADAR_PANEL, VIEW_RECT, viewMask } from './compare';
import { addShots, readShots, SHOT_DELAY, SHOT_VIEWS, shownStep, viewInputs } from './shots';

/** A black 640 x 480 screen with these filled boxes ([x, y, w, h, grey]) in it. */
function screen(boxes: [number, number, number, number, number][] = []): PNG {
  const png = new PNG({ width: 640, height: 480 });
  for (let i = 0; i < png.data.length; i += 4) png.data[i + 3] = 255;
  for (const [x, y, w, h, g] of boxes) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * 640 + xx) * 4;
      png.data[i] = png.data[i + 1] = png.data[i + 2] = g;
    }
  }
  return png;
}

/** A made-up console (a box for each tab and status field, and blocks over the page, on black), moved dx, with these boxes too. */
function console(boxes: [number, number, number, number, number][] = [], dx = 0): PNG {
  return screen([
    ...[0, 1, 2, 3, 4, 5].map(p => [dx + 2, 299 + 31 * p, 120, 25, 180] as [number, number, number, number, number]),
    ...[0, 1, 2, 3, 4].map(i => [dx + 544, 309 + 11 * i, 56, 7, 120] as [number, number, number, number, number]),
    [dx + 130, 310, 60, 40, 90], [dx + 300, 360, 80, 30, 200], [dx + 490, 390, 120, 34, 160], [dx + 490, 424, 120, 34, 140],
    ...boxes,
  ]);
}

describe('the views and the shots (M8 spec §9.3)', () => {
  it('sets the six views with inputs the port reads, and shoots each SHOT_DELAY steps later, before the fight', () => {
    expect(SHOT_VIEWS.map(v => v.name)).toEqual(['chase', 'side', 'top', 'overview', 'target', 'forward']);
    const read = combatSim.parseInputScript(viewInputs());
    expect([read.errors, read.inputs.map(i => [i.step, i.command])]).toEqual([[], SHOT_VIEWS.map(v => [v.at, { type: 'view', view: v.view, ship: v.ship }])]);
    // (the at-lines in step order, as the harness takes them: each shot after its view's input)
    const script = addShots(`difficulty 1\nship 7 8\n${viewInputs()}fight 130\ntrace off\nquit\n`).split('\n');
    expect(script.slice(2, 14)).toEqual(SHOT_VIEWS.flatMap(v => [`at ${v.at} view ${v.view} ${v.ship}`, `at ${v.at + SHOT_DELAY} shot @DIR@/scummvm-${v.name}.png`]));
    expect(script.slice(0, 2).concat(script.slice(14))).toEqual(['difficulty 1', 'ship 7 8', 'fight 130', 'trace off', 'quit', '']);
    expect(() => addShots('quit\n')).toThrow('no fight line');
  });

  it('reads the shots from the run\'s log, each showing the step before the one it was taken at', () => {
    const shots = readShots('x\nHARNESS shot /r/b8/scummvm-chase.png at step 6\nHARNESS> at 11 shot\nHARNESS shot /r/b8/scummvm-side.png at step 12\n');
    expect(shots).toEqual([{ name: 'chase', file: '/r/b8/scummvm-chase.png', step: 6 }, { name: 'side', file: '/r/b8/scummvm-side.png', step: 12 }]);
    expect(shots.map(shownStep)).toEqual([5, 11]);
  });
});

describe('the comparison (M8 spec §9.3)', () => {
  it('masks what isn\'t the view rectangle\'s commonest colour, in the rectangle alone', () => {
    // (a ship of 20 x 10 in the view, and a box outside it)
    const mask = viewMask(screen([[400, 100, 20, 10, 200], [10, 10, 50, 50, 255]]));
    expect(maskStats(mask, VIEW_RECT.width)).toEqual({ area: 200, box: [81, 77, 100, 86], centroid: [90.5, 81.5] });
  });

  it('takes the stars out: what fits a 5 x 5 box goes, a ship stays', () => {
    const w = 20, h = 20;
    const mask = new Uint8Array(w * h);
    // (a type 1 star, 5 across and 3 down, and a 6 x 6 ship)
    for (const [x, y] of [[2, 2], [1, 2], [3, 2], [0, 2], [4, 2], [2, 1], [2, 3]]) mask[y! * w + x!] = 1;
    for (let y = 10; y < 16; y++) for (let x = 10; x < 16; x++) mask[y * w + x] = 1;
    expect(maskStats(dropStars(mask, w, h), w).area).toBe(36);
  });

  it('passes the same silhouette, and fails one moved 3 px or a ship the port lacks', () => {
    const ship: [number, number, number, number, number] = [400, 100, 40, 30, 180];
    expect(compareShots(screen([ship]), screen([ship]))).toEqual({ iou: 1, strictIou: 1, shift: 0, centroid: 0, areas: [1200, 1200], pass: true });
    // (shaded differently: still the same silhouette)
    expect(compareShots(screen([ship]), screen([[400, 100, 40, 30, 90]])).pass).toBe(true);
    const moved = compareShots(screen([ship]), screen([[403, 100, 40, 30, 180]]));
    expect([moved.shift, moved.pass]).toEqual([3, false]);
    expect(compareShots(screen([ship]), screen()).pass).toBe(false);
    expect(compareShots(screen(), screen()).pass).toBe(true);
  });

  it('judges with a 1 px edge tolerance (Plan 31 R9): a ring round a small ship passes, a 2 px shift or a stray 3 px off does not', () => {
    expect(EDGE_TOLERANCE).toBe(1);
    const ship: [number, number, number, number, number] = [400, 100, 10, 10, 180];
    const ring = compareShots(screen([ship]), screen([[399, 99, 12, 12, 180]]));
    expect(ring.strictIou).toBeCloseTo(100 / 144, 10);
    expect(ring.strictIou).toBeLessThan(0.9);
    expect([ring.iou, ring.shift, ring.centroid, ring.pass]).toEqual([1, 1, 0, true]);
    // (2 px right: per row 8 shared, the 1 px beside the other's edge matched, the outer 1 px not: 10 of 12)
    const moved = compareShots(screen([ship]), screen([[402, 100, 10, 10, 180]]));
    expect(moved.strictIou).toBeCloseTo(80 / 120, 10);
    expect(moved.iou).toBeCloseTo(100 / 120, 10);
    expect([moved.shift, moved.pass]).toEqual([2, false]);
    // (a line of 6 in ScummVM's alone, 3 px from the ship: nothing of the port's within 1 px of it)
    const stray = compareShots(screen([ship, [413, 100, 1, 6, 180]]), screen([ship]));
    expect(stray.strictIou).toBeCloseTo(100 / 106, 10);
    expect(stray.iou).toBeCloseTo(100 / 106, 10);
  });

  it('lays the shots out ScummVM\'s beside the port\'s, a row each', () => {
    const sheet = contactSheet([[screen([[0, 0, 1, 1, 255]]), screen()], [screen(), screen([[0, 0, 1, 1, 255]])]]);
    expect([sheet.width, sheet.height]).toEqual([1280, 960]);
    expect([sheet.data[0], sheet.data[(480 * 1280 + 640) * 4]]).toEqual([255, 255]);
  });
});

describe('the report with the art on (Plan 30 R17)', () => {
  it('passes a repainted console that lines up, saying how much of it differs, only with --art', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'combatshots-'));
    try {
      const a = console(), b = console();
      for (let y = 309; y < 316; y++) for (let x = 544; x < 600; x++) b.data.fill(121, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3);
      writeFileSync(join(dir, 'scummvm-chase.png'), PNG.sync.write(a));
      writeFileSync(join(dir, 'port-chase.png'), PNG.sync.write(b));
      writeFileSync(join(dir, 'shots.json'), JSON.stringify([{ name: 'chase', file: join(dir, 'scummvm-chase.png'), step: 1, state: 'none.json' }]));
      const log: string[] = [];
      expect(await runCombatshots(['compare', '--dir', dir], line => log.push(line))).toBe(1);
      expect(await runCombatshots(['compare', '--dir', dir, '--art'], line => log.push(line))).toBe(0);
      expect(log.at(-2)!.split('|').at(-3)!.trim()).toMatch(/^lines up \d+\/\d+ points; 99\.\d% the same$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the report (Plan 25 review M1)', () => {
  it('says a pair empty on both sides apart from a real match, and counts it in the tally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'combatshots-'));
    try {
      const ship: [number, number, number, number, number] = [400, 100, 40, 30, 180];
      const pairs: [string, PNG, PNG][] = [['chase', console([ship]), console([ship])], ['forward', console(), console()], ['side', console([ship]), console()]];
      for (const [name, a, b] of pairs) {
        writeFileSync(join(dir, `scummvm-${name}.png`), PNG.sync.write(a));
        writeFileSync(join(dir, `port-${name}.png`), PNG.sync.write(b));
      }
      writeFileSync(join(dir, 'shots.json'), JSON.stringify(pairs.map(([name], i) => ({ name, file: join(dir, `scummvm-${name}.png`), step: i + 1, state: 'none.json' }))));
      const log: string[] = [];
      expect(await runCombatshots(['compare', '--dir', dir], line => log.push(line))).toBe(1);
      expect(log.map(l => l.split('|').at(-2)?.trim() ?? l)).toEqual(['SAME', 'SAME (empty)', 'DIFFERS', 'combatshots: 2 of 3 SAME (1 empty on both sides)']);
      expect(readFileSync(join(dir, 'report.md'), 'utf8')).toContain('\n\n2 of 3 SAME (1 empty on both sides)\n');
      // (the console's column: lined up, on how many of its points, and the same pixels' share)
      expect(log[0]!.split('|').at(-3)!.trim()).toMatch(/^lines up \d+\/\d+ points; 100\.0% the same$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the console\'s comparison (M8 spec §9.3; Plan 27 R17, amended)', () => {
  it('leaves out the radar\'s whole panel, its blips\' boxes at x 308-312 and y 25 too', () => {
    expect(RADAR_PANEL).toEqual({ x: 0, y: 25, width: 313, height: 267 });
  });

  it('takes its points from the console\'s own places, none whose window reaches the view or the radar', () => {
    const points = consolePoints();
    expect(points.length).toBeGreaterThan(40);
    const meets = (r: typeof VIEW_RECT, x: number, y: number) => x + MASK_REACH >= r.x && x - MASK_REACH < r.x + r.width && y + MASK_REACH >= r.y && y - MASK_REACH < r.y + r.height;
    expect(points.filter(p => meets(VIEW_RECT, p.x, p.y) || meets(RADAR_PANEL, p.x, p.y))).toEqual([]);
  });

  it('passes the same console whatever its view and radar show, and fails one moved 3 pixels', () => {
    const a = console(), b = console();
    // (a ship in the view, blips on the radar, at its panel's far edges too: none compared here)
    for (const [x, y] of [[400, 100], [150, 150], [310, 100], [100, 25]] as const) b.data.fill(255, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3);
    expect(compareConsole(a, b)).toMatchObject({ pass: true, same: 1 });
    const moved = compareConsole(a, console([], 3));
    expect([moved.pass, moved.same < 1]).toEqual([false, true]);
  });

  it('fails a console that lines up but isn\'t the same pixel for pixel (art off: a wrong palette entry), saying how many differ', () => {
    const a = console(), b = console();
    // (one status field a grey off: every edge where it was)
    for (let y = 309; y < 316; y++) for (let x = 544; x < 600; x++) b.data.fill(121, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3);
    const k = compareConsole(a, b);
    expect([k.pass, k.aligned, k.differ, k.why]).toEqual([false, true, 56 * 7, '392 pixels differ']);
  });

  it('passes a repainted console that lines up whatever its pixels, with the art on, and still fails one moved 3 pixels (Plan 30 R17)', () => {
    const a = console(), b = console();
    for (let y = 309; y < 316; y++) for (let x = 544; x < 600; x++) b.data.fill(121, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3);
    const k = compareConsole(a, b, { art: true });
    expect([k.pass, k.aligned, k.differ, k.why]).toEqual([true, true, 392, undefined]);
    expect(compareConsole(a, console([], 3), { art: true }).pass).toBe(false);
  });

  it('fails a console with nothing to line up by, even the same pixel for pixel: the alignment check must pass as well', () => {
    const k = compareConsole(screen(), screen());
    expect([k.pass, k.same, k.aligned]).toEqual([false, 1, false]);
  });
});

