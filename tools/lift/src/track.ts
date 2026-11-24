// SPDX-License-Identifier: GPL-3.0-or-later
import { LiftError } from './problems';
import type { RawIR } from './raw';

/**
 * Keys that are numbers or object ids belong to records; they all count as one field.
 * Limit: this is by shape, so a named field that is all digits or six hex characters
 * (say `abcdef`) would fold into `*` too. The IR has none today.
 */
const RECORD_KEY = /^(\d+|[0-9a-f]{6})$/;

export function keyPath(parent: string, key: string): string {
  return `${parent}.${RECORD_KEY.test(key) ? '*' : key}`;
}

function isEntry(value: unknown): value is { class: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { class?: unknown }).class === 'string';
}

/** An array element's path: an entry's own kind, else the array's path with []. */
export function elementPath(parent: string, element: unknown): string {
  return isEntry(element) ? `entry:${element.class}` : `${parent}[]`;
}

/** Every field kind in a value. A path in `skip` is listed, but what's under it isn't. */
export function fieldPaths(value: unknown, path: string, out = new Set<string>(), skip: ReadonlySet<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) fieldPaths(element, elementPath(path, element), out, skip);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      const p = keyPath(path, key);
      out.add(p);
      if (!skip.has(p)) fieldPaths(child, p, out, skip);
    }
  }
  return out;
}

/** Wraps IR values so that every field read is recorded by kind (see fieldPaths). */
export class FieldTracker {
  readonly used = new Set<string>();
  private readonly proxies = new WeakMap<object, unknown>();

  track<T>(value: T, path: string): T {
    if (typeof value !== 'object' || value === null) return value;
    const known = this.proxies.get(value);
    if (known) return known as T;
    const tracker = this;
    const proxy = new Proxy(value, {
      get(target, key, receiver) {
        const child: unknown = Reflect.get(target, key, receiver);
        if (typeof key !== 'string') return child;
        if (Array.isArray(target)) return /^\d+$/.test(key) ? tracker.track(child, elementPath(path, child)) : child;
        if (!Object.prototype.hasOwnProperty.call(target, key)) return child;
        const p = keyPath(path, key);
        tracker.used.add(p);
        return tracker.track(child, p);
      },
      // Spread, Object.keys/entries/values and JSON.stringify enumerate without naming
      // fields, which would count them all as read. Only records (every key an id or
      // number) and arrays may be enumerated; a block's fields must be read by name.
      ownKeys(target) {
        const keys = Reflect.ownKeys(target);
        if (!Array.isArray(target) && !keys.every(k => typeof k === 'string' && RECORD_KEY.test(k))) {
          throw new LiftError([`tracked IR value enumerated at ${path}; read fields explicitly`]);
        }
        return keys;
      },
    });
    this.proxies.set(value, proxy);
    return proxy;
  }

  /** The same IR, with every value tracked (the Maps are new; their values are proxies). */
  trackRaw(raw: RawIR): RawIR {
    const map = <T>(m: Map<string, T>, root: string) => new Map([...m].map(([k, v]) => [k, this.track(v, root)] as const));
    return {
      manifest: this.track(raw.manifest, 'manifest'),
      objects: map(raw.objects, 'object'),
      conversations: map(raw.conversations, 'conversation'),
      screens: map(raw.screens, 'screen'),
      worlds: map(raw.worlds, 'world'),
      triggers: this.track(raw.triggers, 'triggers'),
      movies: this.track(raw.movies, 'maps.movie'),
      sprites: this.track(raw.sprites, 'maps.sprite'),
      executable: this.track(raw.executable, 'executable'),
      ...(raw.computer ? { computer: raw.computer } : {}),
      ...(raw.compstat ? { compstat: raw.compstat } : {}),
      ...(raw.astro ? { astro: raw.astro } : {}),
      ...(raw.sectorNames ? { sectorNames: raw.sectorNames } : {}),
      ...(raw.astStat ? { astStat: raw.astStat } : {}),
      ...(raw.screenTexts ? { screenTexts: raw.screenTexts } : {}),
      ...(raw.combat ? { combat: this.track(raw.combat, 'combat') } : {}),
      // (every value is read: the whole table goes into combat.yaml)
      ...(raw.trig ? { trig: raw.trig } : {}),
      ...(raw.space ? { space: raw.space } : {}),
    };
  }
}
