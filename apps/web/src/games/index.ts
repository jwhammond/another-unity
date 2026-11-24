// SPDX-License-Identifier: GPL-3.0-or-later
import type { GamePackage } from '@another-unity/engine/web';
import type { GateParams } from '../gate/params';
import type { MissionSelectText } from '../missionSelect';

// (games/unity is generated locally from the game's data: without it, the app has only the demo)
// (only the key is read: ?raw, as a lazy glob still bundles the file, and YAML isn't a module)
// (the deploy build's unity is the sealed one, which `gate:seal` writes: never the plain files. The flags are constants Vite replaces, so
// the branch not taken and its glob are left out of the bundle; gamePlugin.ts keeps the other module from being loaded at all, and sets
// VITE_AU_SEALED when the sealed files are there)
const deploy = import.meta.env.VITE_AU_DEPLOY === '1';
const unityLifted = !deploy && Object.keys(import.meta.glob('../../../../games/unity/game.yaml', { query: '?raw' })).length > 0;
const unitySealed = deploy && import.meta.env.VITE_AU_SEALED === '1';

/** The games this app runs, by their ?game= name. Each loads only its own content and theme. */
export const GAMES: Record<string, () => Promise<GamePackage>> = {
  demo: async () => (await import('./demo')).demo(),
  ...(unitySealed ? { unity: async () => (await import('./unitySealed')).unitySealed() } : {}),
  ...(unityLifted ? { unity: async () => (await import('./unity')).unity() } : {}),
};

/**
 * The games behind the CD gate, and the gate's public parts: the parameters, and the check file's URL. The deploy build's unity only.
 * (here, not imported by main.ts itself, so gamePlugin.ts's stub covers it in a build without the sealed files)
 */
export const GATES: Record<string, () => Promise<{ params: GateParams; checkUrl: string }>> = {
  ...(unitySealed ? { unity: async () => { const m = await import('./unitySealed'); return { params: m.gateParams, checkUrl: m.checkUrl }; } } : {}),
};

/** The games with a dev mission select (?dev&missions, R11), and their missions' names by world. */
export const BRIDGES: Record<string, MissionSelectText> = {
  unity: { missions: { horst3: 'Horst III', allanor: 'Allanor', zoo: 'Morassia', lab: 'Mertens Station', frigis: 'Shonoisho Epsilon VI', unity: 'Unity' } },
};

/**
 * The dev ship starts (?dev&ship=<name>): the ship's trigger states the original reaches only through earlier missions,
 * so a second mission can be played from a new game. Trigger ids are the census's (docs/unity-local.md).
 */
export const SHIP_STARTS: Record<string, Record<string, string[]>> = {
  // (horst3: the post-Frigis trigger t117, which enables the arrival trigger at Horst III's planet)
  unity: { horst3: ['t117'] },
};
