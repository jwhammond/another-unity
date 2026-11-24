// SPDX-License-Identifier: GPL-3.0-or-later
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cwebpArgs, toWebp } from './webp';

function fake(code: number, calls: { cmd: string; args: string[] }[]): (cmd: string, args: string[]) => ChildProcess {
  return (cmd, args) => {
    calls.push({ cmd, args });
    const c = new EventEmitter() as ChildProcess;
    (c as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    setTimeout(() => {
      (c.stderr as unknown as EventEmitter).emit('data', 'bad input');
      c.emit('close', code);
    }, 0);
    return c;
  };
}

describe('webp', () => {
  it('toWebp calls cwebp with the quality, and the alpha flags only for alpha images (mocked spawn)', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    await toWebp('a.png', 'a.webp', { quality: 90, spawnFn: fake(0, calls) });
    await toWebp('m.png', 'm.webp', { quality: 90, alpha: true, spawnFn: fake(0, calls) });
    expect(calls[0]).toEqual({ cmd: 'cwebp', args: ['-q', '90', '-m', '6', '-mt', '-quiet', 'a.png', '-o', 'a.webp'] });
    expect(calls[1]!.args).toEqual(expect.arrayContaining(['-alpha_q', '100', '-exact']));
    expect(cwebpArgs('x', 'y', { quality: 80 })).not.toContain('-exact');
  });
  it('a failing cwebp rejects with its message', async () => {
    await expect(toWebp('a.png', 'a.webp', { quality: 90, spawnFn: fake(1, []) })).rejects.toThrow(/cwebp exited 1: bad input/);
  });
});
