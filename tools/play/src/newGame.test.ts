// SPDX-License-Identifier: GPL-3.0-or-later
import { makeGame, miniShipContent } from '@another-unity/engine';
import { describe, expect, it } from 'vitest';
import { Play } from './play';

describe('Play.newGame', () => {
  it('starts on the ship when the game has one', () => {
    const play = Play.newGame(miniShipContent(), 1);
    expect(play.state.onShip).toEqual({ gameOver: null });
    expect(play.state.ship.station).toBe('bridge');
    expect(play.state.awayTeam).toEqual([]);
  });

  it('starts at the start screen when it has none, and `from` keeps the away start', () => {
    expect(Play.newGame(makeGame([]), 1).state.onShip).toBeNull();
    expect(Play.from(miniShipContent(), 1).state.onShip).toBeNull();
  });
});
