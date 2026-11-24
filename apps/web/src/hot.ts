// SPDX-License-Identifier: GPL-3.0-or-later
import type { GamePackage } from '@another-unity/engine/web';

interface ContentListener {
  changed(pkg: GamePackage): void;
  /** The game module threw building its new package: the session lists it and carries on. */
  failed(err: unknown): void;
}

let listener: ContentListener | null = null;

/** main.ts listens; a game module calls contentChanged when Vite hot-reloads its YAML. */
export function onContentChange(next: ContentListener): void {
  listener = next;
}

/** Builds the new package and passes it on, or passes on why it couldn't be built. */
export function contentChanged(build: () => GamePackage): void {
  if (!listener) return;
  let pkg: GamePackage;
  try {
    pkg = build();
  } catch (err) {
    listener.failed(err);
    return;
  }
  listener.changed(pkg);
}
