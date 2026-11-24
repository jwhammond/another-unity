// SPDX-License-Identifier: GPL-3.0-or-later
import type { World } from './world';

/** kMaxLoggedConversations (unity.h:248). */
export const MAX_LOGGED_CONVERSATIONS = 10;

/** UnityEngine::beginTalk (talk.cpp:216-220): each outermost conversation starts a log entry, newest first (R7). */
export function beginTalk(world: World): void {
  if (!world.talkDepth++) world.state.conversationLog.unshift([]);
}

/** UnityEngine::endTalk (talk.cpp:222-230): the last one out drops an empty entry and keeps only the last few. */
export function endTalk(world: World): void {
  if (--world.talkDepth) return;
  if (world.state.conversationLog[0]?.length === 0) world.state.conversationLog.shift();
  world.state.conversationLog.length = Math.min(world.state.conversationLog.length, MAX_LOGGED_CONVERSATIONS);
}

/** Runs `body` inside beginTalk and endTalk. */
export async function talking<T>(world: World, body: () => Promise<T>): Promise<T> {
  beginTalk(world);
  try {
    return await body();
  } finally {
    endTalk(world);
  }
}

/** Runs `body` with the log off (the failure lines, the medical lines and advice are not logged: awayteam.cpp:457-461, 1305-1308, talk.cpp:300-305). */
export async function unlogged<T>(world: World, body: () => Promise<T>): Promise<T> {
  const logging = world.logging;
  world.logging = false;
  try {
    return await body();
  } finally {
    world.logging = logging;
  }
}

/** UnityEngine::sayLine (unity.cpp:1189-1195): the line goes in the log, then on the screen. */
export async function sayLine(world: World, speaker: string, text: string, voice?: string): Promise<void> {
  if (world.logging && world.talkDepth > 0) world.state.conversationLog[0].push({ speaker, text });
  await world.presenter.say(speaker, text, voice);
}
