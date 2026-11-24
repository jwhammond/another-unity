// SPDX-License-Identifier: GPL-3.0-or-later
import type { LineRef } from '../content/types';
import { runConversation } from './conversation';
import { R } from './result';
import { unlogged } from './talkLog';
import type { ActionContext, World } from './world';

/**
 * What the player hears when an action did nothing (handleLook, handleUse, handleTalk and
 * sayFailure, awayteam.cpp:396-462). Only the player's own commands get these.
 */
export async function reportFailure(world: World, ctx: ActionContext, result: number): Promise<void> {
  const lines = world.content.rules.lines;
  let r = result;
  let line: LineRef | undefined;

  switch (ctx.verb) {
    case 'look':
      if (r & R.DIDSOMETHING) return;
      line = lines.failLook;
      break;

    case 'talk':
      if (r === 0 || r & R.DIDSOMETHING) return;
      line = lines.failTalk;
      break;

    case 'use':
      if (ctx.other !== null) {
        // the failure lines need an exact match, so the tricorder replaces the "used with something" flag
        if (ctx.other === world.content.rules.items.tricorder && !(r & R.DIDSOMETHING)) r |= R.TRICORDER;
        else r |= R.FAILOTHER;
      }
      if (r & R.DIDSOMETHING) return;
      if (r & R.FAILPHASER) r = R.FAILPHASER;
      if (r === R.FAILOTHER) line = lines.failOther;
      else if (r === R.FAILPHASER) line = lines.failPhaser;
      else if (r === R.TRICORDER) line = lines.tricorderNothing;
      else line = lines.failUse;
      break;

    default:
      // nothing is said when getting or walking fails
      return;
  }

  // (these aren't logged: awayteam.cpp:457-461)
  if (line) await unlogged(world, () => runConversation(world, line.conversation, line.situation, world.state.currentActor));
}
