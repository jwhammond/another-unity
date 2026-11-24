// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { AssetIndex } from '../view/assets';
import { parsePresentation } from '../view/package';
import { ADMIN_BUTTONS, ADMIN_FRAMES, adminArtFromPresentation, ASTRO_MAP_SPRITES, ASTRO_PANEL_SPRITES, facesFromPresentation } from './faces';

const assets = new AssetIndex([
  ['art/avatars/picard.webp', '/u/picard.webp'],
  ['art/icons/communicator.webp', '/u/badge.webp'],
  ['art/icons/phaser.webp', '/u/phaser.webp'],
]);
const config = parsePresentation(`art:
  portraits:
    picard: art/avatars/picard.webp
    riker: art/avatars/missing.webp
  icons:
    communicator: art/icons/communicator.webp
    phaser: art/icons/phaser.webp
`);

describe('the presentation schema', () => {
  it('has no portraits or icons without them, and reads them by object id', () => {
    expect(parsePresentation('').art.portraits).toBeUndefined();
    expect(config.art.portraits?.picard).toBe('art/avatars/picard.webp');
    expect(config.art.icons?.phaser).toBe('art/icons/phaser.webp');
  });
  it('refuses a portrait that is not a path', () => {
    expect(() => parsePresentation('art:\n  portraits:\n    picard: 3\n')).toThrow();
  });
});

describe('facesFromPresentation', () => {
  const faces = facesFromPresentation(config, assets, 'communicator');

  it('gives a crew member their portrait and an item its icon', () => {
    expect(faces.portrait('picard')).toBe('/u/picard.webp');
    expect(faces.icon('phaser')).toBe('/u/phaser.webp');
    expect(faces.combadge()).toBe('/u/badge.webp');
  });

  it('has nothing for an id with no entry, or whose file is not there', () => {
    expect(faces.portrait('data')).toBeUndefined();
    expect(faces.portrait('riker')).toBeUndefined();
    expect(faces.icon('med_kit')).toBeUndefined();
    expect(faces.portrait('constructor')).toBeUndefined();
  });

  it("shows a speaker's portrait, and the combadge as a placeholder for anyone without one", () => {
    expect(faces.speaker('picard')).toEqual({ url: '/u/picard.webp', placeholder: false });
    for (const who of ['computer_voice', 'riker', 'some_npc', 'ff']) expect(faces.speaker(who)).toEqual({ url: '/u/badge.webp', placeholder: true });
  });

  it("shows an item's icon for a speaker that is an item (the tricorder), a portrait first", () => {
    expect(faces.speaker('phaser')).toEqual({ url: '/u/phaser.webp', placeholder: false });
    const both = facesFromPresentation(parsePresentation('art:\n  portraits:\n    phaser: art/avatars/picard.webp\n  icons:\n    phaser: art/icons/phaser.webp\n'), assets, 'communicator');
    expect(both.speaker('phaser')).toEqual({ url: '/u/picard.webp', placeholder: false });
  });

  it('shows nothing for a speaker when there is neither a portrait nor a combadge icon', () => {
    expect(facesFromPresentation(parsePresentation(''), assets, 'communicator').speaker('picard')).toBeUndefined();
    expect(facesFromPresentation(config, assets, undefined).speaker('data')).toBeUndefined();
  });
});

describe('the astrogation course panel sprites (art.astro)', () => {
  const NAMES = ['faster_warp', 'faster_warp_down', 'faster_impulse', 'faster_impulse_down', 'slower', 'slower_down', 'engage', 'engage_down', 'stop', 'stop_down'];
  const yaml = (names: string[]) => `art:\n  astro:\n    scale: 4\n    sprites:\n${names.map(n => `      ${n}: { image: art/astro/${n}.webp, rect: [392, 161, 245, 29] }`).join('\n')}\n`;
  const index = (names: string[]) => new AssetIndex(names.map(n => [`art/astro/${n}.webp`, `/a/${n}.webp`]));

  it('gives each sprite its image and the original\'s rectangle, when every one is published', () => {
    const a = facesFromPresentation(parsePresentation(yaml(NAMES)), index(NAMES), undefined).astro();
    expect(a?.sprite('engage_down')).toEqual({ url: '/a/engage_down.webp', rect: [392, 161, 245, 29] });
    expect(a?.sprite('faster_impulse').url).toBe('/a/faster_impulse.webp');
  });
  it('has none without art.astro, or with a sprite missing or its file not in the package', () => {
    expect(facesFromPresentation(config, assets, undefined).astro()).toBeUndefined();
    expect(facesFromPresentation(parsePresentation(yaml(NAMES.slice(1))), index(NAMES), undefined).astro()).toBeUndefined();
    expect(facesFromPresentation(parsePresentation(yaml(NAMES)), index(NAMES.slice(1)), undefined).astro()).toBeUndefined();
  });
});

describe('the astrogation map\'s pictures and tables (art.astro)', () => {
  const yaml = (names: readonly string[], tables = '') => `art:\n  astro:\n    scale: 4\n${tables}    sprites:${names.length === 0 ? ' {}' : ''}\n${names.map(n => `      ${n}: { image: art/astro/${n}.webp, rect: [0, 0, 22, 20] }`).join('\n')}\n`;
  const index = (names: readonly string[]) => new AssetIndex(names.map(n => [`art/astro/${n}.webp`, `/a/${n}.webp`]));

  it('gives each picture its image and size, with the scale, when all of them are published', () => {
    const m = facesFromPresentation(parsePresentation(yaml(ASTRO_MAP_SPRITES)), index(ASTRO_MAP_SPRITES), undefined).astroMap();
    expect(m?.scale).toBe(4);
    expect(m?.sprite('planet9')).toEqual({ url: '/a/planet9.webp', width: 22, height: 20 });
    expect(m?.sprite('star_class6').url).toBe('/a/star_class6.webp');
  });
  it('has none without art.astro, or with one missing or its file not in the package, and the map then draws shapes', () => {
    expect(facesFromPresentation(config, assets, undefined).astroMap()).toBeUndefined();
    expect(facesFromPresentation(parsePresentation(yaml(ASTRO_MAP_SPRITES.slice(1))), index(ASTRO_MAP_SPRITES), undefined).astroMap()).toBeUndefined();
    expect(facesFromPresentation(parsePresentation(yaml(ASTRO_MAP_SPRITES)), index(ASTRO_MAP_SPRITES.slice(1)), undefined).astroMap()).toBeUndefined();
  });
  it('gives the info and display tabs\' own pictures when they are published, and the course panel works without them', () => {
    const COURSE = ['faster_warp', 'faster_warp_down', 'faster_impulse', 'faster_impulse_down', 'slower', 'slower_down', 'engage', 'engage_down', 'stop', 'stop_down'];
    const all = [...COURSE, ...ASTRO_PANEL_SPRITES];
    expect(facesFromPresentation(parsePresentation(yaml(all)), index(all), undefined).astro()?.panel('display_bottom')).toEqual({ url: '/a/display_bottom.webp', rect: [0, 0, 22, 20] });
    const without = facesFromPresentation(parsePresentation(yaml(COURSE)), index(COURSE), undefined).astro();
    expect(without?.panel('display_bottom')).toBeUndefined();
    expect(without?.sprite('stop').url).toBe('/a/stop.webp');
  });
  it('reads the tables the executable has, and rejects ones that are not what the schema says', () => {
    const tables = `    tables:\n      labels: [A, B]\n      messages: [M]\n      alignmentTexts: [T]\n      alignmentColours: ['#44a0ec']\n      magnitudes: [-20, 5]\n      numerals: [I, II]\n      planetDescriptions: [D]\n      planetSizes: [{ radius: 18, spacing: 30 }]\n      colours: { grid: '#606060' }\n`;
    const t = facesFromPresentation(parsePresentation(yaml([], tables)), index([]), undefined).astroTables();
    expect(t?.labels).toEqual(['A', 'B']);
    expect(t?.planetSizes).toEqual([{ radius: 18, spacing: 30 }]);
    expect(t?.colours.grid).toBe('#606060');
    expect(facesFromPresentation(config, assets, undefined).astroTables()).toBeUndefined();
    expect(() => parsePresentation(yaml([], tables.replace('#606060', 'grey')))).toThrow();
    expect(() => parsePresentation(yaml([], tables.replace('numerals: [I, II]', 'numerals: 3')))).toThrow();
  });
});

describe('the transporter room\'s console sprites (art.transporter)', () => {
  const NAMES = ['up', 'up_grey', 'down', 'down_grey', 'left', 'left_grey', 'right', 'right_grey', 'kit_slot', 'lists', 'lists_on', 'map', 'map_on'];
  const yaml = (names: string[]) => `art:\n  transporter:\n    scale: 4\n    sprites:\n${names.map(n => `      ${n}: { image: art/transporter/${n}.webp, rect: [210, 359, 48, 23] }`).join('\n')}\n`;
  const index = (names: string[]) => new AssetIndex(names.map(n => [`art/transporter/${n}.webp`, `/t/${n}.webp`]));

  it('gives each sprite its image and the original\'s rectangle, when every one is published', () => {
    const t = facesFromPresentation(parsePresentation(yaml(NAMES)), index(NAMES), undefined).transporter();
    expect(t?.sprite('up_grey')).toEqual({ url: '/t/up_grey.webp', rect: [210, 359, 48, 23] });
    expect(t?.sprite('map_on').url).toBe('/t/map_on.webp');
  });
  it('has none without art.transporter, or with a sprite missing or its file not in the package', () => {
    expect(facesFromPresentation(config, assets, undefined).transporter()).toBeUndefined();
    expect(facesFromPresentation(parsePresentation(yaml(NAMES.slice(1))), index(NAMES), undefined).transporter()).toBeUndefined();
    expect(facesFromPresentation(parsePresentation(yaml(NAMES)), index(NAMES.slice(1)), undefined).transporter()).toBeUndefined();
  });
  describe('the map\'s pictures', () => {
    const MAP = ['map_world_0', 'map_world_1', 'map_world_2', 'scan_across', 'scan_down', 'blip_0', 'blip_1'];
    const withMap = (names: string[], extra = '') => yaml(names).replace('scale: 4\n', `scale: 4\n${extra}`);
    it('gives a picture for each world, the scan\'s two lines and the blip\'s frames with their wait', () => {
      const names = [...NAMES, ...MAP];
      const map = facesFromPresentation(parsePresentation(withMap(names, '    blipMs: 100\n')), index(names), undefined).transporter()?.map();
      expect(map?.world(2)?.url).toBe('/t/map_world_2.webp');
      expect(map?.world(3)).toBeUndefined();
      expect(map?.across.url).toBe('/t/scan_across.webp');
      expect(map?.blip.frames.map(f => f.url)).toEqual(['/t/blip_0.webp', '/t/blip_1.webp']);
      expect(map?.blip.ms).toBe(100);
    });
    it('is a hundred milliseconds a frame without a recorded wait, and absent when a picture is missing (the console\'s sprites still work)', () => {
      const names = [...NAMES, ...MAP];
      expect(facesFromPresentation(parsePresentation(withMap(names)), index(names), undefined).transporter()?.map()?.blip.ms).toBe(100);
      const without = names.filter(n => n !== 'scan_down');
      const t = facesFromPresentation(parsePresentation(withMap(without)), index(without), undefined).transporter();
      expect(t?.map()).toBeUndefined();
      expect(t?.sprite('map').url).toBe('/t/map.webp');
      expect(facesFromPresentation(parsePresentation(yaml(NAMES)), index(NAMES), undefined).transporter()?.map()).toBeUndefined();
    });
  });
});

describe('the admin console\'s pictures (art.admin)', () => {
  const frames = Array.from({ length: ADMIN_FRAMES }, (_, i) => `art/admin/frame${i}.webp`);
  const buttons = ADMIN_BUTTONS.map(b => `art/admin/${b}.webp`);
  const paths = [...frames, ...buttons, 'art/admin/final.webp', 'art/admin/settings.webp', 'art/admin/settingsLit.webp', 'art/admin/frame0.hd.webp', 'art/admin/final.hd.webp'];
  const index = new AssetIndex(paths.map(p => [p, `/u/${p.slice('art/admin/'.length)}`]));
  const yaml = (hd: string) => `art:\n  admin:\n    scale: 4\n    frames: [${frames.join(', ')}]\n    buttons: { ${ADMIN_BUTTONS.map(b => `${b}: art/admin/${b}.webp`).join(', ')} }\n    final: art/admin/final.webp\n    settings: art/admin/settings.webp\n    settingsLit: art/admin/settingsLit.webp\n${hd}`;

  it('shows the HD repaints of the console\'s body and the F1 screen with the art on, and the original\'s with it off (Plan 32 Task 12)', () => {
    const c = parsePresentation(yaml('    hd: { frame0: art/admin/frame0.hd.webp, final: art/admin/final.hd.webp }\n'));
    const on = adminArtFromPresentation(c, index, true)!, off = adminArtFromPresentation(c, index, false)!;
    expect([on.frame(0), on.final, on.frame(1)]).toEqual(['/u/frame0.hd.webp', '/u/final.hd.webp', '/u/frame1.webp']);
    expect([off.frame(0), off.final]).toEqual(['/u/frame0.webp', '/u/final.webp']);
    expect(adminArtFromPresentation(c, index)!.frame(0)).toBe('/u/frame0.webp');
    // (the HD body has its groove painted out: no cover)
    expect([on.bodyHd, off.bodyHd]).toEqual([true, undefined]);
  });
  it('keeps the original\'s where no repaint is published, or its file is not there', () => {
    const none = adminArtFromPresentation(parsePresentation(yaml('')), index, true)!;
    expect([none.frame(0), none.final]).toEqual(['/u/frame0.webp', '/u/final.webp']);
    const missing = adminArtFromPresentation(parsePresentation(yaml('    hd: { frame0: art/admin/gone.webp }\n')), index, true)!;
    expect([missing.frame(0), missing.final, missing.bodyHd, none.bodyHd]).toEqual(['/u/frame0.webp', '/u/final.webp', undefined, undefined]);
  });
  it('shows the screen\'s pages in HD with the art on, each where published and there, and the original\'s otherwise (Plan 33 Task 7)', () => {
    const pages = [1, 2, 3, 5].map(i => `art/admin/frame${i}.hd.webp`);
    const idx = new AssetIndex([...paths, ...pages].map(p => [p, `/u/${p.slice('art/admin/'.length)}`]));
    // (frame4's HD file is not there)
    const c = parsePresentation(yaml('    hd: { frame1: art/admin/frame1.hd.webp, frame2: art/admin/frame2.hd.webp, frame3: art/admin/frame3.hd.webp, frame4: art/admin/frame4.hd.webp, frame5: art/admin/frame5.hd.webp }\n'));
    const on = adminArtFromPresentation(c, idx, true)!, off = adminArtFromPresentation(c, idx, false)!;
    expect([1, 2, 3, 4, 5].map(i => on.frame(i))).toEqual(['/u/frame1.hd.webp', '/u/frame2.hd.webp', '/u/frame3.hd.webp', '/u/frame4.webp', '/u/frame5.hd.webp']);
    expect([0, 1, 2, 3, 4, 5].map(i => off.frame(i))).toEqual(frames.map(f => `/u/${f.slice('art/admin/'.length)}`));
    // (pages alone leave the body the original's, with its groove cover)
    expect([on.frame(0), on.bodyHd]).toEqual(['/u/frame0.webp', undefined]);
  });
});
