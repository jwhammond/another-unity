// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { battleContent, Clock, deserializeState, miniBattleDef, miniCombat, miniShipContent, miniTacticsCombat, normalizeSeed, parseGame, TICKS_PER_SECOND, type GameContent, type World } from '@another-unity/engine';
import { afterAll, describe, expect, it } from 'vitest';
import { readGameDir } from './readGameDir';
import { parseUint, parseWalk, runWalkthrough, WalkPresenter, type WalkEvent, type WalkIds, type WalkOptions } from './walkthrough';

const demo = fileURLToPath(new URL('../fixtures/demo', import.meta.url));

// (made-up original ids for the demo, in the shape ids.yaml gives the real game's)
const IDS: WalkIds = {
  objects: {
    '000000': 'picard', '000001': 'data', '010101': 'panel', '010102': 'door', '010201': 'chip', '010202': 'guard',
    '007001': 'tricorder', '007003': 'phaser',
  },
  screens: { s_0101: 'corridor', s_0102: 'lab' },
};

async function demoContent(): Promise<GameContent> {
  const content = parseGame(await readGameDir(demo));
  // (the demo's arrival marker, under the name a walkthrough's entrance 0 maps to)
  content.screens.corridor.markers.entrance_0 = { ...content.screens.corridor.markers.arrival };
  return content;
}

async function walk(text: string, extra: Partial<WalkOptions> = {}) {
  const events: WalkEvent[] = [];
  const result = await runWalkthrough(text, { content: await demoContent(), ids: IDS, seed: 42, onEvent: e => events.push(e), ...extra });
  return { ...result, events, log: result.play?.log ?? [] };
}

describe('parseWalk', () => {
  it('reads lines as ScummVM does: whole-line comments, blank lines, tokens on spaces and tabs', () => {
    expect(parseWalk('# a comment\n\n  look 000000\t010101  \nend\n')).toEqual([
      { line: 3, text: 'look 000000\t010101', args: ['look', '000000', '010101'] },
      { line: 4, text: 'end', args: ['end'] },
    ]);
    expect(['42', '0x2a', '010', '-1', '4294967296', '0x', ''].map(parseUint)).toEqual([42, 42, 10, null, null, null, null]);
  });
});

describe('runWalkthrough', () => {
  it('plays the demo\'s opening through Play, mapping the ids, as Plan 2\'s demo test does', async () => {
    const r = await walk([
      'seed 42',
      'start 1 1',
      'use 000000 010101 007001',
      'walk 000000 010102',
      'answer 0',
      'use 000001 010101 007001',
      'walk 000000 010102',
      'end',
    ].join('\n'));
    expect(r.error).toBeNull();
    expect(r.ended).toBe(true);
    expect(r.log).toContain('say picard: We need to understand it first.');
    expect(r.log).toContain('say picard: The door is sealed.');
    expect(r.play!.state.screen).toBe('lab');
    expect(r.events.filter(e => e.kind !== 'step')).toEqual([{ kind: 'seed', seed: 42 }, { kind: 'end' }]);
    expect(r.events.flatMap(e => (e.kind === 'step' ? [e.line] : []))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('stops at the first line it can\'t carry out, in the words ScummVM\'s runner uses', async () => {
    const bad = await walk('start 1 1\njump 000000 010101\nlook 000000 010101\nend');
    expect(bad.error).toBe('line 2 (jump 000000 010101): unknown step');
    expect(bad.events.at(-1)).toEqual({ kind: 'error', what: 'line 2 (jump 000000 010101): unknown step' });
    expect((await walk('start 1 1\nlook 000000 099999\nend')).error).toBe('line 2 (look 000000 099999): no such object');
    expect((await walk('look 000000 010101\nend')).error).toBe("line 1 (look 000000 010101): the away team isn't beamed down");
    expect((await walk('start 1 1\nadvance 3601\nend')).error).toBe('line 2 (advance 3601): an advance is at most 3600 seconds');
    expect((await walk('start 1 1\npick -1\nend')).error).toBe("line 2 (pick -1): a pick is a number or 'cancel'");
    expect((await walk('start 1 1\nanswer 2\nend')).error).toBe('line 2 (answer 2): an answer is 0 or 1');
    expect((await walk('start 1 1\nlook 000000 010101')).error).toBe("the walkthrough has no 'end'");
  });

  it('refuses what Play can\'t start the same way', async () => {
    expect((await walk('start 1 1 0x80\nend')).error)
      .toBe('line 1 (start 1 1 0x80): Play starts only on a plain entrance (no 0x40 gather or 0x80 step-in)');
    expect((await walk('start 1 1 0x40\nend')).error)
      .toBe('line 1 (start 1 1 0x40): Play starts only on a plain entrance (no 0x40 gather or 0x80 step-in)');
    // (0x10-0x3f carry no flag ScummVM reads: it places the team at the low four bits' entrance)
    expect((await walk('start 1 1 0x21\nend')).error)
      .toBe('line 1 (start 1 1 0x21): Play starts only on entrances 0-15 (ScummVM would place the team at entrance 1 and ignore 0x20)');
    expect((await walk('start 1 1 0x100\nend')).error).toBe('line 1 (start 1 1 0x100): an entrance is a byte (at most 0xff)');
    expect((await walk('start 1 9\nend')).error).toBe('line 1 (start 1 9): no such screen');
    expect((await walk('start 1 1\nstart 1 2\nend')).error).toMatch(/^line 2 \(start 1 2\): Play starts once/);
  });

  it('refuses a member who is down, as a click would, and goes on', async () => {
    const content = await demoContent();
    content.objects.data = { ...content.objects.data, phaser: { health: 10, threshold: 4, damageFrom: 1, gtpFrom: 4 } };
    const events: WalkEvent[] = [];
    const r = await runWalkthrough('start 1 1\nlook 000001 010101\nend', {
      content, ids: IDS, onEvent: e => events.push(e), onWorld: world => { world.state.phaser.data.health = 0; },
    });
    expect(r.error).toBeNull();
    expect(events).toContainEqual({ kind: 'refused', who: 'data' });
    expect(r.play!.log.join('\n')).not.toContain('An alien control panel. It is dark.');
  });

  it('turns off the triggers it is told to before the world starts, and lets the caller see the world first', async () => {
    const content = await demoContent();
    content.triggers = [...content.triggers, { id: 'tx', type: 'timer', context: 'away', target: 'panel', enabled: true, seconds: 1 }];
    let seen: boolean | null = null;
    const r = await runWalkthrough('start 1 1\nend', {
      content, ids: IDS, disableTriggers: ['tx'], onWorld: world => { seen = world.state.triggers.tx.enabled; },
    });
    expect(seen).toBe(false);
    expect(r.play!.state.triggers.tx.enabled).toBe(false);
  });

  it('reports a trigger to turn off that the game doesn\'t have, rather than ignoring it', async () => {
    const r = await walk('start 1 1\nend', { disableTriggers: ['nosuch'] });
    expect(r.error).toBe('line 1 (start 1 1): no trigger nosuch to turn off');
  });

  it('reseeds a world already started, on a seed after start', async () => {
    const r = await walk('start 1 1\nseed 7\nend');
    expect(r.error).toBeNull();
    expect(r.play!.state.rngSeed).toBe(normalizeSeed(7));
    expect(r.events).toContainEqual({ kind: 'seed', seed: normalizeSeed(7) });
  });

  it('moves the clock on by an advance\'s seconds', async () => {
    const still = await walk('start 1 1\nend');
    const moved = await walk('start 1 1\nadvance 2\nend');
    expect(moved.error).toBeNull();
    expect(moved.play!.state.tick - still.play!.state.tick).toBe(2 * TICKS_PER_SECOND);
  });

  it('rejects a pick past the menu\'s options, as ScummVM\'s walkthrough does', async () => {
    const p = new WalkPresenter(new Clock({ tick: 0 }));
    p.pick(5);
    await expect(p.menu(['a', 'b'])).rejects.toThrow('scripted pick 5 is out of range for a menu of 2');
  });

  it('asks before calling the ship, and calls only on Hail', async () => {
    const r = await walk('start 1 1\nanswer 1\ncombadge 000000\nanswer 0\ncombadge 000000\nend');
    expect(r.error).toBeNull();
    expect(r.log.filter(l => l === 'choose Do you wish to contact the ship?')).toHaveLength(2);
    expect(r.log.filter(l => l === 'say picard: Away team to bridge. Stand by.')).toHaveLength(1);
  });

  it('does nothing for a combadge that is off, without asking', async () => {
    const content = await demoContent();
    content.screens.corridor = { ...content.screens.corridor, startup: { ...content.screens.corridor.startup, combadge: false } };
    const r = await runWalkthrough('start 1 1\ncombadge 000000\nend', { content, ids: IDS, seed: 42 });
    expect(r.error).toBeNull();
    expect(r.play!.log).not.toContain('choose Do you wish to contact the ship?');
  });
});

describe('the ship in a walkthrough', () => {
  const ship = (text: string) => runWalkthrough(text, { content: miniShipContent(), ids: IDS, seed: 1 });

  it('opens the computer, clicks a row, and goes back to the bridge', async () => {
    const content = miniShipContent();
    content.ship!.computer.entries[0].subentries = [1, 2];
    content.ship!.computer.entries[1].subentries = [2];
    const r = await runWalkthrough('start ship\nstation computer\ncomputer 1\nstation bridge\nend', { content, ids: IDS, seed: 1 });
    expect(r.error).toBeNull();
    expect(r.ended).toBe(true);
    expect(r.play!.world.computer).toBeNull();
    expect(r.play!.state.ship.station).toBe('bridge');
    expect((await ship('start ship\ncomputer 1\nend')).error).toContain('not open');
    expect((await ship('start ship\nstation computer\ncomputer x\nend')).error).toContain('a number');
  });

  it('starts on the bridge and goes to astrogation and back', async () => {
    const r = await ship('start ship\nstation astrogation\nstation bridge\nend');
    expect(r.error).toBeNull();
    expect(r.ended).toBe(true);
    expect(r.play!.state.ship.station).toBe('bridge');
    expect(r.play!.state.onShip).toEqual({ gameOver: null });
  });

  it('plots and engages a course, and arrives on the sim clock', async () => {
    const r = await ship('start ship\nstation astrogation\nplot 1 0\nengage warp 300\nadvance 10\nadvance 60\nend');
    expect(r.error).toBeNull();
    const s = r.play!.state.ship;
    expect(s.transit).toBeNull();
    expect(s.location).toMatchObject({ sector: 1, star: 0 });
    expect(s.pos).toEqual({ x: 110, y: 90, z: 90 });
  });

  it('refuses to plot off astrogation, a bad course, and an engage with nothing plotted', async () => {
    expect((await ship('start ship\nplot 1 0\nend')).error).toContain('not at astrogation');
    expect((await ship('start ship\nstation astrogation\nplot 1 4\nend')).error).toContain('nothing there');
    expect((await ship('start ship\nstation astrogation\nengage warp 300\nend')).error).toContain('no course');
    expect((await ship('start ship\nstation astrogation\nplot 1 0\nengage warp 999\nend')).error).toContain('too fast');
  });

  it('refuses a station that does not exist, the viewscreen, or a station while the team is away', async () => {
    expect((await ship('start ship\nstation galley\nend')).error).toContain('no such station');
    expect((await ship('start ship\nstation viewscreen\nend')).error).toContain('no such station');
    expect((await runWalkthrough('start 1 1\nstation bridge\nend', { content: await demoContent(), ids: IDS })).error).toContain('away');
  });

  it('difficulty 0 then beam needs no step to energize', async () => {
    const content = miniShipContent();
    content.screens.hall.markers.entrance_0 = { x: 1, z: 1 };
    content.missions = [{ world: 'test', number: 1, screen: 'hall', entrance: 'entrance_0' }];
    content.ship!.data.transporter.targets = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    const target = (w: World) => { w.state.beamTarget = 'hall'; };
    const walk = (text: string) => runWalkthrough(text, { content, ids: IDS, seed: 1, onWorld: target });
    const easy = await walk('difficulty 0\nstart ship\nstation transporter\nadvance 1\nend');
    expect(easy.error).toBeNull();
    expect(easy.play!.world.difficulty).toBe(0);
    expect(easy.play!.state.onShip).toBeNull();
    expect(easy.play!.state.screen).toBe('hall');
    // (at the middle level the pads are ready, but someone has to energize)
    const middle = await walk('start ship\nstation transporter\nadvance 1\nend');
    expect(middle.play!.state.onShip).not.toBeNull();
    // (the setting can change aboard, and not while the team is away)
    const late = await walk('start ship\ndifficulty 0\nstation transporter\nadvance 1\nend');
    expect(late.play!.state.onShip).toBeNull();
    expect((await walk('start ship\ndifficulty 0\nstation transporter\nadvance 1\ndifficulty 2\nend')).error).toContain('no team is away');
    expect((await walk('difficulty 3\nend')).error).toContain('0, 1 or 2');
  });

  it('refuses start ship for a game with no ship, and a second start', async () => {
    expect((await runWalkthrough('start ship\nend', { content: await demoContent(), ids: IDS })).error).toContain('no ship');
    expect((await ship('start ship\nstart ship\nend')).error).toContain('once');
  });

  it('lands on the bridge when a Hail on an away screen runs a communicator script that goes to the ship (L15)', async () => {
    const content = miniShipContent();
    content.objects.communicator = {
      id: 'communicator', name: 'Communicator', screen: null, inventory: true,
      on: { use: [{ do: [{ screen: { to: '$ship' } }] }] },
    };
    content.rules = { items: { communicator: 'communicator' }, lines: {} };
    content.screens.room = { ...content.screens.room, startup: { ...content.screens.room.startup, combadge: true } };
    content.screens.room.markers.entrance_0 = { x: 0, z: 0 };
    const ids: WalkIds = { objects: { '000000': 'picard' }, screens: { s_0101: 'room' } };
    // (Ignore leaves the team away; Hail beams back)
    const ignore = await runWalkthrough('start 1 1\nanswer 1\ncombadge 000000\nend', { content, ids, seed: 1 });
    expect(ignore.error).toBeNull();
    expect(ignore.play!.state.onShip).toBeNull();
    const hail = await runWalkthrough('start 1 1\nanswer 0\ncombadge 000000\nadvance 5\nend', { content, ids, seed: 1 });
    expect(hail.error).toBeNull();
    expect(hail.play!.state.onShip).toEqual({ gameOver: null });
    expect(hail.play!.state.ship.station).toBe('bridge');
  });

  it('hails a contact with `comms`, and talks in the lounge with `lounge`', async () => {
    const content = miniShipContent();
    content.objects['w.planet'] = { ...content.objects['w.planet'], talk: 'Own talk.' };
    content.ship!.data.contacts = { comms: [{ object: 'w.planet', sprite: true }], lounge: ['w.planet'] };
    const ids: WalkIds = { objects: { '000000': 'picard', '100001': 'w.planet', '100002': 'w.ent' }, screens: {} };
    const r = await runWalkthrough('start ship\ncomms 100001\nlounge 100001\nend', { content, ids, seed: 1 });
    expect(r.error).toBeNull();
    expect(r.play!.log.filter(l => l.includes('Own talk.'))).toHaveLength(2);
    expect((await runWalkthrough('start ship\ncomms 100002\nend', { content, ids, seed: 1 })).error).toContain('not on the comms list');
    expect((await runWalkthrough('start ship\ncomms\nend', { content, ids, seed: 1 })).error).toContain('not empty');
    content.ship!.data.contacts = { comms: [], lounge: [] };
    const none = await runWalkthrough('start ship\ncomms\nlounge\nend', { content, ids, seed: 1 });
    expect(none.error).toBeNull();
    expect(none.play!.log.filter(l => l.includes('no response') || l.includes('empty'))).toHaveLength(2);
  });

  it('fights the default battle at tactical and wins it with `combat win`, then Exit runs on the bridge', async () => {
    const content = miniShipContent();
    content.objects['b.ent'] = { id: 'b.ent', name: 'Enterprise', screen: null };
    content.objects['b.rom'] = {
      id: 'b.rom', name: 'Romulan', screen: null,
      phaser: { health: 1, threshold: 0, damageFrom: 1, gtpFrom: 1, on: { kill: [{ do: [{ alter: { object: 'b.mark', state: 1 } }] }] } },
    };
    content.objects['b.mark'] = { id: 'b.mark', name: 'Mark', screen: null };
    content.objects['b.exit'] = { id: 'b.exit', name: 'Exit', screen: null, on: { use: [{ do: [{ alter: { object: 'b.mark', state: 2 } }] }] } };
    content.ship!.combat = miniCombat();
    content.ship!.combat.battles[8] = miniBattleDef({ exit: 'b.exit', ships: [['b.ent', 'enterprise'], ['b.rom', 'romulan']] });
    // (M4's dialog, which players fight until M8: Plan 23 R2)
    const opts = { content, ids: { objects: {}, screens: {} }, seed: 1, combat: 'dialog' as const };
    expect((await runWalkthrough('start ship\ncombat win\nend', opts)).error).toContain('not in combat');
    expect((await runWalkthrough('start ship\nstation tactical\ncombat dance\nend', opts)).error).toContain('win, flee, lose, answer, auto');
    expect((await runWalkthrough('start ship\nstation tactical\ncombat auto\nend', opts)).error).toContain('not in a battle the combat sim fights');
    const r = await runWalkthrough('start ship\nstation tactical\ncombat win\nadvance 1\nend', opts);
    expect(r.error).toBeNull();
    expect(r.play!.state.ship.combat).toBeNull();
    expect(r.play!.state.ship.station).toBe('bridge');
    // (the kill list ran, then Exit's USE)
    expect(r.play!.state.objects['b.mark'].state).toBe(2);
    expect(r.play!.state.objects['b.rom'].active).toBe(false);
  });

  it('fights a battle in the combat sim: input lines as orders, at a step, and auto-resolve to its end (spec §6; Plan 23)', async () => {
    const opts = { content: battleContent(), ids: { objects: {}, screens: {} }, seed: 1, onWorld: (w: World) => { w.hooks.register('rec', () => 0); } };
    let world: World | null = null;
    const r = await runWalkthrough('start ship\nstation tactical\ncombat set shields on\ncombat at 30 fire phasers\nadvance 1\nend', { ...opts, onWorld: w => { opts.onWorld(w); world = w; } });
    expect(r.error).toBeNull();
    const b = world!.battle!.b;
    // (the shields went up before the first frame; the phasers fired at step 30, which put the battle at a red alert)
    expect([b.console.shieldsRaised, b.steps >= 30, b.console.redAlert]).toEqual([true, true, true]);
    expect((await runWalkthrough('start ship\nstation tactical\ncombat at x fire phasers\nend', opts)).error).toContain('a step and an input line');
    expect((await runWalkthrough('start ship\nstation tactical\ncombat fire lasers\nend', opts)).error).toContain('an input line');
    // (the chodak out of range: auto-resolve stands down at once, and the Bridge button ends it, Exit on the bridge)
    const far = { ...opts, content: battleContent({ chodakAt: [0, 300000, 0] }) };
    const auto = await runWalkthrough('start ship\nstation tactical\ncombat auto\nadvance 1\nend', far);
    expect(auto.error).toBeNull();
    expect([auto.play!.state.ship.station, auto.play!.state.ship.combat, auto.play!.world.battle]).toEqual(['bridge', null, null]);
  });

  it('gives a `combat at <step>` order after exactly that step, at 1x and at 8x: it first shows in the next step (Plan 23)', async () => {
    const opts = { content: battleContent(), ids: { objects: {}, screens: {} }, seed: 1, onWorld: (w: World) => { w.hooks.register('rec', () => 0); } };
    for (const speed of [1, 8]) {
      const r = await runWalkthrough(`start ship\nassists game ${speed}\nstation tactical\ncombat at 31 set shields on\nend`, opts);
      expect(r.error).toBeNull();
      const run = r.play!.world.battle!;
      // (held at step 31, at 8x too, where a tick is about two steps: measured, unheld, 8x's frames end on even steps,
      // so step 31 would be passed; the order waits for the next frame)
      expect([run.b.steps, run.b.console.shieldsRaised, run.queue.length]).toEqual([31, false, 1]);
      const up: [number, boolean][] = [];
      run.ctx.onStep = b => { up.push([b.steps, b.console.shieldsRaised]); };
      expect(await r.play!.untilStep(33)).toBe(true);
      expect(up).toEqual([[32, true], [33, true]]);
    }
  });

  it('reads a combat input line as the walk line has it: doubled spaces and tabs are refused, as the input lines refuse them (Plan 22)', async () => {
    const opts = { content: battleContent(), ids: { objects: {}, screens: {} }, seed: 1, onWorld: (w: World) => { w.hooks.register('rec', () => 0); } };
    for (const line of ['combat  set shields on', 'combat set  shields on', 'combat set shields\ton', 'combat\tset shields on', 'combat at 30  set shields on', 'combat at 30\tset shields on']) {
      expect((await runWalkthrough(`start ship\nstation tactical\n${line}\nend`, opts)).error).toContain('an input line');
    }
    expect((await runWalkthrough('start ship\nstation tactical\ncombat set shields on\ncombat at 30 set shields off\nend', opts)).error).toBeNull();
  });

  describe('combat inputs (Plan 31 R5)', () => {
    const game = mkdtempSync(join(tmpdir(), 'walk-inputs-'));
    afterAll(() => rmSync(game, { recursive: true, force: true }));
    const inputs = (name: string, text: string) => {
      mkdirSync(join(game, 'tests/battles'), { recursive: true });
      writeFileSync(join(game, 'tests/battles', name), text);
    };
    const opts = (onWorld: (w: World) => void = () => {}): WalkOptions => ({
      content: battleContent(), ids: { objects: {}, screens: {} }, seed: 1, gameDir: game,
      onWorld: w => { w.hooks.register('rec', () => 0); onWorld(w); },
    });

    it('gives an inputs file\'s orders at their steps', async () => {
      inputs('ok.inputs', '# a tactic\nat 0 set shields on\nat 31 set shields off\n\nat 31 set lock on\nat 40 set shields on\n');
      const seen: [number, boolean, boolean][] = [];
      const r = await runWalkthrough('start ship\nstation tactical\ncombat inputs tests/battles/ok.inputs\nadvance 1\nend', opts(w => {
        w.bus.on(e => { if (e.type === 'combat' && e.on) w.battle!.ctx.onStep = b => { seen.push([b.steps, b.console.shieldsRaised, b.console.weaponsLock]); }; });
      }));
      expect(r.error).toBeNull();
      // (each order shows first in the step after its own, as `combat at` gives it)
      const at = (n: number) => seen.find(s => s[0] === n);
      expect([at(1), at(31), at(32), at(40), at(41)]).toEqual([[1, true, false], [31, true, false], [32, false, true], [40, false, true], [41, true, true]]);
    });

    it('refuses an inputs file with a bad line, naming the file and line', async () => {
      inputs('bad.inputs', 'at 5 set shields on\nat 6 jump\nat 4 stop\n');
      const r = await runWalkthrough('start ship\nstation tactical\ncombat inputs tests/battles/bad.inputs\nend', opts());
      expect(r.error).toBe('line 3 (combat inputs tests/battles/bad.inputs): tests/battles/bad.inputs: line 2: not a combat input: "jump"; tests/battles/bad.inputs: line 3: step 4 comes before step 5');
      // (nothing was given: the battle hasn't been run on to step 5)
      expect(r.play!.world.battle!.b.steps).toBeLessThan(5);
      expect((await runWalkthrough('start ship\nstation tactical\ncombat inputs tests/battles/none.inputs\nend', opts())).error).toContain('tests/battles/none.inputs: no such file');
    });
  });

  it('fails `combat auto` on a battle that doesn\'t stand down, unless the walk expects how it comes out, and reports it (Plan 23)', async () => {
    const onWorld = (w: World) => { w.hooks.register('rec', () => 0); };
    // (the fixture's battle 3 as tacticalAssists.test.ts' tacticsCombat(10): Delegate loses it, the Enterprise destroyed at step 2888)
    const combat = miniTacticsCombat();
    combat.battles[3]!.ships[1] = { ...combat.battles[3]!.ships[1]!, position: [2000, 9000, 0], strength: 10 };
    const lost = { content: battleContent({ combat }), ids: { objects: {}, screens: {} }, seed: 1, onWorld };
    const events: WalkEvent[] = [];
    const r = await runWalkthrough('start ship\nstation tactical\ncombat auto\nend', { ...lost, onEvent: e => { events.push(e); } });
    expect(r.error).toContain('combat auto): the battle came out lost at step 2888, where the walk expects stoodDown');
    expect(events.filter(e => e.kind === 'battle')).toEqual([{ kind: 'battle', outcome: 'lost', steps: 2888 }]);
    const expected = await runWalkthrough('start ship\nstation tactical\ncombat auto expect lost\nend', lost);
    expect(expected.error).toBeNull();
    expect(expected.play!.state.onShip).toEqual({ gameOver: 1 });
    // (the chodak out of range stands down: expecting another outcome fails, and an outcome must be one of the four)
    const far = { content: battleContent({ chodakAt: [0, 300000, 0] }), ids: { objects: {}, screens: {} }, seed: 1, onWorld };
    expect((await runWalkthrough('start ship\nstation tactical\ncombat auto expect left\nend', far)).error).toMatch(/came out stoodDown at step \d+, where the walk expects left$/);
    expect((await runWalkthrough('start ship\nstation tactical\ncombat auto expect stoodDown\nend', far)).error).toBeNull();
    expect((await runWalkthrough('start ship\nstation tactical\ncombat auto expect won\nend', far)).error).toContain('combat auto expects stoodDown, left, ended, lost');
  });

  describe('the reachable-target check and force', () => {
    it('refuses a use, get or talk on a target nobody could click', async () => {
      const off = (w: World) => { w.state.objects.panel.active = false; };
      const r = await walk('start 1 1\nuse 000000 010101\nend', { onWorld: off });
      expect(r.error).toContain('panel is inactive');
      expect((await walk('start 1 1\nget 000000 010101\nend', { onWorld: off })).error).toContain('panel is inactive');
      expect((await walk('start 1 1\ntalk 000000 010101\nend', { onWorld: off })).error).toContain('panel is inactive');
      // (looking and walking are not checks: ScummVM runs them remotely too)
      expect((await walk('start 1 1\nlook 000000 010101\nend', { onWorld: off })).error).toBeNull();
    });

    it('lets a use, get or talk after a gap comment opt out, and the step event says so', async () => {
      const off = (w: World) => { w.state.objects.panel.active = false; };
      const ok = await walk('start 1 1\n# gap: a ruled object gap\nuse 000000 010101\nend', { onWorld: off });
      expect(ok.error).toBeNull();
      expect(ok.events.filter(e => e.kind === 'step' && e.gap).map(e => (e as { text: string }).text)).toEqual(['use 000000 010101']);
      // (only the next line: the one after is checked again)
      const twice = await walk('start 1 1\n# gap: once\nuse 000000 010101\nuse 000000 010101\nend', { onWorld: off });
      expect(twice.error).toContain('line 4');
      expect(twice.error).toContain('panel is inactive');
    });

    it('checks another screen only when asked (the Plan 9 walks act remotely)', async () => {
      expect((await walk('start 1 1\nuse 000000 010202\nend')).error).toBeNull();
      expect((await walk('start 1 1\nuse 000000 010202\nend', { checkScreens: true })).error).toContain('not on the current screen');
    });
  });

  describe('include, checkpoint and trigger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'walk-'));
    const file = (name: string, text: string) => { writeFileSync(join(dir, name), text); return join(dir, name); };
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const inc = (text: string, extra: Partial<WalkOptions> = {}) =>
      runWalkthrough(text, { content: miniShipContent(), ids: IDS, seed: 1, file: join(dir, 'main.walk'), ...extra });

    it('runs another walk\'s steps after its seed and start lines, to its end, and carries on', async () => {
      file('leg.walk', 'seed 7\nstart ship\nstation astrogation\nend\nstation bridge\n');
      const events: WalkEvent[] = [];
      const r = await inc('seed 1\nstart ship\ninclude leg.walk\nstation engineering\nend', { onEvent: e => events.push(e) });
      expect(r.error).toBeNull();
      expect(r.ended).toBe(true);
      // (the included seed is skipped, its steps ran, and the line after its `end` did not)
      expect(events.filter(e => e.kind === 'seed')).toHaveLength(1);
      expect(events.some(e => e.kind === 'step' && e.text === 'station astrogation')).toBe(true);
      expect(events.some(e => e.kind === 'step' && e.text === 'station bridge')).toBe(false);
      expect(r.play!.state.ship.station).toBe('engineering');
    });

    it('resolves a path from the including file, nests, and says what it can not find', async () => {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'sub', 'inner.walk'), 'start ship\nstation engineering\nend\n');
      writeFileSync(join(dir, 'sub', 'outer.walk'), 'start ship\ninclude inner.walk\nend\n');
      const r = await inc('start ship\ninclude sub/outer.walk\nend');
      expect(r.error).toBeNull();
      expect(r.play!.state.ship.station).toBe('engineering');
      expect((await inc('start ship\ninclude nowhere.walk\nend')).error).toContain('include nowhere.walk: no such file');
    });

    it('refuses an include that starts on another screen than the game is on', async () => {
      file('away.walk', 'start 1 1 0\nend\n');
      const r = await inc('start ship\ninclude away.walk\nend', { ids: { objects: {}, screens: { s_0101: 'room' } } });
      expect(r.error).toBe('line 2 (include away.walk): include away.walk: starts on room, the game is on ship');
    });

    it('writes a checkpoint that deserializeState loads, only when there is a directory', async () => {
      const out = join(dir, 'cp');
      const r = await inc('start ship\nstation astrogation\ncheckpoint here\nend', { checkpointDir: out });
      expect(r.error).toBeNull();
      const content = miniShipContent();
      const state = deserializeState(readFileSync(join(out, 'here.json'), 'utf8'), content);
      expect(state.ship.station).toBe('astrogation');
      const none = await inc('start ship\ncheckpoint nowhere\nend');
      expect(none.error).toBeNull();
      expect(existsSync(join(out, 'nowhere.json'))).toBe(false);
      expect((await inc('start ship\ncheckpoint bad/name\nend')).error).toContain('a checkpoint name');
    });

    it('turns a checkpoint in a battle into a step error, not a crash (save.cpp:156-159)', async () => {
      let world: World | null = null;
      const r = await inc('start ship\ncheckpoint here\nend', {
        checkpointDir: join(dir, 'cp-combat'),
        onWorld: w => { world = w; },
        // (the battle starts just before the checkpoint step)
        onEvent: e => {
          if (e.kind === 'step' && e.text === 'checkpoint here') world!.state.ship.combat = { scenario: 8, enterprise: 'w.ent', enemies: [], friends: [], destroyed: [], warped: false, redAlert: true };
        },
      });
      expect(r.error).toBe("line 2 (checkpoint here): You can't save during combat.");
    });

    it('enables a trigger only after a gap comment', async () => {
      const bare = await inc('start ship\ntrigger 1 on\nend');
      expect(bare.error).toBe('line 2 (trigger 1 on): trigger without a gap comment');
      const ok = await inc('start ship\n# gap: nothing enables it, a dev shortcut\ntrigger 1 on\nend');
      expect(ok.error).toBeNull();
      expect(ok.play!.state.triggers.t1.enabled).toBe(true);
      const off = await inc('start ship\n# gap: a test\ntrigger 1 on\n# gap: and back\ntrigger 1 off\nend');
      expect(off.play!.state.triggers.t1.enabled).toBe(false);
      expect((await inc('start ship\n# gap: x\ntrigger 99 on\nend')).error).toContain('no such trigger');
      // (the comment belongs to the next step only)
      expect((await inc('start ship\n# gap: x\nstation bridge\ntrigger 1 on\nend')).error).toContain('without a gap comment');
    });
  });
});
