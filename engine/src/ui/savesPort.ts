// SPDX-License-Identifier: GPL-3.0-or-later
import type { SaveMeta } from './saves';

export { NAME_MAX, SLOTS, validNameChar } from './saves';

/** What the admin console's LOAD and SAVE need from the session. */
export interface SavesPort {
  gameId: string;
  list(): Promise<SaveMeta[]>;
  /** Saving, loading and importing are only possible while nothing is happening. */
  canSave(): boolean;
  /** Why the game can't be saved now, when the game says (a battle: save.cpp:156-159); null otherwise. */
  refusal?(): string | null;
  /** Saves to slot 1-9 under a name (cut to NAME_MAX; blank saves as `Save Game N`). */
  save(slot: number, name: string): Promise<void>;
  load(slot: number): Promise<void>;
  exportText(): string;
  importText(text: string): Promise<void>;
}
