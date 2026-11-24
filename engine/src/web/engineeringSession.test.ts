// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { HeadlessPresenter } from '../sim/presenter';
import { gotoShipScreen } from '../sim/stations';
import { createInitialState } from '../sim/state';
import { World } from '../sim/world';
import { miniShipContent } from '../testing/ship';
import { AssetIndex } from '../view/assets';
import { PACK_ENTRIES } from '../view/engineeringLayout';
import { writePack } from '../view/indexed';
import type { PresentationConfig } from '../view/package';
import { engineeringPort, type EngineeringHost } from './engineeringSession';

function setup(over: Partial<EngineeringHost> = {}) {
  const c = miniShipContent();
  const world = new World(c, createInitialState(c, 1, { onShip: true }), w => new HeadlessPresenter(w.clock));
  const log: string[] = [];
  let idle = true;
  const bytes: Record<string, Uint8Array> = {
    pack: writePack(Array.from({ length: PACK_ENTRIES }, () => ({ width: 1, height: 1, pixels: new Uint8Array([1]) }))),
    pal: new Uint8Array(768), f: new Uint8Array([1, 3, 0x20, 0x20, 3, 0, 0, 0, 0, 4, 0, 0, 0]),
  };
  const presentation = { art: {
    engineering: { pack: 'e.pack', palette: 'e.pal', tables: { sliders: [], labels: [], rows: [], shieldOrder: [], paletteIndex: [] } },
    fonts: { files: ['f0', 'f1', 'f2'] },
  } } as unknown as PresentationConfig;
  const host: EngineeringHost = {
    world: () => world, idle: () => idle, artOn: () => true, presentation: () => presentation,
    assets: () => new AssetIndex([['e.pack', 'pack'], ['e.pal', 'pal'], ['f0', 'f'], ['f1', 'f'], ['f2', 'f']]),
    difficulty: () => 1, bump: () => { log.push('bump'); }, sound: name => { log.push(`sound ${name}`); },
    fetchBytes: async url => { log.push(`fetch ${url}`); return bytes[url]!; },
    ...over,
  };
  return { world, log, port: engineeringPort(host), setIdle: (v: boolean) => { idle = v; } };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the engineering screen\'s port', () => {
  it('has nothing until the ship is at engineering, then the lifted units with their live state', async () => {
    const { world, port } = setup();
    expect(port.engineering()).toBeNull();
    await gotoShipScreen(world, 9);
    const view = port.engineering()!;
    expect(view.units).toBe(world.content.ship!.data.units);
    expect(view.systems).toBe(world.state.ship.systems);
    expect(view.art).toBeNull();
  });

  it('loads the pictures once, on first use, and tells the panels when they are there', async () => {
    const { world, port, log } = setup();
    await gotoShipScreen(world, 9);
    port.engineering();
    port.engineering();
    await flush();
    expect(log.filter(l => l.startsWith('fetch'))).toHaveLength(5);
    expect(log).toContain('bump');
    expect(port.engineering()!.art!.images).toHaveLength(PACK_ENTRIES);
  });

  it('does not load them, or show them, with the art off', async () => {
    const { world, port, log } = setup({ artOn: () => false });
    await gotoShipScreen(world, 9);
    port.engineering();
    await flush();
    expect(log.filter(l => l.startsWith('fetch'))).toEqual([]);
    expect(port.engineering()!.art).toBeNull();
  });

  it('lets La Forge run things on the easier levels, and the player\'s Delegate button takes over or gives back, saying so when it takes over', async () => {
    const easy = setup({ difficulty: () => 0 });
    await gotoShipScreen(easy.world, 9);
    expect(easy.port.engineering()!.delegate).toBe(true);
    easy.port.engineeringDelegate();
    expect(easy.port.engineering()!.delegate).toBe(false);
    expect(easy.log.filter(l => l.startsWith('sound'))).toEqual([]);
    easy.port.engineeringDelegate();
    expect(easy.log.filter(l => l.startsWith('sound'))).toEqual(['sound delegateTakeOver', 'sound delegateAye']);
    const hard = setup({ difficulty: () => 2 });
    await gotoShipScreen(hard.world, 9);
    expect(hard.port.engineering()!.delegate).toBe(false);
  });

  it('sets a slider through the sim while the game is idle, and ignores it otherwise or away from engineering', async () => {
    const { world, port, setIdle, log } = setup();
    const warp = world.content.ship!.data.units.findIndex(u => u.type === 4);
    port.engineeringSlider(warp, 'power', 30);
    expect(world.state.ship.systems.units[warp]!.target).toBe(100);
    await gotoShipScreen(world, 9);
    port.engineeringSlider(warp, 'power', 30);
    expect(world.state.ship.systems.units[warp]!.target).toBe(Math.trunc(100 * 30 / 119));
    expect(log).toContain('bump');
    setIdle(false);
    port.engineeringSlider(warp, 'power', 100);
    expect(world.state.ship.systems.units[warp]!.target).toBe(Math.trunc(100 * 30 / 119));
  });
});
