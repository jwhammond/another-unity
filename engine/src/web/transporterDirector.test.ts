// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { TransporterRoom } from '../sim/transporter';
import { canEnergize } from '../sim/transporter';
import { LOCK_STEP_MS } from '../view/transporterMap';
import { WALK_DELAY_MS, type Waypoint } from '../view/transporterWalk';
import { TransporterDirector } from './transporterDirector';

const targets = [{ x: 418, y: 415 }, { x: 418, y: 415 }, { x: 213, y: 339 }];

const on: Waypoint[] = [
  { x: 38, y: 289, direction: 0, scale: 256 }, { x: 290, y: 277, direction: 3, scale: 256 }, { x: 326, y: 248, direction: 3, scale: 256 },
  { x: 326, y: 243, direction: 0, scale: 256 }, { x: 0, y: 0, direction: 0, scale: 244 }, { x: 0, y: 0, direction: 0, scale: 244 },
];
const off: Waypoint[] = [
  { x: 0, y: 0, direction: 0, scale: 0 }, { x: 326, y: 248, direction: 9, scale: 244 }, { x: 290, y: 277, direction: 9, scale: 256 }, { x: 38, y: 289, direction: 9, scale: 256 },
];
const pads = [0, 1, 2, 3].map(i => ({ stand: [250 + 51 * i, 231] as [number, number], scale: 240 }));

function setup(target: string | null = 'x', world = 2, walking = false) {
  const sounds: string[] = [];
  const removed: number[] = [];
  let bumps = 0;
  const director = new TransporterDirector({
    targets: () => targets, sound: n => { sounds.push(n); }, bump: () => { bumps++; }, blipMs: () => 100,
    walk: () => (walking ? { on, off, pads } : null), walks: crew => walking && crew !== 'nocard', removePad: p => { removed.push(p); },
  });
  const room: TransporterRoom = {
    target, world: target === null ? 0 : world, pads: ['a', null, null, null], crew: [], equipment: [], kit: [],
    movedByHand: { medkit: false, medicalTricorder: false }, roles: {},
  };
  return { director, room, sounds, removed, bumps: () => bumps };
}

describe('TransporterDirector', () => {
  it('opens each visit on the map, scanning, with the scan sound, and holds the energize until the lock', () => {
    const { director, room, sounds } = setup();
    expect(director.view(room)).toMatchObject({ showing: true, hasTarget: true, world: 2, locked: false, down: null, blip: null });
    director.update(room, 0);
    expect(sounds).toEqual(['transporterScan']);
    expect(room.hold).toBe(true);
    expect(canEnergize(room)).toBe(false);
  });

  it('scans to the target\'s row, then its column, locks on with the computer\'s line, and lets the team go', () => {
    const { director, room, sounds } = setup();
    director.update(room, 21 * LOCK_STEP_MS + 1);
    expect(director.view(room).down).not.toBeNull();
    expect(director.view(room).across).toEqual([51, 339, 366, 2]);
    expect(room.hold).toBe(true);
    director.update(room, 54 * LOCK_STEP_MS);
    expect(director.view(room)).toMatchObject({ locked: true, blip: [194, 320, 38, 38] });
    expect(sounds).toEqual(['transporterScan', 'transporterLocked']);
    expect(room.hold).toBe(false);
    expect(canEnergize(room)).toBe(true);
    // (and it does not say it again)
    director.update(room, 5000);
    expect(sounds).toEqual(['transporterScan', 'transporterLocked']);
  });

  it('turns the blip a frame every blipMs, and tells the panels', () => {
    const { director, room, bumps } = setup();
    director.update(room, 100 * LOCK_STEP_MS);
    expect(director.view(room).locked).toBe(true);
    const before = bumps();
    director.update(room, 60);
    expect(bumps()).toBe(before);
    director.update(room, 60);
    expect(bumps()).toBe(before + 1);
    expect(director.view(room).blipTime).toBeGreaterThanOrEqual(100);
  });

  it('with no target says so, keeps scanning and never locks (and holds nothing: there was nothing to energize to anyway)', () => {
    const { director, room, sounds } = setup(null);
    director.update(room, 0);
    expect(sounds).toEqual(['transporterScan', 'transporterNoTarget']);
    expect(director.view(room)).toMatchObject({ hasTarget: false, world: 0 });
    director.update(room, 200 * LOCK_STEP_MS);
    expect(director.view(room).locked).toBe(false);
    expect(director.view(room).down).toBeNull();
    expect(canEnergize(room)).toBe(false);
  });

  it('Lists puts the map away and frees the energize; Map starts the scan again, from the top, with its sound', () => {
    const { director, room, sounds } = setup();
    director.update(room, 10 * LOCK_STEP_MS);
    director.showMap(room, false);
    expect(director.view(room).showing).toBe(false);
    expect(room.hold).toBe(false);
    // (the scan does not run behind the lists)
    director.update(room, 100 * LOCK_STEP_MS);
    director.showMap(room, true);
    expect(director.view(room)).toMatchObject({ showing: true, locked: false, across: [51, 297, 366, 2] });
    expect(room.hold).toBe(true);
    expect(sounds).toEqual(['transporterScan', 'transporterScan']);
    // (Map while the map is up does nothing, as the original's button does)
    director.showMap(room, true);
    expect(sounds).toHaveLength(2);
  });

  it('is a fresh map for a fresh room', () => {
    const { director, room } = setup();
    director.update(room, 100 * LOCK_STEP_MS);
    const next = { ...room, hold: undefined };
    expect(director.view(next).locked).toBe(false);
  });

  describe('the crew walking on and off the pads', () => {
    const frames = (d: TransporterDirector, room: TransporterRoom, ms: number, step = 16) => { for (let t = 0; t < ms; t += step) d.update(room, step); };

    it('a crew member put on a pad walks in from the door, hidden until they set off, and holds the energize until they have arrived', () => {
      const { director, room, sounds } = setup('x', 2, true);
      room.pads = [null, null, null, null];
      director.update(room, 16);
      room.pads[0] = 'a';
      director.update(room, 16);
      expect(director.walking(room, 0)).toBe(true);
      expect(director.poses(room).get(0)).toMatchObject({ visible: true, at: expect.any(Array), scale: 256 });
      // (the door opens as they set off)
      expect(sounds).toContain('doorOpen');
      expect(room.hold).toBe(true);
      frames(director, room, 5000);
      expect(director.walking(room, 0)).toBe(false);
      expect(director.poses(room).size).toBe(0);
      // (and the door closes when nobody is near it)
      expect(sounds.filter(s => s === 'doorClose')).toHaveLength(1);
    });

    it('the team the room opens with walks in one after another, 1.33 seconds apart, the first at once', () => {
      const { director, room } = setup('x', 2, true);
      room.pads = ['a', 'b', 'c', null];
      director.update(room, 16);
      const poses = director.poses(room);
      expect([...poses.keys()]).toEqual([0, 1, 2]);
      expect([0, 1, 2].map(p => poses.get(p)!.visible)).toEqual([true, false, false]);
      frames(director, room, WALK_DELAY_MS + 100);
      expect([0, 1, 2].map(p => director.poses(room).get(p)!.visible)).toEqual([true, true, false]);
      frames(director, room, WALK_DELAY_MS);
      expect(director.poses(room).get(2)!.visible).toBe(true);
    });

    it('one chosen by hand after that sets off at once, Recommended\'s again one at a time', () => {
      const { director, room } = setup('x', 2, true);
      room.pads = [null, null, null, null];
      director.update(room, 16);
      room.pads[0] = 'a';
      room.pads[1] = 'b';
      director.update(room, 16);
      expect([0, 1].map(p => director.poses(room).get(p)!.visible)).toEqual([true, true]);
      frames(director, room, 6000);
      director.recommended(room);
      room.pads[2] = 'c';
      room.pads[3] = 'd';
      director.update(room, 16);
      expect([2, 3].map(p => director.poses(room).get(p)!.visible)).toEqual([true, false]);
    });

    it('dismissing walks them out to the door and only then puts them back in the list; the pad cannot be clicked meanwhile', () => {
      const { director, room, removed } = setup('x', 2, true);
      room.pads = ['a', null, null, null];
      director.update(room, 16);
      frames(director, room, 5000);
      expect(director.dismiss(room, 0)).toBe(true);
      expect(director.walking(room, 0)).toBe(true);
      expect(room.hold).toBe(true);
      expect(removed).toEqual([]);
      expect(director.poses(room).get(0)).toMatchObject({ at: [250, 231], scale: 240 });
      // (a second dismissal while they walk does nothing)
      expect(director.dismiss(room, 0)).toBe(true);
      frames(director, room, 5000);
      expect(removed).toEqual([0]);
      expect(director.walking(room, 0)).toBe(false);
    });

    it('a crew member without a card, or a game without the walk, is on the pad at once and dismissed at once', () => {
      const { director, room } = setup('x', 2, true);
      room.pads = ['nocard', null, null, null];
      director.update(room, 16);
      expect(director.walking(room, 0)).toBe(false);
      expect(director.dismiss(room, 0)).toBe(false);
      const bare = setup('x', 2, false);
      bare.room.pads = ['a', null, null, null];
      bare.director.update(bare.room, 16);
      expect(bare.director.walking(bare.room, 0)).toBe(false);
    });

    it('takes a long frame as several, so the walk lasts the same at any speed', () => {
      const a = setup('x', 2, true);
      const b = setup('x', 2, true);
      for (const t of [a, b]) { t.room.pads = ['a', null, null, null]; t.director.update(t.room, 16); }
      frames(a.director, a.room, 2000, 16);
      frames(b.director, b.room, 2000, 250);
      const [pa, pb] = [a.director.poses(a.room).get(0)!.at, b.director.poses(b.room).get(0)!.at];
      // (a leg's leftover distance is dropped at each waypoint, as the original does: a longer step drops a little more)
      expect(Math.abs(pa[0] - pb[0])).toBeLessThan(25);
    });
  });
});
