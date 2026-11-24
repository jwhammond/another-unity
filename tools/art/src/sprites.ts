// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * An original sprite file's animations, read as the engine plays them (ScummVM sprite_player.cpp, read-only). A sprite
 * file's `sprite.json` has `anims` (the entry each animation starts at) and `entries` (the script: frames, relative
 * moves, waits, jumps). Nothing here is committed output: it reads the user's own export.
 */

/** The animations Plan 15 uses (R8): walk 0-11 (a clock direction), stand 24-29, and talk.cpp:35-50's talk, idle, end and turn. */
export const WALK_ANIMS = Array.from({ length: 12 }, (_, i) => i);
export const STAND_ANIMS = [24, 25, 26, 27, 28, 29];
/** talk.cpp:35-50: kAnimEndLeft 0x1b, TalkFront 0x1e, IdleFront 0x20, EndRight 0x21, IdleRight 0x24, TalkRight 0x25, TurnRight 0x29, TurnLeft 0x2a, IdleLeft 0x2e, TalkLeft 0x2f, EndFront 0x4d. */
export const TALK_ANIMS = [0x1b, 0x1e, 0x20, 0x21, 0x24, 0x25, 0x29, 0x2a, 0x2e, 0x2f, 0x4d];
export const USED_ANIMS = [...WALK_ANIMS, ...STAND_ANIMS, ...TALK_ANIMS];
/**
 * awayteam.cpp:929, 1167: a crew member fires with animation kAnimFirePhaser (12) + the direction phaserShot picks from this table (kDirections: down-left 7, down 6, down-right 5, left 9,
 * the middle 6 and 5, up-left 10, up 0, up-right 2), so these seven of the twelve are the ones that are ever played. The beam is drawn from the frame the executable's muzzle table names.
 */
export const FIRE_DIRECTIONS = [0, 2, 5, 6, 7, 9, 10];
export const FIRE_ANIM = 12;
export const FIRE_ANIMS = FIRE_DIRECTIONS.map(d => FIRE_ANIM + d);

/**
 * The colours of the dithered foot shadow, as (r, g, b). The original draws no shadow of its own: ScummVM's Graphics
 * (graphics.cpp drawSprite, blit with COLOUR_BLANK 13 as the only transparent index) copies a sprite's pixels as they
 * are. The shadow is baked into the frames: a checkerboard of the palette's pure black under the feet, the same colour
 * as the shoes' outline, found by inspecting the frames of all seven crew (isolated diagonal pixels of (0, 0, 0) in the
 * lowest rows; art strips reports the count it finds).
 */
export const SHADOW_COLOURS: [number, number, number][] = [[0, 0, 0]];

/** The original's sprite clock runs at about 291.3 ticks a second (sprite_player.cpp:33-36); a wait is in sixteenths of a tick. */
export function waitMillis(wait: number): number {
  return Math.round(((wait >> 4) * 10000) / 2913);
}

export interface FrameEntry {
  type: 'sprite' | 'speechSprite';
  width: number;
  height: number;
  png: string;
}
/** Any other entry (relPos, wait, randomWait, jump, mark, pause, exit, ...), by its fields. */
export interface OtherEntry {
  type: string;
  [k: string]: unknown;
}
export type SpriteEntry = FrameEntry | OtherEntry;

export interface SpriteJson {
  file?: string;
  anims: number[];
  entries: SpriteEntry[];
  /**
   * A talk animation's frames are speech sprites over a frame an earlier animation marked, and the player keeps that mark when it changes animation: `{ [talk]: prior }`
   * has `playAnim` play `prior` first (to where it stops) and carry its state into the talk animation. Not in the export: a recipe's `prop.talk` sets it.
   */
  primed?: Record<number, number>;
}

/** One displayed frame of an animation. Offsets are the sprite's own: left = dx - trunc(width / 2), top = dy - height (graphics.cpp drawSprite). */
export interface AnimFrame {
  png: string;
  width: number;
  height: number;
  dx: number;
  dy: number;
  /** Milliseconds shown. */
  wait: number;
  /** A speech frame's mouth, drawn over `png` (its top-left, relative to the base frame's). */
  overlay?: { png: string; width: number; height: number; x: number; y: number };
}

/** One animation's body: its frames, whether it loops on itself, and the animation it falls into when it ends. */
export interface AnimBody {
  frames: AnimFrame[];
  loop: boolean;
  next?: number;
}

const MAX_STEPS = 4000;
/** A frame with no wait shows for one game tick or so. */
const DEFAULT_WAIT_MS = 50;

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Where an animation really starts: one whose first entry is a jump is another name for its target. */
export function canonicalAnim(sprite: SpriteJson, anim: number): number {
  const seen = new Set<number>();
  let a = anim;
  while (!seen.has(a)) {
    seen.add(a);
    const start = sprite.anims[a];
    const e = start === undefined ? undefined : sprite.entries[start];
    if (e?.type !== 'jump') return a;
    a = num((e as OtherEntry).target);
  }
  return a;
}

/**
 * Plays an animation as SpritePlayer::update does and returns every animation body it passes through (the one asked
 * for, then each one it jumps into). The player's state goes along: a talk animation marks its frame and falls into
 * the speech animation, whose mouth frames draw over the marked frame (se_Mark, se_SpeechSprite).
 */
export function playAnim(sprite: SpriteJson, anim: number): Map<number, AnimBody> {
  const bodies = new Map<number, AnimBody>();
  const { entries } = sprite;
  // the player's state (sprite_player.cpp)
  let normal = { x: 0, y: 0 };
  let speech = { x: 0, y: 0 };
  let relPos = { x: 0, y: 0 };
  // (the sprite's own `position`, replacing the object's: 0 is unset. A speech frame is drawn from the speech position, the marked frame from the normal one)
  let normalPos = { x: 0, y: 0 };
  let speechPos = { x: 0, y: 0 };
  type Sprite = FrameEntry;
  type Speech = FrameEntry;
  let current = null as Sprite | null;
  let marked = null as { sprite: Sprite; adj: { x: number; y: number }; pos: { x: number; y: number } } | null;
  let wasSpeech = false;
  const reset = (): void => {
    // (resetState: the normal move is lost, the speech frames lose the last relative move)
    normal = { x: 0, y: 0 };
    speech = { x: speech.x - relPos.x, y: speech.y - relPos.y };
    relPos = { x: 0, y: 0 };
  };

  let steps = 0;
  const run = (root: number, into: Map<number, AnimBody>): void => {
    let a = canonicalAnim(sprite, root);
    while (!into.has(a)) {
      const start = sprite.anims[a];
      if (start === undefined) break;
      const body: AnimBody = { frames: [], loop: false };
      into.set(a, body);
      let pending = null as { sprite: Sprite; speech: Speech | null } | null;
      const flush = (waitMs: number): void => {
        if (!pending) return;
        if (pending.speech && marked) {
          const base = marked.sprite;
          const m = pending.speech;
          // (graphics.cpp drawSprite: each frame is at its position plus its adjust, less half its width and all its height; a position the sprite does not set is the object's own,
          // which the two share, so an unset one counts as the other's)
          const at = (pos: { x: number; y: number }, other: { x: number; y: number }): { x: number; y: number } => ({ x: pos.x !== 0 ? pos.x : other.x, y: pos.y !== 0 ? pos.y : other.y });
          const [sp, np] = [at(speechPos, normalPos), at(normalPos, speechPos)];
          const ox = sp.x - np.x + speech.x - Math.trunc(m.width / 2) - (marked.adj.x - Math.trunc(base.width / 2));
          const oy = sp.y - np.y + speech.y - m.height - (marked.adj.y - base.height);
          body.frames.push({ png: base.png, width: base.width, height: base.height, dx: marked.adj.x, dy: marked.adj.y, wait: waitMs, overlay: { png: m.png, width: m.width, height: m.height, x: ox, y: oy } });
        } else {
          body.frames.push({ png: pending.sprite.png, width: pending.sprite.width, height: pending.sprite.height, dx: normal.x, dy: normal.y, wait: waitMs });
        }
        pending = null;
      };
      let i = start;
      let jumpedTo: number | null = null;
      for (; i < entries.length && steps++ < MAX_STEPS; i++) {
        const e = entries[i]!;
        if (e.type === 'sprite') {
          flush(0);
          current = e as Sprite;
          wasSpeech = false;
          pending = { sprite: current, speech: null };
        } else if (e.type === 'speechSprite') {
          // (the original skips these until a frame has been marked)
          if (!marked) continue;
          flush(0);
          if (!wasSpeech) {
            speech = { ...normal };
            speechPos = { ...normalPos };
            normal = { ...marked.adj };
            normalPos = { ...marked.pos };
          }
          wasSpeech = true;
          pending = { sprite: marked.sprite, speech: e as Speech };
        } else if (e.type === 'position') {
          const x = num((e as OtherEntry).x);
          const y = num((e as OtherEntry).y);
          if (wasSpeech) {
            // (the speech frame's own place: its adjust starts over)
            speechPos = { x, y };
            speech = { x: 0, y: 0 };
          } else normalPos = { x, y };
        } else if (e.type === 'relPos') {
          const x = num((e as OtherEntry).x);
          const y = num((e as OtherEntry).y);
          if (wasSpeech) speech = { x: speech.x + x, y: speech.y + y };
          else normal = { x, y };
          relPos = { x, y };
        } else if (e.type === 'mark') {
          if (current) marked = { sprite: current, adj: { ...normal }, pos: { ...normalPos } };
        } else if (e.type === 'wait') {
          flush(Math.max(1, waitMillis(num((e as OtherEntry).wait))));
        } else if (e.type === 'randomWait') {
          const r = e as OtherEntry;
          // (a random extra on top of the base: its middle)
          flush(Math.max(1, waitMillis(num(r.base) + num(r.rand_amt) / 2)));
        } else if (e.type === 'jump') {
          flush(DEFAULT_WAIT_MS);
          jumpedTo = canonicalAnim(sprite, num((e as OtherEntry).target));
          break;
        } else if (e.type === 'pause' || e.type === 'exit') {
          flush(DEFAULT_WAIT_MS);
          break;
        }
      }
      flush(DEFAULT_WAIT_MS);
      for (const f of body.frames) if (f.wait <= 0) f.wait = DEFAULT_WAIT_MS;
      if (jumpedTo === null) break;
      if (jumpedTo === a) {
        body.loop = true;
        break;
      }
      body.next = jumpedTo;
      reset();
      a = jumpedTo;
    }
  };
  const prior = sprite.primed?.[canonicalAnim(sprite, anim)];
  if (prior !== undefined) {
    // (the player was on `prior` first: its marked frame stays marked, and the new animation starts with the state reset as startAnim does)
    run(prior, new Map());
    reset();
  }
  run(anim, bodies);
  return bodies;
}

/**
 * Every animation the roots play, with the animations they fall into. `alias` maps an animation index to the one that
 * holds its frames (an animation that only jumps is another name for its target); `bodies` has each real one once.
 */
export function usedBodies(sprite: SpriteJson, roots: readonly number[]): { bodies: Map<number, AnimBody>; alias: Map<number, number> } {
  const bodies = new Map<number, AnimBody>();
  const alias = new Map<number, number>();
  const visit = (root: number): void => {
    if (root >= sprite.anims.length) return;
    alias.set(root, canonicalAnim(sprite, root));
    for (const [index, body] of playAnim(sprite, root)) {
      if (!bodies.has(index)) bodies.set(index, body);
      alias.set(index, index);
    }
  };
  for (const root of roots) visit(root);
  // (a body that falls into an animation no root visited: it is visited too)
  for (let again = true; again;) {
    again = false;
    for (const body of [...bodies.values()]) {
      if (body.next !== undefined && !bodies.has(body.next)) {
        visit(body.next);
        again = true;
      }
    }
  }
  return { bodies, alias };
}

/** SpritePlayer::initFlags: the flags a new sprite's script sets before it first stops (a `setFlag` is bit `flagId`), by running it from entry 0. */
export function spriteFlags(sprite: SpriteJson): number {
  let flags = 0;
  let marked = false;
  let entry = 0;
  for (let steps = 0; entry < sprite.entries.length && steps < sprite.entries.length; steps++) {
    const e = sprite.entries[entry]!;
    switch (e.type) {
      case 'pause':
      case 'exit':
      case 'wait':
      case 'randomWait':
        return flags;
      case 'mark':
        marked = true;
        break;
      case 'setFlag': {
        const id = num((e as OtherEntry).flagId);
        if (id < 32) flags |= 1 << id;
        break;
      }
      case 'jump': {
        const start = sprite.anims[num((e as OtherEntry).target)];
        if (start === undefined) return flags;
        entry = start;
        continue;
      }
      case 'speechSprite':
        if (!marked) break;
      // falls through (a speech sprite after a mark ends the run as a sprite does)
      case 'sprite': {
        const next = sprite.entries[entry + 1]?.type;
        if (entry + 1 < sprite.entries.length && (next === 'sprite' || next === 'speechSprite')) return flags;
        break;
      }
      default:
        break;
    }
    entry++;
  }
  return flags;
}

/** The sprite kinds (talk.cpp: kSpriteTalks, kSpriteIdle1, kSpriteCrew). */
export const SPRITE_TALKS = 2;
export const SPRITE_IDLE1 = 4;
export const SPRITE_CREW = 0x10;

/**
 * What a character does while it replies (UnityEngine::replyAnims): animation 2 talks (kAnimShipTalk), and the one it goes back to when the line ends is
 * 3 for a sprite flagged as talking, 1 for one flagged idle, else 0. Null for a crew-flagged sprite (it talks by the turn animations of the crew card) and for a sprite with no animation 2;
 * `idle` is -1 where the sprite has no such animation (the original leaves it on the talk animation then).
 */
export function replyAnims(sprite: SpriteJson): { talk: number; idle: number } | null {
  if (sprite.anims.length <= 2) return null;
  const flags = spriteFlags(sprite);
  if (flags & SPRITE_CREW) return null;
  const idle = flags & SPRITE_TALKS ? 3 : flags & SPRITE_IDLE1 ? 1 : 0;
  return { talk: 2, idle: idle < sprite.anims.length ? idle : -1 };
}
