// SPDX-License-Identifier: GPL-3.0-or-later
import { AssetIndex, packageFromStrings, type GamePackage } from '@another-unity/engine/web';
import { registerUnityHooks } from '../../../../games/unity/hooks/register';
import '../../../../games/unity/theme.css';
import gateJson from '../../../../games/unity/.sealed/gate.json?raw';
import checkBin from '../../../../games/unity/.sealed/check.bin?url';
import contentPack from '../../../../games/unity/.sealed/content.pack?url';
import { parseContentPack } from '../gate/contentPack';
import { parseGateParams, type GateParams } from '../gate/params';

/**
 * A Final Unity in the deploy build: the files `gate:seal` wrote to games/unity/.sealed, never the plain games/unity (docs/unity-local.md).
 * The media keep their paths, so the asset index is as unity.ts's; the text is content.pack, one JSON map of path to yaml, and combat.yaml
 * is combat.pack. Each is fetched through the service worker, which opens it with the key the player's disc gave.
 */
const BASE = '../../../../games/unity/.sealed/';

/** The gate's public parameters: which ranges of the disc the key comes from, and the salt. */
export const gateParams: GateParams = parseGateParams(gateJson);
/** check.bin: a known text sealed with the key, so the page can tell a right disc from a wrong one before the game starts. */
export const checkUrl: string = checkBin;

const assets = import.meta.glob<string>(
  ['../../../../games/unity/.sealed/{art,audio,models,movies,space}/**/*', '!../../../../games/unity/.sealed/**/*.cmd'],
  { query: '?url', import: 'default', eager: true },
);
// (combat.pack is optional, as combat.yaml is: a glob, so a game without one still builds)
const combatPack = Object.values(import.meta.glob<string>('../../../../games/unity/.sealed/combat.pack', { query: '?url', import: 'default', eager: true }))[0];

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  // (the status rides on the error: a 403 is the worker's "no key", which sends the player back to the import screen: gateFlow.ts)
  if (!res.ok) throw Object.assign(new Error(`unity: ${res.status} for a sealed file`), { status: res.status });
  return res.text();
}

export async function unitySealed(): Promise<GamePackage> {
  // (not JSON: the file came through still sealed, as from a worker of another build, which the gate should have replaced: Reload)
  const yaml = parseContentPack(await fetchText(contentPack));
  return packageFromStrings({
    id: 'unity',
    yaml,
    assets: AssetIndex.fromGlob(BASE, assets),
    registerHooks: registerUnityHooks,
    ...(combatPack ? { combat: () => fetchText(combatPack) } : {}),
  });
}
