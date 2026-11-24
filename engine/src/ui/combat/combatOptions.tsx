// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AstroFonts } from '../../view/bitmapText';
import { BINDABLE_ACTIONS, DEFAULT_KEYS, type BindableAction } from '../../view/combat/bindings';
import { PREVIEW_RECT } from '../../view/combat/optionsPreview';
import { DEFAULT_SETTINGS, type CombatOptions as Options, type Settings } from '../../web/settings';
import type { SettingsPort } from '../../web/settingsPort';
import { BitmapWords, errorText, INK, KEYS_FONT, LIT, modalKey, useModal, type Rect, type Rgb } from '../admin/parts';
import { ACTION_NAMES, guardKeyUp, keyName, keyRowName, offerKey, useRebinding } from '../admin/rebinding';
import { areaStyle as area } from '../ship/areas';

/** areaStyle for the console's readonly rectangles. */
const areaStyle = (r: Rect) => area([...r] as [number, number, number, number]);

/**
 * Tactical's F1 Combat Options (Plan 32 Task 11): the original's options screen (help.cpp 0x98042, tactical_hooks_ui.md §8), modal over the battle.
 * final.spr, 562 by 334, at (39,84) of the 640 by 480 screen, with its controls where the original takes them: the stars, resolution and radar rows'
 * Off/On cells, the Detail cycle box, the sixteen rebindable keys, DEFAULT, CANCEL and USE, and the 3D preview's window (399,128)-(547,269), left
 * open for the session to draw the Enterprise in with the options chosen. Without the picture, CSS stand-ins at the same places, with the same names.
 *
 * The values are the settings record's, the admin console's SETTINGS page's own (COMBAT and KEYS): a change is kept at once, so the preview and the
 * console show it. CANCEL puts back what the screen opened with, and closes; USE closes; DEFAULT gives the original's values; F1 and Esc close it.
 * Every rectangle is in the original's 640 by 480 screen.
 */

/** final.spr's place: centred across the screen, at y 84 (its preview window then falls on (399,128)-(547,269)). */
const PICTURE: Rect = [39, 84, 562, 334];
const PREVIEW: Rect = [PREVIEW_RECT.x, PREVIEW_RECT.y, PREVIEW_RECT.width, PREVIEW_RECT.height];
/**
 * The screen's face (black, then the picture) with the preview's window cut out of it, so the space view's canvas under the page shows there: the
 * whole screen, then the window, the even-odd rule leaving the window open.
 */
const FACE_CLIP = (() => {
  const [x, y, w, h] = PREVIEW;
  const l = `${(x / 640) * 100}%`, r = `${((x + w) / 640) * 100}%`, t = `${(y / 480) * 100}%`, b = `${((y + h) / 480) * 100}%`;
  return `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l} ${t}, ${r} ${t}, ${r} ${b}, ${l} ${b}, ${l} ${t})`;
})();
/** A cell of a row from the notes' corners (inclusive). */
const span = (x1: number, y1: number, x2: number, y2: number): Rect => [x1, y1, x2 - x1 + 1, y2 - y1 + 1];
/** The Off/On rows: y 131..144, 173..186 and 215..228; Off x 279..324, On x 325..371 (tactical_hooks_ui.md §8). */
const ROWS = { stars: 131, resolution: 173, radar: 215 } as const;
const cell = (row: number, on: boolean): Rect => (on ? span(325, row, 371, row + 13) : span(279, row, 324, row + 13));
/** The Detail cycle box (x 411..537, y 282..310): its heading and, under it, the value's row (final.spr's lighter band). */
const DETAIL = span(411, 282, 537, 310);
const DETAIL_VALUE: Rect = [411, 298, 127, 13];
/** Under the box, the original's caption (y 312 on): what the detail draws with. */
const DETAIL_CAPTION: Rect = [401, 312, 147, 28];
/** The key list: sixteen rows 14 apart from y 117, each the key's cell (x 86..119) and what it does (x 121..254). */
const keyRow = (i: number): Rect => [86, 117 + 14 * i, 169, 13];
const KEY_CELL_W = 34;
/** The buttons along the foot. */
const BUTTONS = { DEFAULT: [88, 369, 119, 35], CANCEL: [261, 369, 119, 35], USE: [436, 369, 119, 35] } as const satisfies Record<string, Rect>;
/** The remake's message line (a wait for a key, a refusal), in the picture's black band over the lists. */
const MESSAGE: Rect = [86, 100, 463, 14];
/** The cells' colours in final.spr (standard.pal's 168 and 170): the list's dark cells, and its lighter ones, which mark a choice. */
const CELL_DARK = 'rgb(4, 20, 32)';
const CELL_LIT = 'rgb(12, 44, 68)';
/** The key names' blue in the picture's list. */
const KEY_INK: Rgb = [28, 116, 184];
const DETAILS: readonly Options['detail'][] = ['high', 'medium', 'low'];
const DETAIL_WORDS: Readonly<Record<Options['detail'], string>> = { high: 'High', medium: 'Medium', low: 'Low' };
/** What each detail draws with (help.cpp's caption, tactical_hooks_ui.md §8): High Gouraud and textures, Medium Gouraud only, Low flat. */
const CAPTIONS: Readonly<Record<Options['detail'], [string, string]>> = {
  high: ['Gouraud Shading On', 'Texture Mapping On'],
  medium: ['Gouraud Shading On', 'Texture Mapping Off'],
  low: ['Gouraud Shading Off', 'Texture Mapping Off'],
};
/** The original's sixteen (BINDABLE_ACTIONS' first): the remake's own three are on the console's KEYS tab. */
const KEYS_LISTED = BINDABLE_ACTIONS.slice(0, 16);
/** final.spr prints fourteen rows' words; its two spare rows are the zoom keys', whose words are drawn. */
const PRINTED_ROWS = 14;
/** The rows' headings and the buttons' words, which final.spr prints: drawn only by the CSS stand-in. */
const HEADINGS: readonly { text: string; r: Rect }[] = [
  { text: 'Stars', r: span(279, 117, 371, 130) },
  { text: 'Resolution', r: span(279, 159, 371, 172) },
  { text: 'Radar', r: span(279, 201, 371, 214) },
  { text: 'Rendering Detail', r: span(401, 282, 547, 296) },
];

export interface CombatOptionsProps {
  settings: SettingsPort;
  /** final.spr's picture (art.admin.final); without it the screen is drawn in CSS. */
  picture?: string;
  /** The game's fonts: the screen's words in font 0, the key list's (help.cpp); without them, CSS words. */
  fonts: AstroFonts | null;
  /** Where the preview's window is, for the session to draw the Enterprise in (BattlePort.previewBox): set as the screen comes up, null as it goes. */
  preview(box: (() => DOMRect | null) | null): void;
  onClose(): void;
}

export function CombatOptions({ settings, picture, fonts, preview, onClose }: CombatOptionsProps): JSX.Element {
  const words = fonts?.fonts[KEYS_FONT] ? fonts : null;
  const box = useRef<HTMLDivElement>(null);
  const hole = useRef<HTMLDivElement>(null);
  /** What the screen opened with: CANCEL puts it back. */
  const [opened] = useState(() => settings.get());
  const [note, setNote] = useState<string | null>(null);
  const [, setRevision] = useState(0);
  const now = settings.get();
  const set = (change: Partial<Settings>) => {
    try {
      settings.set(change);
    } catch (err) {
      setNote(errorText(err));
    }
    setRevision(r => r + 1);
  };
  const beep = () => settings.sound('beep7');
  const choose = (change: Partial<Settings>) => {
    settings.sound('softbop');
    set(change);
  };
  const grab = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  const taken = useRef(new Set<string>());
  const { pending, wait } = useRebinding({ settings, set, say: setNote, grab, beep });
  useModal(box);

  // (the preview's window, for the session to draw in while the screen is up)
  useLayoutEffect(() => {
    preview(() => hole.current?.getBoundingClientRect() ?? null);
    return () => preview(null);
  }, []);

  // Every key is the screen's while it is up (the original's is modal): a wait for a key takes it first; F1 and Esc close; Tab stays on the
  // screen; nothing reaches the battle or the game behind (in place at once, so a key pressed as the screen comes up finds it).
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (offerKey({ grab, taken }, e)) return;
      if ((e.key === 'Escape' || e.key === 'F1') && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        // (F1 held from the press that opened it does not close it)
        if (!e.repeat) close.current();
        return;
      }
      modalKey(box.current, e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      guardKeyUp({ grab, taken }, e);
      modalKey(box.current, e);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  const combat = now.combat;
  /** Words in `r` of the control `outer`: in the game's font 0, else CSS. */
  const text = (t: string, r: Rect, outer: Rect, ink: Rgb, align: 'left' | 'centre' = 'centre') => (words
    ? <BitmapWords fonts={words} text={t} r={r} outer={outer} align={align} ink={ink} face={KEYS_FONT} />
    : <span class={align === 'left' ? 'au-options-words au-options-left' : 'au-options-words'} style={inside(outer, r)} aria-hidden="true">{t}</span>);
  /** An Off/On (or 1x/2x) cell: the chosen one lit, as final.spr's lighter cells. */
  const choice = (name: string, row: number, on: boolean, word: string, chosen: boolean, change: () => Partial<Settings>) => {
    const r = cell(row, on);
    return (
      <button key={`${name} ${word}`} type="button" class="au-options-ctl au-options-cell" style={{ ...areaStyle(r), background: chosen ? CELL_LIT : CELL_DARK }}
        aria-label={`${name} ${word.toUpperCase()}`} aria-pressed={chosen} onClick={() => choose(change())}>
        {text(word, r, r, chosen ? LIT : INK)}
      </button>
    );
  };
  const onOff = (name: string, row: number, value: boolean, change: (on: boolean) => Partial<Settings>) => [
    choice(name, row, false, 'Off', !value, () => change(false)),
    choice(name, row, true, 'On', value, () => change(true)),
  ];
  const button = (name: keyof typeof BUTTONS, onClick: () => void) => (
    <button key={name} type="button" class={picture ? 'au-options-ctl au-options-button' : 'au-options-ctl au-options-button au-options-plain'} style={areaStyle(BUTTONS[name])} aria-label={name} onClick={() => { beep(); onClick(); }}>
      {!picture && <span class="au-options-words" aria-hidden="true">{name}</span>}
    </button>
  );
  const message = note ?? '';

  return (
    <div class="au-options" data-art={picture ? 'picture' : undefined}>
      <div class="au-options-box" role="dialog" aria-modal="true" aria-label="Combat Options" ref={box}>
        <div class="au-options-face" style={{ clipPath: FACE_CLIP }} aria-hidden="true">
          {picture
            ? <img class="au-options-picture" src={picture} alt="" draggable={false} style={areaStyle(PICTURE)} />
            : <StandIn words={words} />}
        </div>
        <div class="au-options-preview" ref={hole} style={areaStyle(PREVIEW)} role="img" aria-label="Preview" />
        <div class="au-options-message" role="status" style={areaStyle(MESSAGE)}>
          <span class={words ? 'au-options-quiet' : undefined}>{message}</span>
          {words && message !== '' && <BitmapWords fonts={words} text={message} r={MESSAGE} outer={MESSAGE} align="centre" ink={LIT} face={KEYS_FONT} fit />}
        </div>

        {KEYS_LISTED.map((action: BindableAction, i) => {
          const r = keyRow(i);
          const waiting = pending === action;
          const keyCell: Rect = [r[0], r[1], KEY_CELL_W, r[3]];
          const doesCell: Rect = [r[0] + KEY_CELL_W + 4, r[1], r[2] - KEY_CELL_W - 4, r[3]];
          // (final.spr prints its fourteen rows' words; its keys are drawn, as a binding changes them)
          const printed = picture && i < PRINTED_ROWS;
          return (
            <button key={action} type="button" class="au-options-ctl au-options-keyrow" style={areaStyle(r)} data-action={action} aria-pressed={waiting}
              aria-label={keyRowName(action, now.keys[action], waiting)} onClick={() => { beep(); wait(waiting ? null : action); }}>
              <span class="au-options-keycell" style={{ ...inside(r, keyCell), background: CELL_DARK }} aria-hidden="true" />
              {text(waiting ? '?' : keyName(now.keys[action]), [keyCell[0] + 2, keyCell[1], keyCell[2] - 2, keyCell[3]], r, waiting ? LIT : KEY_INK, 'left')}
              {!printed && text(ACTION_NAMES[action], [doesCell[0], doesCell[1], doesCell[2], doesCell[3]], r, INK, 'left')}
            </button>
          );
        })}

        {onOff('STARS', ROWS.stars, combat.stars, stars => ({ combat: { ...combat, stars } }))}
        {choice('RESOLUTION', ROWS.resolution, false, '1x', combat.resolution === 1, () => ({ combat: { ...combat, resolution: 1 } }))}
        {choice('RESOLUTION', ROWS.resolution, true, '2x', combat.resolution === 2, () => ({ combat: { ...combat, resolution: 2 } }))}
        {onOff('RADAR', ROWS.radar, combat.radar, radar => ({ combat: { ...combat, radar } }))}
        <button type="button" class="au-options-ctl au-options-cycle" style={areaStyle(DETAIL)} aria-label={`DETAIL ${combat.detail.toUpperCase()}`}
          data-setting="detail" onClick={() => choose({ combat: { ...combat, detail: DETAILS[(DETAILS.indexOf(combat.detail) + 1) % DETAILS.length]! } })}>
          {text(DETAIL_WORDS[combat.detail], DETAIL_VALUE, DETAIL, LIT)}
        </button>
        <div class="au-options-caption" style={areaStyle(DETAIL_CAPTION)} aria-hidden="true">
          {CAPTIONS[combat.detail].map((line, k) => (
            <div key={line} class="au-options-line" style={inside(DETAIL_CAPTION, [DETAIL_CAPTION[0], DETAIL_CAPTION[1] + 1 + 13 * k, DETAIL_CAPTION[2], 13])}>
              {text(line, [DETAIL_CAPTION[0], DETAIL_CAPTION[1] + 1 + 13 * k, DETAIL_CAPTION[2], 13], [DETAIL_CAPTION[0], DETAIL_CAPTION[1] + 1 + 13 * k, DETAIL_CAPTION[2], 13], INK)}
            </div>
          ))}
        </div>

        {button('DEFAULT', () => {
          if (pending !== null) wait(null);
          set({ combat: { ...DEFAULT_SETTINGS.combat }, keys: DEFAULT_KEYS });
        })}
        {button('CANCEL', () => {
          set({ combat: opened.combat, keys: opened.keys });
          onClose();
        })}
        {button('USE', onClose)}
      </div>
    </div>
  );
}

const pct = (v: number, of: number) => `${(v / of) * 100}%`;
/** A rectangle inside `outer`, as CSS of `outer`. */
const inside = (outer: Rect, [x, y, w, h]: Rect) => ({ position: 'absolute' as const, left: pct(x - outer[0], outer[2]), top: pct(y - outer[1], outer[3]), width: pct(w, outer[2]), height: pct(h, outer[3]) });

/** The CSS stand-in for final.spr: its frame, its list's and boxes' cells and its headings, in its colours (decorative: the controls carry the names). */
function StandIn({ words }: { words: AstroFonts | null }) {
  const heading = ({ text, r }: { text: string; r: Rect }) => (
    <div key={text} class="au-options-heading" style={areaStyle(r)}>
      {words ? <BitmapWords fonts={words} text={text} r={r} outer={r} align="centre" ink={INK} face={KEYS_FONT} /> : <span class="au-options-words">{text}</span>}
    </div>
  );
  return (
    <>
      <div class="au-options-standin" style={areaStyle(PICTURE)} />
      <div class="au-options-window" style={areaStyle([PREVIEW[0] - 3, PREVIEW[1] - 3, PREVIEW[2] + 6, PREVIEW[3] + 6])} />
      {HEADINGS.map(heading)}
    </>
  );
}
