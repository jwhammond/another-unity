// SPDX-License-Identifier: GPL-3.0-or-later
import { Pill } from '../lcars/Pill';
import { MISSIONS, type MissionWorld } from './missions';

const TONES = ['a1', 'a2', 'a3'] as const;
export const missionHref = (world: string) => `/engineering/afu/missions/${world}/`;

/** The six worlds as pills (three accents in turn); the current world, if any, is marked `aria-current="page"`. They wrap on a phone. */
export function WorldMenu(p: { current?: MissionWorld }) {
  return (
    <nav class="lc-worlds" aria-label="Worlds">
      {MISSIONS.map((m, i) => <Pill key={m.world} tone={TONES[i % 3]!} href={missionHref(m.world)} current={m.world === p.current}>{m.name}</Pill>)}
    </nav>
  );
}
