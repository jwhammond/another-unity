// SPDX-License-Identifier: GPL-3.0-or-later
import { ANYONE, type ResponseDef, type ResponseState } from '../content/types';
import { runList } from './rules';
import { sayLine, talking } from './talkLog';
import type { ActionContext, World } from './world';

function isCrew(world: World, id: string): boolean {
  return world.content.objects[id]?.crew === true;
}

/** Who says the reply, or null for nobody (responderFor, conversation.cpp:270-287). */
export function responderFor(world: World, r: ResponseDef): string | null {
  const rep = r.replier;
  if (!rep) return null;
  if ('object' in rep) return rep.object;
  if ('crew' in rep) return rep.crew;
  // (0x3n: only checked on an away mission, conversation.cpp:279)
  return world.state.onShip !== null || world.isActiveAwayTeamMember(rep.teamCrew) ? rep.teamCrew : null;
}

/** Response::isCandidate (conversation.cpp:289-325); it can turn a SET response ENABLED. */
function isCandidate(world: World, conversation: string, index: number, who: string, first: boolean): boolean {
  const r = world.content.conversations[conversation].responses[index];
  const states = world.state.conversations[conversation];
  const anyone = r.who.includes(ANYONE);
  const text = r.text ?? '';

  // a line from someone else can always be said
  if (!(anyone && (text === '' || text[0] === ' '))) {
    const crew = isCrew(world, who);
    if (!anyone && !(crew && r.who.includes(who))) return false;
    // (aboard the ship nobody is on a team: conversation.cpp:305 checks only on an away mission)
    if (world.state.onShip === null && crew && !world.isActiveAwayTeamMember(who)) return false;
  }

  if (first && states[index] === 'set') states[index] = 'enabled';
  if (states[index] !== 'enabled') return false;

  // whoever replies has to be here
  const rep = r.replier;
  if (!rep || 'crew' in rep || 'teamCrew' in rep) return true;
  if (isCrew(world, rep.object)) return world.state.onShip !== null || world.isActiveAwayTeamMember(rep.object);
  return world.state.objects[rep.object]?.active === true;
}

/** Conversation::setState (conversation.cpp:413-422): the first response that matches; a locked one stays locked. */
export function setResponseState(world: World, conversation: string, situation: number, key: number, to: ResponseState): void {
  const conv = world.content.conversations[conversation];
  const index = conv ? conv.responses.findIndex(r => r.situation === situation && r.key === key) : -1;
  if (index < 0) {
    world.bus.emit({ type: 'warning', message: `no state ${key} of situation ${situation} in conversation ${conversation}` });
    return;
  }
  const states = world.state.conversations[conversation];
  if (states[index] !== 'locked') states[index] = to;
}

const CHANGE_ORDER: ResponseState[] = ['disabled', 'set', 'enabled', 'locked'];

/** Response::execute (conversation.cpp:327-399). */
async function runResponse(world: World, conversation: string, index: number, who: string): Promise<boolean> {
  const r = world.content.conversations[conversation].responses[index];
  let said = false;

  // a hail with no target (a script's 0xffffff) is shown as whoever replies, not as the warp behind it
  if (world.viewscreen !== null && world.viewscreen.target === null) {
    const replier = responderFor(world, r);
    if (replier !== null && world.state.objects[replier] && !isCrew(world, replier)) world.viewscreen.caller = replier;
  }

  // a response that only turns the speaker says nothing, but the view turns them (forceTurn, talk.cpp)
  if (r.turn) world.bus.emit({ type: 'turned', who, side: r.turn });
  if (r.text && !r.turn) {
    await sayLine(world, who, r.text, r.voices ? r.voices[who] : r.voice);
    said = true;
  }

  // the reply
  const replies = r.replies ?? [];
  if (replies.length > 0) {
    let block = replies[0];
    let reply = block.text;
    if (r.joined && replies.length > 1) {
      reply += replies[1].text;
    } else if (replies.length > 1) {
      block = replies[world.rng.next(replies.length - 1, 'reply')];
      reply = block.text;
    }
    const responder = responderFor(world, r);
    if (reply !== '' && responder !== null && world.state.objects[responder]) {
      await sayLine(world, responder, reply, block.voice);
      said = true;
    }
  }

  // then the changes to the conversation, by kind, and each kind in reverse
  const changes = r.changes ?? [];
  for (const to of CHANGE_ORDER) {
    for (let i = changes.length - 1; i >= 0; i--) {
      if (changes[i].to === to) setResponseState(world, conversation, changes[i].situation, changes[i].key, to);
    }
  }

  // and last, the results, on whatever the outermost action was about
  const results = r.results ?? [];
  for (let i = 0; i < results.length; i++) {
    const ctx: ActionContext = {
      verb: 'use',
      target: world.talkTarget ?? (world.state.objects[who] ? who : null),
      who,
      other: null,
      walked: false,
    };
    await runList(world, results[i], ctx, `${conversation}/${index}/results${i}`);
  }
  return said;
}

/** Conversation::execute (conversation.cpp:424-459): true if anything was said. */
export function runConversation(world: World, conversation: string, situation: number, who: string): Promise<boolean> {
  // (talk.cpp:63-79: a missing conversation warns before beginTalk)
  if (!world.content.conversations[conversation]) return executeConversation(world, conversation, situation, who);
  return talking(world, () => executeConversation(world, conversation, situation, who));
}

async function executeConversation(world: World, conversation: string, situation: number, who: string): Promise<boolean> {
  const conv = world.content.conversations[conversation];
  if (!conv) {
    world.bus.emit({ type: 'warning', message: `there is no conversation "${conversation}"` });
    return false;
  }

  let said = false;
  let first = true;
  let faced = false;
  let current: number | undefined = situation;
  // (a screen change ends the conversation)
  while (current !== undefined && world.state.pendingScreen === null) {
    // the original keeps these in reverse order
    const candidates: number[] = [];
    for (let i = conv.responses.length - 1; i >= 0; i--) {
      if (conv.responses[i].situation === current && isCandidate(world, conversation, i, who, first)) candidates.push(i);
    }
    if (candidates.length === 0) break;
    // the speaker turns to whoever replies, once a conversation (turnSpeaker, conversation.cpp:438-440)
    const lead = conv.responses[candidates[0]];
    if (!faced && (candidates.length > 1 || (lead.text ?? '') !== '')) {
      const responder = responderFor(world, lead);
      if (responder !== null && responder !== who) world.bus.emit({ type: 'faced', who, toward: responder });
      faced = true;
    }

    let index = candidates[0];
    if (candidates.length > 1) {
      const choice = await world.presenter.menu(candidates.map(i => conv.responses[i].text ?? ''), { conversation, situation: current });
      if (choice === null || !Number.isInteger(choice) || choice < 0 || choice >= candidates.length) break;
      index = candidates[choice];
    }

    if (await runResponse(world, conversation, index, who)) said = true;
    first = false;
    current = conv.responses[index].next;
  }
  return said;
}
