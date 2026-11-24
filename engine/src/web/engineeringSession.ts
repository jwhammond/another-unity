// SPDX-License-Identifier: GPL-3.0-or-later
import type { ShipUnit } from '../content/types';
import { setSlider, type SliderKind, type SystemsState } from '../sim/shipSystems';
import type { World } from '../sim/world';
import type { AssetIndex } from '../view/assets';
import { loadEngineeringArt, type LoadedEngineeringArt } from '../view/engineeringArt';
import type { PresentationConfig } from '../view/package';

/** What the engineering panel reads: the ship's units and their live state, whether La Forge is running things, and the original's pictures when they are loaded. */
export interface EngineeringView {
  units: readonly ShipUnit[];
  systems: SystemsState;
  delegate: boolean;
  art: LoadedEngineeringArt | null;
}

/** What the session lends the engineering screen. */
export interface EngineeringHost {
  world(): World;
  /** Nothing is running (the ship's clicks are refused otherwise). */
  idle(): boolean;
  /** Whether the art is on (`&art=0` turns it off). */
  artOn(): boolean;
  presentation(): PresentationConfig;
  assets(): AssetIndex;
  difficulty(): number;
  /** Tells the panels something changed. */
  bump(): void;
  /** A ship sound by name (presentation.yaml's `shipSounds`). */
  sound(name: string): void;
  /** The browser's fetch of a URL's bytes; a test's own. */
  fetchBytes(url: string): Promise<Uint8Array>;
}

/**
 * The engineering screen's half of the ship port. `_delegate` starts as `difficulty < 2` (La Forge runs things on the easier levels) and is kept
 * for the session, as `_delegateSet` keeps it in the original (engineering.cpp:141); the pictures are fetched on first use.
 */
export function engineeringPort(host: EngineeringHost): {
  engineering(): EngineeringView | null;
  engineeringSlider(unit: number, kind: SliderKind, x: number): void;
  engineeringDelegate(): void;
} {
  let delegate: boolean | null = null;
  let art: LoadedEngineeringArt | null = null;
  let loading = false;
  const load = (): void => {
    if (loading) return;
    loading = true;
    loadEngineeringArt(host.presentation(), host.assets(), host.fetchBytes).then(loaded => {
      art = loaded;
      if (loaded) host.bump();
    }).catch((err: unknown) => console.warn('the engineering art did not load', err));
  };
  return {
    engineering() {
      const world = host.world();
      const ship = world.content.ship;
      if (world.state.onShip === null || world.state.ship.station !== 'engineering' || !ship) return null;
      delegate ??= host.difficulty() < 2;
      if (host.artOn()) load();
      return { units: ship.data.units, systems: world.state.ship.systems, delegate, art: host.artOn() ? art : null };
    },
    engineeringSlider(unit, kind, x) {
      const world = host.world();
      const ship = world.content.ship;
      if (!host.idle() || !ship || world.state.ship.station !== 'engineering') return;
      setSlider(ship, world.state.ship.systems, unit, kind, x);
      host.bump();
    },
    engineeringDelegate() {
      delegate = !(delegate ?? host.difficulty() < 2);
      // ("Mr La Forge, take over", "Aye, Captain": the voice lines come one after another, as the original waits for the first before the second)
      if (delegate) {
        host.sound('delegateTakeOver');
        host.sound('delegateAye');
      }
      host.bump();
    },
  };
}
