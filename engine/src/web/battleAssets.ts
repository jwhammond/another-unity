// SPDX-License-Identifier: GPL-3.0-or-later
import type { CombatData } from '../content/types';
import type { AssetIndex } from '../view/assets';
import { battleAssetList, loadBattleAssets, type BattleAssets, type BattleLoaders } from '../view/combat/assets';
import { backdropPlate } from '../view/combat/files';
import { spaceArtPacks, type SpaceArt } from '../view/combat/spaceArt';
import { textureBytes } from '../view/textureMemory';

/**
 * A file's bytes for a battle's set (BattleLoaders.bytes). A response that is not OK (a 404), or the dev server's HTML page
 * served in place of a missing file, throws, so the file is listed as missing, as an absent one is, and never parsed as a pack.
 */
export async function fetchBytes(url: string, get: typeof fetch = fetch): Promise<Uint8Array> {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if ((res.headers.get('content-type') ?? '').startsWith('text/html')) throw new Error(`${url}: an HTML page, not the file`);
  return new Uint8Array(await res.arrayBuffer());
}

/** What the battle's set is doing, for `?dev` and the e2e tests. */
export interface BattleAssetState {
  scenario: number;
  state: 'loading' | 'ready';
  models: number;
  sprites: number;
  stills: boolean;
  missing: string[];
  /** The set's textures, and their bytes as the texture ledger counts them. */
  textures: number;
  bytes: number;
  /** With the art on, what the art's packs gave (BattleAssets.art: Plan 30); null with it off. */
  art: { packs: number; swapped: number; sheets: number; fit: number } | null;
}

/**
 * The battle being fought's models, sprites and stills (M8 spec §8): loaded as the battle starts, freed as it ends or the world is
 * replaced (a load, a restart). One set at a time; a set that finishes loading after its battle has gone is freed at once.
 */
export class BattleAssetHolder {
  private current: { scenario: number; assets: BattleAssets | null } | null = null;

  constructor(
    /** The game's assets now (a hot reload swaps the package). */
    private readonly assets: () => AssetIndex,
    private readonly loaders: BattleLoaders,
    private readonly warn: (message: string) => void,
    private readonly changed: () => void,
    /** `art.space` while the art is on, else null: read as each battle starts (Plan 30 R16). */
    private readonly art: () => SpaceArt | null = () => null,
  ) {}

  /** Loads the set of a battle with these ships (CombatShip.type, one a ship), freeing the one before. Resolves once it is loaded, or dropped. */
  async load(combat: CombatData, scenario: number, types: readonly number[]): Promise<void> {
    this.free();
    const entry: { scenario: number; assets: BattleAssets | null } = { scenario, assets: null };
    this.current = entry;
    let set: BattleAssets;
    // (the art's packs and backdrop plate only while the art is on: Plan 30 R13, R16)
    const space = this.art();
    const plate = space?.backdrops.includes(backdropPlate(scenario)) ? backdropPlate(scenario) : undefined;
    const packs = space ? spaceArtPacks(space, types) : [];
    try {
      set = await loadBattleAssets(combat, { ...battleAssetList(combat, types), ...(plate ? { backdrop: plate } : {}), ...(space ? { art: packs } : {}) }, this.assets(), this.loaders);
    } catch (err) {
      // (a load its battle has already dropped fails silently: nothing is drawn from it either way)
      if (this.current !== entry) return;
      this.current = null;
      this.warn(`combat: battle ${scenario}'s models and sprites failed to load: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // (the battle ended, or another began, while it loaded)
    if (this.current !== entry) {
      set.dispose();
      return;
    }
    entry.assets = set;
    // (a plate and the packs are the art's (Plan 30), not the space build's: each told apart)
    const art = (m: string) => m === plate || packs.includes(m) || m.includes(':');
    const build = set.missing.filter(m => !art(m));
    if (build.length > 0) this.warn(`combat: battle ${scenario} is drawn without ${build.join(', ')}: not in the game's space build (npm run unity:build)`);
    if (plate && set.missing.includes(plate)) this.warn(`combat: battle ${scenario}'s backdrop plate ${plate} failed to load: drawn without a backdrop`);
    const lost = set.missing.filter(m => m !== plate && art(m));
    if (lost.length > 0) this.warn(`combat: battle ${scenario} is drawn in the original's textures where the art lacks ${lost.join(', ')} (npm run art:space -- publish)`);
    this.changed();
  }

  /** Frees the set (and drops one still loading). */
  free(): void {
    this.current?.assets?.dispose();
    this.current = null;
  }

  /** The set now: null when there is none. */
  state(): BattleAssetState | null {
    const c = this.current;
    if (!c) return null;
    const a = c.assets;
    if (!a) return { scenario: c.scenario, state: 'loading', models: 0, sprites: 0, stills: false, missing: [], textures: 0, bytes: 0, art: null };
    const sized = a.textures.map(t => t.image as { width?: number; height?: number } | undefined);
    return {
      scenario: c.scenario, state: 'ready', models: a.models.size, sprites: a.sprites.size, stills: a.stills !== null, missing: a.missing,
      textures: a.textures.length,
      bytes: a.textures.reduce((n, t, i) => n + textureBytes(sized[i]?.width ?? 0, sized[i]?.height ?? 0, t.generateMipmaps), 0),
      art: a.art ?? null,
    };
  }

  /** The set now, loaded: what a battle's draw will use (Plans 25-27). */
  get loaded(): BattleAssets | null {
    return this.current?.assets ?? null;
  }
}
