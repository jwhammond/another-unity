// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { primeMedia } from '../media';
import { BeforeAfter } from './BeforeAfter';
import { SpriteSheet } from './SpriteSheet';

afterEach(() => { document.body.innerHTML = ''; });

const manifest = {
  version: 1 as const, built: 't',
  items: {
    'room.lab.s01': { src: '/site-media/a.webp', pairSrc: '/site-media/b.webp', w: 960, h: 600, alt: 'A lab', kind: 'pair' as const },
    'portrait.picard': { src: '/site-media/p-orig.webp', pairSrc: '/site-media/p.webp', w: 256, h: 256, alt: 'Picard', kind: 'portrait' as const },
    'sheet.picard': { src: '/site-media/s.webp', w: 960, h: 200, alt: 'Picard frames', kind: 'sheet' as const },
  },
};
const mount = async (ui: preact.VNode) => {
  const root = document.createElement('div'); document.body.append(root);
  await act(async () => { render(ui, root); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return root;
};

describe('BeforeAfter', () => {
  it('stacks both pictures with a slider that clips the remastered one', async () => {
    primeMedia(manifest);
    const root = await mount(<BeforeAfter id="room.lab.s01" before="Original" after="Remastered" />);
    const imgs = root.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0]!.getAttribute('src')).toBe('/site-media/a.webp');
    expect(imgs[1]!.getAttribute('src')).toBe('/site-media/b.webp');
    const slider = root.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.getAttribute('aria-label')).toBe('Compare original and remastered: lab s01');
    expect([slider.min, slider.max, slider.step]).toEqual(['0', '100', '1']);
    await act(async () => { slider.value = '30'; slider.dispatchEvent(new Event('input', { bubbles: true })); });
    expect((root.querySelectorAll('img')[1] as HTMLElement).style.clipPath).toBe('inset(0 0 0 30%)');
  });
  it('shows the original on the left and the remake on the right, as the captions say', async () => {
    primeMedia(manifest);
    const root = await mount(<BeforeAfter id="room.lab.s01" before="Original" after="Remastered" />);
    const [orig, remake] = [...root.querySelectorAll('img')] as HTMLElement[];
    const [left, right] = [...root.querySelectorAll('figcaption span')].map(s => s.textContent);
    expect([left, right]).toEqual(['Original', 'Remastered']);
    expect(orig!.getAttribute('src')).toBe('/site-media/a.webp');
    expect(orig!.style.clipPath).toBe('');
    // (the remake covers only what is right of the handle, at 50 to start)
    expect(remake!.style.clipPath).toBe('inset(0 0 0 50%)');
    expect((root.querySelector('.lc-ba-edge') as HTMLElement).style.left).toBe('50%');
  });
  it('names each slider for its picture', async () => {
    primeMedia(manifest);
    const p = await mount(<BeforeAfter id="portrait.picard" before="Original" after="Remastered" />);
    expect(p.querySelector('input')!.getAttribute('aria-label')).toBe('Compare original and remastered: picard');
  });
  it('moves by 5 on an arrow key', async () => {
    primeMedia(manifest);
    const root = await mount(<BeforeAfter id="room.lab.s01" before="Original" after="Remastered" />);
    const slider = root.querySelector('input[type="range"]') as HTMLInputElement;
    const start = Number(slider.value);
    await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); });
    expect(Number(slider.value)).toBe(start + 5);
    await act(async () => { slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })); });
    expect(Number(slider.value)).toBe(start);
  });
  it('pixelates only the original-scale portrait head', async () => {
    primeMedia(manifest);
    const p = await mount(<BeforeAfter id="portrait.picard" before="Original" after="Remastered" />);
    expect((p.querySelectorAll('img')[0] as HTMLElement).style.imageRendering).toBe('pixelated');
    expect((p.querySelectorAll('img')[1] as HTMLElement).style.imageRendering).not.toBe('pixelated');
    const r = await mount(<BeforeAfter id="room.lab.s01" before="Original" after="Remastered" />);
    expect((r.querySelectorAll('img')[0] as HTMLElement).style.imageRendering).not.toBe('pixelated');
  });
  it('is one placeholder when the entry is missing', async () => {
    primeMedia(manifest);
    const root = await mount(<BeforeAfter id="room.nope.s01" before="Original" after="Remastered" />);
    expect(root.querySelectorAll('.lc-noimg').length).toBe(1);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('input')).toBeNull();
  });
});

describe('SpriteSheet', () => {
  it('shows the sheet pixelated with its caption', async () => {
    primeMedia(manifest);
    const root = await mount(<SpriteSheet id="sheet.picard" caption="Picard, the first animation" />);
    expect((root.querySelector('img') as HTMLElement).style.imageRendering).toBe('pixelated');
    expect(root.querySelector('figcaption')?.textContent).toBe('Picard, the first animation');
  });
});
