// SPDX-License-Identifier: GPL-3.0-or-later
export interface SaveMeta {
  slot: number;
  label: string;
  screen: string;
  savedAt: number;
}

interface SaveRecord extends SaveMeta {
  key: string;
  game: string;
  text: string;
}

/** The save slots 1-9 the console offers (slot 0 is the autosave). */
export const SLOTS = 9;

/** A save's name is at most this long (the original's admin console: 30 characters). */
export const NAME_MAX = 30;

/** Characters the original's name box refuses: the set @ [ \ ] ^ _ ` { | } ~ and anything outside printable ASCII. */
export function validNameChar(c: string): boolean {
  if (c.length !== 1) return false;
  const code = c.charCodeAt(0);
  // (the console's pixel font has the printable ASCII only)
  if (code < 0x20 || code > 0x7e) return false;
  return !'@[\\]^_`{|}~'.includes(c);
}

/** What a typed name saves as: refused characters dropped, cut to NAME_MAX; blank becomes `Save Game N`. */
export function saveName(slot: number, typed: string): string {
  const kept = Array.from(typed).filter(validNameChar).join('').slice(0, NAME_MAX);
  return kept.trim() === '' ? `Save Game ${slot}` : kept;
}

/**
 * A stored save's name as the console shows it: the label, if it is one the name box could have taken (no refused character, at most NAME_MAX);
 * otherwise `Save Game <slot>`. Saves from before the console (Plan 32) are labelled with a screen id and a locale date, which can hold
 * characters the console's font lacks (U+202F).
 */
export function shownName(slot: number, label: string): string {
  const valid = label.length <= NAME_MAX && label.trim() !== '' && Array.from(label).every(validNameChar);
  return valid ? label : `Save Game ${slot}`;
}

const DB_NAME = 'another-unity';
const STORE = 'saves';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A game's save slots in IndexedDB (spec §7.1: saves are serialized state, kept in IndexedDB). */
export class SaveSlots {
  private constructor(private readonly db: IDBDatabase, readonly game: string) {}

  static async open(game: string, idb: IDBFactory = indexedDB): Promise<SaveSlots> {
    const request = idb.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    return new SaveSlots(await done(request), game);
  }

  async list(): Promise<SaveMeta[]> {
    const all = (await done(this.store('readonly').getAll())) as SaveRecord[];
    return all
      .filter(r => r.game === this.game)
      .map(({ slot, label, screen, savedAt }) => ({ slot, label, screen, savedAt }))
      .sort((a, b) => a.slot - b.slot);
  }

  async put(slot: number, text: string, meta: Omit<SaveMeta, 'slot'>): Promise<void> {
    const record: SaveRecord = { key: this.key(slot), game: this.game, slot, text, ...meta };
    await done(this.store('readwrite').put(record));
  }

  async get(slot: number): Promise<string | undefined> {
    const record = (await done(this.store('readonly').get(this.key(slot)))) as SaveRecord | undefined;
    return record?.text;
  }

  async remove(slot: number): Promise<void> {
    await done(this.store('readwrite').delete(this.key(slot)));
  }

  private key(slot: number): string {
    return `${this.game}/${slot}`;
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }
}

/** Offers a save as a file to keep (spec §7.1: exportable as a file). */
export function exportSave(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // (some browsers start the download after click returns: free the link a moment later, not at once)
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
