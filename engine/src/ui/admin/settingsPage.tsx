// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type MutableRef } from 'preact/hooks';
import { BATTLE_SPEEDS, COMBAT_DIFFICULTIES, type CombatDifficulty } from '../../sim/combat/assists';
import type { AstroFonts } from '../../view/bitmapText';
import { BINDABLE_ACTIONS } from '../../view/combat/bindings';
import { barSegments, levelFromBar, type CombatOptions, type Settings } from '../../web/settings';
import type { SettingsPort } from '../../web/settingsPort';
import type { AdminArt, AdminTab } from '../faces';
import { exportSave } from '../saves';
import type { SavesPort } from '../savesPort';
import type { UiStore } from '../store';
import { at, BitmapWords, CANT_SAVE, Control, INK, KEYS_FONT, LIT, SEGMENTS, W, within, type Rect } from './parts';
import { ACTION_NAMES, keyName, keyRowName, useRebinding } from './rebinding';

export { KEY_NAMES, keyName } from './rebinding';

/**
 * The console's SETTINGS page (Plan 32 spec §5): every remake setting, on the console's screen as the original's own pages are drawn there. Three
 * tabs, GAME, COMBAT and KEYS, in pills of the CANCEL shape with the console's printed words; settings in the cells of the original's F1 options
 * screen (its Off/On rows and its Detail cycle box: tactical_hooks_ui.md §8), and the master level in the SOUND LEVELS bar's 27 segments. Every
 * rectangle is in the original's pixels, from the console's top left.
 */

/** A bar the console sets by a click or a key: SOUND LEVELS' two, and SETTINGS' master. */
export type Bar = 'voices' | 'music' | 'master';
type Tab = 'game' | 'combat' | 'keys';
const TABS: readonly { tab: Tab; name: string; word: AdminTab; width: number; x: number }[] = [
  { tab: 'game', name: 'GAME', word: 'tabGame', width: 74, x: 81 },
  { tab: 'combat', name: 'COMBAT', word: 'tabCombat', width: 94, x: 165 },
  { tab: 'keys', name: 'KEYS', word: 'tabKeys', width: 70, x: 269 },
];

/** The screen inside the sound page's frame (adminmnu.spr picture 5 at (44,47)), cleared for the settings: its bars, headings and divider. */
const INSIDE: Rect = [56, 59, 308, 190];
const TAB_Y = 62;
/** A pill's height, and its round end's width (the CANCEL pill's: adminmnu.mrg). */
const PILL_H = 18;
const CAP = 13;
/** The tab words (art admin publish's, cut from the console's printed text) are 12 rows high. */
const TAB_WORD_H = 12;
/** The line under the tabs, as the load page's lines under its rows. */
const RULE: Rect = [62, 85, 296, 1];
/** Setting row i: 20 high, 22 apart, under the tabs; its name at the left, its cells at the right. */
const rowY = (i: number) => 90 + 22 * i;
const LABEL_X = 64;
const CELLS_X = 238;
const CELLS_W = 120;
const ROW_H = 20;

/** The master bar: the sound bars' 27 segments, 6 apart, on their side (segment j from the left is the sound bar's j from its foot), right-aligned on row 0. */
const MASTER_X = 195;
const MASTER_SEG_H = 16;
const masterSeg = (j: number): Rect => [MASTER_X + 6 * j, rowY(0) + 2, 7, MASTER_SEG_H];
const MASTER: Rect = [MASTER_X, rowY(0) + 2, 6 * SEGMENTS + 1, MASTER_SEG_H];
/** The sound bar's foot (y 243 of the screen): a click dx along the master bar is the sound bar's click dx up from it. */
const BAR_FOOT = 243;
/** SEND FEEDBACK's pill, centred on GAME's row 5. */
const FEEDBACK_W = 150;

/** The KEYS tab's table: the F1 screen's two columns (the key, then what it does), here two tables of ten 15-high rows side by side. */
const KEY_ROWS = 10;
const KEY_ROW_H = 15;
const KEY_CELL_W = 44;
const ACTION_CELL_W = 100;
const keyRow = (i: number): Rect => [i < KEY_ROWS ? 62 : 214, 90 + KEY_ROW_H * (i % KEY_ROWS), KEY_CELL_W + ACTION_CELL_W, KEY_ROW_H];

/** The battle assist's difficulty (Plan 29), named apart from the console's DIFFICULTY (spec §12): `game` follows it. */
const BATTLE_DIFFICULTY_WORDS: Readonly<Record<CombatDifficulty, string>> = { game: 'AS DIFFICULTY', ensign: 'ENSIGN', lieutenant: 'LIEUTENANT', captain: 'CAPTAIN', story: 'STORY' };
const DETAILS: readonly CombatOptions['detail'][] = ['high', 'medium', 'low'];
const next = <T,>(all: readonly T[], now: T) => all[(all.indexOf(now) + 1) % all.length]!;

export interface SettingsPageProps {
  settings: SettingsPort;
  /** Absent where IndexedDB isn't: no IMPORT or EXPORT. */
  saves?: SavesPort;
  store: UiStore;
  art?: AdminArt;
  /** The game's fonts, when published: the words in the console's font 2 (and the key list in the F1 screen's font 0). */
  fonts: AstroFonts | null;
  /** The console's own ways: a change (its refusal said on the strip), a bar with its beep, and an import that closes the console. */
  set(change: Partial<Settings>): void;
  setBar(bar: Bar, level: number): void;
  /** The console's message strip (null: its page's own words again). */
  say(text: string | null): void;
  /**
   * The console's keyboard capture (adminConsole.tsx): while a key is wanted for a binding the page sets this to take the next keydown, which
   * answers whether it did; the console lets it first, before Esc, Tab and the rest.
   */
  grab: MutableRef<((e: KeyboardEvent) => boolean) | null>;
  run(what: () => Promise<void>, closing: boolean): Promise<void>;
  /** Opens the FEEDBACK page; absent where the site has no feedback. */
  feedback?: () => void;
}

export function SettingsPage({ settings, saves, store, art, fonts, set, setBar, say, grab, run, feedback }: SettingsPageProps) {
  const [tab, setTab] = useState<Tab>('game');
  const picker = useRef<HTMLInputElement>(null);
  const now = settings.get();
  const beep = () => settings.sound('beep7');
  /** The action waiting for its key (a row pressed): the next key is taken for it (rebinding.ts, shared with Tactical's F1 screen). */
  const { pending, wait } = useRebinding({ settings, set, say, grab, beep });
  // (leaving the page or the tab gives the wait up, and its message)
  useEffect(() => () => say(null), []);
  /** A cell or a cycle box pressed: the original's toggle sound (TEXT's, DIFFICULTY's). */
  const choose = (change: Partial<Settings>) => {
    settings.sound('softbop');
    set(change);
  };

  /** Words at the screen's left, a setting's name. */
  const label = (text: string, i: number) => {
    const r: Rect = [LABEL_X, rowY(i), CELLS_X - LABEL_X - 4, ROW_H];
    return fonts
      ? <BitmapWords key={text} fonts={fonts} text={text} r={r} ink={INK} />
      : <div key={text} class="au-admin-setname" style={at(r)} aria-hidden="true">{text}</div>;
  };
  /** A control's word, centred in `r` (the control's own rectangle, or a part of it): in the game's font, plain or lit (the lit one also there for the pointer). */
  const words = (text: string, r: Rect, outer: Rect, lit: boolean) => fonts && (
    <>
      <BitmapWords fonts={fonts} text={text} r={r} outer={outer} align="centre" ink={lit ? LIT : INK} />
      {!lit && <BitmapWords fonts={fonts} text={text} r={r} outer={outer} align="centre" ink={LIT} class="au-admin-hover" />}
    </>
  );
  /** A row of cells, one per choice, the chosen one lit (the F1 screen's Off/On rows). */
  const cells = <T,>(name: string, i: number, choices: readonly { value: T; word: string }[], chosen: T, pick: (value: T) => Partial<Settings>) => {
    const w = CELLS_W / choices.length;
    return choices.map(({ value, word }, k) => {
      const r: Rect = [CELLS_X + w * k, rowY(i), w, ROW_H];
      const on = value === chosen;
      return (
        <Control key={`${name} ${word}`} name={`${name} ${word}`} r={r} kind="cell" on={on} label={fonts ? undefined : word} data={{ 'aria-pressed': String(on) }} onClick={() => choose(pick(value))}>
          {words(word, r, r, on)}
        </Control>
      );
    });
  };
  /** The original's cycle box (the F1 screen's Detail): the chosen value, the next one at a press. */
  const cycle = (name: string, i: number, word: string, change: () => Partial<Settings>) => {
    const r: Rect = [CELLS_X, rowY(i), CELLS_W, ROW_H];
    return (
      <Control key={name} name={`${name} ${word}`} r={r} kind="cell" on label={fonts ? undefined : word} data={{ 'data-setting': name.toLowerCase() }} onClick={() => choose(change())}>
        {words(word, r, r, true)}
      </Control>
    );
  };
  const onOff = (name: string, i: number, value: boolean, field: (on: boolean) => Partial<Settings>) => [
    label(name, i),
    ...cells(name, i, [{ value: false, word: 'OFF' }, { value: true, word: 'ON' }], value, field),
  ];
  /** A pill of the CANCEL shape: its ends round, its word between them. */
  const pill = (name: string, r: Rect, onClick: () => void) => (
    <Control key={name} name={name} r={r} kind="cap" label={fonts ? undefined : name} onClick={onClick}>
      {words(name, [r[0] + CAP, r[1], r[2] - 2 * CAP, r[3]], r, false)}
    </Control>
  );

  const masterLit = barSegments(now.master);
  const combat = now.combat;
  const actions = saves ? [
    { name: 'IMPORT', width: 87, press: () => { beep(); picker.current?.click(); } },
    { name: 'EXPORT', width: 88, press: () => {
      beep();
      // (refused as SAVE is: a game exported mid-action would load half done)
      if (!saves.canSave()) say(saves.refusal?.() ?? CANT_SAVE);
      else void run(async () => exportSave(saves.exportText(), `${saves.gameId}-save.json`), false);
    } },
  ] : [];
  actions.push({ name: 'LOG', width: 60, press: () => { beep(); store.set({ panel: 'transcript' }); } });
  const actionsW = actions.reduce((sum, a) => sum + a.width, 0) + 14 * (actions.length - 1);
  let actionX = 62 + Math.round((296 - actionsW) / 2);

  return (
    <div class="au-admin-settings" data-tab={tab}>
      {art && <div class="au-admin-inside" style={at(INSIDE)} aria-hidden="true" />}
      {TABS.map(t => {
        const r: Rect = [t.x, TAB_Y, t.width, PILL_H];
        const on = tab === t.tab;
        const plain = art?.tabs?.[t.word];
        const lit = art?.tabs?.[`${t.word}Lit`];
        return (
          <Control key={t.tab} name={t.name} r={r} kind="cap" on={on} label={plain || fonts ? undefined : t.name} data={{ 'aria-pressed': String(on) }} onClick={() => {
            beep();
            if (pending !== null) wait(null);
            setTab(t.tab);
          }}>
            {plain && lit
              ? <TabWord plain={plain} lit={lit} on={on} />
              : words(t.name, [t.x + CAP, TAB_Y, t.width - 2 * CAP, PILL_H], r, on)}
          </Control>
        );
      })}
      <div class="au-admin-rule" style={at(RULE)} aria-hidden="true" />

      {tab === 'game' && (
        <>
          {label('MASTER', 0)}
          <div
            class="au-admin-bar au-admin-hbar"
            role="slider"
            tabIndex={0}
            aria-label="MASTER"
            aria-orientation="horizontal"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(now.master * 100)}
            style={at(MASTER)}
            data-bar="master"
            data-left={String(MASTER_X)}
            onPointerDown={e => {
              if (e.button !== 0) return;
              const console = (e.currentTarget as HTMLElement).closest('.au-admin-console');
              const box = console?.getBoundingClientRect();
              if (!box || box.width === 0) return;
              const dx = ((e.clientX - box.left) / box.width) * W - MASTER_X;
              setBar('master', levelFromBar(BAR_FOOT - dx));
            }}
          >
            {Array.from({ length: SEGMENTS }, (_, j) => {
              const on = j < masterLit;
              return art
                ? <span key={j} class="au-admin-hseg" style={within(MASTER, masterSeg(j))} data-seg={on ? 'on' : 'off'}><img src={art.button(on ? 'segOn' : 'segOff')} alt="" draggable={false} /></span>
                : <i key={j} class="au-admin-seg" style={within(MASTER, masterSeg(j))} data-seg={on ? 'on' : 'off'} />;
            })}
          </div>
          {onOff('ART', 1, now.art, art => ({ art }))}
          {onOff('HOTSPOT LABELS', 2, now.hotspots, hotspots => ({ hotspots }))}
          {onOff('MOVIES', 3, now.movies, movies => ({ movies }))}
          {onOff('3D SOUND', 4, now.threeD, threeD => ({ threeD }))}
          {/* (the remake's: a report to the developer, on the row left free above the actions) */}
          {feedback && pill('SEND FEEDBACK', [62 + Math.round((296 - FEEDBACK_W) / 2), rowY(5), FEEDBACK_W, PILL_H], feedback)}
          {actions.map(a => {
            const r: Rect = [actionX, rowY(6), a.width, PILL_H];
            actionX += a.width + 14;
            return pill(a.name, r, a.press);
          })}
          {saves && (
            <input
              ref={picker}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={e => {
                const input = e.currentTarget as HTMLInputElement;
                const file = input.files?.[0];
                // (cleared, so picking the same file again still reports a change)
                input.value = '';
                if (file) void run(async () => saves.importText(await file.text()), true);
              }}
            />
          )}
        </>
      )}

      {tab === 'combat' && (
        <>
          {onOff('STARS', 0, combat.stars, stars => ({ combat: { ...combat, stars } }))}
          {label('RESOLUTION', 1)}
          {cells('RESOLUTION', 1, [{ value: 1 as const, word: '1X' }, { value: 2 as const, word: '2X' }], combat.resolution, resolution => ({ combat: { ...combat, resolution } }))}
          {onOff('RADAR', 2, combat.radar, radar => ({ combat: { ...combat, radar } }))}
          {label('DETAIL', 3)}
          {cycle('DETAIL', 3, combat.detail.toUpperCase(), () => ({ combat: { ...combat, detail: next(DETAILS, combat.detail) } }))}
          {label('BATTLE DIFFICULTY', 4)}
          {cycle('BATTLE DIFFICULTY', 4, BATTLE_DIFFICULTY_WORDS[now.assists.difficulty], () => ({ assists: { ...now.assists, difficulty: next(COMBAT_DIFFICULTIES, now.assists.difficulty) } }))}
          {label('BATTLE SPEED', 5)}
          {cells('BATTLE SPEED', 5, BATTLE_SPEEDS.map(speed => ({ value: speed, word: `${speed}X` })), now.assists.speed, speed => ({ assists: { ...now.assists, speed } }))}
        </>
      )}

      {tab === 'keys' && (
        <>
          {BINDABLE_ACTIONS.map((action, i) => {
            const r = keyRow(i);
            const key = keyName(now.keys[action]);
            const does = ACTION_NAMES[action];
            const keyCell: Rect = [r[0] + 3, r[1], KEY_CELL_W - 3, r[3]];
            const doesCell: Rect = [r[0] + KEY_CELL_W + 4, r[1], ACTION_CELL_W - 4, r[3]];
            const waiting = pending === action;
            const shown = waiting ? '?' : key;
            return (
              <Control key={action} name={keyRowName(action, now.keys[action], waiting)} r={r} kind="keyrow" on={waiting} onClick={() => { beep(); wait(waiting ? null : action); }} data={{ 'data-action': action, 'aria-pressed': String(waiting) }}>
                <span class="au-admin-keycell" aria-hidden="true">{fonts ? '' : shown}</span>
                <span class="au-admin-keycell" aria-hidden="true">{fonts ? '' : does}</span>
                {fonts && <BitmapWords fonts={fonts} text={shown} r={keyCell} outer={r} ink={LIT} face={KEYS_FONT} />}
                {fonts && <BitmapWords fonts={fonts} text={does} r={doesCell} outer={r} ink={LIT} face={KEYS_FONT} />}
              </Control>
            );
          })}
          {/* (the table's last row, empty, as the options screen's own spare rows) */}
          {Array.from({ length: 2 * KEY_ROWS - BINDABLE_ACTIONS.length }, (_, k) => (
            <div key={k} class="au-admin-keyrow au-admin-keyspare" style={at(keyRow(BINDABLE_ACTIONS.length + k))} aria-hidden="true">
              <span class="au-admin-keycell" />
              <span class="au-admin-keycell" />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/** A tab's word, the console's own printed text (art admin publish's, 12 rows at its own width), in the pill's middle: lit when its tab is chosen, and under the pointer. */
function TabWord({ plain, lit, on }: { plain: string; lit: string; on: boolean }) {
  const style = { top: `${((PILL_H - TAB_WORD_H) / 2 / PILL_H) * 100}%`, height: `${(TAB_WORD_H / PILL_H) * 100}%` };
  const img = (src: string, cls?: string) => <img class={cls ? `au-admin-pic au-admin-tabword ${cls}` : 'au-admin-pic au-admin-tabword'} src={src} alt="" aria-hidden="true" draggable={false} style={style} />;
  return on ? img(lit) : <>{img(plain)}{img(lit, 'au-admin-hover')}</>;
}
