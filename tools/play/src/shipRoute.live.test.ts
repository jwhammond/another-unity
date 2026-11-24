// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGame } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { Play } from './play';
import { readGameDir } from './readGameDir';

// RAW_DIR=$HOME/pcode/unity-raw/runs/export/raw, after npm run unity:build (docs/unity-local.md)
const game = fileURLToPath(new URL('../../../games/unity', import.meta.url));
const lifted = !!process.env.RAW_DIR && existsSync(join(game, 'ids.yaml'));
if (!lifted) console.info('shipRoute.live.test.ts: skipped; set RAW_DIR and run npm run unity:build (docs/unity-local.md)');

describe.skipIf(!lifted)('the real ship route to the first beam-down', () => {
  it('plots the first mission, arrives, fires the proximity trigger, and its chain reaches the lab beam', async () => {
    const play = Play.newGame(parseGame(await readGameDir(game)), 1);
    const w = play.world;
    const fired: string[] = [];
    w.bus.on(e => { if (e.type === 'triggerFired') fired.push(e.id); });
    // the opening plays out on the bridge: five menus, then the sixth (the first mission's hail) at the end of the wait; each the second option
    for (let i = 0; i < 6; i++) play.pick(1);
    // (the battle hail comes all the same, a little before the wait's end: battle 16, which the combat sim fights from its
    // first frame (Plan 23), so the route leaves it at its start, at astrogation)
    await play.untilCombat(400);
    expect(w.state.ship.combat?.scenario).toBe(16);
    await play.station('astrogation');
    play.plot({ sector: 156, star: 3, planet: 3 });
    expect(await play.engage(true, 300)).toBeNull();
    // crew speak aboard with nobody on an away team
    expect(w.state.awayTeam).toEqual([]);
    await play.advance(450);
    expect(w.state.ship.transit).toBeNull();
    expect(fired).toContain('t64');
    expect(fired.indexOf('t64')).toBeGreaterThan(fired.indexOf('t74'));
    // the briefing's hails ran, and the chain set the beam target
    expect(w.state.pendingHail).toBeNull();
    expect(w.state.beamTarget).toBe('lab.s01');
    expect(w.state.onShip).toEqual({ gameOver: null });

    // the transporter room: the recommended team and kit, then the beam-down lands them on the lab's first screen
    await play.station('transporter');
    const room = w.transporter!;
    expect(room.target).toBe('lab.s01');
    expect(room.world).toBe(4);
    const items = w.content.rules.items;
    expect(room.kit).toEqual(expect.arrayContaining([items.phaser, items.tricorder]));
    expect(room.equipment).not.toContain(items.communicator);
    await play.beam();
    expect(w.state.onShip).toBeNull();
    expect(w.state.screen).toBe('lab.s01');
    expect(w.state.awayTeam.length).toBeGreaterThan(0);
    expect(w.state.awayTeam.length).toBeLessThanOrEqual(4);
    for (const id of w.state.awayTeam) expect(w.obj(id).screen).toBe('lab.s01');
    expect(w.state.awayTeam).toContain(w.state.currentActor);
    for (const id of room.kit) expect(w.obj(id).inventory).toBe(true);
    // the ship's clock keeps running while they are away (the original stops it only for a non-clock station)
    expect(w.state.ship.clockStopped).toBe(0);
  }, 60_000);
});
