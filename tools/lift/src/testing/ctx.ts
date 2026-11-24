// SPDX-License-Identifier: GPL-3.0-or-later
import type { Manifest } from '@another-unity/rawcheck/manifest';
import type { LiftCtx } from '../context';
import { Stats } from '../context';
import { HookStubs } from '../hooks';
import { assignObjectSlugs, IdTable, isCrewId, parseId, screenSlug } from '../ids';
import { Markers } from '../markers';
import { Problems } from '../problems';
import { fitProjection } from '../projection';
import type { CombatFileT, RawIR, TrigFileT } from '../raw';
import { VoiceIndex } from '../voice';
import { miniRaw } from './mini';

/** The synthetic export, in memory (its files already pass Plan 3's schemas: mini.test.ts). */
export function rawFromMini(files: Record<string, unknown> = miniRaw()): RawIR {
  const m = files['manifest.json'] as Manifest;
  const get = <T>(path: string) => files[path] as T;
  return {
    manifest: m,
    objects: new Map(m.objects.map(id => [id, get(`objects/o_${id}.json`)])),
    conversations: new Map(m.conversations.map(id => [id, get(`conversations/${id}.json`)])),
    screens: new Map(m.screens.map(id => [id, get(`screens/${id}.json`)])),
    worlds: new Map(m.worlds.map(id => [id, get(`worlds/${id}.json`)])),
    triggers: get('triggers.json'),
    movies: get('maps/movie.json'),
    sprites: get('maps/sprite.json'),
    executable: get('executable.json'),
    ...(files['combat.json'] ? { combat: get<CombatFileT>('combat.json') } : {}),
    ...(files['trig.json'] ? { trig: get<TrigFileT>('trig.json') } : {}),
  };
}

/** A lift context with every screen of the export registered, as liftGame sets it up. */
export function testCtx(raw: RawIR = rawFromMini()): LiftCtx {
  const problems = new Problems();
  const known = {
    objects: new Set(raw.objects.keys()), conversations: new Set(raw.conversations.keys()),
    screens: new Set(raw.screens.keys()), triggers: new Set(raw.triggers.map(t => t.id)),
  };
  const slugs = assignObjectSlugs([...raw.objects.values()]);
  const markers = new Markers(problems);
  const regions = new Map<string, Set<number>>();
  const entrances = new Map<string, number>();
  for (const s of raw.screens.values()) {
    const slug = screenSlug(s.world, s.screen);
    markers.addScreen(slug, fitProjection(s.polygons));
    regions.set(slug, new Set(s.polygons.map(p => p.id)));
    entrances.set(s.id, s.location?.entrypoints.length ?? 0);
  }
  const crew = new Map<number, string>();
  for (const id of raw.objects.keys()) if (isCrewId(id)) crew.set(parseId(id).id, slugs.get(id) ?? id);
  return {
    raw, ids: new IdTable(slugs, known, problems), problems, markers, hooks: new HookStubs(), voices: new VoiceIndex(),
    stats: new Stats(), crew, regions, entrances, contexts: {}, full: new Set(raw.objects.keys()), lenient: false,
  };
}
