// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import type { CursorArt } from '../ui/faces';

const loaded = vi.hoisted(() => ({ sources: [] as unknown[], result: {} as Record<string, unknown> }));
vi.mock('../ui/cursors', async importOriginal => ({
  ...(await importOriginal<typeof import('../ui/cursors')>()),
  loadSpriteCursors: vi.fn(async (sources: unknown) => { loaded.sources.push(sources); return loaded.result; }),
}));
const { cursorCss } = await import('../ui/cursors');
const { exitCursorPort } = await import('./exitCursor');

describe('the pointer over astrogation\'s exits', () => {
  it('is the drawn lit use pointer without the original\'s pointers', () => {
    const bumps: string[] = [];
    const port = exitCursorPort({ cursorArt: () => undefined, bump: () => { bumps.push('bump'); } });
    expect(port.exitCursor()).toBe(cursorCss('use', {}, true));
    expect(port.exitCursor()).toContain('data:image/svg+xml');
    expect(bumps).toEqual([]);
    expect(loaded.sources).toEqual([]);
  });

  it('is the published use_lit picture (cursor.dat\'s frame 3) once it is scaled, with the use pointer\'s click point, and tells the panels when it is', async () => {
    loaded.sources.length = 0;
    loaded.result = { use_lit: { url: 'data:image/png;base64,LOADED', x: 66, y: 22 } };
    const bumps: string[] = [];
    const art: CursorArt = { scale: 4, sprite: name => `/${name}.webp`, hotspot: () => [33, 11] };
    const port = exitCursorPort({ cursorArt: () => art, bump: () => { bumps.push('bump'); } });
    // (the drawn one until the picture has loaded)
    expect(port.exitCursor()).toContain('data:image/svg+xml');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(bumps).toEqual(['bump']);
    expect(port.exitCursor()).toBe('url("data:image/png;base64,LOADED") 66 22, grab');
    // (loaded once, from the lit use picture, at the original's click point)
    expect(loaded.sources).toHaveLength(1);
    expect(JSON.stringify(loaded.sources[0])).toContain('/use_lit.webp');
    port.exitCursor();
    expect(loaded.sources).toHaveLength(1);
  });

  it('goes back to the drawn pointer when the art goes', async () => {
    loaded.result = { use_lit: { url: 'data:image/png;base64,LOADED', x: 1, y: 2 } };
    let art: CursorArt | undefined = { scale: 4, sprite: name => `/${name}.webp`, hotspot: () => [33, 11] };
    const port = exitCursorPort({ cursorArt: () => art, bump: () => {} });
    port.exitCursor();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(port.exitCursor()).toContain('LOADED');
    art = undefined;
    expect(port.exitCursor()).toContain('data:image/svg+xml');
  });
});
