// SPDX-License-Identifier: GPL-3.0-or-later
// @vitest-environment happy-dom
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShipPort } from '../../web/shipPort';
import { Viewscreen } from './viewscreen';

describe('Viewscreen', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    root.remove();
  });
  const show = (view: { target: string | null; label: string } | null, plate: { areas: Record<string, [number, number, number, number]> } | null = null, screenRect = vi.fn()) => {
    root = document.body.appendChild(document.createElement('div'));
    act(() => { render(<Viewscreen port={{ viewscreen: () => view, shipPlate: () => plate, screenRect } as unknown as ShipPort} />, root); });
    return screenRect;
  };

  it('shows the hailing object while the viewscreen runs', () => {
    const screenRect = show({ target: 'w.planet', label: '-Zap-' });
    expect(root.querySelector('[aria-label="Viewscreen"]')?.textContent).toBe('-Zap-');
    // (the flat frame registers no box)
    expect(root.querySelector('.au-ship-screen')).toBeNull();
    expect(screenRect).not.toHaveBeenCalledWith(expect.any(Function));
  });

  it('shows nothing otherwise', () => {
    show(null);
    expect(root.querySelector('[aria-label="Viewscreen"]')).toBeNull();
  });

  it('with a plate the viewscreen registers a 4:3 box and puts the name in the name area; without one it is the flat frame as before', () => {
    const screenRect = show({ target: 'w.planet', label: '-Zap-' }, { areas: { name: [66, 386, 460, 90] } });
    const box = root.querySelector('.au-ship-screen') as HTMLElement;
    expect(box.style.aspectRatio).toMatch(/640\s*\/\s*480/);
    expect(screenRect).toHaveBeenCalledWith(expect.any(Function));
    const name = root.querySelector('.au-area[data-area="name"]') as HTMLElement;
    expect(name.textContent).toBe('-Zap-');
    expect(name.style.left).toBe(`${(66 / 640) * 100}%`);
    expect(name.style.top).toBe('80.4167%');
    expect(root.querySelector('.au-ship-viewscreen-frame')).toBeNull();
  });
});
