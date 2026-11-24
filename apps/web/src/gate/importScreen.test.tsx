// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHECK_PLAINTEXT, deriveGateKey, deriveIvKey, seal } from './crypto';
import { folderSource, rangeDigests } from './disc';
import { ImportScreen, WRONG_FILES } from './importScreen';
import type { GateParams } from './params';
import { fakeFiles } from './testDisc';

// (made-up files, ranges and salt: no real gate parameters)
const bytes = (n: number, k: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * k + 7) & 255);
const params: GateParams = {
  version: 1, salt: Uint8Array.from({ length: 32 }, (_, i) => i),
  ranges: [{ path: 'ONE.DAT', offset: 5000, length: 65536 }, { path: 'TWO.DAT', offset: 6000, length: 65536 }, { path: 'THREE.DAT', offset: 7000, length: 65536 }],
};
const disc = { 'one.dat': bytes(80000, 3), 'two.dat': bytes(80000, 5), 'three.dat': bytes(80000, 11) };
let check: Uint8Array;

beforeAll(async () => {
  const d = await rangeDigests(folderSource(fakeFiles(disc)), params);
  check = await seal(await deriveGateKey(d, params.salt), await deriveIvKey(d, params.salt), 'check', new TextEncoder().encode(CHECK_PLAINTEXT));
});

/** Picks `files` on an input, as the browser's file chooser does. */
function pick(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('ImportScreen', () => {
  let root: HTMLElement;
  const realMatch = window.matchMedia;
  afterEach(() => {
    act(() => { render(null, root); });
    root.remove();
    window.matchMedia = realMatch;
  });

  function show(props: { onUnlocked?: (key: CryptoKey) => void; workerSupported?: boolean } = {}) {
    root = document.body.appendChild(document.createElement('div'));
    act(() => {
      render(<ImportScreen params={params} check={check} onUnlocked={props.onUnlocked ?? (() => {})} workerSupported={props.workerSupported ?? true} />, root);
    });
    return {
      folder: root.querySelector<HTMLInputElement>('[data-gate=folder]'),
      image: root.querySelector<HTMLInputElement>('[data-gate=image]'),
      message: () => root.querySelector('[data-gate=message]')!.textContent,
    };
  }

  it('a folder of the right files unlocks and calls onUnlocked', async () => {
    const onUnlocked = vi.fn();
    const s = show({ onUnlocked });
    expect(root.querySelector('[data-gate=screen]')).not.toBeNull();
    expect(root.textContent).toContain('Your files stay on this device. Nothing is uploaded.');
    pick(s.folder!, fakeFiles(disc, 'MyCd'));
    await vi.waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect((onUnlocked.mock.calls[0]![0] as CryptoKey).type).toBe('secret');
  });

  it('wrong files show the exact message', async () => {
    const onUnlocked = vi.fn();
    const s = show({ onUnlocked });
    pick(s.folder!, fakeFiles({ ...disc, 'two.dat': bytes(80000, 13) }));
    await vi.waitFor(() => expect(s.message()).toBe("These don't look like the A Final Unity CD."));
    expect(WRONG_FILES).toBe("These don't look like the A Final Unity CD.");
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('a folder without the files says so', async () => {
    const s = show();
    pick(s.folder!, fakeFiles({ 'other.txt': bytes(10, 1) }));
    await vi.waitFor(() => expect(s.message()).toBe("This folder doesn't have the CD's files."));
  });

  it('a BIN alone asks for the CUE', async () => {
    const s = show();
    pick(s.image!, [new File([bytes(4096, 1) as BlobPart], 'disc.bin')]);
    await vi.waitFor(() => expect(s.message()).toBe('Choose the .cue file with the .bin.'));
    pick(s.image!, [new File(['FILE "disc.bin" BINARY\n'], 'disc.cue')]);
    await vi.waitFor(() => expect(s.message()).toBe('Choose the .bin file with the .cue.'));
  });

  it('a phone shows only the disc image choice', () => {
    window.matchMedia = ((q: string) => ({ matches: q.includes('pointer: coarse'), media: q })) as unknown as typeof window.matchMedia;
    const s = show();
    expect(s.folder).toBeNull();
    expect(s.image).not.toBeNull();
    expect(s.image!.accept).toBe('.iso,.bin,.cue');
    expect(s.image!.multiple).toBe(true);
  });

  it('without a worker the choices are disabled and the demo line shows', () => {
    const s = show({ workerSupported: false });
    expect(s.folder!.disabled).toBe(true);
    expect(s.image!.disabled).toBe(true);
    expect(s.message()).toBe("This browser can't play the protected game. The demo still plays.");
  });
});
