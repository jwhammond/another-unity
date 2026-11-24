// SPDX-License-Identifier: GPL-3.0-or-later
import { miniShipContent, restoreTransporter, SHIP, type GameContent } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { Play } from './play';
import { runWalkthrough } from './walkthrough';

/** The mini ship with a beam-down to `hall`, as world 1. */
function content(): GameContent {
  const c = miniShipContent();
  c.screens.hall.markers.entrance_0 = { x: 1, z: 1 };
  c.missions = [{ world: 'test', number: 1, screen: 'hall', entrance: 'entrance_0' }];
  c.ship!.data.transporter.targets = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  return c;
}

describe('beaming down', () => {
  it('beams the recommended team down to the target', async () => {
    const play = Play.newGame(content(), 1);
    play.state.beamTarget = 'hall';
    await play.station('transporter');
    await play.beam();
    expect(play.state.onShip).toBeNull();
    expect(play.state.screen).toBe('hall');
    expect(play.state.awayTeam).toEqual(['picard', 'data']);
    expect(play.state.ship.clockStopped).toBe(0);
  });

  it('beams exactly the crew named', async () => {
    const play = Play.newGame(content(), 1);
    play.state.beamTarget = 'hall';
    await play.station('transporter');
    await play.beam(['data']);
    expect(play.state.awayTeam).toEqual(['data']);
    expect(play.state.currentActor).toBe('data');
  });

  it('comes back aboard with the captain acting, and the bridge talk is the captain\'s', async () => {
    const play = Play.newGame(content(), 1);
    play.state.beamTarget = 'hall';
    await play.station('transporter');
    await play.beam(['data']);
    expect(play.state.currentActor).toBe('data');
    const w = play.world;
    w.state.pendingScreen = { to: SHIP, entrance: 'entrance_0' };
    w.applyScreenChange();
    await play.advance(1);
    expect(w.state.onShip).not.toBeNull();
    expect(w.state.awayTeam).toEqual([]);
    expect(w.state.currentActor).toBe(w.content.start.leader);
    const who: string[] = [];
    w.bus.on(e => { if (e.type === 'actionStarted' && e.verb === 'talk') who.push(e.who); });
    await play.talk('data');
    expect(who).toEqual([w.content.start.leader]);
  });

  it('refuses with no transporter target, off the transporter and with nobody named', async () => {
    const play = Play.newGame(content(), 1);
    await expect(play.beam()).rejects.toThrow('not at the transporter room');
    await play.station('transporter');
    await expect(play.beam()).rejects.toThrow('no transporter target');
    play.state.beamTarget = 'hall';
    play.world.transporter = null;
    restoreTransporter(play.world);
    await expect(play.beam(['nobody'])).rejects.toThrow('cannot go on a pad');
  });

  it('is a walkthrough verb whose refusals are step errors', async () => {
    const ids = { objects: { '000000': 'picard' }, screens: {} };
    const r = await runWalkthrough('start ship\nstation transporter\nbeam\nend', { content: content(), ids, seed: 1 });
    expect(r.error).toContain('no transporter target');
    const away = await runWalkthrough('beam\nend', { content: content(), ids, seed: 1 });
    expect(away.error).toBeDefined();
  });
});
