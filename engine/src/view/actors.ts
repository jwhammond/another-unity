// SPDX-License-Identifier: GPL-3.0-or-later
import { CapsuleGeometry, Group, Mesh, MeshStandardMaterial, Sprite, SpriteMaterial, type Texture } from 'three';
import type { Vec2 } from '../content/types';
import type { CardAnim, CardArt } from './art';
import { setDissolve, type BeamTarget, type SparkleFrame } from './beam';
import type { Walker } from './walker';

export const ACTOR_HEIGHT = 1.8;
const RADIUS = 0.3;

/** What a card is doing: it picks the animation by R8. */
export type CardState =
  | { kind: 'walk'; dir: number }
  | { kind: 'stand'; dir: number }
  | { kind: 'talk' | 'idle' | 'end' | 'turn'; side: 'front' | 'left' | 'right' }
  | { kind: 'anim'; index: number };

/** A card's pixels to the original's: art strips makes cards at 4x (tools/art CARD_SCALE). */
const CARD_SCALE = 4;

/** What ActorView.setCard shows. */
export interface CardSpec {
  /** The still: the first frame of a sheet of `frames`. */
  texture: Texture;
  frames: number;
  anchor: [number, number];
  pixelHeight?: number;
  /** Plays the card's animations; without it the still is shown. */
  player?: CardPlayer;
  /** An animation's strip texture; undefined while it loads (and the call asks for it). */
  strip?: (anim: number) => Texture | undefined;
}

/** The animations of the original's away team sprites (unity.cpp:872-873 and talk.cpp:35-50). */
const WALK = 0;
const STOP_WALKING = 24;
const TALK = { front: 0x1e, right: 0x25, left: 0x2f };
/** awayteam.cpp:929: a crew member fires with this animation plus the direction it fires in (12 to 23, of which seven are played). */
export const FIRE_PHASER = 12;
const IDLE = { front: 0x20, right: 0x24, left: 0x2e };
const END = { front: 0x4d, right: 0x21, left: 0x1b };
const TURN = { right: 0x29, left: 0x2a };
/** The stand that faces the camera: where a state with no direction falls back to. */
const STAND_FRONT = STOP_WALKING + 3;

/** 12-way clock direction of a screen-space step (0 up, 3 right, 6 down, 9 left), from its NDC components. */
export function clockDirection(dxNdc: number, dyNdc: number): number {
  // (NDC spans 640 columns and 480 rows: the original's directions are in pixels)
  const angle = Math.atan2(dxNdc * 320, dyNdc * 240);
  return ((Math.round(angle / (Math.PI / 6)) % 12) + 12) % 12;
}

/** The animation a state plays, before any fallback. */
export function animFor(state: CardState): number {
  switch (state.kind) {
    case 'walk': return WALK + (((state.dir % 12) + 12) % 12);
    case 'stand': return STOP_WALKING + Math.floor((((state.dir % 12) + 12) % 12) / 2);
    case 'talk': return TALK[state.side];
    case 'idle': return IDLE[state.side];
    case 'end': return END[state.side];
    case 'turn': return state.side === 'front' ? IDLE.front : TURN[state.side];
    case 'anim': return state.index;
  }
}

/**
 * Plays a card's animations on a clock in milliseconds: a state picks its animation (R8), the animation runs through
 * its frames on their delays, loops or falls into the animation the original jumps to, and holds its last frame.
 */
export class CardPlayer {
  private anim = -1;
  private since = 0;
  private state = '';
  /** Where a hold keeps the animation (milliseconds into it), or null while it plays. */
  private held: number | null = null;

  constructor(private readonly card: Pick<CardArt, 'anims'>, private readonly clock: () => number) {}

  /** Whether the card has this animation. */
  has(anim: number): boolean {
    return !!this.card.anims?.[anim];
  }

  /** Milliseconds from the start of animation `anim` to the moment its frame `index` is first shown: the time the original's sprite player takes to reach it (getFrameCount). */
  startOf(anim: number, index: number): number {
    const delays = this.card.anims?.[anim]?.delays ?? [];
    return delays.slice(0, Math.max(0, index)).reduce((x, y) => x + y, 0);
  }

  /** Holds the animation on frame `index` (SpritePlayer::setPaused): it stays there until `release`. */
  hold(index: number): void {
    if (this.anim >= 0) this.held = this.startOf(this.anim, index);
  }

  /** Lets a held animation go on from the frame it is on (setPaused(false)). */
  release(): void {
    if (this.held === null) return;
    this.since = this.clock() - this.held;
    this.held = null;
  }

  /** The animation a state really plays: its own if the card has it, else the nearest stand (the front one for a state with no direction). */
  resolve(state: CardState): number | null {
    const anims = this.card.anims ?? {};
    const want = animFor(state);
    if (anims[want]) return want;
    const stands = [0, 1, 2, 3, 4, 5].map(i => STOP_WALKING + i).filter(i => anims[i]);
    if (stands.length === 0) return null;
    const near = state.kind === 'walk' || state.kind === 'stand' ? STOP_WALKING + Math.floor((((state.dir % 12) + 12) % 12) / 2) : STAND_FRONT;
    return stands.reduce((best, i) => (Math.abs(i - near) < Math.abs(best - near) ? i : best));
  }

  /** Starts the state's animation, unless it is the one already playing for the same state. */
  set(state: CardState): void {
    const key = JSON.stringify(state);
    if (key === this.state) return;
    this.state = key;
    const anim = this.resolve(state);
    if (anim === null) {
      this.anim = -1;
      return;
    }
    // (a different state that resolves to the animation already playing keeps its place)
    if (anim === this.anim) return;
    this.anim = anim;
    this.since = this.clock();
    this.held = null;
  }

  /** The frame to show now: which animation, which cell of its strip, the strip's uv rectangle, and where the feet are. */
  frame(): { anim: number; index: number; uv: [number, number, number, number]; anchor: [number, number]; cell: [number, number] } | null {
    const anims = this.card.anims ?? {};
    if (this.anim < 0 || !anims[this.anim]) return null;
    let a: CardAnim = anims[this.anim]!;
    let t = this.held ?? this.clock() - this.since;
    // (an animation that ends falls into the next, taking the time that is left: bounded, as a chain can loop)
    for (let hops = 0; hops < 8; hops++) {
      const total = a.delays.reduce((x, y) => x + y, 0);
      if (a.loop || t < total || total <= 0) break;
      const next = a.next !== undefined ? anims[a.next] : undefined;
      if (!next) {
        t = total;
        break;
      }
      t -= total;
      this.anim = a.next!;
      this.since = this.clock() - t;
      a = next;
    }
    const total = a.delays.reduce((x, y) => x + y, 0);
    if (a.loop && total > 0) t %= total;
    let index = 0;
    for (let acc = 0; index < a.frames - 1; index++) {
      acc += a.delays[index] ?? 0;
      if (t < acc) break;
    }
    // (a strip that wraps has rows: the first row is the top of the image, so the last v is 1)
    const columns = Math.min(a.frames, a.columns ?? a.frames);
    const rows = Math.ceil(a.frames / columns);
    const col = index % columns;
    const row = Math.floor(index / columns);
    return { anim: this.anim, index, uv: [col / columns, 1 - (row + 1) / rows, (col + 1) / columns, 1 - row / rows], anchor: a.anchor, cell: a.cell };
  }
}

/** A crew member without a model: a capsule with a name tag (spec §7.2's fallback). */
export class ActorView implements BeamTarget {
  readonly group = new Group();
  readonly body: Mesh<CapsuleGeometry, MeshStandardMaterial>;
  readonly label: HTMLElement | null;
  walker: Walker | null = null;
  /** The card standing in for the capsule's look (setCard), if any. */
  card: Sprite | null = null;
  /** The still texture the card was made from (the stage's check that the card is the one it wants). */
  cardStill: Texture | null = null;
  private spec: CardSpec | null = null;
  /** The last clock direction it walked in (0 up, 3 right): the stand that follows faces that way. Down the screen at first. */
  lastDir = 6;
  /** Which way it speaks: toward the camera until a turn says otherwise. */
  side: 'front' | 'left' | 'right' = 'front';
  /** Whether the card was walking on the last frame. */
  walkingCard = false;
  private cardBase = { width: 0, height: ACTOR_HEIGHT };
  private cardAnchor: readonly [number, number] = [0.5, 0];
  /** Metres one of the original's pixels is across, at full scale (the room's metric), when the room has one. */
  private pixelMetres: number | undefined;
  /** The same down the picture: a flat screen's rows are deeper than its columns are wide, and a card (a sprite) is drawn in the camera's own space. */
  private rowMetres: number | undefined;
  /** The row of the original's picture the feet stand on, when the room has a metric: the card is drawn in that order (setFootRow). */
  private footRow = 0;
  private down = false;
  /** How much of the picture the transporter's dissolve hides (beam.ts): 0 (all) to 6 (none), or -1 for the picture as it is. */
  private beamLevel = -1;
  /** The transporter's sparkle in front of the actor, while one plays. */
  private sparkleSprite: Sprite | null = null;
  /** Ends the walk in progress at its destination; Stage.walk sets it. */
  arrive: (() => void) | null = null;

  constructor(readonly id: string, color: number, labels: HTMLElement | null) {
    this.body = new Mesh(
      new CapsuleGeometry(RADIUS, ACTOR_HEIGHT - 2 * RADIUS, 4, 12),
      new MeshStandardMaterial({ color, transparent: true, opacity: 1 }),
    );
    this.body.position.y = ACTOR_HEIGHT / 2;
    this.body.userData.object = id;
    this.group.add(this.body);
    this.label = labels ? labels.appendChild(document.createElement('div')) : null;
    if (this.label) this.label.className = 'au-nametag';
  }

  get position(): Vec2 {
    return { x: this.group.position.x, z: this.group.position.z };
  }

  place(p: Vec2): void {
    this.group.position.set(p.x, 0, p.z);
  }

  face(heading: number): void {
    this.group.rotation.y = heading;
  }

  setName(name: string): void {
    if (this.label && this.label.textContent !== name) this.label.textContent = name;
  }

  /**
   * Shows a card in place of the capsule's look: a camera-facing Sprite, its anchor on the floor. The capsule stays as
   * the hit volume (its material is only made invisible). null puts the capsule back. A card with a `pixelHeight` is
   * drawn that many of the original's pixels tall (R9), else ACTOR_HEIGHT tall; with a `player` its animation's
   * frame is shown (updateCard), else the first frame of the still. The textures are the caller's: shared, not freed here.
   */
  setCard(card: CardSpec | null): void {
    if (this.card) {
      this.group.remove(this.card);
      this.card.material.dispose();
      this.card = null;
    }
    this.spec = card;
    this.cardStill = card?.texture ?? null;
    this.body.material.visible = card === null;
    if (!card) return;
    // (a sprite sheet's first frame: the texture shows 1/frames of its width, from the left)
    card.texture.repeat.set(1 / card.frames, 1);
    card.texture.offset.set(0, 0);
    const sprite = new Sprite(new SpriteMaterial({ map: card.texture, transparent: true, opacity: this.beamLevel >= 0 ? 1 : this.body.material.opacity }));
    if (this.beamLevel >= 0) setDissolve(sprite, this.beamLevel);
    this.cardAnchor = [card.anchor[0], 1 - card.anchor[1]];
    sprite.name = 'card';
    sprite.renderOrder = this.footRow;
    this.card = sprite;
    this.group.add(sprite);
    this.layoutStill();
    this.updateCard();
    this.setDown(this.down);
  }

  /** The metres one of the original's pixels is across at full scale, where the room has a metric; the card is laid out again. */
  setPixelMetres(metres: number | undefined, rowMetres = metres): void {
    if (metres === this.pixelMetres && rowMetres === this.rowMetres) return;
    this.pixelMetres = metres;
    this.rowMetres = rowMetres;
    if (this.card) {
      this.layoutStill();
      this.updateCard();
      this.setDown(this.down);
    }
  }

  /**
   * The row the feet stand on in the original's 640x480: the original draws objects in ascending order of that row
   * (DrawOrderComparison, unity.cpp:209-220), so the card's renderOrder is the row. On a flat screen every card's origin
   * is on the floor plane the top-down camera faces, so a depth sort can't order them.
   */
  setFootRow(row: number): void {
    this.footRow = row;
    if (this.card) this.card.renderOrder = row;
  }

  /** The card's animation player, if its card has animations. */
  get player(): CardPlayer | null {
    return this.spec?.player ?? null;
  }

  /** The card's width over its height, as it is now. */
  cardAspect(): number {
    return this.cardBase.width / this.cardBase.height;
  }

  /** Where the feet are in the card, in fractions of its width from the left and its height from the top. */
  cardFeet(): readonly [number, number] {
    return [this.cardAnchor[0], 1 - this.cardAnchor[1]];
  }

  /** The height of the card's top above the feet, in metres at the group's own scale (the name tag stands over it). */
  headHeight(): number {
    return this.card ? this.cardBase.height * (1 - this.cardAnchor[1]) : ACTOR_HEIGHT;
  }

  /** Metres per original pixel for a card: the room's, else the one that makes the standing frame ACTOR_HEIGHT tall. */
  private metresPerPixel(): number | undefined {
    if (this.pixelMetres !== undefined) return this.pixelMetres;
    return this.spec?.pixelHeight ? ACTOR_HEIGHT / this.spec.pixelHeight : undefined;
  }

  private layoutStill(): void {
    const spec = this.spec;
    const sprite = this.card;
    if (!spec || !sprite) return;
    const image = spec.texture.image as { width?: number; height?: number } | undefined;
    const aspect = image?.width && image.height ? image.width / spec.frames / image.height : 0.5;
    const m = this.metresPerPixel();
    const height = spec.pixelHeight && m !== undefined ? spec.pixelHeight * (this.rowMetres ?? m) : ACTOR_HEIGHT;
    const width = spec.pixelHeight && m !== undefined ? spec.pixelHeight * m * aspect : height * aspect;
    this.cardBase = { width, height };
    sprite.scale.set(this.cardBase.width, this.cardBase.height, 1);
  }

  /** Shows the animation's frame now: its strip's texture and cell, the cell's size at the room's pixel size, and the feet where the animation puts them. */
  updateCard(): void {
    const spec = this.spec;
    const sprite = this.card;
    if (!spec?.player || !sprite) return;
    const f = spec.player.frame();
    if (!f) return;
    const texture = spec.strip?.(f.anim);
    // (until the strip has loaded the card keeps what it showed)
    if (!texture) return;
    sprite.material.map = texture;
    texture.repeat.set(f.uv[2] - f.uv[0], f.uv[3] - f.uv[1]);
    texture.offset.set(f.uv[0], f.uv[1]);
    this.cardAnchor = [f.anchor[0], 1 - f.anchor[1]];
    // (a cell is 4x the original's pixels)
    const m = this.metresPerPixel() ?? ACTOR_HEIGHT / 168;
    this.cardBase = { width: (f.cell[0] / CARD_SCALE) * m, height: (f.cell[1] / CARD_SCALE) * (this.rowMetres ?? m) };
    sprite.scale.set(this.cardBase.width, this.cardBase.height, 1);
    this.setDown(this.down);
  }

  /** Lying down while out of action. */
  setDown(down: boolean): void {
    this.down = down;
    if (this.card) {
      // (a card lies on its side about its middle; standing, its anchor is on the floor)
      this.card.center.set(...(down ? ([0.5, 0.5] as const) : this.cardAnchor));
      this.card.material.rotation = down ? Math.PI / 2 : 0;
      this.card.position.y = down ? this.cardBase.width / 2 : 0;
    }
    this.body.rotation.z = down ? Math.PI / 2 : 0;
    this.body.position.y = down ? RADIUS : ACTOR_HEIGHT / 2;
  }

  /**
   * The transporter's dissolve: the card loses blocks of its picture as the original's does (beam.ts), or, with no card, the capsule fades.
   * -1 puts it back as it was.
   */
  dissolve(level: number): void {
    this.beamLevel = level;
    if (this.card) {
      setDissolve(this.card, level);
      this.body.material.opacity = 1;
    } else this.body.material.opacity = level < 0 ? 1 : level / 6;
  }

  /** The sparkle's frame drawn in front of the actor, standing where its feet are, at the size of the card's own pixels (the group's scale makes it the floor's). */
  sparkle(texture: Texture | undefined, frame: SparkleFrame | null): void {
    if (!texture || !frame) {
      if (this.sparkleSprite) this.sparkleSprite.visible = false;
      return;
    }
    if (!this.sparkleSprite) {
      const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      sprite.name = 'beam-sparkle';
      this.sparkleSprite = sprite;
      this.group.add(sprite);
    }
    const sprite = this.sparkleSprite;
    sprite.visible = true;
    sprite.material.map = texture;
    texture.repeat.set(frame.uv[2] - frame.uv[0], frame.uv[3] - frame.uv[1]);
    texture.offset.set(frame.uv[0], frame.uv[1]);
    const m = this.metresPerPixel() ?? ACTOR_HEIGHT / 168;
    sprite.center.set(frame.anchor[0], 1 - frame.anchor[1]);
    sprite.scale.set(frame.cell[0] * m, frame.cell[1] * (this.rowMetres ?? m), 1);
    // (just in front of the actor: the original draws the effect straight after the sprite)
    sprite.renderOrder = this.footRow + 0.5;
  }

  clear(): void {
    if (!this.sparkleSprite) return;
    this.group.remove(this.sparkleSprite);
    this.sparkleSprite.material.dispose();
    this.sparkleSprite = null;
  }

  setOpacity(opacity: number): void {
    this.body.material.opacity = opacity;
    if (this.card) this.card.material.opacity = opacity;
  }

  setHighlight(on: boolean): void {
    this.body.material.emissive.setHex(on ? 0x444444 : 0x000000);
    this.card?.material.color.setHex(on ? 0xffffaa : 0xffffff);
  }

  dispose(): void {
    this.clear();
    this.label?.remove();
    this.card?.material.dispose();
    this.body.geometry.dispose();
    this.body.material.dispose();
  }
}
