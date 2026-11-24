// SPDX-License-Identifier: GPL-3.0-or-later
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entranceSlotName, parseGame, type Condition, type GameContent, type Vec2 } from '@another-unity/engine';
import { Projection, type ProjectionParams } from '@another-unity/lift/projection';
import { readGameDir } from '@another-unity/play';
import { parse } from 'yaml';

/** ids.yaml (Plan 4 Decision 4): original ids to slugs, and IR list pointers to rule paths. */
export interface IdsFile {
  worlds: Record<string, string>;
  screens: Record<string, string>;
  objects: Record<string, string>;
  conversations: Record<string, string>;
  triggers: Record<string, string>;
  advice: Record<string, string>;
  lists: Record<string, string>;
}

/** The parts of coords.yaml the diff reads: each screen's projection and its markers' raw pixels. */
export interface CoordsFile {
  metersPerPixel: number;
  screens: Record<string, { projection: ProjectionParams; markers: Record<string, [number, number]> }>;
}

/** The parts of voices.yaml the diff reads (Plan 4 Decision 9). */
export interface VoicesYaml {
  speakers: Record<string, string>;
  other: string;
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, '0');

/** A position as both sides write it: metres, to the millimetre, "x,z". */
export function posString(p: Vec2): string {
  const mm = (v: number) => Math.round(v * 1000) / 1000 + 0; // (+ 0 turns -0 into 0)
  return `${mm(p.x)},${mm(p.z)}`;
}

/** A trigger as Plan 3's triggers.json has it (only what unlifted-triggers checks). */
export interface RawTrigger {
  id: number;
  type: number;
  context: number;
  target: string;
}

/** What the diff knows about one lifted game: its id table, projections, voices and content. */
export class GameMaps {
  private readonly projections = new Map<string, Projection>();

  constructor(
    readonly ids: IdsFile,
    readonly coords: CoordsFile,
    readonly voices: VoicesYaml,
    readonly content: GameContent,
    /** The export's triggers.json, when RAW_DIR is known: what unlifted-triggers may forgive. */
    readonly rawTriggers: RawTrigger[] = [],
  ) {}

  static async load(gameDir: string, rawDir?: string): Promise<GameMaps> {
    const read = async (file: string): Promise<unknown> => parse(await readFile(join(gameDir, file), 'utf8'));
    // (overrides are the lifter's input: they are merged into the generated files already)
    const files = (await readGameDir(gameDir)).filter(f => !f.path.startsWith('overrides/'));
    const triggers = rawDir ? (JSON.parse(await readFile(join(rawDir, 'triggers.json'), 'utf8')) as RawTrigger[]) : [];
    return new GameMaps(
      (await read('ids.yaml')) as IdsFile,
      (await read('coords.yaml')) as CoordsFile,
      (await read('voices.yaml')) as VoicesYaml,
      parseGame(files),
      triggers,
    );
  }

  /**
   * Whether a trigger the lift didn't name may change in ScummVM's trace with nothing to compare: it is
   * unused (type 3, Plan 4 Decision 14) or the ship's (context other than 1, Plan 4's `context: ship`;
   * and none of the slice's scope, Plan 4 Decision 6). Without triggers.json, nothing is expected.
   */
  unliftedTriggerExpected(id: number): boolean {
    const t = this.rawTriggers.find(r => r.id === id);
    return t !== undefined && (t.type === 3 || t.context !== 1);
  }

  /** An object's slug: null for nobody (ffffff) and no other (fffffe); `?<id>` for one the lift didn't name. */
  object(id: string): string | null {
    if (id === 'ffffff' || id === 'fffffe') return null;
    return this.ids.objects[id] ?? `?${id}`;
  }

  /** The world an object's curr_screen counts in: its own, or, for world 0 (crew and items), the team's. */
  objectWorld(id: string, current: number): number {
    const world = parseInt(id.slice(0, 2), 16);
    return world === 0 ? current : world;
  }

  /** A screen's slug; null for screen 0 (nowhere). */
  screen(world: number, screen: number): string | null {
    if (screen === 0) return null;
    const key = `s_${hex(world, 2)}${hex(screen, 2)}`;
    return this.ids.screens[key] ?? `?${key}`;
  }

  trigger(id: number): string {
    return this.ids.triggers[String(id)] ?? `?${id}`;
  }

  /** An advice id as a slug: 0xffff is none, 0xfffe off. */
  advice(world: number, id: number): string | null {
    if (id === 0xffff) return null;
    if (id === 0xfffe) return 'off';
    const key = `w_${hex(world, 2)}/${id}`;
    return this.ids.advice[key] ?? `?${key}`;
  }

  conversation(world: number, id: number): string | undefined {
    return this.ids.conversations[`w${hex(world, 3)}c${String(id).padStart(3, '0')}`];
  }

  /**
   * A group's rule path, as the sim names it: the list's path (ids.yaml `lists`) and the group's index. A
   * choice branch's groups sit under the group holding the choice: `<group>/choice<n>/<index>` (effects.ts).
   */
  group(list: string, index: number): string {
    const choice = /^(.*)\/(\d+)\/\d+\/_choice\/(\d+)$/.exec(list);
    if (choice) return `${this.group(choice[1], Number(choice[2]))}/choice${choice[3]}/${index}`;
    const path = this.ids.lists[list];
    return path === undefined ? `?${list}/${index}` : `${path}/${index}`;
  }

  /** A condition counter's key: its entry's group (a condition is always its group's first entry). */
  counter(entry: string): string {
    const m = /^(.*)\/(\d+)\/\d+$/.exec(entry);
    return m ? this.group(m[1], Number(m[2])) : `?${entry}`;
  }

  /** A talk string in the lifter's words (Plan 4 Decision 10): conversations by slug. */
  talk(s: string, world: number): string {
    const three = /^@(\d+),(\d+),(\??\d+)$/.exec(s);
    if (three) {
      const c = this.conversation(Number(three[1]), Number(three[2]));
      return c ? `@${c},${three[3]}` : s;
    }
    const two = /^@(\d+),(\??\d+)$/.exec(s);
    if (two) {
      const c = this.conversation(world, Number(two[1]));
      return c ? `@${c},${two[2]}` : s;
    }
    return s;
  }

  /** A pixel on a screen in metres, through the projection the lifter placed that screen's markers with. */
  pos(screen: string, x: number, y: number): string {
    let p = this.projections.get(screen);
    if (!p) {
      const params = this.coords.screens[screen]?.projection;
      if (!params) return `?${x},${y}`;
      p = new Projection(params);
      this.projections.set(screen, p);
    }
    return posString(p.toWorld(x, y));
  }

  /** Where an object starts, as the TypeScript world's baseline has it (createInitialState). */
  initialScreen(slug: string): string | null {
    const d = this.content.objects[slug];
    if (!d || d.inventory) return null;
    // (the start puts the away team on its screen, whatever their own screen says: the lifter gives the crew none)
    if (this.content.start.awayTeam.includes(slug)) return this.content.start.screen;
    return d.screen ?? null;
  }

  /**
   * Where an object starts, in the original's pixels (its marker in coords.yaml), if it starts on one. The
   * away team starts on the start entrance's slots, in content order, as createInitialState places them.
   */
  initialPixel(slug: string): [number, number] | null {
    const d = this.content.objects[slug];
    const screen = this.initialScreen(slug);
    if (!d || !screen) return null;
    const start = this.content.start;
    let at = d.at;
    if (start.awayTeam.includes(slug)) {
      const arriving = Object.keys(this.content.objects).filter(id => start.awayTeam.includes(id));
      at = entranceSlotName(this.content.screens[start.screen].markers, start.entrance, arriving.indexOf(slug));
    }
    if (!at) return null;
    return this.coords.screens[screen]?.markers[at] ?? null;
  }

  /**
   * Where a team member stands the moment a start places them: the pixel of their slot on the entrance (the low
   * four bits), if the screen has one. ScummVM logs a coordinate only when it changes, so one it doesn't log
   * was already this.
   */
  entrancePixel(screen: string, entrance: number, member: string): [number, number] | null {
    const markers = this.content.screens[screen]?.markers;
    const index = this.content.start.awayTeam.indexOf(member);
    if (!markers || index < 0) return null;
    const base = `entrance_${entrance === 0xff ? 0 : entrance & 0x0f}`;
    if (!Object.hasOwn(markers, base)) return null;
    return this.coords.screens[screen]?.markers[entranceSlotName(markers, base, index)] ?? null;
  }

  /** A voice key with its '@' made the speaker's byte (Plan 4 Decision 9): the file stem it names. */
  voice(key: string | undefined, who: string): string {
    return key ? key.replace('@', this.voices.speakers[who] ?? this.voices.other).toLowerCase() : '';
  }

  /** Whether a screen is a close-up (its startup's closeup), which places no one on arriving. */
  isCloseup(screen: string): boolean {
    return this.content.screens[screen]?.startup?.closeup === true;
  }

  isCrew(slug: string): boolean {
    return this.content.objects[slug]?.crew === true;
  }

  threshold(slug: string): number | undefined {
    return this.content.objects[slug]?.phaser?.threshold;
  }

  private animatedSlugs: Set<string> | undefined;

  /** Whether some lifted rule plays an animation on this object or switches it on or off (an object with a sprite: its script may set its state). */
  animated(slug: string): boolean {
    if (!this.animatedSlugs) {
      const found = new Set<string>();
      const scan = (x: unknown): void => {
        if (Array.isArray(x)) x.forEach(scan);
        else if (x && typeof x === 'object') {
          const alter = (x as { alter?: { object?: unknown; anim?: unknown; active?: unknown } }).alter;
          if (alter && typeof alter.object === 'string' && (alter.anim !== undefined || alter.active !== undefined)) found.add(alter.object);
          Object.values(x).forEach(scan);
        }
      };
      scan(this.content.objects);
      scan(this.content.conversations);
      this.animatedSlugs = found;
    }
    return this.animatedSlugs.has(slug);
  }

  /** The talk distance in metres (the original's 180 pixels at full scale, unless the game says otherwise). */
  talkDistance(): number {
    return this.content.rules.talkDistance ?? 180 * 0.0125;
  }

  /** The condition of an object's rule group, from its key `<slug>/<verb>/<index>`. */
  groupCondition(key: string): Condition | undefined {
    const parts = key.split('/');
    if (parts.length !== 3) return undefined;
    const lists = this.content.objects[parts[0]]?.on as unknown as Record<string, { when?: Condition }[] | undefined> | undefined;
    return lists?.[parts[1]]?.[Number(parts[2])]?.when;
  }
}
