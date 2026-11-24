// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, type AdviceSetting } from '../content/types';
import { TICKS_PER_SECOND } from './clock';
import { say } from './talk';
import type { World } from './world';

/** setAdvice (unity.cpp:982-997). */
export function setAdvice(world: World, a: AdviceSetting): void {
  const s = world.state.advice;
  if (a.off) {
    s.id = null;
    s.every = 0;
    return;
  }
  if (a.id !== undefined) s.id = a.id;
  if (a.every !== undefined) {
    s.every = a.every;
    s.due = world.clock.now + Math.round(a.every * TICKS_PER_SECOND);
  }
}

/** getAdvice (data.cpp:1147-1161): the line for the given crew slug (which may be $anyone). */
function adviceText(world: World, crew: string, hard: boolean): string {
  const id = world.state.advice.id;
  if (id === null) return '';
  const entry = world.content.advice[id];
  return (hard ? entry?.hard : entry?.easy)?.[crew] ?? '';
}

/** sayAdvice (talk.cpp:409-419): the one being asked gives the advice (level 3 is none). */
export async function sayAdvice(world: World, obj: string | null, level: number): Promise<boolean> {
  if (obj === null || world.state.advice.id === null || level === 3) return false;
  const crew = world.content.objects[obj]?.crew ? obj : ANYONE;
  const text = adviceText(world, crew, level === 2);
  if (text === '') return false;
  return say(world, obj, crew, text);
}

/**
 * updateAdvice (talk.cpp:421-445): someone with something to say offers it, but only in a full team.
 * Decides (and rolls) now; returns who is to say it, for giveAdvice, or null.
 */
export function updateAdvice(world: World): string | null {
  const a = world.state.advice;
  if (!a.every || a.id === null || world.clock.now < a.due || world.state.pendingScreen !== null) return null;
  a.due = world.clock.now + Math.round(a.every * TICKS_PER_SECOND);

  const advisors: string[] = [];
  let team = 0;
  for (const member of world.state.awayTeam) {
    if (!world.isActiveAwayTeamMember(member)) continue;
    team++;
    if (adviceText(world, member, false) !== '') advisors.push(member);
  }
  if (advisors.length === 0 || team !== 4) return null;

  return advisors[world.rng.next(advisors.length - 1, 'advisor')];
}

/** The member chosen by updateAdvice says their advice (updateAdvice's say, talk.cpp:444). */
export async function giveAdvice(world: World, member: string): Promise<void> {
  await say(world, member, member, '!0');
}
