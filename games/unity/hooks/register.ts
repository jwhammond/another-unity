// SPDX-License-Identifier: GPL-3.0-or-later
import type { HookRegistry } from '@another-unity/engine';
import { hooks } from './generated';

/** Registers every hook A Final Unity's content calls: ported ones, and stubs that throw NotPorted. */
export function registerUnityHooks(registry: HookRegistry): void {
  for (const name of Object.keys(hooks).sort()) registry.register(name, hooks[name]);
}

/** The name tools load a game's hooks by at run time (tools/tracediff's loadGameHooks). */
export const registerHooks = registerUnityHooks;
