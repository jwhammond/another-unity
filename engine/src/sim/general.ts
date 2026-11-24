// SPDX-License-Identifier: GPL-3.0-or-later
import { parseConversationString } from '../content/talkString';
import type { CommunicateFx } from '../content/types';
import { perform } from './actions';
import { runConversation } from './conversation';
import { NO_SCENARIO } from './ship';
import type { World } from './world';

/** No hail is pending (and type 0xff clears one). */
const NO_HAIL = 0xff;

/** CommunicateBlock::execute (object.cpp:1849-1888): these are all conversations on the ship, with the captain. */
export async function communicate(world: World, c: CommunicateFx): Promise<number> {
  if (c.type === NO_HAIL) {
    world.state.pendingHail = null;
    return 0;
  }

  if (c.type === 0xa || c.type === 0xb || c.type === 0x10 || c.type === 0x11) {
    // a battle hail: its scenario, not a conversation (unity.cpp:676-690)
    const hail = { from: c.from ?? null, conversation: null, situation: 0, type: c.type, scenario: c.scenario ?? NO_SCENARIO };
    world.state.pendingHail = hail;
    world.bus.emit({ type: 'hail', hail: { ...hail } });
    return 0;
  }

  const pend = (conversation: string | null, situation: number): number => {
    // the bridge (or space combat) deals with it
    const hail = { from: c.from ?? null, conversation, situation, type: c.type };
    world.state.pendingHail = hail;
    // (a copy, so a listener can't change the pending hail)
    world.bus.emit({ type: 'hail', hail: { ...hail } });
    return 0;
  };
  // a hail with no conversation: 7 with the target's own talk string (99), 9 the transporter, and the rest for space combat
  if (c.type > 3 && c.conversation === undefined && (c.type === 7 || ![4, 5, 6, 8].includes(c.type))) return pend(null, 0);

  let conversation = c.conversation;
  let situation = c.situation;
  if (c.type !== 7 && c.type !== 8 && c.from !== undefined) {
    // the hailer's talk string gives the numbers (like sscanf "@%d,%d": no random situations),
    // and they always mean a ship conversation (object.cpp:1854-1877)
    const ref = world.state.objects[c.from] ? parseConversationString(world.obj(c.from).talk) : null;
    const number = ref ? world.content.conversations[ref.conversation]?.number : undefined;
    const ship = number === undefined
      ? undefined
      : Object.values(world.content.conversations).find(conv => conv.ship && conv.number === number);
    if (!ref || ref.situation.startsWith('?') || !ship) {
      world.bus.emit({ type: 'warning', message: `no conversation for a hail from ${c.from}` });
      return 0;
    }
    conversation = ship.id;
    situation = Number(ref.situation);
  }
  if (conversation === undefined || situation === undefined) {
    world.bus.emit({ type: 'warning', message: 'a hail without a conversation' });
    return 0;
  }

  if (c.type <= 3) {
    // (these ask whether to answer, but no script uses them)
    world.bus.emit({ type: 'warning', message: `unused hail type ${c.type}` });
    return 0;
  }
  if (c.type === 6) {
    // right now
    await runConversation(world, conversation, situation, world.content.start.leader);
    return 0;
  }
  return pend(conversation, situation);
}

/** GeneralBlock command 4: every enabled timer trigger starts again. */
export function restartTimerTriggers(world: World): void {
  for (const t of world.content.triggers) {
    const ts = world.state.triggers[t.id];
    if (ts.enabled && t.type === 'timer') ts.due = 0;
  }
}

/** What clicking the communicator asks first (awayteam.cpp:830): the UI's prompt, and a walkthrough's `combadge`. */
export const COMBADGE_QUESTION = 'Do you wish to contact the ship?';

/**
 * The combadge (awayteam.cpp:824-832): the communicator's own rules, as the current member. Returns
 * false, doing nothing, while the combadge is disabled: the original checks that flag as part of the
 * combadge click itself, so the sim does too. Everything around it belongs to the UI, as it does
 * to the original's input handling: ignoring the click while input is blocked (awayFlags.inputBlocked)
 * or a dialog is up (unity.cpp:1366-1370), the combadge sound, and the "contact the ship?" question,
 * which is asked before calling this.
 */
export function callShip(world: World): boolean {
  const communicator = world.content.rules.items.communicator;
  if (!world.state.awayFlags.combadge || communicator === undefined) return false;
  void world.enqueue(async () => {
    await perform(world, { verb: 'use', target: communicator, who: world.state.currentActor, other: null, walked: false });
  });
  return true;
}
