// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AstroFonts } from '../../view/bitmapText';
import { barSegments, levelFromBar, type Settings } from '../../web/settings';
import type { SettingsPort } from '../../web/settingsPort';
import type { AdminArt, AdminButton } from '../faces';
import { NAME_MAX, saveName, shownName, SLOTS, validNameChar, type SaveMeta } from '../saves';
import type { SavesPort } from '../savesPort';
import type { UiStore } from '../store';
import { useStore } from '../useStore';
import { ADMIN_FONT, at, BitmapWords, CANT_SAVE, Control, errorText, H, INK, LIT, ORIGIN, Pic, rect, screenRect, modalKey, SEGMENTS, useModal, W, within, type Rect } from './parts';
import { guardKeyUp, offerKey } from './rebinding';
import { SettingsPage, type Bar } from './settingsPage';
import { FeedbackPage } from './feedbackPage';
import type { FeedbackPort } from '../../web/feedback';

/**
 * The admin console (the original's "RGCD" PADD: main\adminmnu.cpp, phase4_rest.md §6.2), drawn from adminmnu.spr and adminmnu.mrg where
 * the original draws them, or in CSS at the same rectangles when they aren't published. Every rectangle here is in the original's pixels,
 * from the console's top left, which the original puts at (110,1) of its 640 by 480 screen.
 */

/** The original's states 0-6 (paused, load, save, sound, new, quit; its "loading" state 2 is a load under way), and the remake's SETTINGS. */
export type AdminPage = 'paused' | 'load' | 'save' | 'sound' | 'new' | 'quit' | 'settings' | 'feedback';

/** The LEDs move on every 20 ticks of the original's 60 Hz clock (`11e06`). */
export const LED_MS = Math.round((20 * 1000) / 60);

/** Where the original takes each click (phase4_rest.md §6.2's widget table), and the remake's SETTINGS (spec §3 Decision 3). */
const CLICK = {
  load: rect(45, 253, 147, 271),
  save: rect(271, 253, 372, 271),
  new: rect(45, 284, 146, 301),
  quit: rect(273, 284, 374, 301),
  sound: rect(34, 321, 176, 363),
  text: rect(34, 369, 176, 411),
  difficulty: rect(184, 322, 384, 365),
  settings: rect(184, 369, 384, 411),
  resume: rect(264, 430, 384, 471),
  message: rect(216, 21, 376, 37),
  screen: rect(62, 40, 358, 245),
  // (the notes give CANCEL's bottom as 384, below the screen and over DIFFICULTY: its picture's own 18 rows are taken instead)
  cancel: screenRect(274, 269, 364, 287),
  yes: screenRect(188, 168, 282, 185),
  no: screenRect(357, 168, 455, 185),
  voices: screenRect(177, 83, 301, 241),
  music: screenRect(336, 83, 459, 241),
  // (the remake's: the autosave, load-only, in the screen's free band above CANCEL)
  autosave: rect(150, 254, 267, 266),
  // (the remake's: FEEDBACK, a grey key as RESUME is, on the console's bare face between its RGCD plate and RESUME)
  feedback: rect(122, 432, 254, 469),
} as const;

/** Slot `i` (0-8): row i spans y 59+21i to 80+21i of the original's screen, across the screen. */
const slotRect = (i: number): Rect => [CLICK.screen[0], 59 + 21 * i - ORIGIN.y, CLICK.screen[2], 21];
/** Where a slot's name is drawn: at the screen's left edge and 2 in, above the row's line. */
const nameRect = (i: number): Rect => [CLICK.screen[0] + 2, 59 + 21 * i - ORIGIN.y, CLICK.screen[2] - 2, 19];

/** Where the pictures go: found against the console's own picture where it has them (each button's picture sits a row below its rectangle). */
const PIC = {
  page: [44, 47, 332, 256],
  sound: [34, 322, 143, 46],
  text: [34, 370, 143, 46],
  difficulty: [184, 322, 201, 44],
  settings: [184, 370, 143, 46],
  resume: [264, 430, 121, 42],
  cancel: [164, 268, 90, 18],
  yes: [78, 167, 94, 18],
  no: [247, 167, 93, 18],
} as const satisfies Record<string, Rect>;
/** A sound bar's segments: 27, 6 apart from y 81 of the screen down, at x 176 (left) and 334 (right) of the screen. */
const segRect = (bar: 'voices' | 'music', i: number): Rect => [(bar === 'voices' ? 176 : 334) - ORIGIN.x, 81 + 6 * i - ORIGIN.y, 129, 7];
/** The slot row's lit line (adminmnu.mrg 0-5): the first, a middle and the last row, each for the load page (on the left) and the save page (on the right). */
function rowPicture(slot: number, saving: boolean): { name: AdminButton; rect: Rect } {
  const kind = slot === 0 ? 0 : slot === SLOTS - 1 ? 4 : 2;
  const name = `row${kind + (saving ? 1 : 0)}` as AdminButton;
  const x = 44 + (saving ? (kind === 4 ? 16 : 17) : 1);
  return { name, rect: [x, 49 + 21 * slot, kind === 0 ? 314 : 313, 39] };
}
/** The top LED row: 11 at x 45+13i (adminmnu.mrg 0x12-0x14, each picture 14 by 20). */
const LEDS_TOP = { x: 45, y: 14, n: 11 };
/**
 * The original's second row, 14 at x 193+13i, ran where SETTINGS now is (spec §6). Moved below SETTINGS it crowds RESUME and its groove shows
 * twice, so it goes (judged side by side with the original, Plan 32 Task 7): its groove, wider than SETTINGS, is covered by the console's own blank face from
 * above it.
 */
const GROOVE_COVER = { from: [186, 340, 198, 24] as Rect, to: [186, 385, 198, 24] as Rect };

const MESSAGES: Record<AdminPage, string> = {
  paused: 'Game paused',
  load: 'Select game to load',
  save: 'Select slot to save',
  new: 'Start new game',
  quit: 'Quit game',
  sound: 'Sound levels',
  settings: 'Settings',
  feedback: 'Send feedback',
};
const TYPING = 'Press Enter to save';
const DIFFICULTY: readonly ('ensign' | 'lieutenant' | 'captain')[] = ['ensign', 'lieutenant', 'captain'];

/** The width at which the original stops taking characters for a name. */
const NAME_WIDTH = 256;
/** The names' CSS font, as admin.css draws them without the game's fonts: 12 of the original's pixels high. */
const NAME_FONT = "12px 'Helvetica Neue', 'Arial Narrow', Arial, sans-serif";
/** A fixed-cell stand-in for the CSS font, where there is no canvas to measure with (a test's DOM). */
const NAME_CELL = 8;
let nameContext: CanvasRenderingContext2D | null | undefined;
/** How wide a name is drawn in the CSS font, in the original's pixels: the canvas's measure, else NAME_CELL a character. */
export function nameWidth(text: string): number {
  if (nameContext === undefined) {
    try {
      nameContext = document.createElement('canvas').getContext('2d');
      if (nameContext) nameContext.font = NAME_FONT;
    } catch {
      nameContext = null;
    }
  }
  return nameContext ? nameContext.measureText(text).width : text.length * NAME_CELL;
}

export interface AdminConsoleProps {
  settings: SettingsPort;
  /** Absent where IndexedDB isn't: LOAD's slots are empty and there is no SAVE. */
  saves?: SavesPort;
  store: UiStore;
  /** The original's pictures (art.admin); without them, CSS at the same rectangles. */
  art?: AdminArt;
  /** The game's bitmap fonts (art.fonts), the console's words drawn in font ADMIN_FONT; without them, CSS text. */
  fonts?: AstroFonts | null;
  /** How wide a name is drawn (the game's font's own widths, else nameWidth; a test's own). */
  measure?: (text: string) => number;
  /** SETTINGS' FEEDBACK page's check and send; without it, no FEEDBACK. */
  feedback?: FeedbackPort;
}

/**
 * The screen's pages (pictures 1-5) fetched and decoded as the console opens, held while it is up: a page's picture is then drawable the frame it
 * comes up, with no frame of the console's own screen showing through first (the HD pages run to most of a megabyte).
 */
function usePreloadedPages(art: AdminArt | undefined): void {
  useEffect(() => {
    if (!art || typeof Image === 'undefined') return;
    const held = [1, 2, 3, 4, 5].map(i => {
      const img = new Image();
      img.src = art.frame(i);
      img.decode?.().catch(() => {});
      return img;
    });
    // (closing lets them go: an unfinished fetch stops, and nothing holds the decoded pictures)
    return () => { for (const img of held.splice(0)) img.src = ''; };
  }, [art]);
}

export function AdminConsole({ settings, saves, store, art, fonts, measure, feedback }: AdminConsoleProps) {
  const font = fonts?.fonts[ADMIN_FONT];
  const bitmap = font !== undefined ? fonts! : null;
  // (the original's rule is the name's drawn width: in the font it is drawn in)
  const widthOf = measure ?? (font ? (t: string) => font.stringWidth(t) : nameWidth);
  useStore(store);
  // (opened by the bar's Feedback: on its page, and its CANCEL goes back to the paused page rather than SETTINGS)
  const [fromBar] = useState(() => store.state.adminStart === 'feedback' && feedback !== undefined);
  const [page, setPage] = useState<AdminPage>(fromBar ? 'feedback' : 'paused');
  useEffect(() => { if (store.state.adminStart !== null) store.set({ adminStart: null }); }, []);
  /** Where FEEDBACK's CANCEL goes: SETTINGS when it was opened from there, else the paused page. */
  const feedbackBack = useRef<AdminPage>('paused');
  const [note, setNote] = useState<string | null>(null);
  const [metas, setMetas] = useState<SaveMeta[]>([]);
  /** The save page's chosen slot (0-8) and the name being typed for it. */
  const [chosen, setChosen] = useState<{ slot: number; name: string } | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  // (a change the port doesn't announce: a test's port; the session bumps the store itself)
  const [, setRevision] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const now: Settings = settings.get();
  const over = settings.gameOver();
  // (SAVE is on the console unless the game is over, as the original's allowSave; while the game can't be saved now, it says why)
  const offersSave = saves !== undefined && !over;

  const refresh = () => {
    if (!saves) return;
    saves.list().then(setMetas, (err: unknown) => setNote(errorText(err)));
  };
  useEffect(refresh, [saves]);
  usePreloadedPages(art);
  // the LEDs chase on their own timer: the game's clock is stopped while the console is up
  useEffect(() => {
    const id = setInterval(() => setStep(s => s + 1), LED_MS);
    return () => clearInterval(id);
  }, []);
  // the first control has the focus while the console is up, and what had it gets it back; everything behind it is inert, so no key or
  // focus reaches the game (the original's console takes every key and click while it is up)
  useModal(box);

  const go = (next: AdminPage) => {
    setPage(next);
    setNote(null);
    setChosen(null);
    setHovered(null);
    if (next === 'load' || next === 'save') refresh();
  };
  const close = () => settings.closeAdmin();
  const set = (change: Partial<Settings>) => {
    try {
      settings.set(change);
    } catch (err) {
      setNote(errorText(err));
    }
    setRevision(r => r + 1);
  };
  /** A load, a save, a new game or quit: the console says why it was refused. */
  const run = async (what: () => Promise<void>, closing: boolean) => {
    try {
      setNote(null);
      await what();
      if (closing) close();
    } catch (err) {
      setNote(errorText(err));
    }
  };
  const save = (slot: number, name: string) => {
    if (!saves) return;
    void run(() => saves.save(slot + 1, saveName(slot + 1, name)), true);
  };

  /** A sound bar set by a click's height (the original's slider: levelFromBar), with beep14 at the new level; and SETTINGS' master bar. */
  const setBar = (bar: Bar, level: number) => {
    set({ [bar]: level });
    settings.sound('beep14', level);
  };
  /** A segment up or down from the keyboard: the click on the segment that is then the top one lit (segment i is at y 81+6i of the screen). */
  const stepBar = (bar: Bar, step: number) => {
    // (the level as it is now, not as last drawn: two quick presses step twice)
    const lit = Math.max(0, Math.min(SEGMENTS, barSegments(settings.get()[bar]) + step));
    setBar(bar, lit === 0 ? 0 : levelFromBar(81 + 6 * (SEGMENTS - lit)));
  };

  // Esc closes from any page, mid-name too, without saving; on the save page the keys type the name; Tab stays on the console; a focused sound
  // bar takes the arrows; and no key reaches the game behind (in place at once, so a key pressed as the console opens finds it)
  /** The settings page's wait for a key to bind (settingsPage.tsx): it takes the next key before the console's own ways. */
  const grab = useRef<((e: KeyboardEvent) => boolean) | null>(null);
  /** The keys a binding took, until their keyups: a Space let go on its focused row must not press it again. */
  const taken = useRef(new Set<string>());
  const keys = useRef({ page, chosen, widthOf, close, save, stepBar });
  keys.current = { page, chosen, widthOf, close, save, stepBar };
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      const k = keys.current;
      const console = box.current;
      const inside = console !== null && e.target instanceof Node && console.contains(e.target);
      if (offerKey({ grab, taken }, e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        k.close();
        return;
      }
      if (modalKey(console, e)) return;
      const bar = inside && e.target instanceof HTMLElement ? e.target.dataset.bar : undefined;
      const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0;
      if ((bar === 'voices' || bar === 'music' || bar === 'master') && step !== 0) {
        e.preventDefault();
        k.stepBar(bar, step);
        return;
      }
      if (k.page === 'save' && k.chosen !== null && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const { slot, name } = k.chosen;
        if (e.key === 'Enter') {
          e.preventDefault();
          k.save(slot, name);
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          setChosen({ slot, name: name.slice(0, -1) });
          return;
        }
        if (e.key.length === 1) {
          e.preventDefault();
          // (the original's rule: a character is taken while the name is under 30 and drawn at most 256 wide)
          if (validNameChar(e.key) && name.length < NAME_MAX && k.widthOf(name) <= NAME_WIDTH) setChosen({ slot, name: name + e.key });
          return;
        }
      }
    };
    // (Space presses a focused button as it comes up: not one behind the console)
    const onKeyUp = (e: KeyboardEvent) => {
      // (a key taken for a binding presses nothing as it comes up)
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

  const beep = () => settings.sound('beep7');
  const pageButton = (next: AdminPage) => () => {
    beep();
    go(next);
  };
  const toggle = (next: AdminPage) => () => {
    beep();
    go(page === next ? 'paused' : next);
  };

  const barAt = (bar: 'voices' | 'music') => (e: PointerEvent) => {
    if (e.button !== 0) return;
    const r = box.current?.getBoundingClientRect();
    if (!r || r.height === 0) return;
    setBar(bar, levelFromBar(((e.clientY - r.top) / r.height) * H + ORIGIN.y));
  };

  const slots = Array.from({ length: SLOTS }, (_, i) => metas.find(m => m.slot === i + 1));
  const autosave = metas.find(m => m.slot === 0);
  const message = note ?? (page === 'save' && chosen !== null ? TYPING : MESSAGES[page]);
  // (SETTINGS has the sound page's frame, lit as a page's is, its insides cleared for its own)
  const frameFor: Partial<Record<AdminPage, number>> = { load: 1, save: 2, new: 3, quit: 4, sound: 5, settings: 5, feedback: 5 };
  const frame = frameFor[page];
  const level = DIFFICULTY[now.difficulty] ?? 'lieutenant';
  const canDifficulty = settings.canChangeDifficulty();
  const lit = (name: AdminButton, litName: AdminButton, r: Rect, outer: Rect, on = false) => art && (
    <>
      <Pic src={art.button(name)} r={r} outer={outer} />
      <Pic src={art.button(litName)} r={r} outer={outer} class={on ? undefined : 'au-admin-hover'} />
    </>
  );
  const highlight = page === 'save' ? chosen?.slot ?? hovered : page === 'load' ? hovered : null;

  return (
    <div class="au-admin-shade">
      <div class={art ? 'au-admin-console au-admin-art' : 'au-admin-console'} role="dialog" aria-modal="true" aria-label="Admin console" data-page={page} ref={box}>
        {art ? <Pic src={art.frame(0)} r={[0, 0, W, H]} class="au-admin-frame" /> : <div class="au-admin-face" aria-hidden="true" />}
        {art && frame !== undefined && <Pic src={art.frame(frame)} r={PIC.page} />}
        {!art && <StandInPage page={page} fonts={bitmap} />}
        <Leds art={art} step={step} />

        <div class={bitmap ? 'au-admin-message au-admin-quiet' : 'au-admin-message'} role="status" style={at(CLICK.message)} title={message}>{message}</div>
        {bitmap && <BitmapWords fonts={bitmap} text={message} r={CLICK.message} align="centre" ink={LIT} fit />}

        <Control name="LOAD" r={CLICK.load} kind="pill" label={art ? undefined : 'LOAD'} on={page === 'load'} onClick={pageButton('load')} />
        {offersSave && saves && <Control name="SAVE" r={CLICK.save} kind="pill" label={art ? undefined : 'SAVE'} on={page === 'save'} onClick={() => {
          beep();
          if (saves.canSave()) go('save');
          else setNote(saves.refusal?.() ?? CANT_SAVE);
        }} />}
        <Control name="NEW" r={CLICK.new} kind="pill" label={art ? undefined : 'NEW'} on={page === 'new'} onClick={pageButton('new')} />
        <Control name="QUIT" r={CLICK.quit} kind="pill" label={art ? undefined : 'QUIT'} on={page === 'quit'} onClick={pageButton('quit')} />
        {feedback && <Control name="FEEDBACK" r={CLICK.feedback} kind="key" label="FEEDBACK" on={page === 'feedback'} data={{ 'data-remake': '' }} onClick={() => { feedbackBack.current = 'paused'; toggle('feedback')(); }} />}

        {(page === 'load' || page === 'save') && (
          <>
            {art && highlight !== null && <Pic src={art.button(rowPicture(highlight, page === 'save').name)} r={rowPicture(highlight, page === 'save').rect} class="au-admin-row-lit" />}
            {slots.map((meta, i) => {
              const editing = page === 'save' && chosen?.slot === i;
              const stored = meta ? shownName(i + 1, meta.label) : null;
              const text = editing ? chosen.name : stored ?? '';
              return (
                <Control
                  key={i}
                  name={`Slot ${i + 1}`}
                  r={slotRect(i)}
                  kind="row"
                  on={highlight === i}
                  data={{ 'data-slot': String(i + 1), 'data-editing': editing ? '' : undefined }}
                  onFocus={() => setHovered(i)}
                  onClick={() => {
                    if (page === 'load') {
                      if (meta && saves) void run(() => saves.load(i + 1), true);
                    } else if (editing) {
                      // (a second press on the chosen row saves it: Enter's way for a player with no keys)
                      save(i, chosen.name);
                    } else {
                      setNote(null);
                      setChosen({ slot: i, name: stored ?? saveName(i + 1, '') });
                    }
                  }}
                >
                  <span class={bitmap ? 'au-admin-name au-admin-quiet' : 'au-admin-name'} onPointerEnter={() => setHovered(i)} onPointerLeave={() => setHovered(h => (h === i ? null : h))}>{text}</span>
                  {/* (a stored name wider than its row is cut with "...": a name being typed stops at NAME_WIDTH instead) */}
                  {bitmap && <BitmapWords fonts={bitmap} text={text} r={nameRect(i)} outer={slotRect(i)} ink={LIT} fit={!editing} />}
                  {bitmap && editing && <BitmapWords fonts={bitmap} text="_" r={[nameRect(i)[0] + widthOf(text), nameRect(i)[1], 16, nameRect(i)[3]]} outer={slotRect(i)} ink={LIT} class="au-admin-caret" />}
                </Control>
              );
            })}
            <Control name="CANCEL" r={CLICK.cancel} kind="pill" label={art ? undefined : 'CANCEL'} onClick={() => go('paused')}>
              {art && <Pic src={art.button('cancel')} r={PIC.cancel} outer={CLICK.cancel} class="au-admin-hover" />}
            </Control>
          </>
        )}
        {page === 'load' && saves && autosave && (
          <Control name="AUTOSAVE" r={CLICK.autosave} kind="plain" label={bitmap ? undefined : 'AUTOSAVE'} onClick={() => void run(() => saves.load(0), true)}>
            {bitmap ? <BitmapWords fonts={bitmap} text="AUTOSAVE" r={CLICK.autosave} outer={CLICK.autosave} align="centre" ink={INK} /> : undefined}
          </Control>
        )}

        {page === 'settings' && <SettingsPage settings={settings} saves={saves} store={store} art={art} fonts={bitmap} set={set} setBar={setBar} say={setNote} grab={grab} run={run} feedback={feedback ? () => { beep(); feedbackBack.current = 'settings'; go('feedback'); } : undefined} />}
        {page === 'feedback' && feedback && <FeedbackPage feedback={feedback} say={setNote} back={() => { beep(); go(feedbackBack.current); }} />}

        {(page === 'new' || page === 'quit') && (
          <>
            <Control name="YES" r={CLICK.yes} kind="pill" label={art ? undefined : 'YES'} onClick={() => void run(page === 'new' ? () => settings.newGame() : () => settings.quit(), false)}>
              {art && <Pic src={art.button('yes')} r={PIC.yes} outer={CLICK.yes} class="au-admin-hover" />}
            </Control>
            <Control name="NO" r={CLICK.no} kind="pill" label={art ? undefined : 'NO'} onClick={() => go('paused')}>
              {art && <Pic src={art.button('no')} r={PIC.no} outer={CLICK.no} class="au-admin-hover" />}
            </Control>
          </>
        )}

        {page === 'sound' && (['voices', 'music'] as const).map(bar => {
          const on = barSegments(now[bar]);
          return (
            <div
              key={bar}
              class="au-admin-bar"
              role="slider"
              tabIndex={0}
              aria-label={bar === 'voices' ? 'VOICES/EFFECTS' : 'MUSIC/BACKGROUND'}
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(now[bar] * 100)}
              style={at(CLICK[bar])}
              data-bar={bar}
              onPointerDown={barAt(bar)}
            >
              {Array.from({ length: SEGMENTS }, (_, i) => {
                const segOn = i >= SEGMENTS - on;
                return art
                  ? <Pic key={i} src={art.button(segOn ? 'segOn' : 'segOff')} r={segRect(bar, i)} outer={CLICK[bar]} data={{ 'data-seg': segOn ? 'on' : 'off' }} />
                  : <i key={i} class="au-admin-seg" style={within(CLICK[bar], segRect(bar, i))} data-seg={segOn ? 'on' : 'off'} />;
              })}
            </div>
          );
        })}

        <Control name="SOUND LEVELS" r={CLICK.sound} kind="key" label={art ? undefined : 'SOUND LEVELS'} on={page === 'sound'} onClick={toggle('sound')}>
          {lit('soundLevels', 'soundLevelsLit', PIC.sound, CLICK.sound, page === 'sound')}
        </Control>
        <Control name={now.text ? 'TEXT ON' : 'TEXT OFF'} r={CLICK.text} kind="key" label={art ? undefined : now.text ? 'TEXT ON' : 'TEXT OFF'} on={now.text} onClick={() => {
          settings.sound('softbop');
          set({ text: !now.text });
        }}>
          {lit(now.text ? 'textOn' : 'textOff', now.text ? 'textOnLit' : 'textOffLit', PIC.text, CLICK.text)}
        </Control>
        <Control name={`DIFFICULTY ${level.toUpperCase()}`} r={CLICK.difficulty} kind="key" label={art ? undefined : `DIFFICULTY ${canDifficulty ? level.toUpperCase() : ''}`} disabled={!canDifficulty} onClick={() => {
          settings.sound('softbop');
          set({ difficulty: ((now.difficulty + 1) % 3) as Settings['difficulty'] });
        }}>
          {art && (canDifficulty ? lit(level, `${level}Lit`, PIC.difficulty, CLICK.difficulty) : <Pic src={art.button('difficultyOff')} r={PIC.difficulty} outer={CLICK.difficulty} />)}
        </Control>
        <Control name="SETTINGS" r={CLICK.settings} kind="key" label={art ? undefined : 'SETTINGS'} on={page === 'settings'} onClick={toggle('settings')}>
          {art && (
            <>
              <Pic src={art.settings} r={PIC.settings} outer={CLICK.settings} />
              <Pic src={art.settingsLit} r={PIC.settings} outer={CLICK.settings} class={page === 'settings' ? undefined : 'au-admin-hover'} />
            </>
          )}
        </Control>
        {!over && (
          <Control name="RESUME" r={CLICK.resume} kind="key" label={art ? undefined : 'RESUME'} onClick={close}>
            {lit('resume', 'resumeLit', PIC.resume, CLICK.resume)}
          </Control>
        )}
      </div>
    </div>
  );
}

/** Where the CSS stand-in prints what the original's pages have in their pictures: the questions and the bars' headings. */
const STAND_IN_TEXT: Partial<Record<AdminPage, { r: Rect; text: string }[]>> = {
  new: [{ r: [62, 110, 297, 40], text: 'ARE YOU SURE YOU WANT TO START A NEW GAME?' }],
  quit: [{ r: [62, 120, 297, 30], text: 'ARE YOU SURE YOU WANT TO QUIT?' }],
  sound: [{ r: [62, 62, 140, 16], text: 'VOICES/EFFECTS' }, { r: [218, 62, 140, 16], text: 'MUSIC/BACKGROUND' }],
};

/** The CSS stand-in's page words (decorative: the controls carry the names), in the game's font when it is published. */
function StandInPage({ page, fonts }: { page: AdminPage; fonts: AstroFonts | null }) {
  return (
    <>
      {(STAND_IN_TEXT[page] ?? []).map(({ r, text }) => (fonts
        ? <BitmapWords key={text} fonts={fonts} text={text} r={r} align="centre" ink={INK} />
        : <div key={text} class="au-admin-words" style={at(r)} aria-hidden="true">{text}</div>))}
    </>
  );
}

/**
 * The LEDs chasing: a bright LED with a dimmer one behind it, along the row; and the lower row's groove covered, from the original's own face (an
 * HD body has the groove painted out when published, and its face shades down the panel, so a copied patch would show: no cover).
 */
function Leds({ art, step }: { art?: AdminArt; step: number }) {
  const r = LEDS_TOP;
  const head = step % r.n;
  const [x, y, w, h] = GROOVE_COVER.from;
  return (
    <>
      <div class="au-admin-leds au-admin-leds-top" aria-hidden="true">
        {Array.from({ length: r.n }, (_, i) => {
          const led = i === head ? 2 : i === (head + r.n - 1) % r.n ? 1 : 0;
          const place: Rect = [r.x + 13 * i, r.y, 14, 20];
          return art
            ? <Pic key={i} src={art.button(`led${led}` as AdminButton)} r={place} data={{ 'data-led': String(led) }} />
            : <i key={i} class="au-admin-led" style={at(place)} data-led={String(led)} />;
        })}
      </div>
      {art && !art.bodyHd && (
        <div
          class="au-admin-cover"
          aria-hidden="true"
          style={{
            ...at(GROOVE_COVER.to),
            backgroundImage: `url("${art.frame(0)}")`,
            backgroundSize: `${(W / w) * 100}% ${(H / h) * 100}%`,
            backgroundPosition: `${(x / (W - w)) * 100}% ${(y / (H - h)) * 100}%`,
          }}
        />
      )}
    </>
  );
}
