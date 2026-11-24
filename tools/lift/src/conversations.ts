// SPDX-License-Identifier: GPL-3.0-or-later
import type { ChangeDef, ConversationDef, Replier, ReplyDef, ResponseDef, ResponseState } from '@another-unity/engine';
import { conversationOwner, demote, type LiftCtx, type Owner } from './context';
import { liftGroups } from './effects';
import { ANYONE_ID, hex2, isCrewId, NONE_ID, parseId, SHIP_WORLD } from './ids';
import type { ConversationFileT } from './raw';
import { resolveVoice, speakerByte, voiceKey } from './voice';

type ResponseT = ConversationFileT['responses'][number];

const STATES: Readonly<Record<number, ResponseState>> = { 1: 'set', 2: 'enabled', 3: 'disabled', 4: 'locked' };
const CHANGES: Readonly<Record<number, ResponseState>> = { 0x30: 'disabled', 0x31: 'set', 0x32: 'enabled', 0x33: 'locked' };

export function liftConversation(c: ConversationFileT, ctx: LiftCtx): ConversationDef {
  const { id, our_world, our_id, responses } = c;
  const slug = ctx.ids.conversation(our_world, our_id, id);
  const owner = conversationOwner(ctx, c);
  return {
    id: slug,
    ...(our_world === SHIP_WORLD ? { ship: true as const } : {}),
    number: our_id,
    responses: responses.map((r, i) => liftResponse(r, i, responses, ctx, owner, slug, `${id}#/responses/${i}`)),
  };
}

function liftResponse(r: ResponseT, index: number, all: ResponseT[], ctx: LiftCtx, owner: Owner, slug: string, pointer: string): ResponseDef {
  const {
    id, state, text, voice_tags, response_state, next_situation, target, voice_id, voice_group, voice_subgroup,
    whocansayblocks, textblocks, changeactions, results,
  } = r;
  // (a response's id is the situation it belongs to, and its state the key: Conversation::execute and setState)
  const out = { situation: id, key: state } as ResponseDef;
  if (text !== '') out.text = text;
  const turn = voice_group === 0xfb || voice_group === 0xfc;
  if (voice_group === 0xfd) {
    const voices = tagVoices(voice_tags, text, ctx, pointer);
    if (voices) out.voices = voices;
  } else if (!turn && text !== '') {
    const key = voiceKey(voice_group, voice_subgroup, voice_id);
    if (key) {
      out.voice = key;
      ctx.voices.add(key, text, pointer);
    }
  }
  // (0xfb and 0xfc only turn the speaker: forceTurn(who, voice_group == 0xfb), conversation.cpp:330-333)
  if (turn) out.turn = voice_group === 0xfb ? 'right' : 'left';
  out.state = STATES[response_state];
  out.who = sayers(whocansayblocks, ctx, pointer);
  const before = ctx.problems.errors.length;
  const replier = liftReplier(target, ctx, pointer);
  // (in secondary content, a replier outside the scope is dropped with a warning)
  if (replier && !demote(ctx, before)) out.replier = replier;
  if (textblocks.length > 0) {
    const byte = replierByte(target);
    out.replies = textblocks.map((b): ReplyDef => {
      const { text: reply, continued, voice_id: vid, voice_group: vgroup, voice_subgroup: vsub } = b;
      void continued;
      const key = voiceKey(vgroup, vsub, vid);
      const voice = key ? resolveVoice(key, byte) : undefined;
      if (voice) ctx.voices.add(voice, reply, pointer);
      return voice ? { text: reply, voice } : { text: reply };
    });
    // a continued first block joins the second into one reply (conversation.cpp:358-360)
    if (textblocks[0].continued && textblocks.length > 1) out.joined = true;
  }
  if (next_situation !== 0xffff) out.next = next_situation;
  if (changeactions.length > 0) {
    out.changes = changeactions.map((ch): ChangeDef => {
      const { type, response_id, state_id } = ch;
      // (Conversation::setState warns and does nothing about a response it doesn't have)
      if (!all.some(other => other.id === response_id && other.state === state_id)) {
        ctx.problems.warn(pointer, `a change names response ${response_id}/${state_id}, which this conversation doesn't have`);
      }
      return { to: CHANGES[type], situation: response_id, key: state_id };
    });
  }
  if (results.length > 0) {
    out.results = results.map((list, k) => {
      ctx.ids.list(`${pointer}/results/${k}`, `${slug}/${index}/results${k}`);
      return liftGroups(list, ctx, owner, `${pointer}/results/${k}`);
    });
  }
  return out;
}

/** Response::isCandidate (conversation.cpp:289-311): 0x10 is anyone; only crew count otherwise. */
function sayers(blocks: ResponseT['whocansayblocks'], ctx: LiftCtx, pointer: string): string[] {
  const who: string[] = [];
  for (const b of blocks) {
    const { whocansay } = b;
    const slug = whocansay === ANYONE_ID ? '$anyone' : isCrewId(whocansay) ? ctx.ids.object(whocansay, pointer) : undefined;
    if (slug === undefined) ctx.problems.warn(pointer, `who-can-say ${whocansay} isn't crew, which the original ignores`);
    else if (!who.includes(slug)) who.push(slug);
  }
  return who;
}

/** responderFor (conversation.cpp:270-287). */
function liftReplier(target: string, ctx: LiftCtx, pointer: string): Replier | undefined {
  if (target === NONE_ID) return undefined;
  const { world, screen, id } = parseId(target);
  if (id === 0xff) return undefined;
  if (world === 0 && screen === 0) {
    const crew = (n: number) => ctx.ids.object(`0000${hex2(n)}`, pointer);
    if (id < 0x10) return { object: crew(id) };
    if (id >= 0x20 && id < 0x30) return { crew: crew(id - 0x20) };
    if (id >= 0x30 && id < 0x40) return { teamCrew: crew(id - 0x30) };
    // (0x10-0x1f and anything above 0x3f: nobody replies)
    return undefined;
  }
  return { object: ctx.ids.object(target, pointer) };
}

/** The replier's voice byte: its crew number, else 0xff (voiceFileFor). */
function replierByte(target: string): string {
  const { world, screen, id } = parseId(target);
  if (world !== 0 || screen !== 0) return speakerByte(null);
  if (id < 0x10) return speakerByte(id);
  if (id >= 0x20 && id < 0x40) return speakerByte(id & 0x0f);
  return speakerByte(null);
}

/** Voice group 0xfd: "<crew digit><3 hex digits>" per speaker (conversation.cpp:336-347). */
function tagVoices(tags: string, text: string, ctx: LiftCtx, pointer: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (let i = 0; i + 4 <= tags.length; i += 4) {
    const crew = tags.charCodeAt(i) - 0x30;
    const value = parseInt(tags.slice(i + 1, i + 4), 16);
    const slug = ctx.crew.get(crew);
    if (!slug || Number.isNaN(value)) {
      ctx.problems.warn(pointer, `voice tag "${tags.slice(i, i + 4)}" names no crew member in the export`);
      continue;
    }
    const key = voiceKey(0xfe, value >> 8, value & 0xff);
    // (the first tag for a speaker wins: the original breaks at the first match, conversation.cpp:340-347)
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (!key) continue;
    out[slug] = resolveVoice(key, speakerByte(crew));
    ctx.voices.add(out[slug], text, pointer);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
