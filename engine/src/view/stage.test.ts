// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { BoxGeometry, type Camera, type Material, Mesh, MeshStandardMaterial, Object3D, type Scene, Texture, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { PixelMetric, ScreenDef, Vec2 } from '../content/types';
import { StopSignal } from '../sim/stop';
import type { World } from '../sim/world';
import { greyboxGlb, type GreyboxRoom } from '../testing/greybox';
import { makeGame, makeWorld } from '../testing/fixture';
import { Projection } from '../content/projection';
import { WalkFloor } from '../sim/walkFloor';
import { parseRoom, readRoom, type RoomView } from './room';
import type { ActorView } from './actors';
import { Stage, type StageOptions } from './stage';
import type { ArtLoaders, CardArt, MaskUrl } from './art';
import { LineSegments, Sprite } from 'three';
import { PresentationClock } from './timeline';
import { dissolveLevel, DISSOLVE_STEP_MS } from './beam';
import { muzzleDirection } from './phaserFx';

/** makeGame's room: door (0, 0), panel (10, 0), center (5, 5), and a closed region "bridge". */
const roomModel: GreyboxRoom = {
  regions: [
    { name: 'main', walkable: true, points: [{ x: -1, z: -1 }, { x: 6, z: -1 }, { x: 6, z: 6 }, { x: -1, z: 6 }] },
    { name: 'bridge', walkable: false, points: [{ x: 6, z: -1 }, { x: 11, z: -1 }, { x: 11, z: 1 }, { x: 6, z: 1 }] },
  ],
  markers: { door: { x: 0, z: 0 }, panel: { x: 10, z: 0 }, center: { x: 5, z: 5 } },
  hotspots: [{ object: 'panel', at: { x: 10, z: 0 }, width: 1, height: 1.5, depth: 0.5 }],
  camera: { position: [5, 4, 16], yfov: 0.8181, horizonY: 100 },
};

const bytes = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function setup(opts: { art?: Partial<StageOptions>; url?: (screen: string) => string | undefined; load?: (url: string) => Promise<RoomView>; room?: Partial<ScreenDef> } = {}) {
  const base = makeGame([]);
  const world = makeWorld([{ id: 'panel', name: 'Panel', screen: 'room', at: 'panel' }], {
    screens: { ...base.screens, room: { ...base.screens.room, ...opts.room } },
  });
  const clock = new PresentationClock();
  const labels = document.createElement('div');
  const warnings: string[] = [];
  const model = await parseRoom(bytes(greyboxGlb(roomModel)));
  const stage = new Stage({
    roomUrl: opts.url ?? (s => (s === 'room' ? 'room.glb' : undefined)),
    load: opts.load ?? (async () => model),
    clock, labels, warn: m => warnings.push(m), ...opts.art,
  });
  const attached = stage.attach(world);
  return { world, stage, clock, labels, warnings, attached };
}

function ndcOf(stage: Stage, p: Vector3): { x: number; y: number } {
  stage.scene.updateMatrixWorld();
  const v = p.clone().project(stage.room!.camera);
  return { x: v.x, y: v.y };
}

/** Lets presentation time pass in 0.1 s frames, letting promises run between them. */
async function frames(stage: Stage, clock: PresentationClock, seconds: number): Promise<void> {
  for (let t = 0; t < seconds; t += 0.1) {
    await tick();
    clock.update(0.1);
    stage.frame(0.1);
  }
  await tick();
}

/** Where a world point is drawn in the original's 640x480. */
function pixelOf(stage: Stage, p: Vector3): { x: number; y: number } {
  const v = p.clone().project(stage.room!.camera);
  return { x: ((v.x + 1) / 2) * 640, y: ((1 - v.y) / 2) * 480 };
}

const actorOf = (stage: Stage, id: string): ActorView => (stage as unknown as { actors: Map<string, ActorView> }).actors.get(id)!;

function changeScreen(world: World, to: string, entrance: string): void {
  world.state.pendingScreen = { to, entrance };
  world.applyScreenChange();
}

const sparkleCard = (): CardArt => {
  const a = (frames: number, delay: number, url: string) => ({ url, frames, cell: [232, 704] as [number, number], anchor: [0.5, 1] as [number, number], delays: Array.from({ length: frames }, () => delay), loop: false });
  return { url: 'fx0.webp', frames: 1, anchor: [0.5, 1], anims: { 0: a(13, 86, 'fx0.webp'), 1: a(8, 127, 'fx1.webp') } };
};

describe('Stage', () => {
  it('puts a labelled capsule on each crew member here, where the sim has them', async () => {
    const { stage, labels, attached } = await setup();
    await attached;
    expect(stage.actorIds()).toEqual(['picard', 'data']);
    expect(stage.actorAt('data')).toEqual({ x: 0, z: 0 });
    expect(labels.textContent).toContain('Picard');
    expect(stage.room?.modelled).toBe(true);
  });

  it("labels each pickable hotspot with its name over its rectangle only while the player's toggle is on", async () => {
    let on = false;
    const withRect = await parseRoom(bytes(greyboxGlb({ ...roomModel, hotspots: [{ ...roomModel.hotspots[0]!, rect: [500, 120, 560, 200] }] })));
    const { world, stage, labels, clock, attached } = await setup({ art: { hotspotLabels: () => on }, load: async () => withRect });
    await attached;
    Object.defineProperty(labels, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(labels, 'clientHeight', { value: 480, configurable: true });
    const spots = () => [...labels.querySelectorAll<HTMLElement>('.au-hotspot')];
    await frames(stage, clock, 0.1);
    expect(spots()).toHaveLength(0);
    on = true;
    await frames(stage, clock, 0.1);
    expect(spots().map(e => e.textContent)).toEqual(['Panel']);
    expect(spots()[0]!.style.cssText).toContain('left: 500px');
    expect(spots()[0]!.style.cssText).toContain('width: 60px');
    // (one that is switched off, or has left, is not a place to click)
    world.obj('panel').active = false;
    await frames(stage, clock, 0.1);
    expect(spots()).toHaveLength(0);
    world.obj('panel').active = true;
    on = false;
    await frames(stage, clock, 0.1);
    expect(spots()).toHaveLength(0);
  });

  it('picks objects under the pointer, open floor elsewhere, and the nearest open floor from a closed region', async () => {
    const { world, stage, attached } = await setup();
    await attached;
    expect(stage.pick(ndcOf(stage, new Vector3(10, 0.75, 0)))).toEqual({ kind: 'object', id: 'panel' });
    const floor = stage.pick(ndcOf(stage, new Vector3(2, 0, 3)));
    expect(floor?.kind).toBe('floor');
    expect(floor?.kind === 'floor' && floor.at.x).toBeCloseTo(2, 1);
    // (as walkTo goes to the nearest walkable point: the main floor's edge is at x 6)
    const closed = stage.pick(ndcOf(stage, new Vector3(8, 0, 0.5)));
    expect(closed?.kind === 'floor' && closed.at.x).toBeCloseTo(6, 2);
    expect(stage.pick({ x: 0, y: 0.99 })).toBeNull();
    world.state.regions.room.bridge = true;
    world.bus.emit({ type: 'regionsChanged', screen: 'room' });
    const opened = stage.pick(ndcOf(stage, new Vector3(8, 0, 0.5)));
    expect(opened?.kind === 'floor' && opened.at.x).toBeCloseTo(8, 1);
    expect(stage.nav.locate({ x: 8, z: 0 })).toBeGreaterThanOrEqual(0);
  });

  it("picks in the original's draw order: whoever stands lower on the screen, whatever a deep hotspot's box reaches", async () => {
    // (a hotspot box deeper than the actor's distance from its ground point: its front face is nearer the camera than
    // an actor standing just in front of the object, as the access shaft's is on Horst III's second screen)
    const deep = await parseRoom(bytes(greyboxGlb({ ...roomModel, hotspots: [{ object: 'panel', at: { x: 10, z: 0 }, width: 2, height: 2, depth: 3 }] })));
    const { world, stage, attached } = await setup({ load: async () => deep });
    await attached;
    const stand = (z: number) => {
      world.obj('picard').pos = { x: 10, z };
      world.bus.emit({ type: 'objectChanged', id: 'picard' });
    };
    // (in front of the object's ground point: the actor is drawn over it, so takes the click)
    stand(0.3);
    expect(stage.pick(ndcOf(stage, new Vector3(10, 0.9, 0.3)))).toEqual({ kind: 'object', id: 'picard' });
    // (the hotspot round the actor is still the hotspot)
    expect(stage.pick(ndcOf(stage, new Vector3(10.8, 1.5, 0)))).toEqual({ kind: 'object', id: 'panel' });
    // (behind it, the object is drawn over the actor: the object takes the click, as objectAt checks it first)
    stand(-0.3);
    expect(stage.pick(ndcOf(stage, new Vector3(10, 0.9, -0.3)))).toEqual({ kind: 'object', id: 'panel' });
  });

  it('moves hotspots with their objects, and hides and stops picking inactive ones', async () => {
    const { world, stage, attached } = await setup();
    await attached;
    world.obj('panel').pos = { x: 5, z: 5 };
    world.bus.emit({ type: 'objectChanged', id: 'panel' });
    expect(stage.pick(ndcOf(stage, new Vector3(5, 0.75, 5)))).toEqual({ kind: 'object', id: 'panel' });
    world.obj('panel').active = false;
    world.bus.emit({ type: 'objectChanged', id: 'panel' });
    expect(stage.pick(ndcOf(stage, new Vector3(5, 0.75, 5)))?.kind).not.toBe('object');
  });

  it('keeps a hotspot box where the lifter stood it, off its object\'s marker (a sprite\'s own position), and moves it with the object', async () => {
    // (the box stands 1.5 m right of and 0.5 m behind the panel's marker, as a sprite drawn at its own POSN does)
    const shifted = await parseRoom(bytes(greyboxGlb({ ...roomModel, hotspots: [{ ...roomModel.hotspots[0]!, at: { x: 8.5, z: -0.5 } }] })));
    const { world, stage, attached } = await setup({ load: async () => shifted });
    await attached;
    const box = stage.room!.hotspots.get('panel')!.mesh;
    expect([box.position.x, box.position.z]).toEqual([8.5, -0.5]);
    expect(stage.pick(ndcOf(stage, new Vector3(8.5, 0.75, -0.5)))).toEqual({ kind: 'object', id: 'panel' });
    world.obj('panel').pos = { x: 5, z: 5 };
    world.bus.emit({ type: 'objectChanged', id: 'panel' });
    expect([box.position.x, box.position.z]).toEqual([3.5, 4.5]);
  });

  describe('hotspots with their rectangle: objectAt on the original\'s 640 by 480 pixels', () => {
    const modelWith = (hotspots: GreyboxRoom['hotspots']) => parseRoom(bytes(greyboxGlb({ ...roomModel, hotspots })));
    const pixel = (x: number, y: number) => ({ x: (x / 640) * 2 - 1, y: 1 - (y / 480) * 2 });
    const spot = (object: string, rect: [number, number, number, number], extra: Partial<GreyboxRoom['hotspots'][number]> = {}) =>
      ({ object, at: { x: 10, z: 0 }, width: 1, height: 1.5, depth: 0.05, rect, ...extra });

    it('picks a rectangle above the horizon, where its box has no ground point to stand on (the shelf\'s pickups, the conduit on the far wall)', async () => {
      // (the camera's horizon is row 100: this rectangle is rows 40 to 70, inclusive at its edges; its box is at the room's panel, nowhere near)
      const model = await modelWith([spot('panel', [300, 40, 340, 70])]);
      const { stage, attached } = await setup({ load: async () => model });
      await attached;
      expect(stage.pick(pixel(320, 55))).toEqual({ kind: 'object', id: 'panel' });
      expect(stage.pick(pixel(300, 40))).toEqual({ kind: 'object', id: 'panel' });
      expect(stage.pick(pixel(340, 70))).toEqual({ kind: 'object', id: 'panel' });
      expect(stage.pick(pixel(341, 55))?.kind).not.toBe('object');
      expect(stage.pick(pixel(320, 71))?.kind).not.toBe('object');
    });

    it('checks the one drawn in front first: by y_adjust where it has one, else its y, and a later object wins a tie', async () => {
      const base = { ...makeGame([]).objects };
      void base;
      const world = makeWorld([
        { id: 'near', name: 'Near', screen: 'room', at: 'panel' },
        { id: 'far', name: 'Far', screen: 'room', at: 'panel' },
        { id: 'tied', name: 'Tied', screen: 'room', at: 'panel' },
      ]);
      const model = await modelWith([
        spot('near', [100, 20, 200, 80], { order: 60 }),
        // (taller, ends lower on the screen, but its y_adjust puts it behind: the conduit's case, 0623 over 0606)
        spot('far', [100, 20, 200, 120], { order: 50 }),
      ]);
      const stage = new Stage({ roomUrl: s => (s === 'room' ? 'room.glb' : undefined), load: async () => model, clock: new PresentationClock(), labels: document.createElement('div') });
      await stage.attach(world);
      expect(stage.pick(pixel(150, 50))).toEqual({ kind: 'object', id: 'near' });
      expect(stage.pick(pixel(150, 100))).toEqual({ kind: 'object', id: 'far' });
      const tie = await modelWith([spot('near', [100, 20, 200, 80], { order: 60 }), spot('far', [100, 20, 200, 80], { order: 60 })]);
      const second = new Stage({ roomUrl: s => (s === 'room' ? 'room.glb' : undefined), load: async () => tie, clock: new PresentationClock(), labels: document.createElement('div') });
      await second.attach(world);
      expect(second.pick(pixel(150, 50))).toEqual({ kind: 'object', id: 'far' });
    });

    it('does not pick a rectangle whose object is off, taken or on another screen, or that no click can pick', async () => {
      const model = await modelWith([spot('panel', [300, 40, 340, 70], { pickable: false })]);
      const unpickable = await setup({ load: async () => model });
      await unpickable.attached;
      expect(unpickable.stage.pick(pixel(320, 55))?.kind).not.toBe('object');
      const ok = await modelWith([spot('panel', [300, 40, 340, 70])]);
      const { world, stage, attached } = await setup({ load: async () => ok });
      await attached;
      world.obj('panel').active = false;
      world.bus.emit({ type: 'objectChanged', id: 'panel' });
      expect(stage.pick(pixel(320, 55))?.kind).not.toBe('object');
    });
  });

  it('walks along the navmesh and ends where the sim said', async () => {
    const { stage, clock, attached } = await setup();
    await attached;
    let end: Vec2 | undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 5, z: 5 }, new StopSignal()).then(p => { end = p; });
    await frames(stage, clock, 2);
    expect(end).toBeUndefined();
    await frames(stage, clock, 2);
    expect(end).toEqual({ x: 5, z: 5 });
    expect(stage.actorAt('picard')).toEqual({ x: 5, z: 5 });
  });

  it('walks faster while hurrying, to the same end', async () => {
    const { stage, clock, attached } = await setup();
    await attached;
    stage.hurry = true;
    let end: Vec2 | undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 5, z: 5 }, new StopSignal()).then(p => { end = p; });
    // (7.07 m: 3.5 s at the usual pace, so not done in 2 s unless faster)
    await frames(stage, clock, 2);
    expect(end).toEqual({ x: 5, z: 5 });
    stage.hurry = false;
    end = undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 5, z: 5 }, new StopSignal()).then(p => { end = p; });
    await frames(stage, clock, 2);
    expect(end).toBeUndefined();
  });

  it('stops part way when the sim stops the walk, and says where', async () => {
    const { stage, clock, attached } = await setup();
    await attached;
    const stop = new StopSignal();
    let end: Vec2 | undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 4, z: 0 }, stop).then(p => { end = p; });
    await frames(stage, clock, 1);
    stop.stop();
    await tick();
    expect(end!.x).toBeGreaterThan(1);
    expect(end!.x).toBeLessThan(3);
    expect(stage.actorAt('picard')).toEqual(end);
    await frames(stage, clock, 2);
    expect(stage.actorAt('picard')).toEqual(end);
  });

  it('waits for the room before walking', async () => {
    let finish!: (room: RoomView) => void;
    const model = await parseRoom(bytes(greyboxGlb(roomModel)));
    const { stage, clock } = await setup({ load: () => new Promise(resolve => { finish = resolve; }) });
    let end: Vec2 | undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 1, z: 0 }, new StopSignal()).then(p => { end = p; });
    await frames(stage, clock, 1);
    expect(end).toBeUndefined();
    finish(model);
    await frames(stage, clock, 1);
    expect(end).toEqual({ x: 1, z: 0 });
  });

  it('shows the latest screen when loads finish out of order', async () => {
    const pending = new Map<string, (room: RoomView) => void>();
    const { world, stage } = await setup({
      url: s => `${s}.glb`,
      load: url => new Promise(resolve => pending.set(url, resolve)),
    });
    await tick();
    changeScreen(world, 'hall', 'entry');
    await tick();
    const hall = await parseRoom(bytes(greyboxGlb({ ...roomModel, markers: { entry: { x: 1, z: 1 } }, hotspots: [] })));
    const room = await parseRoom(bytes(greyboxGlb(roomModel)));
    pending.get('hall.glb')!(hall);
    await tick();
    pending.get('room.glb')!(room);
    await stage.ready;
    await tick();
    expect(stage.room).toBe(hall);
    expect(stage.actorAt('picard')).toEqual({ x: 1, z: 1 });
  });

  it('falls back to a flat floor when there is no model, or it fails to load', async () => {
    const { world, stage, warnings, attached } = await setup({ load: async () => { throw new Error('404'); } });
    await attached;
    expect(stage.room?.modelled).toBe(false);
    expect(warnings[0]).toMatch(/could not load the room for room \(404\)/);
    // (in a made-up room every object gets a box to click)
    expect(stage.pick(ndcOf(stage, new Vector3(10, 0.5, 0)))).toEqual({ kind: 'object', id: 'panel' });
    changeScreen(world, 'hall', 'entry');
    await stage.ready;
    expect(stage.room?.modelled).toBe(false);
    expect(stage.actorAt('picard')).toEqual({ x: 1, z: 1 });
  });

  it('falls back to a flat floor when the model has no camera', async () => {
    const { stage, warnings, attached } = await setup({ load: async () => readRoom(new Object3D()) });
    await attached;
    expect(stage.room?.modelled).toBe(false);
    expect(warnings[0]).toMatch(/could not load the room for room \(the room has no camera\)/);
    expect(stage.actorAt('data')).toEqual({ x: 0, z: 0 });
  });

  it('draws the phaser and the transporter on presentation time', async () => {
    const { stage, clock, attached } = await setup();
    await attached;
    let shot = false;
    void stage.show({ kind: 'phaserShot', from: 'picard', to: 'panel' }).then(() => { shot = true; });
    await frames(stage, clock, 0.3);
    expect(shot).toBe(false);
    await frames(stage, clock, 0.4);
    expect(shot).toBe(true);
    let beamed = false;
    void stage.show({ kind: 'beam', objects: ['data'], out: true, chodak: false }).then(() => { beamed = true; });
    await frames(stage, clock, 1.5);
    expect(beamed).toBe(false);
    await frames(stage, clock, 1.5);
    expect(beamed).toBe(true);
  });

  describe('the transporter\'s beam', () => {
    const body = (stage: Stage, id: string) => actorOf(stage, id).body.material.opacity;
    const BEAM = 1.1 + (7 * DISSOLVE_STEP_MS) / 1000;

    it('beaming out: whole while the sparkle plays, fading a level a step, and gone at the end', async () => {
      const { stage, clock, attached } = await setup();
      await attached;
      let done = false;
      void stage.show({ kind: 'beam', objects: ['picard'], out: true, chodak: false }).then(() => { done = true; });
      await frames(stage, clock, 0.5);
      expect(body(stage, 'picard')).toBe(1);
      expect(stage.artState().beams).toMatchObject([{ objects: ['picard'], out: true, sparkle: 0, level: 6 }]);
      await frames(stage, clock, 1.1);
      expect(stage.artState().beams[0]).toMatchObject({ sparkle: 1 });
      expect(body(stage, 'picard')).toBeLessThan(1);
      await frames(stage, clock, BEAM);
      expect(done).toBe(true);
      expect(body(stage, 'picard')).toBe(0);
      expect(stage.artState().beams).toEqual([]);
    });

    it('beaming in: hidden from the moment the sim has put them here, and whole at the end', async () => {
      const { stage, clock, attached } = await setup();
      await attached;
      let done = false;
      void stage.show({ kind: 'beam', objects: ['picard'], out: false, chodak: false }).then(() => { done = true; });
      // (before the first frame draws: it never shows whole)
      expect(body(stage, 'picard')).toBe(0);
      await frames(stage, clock, 0.5);
      expect(body(stage, 'picard')).toBe(0);
      await frames(stage, clock, BEAM + 0.5);
      expect(done).toBe(true);
      expect(body(stage, 'picard')).toBe(1);
    });

    it('holds an arriving team hidden until their beam-in plays, and lets them go if none does', async () => {
      const { stage, world, clock, attached } = await setup();
      await attached;
      world.state.awayTeam = ['picard'];
      world.bus.emit({ type: 'beamedDown', world: 4, effect: true });
      world.bus.emit({ type: 'objectChanged', id: 'picard' });
      await frames(stage, clock, 0.3);
      expect(body(stage, 'picard')).toBe(0);
      let done = false;
      void stage.show({ kind: 'beam', objects: ['picard'], out: false, chodak: false }).then(() => { done = true; });
      await frames(stage, clock, BEAM + 0.5);
      expect(done).toBe(true);
      expect(body(stage, 'picard')).toBe(1);
      // (a team whose beam-in never comes is shown after a while)
      world.bus.emit({ type: 'beamedDown', world: 4, effect: true });
      world.obj('picard').active = true;
      world.bus.emit({ type: 'objectChanged', id: 'picard' });
      actorOf(stage, 'picard').dissolve(0);
      await frames(stage, clock, 31);
      expect(body(stage, 'picard')).toBe(1);
    });

    it('a beam of nothing the stage draws ends at once', async () => {
      const { stage, clock, attached } = await setup();
      await attached;
      let done = false;
      void stage.show({ kind: 'beam', objects: ['nobody'], out: true, chodak: false }).then(() => { done = true; });
      await frames(stage, clock, 0.2);
      expect(done).toBe(true);
    });
  });

  it('shows hotspots, markers and the navmesh for the dev tools', async () => {
    const { stage, attached } = await setup();
    await attached;
    stage.setDebug({ markers: true, navmesh: true });
    expect(stage.debugView).toEqual({ hotspots: false, markers: true, navmesh: true, art: true });
    const debug = stage.scene.children.find(c => c.name === 'debug')!;
    // three markers, and one line set for the navmesh
    expect(debug.children).toHaveLength(4);
    stage.setDebug({ markers: false, navmesh: false });
    expect(debug.children).toHaveLength(0);
  });

  it('ends a finished walk exactly where the sim said, and rounds only a stopped one', async () => {
    const { stage, clock, attached } = await setup();
    await attached;
    let end: Vec2 | undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 1.23456789, z: 0.0004 }, new StopSignal()).then(p => { end = p; });
    await frames(stage, clock, 2);
    expect(end).toEqual({ x: 1.23456789, z: 0.0004 });
    expect(stage.actorAt('picard')).toEqual(end);
  });

  it('warns and uses an empty floor for a screen with no definition', async () => {
    const { world, stage, warnings, attached } = await setup();
    await attached;
    world.bus.emit({ type: 'screenChanged', screen: 'ghost' });
    await expect(stage.ready).resolves.toBeUndefined();
    expect(warnings).toEqual(['ghost has no screen definition: using an empty floor']);
    expect(stage.room?.modelled).toBe(false);
  });

  it('frees the props of a room it leaves', async () => {
    const { world, stage, attached } = await setup({ load: async () => { throw new Error('404'); } });
    await attached;
    const props = (stage as unknown as { props: Map<string, { material: { dispose(): void } }> }).props;
    const dispose = vi.spyOn(props.get('panel')!.material, 'dispose');
    changeScreen(world, 'hall', 'entry');
    await stage.ready;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("frees a modelled room's geometry, materials and textures when it leaves, and the materials it replaced", async () => {
    const model = await parseRoom(bytes(greyboxGlb(roomModel)));
    const region = [...model.regions.values()][0].mesh;
    const original = region.material as MeshStandardMaterial;
    original.map = new Texture();
    const originalDispose = vi.spyOn(original, 'dispose');
    const textureDispose = vi.spyOn(original.map, 'dispose');
    const geometryDispose = vi.spyOn(region.geometry, 'dispose');
    const { world, stage, attached } = await setup({ load: async () => model });
    await attached;
    // (setRoom gave the region a clone: the original is freed then)
    expect(originalDispose).toHaveBeenCalledOnce();
    const clone = region.material as Material;
    expect(clone).not.toBe(original);
    const cloneDispose = vi.spyOn(clone, 'dispose');
    expect(geometryDispose).not.toHaveBeenCalled();
    changeScreen(world, 'hall', 'entry');
    await stage.ready;
    expect(cloneDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });

  it("frees a flat floor's geometry and material when it leaves", async () => {
    const { world, stage, attached } = await setup({ load: async () => { throw new Error('404'); } });
    await attached;
    const floor = stage.room!.regions.get('floor')!.mesh;
    const material = vi.spyOn(floor.material as Material, 'dispose');
    const geometry = vi.spyOn(floor.geometry, 'dispose');
    changeScreen(world, 'hall', 'entry');
    await stage.ready;
    expect(material).toHaveBeenCalledOnce();
    expect(geometry).toHaveBeenCalledOnce();
  });

  it('builds the walking graph as a room loads, not on the first blocked click', async () => {
    const { stage, attached } = await setup();
    await attached;
    expect((stage.nav as unknown as { visible: number[][] | null }).visible).not.toBeNull();
  });

  it('ends a walk where the actor stood when the actor leaves the stage', async () => {
    const { world, stage, clock, attached } = await setup();
    await attached;
    let end: Vec2 | undefined;
    void stage.walk('picard', { x: 0, z: 0 }, { x: 4, z: 0 }, new StopSignal()).then(p => { end = p; });
    await frames(stage, clock, 1);
    expect(end).toBeUndefined();
    const at = stage.actorAt('picard')!;
    world.obj('picard').active = false;
    world.bus.emit({ type: 'objectChanged', id: 'picard' });
    await tick();
    expect(end).toEqual({ x: Math.round(at.x * 1000) / 1000, z: 0 });
    expect(stage.actorIds()).toEqual(['data']);
  });

  it('picks nothing while a room is loading', async () => {
    const pending = new Map<string, (room: RoomView) => void>();
    const { world, stage, attached } = await setup({
      url: s => `${s}.glb`,
      load: url => new Promise(resolve => pending.set(url, resolve)),
    });
    const room = await parseRoom(bytes(greyboxGlb(roomModel)));
    await tick();
    pending.get('room.glb')!(room);
    await attached;
    const at = ndcOf(stage, new Vector3(2, 0, 3));
    expect(stage.pick(at)?.kind).toBe('floor');
    changeScreen(world, 'hall', 'entry');
    await tick();
    expect(stage.pick(at)).toBeNull();
    pending.get('hall.glb')!(room);
    await stage.ready;
    expect(stage.pick(at)?.kind).toBe('floor');
  });

  it('puts an actor where it was placed, even in the middle of a walk', async () => {
    const { world, stage, clock, attached } = await setup();
    await attached;
    // (the world's own walk, drawn by the stage)
    world.presenter.walk = (actor, from, to, stop) => stage.walk(actor, from, to, stop);
    const walked = (world as unknown as { walkActor(actor: string, to: Vec2): Promise<boolean> }).walkActor('picard', { x: 4, z: 0 });
    await frames(stage, clock, 0.5);
    expect(stage.actorAt('picard')!.x).toBeGreaterThan(0.5);
    world.obj('picard').pos = { x: 5, z: 5 };
    world.stopWalk('picard', true);
    expect(await walked).toBe(true);
    expect(world.obj('picard').pos).toEqual({ x: 5, z: 5 });
    world.bus.emit({ type: 'objectChanged', id: 'picard' });
    expect(stage.actorAt('picard')).toEqual({ x: 5, z: 5 });
    await frames(stage, clock, 1);
    expect(stage.actorAt('picard')).toEqual({ x: 5, z: 5 });
  });

  it('turns an actor to a side, or toward an object', async () => {
    const { world, stage, attached } = await setup();
    await attached;
    const picard = actorOf(stage, 'picard');
    world.bus.emit({ type: 'turned', who: 'picard', side: 'right' });
    expect(picard.group.rotation.y).toBeCloseTo(Math.PI / 2);
    world.bus.emit({ type: 'turned', who: 'picard', side: 'left' });
    expect(picard.group.rotation.y).toBeCloseTo(-Math.PI / 2);
    // (the panel is straight along +x from picard at the door)
    world.bus.emit({ type: 'faced', who: 'picard', toward: 'panel' });
    expect(picard.group.rotation.y).toBeCloseTo(Math.PI / 2);
  });

  describe('on a screen with a pixel metric', () => {
    // (a flat fit at scale 200; the floor's corners say 100 at the top and 150 at the bottom: an actor stands at half
    // to three quarters of the size the room camera alone would draw)
    const corners = [{ x: 0, y: 0, scale: 100 }, { x: 639, y: 0, scale: 100 }, { x: 639, y: 479, scale: 150 }, { x: 0, y: 479, scale: 150 }];
    const metric: PixelMetric = {
      kind: 'flat', slope: 0, horizonY: 0, meanScale: 200, topY: 0, metersPerPixel: 0.0125, floor: [{ region: 'deck', points: corners }],
    };
    const room = { pixelMetric: metric, regions: { bridge: false, deck: true } };
    const expected = (at: Vec2) => {
      const p = new Projection(metric).toPixel(at);
      return new WalkFloor([corners]).scaleAt({ x: Math.round(p.x), y: Math.round(p.y) }) / 200;
    };

    it('draws each actor at the floor\'s scale where it stands, over the room camera\'s', async () => {
      const top = { ...metric, floor: [{ region: 'deck', points: corners.map(c => ({ ...c, scale: 100 })) }] };
      const { stage, attached } = await setup({ room: { pixelMetric: top, regions: room.regions } });
      await attached;
      expect(actorOf(stage, 'picard').group.scale.toArray()).toEqual([0.5, 0.5, 0.5]);
    });

    it("keeps a smaller actor's name tag just over its head", async () => {
      const top = { ...metric, floor: [{ region: 'deck', points: corners.map(c => ({ ...c, scale: 100 })) }] };
      const { stage, labels, attached } = await setup({ room: { pixelMetric: top, regions: room.regions } });
      await attached;
      Object.defineProperty(labels, 'clientWidth', { value: 640 });
      Object.defineProperty(labels, 'clientHeight', { value: 480 });
      stage.frame(0);
      const picard = actorOf(stage, 'picard');
      const tagY = Number(/translate\([-\d.]+px, ([-\d.]+)px\)/.exec(picard.label!.style.transform)?.[1]);
      // (the top of the half-size capsule, on the canvas: the tag is just above it, not where a full-size head would be)
      const head = new Vector3(picard.position.x, 0.9, picard.position.z).project(stage.room!.camera);
      const headY = ((1 - head.y) / 2) * 480;
      expect(tagY).toBeLessThan(headY);
      expect(headY - tagY).toBeLessThan(20);
    });

    it('rescales an actor as it walks, and where it ends', async () => {
      const { stage, clock, attached } = await setup({ room });
      await attached;
      const picard = actorOf(stage, 'picard');
      expect(picard.group.scale.x).toBeCloseTo(expected({ x: 0, z: 0 }), 6);
      void stage.walk('picard', { x: 0, z: 0 }, { x: 0, z: -3 }, new StopSignal());
      await frames(stage, clock, 0.5);
      expect(picard.group.scale.x).toBeCloseTo(expected(picard.position), 6);
      expect(picard.group.scale.x).not.toBeCloseTo(expected({ x: 0, z: 0 }), 3);
      await frames(stage, clock, 5);
      expect(picard.position).toEqual({ x: 0, z: -3 });
      expect(picard.group.scale.x).toBeCloseTo(expected({ x: 0, z: -3 }), 6);
    });

    it('leaves actors at full size without a metric', async () => {
      const { stage, attached } = await setup();
      await attached;
      expect(actorOf(stage, 'picard').group.scale.toArray()).toEqual([1, 1, 1]);
    });
  });

  describe('art', () => {
    const plate = () => new Texture();
    const art = (over: Partial<ArtLoaders> = {}, urls: Record<string, string> = { plate: 'p.png', depth: 'd.png' }) => {
      const made: Texture[] = [];
      const loaders: ArtLoaders = {
        texture: async () => {
          const t = plate();
          made.push(t);
          return t;
        },
        model: async () => new Object3D(),
        ...over,
      };
      return { made, art: { art: { room: (s: string) => (s === 'room' ? urls : undefined), card: () => undefined }, artLoaders: loaders } };
    };
    const meshes = (stage: Stage) => {
      const out: { mesh: Mesh; visible: boolean }[] = [];
      stage.room!.root.traverse(n => {
        if (n instanceof Mesh) out.push({ mesh: n, visible: (n.material as Material).visible });
      });
      return out;
    };

    it('with a plate, the background is the plate and the greybox meshes are hidden by material only', async () => {
      const { made, art: a } = art();
      const { stage, attached } = await setup({ art: a });
      await attached;
      await tick();
      expect(stage.scene.background).toBe(made[0]);
      expect(stage.artState()).toMatchObject({ screen: 'room', plate: true, on: true });
      const all = meshes(stage);
      expect(all.length).toBeGreaterThan(0);
      for (const { mesh, visible } of all) {
        expect(visible).toBe(false);
        expect(mesh.visible).toBe(true);
      }
    });

    it('art on picks and walks exactly as greybox: the same object at the same ndc, the same floor point', async () => {
      const { art: a } = art();
      const on = await setup({ art: a });
      const off = await setup({ art: { ...a, artOff: true } });
      await on.attached;
      await off.attached;
      await tick();
      expect(on.stage.artState().on).toBe(true);
      expect(off.stage.artState().on).toBe(false);
      for (const p of [new Vector3(10, 0.75, 0), new Vector3(2, 0, 3), new Vector3(8, 0, 0.5), new Vector3(5, 0, 5)]) {
        expect(on.stage.pick(ndcOf(on.stage, p))).toEqual(off.stage.pick(ndcOf(off.stage, p)));
      }
      expect(on.stage.pick(ndcOf(on.stage, new Vector3(10, 0.75, 0)))).toEqual({ kind: 'object', id: 'panel' });
      expect(on.stage.nav.triangles.length).toBe(off.stage.nav.triangles.length);
      const stop = new StopSignal();
      let end: Vec2 | undefined;
      void on.stage.walk('picard', { x: 0, z: 0 }, { x: 5, z: 5 }, stop).then(p => { end = p; });
      await frames(on.stage, on.clock, 4);
      expect(end).toEqual({ x: 5, z: 5 });
    });

    it('a plate that fails to load leaves greybox, with one warning', async () => {
      const { art: a } = art({ texture: async () => { throw new Error('404'); } }, { plate: 'p.png' });
      const { stage, attached, warnings } = await setup({ art: a });
      await attached;
      await tick();
      expect(stage.artState().on).toBe(false);
      expect(warnings.filter(w => w.includes('plate'))).toHaveLength(1);
      expect(meshes(stage).every(m => m.visible)).toBe(true);
    });

    it('a room without art in presentation stays greybox', async () => {
      const { art: a } = art({}, { plate: 'p.png' });
      const { stage, attached } = await setup({ art: { ...a, art: { room: () => undefined, card: () => undefined } } });
      await attached;
      await tick();
      expect(stage.artState()).toMatchObject({ plate: false, on: false });
      expect(meshes(stage).every(m => m.visible)).toBe(true);
    });

    it('setDebug({ art: false }) shows greybox at once; on again shows the plate without reloading', async () => {
      const { made, art: a } = art();
      const { stage, attached } = await setup({ art: a });
      await attached;
      await tick();
      const bg = stage.scene.background;
      stage.setDebug({ art: false });
      expect(stage.scene.background).not.toBe(bg);
      expect(meshes(stage).every(m => m.visible)).toBe(true);
      stage.setDebug({ art: true });
      await tick();
      expect(stage.scene.background).toBe(bg);
      expect(made).toHaveLength(2);
    });

    it('turning art on in a room that started with it off loads it then', async () => {
      const { made, art: a } = art();
      const { stage, attached } = await setup({ art: { ...a, artOff: true } });
      await attached;
      await tick();
      expect(made).toHaveLength(0);
      stage.setDebug({ art: true });
      await tick();
      expect(stage.artState().plate).toBe(true);
    });

    it('the hotspot and navmesh debug views still draw over the plate', async () => {
      const { art: a } = art();
      const { stage, attached } = await setup({ art: a });
      await attached;
      await tick();
      const hotspot = stage.room!.hotspots.get('panel')!.mesh;
      const region = stage.room!.regions.get('main')!.mesh;
      expect((hotspot.material as Material).visible).toBe(false);
      stage.setDebug({ hotspots: true, navmesh: true });
      expect((hotspot.material as Material).visible).toBe(true);
      expect((region.material as Material).visible).toBe(true);
      expect(stage.scene.getObjectByName('debug')!.children.length).toBeGreaterThan(0);
    });

    it('frees the art of the room it leaves, and of a load a screen change overtook', async () => {
      const { made, art: a } = art();
      const { stage, attached, world } = await setup({ art: a });
      await attached;
      await tick();
      const disposed = made.map(t => vi.spyOn(t, 'dispose'));
      stage.detach();
      expect(disposed.every(d => d.mock.calls.length === 1)).toBe(true);
      expect(stage.scene.background).not.toBe(made[0]);
      // (a load a screen change overtakes)
      let release: () => void = () => {};
      const gate = new Promise<void>(r => { release = r; });
      const slow = art({ texture: async () => { await gate; const t = plate(); late.push(t); return t; } });
      const late: Texture[] = [];
      const second = await setup({ art: slow.art });
      await second.attached;
      second.stage.detach();
      release();
      await tick();
      await tick();
      expect(late.length).toBeGreaterThan(0);
      void world;
    });

    describe('scene swaps (B5)', () => {
      /** What a frame draws now: the scene and camera the stage hands the renderer. */
      const drawn = (stage: Stage): { scene: Scene; camera: Camera } | null => {
        let got: { scene: Scene; camera: Camera } | null = null;
        stage.render({ render: (scene: Scene, camera: Camera) => { got = { scene, camera }; } } as unknown as WebGLRenderer);
        return got;
      };
      /** Rooms and plates that load when the test says: each screen has a model `<screen>.glb` and a plate `<screen>.png`. */
      const gated = async (over: Partial<StageOptions> = {}) => {
        const rooms = new Map<string, (room: RoomView) => void>();
        const plates = new Map<string, () => Texture>();
        const loaders: ArtLoaders = {
          texture: url => new Promise(resolve => plates.set(url, () => { const t = new Texture(); resolve(t); return t; })),
          model: async () => new Object3D(),
        };
        const ctx = await setup({
          url: s => `${s}.glb`,
          load: url => new Promise(resolve => rooms.set(url, resolve)),
          art: { art: { room: (s: string) => ({ plate: `${s}.png` }), card: () => undefined }, artLoaders: loaders, ...over },
        });
        await tick();
        const first = await parseRoom(bytes(greyboxGlb(roomModel)));
        rooms.get('room.glb')!(first);
        const plate = plates.get('room.png')?.();
        await ctx.attached;
        await ctx.stage.artDone;
        return { ...ctx, rooms, plates, first, plate };
      };
      const hallModel = () => parseRoom(bytes(greyboxGlb({ ...roomModel, markers: { entry: { x: 1, z: 1 } }, hotspots: [] })));

      it('the old room and its actors stay until the new room and its art are ready, then swap in one frame', async () => {
        const { world, stage, rooms, plates, first, plate } = await gated();
        expect(drawn(stage)!.scene).toBe(stage.scene);
        expect(stage.scene.background).toBe(plate);
        const crew = ['picard', 'data'].map(id => actorOf(stage, id).group);
        const plateFreed = vi.spyOn(plate!, 'dispose');
        changeScreen(world, 'hall', 'entry');
        await tick();
        // (the room left, its plate and its crew are what is drawn; the next room's model and art are both on their way)
        let shown = drawn(stage)!;
        expect(shown.scene).not.toBe(stage.scene);
        expect(shown.camera).toBe(first.camera);
        expect(shown.scene.background).toBe(plate);
        for (const g of crew) expect(shown.scene.children).toContain(g);
        expect(shown.scene.children).toContain(first.root);
        expect(stage.artState()).toMatchObject({ screen: 'hall', held: true });
        expect([rooms.has('hall.glb'), plates.has('hall.png')]).toEqual([true, true]);
        // (the model is in, but the frame still holds: nothing is picked in a room the player can't see, nor in the one held)
        const hall = await hallModel();
        rooms.get('hall.glb')!(hall);
        await stage.ready;
        expect(stage.room).toBe(hall);
        const floor = ndcOf(stage, new Vector3(2, 0, 3));
        expect([stage.holding, stage.pick(floor), stage.hover(floor)]).toEqual([true, null, null]);
        expect(drawn(stage)!.scene.background).toBe(plate);
        expect(plateFreed).not.toHaveBeenCalled();
        // (the art is in: room, plate and crew are swapped at once, and the room left is freed)
        const next = plates.get('hall.png')!();
        await stage.artDone;
        shown = drawn(stage)!;
        expect(shown.scene).toBe(stage.scene);
        expect(shown.camera).toBe(hall.camera);
        expect(stage.scene.background).toBe(next);
        expect(stage.actorIds()).toEqual(['picard', 'data']);
        for (const id of ['picard', 'data']) expect(stage.scene.children).toContain(actorOf(stage, id).group);
        expect(stage.artState()).toMatchObject({ screen: 'hall', plate: true, held: false });
        expect(plateFreed).toHaveBeenCalledOnce();
        expect(stage.pick(floor)?.kind).toBe('floor');
      });

      it('a newer screen change cancels the pending swap', async () => {
        const { world, stage, rooms, plates, plate } = await gated();
        changeScreen(world, 'hall', 'entry');
        await tick();
        const hall = await hallModel();
        const hallGeometry = vi.spyOn([...hall.regions.values()][0]!.mesh.geometry, 'dispose');
        const resolveHallRoom = rooms.get('hall.glb')!;
        const resolveHallPlate = plates.get('hall.png')!;
        changeScreen(world, 'room', 'door');
        await tick();
        // (what the cancelled change loads is freed as it arrives, and never shown)
        resolveHallRoom(hall);
        const late = resolveHallPlate();
        const lateFreed = vi.spyOn(late, 'dispose');
        await tick();
        await tick();
        expect(hallGeometry).toHaveBeenCalled();
        expect(lateFreed).toHaveBeenCalledOnce();
        expect(drawn(stage)!.scene.background).toBe(plate);
        expect(stage.artState().held).toBe(true);
        // (the latest change's room and art swap in)
        const back = await parseRoom(bytes(greyboxGlb(roomModel)));
        rooms.get('room.glb')!(back);
        const again = plates.get('room.png')!();
        await stage.artDone;
        expect(drawn(stage)!.scene).toBe(stage.scene);
        expect(stage.room).toBe(back);
        expect(stage.scene.background).toBe(again);
      });

      /** Holds a change to the hall with its model in and its art still coming, on fake timers; `limit` is the hold's limit to expect. */
      const atLimit = async (limit: number, over: Partial<StageOptions> = {}) => {
        const ctx = await gated(over);
        const hall = await hallModel();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          changeScreen(ctx.world, 'hall', 'entry');
          ctx.rooms.get('hall.glb')!(hall);
          await ctx.stage.ready;
          vi.advanceTimersByTime(limit - 1);
          expect(ctx.stage.holding).toBe(true);
          expect(drawn(ctx.stage)!.scene.background).toBe(ctx.plate);
          vi.advanceTimersByTime(1);
          expect(ctx.stage.holding).toBe(false);
        } finally {
          vi.useRealTimers();
        }
        return { ...ctx, hall };
      };

      it("the hold's limit counts from the change, not from a later screen change or attach", async () => {
        const ctx = await gated({ holdMs: 30 });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          changeScreen(ctx.world, 'hall', 'entry');
          vi.advanceTimersByTime(20);
          // (a newer change while the frame is held keeps the frame, and its clock)
          changeScreen(ctx.world, 'room', 'door');
          ctx.rooms.get('room.glb')!(await parseRoom(bytes(greyboxGlb(roomModel))));
          await ctx.stage.ready;
          vi.advanceTimersByTime(9);
          expect(ctx.stage.holding).toBe(true);
          vi.advanceTimersByTime(1);
          expect(ctx.stage.holding).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('a room model that never loads keeps the picture held past the limit, but input no longer waits on it', async () => {
        const ctx = await gated({ holdMs: 30 });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          changeScreen(ctx.world, 'hall', 'entry');
          expect([ctx.stage.holding, ctx.stage.inputHeld]).toEqual([true, true]);
          vi.advanceTimersByTime(30);
          // (hall.glb never comes: the room left stays drawn, nothing is picked, and presses go through)
          expect([ctx.stage.holding, ctx.stage.inputHeld]).toEqual([true, false]);
          expect(drawn(ctx.stage)!.scene.background).toBe(ctx.plate);
          expect(ctx.stage.pick({ x: 0, y: 0 })).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it('a held frame with no world to swap to goes at the limit (a load whose build throws), and input works again', async () => {
        const { stage, plate } = await gated({ holdMs: 30 });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          stage.detach(true);
          expect([stage.holding, drawn(stage)!.scene.background === plate]).toEqual([true, true]);
          vi.advanceTimersByTime(29);
          expect(stage.holding).toBe(true);
          vi.advanceTimersByTime(1);
          expect(stage.holding).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it("swaps at the hold's limit with what has come, and the art pops in after; artDone waits for it", async () => {
        const { stage, plates, plate, hall } = await atLimit(30, { holdMs: 30 });
        let done = false;
        void stage.artDone.then(() => { done = true; });
        // (past the limit: the next room, without its plate yet, and it takes clicks)
        expect(drawn(stage)).toEqual({ scene: stage.scene, camera: hall.camera });
        expect(stage.scene.background).not.toBe(plate);
        expect(stage.artState()).toMatchObject({ held: false, plate: false });
        expect(stage.pick(ndcOf(stage, new Vector3(2, 0, 3)))?.kind).toBe('floor');
        await tick();
        expect(done).toBe(false);
        const next = plates.get('hall.png')!();
        await stage.artDone;
        expect(stage.scene.background).toBe(next);
      });

      it('holds 1.5 s at most by default', async () => {
        await atLimit(1500);
      });

      it('with art off the swap waits only for the room', async () => {
        const { world, stage, rooms, plates } = await gated({ artOff: true });
        expect(plates.size).toBe(0);
        changeScreen(world, 'hall', 'entry');
        await tick();
        expect(stage.artState().held).toBe(true);
        const hall = await hallModel();
        rooms.get('hall.glb')!(hall);
        await stage.ready;
        expect(drawn(stage)).toEqual({ scene: stage.scene, camera: hall.camera });
        expect(plates.size).toBe(0);
        await expect(stage.artDone).resolves.toBeUndefined();
      });

      it('a load holds the frame on show the same way, until the loaded screen is ready', async () => {
        const { world, stage, rooms, plates, plate } = await gated();
        stage.detach(true);
        const attached = stage.attach(world);
        await tick();
        expect(drawn(stage)!.scene.background).toBe(plate);
        rooms.get('room.glb')!(await parseRoom(bytes(greyboxGlb(roomModel))));
        await attached;
        expect(drawn(stage)!.scene.background).toBe(plate);
        const again = plates.get('room.png')!();
        await stage.artDone;
        expect(drawn(stage)!.scene).toBe(stage.scene);
        expect(stage.scene.background).toBe(again);
      });

      it('a swap waits for the cards of the crew who arrive, and not for one that fails', async () => {
        const card: CardArt = { url: 'picard.png', frames: 1, anchor: [0.5, 1] };
        let failCard: (err: Error) => void = () => {};
        const textures: ArtLoaders = {
          texture: url => (url === 'picard.png' ? new Promise((_, reject) => { failCard = reject; }) : Promise.resolve(new Texture())),
          model: async () => new Object3D(),
        };
        const { stage, attached } = await setup({ art: { art: { room: () => ({ plate: 'p.png' }), card: id => (id === 'picard' ? card : undefined) }, artLoaders: textures } });
        await attached;
        await tick();
        await tick();
        expect(stage.artState().held).toBe(true);
        failCard(new Error('404'));
        await stage.artDone;
        expect(stage.artState().held).toBe(false);
      });
    });

    describe('masks (R9)', () => {
      const card: CardArt = { url: 'picard.png', frames: 1, anchor: [0.5, 1] };
      /** The pixel row a world point is drawn on in the original's 640x480. */
      const rowOf = (stage: Stage, p: Vector3): number => ((1 - p.clone().project(stage.room!.camera).y) / 2) * 480;
      const pixelOf = (stage: Stage, p: Vector3): { x: number; y: number } => {
        const v = p.clone().project(stage.room!.camera);
        return { x: ((v.x + 1) / 2) * 640, y: ((1 - v.y) / 2) * 480 };
      };
      const withMasks = async (masks: (card: number) => MaskUrl[], over: Partial<StageOptions> = {}) => {
        const made: Texture[] = [];
        const probe = await setup();
        await probe.attached;
        // (the row Picard stands on, from a stage with no art)
        const picardRow = rowOf(probe.stage, actorOf(probe.stage, 'picard').group.position);
        const loaders: ArtLoaders = {
          texture: async () => {
            const t = new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement);
            made.push(t);
            return t;
          },
          model: async () => new Object3D(),
        };
        const urls = { plate: 'p.png', masks: masks(picardRow) };
        const s = await setup({ art: { art: { room: (id: string) => (id === 'room' ? urls : undefined), card: (id: string) => (id === 'picard' ? card : undefined) }, artLoaders: loaders, ...over } });
        await s.attached;
        await tick();
        return { ...s, made, picardRow };
      };
      const maskOf = (stage: Stage, object: string) => stage.scene.getObjectByName(`mask:${object}`) as Mesh | undefined;
      /** Three draws transparent things far to near, by the depth of each one's origin: the nearer one is drawn over. */
      const drawsOver = (stage: Stage, over: Object3D, under: Object3D): boolean => {
        stage.scene.updateMatrixWorld(true);
        const z = (o: Object3D) => o.getWorldPosition(new Vector3()).project(stage.room!.camera).z;
        return z(over) < z(under);
      };

      it('a mask quad projects onto its original rect within 1 px', async () => {
        const rect: [number, number, number, number] = [120, 260, 90, 70];
        const { stage, picardRow } = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect, depth: row + 15 }]);
        const quad = maskOf(stage, 'panel')!;
        expect(quad).toBeDefined();
        expect(stage.artState().masks).toEqual(['panel']);
        stage.scene.updateMatrixWorld(true);
        const position = quad.geometry.getAttribute('position');
        const px = [0, 1, 2, 3].map(i => pixelOf(stage, new Vector3().fromBufferAttribute(position, i).applyMatrix4(quad.matrixWorld)));
        const [x, y, w, h] = rect;
        const want = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        px.forEach((p, i) => {
          expect(Math.abs(p.x - want[i]![0]!)).toBeLessThan(1);
          expect(Math.abs(p.y - want[i]![1]!)).toBeLessThan(1);
        });
        // (it stands on the floor, on the depth row)
        expect(quad.position.y).toBeCloseTo(0, 3);
        expect(rowOf(stage, quad.position)).toBeCloseTo(picardRow + 15, 3);
      });

      it('keeps one quad for an object listed twice, the later entry, and says so (an untracked one would be drawn in every room after)', async () => {
        const warned: string[] = [];
        const { stage } = await withMasks(row => [
          { object: 'panel', url: 'cut.webp', rect: [100, 200, 120, 100], depth: row },
          { object: 'panel', url: 'card.webp', rect: [100, 200, 120, 100], depth: row, card: true },
        ], { warn: m => warned.push(m) });
        await stage.artDone;
        expect(stage.scene.children.filter(c => c.name === 'mask:panel')).toHaveLength(1);
        expect(stage.artState().masks).toEqual(['panel']);
        expect(warned.some(m => m.includes('panel'))).toBe(true);
      });

      it('a card standing behind the mask\'s floor point is hidden by it; one in front is not', async () => {
        const behind = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [100, 200, 120, 100], depth: row + 25 }]);
        const sprite = actorOf(behind.stage, 'picard').card!;
        expect(sprite).toBeInstanceOf(Sprite);
        // (the mask stands nearer the camera than the card does: it is drawn over it)
        expect(drawsOver(behind.stage, maskOf(behind.stage, 'panel')!, sprite)).toBe(true);
        const front = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [100, 200, 120, 100], depth: row - 25 }]);
        expect(drawsOver(front.stage, maskOf(front.stage, 'panel')!, actorOf(front.stage, 'picard').card!)).toBe(false);
        // (and the mask is the transparent, depth-free kind, so that order is all there is)
        const material = maskOf(front.stage, 'panel')!.material as Material;
        expect([material.transparent, material.depthTest, material.depthWrite]).toEqual([true, false, false]);
      });

      it('walking past the mask\'s row flips the order', async () => {
        const { stage, picardRow } = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [100, 200, 120, 100], depth: row }]);
        const picard = actorOf(stage, 'picard');
        const quad = maskOf(stage, 'panel')!;
        const at = picard.group.position.clone();
        picard.group.position.z = at.z + 1;
        expect(rowOf(stage, picard.group.position)).toBeGreaterThan(picardRow);
        expect(drawsOver(stage, quad, picard.card!)).toBe(false);
        picard.group.position.z = at.z - 1;
        expect(drawsOver(stage, quad, picard.card!)).toBe(true);
      });

      it("hides a crew member's name tag while its card is fully behind a mask, and shows it again when it isn't", async () => {
        const labelOf = (s: { stage: Stage; labels: HTMLElement }) => {
          Object.defineProperty(s.labels, 'clientWidth', { value: 640, configurable: true });
          Object.defineProperty(s.labels, 'clientHeight', { value: 480, configurable: true });
          s.stage.frame(0);
          return actorOf(s.stage, 'picard').label!;
        };
        // (a mask over the whole screen, opaque, in front of Picard: his card and tag are hidden)
        const hidden = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 640, 480], depth: row + 20 }], {
          artLoaders: { texture: async () => new Texture({ width: 640, height: 480 } as unknown as HTMLImageElement), model: async () => new Object3D(), alpha: (_t, w, h) => new Uint8Array(w * h).fill(255) },
        });
        expect(labelOf(hidden).style.visibility).toBe('hidden');
        // (the same mask sorted behind him: shown)
        const front = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 640, 480], depth: row - 20 }], {
          artLoaders: { texture: async () => new Texture({ width: 640, height: 480 } as unknown as HTMLImageElement), model: async () => new Object3D(), alpha: (_t, w, h) => new Uint8Array(w * h).fill(255) },
        });
        expect(labelOf(front).style.visibility).toBe('');
        // (a mask with a hole where he stands: only part of him is hidden, so the tag stays)
        const partly = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 640, 480], depth: row + 20 }], {
          artLoaders: { texture: async () => new Texture({ width: 640, height: 480 } as unknown as HTMLImageElement), model: async () => new Object3D(), alpha: (_t, w, h) => { const a = new Uint8Array(w * h).fill(255); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (y > 200 && y < 300) a[y * w + x] = 0; return a; } },
        });
        expect(labelOf(partly).style.visibility).toBe('');
        // (and with art off, never hidden)
        hidden.stage.setDebug({ art: false });
        expect(labelOf(hidden).style.visibility).toBe('');
      });

      it('mask quads are never picked, and art off hides them', async () => {
        const { stage } = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 640, 480], depth: row + 40 }]);
        const quad = maskOf(stage, 'panel')!;
        expect(quad.visible).toBe(true);
        // (it covers the whole view and a click still lands where it did without it)
        const bare = await setup();
        await bare.attached;
        for (const p of [new Vector3(10, 0.75, 0), new Vector3(2, 0, 3), new Vector3(0, 0.9, 0)]) {
          expect(stage.pick(ndcOf(stage, p))).toEqual(bare.stage.pick(ndcOf(bare.stage, p)));
        }
        stage.setDebug({ art: false });
        expect(quad.visible).toBe(false);
        stage.setDebug({ art: true });
        expect(quad.visible).toBe(true);
        // (an object that isn't here or is switched off takes its mask with it)
        stage.setDebug({ art: true });
        const world = (stage as unknown as { world: World }).world;
        expect(stage.artState().shown).toEqual(['panel']);
        world.state.objects.panel!.active = false;
        (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
        expect(quad.visible).toBe(false);
        expect(stage.artState().shown).toEqual([]);
      });

      it('a mask that fails to load is left out with a warning, and one sorted above the horizon (behind every actor, so nothing to draw) is left out', async () => {
        const first = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 10, 10], depth: row }], { artLoaders: { texture: async (u: string) => { if (u === 'm.webp') throw new Error('404'); return new Texture(); }, model: async () => new Object3D() } });
        expect(maskOf(first.stage, 'panel')).toBeUndefined();
        expect(first.warnings.some(m => m.includes('mask of panel'))).toBe(true);
        // (row 0 is above the horizon)
        const sky = await withMasks(() => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 10, 10], depth: 0 }]);
        expect(maskOf(sky.stage, 'panel')).toBeUndefined();
        expect(sky.warnings).toEqual([]);
      });

      it('frees mask textures and quads with the room', async () => {
        const { stage, made } = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [0, 0, 10, 10], depth: row + 5 }]);
        const quad = maskOf(stage, 'panel')!;
        const spies = made.map(t => vi.spyOn(t, 'dispose'));
        const geometry = vi.spyOn(quad.geometry, 'dispose');
        stage.detach();
        expect(spies.length).toBeGreaterThan(1);
        expect(spies.every(d => d.mock.calls.length >= 1)).toBe(true);
        expect(geometry).toHaveBeenCalledTimes(1);
        expect(maskOf(stage, 'panel')).toBeUndefined();
      });

      describe('animated layers (Batch 8)', () => {
        const strip = (n: number, over: Record<string, unknown> = {}) => ({ url: `s${n}.webp`, frames: 3, delays: [100, 100, 100], loop: false, rect: [100, 200, 40, 60] as [number, number, number, number], ...over });
        const door = (row: number): MaskUrl[] => [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60], depth: row + 5, card: true, anim: 0, strips: { 0: strip(0), 1: strip(1, { rect: [90, 180, 60, 80], loop: true, delays: [50, 50, 50] }) } }];
        const layerOf = (stage: Stage, anim: number) => stage.scene.getObjectByName(`layer:panel:${anim}`) as Mesh | undefined;
        const uvOf = (mesh: Mesh): number[] => [...(mesh.geometry.getAttribute('uv').array as Float32Array)];
        const worldOf = (stage: Stage) => (stage as unknown as { world: World }).world;

        it('draws the frame its object\'s animation is on at that time, and holds the last frame when the animation ends', async () => {
          const { stage, clock } = await withMasks(door);
          expect(stage.artState().layers).toEqual([{ object: 'panel', anim: 0, frame: 0, still: false }]);
          expect(layerOf(stage, 0)!.visible).toBe(true);
          // (the still is the fallback: it is not drawn while a frame is)
          expect(maskOf(stage, 'panel')!.visible).toBe(false);
          expect(uvOf(layerOf(stage, 0)!).slice(0, 2)).toEqual([0, 1]);
          await frames(stage, clock, 0.1);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 0, frame: 1 });
          expect(uvOf(layerOf(stage, 0)!)[0]).toBeCloseTo(1 / 3, 5);
          await frames(stage, clock, 0.3);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 0, frame: 2 });
          await frames(stage, clock, 5);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 0, frame: 2 });
        });

        it('switches to the strip of the animation a script plays, from its first frame, at that animation\'s own rectangle', async () => {
          const { stage, clock } = await withMasks(door);
          await frames(stage, clock, 0.3);
          worldOf(stage).state.objects.panel!.anim = 1;
          await frames(stage, clock, 0.1);
          // (the frame after it was set, the first frame of the new animation)
          expect(stage.artState().layers).toEqual([{ object: 'panel', anim: 1, frame: 0, still: false }]);
          expect(layerOf(stage, 0)!.visible).toBe(false);
          const quad = layerOf(stage, 1)!;
          expect(quad.visible).toBe(true);
          stage.scene.updateMatrixWorld(true);
          const position = quad.geometry.getAttribute('position');
          const px = [0, 1, 2, 3].map(i => pixelOf(stage, new Vector3().fromBufferAttribute(position, i).applyMatrix4(quad.matrixWorld)));
          const want = [[90, 180], [150, 180], [150, 260], [90, 260]];
          px.forEach((p, i) => {
            expect(Math.abs(p.x - want[i]![0]!)).toBeLessThan(1);
            expect(Math.abs(p.y - want[i]![1]!)).toBeLessThan(1);
          });
          // (a looping one goes round on its own length: 150 ms)
          await frames(stage, clock, 0.1);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1, frame: 2 });
          await frames(stage, clock, 0.2);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1, frame: 0 });
        });

        it('a character plays its talk animation while it replies and goes back to its idle one when the line ends (replyAnims)', async () => {
          const talker = (idle: number): MaskUrl[] => [{ ...door(0)[0]!, talk: { anim: 1, idle } }];
          const { stage, clock } = await withMasks(() => talker(0));
          await frames(stage, clock, 0.3);
          stage.speak('panel', true);
          stage.frame(0);
          // (from its first frame, at the talk animation's own rectangle)
          expect(stage.artState().layers).toEqual([{ object: 'panel', anim: 1, frame: 0, still: false }]);
          expect(layerOf(stage, 1)!.visible).toBe(true);
          await frames(stage, clock, 0.2);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1, frame: 1 });
          stage.speak('panel', false);
          stage.frame(0);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 0, frame: 0 });
          // (the object's own state is not touched: a script that plays another animation still takes the layer)
          expect(worldOf(stage).state.objects.panel!.anim).toBeUndefined();
        });

        it('a talker whose idle animation has no strip goes back to the one it started on, and one with no talk strip does not move', async () => {
          const { stage, clock } = await withMasks(() => [{ ...door(0)[0]!, talk: { anim: 1, idle: 7 } }]);
          stage.speak('panel', true);
          await frames(stage, clock, 0.1);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1 });
          stage.speak('panel', false);
          stage.frame(0);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 0 });
          const quiet = await withMasks(() => [{ ...door(0)[0]!, talk: { anim: 4, idle: 0 } }]);
          quiet.stage.speak('panel', true);
          await frames(quiet.stage, quiet.clock, 0.1);
          expect(quiet.stage.artState().layers[0]).toMatchObject({ anim: 0 });
        });

        it('a button\'s lit animation and the plain one played straight after, between two frames, still shows the lit one for a moment', async () => {
          const { stage, clock } = await withMasks(door);
          const state = worldOf(stage).state.objects.panel!;
          state.anim = 1;
          void stage.anim('panel', { play: 1 });
          state.anim = 0;
          void stage.anim('panel', { play: 0 });
          await frames(stage, clock, 0.1);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1 });
          await frames(stage, clock, 0.4);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 0 });
        });

        it('a play that waits lasts as long as the layer plays the animation, not a fixed time (waitForAnim)', async () => {
          const { stage, clock } = await withMasks(door);
          // (animation 1 loops: the original gives up on it after 30 s; animation 0 is three frames of 100 ms)
          let done = false;
          void stage.anim('panel', { play: 0, wait: true }).then(() => { done = true; });
          await frames(stage, clock, 0.2);
          expect(done).toBe(false);
          await frames(stage, clock, 0.2);
          expect(done).toBe(true);
          done = false;
          void stage.anim('panel', { play: 1, wait: true }).then(() => { done = true; });
          await frames(stage, clock, 20);
          expect(done).toBe(false);
          await frames(stage, clock, 11);
          expect(done).toBe(true);
          // (an animation with no strip waits the usual short time)
          done = false;
          void stage.anim('panel', { play: 5, wait: true }).then(() => { done = true; });
          await frames(stage, clock, 1);
          expect(done).toBe(true);
        });

        it('starts an animation again when a script plays the one it is on, and holds the frame it was on when a script stops it', async () => {
          const { stage, clock } = await withMasks(door);
          worldOf(stage).state.objects.panel!.anim = 1;
          await frames(stage, clock, 0.1);
          await stage.anim('panel', { play: 1 });
          stage.frame(0);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1, frame: 0 });
          await frames(stage, clock, 0.1);
          expect(stage.artState().layers[0]).toMatchObject({ anim: 1, frame: 2 });
          worldOf(stage).state.objects.panel!.anim = -1;
          await frames(stage, clock, 0.1);
          const held = stage.artState().layers[0]!;
          expect(held).toMatchObject({ anim: 1, still: false });
          await frames(stage, clock, 1);
          expect(stage.artState().layers[0]).toEqual(held);
        });

        it('ignores an animation the sprite has no strip of (SpritePlayer::startAnim), and so for one whose strip failed to load', async () => {
          const missing = await withMasks(door);
          await frames(missing.stage, missing.clock, 0.1);
          expect(missing.stage.artState().layers[0]).toMatchObject({ anim: 0, still: false });
          worldOf(missing.stage).state.objects.panel!.anim = 7;
          await frames(missing.stage, missing.clock, 0.1);
          // (it stays on the animation it was on, and does not fall back to the still)
          expect(missing.stage.artState().layers[0]).toMatchObject({ anim: 0, still: false });
          expect(maskOf(missing.stage, 'panel')!.visible).toBe(false);
          expect(layerOf(missing.stage, 0)!.visible).toBe(true);
          // (and a real one is followed as before)
          worldOf(missing.stage).state.objects.panel!.anim = 1;
          await frames(missing.stage, missing.clock, 0.1);
          expect(missing.stage.artState().layers[0]).toMatchObject({ anim: 1, still: false });
          worldOf(missing.stage).state.objects.panel!.anim = 7;
          await frames(missing.stage, missing.clock, 0.1);
          expect(missing.stage.artState().layers[0]).toMatchObject({ anim: 1, still: false });
          // (a strip file that fails: the layer is there without it, and says so)
          const failed = await withMasks(door, { artLoaders: { texture: async (u: string) => { if (u === 's1.webp') throw new Error('404'); return new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement); }, model: async () => new Object3D() } });
          expect(failed.warnings.some(m => m.includes('strip of panel, animation 1'))).toBe(true);
          worldOf(failed.stage).state.objects.panel!.anim = 1;
          await frames(failed.stage, failed.clock, 0.1);
          // (the strip is not in the layer, so the animation is one it does not have: the layer stays on animation 0)
          expect(failed.stage.artState().layers[0]).toMatchObject({ anim: 0, still: false });
          expect(maskOf(failed.stage, 'panel')!.visible).toBe(false);
          expect(layerOf(failed.stage, 1)).toBeUndefined();
        });

        it("measures a moved object from where it stood in the original's pixels, not from its lifted marker (an object that stood above the floor has none to speak of), and leaves one a rule has not moved alone", async () => {
          const corners = [{ x: 0, y: 0, scale: 256 }, { x: 639, y: 0, scale: 256 }, { x: 639, y: 479, scale: 256 }, { x: 0, y: 479, scale: 256 }];
          const metric: PixelMetric = { kind: 'flat', slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, floor: [{ region: 'deck', points: corners }] };
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 40, height: 60 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const urls = { plate: 'p.png', masks: [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60] as [number, number, number, number], depth: 260, card: true, home: [50, 60] as [number | null, number | null] }] };
          const { stage, world, attached } = await setup({ room: { pixelMetric: metric, regions: { bridge: false, deck: true } }, art: { art: { room: (id: string) => (id === 'room' ? urls : undefined), card: () => undefined }, artLoaders: loaders } });
          await attached;
          await tick();
          const quad = maskOf(stage, 'panel')!;
          const corner = (): { x: number; y: number } => {
            stage.scene.updateMatrixWorld(true);
            return pixelOf(stage, new Vector3().fromBufferAttribute(quad.geometry.getAttribute('position'), 0).applyMatrix4(quad.matrixWorld));
          };
          // (not moved: where it was published, though its marker is nowhere near pixel 50, 60)
          expect(Math.abs(corner().x - 100)).toBeLessThan(1);
          expect(Math.abs(corner().y - 200)).toBeLessThan(1);
          const projection = new Projection(metric);
          const to = { x: world.state.objects.panel!.pos.x + 1.2, z: world.state.objects.panel!.pos.z + 0.8 };
          const b = projection.toPixel(to);
          world.state.objects.panel!.pos = to;
          (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
          expect(stage.artState().moved.panel).toEqual([Math.round(b.x) - 50, Math.round(b.y) - 60]);
          expect(corner().x).toBeCloseTo(100 + Math.round(b.x) - 50, 0);
          expect(corner().y).toBeCloseTo(200 + Math.round(b.y) - 60, 0);
        });

        it('beaming a prop dissolves its layer and stands the sparkle on the object, where the original draws it', async () => {
          const corners = [{ x: 0, y: 0, scale: 256 }, { x: 639, y: 0, scale: 256 }, { x: 639, y: 479, scale: 256 }, { x: 0, y: 479, scale: 256 }];
          const metric: PixelMetric = { kind: 'flat', slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, floor: [{ region: 'deck', points: corners }] };
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 40, height: 60 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const urls = { plate: 'p.png', masks: [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60] as [number, number, number, number], depth: 260, card: true }] };
          const { stage, world, clock, attached } = await setup({ room: { pixelMetric: metric, regions: { bridge: false, deck: true } }, art: { art: { room: (id: string) => (id === 'room' ? urls : undefined), card: (id: string) => (id === 'beam_effect' ? sparkleCard() : undefined) }, artLoaders: loaders } });
          await attached;
          await tick();
          const quad = maskOf(stage, 'panel')!;
          let done = false;
          void stage.show({ kind: 'beam', objects: ['panel'], out: true, chodak: false }).then(() => { done = true; });
          await frames(stage, clock, 0.3);
          expect(dissolveLevel(quad)).toBe(6);
          const fx = stage.scene.getObjectByName('beam:panel') as Mesh;
          expect(fx.visible).toBe(true);
          // (its bottom middle is on the object's place)
          const at = new Projection(metric).toPixel(world.state.objects.panel!.pos);
          stage.scene.updateMatrixWorld(true);
          const position = fx.geometry.getAttribute('position');
          const foot = pixelOf(stage, new Vector3().fromBufferAttribute(position, 2).applyMatrix4(fx.matrixWorld));
          const footLeft = pixelOf(stage, new Vector3().fromBufferAttribute(position, 3).applyMatrix4(fx.matrixWorld));
          expect(Math.abs((foot.x + footLeft.x) / 2 - Math.round(at.x))).toBeLessThan(1.5);
          expect(Math.abs(foot.y - Math.round(at.y))).toBeLessThan(1.5);
          expect(Math.abs(foot.x - footLeft.x - 58)).toBeLessThan(1.5);
          await frames(stage, clock, 3);
          expect(done).toBe(true);
          // (out: the sim moves the object next; until then it stays hidden, and the sparkle is gone)
          expect(dissolveLevel(quad)).toBe(0);
          expect(stage.scene.getObjectByName('beam:panel')).toBeUndefined();
        });

        it('a phaser shot is drawn in the original\'s pixels from the shooter\'s muzzle to the sprite\'s aim point', async () => {
          const corners = [{ x: 0, y: 0, scale: 256 }, { x: 639, y: 0, scale: 256 }, { x: 639, y: 479, scale: 256 }, { x: 0, y: 479, scale: 256 }];
          const metric: PixelMetric = { kind: 'flat', slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, floor: [{ region: 'deck', points: corners }] };
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 40, height: 60 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const urls = { plate: 'p.png', masks: [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60] as [number, number, number, number], depth: 260, card: true, aim: [112, 225] as [number, number] }] };
          const colours = { beam: [205, 0, 0] as [number, number, number], beamEdge: [166, 0, 0] as [number, number, number], pulse: [165, 0, 0] as [number, number, number], pulseEdge: [167, 0, 0] as [number, number, number] };
          const muzzles = Array.from({ length: 120 }, () => ({ x: 20, y: 90, frame: 8 }));
          const { stage, world, clock, attached } = await setup({ room: { pixelMetric: metric, regions: { bridge: false, deck: true } }, art: { art: { room: (id: string) => (id === 'room' ? urls : undefined), card: () => undefined, phaser: () => ({ muzzles, crew: ['picard', 'riker'], colours }) }, artLoaders: loaders } });
          await attached;
          await tick();
          const picard = new Projection(metric).toPixel(world.state.objects.picard!.pos);
          let done = false;
          void stage.show({ kind: 'phaserShot', from: 'picard', to: 'panel' }).then(() => { done = true; });
          await frames(stage, clock, 0.1);
          const shot = stage.artState().shots[0]!;
          expect(shot).toMatchObject({ from: 'picard', to: 'panel', target: [112, 225] });
          // (the crew member's muzzle: 20 right of and 90 above its feet, at the floor's scale there)
          expect(shot.start[0]).toBeCloseTo(Math.round(picard.x) + 20, 0);
          expect(shot.start[1]).toBeCloseTo(Math.round(picard.y) - 90, 0);
          const core = stage.scene.getObjectByName('phaser:beam') as Mesh;
          expect(core.visible).toBe(true);
          expect((core.material as unknown as { color: { getHex(): number } }).color.getHex()).toBe(0xcd0000);
          await frames(stage, clock, 0.5);
          expect(done).toBe(true);
          expect(stage.artState().shots).toEqual([]);
          expect(stage.scene.getObjectByName('phaser:beam')).toBeUndefined();
        });

        it('moves with its object: a prop the rules put elsewhere is drawn at its new place, and back where it started when it returns', async () => {
          // (a flat screen: a pixel is the same distance everywhere, so the move is the same number of pixels at either end)
          const corners = [{ x: 0, y: 0, scale: 256 }, { x: 639, y: 0, scale: 256 }, { x: 639, y: 479, scale: 256 }, { x: 0, y: 479, scale: 256 }];
          const metric: PixelMetric = { kind: 'flat', slope: 0, horizonY: 0, meanScale: 256, topY: 0, metersPerPixel: 0.0125, floor: [{ region: 'deck', points: corners }] };
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 40, height: 60 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const urls = { plate: 'p.png', masks: [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60] as [number, number, number, number], depth: 260, card: true }] };
          const { stage, world, attached } = await setup({ room: { pixelMetric: metric, regions: { bridge: false, deck: true } }, art: { art: { room: (id: string) => (id === 'room' ? urls : undefined), card: () => undefined }, artLoaders: loaders } });
          await attached;
          await tick();
          const quad = maskOf(stage, 'panel')!;
          const corner = (): { x: number; y: number } => {
            stage.scene.updateMatrixWorld(true);
            return pixelOf(stage, new Vector3().fromBufferAttribute(quad.geometry.getAttribute('position'), 0).applyMatrix4(quad.matrixWorld));
          };
          const home = corner();
          expect(Math.abs(home.x - 100)).toBeLessThan(1);
          expect(Math.abs(home.y - 200)).toBeLessThan(1);
          const projection = new Projection(metric);
          const at = world.state.objects.panel!.pos;
          const to = { x: at.x + 1.2, z: at.z + 0.8 };
          const a = projection.toPixel(at);
          const b = projection.toPixel(to);
          world.state.objects.panel!.pos = to;
          (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
          const moved = corner();
          expect(moved.x - home.x).toBeCloseTo(Math.round(b.x) - Math.round(a.x), 0);
          expect(moved.y - home.y).toBeCloseTo(Math.round(b.y) - Math.round(a.y), 0);
          expect(Math.abs(moved.x - home.x)).toBeGreaterThan(50);
          // (and the order it is drawn in follows the row it stands on now)
          expect(quad.renderOrder).toBe(260 + Math.round(b.y) - Math.round(a.y));
          world.state.objects.panel!.pos = { ...at };
          (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
          expect(corner().x).toBeCloseTo(home.x, 3);
          expect(corner().y).toBeCloseTo(home.y, 3);
        });

        it('goes with its object, and with the art, whichever picture it is drawing', async () => {
          const { stage, clock } = await withMasks(door);
          const world = worldOf(stage);
          expect(stage.artState().shown).toEqual(['panel']);
          world.state.objects.panel!.active = false;
          (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
          await frames(stage, clock, 0.1);
          expect(stage.artState()).toMatchObject({ shown: [], layers: [] });
          expect([layerOf(stage, 0)!.visible, maskOf(stage, 'panel')!.visible]).toEqual([false, false]);
          world.state.objects.panel!.active = true;
          (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
          await frames(stage, clock, 0.1);
          expect(stage.artState().shown).toEqual(['panel']);
          expect(layerOf(stage, 0)!.visible).toBe(true);
          stage.setDebug({ art: false });
          await frames(stage, clock, 0.1);
          expect(stage.artState()).toMatchObject({ shown: [], layers: [] });
          expect(layerOf(stage, 0)!.visible).toBe(false);
          stage.setDebug({ art: true });
          await frames(stage, clock, 0.1);
          expect(layerOf(stage, 0)!.visible).toBe(true);
        });

        it('starts on the animation of the object\'s state in a save, not its own', async () => {
          // (a door a save left open: the room is entered with the object on animation 1)
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const urls = { plate: 'p.png', masks: door(300) };
          const s = await setup({ art: { art: { room: (id: string) => (id === 'room' ? urls : undefined), card: () => undefined }, artLoaders: loaders } });
          s.world.state.objects.panel!.anim = 1;
          await s.attached;
          await tick();
          expect(s.stage.artState().layers).toEqual([{ object: 'panel', anim: 1, frame: 0, still: false }]);
        });

        describe('streamed atlas strips (Batch 8c)', () => {
          // (pages big enough that streaming costs less than uploading them, as `layerMode` decides)
          // (one animation of 3 frames in 2 cells: the union cell is 160x240 pixels over [100, 200, 40, 60]; cell 0 is its left quarter's top half, 40x120 at (0, 0) of page 0,
          // cell 1 the bottom right half, 80x120 at (8, 8) of page 1; frames 0 and 2 are cell 0)
          const atlas = (n: number) => strip(n, { urls: ['a0.webp', 'a1.webp'], cell: [160, 240], pages: [[640, 1280], [1280, 1280]], of: [0, 1, 0], frames: 3, delays: [100, 100, 100], loop: true, cells: [[0, 0, 0, 40, 120, 0, 0], [1, 8, 8, 80, 120, 80, 120]] });
          /** Pages whose crops finish when the test says; and a surface that records what was drawn on it. */
          const streamed = async (over: Partial<StageOptions> = {}, make: (n: number) => ReturnType<typeof strip> = atlas, more: Record<number, ReturnType<typeof strip>> = {}, start = 0) => {
            const crops: { page: string; rect: number[]; open: boolean; settled: boolean; resolve(): void }[] = [];
            const drawn: { page: string; rect: number[] }[] = [];
            const surfaces: { w: number; h: number; texture: Texture; disposed: boolean }[] = [];
            const fetched: string[] = [];
            const loaders: ArtLoaders = {
              texture: async () => new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement),
              model: async () => new Object3D(),
              page: async (url: string) => {
                fetched.push(url);
                return {
                  bytes: 1000,
                  crop: (x: number, y: number, w: number, h: number) => new Promise(resolve => {
                    const c = { page: url, rect: [x, y, w, h], open: false, settled: false, resolve: () => { c.settled = true; c.open = true; resolve({ owner: c, close: () => { c.open = false; } } as never); } };
                    crops.push(c);
                  }),
                };
              },
              surface: (w: number, h: number) => {
                const s = { w, h, texture: new Texture(), disposed: false };
                surfaces.push(s);
                return { texture: s.texture, draw: (cell: unknown) => { const c = (cell as { owner: { page: string; rect: number[] } }).owner; drawn.push({ page: c.page, rect: c.rect }); }, dispose: () => { s.disposed = true; } };
              },
            };
            const made = await withMasks(row => [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60], depth: row + 5, card: true, anim: start, strips: { 0: make(0), ...more } }], { artLoaders: loaders, ...over });
            return { ...made, crops, drawn, surfaces, fetched };
          };
          const settle = async (n = 3) => { for (let i = 0; i < n; i++) await tick(); };
          const cornersOf = (stage: Stage, quad: Mesh): { x: number; y: number }[] => {
            stage.scene.updateMatrixWorld(true);
            const position = quad.geometry.getAttribute('position');
            return [0, 1, 2, 3].map(i => pixelOf(stage, new Vector3().fromBufferAttribute(position, i).applyMatrix4(quad.matrixWorld)));
          };
          const near = (p: { x: number; y: number }, x: number, y: number) => expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(1);

          it('draws the still until the first cell is decoded, then the cell on its own part of the union rectangle, from the layer\'s one texture', async () => {
            const { stage, clock, crops, drawn, surfaces } = await streamed();
            // (one texture the size of the largest cell: 80x120)
            expect(surfaces.map(s => [s.w, s.h])).toEqual([[80, 120]]);
            const quad = layerOf(stage, 0)!;
            expect((quad.material as unknown as { map: Texture }).map).toBe(surfaces[0]!.texture);
            stage.frame(0);
            expect(stage.artState().layers).toEqual([{ object: 'panel', anim: 0, frame: null, still: true }]);
            expect(maskOf(stage, 'panel')!.visible).toBe(true);
            expect(quad.visible).toBe(false);
            // (the current cell first, then the next: two decode at once)
            expect(crops.map(c => c.rect)).toEqual([[0, 0, 40, 120], [8, 8, 80, 120]]);
            crops[0]!.resolve();
            await settle();
            stage.frame(0);
            expect(stage.artState().layers).toEqual([{ object: 'panel', anim: 0, frame: 0, still: false }]);
            expect(maskOf(stage, 'panel')!.visible).toBe(false);
            expect(quad.visible).toBe(true);
            expect(drawn).toEqual([{ page: 'a0.webp', rect: [0, 0, 40, 120] }]);
            // (the top-left quarter of the union rectangle; the cell is the surface's top left 40x120 of 80x120)
            const c = cornersOf(stage, quad);
            near(c[0]!, 100, 200);
            near(c[2]!, 110, 230);
            expect([...quad.geometry.getAttribute('uv').array].slice(0, 2)).toEqual([0, 1]);
            expect(quad.geometry.getAttribute('uv').getX(1)).toBeCloseTo(0.5, 5);
            await frames(stage, clock, 0.1);
          });

          it('decodes the next frames ahead, holds the frame on screen when the next is late, and never draws nothing', async () => {
            const { stage, clock, crops, drawn } = await streamed();
            crops[0]!.resolve();
            await settle();
            stage.frame(0);
            // (the ring wants the current cell and the next two: cell 1, then cell 0 is already there)
            expect(crops.map(c => c.rect)).toEqual([[0, 0, 40, 120], [8, 8, 80, 120]]);
            // (100 ms on, frame 1 is up but its cell is not decoded: the layer holds cell 0, and says the frame is 1)
            await frames(stage, clock, 0.1);
            expect(stage.artState().layers).toEqual([{ object: 'panel', anim: 0, frame: 1, still: false }]);
            expect(drawn).toHaveLength(1);
            expect(layerOf(stage, 0)!.visible).toBe(true);
            near(cornersOf(stage, layerOf(stage, 0)!)[0]!, 100, 200);
            crops[1]!.resolve();
            await settle();
            stage.frame(0);
            expect(drawn).toEqual([{ page: 'a0.webp', rect: [0, 0, 40, 120] }, { page: 'a1.webp', rect: [8, 8, 80, 120] }]);
            const c = cornersOf(stage, layerOf(stage, 0)!);
            near(c[0]!, 120, 230);
            near(c[2]!, 140, 260);
          });

          it('closes the cells that leave the ring, and frees the cells, the texture and the pages with the room', async () => {
            const { stage, clock, crops, surfaces } = await streamed();
            crops[0]!.resolve();
            await settle();
            stage.frame(0);
            crops[1]!.resolve();
            await settle();
            expect(crops.filter(c => c.open)).toHaveLength(2);
            // (the object goes: nothing is played, nothing is kept decoded)
            worldOf(stage).state.objects.panel!.active = false;
            (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
            await frames(stage, clock, 0.1);
            expect(crops.filter(c => c.open)).toHaveLength(0);
            worldOf(stage).state.objects.panel!.active = true;
            (stage as unknown as { syncObject(id: string): void }).syncObject('panel');
            await frames(stage, clock, 0.1);
            await settle();
            // (it is asked for its frames again)
            crops.filter(c => !c.settled).forEach(c => c.resolve());
            await settle();
            expect(crops.some(c => c.open)).toBe(true);
            stage.detach();
            expect(crops.filter(c => c.open)).toHaveLength(0);
            expect(surfaces.every(s => s.disposed)).toBe(true);
          });

          it('closes a cell that is decoded after the room is gone', async () => {
            const { stage, crops } = await streamed();
            stage.detach();
            crops[0]!.resolve();
            await settle();
            expect(crops[0]!.open).toBe(false);
          });

          it('draws nothing for a cell with nothing visible, and decodes none', async () => {
            const clear = (n: number) => strip(n, { urls: ['a0.webp'], cell: [160, 240], pages: [[640, 1280]], of: [0, 1], frames: 2, delays: [100, 100], loop: true, cells: [[0, 0, 0, 40, 120, 0, 0], [0, 0, 0, 0, 0, 0, 0]] });
            const made = await streamed({}, clear);
            made.crops[0]!.resolve();
            await settle();
            made.stage.frame(0);
            expect(layerOf(made.stage, 0)!.visible).toBe(true);
            await frames(made.stage, made.clock, 0.1);
            expect(layerOf(made.stage, 0)!.visible).toBe(false);
            expect(maskOf(made.stage, 'panel')!.visible).toBe(false);
            expect(made.crops).toHaveLength(1);
          });

          it('an animation of clear cells only has no pages, and draws nothing (a door that has gone from its frame), not the still', async () => {
            // (the layer's own atlas is anim 0; anim 1 is one clear cell with no page, and the layer starts on it)
            const gone = strip(1, { urls: [], cell: [160, 240], pages: [], of: [0], frames: 1, delays: [100], loop: false, cells: [[0, 0, 0, 0, 0, 0, 0]] });
            const made = await streamed({}, undefined, { 1: gone }, 1);
            made.stage.frame(0);
            await frames(made.stage, made.clock, 0.1);
            expect(made.stage.artState().layers).toEqual([{ object: 'panel', anim: 1, frame: 0, still: false }]);
            expect(maskOf(made.stage, 'panel')!.visible).toBe(false);
            expect(layerOf(made.stage, 0)!.visible).toBe(false);
            expect(layerOf(made.stage, 1)!.visible).toBe(false);
            expect(made.crops).toHaveLength(0);
          });
        });

        it('frees the strips\' quads with the room', async () => {
          const { stage } = await withMasks(door);
          const quad = layerOf(stage, 1)!;
          const geometry = vi.spyOn(quad.geometry, 'dispose');
          stage.detach();
          expect(geometry).toHaveBeenCalledTimes(1);
          expect(layerOf(stage, 1)).toBeUndefined();
        });
      });

      it('the hotspot view draws each hotspot\'s rect in screen space over the plate', async () => {
        const rected = await parseRoom(bytes(greyboxGlb({ ...roomModel, hotspots: [{ ...roomModel.hotspots[0]!, rect: [500, 120, 560, 200] }] })));
        const { stage } = await withMasks(() => [], { load: async () => rected });
        expect(stage.scene.getObjectByName('hotspot-rects')).toBeUndefined();
        stage.setDebug({ hotspots: true });
        const lines = stage.scene.getObjectByName('hotspot-rects') as LineSegments;
        expect(lines).toBeInstanceOf(LineSegments);
        const position = lines.geometry.getAttribute('position');
        // (panel's rect [500, 120, 560, 200]: its four edges, as segment ends)
        const px = [0, 2, 4, 6].map(i => pixelOf(stage, new Vector3().fromBufferAttribute(position, i).applyMatrix4(lines.matrixWorld)));
        const want = [[500, 120], [560, 120], [560, 200], [500, 200]];
        px.forEach((p, i) => {
          expect(Math.abs(p.x - want[i]![0]!)).toBeLessThan(1);
          expect(Math.abs(p.y - want[i]![1]!)).toBeLessThan(1);
        });
        expect((lines.material as Material).depthTest).toBe(false);
        expect(position.count).toBe(8);
        stage.setDebug({ hotspots: false });
        expect(stage.scene.getObjectByName('hotspot-rects')).toBeUndefined();
      });
    });

    describe('cards and glTF', () => {
      const metricFor = (scale: number): PixelMetric => ({
        kind: 'flat', slope: 0, horizonY: 0, meanScale: 200, topY: 0, metersPerPixel: 0.0125,
        floor: [{ region: 'deck', points: [{ x: 0, y: 0, scale }, { x: 639, y: 0, scale }, { x: 639, y: 479, scale }, { x: 0, y: 479, scale }] }],
      });
      const card: CardArt = { url: 'picard.png', frames: 2, anchor: [0.5, 1] };
      const withCards = (over: Partial<ArtLoaders> = {}, cards: Record<string, CardArt> = { picard: card }) => {
        const made: Texture[] = [];
        const byUrl = new Map<string, Texture>();
        const { art: a } = art({
          texture: async url => {
            const t = new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement);
            made.push(t);
            byUrl.set(url, t);
            return t;
          },
          ...over,
        });
        return { made, byUrl, art: { ...a, art: { ...a.art, card: (id: string) => cards[id] } } };
      };

      it('frees the card of a crew member who is not in the room the player has come to, and loads it again when they are', async () => {
        const made: Texture[] = [];
        const { art: a } = withCards({ texture: async url => { const t = new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement); if (url === 'picard.png') made.push(t); return t; } });
        const top = { pixelMetric: metricFor(100), regions: { bridge: false, deck: true } };
        const { stage, world, attached } = await setup({ art: a, room: top });
        await attached;
        await tick();
        expect(made).toHaveLength(1);
        const freed: Texture[] = [];
        made[0]!.addEventListener('dispose', () => freed.push(made[0]!));
        // (picard stays behind when the player goes on: the next room has none of his)
        world.obj('picard').screen = 'elsewhere';
        world.bus.emit({ type: 'screenChanged', screen: 'room' });
        await tick();
        await tick();
        expect(freed).toHaveLength(1);
        expect(stage.artState().cards).toEqual([]);
        world.obj('picard').screen = 'room';
        world.bus.emit({ type: 'objectChanged', id: 'picard' });
        await tick();
        await tick();
        expect(made).toHaveLength(2);
        expect(stage.artState().cards).toEqual(['picard']);
      });

      it('beaming a crew member with a card dissolves the card and draws the sparkle in front of it, and takes the sparkle away at the end', async () => {
        const { art: a } = withCards({}, { picard: card, beam_effect: sparkleCard() });
        const top = { pixelMetric: metricFor(100), regions: { bridge: false, deck: true } };
        const { stage, clock, attached } = await setup({ art: a, room: top });
        await attached;
        await tick();
        const picard = actorOf(stage, 'picard');
        expect(picard.card).not.toBeNull();
        expect(dissolveLevel(picard.card!)).toBe(-1);
        let done = false;
        void stage.show({ kind: 'beam', objects: ['picard'], out: false, chodak: false }).then(() => { done = true; });
        await frames(stage, clock, 0.4);
        // (hidden while the sparkle plays, with the sparkle's first frames up)
        expect(dissolveLevel(picard.card!)).toBe(0);
        const sparkle = picard.group.getObjectByName('beam-sparkle') as Sprite;
        expect(sparkle.visible).toBe(true);
        expect((sparkle.material.map as Texture).repeat.x).toBeCloseTo(1 / 13);
        // (58 x 176 of the original's pixels, standing on the actor's feet: the card's own pixel size here is 168 over ACTOR_HEIGHT)
        expect(sparkle.scale.y / sparkle.scale.x).toBeCloseTo(176 / 58);
        expect([sparkle.center.x, sparkle.center.y]).toEqual([0.5, 0]);
        await frames(stage, clock, 1.4);
        // (the dissolve: the second animation plays and the level climbs)
        expect(dissolveLevel(picard.card!)).toBeGreaterThan(0);
        expect((sparkle.material.map as Texture).repeat.x).toBeCloseTo(1 / 8);
        await frames(stage, clock, 2);
        expect(done).toBe(true);
        expect(dissolveLevel(picard.card!)).toBe(-1);
        expect(picard.group.getObjectByName('beam-sparkle')).toBeUndefined();
      });

      it('a card made while the beam-in is under way is dissolved from its first frame', async () => {
        const { art: a } = withCards({}, { picard: card });
        const top = { pixelMetric: metricFor(100), regions: { bridge: false, deck: true } };
        const { stage, world, attached } = await setup({ art: a, room: top });
        await attached;
        await tick();
        const picard = actorOf(stage, 'picard');
        picard.dissolve(3);
        // (the room reloads its cards: the new sprite has the dissolve already)
        picard.setCard(null);
        picard.setCard({ texture: new Texture({ width: 104, height: 158 } as unknown as HTMLImageElement), frames: 2, anchor: [0.5, 1] });
        expect(dissolveLevel(picard.card!)).toBe(3);
        void world;
      });

      it('a crew member with a card shows a sprite, still picks by the capsule, and scales with the floor', async () => {
        const base = await setup();
        await base.attached;
        const at = ndcOf(base.stage, new Vector3(0, 0.9, 0));
        const bare = base.stage.pick(at);
        const { byUrl, art: a } = withCards();
        const top = { pixelMetric: metricFor(100), regions: { bridge: false, deck: true } };
        const { stage, attached } = await setup({ art: a, room: top });
        await attached;
        await tick();
        const picard = actorOf(stage, 'picard');
        expect(picard.card).not.toBeNull();
        expect(picard.card!.material.map).toBe(byUrl.get('picard.png'));
        expect(stage.artState().cards).toEqual(['picard']);
        // (the capsule is only made invisible: it is still what a click hits)
        expect((picard.body.material as Material).visible).toBe(false);
        expect(picard.body.visible).toBe(true);
        expect(stage.pick(ndcOf(stage, new Vector3(0, 0.9, 0)))).toEqual(bare);
        expect(bare).toEqual({ kind: 'object', id: 'picard' });
        // (ACTOR_HEIGHT tall, a frame's aspect wide, on the group that carries the floor's scale)
        expect(picard.card!.scale.y).toBeCloseTo(1.8);
        expect(picard.card!.scale.x).toBeCloseTo((1.8 * 52) / 158);
        expect(picard.group.scale.y).toBeCloseTo(0.5);
        expect(actorOf(stage, 'data').card).toBeNull();
      });

      it('on a flat (top-down) screen, draws overlapping cards in the order of their foot rows, at the original\'s pixel height', async () => {
        const flat = await parseRoom(bytes(greyboxGlb({ ...roomModel, camera: { position: [5, 20, 5], yfov: 0.8, horizonY: 0, flat: { xmag: 8, ymag: 6 } } })));
        const pixelHeight = 150;
        const crewCard: CardArt = { ...card, pixelHeight };
        const { art: a } = withCards({}, { picard: crewCard, data: crewCard });
        const top = { pixelMetric: metricFor(100), regions: { bridge: false, deck: true } };
        const { stage, world, attached } = await setup({ art: a, room: top, load: async () => flat });
        await attached;
        await tick();
        expect(stage.room!.camera.type).toBe('OrthographicCamera');
        // (data stands a little lower on the screen than picard, overlapping: data is drawn in front)
        world.obj('picard').pos = { x: 2, z: 2.5 };
        world.obj('data').pos = { x: 2.1, z: 2 };
        for (const id of ['picard', 'data']) world.bus.emit({ type: 'objectChanged', id });
        const projection = new Projection(top.pixelMetric);
        const row = (id: string) => Math.round(projection.toPixel(world.obj(id).pos).y);
        expect(row('picard')).not.toBe(row('data'));
        for (const id of ['picard', 'data']) expect(actorOf(stage, id).card!.renderOrder).toBe(row(id));
        const [back, front] = row('picard') < row('data') ? ['picard', 'data'] : ['data', 'picard'];
        expect(actorOf(stage, front).card!.renderOrder).toBeGreaterThan(actorOf(stage, back).card!.renderOrder);
        // (pixelHeight original pixels at the floor's scale, 100/256 here: not ACTOR_HEIGHT's fallback)
        const camera = stage.room!.camera as unknown as { top: number; bottom: number; zoom: number };
        const picard = actorOf(stage, 'picard');
        const drawn = (picard.card!.scale.y * picard.group.scale.y * 480) / ((camera.top - camera.bottom) / camera.zoom);
        expect(drawn).toBeCloseTo((pixelHeight * 100) / 256, 3);
      });

      describe('animated cards (R8, R9)', () => {
        /** A card with every animation the stage asks for: a strip of `frames` cells of 200x680 (50x170 original pixels), the feet at (0.5, 0.9). */
        const animated = (): CardArt => {
          const a = (frames: number, over: Record<string, unknown> = {}) => ({ url: `strip${frames}.webp`, frames, cell: [200, 680] as [number, number], anchor: [0.5, 0.9] as [number, number], delays: Array.from({ length: frames }, () => 100), loop: true, ...over });
          const anims: NonNullable<CardArt['anims']> = {};
          for (let d = 0; d < 12; d++) anims[d] = { ...a(4), url: `walk${d}.webp` };
          for (let d = 24; d < 30; d++) anims[d] = { ...a(2, { loop: false, next: 78 }), url: `stand${d}.webp` };
          anims[78] = { ...a(3), url: 'idle.webp' };
          anims[0x1e] = { ...a(2, { loop: false, next: 0x1f }), url: 'talk.webp' };
          anims[0x1f] = { ...a(3), url: 'talking.webp' };
          anims[0x4d] = { ...a(2, { loop: false, next: 78 }), url: 'end.webp' };
          anims[0x25] = { ...a(2), url: 'talkright.webp' };
          anims[0x29] = { ...a(2, { loop: false, next: 0x24 }), url: 'turnright.webp' };
          anims[0x24] = { ...a(2), url: 'idleright.webp' };
          return { url: 'picard.png', frames: 1, anchor: [0.5, 1], pixelHeight: 168, anims };
        };
        const strips = new Map<string, Texture>();
        const open = async (over: Parameters<typeof setup>[0] = {}) => {
          strips.clear();
          const { art: a } = art({
            texture: async url => {
              const t = new Texture({ width: 800, height: 680 } as unknown as HTMLImageElement);
              strips.set(url, t);
              return t;
            },
          });
          const art2 = { ...a, art: { ...a.art, card: (id: string) => (id === 'picard' ? animated() : undefined) } };
          const s = await setup({ art: art2, ...over });
          await s.attached;
          await tick();
          // (the strips load as the player asks for them)
          await frames(s.stage, s.clock, 0.2);
          return s;
        };
        const mapOf = (stage: Stage) => (actorOf(stage, 'picard').card!.material.map as Texture & { image: unknown });
        const urlOf = (t: Texture | null) => [...strips].find(([, v]) => v === t)?.[0];

        const corners = [{ x: 0, y: 0, scale: 100 }, { x: 639, y: 0, scale: 100 }, { x: 639, y: 479, scale: 160 }, { x: 0, y: 479, scale: 160 }];
        const metric: PixelMetric = { kind: 'flat', slope: 0, horizonY: 0, meanScale: 200, topY: 0, metersPerPixel: 0.0125, floor: [{ region: 'deck', points: corners }] };
        const room = { pixelMetric: metric, regions: { bridge: false, deck: true } };

        it('with a memory budget, strips load as they are needed and the least recently used are freed to stay under it', async () => {
          const live = new Set<Texture>();
          const made: string[] = [];
          const { art: a } = art({
            texture: async url => {
              const t = new Texture({ width: 800, height: 680 } as unknown as HTMLImageElement);
              t.generateMipmaps = false;
              if (/\.webp$/.test(url)) {
                live.add(t);
                made.push(url);
                t.addEventListener('dispose', () => live.delete(t));
              }
              return t;
            },
          });
          // (a strip of 800x680 is 2.2 MB: the budget holds two)
          const art2 = { ...a, art: { ...a.art, card: (id: string) => (id === 'picard' ? animated() : undefined) }, stripBudget: 5 * 1048576 };
          const { stage, clock, attached, world } = await setup({ art: art2, room });
          await attached;
          await tick();
          await frames(stage, clock, 0.3);
          // (what the card plays now, not the card's twenty-nine strips)
          expect(made.length).toBeGreaterThan(0);
          expect(made.length).toBeLessThan(6);
          // (a walk to the other side, long enough to play several strips: older ones go once they have been idle for two seconds)
          world.obj('picard').pos = { x: 5, z: 5 };
          world.bus.emit({ type: 'objectChanged', id: 'picard' });
          void stage.walk('picard', { x: 0, z: 0 }, { x: 5, z: 5 }, new StopSignal());
          await frames(stage, clock, 6);
          expect(made.length).toBeGreaterThan(1);
          expect(live.size).toBeLessThan(made.length);
          expect(live.size).toBeLessThanOrEqual(3);
        });

        it('a crew member who fires plays the firing animation for that direction up to the muzzle frame, holds it while the beam is drawn and lets it go on after', async () => {
          const withFire = (): CardArt => {
            const card = animated();
            // (the seven animations a crew member fires with: six frames of 100 ms that fall into the idle one)
            for (const d of [0, 2, 5, 6, 7, 9, 10]) card.anims![12 + d] = { url: `fire${12 + d}.webp`, frames: 6, cell: [200, 680], anchor: [0.5, 0.9], delays: [100, 100, 100, 100, 100, 100], loop: false, next: 78 };
            return card;
          };
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 800, height: 680 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const colours = { beam: [205, 0, 0] as [number, number, number], beamEdge: [166, 0, 0] as [number, number, number], pulse: [165, 0, 0] as [number, number, number], pulseEdge: [167, 0, 0] as [number, number, number] };
          // (the muzzle of every direction shows on frame 3)
          const muzzles = Array.from({ length: 120 }, () => ({ x: 20, y: 90, frame: 3 }));
          const urls = { plate: 'p.png', masks: [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60] as [number, number, number, number], depth: 260, card: true, aim: [112, 225] as [number, number] }] };
          const { art: a } = art({ texture: async () => new Texture({ width: 800, height: 680 } as unknown as HTMLImageElement) });
          const art2 = { ...a, art: { ...a.art, room: (id: string) => (id === 'room' ? urls : undefined), card: (id: string) => (id === 'picard' ? withFire() : undefined), phaser: () => ({ muzzles, crew: ['picard', 'riker'], colours }) }, artLoaders: loaders };
          const { stage, world, clock, attached } = await setup({ art: art2, room });
          await attached;
          await tick();
          await frames(stage, clock, 0.2);
          const picard = actorOf(stage, 'picard');
          const feet = new Projection(metric).toPixel(world.state.objects.picard!.pos);
          const direction = muzzleDirection({ x: Math.round(feet.x), y: Math.round(feet.y) }, { x: 112, y: 225 });
          const fire = 12 + direction;
          let done = false;
          void stage.show({ kind: 'phaserShot', from: 'picard', to: 'panel' }).then(() => { done = true; });
          await frames(stage, clock, 0.05);
          expect(picard.player!.frame()).toMatchObject({ anim: fire });
          // (the beam waits for the muzzle frame, three frames of 100 ms in)
          expect(stage.artState().shots).toEqual([]);
          await frames(stage, clock, 0.4);
          expect(stage.artState().shots).toHaveLength(1);
          expect(picard.player!.frame()).toMatchObject({ anim: fire, index: 3 });
          // (held on it while the beam is drawn)
          await frames(stage, clock, 0.2);
          expect(picard.player!.frame()).toMatchObject({ anim: fire, index: 3 });
          await frames(stage, clock, 0.6);
          expect(done).toBe(true);
          expect(stage.artState().shots).toEqual([]);
          // (and it goes on from there: the last frames, then the idle animation it jumps to)
          expect(picard.player!.frame()!.anim === fire || picard.player!.frame()!.anim === 78).toBe(true);
          await frames(stage, clock, 1);
          expect(picard.player!.frame()).toMatchObject({ anim: 78 });
        });

        it('a card with no firing animation for that direction still shoots: the beam alone, at once', async () => {
          const loaders: ArtLoaders = { texture: async () => new Texture({ width: 800, height: 680 } as unknown as HTMLImageElement), model: async () => new Object3D() };
          const colours = { beam: [205, 0, 0] as [number, number, number], beamEdge: [166, 0, 0] as [number, number, number], pulse: [165, 0, 0] as [number, number, number], pulseEdge: [167, 0, 0] as [number, number, number] };
          const muzzles = Array.from({ length: 120 }, () => ({ x: 20, y: 90, frame: 3 }));
          const urls = { plate: 'p.png', masks: [{ object: 'panel', url: 'm.webp', rect: [100, 200, 40, 60] as [number, number, number, number], depth: 260, card: true, aim: [112, 225] as [number, number] }] };
          const { art: a } = art({ texture: async () => new Texture({ width: 800, height: 680 } as unknown as HTMLImageElement) });
          const art2 = { ...a, art: { ...a.art, room: (id: string) => (id === 'room' ? urls : undefined), card: (id: string) => (id === 'picard' ? animated() : undefined), phaser: () => ({ muzzles, crew: ['picard', 'riker'], colours }) }, artLoaders: loaders };
          const { stage, clock, attached } = await setup({ art: art2, room });
          await attached;
          await tick();
          await frames(stage, clock, 0.2);
          void stage.show({ kind: 'phaserShot', from: 'picard', to: 'panel' });
          await frames(stage, clock, 0.05);
          expect(stage.artState().shots).toHaveLength(1);
        });

        it("a card covers its sprite's original pixel rect within 1 px at two floor depths (pixelHeight, R9)", async () => {
          const { stage, world } = await open({ room });
          const picard = actorOf(stage, 'picard');
          const floor = new WalkFloor([corners]);
          const fit = new Projection(metric);
          const heights: number[] = [];
          for (const z of [-0.5, 4]) {
            picard.place({ x: 2, z });
            (stage as unknown as { placeActor(a: ActorView, p: Vec2): void }).placeActor(picard, { x: 2, z });
            stage.scene.updateMatrixWorld(true);
            const feet = pixelOf(stage, new Vector3(2, 0, z));
            const px = fit.toPixel({ x: 2, z });
            const scale = floor.scaleAt({ x: Math.round(px.x), y: Math.round(px.y) }) / 256;
            // (the cell is 50x170 original pixels at the floor's scale there: the card's top is 0.9 of it above the feet)
            const wantTop = feet.y - 0.9 * 170 * scale;
            const top = pixelOf(stage, new Vector3(2, picard.headHeight() * picard.group.scale.y, z));
            expect(Math.abs(top.y - wantTop)).toBeLessThan(1);
            heights.push(feet.y - top.y);
            // (and its width: 50 pixels at that scale, the feet in the middle)
            const half = (picard.card!.scale.x * picard.group.scale.x) / 2;
            const right = pixelOf(stage, new Vector3(2 + half, 0, z));
            expect(Math.abs(right.x - feet.x - 25 * scale)).toBeLessThan(1);
          }
          // (the two depths differ: the one nearer the camera is drawn larger)
          expect(heights[1]! / heights[0]!).toBeGreaterThan(1.05);
          void world;
        });

        it("each character's own height: a taller sprite's card is taller at the same spot", async () => {
          const { stage } = await open({ room });
          const picard = actorOf(stage, 'picard');
          const before = picard.headHeight();
          picard.setCard({ texture: new Texture({ width: 100, height: 200 } as unknown as HTMLImageElement), frames: 1, anchor: [0.5, 1], pixelHeight: 168 * 1.1 });
          expect(picard.headHeight()).toBeGreaterThan(before * 0.9 * 1.05 - 1e-9);
        });

        it("a walk updates the card's direction from screen-space velocity, and a stop stands that way", async () => {
          const { stage, clock, world } = await open();
          const picard = actorOf(stage, 'picard');
          // (standing toward the camera first: the stand, then the idle it falls into)
          expect(urlOf(mapOf(stage))).toBe('idle.webp');
          // (along +x the screen moves right: clock direction 3)
          void stage.walk('picard', { x: 0, z: 0 }, { x: 4, z: 0 }, new StopSignal());
          await frames(stage, clock, 0.5);
          expect(picard.lastDir).toBe(3);
          expect(urlOf(mapOf(stage))).toBe('walk3.webp');
          // (the screen motion of +z is toward the camera: down, 6; the walk back along -z is up, 0)
          await frames(stage, clock, 3);
          void stage.walk('picard', { x: 4, z: 0 }, { x: 4, z: 4 }, new StopSignal());
          await frames(stage, clock, 0.5);
          expect(picard.lastDir).toBe(6);
          expect(urlOf(mapOf(stage))).toBe('walk6.webp');
          await frames(stage, clock, 4);
          void stage.walk('picard', { x: 4, z: 4 }, { x: 4, z: 0 }, new StopSignal());
          await frames(stage, clock, 0.5);
          expect(picard.lastDir).toBe(0);
          for (let i = 0; i < 60 && picard.walker; i++) await frames(stage, clock, 0.1);
          // (stopped: the stand for that direction, 24 + 0, which then falls into the idle loop)
          expect(picard.walker).toBeNull();
          expect(urlOf(mapOf(stage))).toBe('stand24.webp');
          await frames(stage, clock, 0.5);
          expect(urlOf(mapOf(stage))).toBe('idle.webp');
          void world;
        });

        it("say() on a crew member plays their talk anim and returns to idle at the line's end", async () => {
          const { stage, clock } = await open();
          const picard = actorOf(stage, 'picard');
          stage.speak('picard', true);
          await frames(stage, clock, 0.1);
          expect(urlOf(mapOf(stage))).toBe('talk.webp');
          // (the talk anim falls into the speech loop)
          await frames(stage, clock, 0.5);
          expect(urlOf(mapOf(stage))).toBe('talking.webp');
          stage.speak('picard', false);
          await frames(stage, clock, 0.1);
          expect(urlOf(mapOf(stage))).toBe('end.webp');
          // (the end falls into idle)
          await frames(stage, clock, 0.6);
          expect(urlOf(mapOf(stage))).toBe('idle.webp');
          expect(picard.side).toBe('front');
        });

        it('a turn to a side plays the turn anim, and that side speaks its own talk', async () => {
          const { stage, clock, world } = await open();
          world.bus.emit({ type: 'turned', who: 'picard', side: 'right' });
          await frames(stage, clock, 0.1);
          expect(urlOf(mapOf(stage))).toBe('turnright.webp');
          await frames(stage, clock, 0.4);
          expect(urlOf(mapOf(stage))).toBe('idleright.webp');
          stage.speak('picard', true);
          await frames(stage, clock, 0.1);
          expect(urlOf(mapOf(stage))).toBe('talkright.webp');
        });
      });

      it('art off hides the glTF and the cards and shows the capsules', async () => {
        const { art: a } = withCards();
        const { stage, attached } = await setup({ art: a });
        await attached;
        await tick();
        const picard = actorOf(stage, 'picard');
        stage.setDebug({ art: false });
        expect(picard.card).toBeNull();
        expect((picard.body.material as Material).visible).toBe(true);
        expect(stage.artState().cards).toEqual([]);
        stage.setDebug({ art: true });
        expect(picard.card).not.toBeNull();
      });

      it('loads a card once, shares it, warns and keeps the capsule when it fails, and frees it on detach', async () => {
        const w = withCards();
        const { stage, attached } = await setup({ art: w.art });
        await attached;
        await tick();
        stage.setDebug({ art: false });
        stage.setDebug({ art: true });
        await tick();
        expect(w.made).toHaveLength(3);
        const disposed = vi.spyOn(w.made[2]!, 'dispose');
        stage.detach();
        expect(disposed).toHaveBeenCalledTimes(1);
        const bad = withCards({ texture: async (url: string) => { if (url === 'picard.png') throw new Error('404'); return new Texture(); } });
        const failed = await setup({ art: bad.art });
        await failed.attached;
        await tick();
        expect(actorOf(failed.stage, 'picard').card).toBeNull();
        expect(failed.warnings.some(m => m.includes("picard's card"))).toBe(true);
      });

      it('a glTF layer is added to the room, hides the greybox look, and its meshes are never what a click picks', async () => {
        const model = new Object3D();
        const box = new Mesh(new BoxGeometry(40, 40, 40), new MeshStandardMaterial());
        box.position.set(10, 0.75, 0);
        model.add(box);
        const { art: a } = art({ model: async () => model }, { gltf: 'room.glb' });
        const off = await setup({ art: { ...a, artOff: true } });
        const { stage, attached } = await setup({ art: a });
        await attached;
        await off.attached;
        await tick();
        expect(stage.artState()).toMatchObject({ model: true, on: true });
        expect(model.parent).toBe(stage.room!.root);
        expect(model.visible).toBe(true);
        for (const { visible, mesh } of meshes(stage).filter(m => m.mesh !== box)) {
          expect(visible).toBe(false);
          expect(mesh.visible).toBe(true);
        }
        // (the box sits on the panel and fills the view, and a click still lands on the panel's hotspot and on open floor)
        for (const p of [new Vector3(10, 0.75, 0), new Vector3(2, 0, 3)]) {
          expect(stage.pick(ndcOf(stage, p))).toEqual(off.stage.pick(ndcOf(off.stage, p)));
        }
        stage.setDebug({ art: false });
        expect(model.visible).toBe(false);
      });
    });
  });
});
