// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { resetHotspotLabels, roomHotspotLabels, setHotspotLabels } from './hotspotLabels';

afterEach(() => resetHotspotLabels());

describe('roomHotspotLabels', () => {
  it('shows the room\'s labels only while the setting is on and the team is away, never aboard the ship', () => {
    const away = { state: { onShip: null } };
    const aboard = { state: { onShip: { gameOver: null } } };
    expect(roomHotspotLabels(away)).toBe(false);
    setHotspotLabels(true);
    expect(roomHotspotLabels(away)).toBe(true);
    expect(roomHotspotLabels(aboard)).toBe(false);
    expect(roomHotspotLabels(undefined)).toBe(false);
  });
});
