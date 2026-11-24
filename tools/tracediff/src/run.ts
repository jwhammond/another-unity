// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HookRegistry } from '@another-unity/engine';
import { runWalkthrough } from '@another-unity/play';
import { GameMaps } from './maps';
import type { Norm } from './model';
import { SHIP_TRIGGERS_OFF } from './preamble';
import { TraceRecorder, TracingPresenter } from './record';

export type RegisterHooks = (hooks: HookRegistry) => void;

/** A game's hooks: `registerHooks` from <game>/hooks/register.ts, if it has one (tools never import games statically). */
export async function loadGameHooks(gameDir: string): Promise<RegisterHooks | undefined> {
  const file = resolve(gameDir, 'hooks/register.ts');
  if (!existsSync(file)) return undefined;
  const mod = (await import(pathToFileURL(file).href)) as { registerHooks?: RegisterHooks };
  return mod.registerHooks;
}

export interface TsRun {
  events: Norm[];
  error: string | null;
  maps: GameMaps;
}

/** Plays a walkthrough in the TypeScript engine and records it in the normalized model. */
export async function runTs(
  gameDir: string, walk: string, opts: { seed?: number; registerHooks?: RegisterHooks; maps?: GameMaps; rawDir?: string } = {},
): Promise<TsRun> {
  const maps = opts.maps ?? (await GameMaps.load(gameDir, opts.rawDir));
  const rec = new TraceRecorder(maps);
  const disable = SHIP_TRIGGERS_OFF.map(id => maps.ids.triggers[String(id)]).filter((t): t is string => t !== undefined);
  const result = await runWalkthrough(walk, {
    content: maps.content,
    ids: { objects: maps.ids.objects, screens: maps.ids.screens },
    seed: opts.seed ?? 42,
    disableTriggers: disable,
    presenter: clock => new TracingPresenter(clock, rec),
    onWorld: world => {
      opts.registerHooks?.(world.hooks);
      rec.attach(world);
    },
    onEvent: e => rec.walkEvent(e),
  });
  rec.finish();
  return { events: rec.events, error: result.error, maps };
}
