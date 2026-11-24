// SPDX-License-Identifier: GPL-3.0-or-later
import type { MissingFx, ShipFx, Verb } from '../content/types';
import type { CueRequest, SoundRequest } from './combat/types';
import type { PendingHail } from './state';

export type SimEvent =
  | { type: 'objectChanged'; id: string }
  | { type: 'screenChanged'; screen: string }
  | { type: 'regionsChanged'; screen: string }
  | { type: 'ruleRan'; target: string | null; verb: Verb; group: string }
  | { type: 'actionFailed'; error: string }
  /** Something the original only warns about, such as a missing response or a bad hail. */
  | { type: 'warning'; message: string }
  /** Content the export lacks was reached (M3 Decision 3): ScummVM would fail here. The trace records it. */
  | { type: 'missing'; kind: MissingFx['kind']; id: string }
  | { type: 'collapsed'; id: string }
  | { type: 'recovered'; id: string }
  | { type: 'reading'; world: string; group: number }
  | { type: 'hail'; hail: PendingHail }
  | { type: 'shipEffect'; effect: ShipFx }
  | { type: 'gathered'; actor: string }
  | { type: 'leftAwayMission'; gameOver: number | null }
  /** The away team beamed down from the transporter room (energize); `effect` is whether the beam-down piece plays. */
  | { type: 'beamedDown'; world: number; effect: boolean }
  /** The ship went to a station (gotoShipScreen); `code` is screen | param << 8. */
  | { type: 'shipScreen'; code: number }
  /** The ship's journey: engaged, arrived or stopped (astrogation.cpp). `ticks` is the journey's length. */
  | { type: 'astro'; what: 'engage' | 'arrive' | 'stop'; pos: { x: number; y: number; z: number }; orbit: number; location: { sector: number; star: number; planet: number; moon: number; station: number; phenomenon: number }; speed: number; ticks: number }
  /** The viewscreen came up for `target` (null: no signal) or went down (runViewscreen). */
  | { type: 'viewscreen'; on: boolean; target: string | null }
  /** A hail raised or lowered the bridge's viewscreen (setViewscreen, unity.cpp:650 and 656). UI state, not saved. */
  | { type: 'bridgeViewscreen'; up: boolean }
  /** The pending battle scenario changed (unity.cpp _battleScenario); 0xffff is none. */
  | { type: 'battleScenario'; scenario: number }
  /** A battle was set up (TacticalScreen::start) or ended (endCombat). */
  | { type: 'combat'; on: boolean; scenario: number }
  /**
   * A battle's frame at tactical ran (TacticalScreen::update): the crew cues and sound effects its update asked for (b.cues
   * and b.sounds, taken from the battle), the battle's clock it ran to (the CuePlayer's g_system->getMillis()), and whether the
   * Enterprise is lost (b.silenced: CuePlayer::_silenced). Sent every frame, as _cues->update() runs every frame
   * (tactical.cpp:474): the presentation's to play (Plan 28).
   */
  | { type: 'battleAudio'; now: number; silenced: boolean; cues: CueRequest[]; sounds: SoundRequest[] }
  /** The Enterprise warped away mid-battle (TacticalScreen::showWarp): the warp overlay, `ms` long, is the presentation's (M8). */
  | { type: 'battleWarp'; ms: number }
  /** A response that only turns the speaker (voice groups 0xfb and 0xfc: forceTurn, talk.cpp). */
  | { type: 'turned'; who: string; side: 'left' | 'right' }
  /** The speaker turns to whoever replies, once a conversation (turnSpeaker, conversation.cpp:438-440). */
  | { type: 'faced'; who: string; toward: string }
  /** A rule group whose condition failed (or that a walk already under way skipped), with its result flags. */
  | { type: 'ruleSkipped'; target: string | null; verb: Verb; group: string; result: number }
  /** One effect of a group that ran, with its result flags (0 when it simply worked). */
  | { type: 'effectRan'; group: string; effect: string; result: number }
  /** performAction starts (the trace's `action`); depth 1 is the outermost. */
  | { type: 'actionStarted'; verb: Verb; target: string | null; who: string; other: string | null; depth: number }
  /** performAction returns, with its result flags (the trace's `actionEnd`). */
  | { type: 'actionEnded'; verb: Verb; target: string | null; result: number; depth: number }
  /** A trigger fired; its target's USE follows (processTriggers). */
  | { type: 'triggerFired'; id: string; target: string }
  /** An object's timer fired; its TIMER action follows (processTimers). */
  | { type: 'timerFired'; object: string }
  /** A game-state random number was drawn, at a site named as ScummVM's trace names it (docs/trace-format.md). */
  | { type: 'rng'; site: string; max: number; value: number }
  /** The ship's computer hid or showed an entry, or recorded a reading (the id is an entry index or a reading key). */
  | { type: 'computer'; field: 'hidden' | 'reading'; id: number; to: boolean }
  /** An astrogation flag changed (a script's reveal). */
  | { type: 'astroFlag'; id: number; from: number; to: number }
  /** A script asked the ship for a scripted warp. */
  | { type: 'scriptedWarp'; code: number; speed: number }
  /** A script set an object moving through space. */
  | { type: 'universeMove'; object: string; to: { x: number; y: number; z: number } }
  /** A group's condition passed, for the action's `other` (the tricorder's chirp: object.cpp:1277-1279). */
  | { type: 'conditionPassed'; group: string; other: string | null }
  /** A sound the ship's screens make by themselves (the holodeck's door, the computer's voice): presentation.yaml's `shipSounds` names the file. */
  | { type: 'shipCue'; cue: ShipCue };

/** The sounds a ship screen's sim plays, by what they mark (the lifter's SHIP_SOUNDS gives each its file). */
export const SHIP_CUES = [
  'holodeckDoor', 'holodeckOn', 'holodeckPick', 'holodeckOff',
  // (how the computer says it is when its screen opens, computer.cpp:306-316: online, then full, partial or offline; offline is also the holodeck's refusal)
  'computerOnline', 'computerFull', 'computerPartial', 'computerOffline',
] as const;
export type ShipCue = (typeof SHIP_CUES)[number];

/** The sounds a ship screen's buttons make (the session plays them as the player clicks): the lifter's SHIP_SOUNDS gives each its file. */
export const SHIP_CLICKS = ['shipBeep', 'shipSoftbop', 'doorOpen', 'doorClose', 'tacticalAlert', 'advice', 'computerSelect', 'transporterConfirm', 'delegateTakeOver', 'delegateAye'] as const;
export type ShipClick = (typeof SHIP_CLICKS)[number];

export class EventBus {
  private readonly handlers = new Set<(e: SimEvent) => void>();

  /** `onError` gets whatever a subscriber throws; the other subscribers, and the sim, carry on. */
  constructor(private readonly onError: (err: unknown) => void = () => {}) {}

  on(handler: (e: SimEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(e: SimEvent): void {
    // (a copy, so a subscriber that unsubscribes, or subscribes another, doesn't change this round)
    for (const handler of [...this.handlers]) {
      try {
        handler(e);
      } catch (err) {
        this.onError(err);
      }
    }
  }
}
