// SPDX-License-Identifier: GPL-3.0-or-later
import { ACTOR, ANYONE, type ActFx, type Effect } from '../content/types';
import { TICKS_PER_SECOND } from './clock';
import { communicate, restartTimerTriggers } from './general';
import { alter } from './alter';
import { perform } from './actions';
import { runConversation, setResponseState } from './conversation';
import { NotPorted } from './hooks';
import { R } from './result';
import { markMovieSeen } from './ship';
import { runList } from './rules';
import { react } from './react';
import { adviceEffect, awayFlagsEffect, requestScreen, startupEffect } from './screens';
import { say } from './talk';
import { sayLine } from './talkLog';
import type { ActionContext, World } from './world';

/** playDescriptionFor (unity.cpp:1105-1119): each crew member has their own description of things. */
export async function describe(world: World, objectId: string, who: string): Promise<void> {
  const speaker = world.state.objects[who] ? who : world.state.currentActor;
  const def = world.content.objects[objectId];
  const line = def?.descriptions?.[speaker] ?? def?.description;
  if (line) {
    await say(world, objectId, speaker, `|${line.text}`, line.voice);
    return;
  }
  const fail = world.content.rules.lines.failLook;
  if (fail) await runConversation(world, fail.conversation, fail.situation, world.state.currentActor);
}

/** CommandBlock (object.cpp:1622-1655): someone does something; the result doesn't matter. */
async function act(world: World, a: ActFx, ctx: ActionContext): Promise<number> {
  // $anyone is the current member (0x10), $actor whoever is acting now (0x20)
  const who = a.who === undefined || a.who === ANYONE ? world.state.currentActor : a.who === ACTOR ? ctx.who : a.who;
  const to = a.at !== undefined ? world.marker(world.state.screen, a.at) : undefined;
  // $anyone as the object is the current member too (getWalker, unity.cpp:876-886; M3 Decision 6)
  const target = a.object === ANYONE ? world.state.currentActor : a.object ?? null;
  await perform(world, { verb: a.verb, target, who, other: a.other ?? null, walked: false, to });
  return 0;
}

/** Runs one effect; returns result flags (0 means it worked and the group goes on). */
export async function runEffect(world: World, fx: Effect, ctx: ActionContext, key: string): Promise<number> {
  if ('alter' in fx) return alter(world, fx.alter, ctx);

  if ('missing' in fx) {
    // (M3 Decision 3: ScummVM would fail here; the warning is for the console, the event for the trace)
    world.bus.emit({ type: 'warning', message: `missing: ${fx.missing.kind} ${fx.missing.id}` });
    world.bus.emit({ type: 'missing', kind: fx.missing.kind, id: fx.missing.id });
    return 0;
  }

  if ('path' in fx) {
    const regions = world.state.regions[world.state.screen];
    for (const region of fx.path.enable ?? []) regions[region] = true;
    for (const region of fx.path.disable ?? []) regions[region] = false;
    world.bus.emit({ type: 'regionsChanged', screen: world.state.screen });
    return 0;
  }

  if ('trigger' in fx) {
    world.setTriggerEnabled(fx.trigger.id, fx.trigger.enabled);
    return 0;
  }

  // (scripts can only change the screen once everything is done)
  if ('screen' in fx) return requestScreen(world, fx.screen);

  if ('say' in fx) {
    await sayLine(world, fx.say.who, fx.say.text, fx.say.voice);
    return 0;
  }

  if ('describe' in fx) {
    await describe(world, fx.describe.object, ctx.who);
    return 0;
  }

  if ('play' in fx) {
    // (UnityEngine::playMovie remembers the movie, for the holodeck: unity.cpp:363-364)
    if (fx.play.movie !== undefined) markMovieSeen(world.state.ship, fx.play.movie);
    await world.presenter.play(fx.play);
    return 0;
  }

  if ('converse' in fx) {
    const cv = fx.converse;
    setResponseState(world, cv.conversation, cv.situation, cv.key, cv.to);
    return 0;
  }

  if ('act' in fx) return act(world, fx.act, ctx);

  if ('react' in fx) return react(world, fx.react, ctx);

  if ('beam' in fx) {
    // this only sets where the transporter will send the away team
    // (BeamBlock's world 8 lands on world 5's screens, so the number goes with it: object.cpp:1829-1838)
    world.state.beamTarget = fx.beam.to;
    world.state.beamWorld = fx.beam.to === null ? null : fx.beam.world ?? null;
    return 0;
  }

  if ('advice' in fx) return adviceEffect(world, fx.advice);
  if ('startup' in fx) return startupEffect(world, fx.startup);
  if ('awayFlags' in fx) return awayFlagsEffect(world, fx.awayFlags);

  if ('communicate' in fx) return communicate(world, fx.communicate);

  if ('wait' in fx) {
    // (GeneralBlock command 3)
    if (fx.wait.seconds > 0) await world.clock.wait(Math.round(fx.wait.seconds * TICKS_PER_SECOND));
    return 0;
  }

  if ('restartTimers' in fx) {
    restartTimerTriggers(world);
    return 0;
  }

  if ('ship' in fx) {
    world.applyShipEffect(fx.ship);
    return 0;
  }

  if ('call' in fx) {
    const name = fx.call.hook;
    const hook = world.hooks.get(name);
    try {
      return await hook(world, ctx, fx.call.args ?? {});
    } catch (err) {
      if (err instanceof NotPorted) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`hook ${name} failed: ${message}`, { cause: err });
    }
  }

  if (!('choose' in fx)) return unhandled(fx);
  const [first, second] = fx.choose.options;
  const choice: number = await world.presenter.choose(fx.choose.question, [first.text, second.text]);
  // (anything but one of the two buttons does nothing, object.cpp:1896-1897)
  if (choice !== 0 && choice !== 1) return 0;
  // only a stop leaves the choice (ChoiceBlock::execute returns result & RESULT_STOPPED)
  return (await runList(world, fx.choose.options[choice].do, ctx, `${key}/choice${choice}`)) & R.STOPPED;
}

/** Every effect has a branch above; a new effect type without one fails the typecheck here. */
function unhandled(fx: never): never {
  throw new Error(`unknown effect: ${JSON.stringify(fx)}`);
}
