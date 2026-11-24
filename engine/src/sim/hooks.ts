// SPDX-License-Identifier: GPL-3.0-or-later
import type { ActionContext, World } from './world';

/** Game code for behavior the original hardcoded; returns result flags. */
export type Hook = (world: World, ctx: ActionContext, args: Record<string, unknown>) => number | Promise<number>;

export class NotPorted extends Error {
  constructor(readonly hook: string) {
    super(`hook not ported: ${hook}`);
    this.name = 'NotPorted';
  }
}

export class HookRegistry {
  private readonly hooks = new Map<string, Hook>();

  register(name: string, hook: Hook): void {
    if (this.hooks.has(name)) throw new Error(`hook registered twice: ${name}`);
    this.hooks.set(name, hook);
  }

  get(name: string): Hook {
    const hook = this.hooks.get(name);
    if (!hook) throw new NotPorted(name);
    return hook;
  }
}
