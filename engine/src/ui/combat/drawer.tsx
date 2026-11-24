// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX, RefObject } from 'preact';
import { CONSOLE_PAGES, type CombatCommand, type ConsolePage } from '../../sim/combat/commands';
import { maneuverAt } from '../../sim/combat/maneuvers';
import type { BattleState } from '../../sim/combat/types';
import { BUTTON, MANEUVER_ROWS, PAGE_LABELS, selfDestructText } from '../../view/combat/console';
import { pendingSwitches } from '../../view/combat/consoleInput';
import { HUD_PANEL } from './hudPanels';
import type { BattleView } from '../../web/battlePort';

/**
 * The scanner's part of the console's picture, which the drawer shows on the two scanner pages: [x, y, width, height]. drawScanner's
 * area (its picture's box from y 309, tactical.cpp:1200; the name field and the log from x 130 to y 474, :1209, :1245; the range,
 * heading and closure fields to x 466, :1226-1236), with a few pixels' margin: the port's choice.
 */
export const SCANNER_CROP = [130, 305, 337, 170] as const;

/** What the drawer does: the console's own ways (console.tsx), so the delays, beeps and lockout are the console's. */
export interface DrawerActions {
  /** A tab (not while a button is down, as mouseClick). */
  page(page: ConsolePage): void;
  /** A console button by its number (BUTTON): pressButton's way. */
  press(button: number): void;
  /** An order as a click on the console gives it, with its beep where the original beeps. */
  send(cmd: CombatCommand, beep?: boolean): void;
  /** A slider's order: not locked out by a button that is down, as dragSlider isn't. */
  drag(cmd: CombatCommand): void;
}

/**
 * The console as a drawer over the wide view (M8 spec §5.2, Decision 16; Plan 27 R10): the six pages laid out for touch, each
 * control at least 32 CSS px and doing what the console's does (the same orders, through `act`), the scanner pages showing the
 * console's own scanner picture; and Bridge and Engineering. Closed, a handle. The modern view's own; the radar isn't in it, as
 * the original's Full has none (tactical.cpp:1315-1316).
 */
export function Drawer({ view, open, onToggle, act, scanner }: {
  view: BattleView; open: boolean; onToggle: () => void; act: DrawerActions; scanner: RefObject<HTMLCanvasElement>;
}): JSX.Element {
  const b = view.b;
  const c = b.console;
  const e = b.ships[0];
  const page = view.page;
  // (a switch as the orders waiting will leave it: Plan 29 R3)
  const on = pendingSwitches(b, view.queued);
  const toggle = (label: string, button: number, on: boolean) => (
    <button type="button" aria-pressed={on} onClick={() => act.press(button)}>{label}</button>
  );
  let body: JSX.Element;
  if (page === 'phasers') {
    body = (
      <>
        {(e?.banks ?? []).slice(0, 6).map((bank, i) => {
          const unit = e!.systems.units[bank.unit];
          const charge = bank.active ? bank.charge : unit && unit.max ? Math.trunc((unit.current * 100) / unit.max) : 0;
          return (
            <label key={i}>
              {`Bank ${i + 1}`}
              {/* (the port's own step of 5: dragSlider takes any setting, tactical.cpp:624, but drawSliders shows them in fives, and a
                  touch slider in ones is too fine to tap) */}
              <input type="range" min={0} max={100} step={5} value={bank.setting} aria-label={`Phaser bank ${i + 1}`}
                onInput={ev => act.drag({ type: 'bank', bank: i, setting: Number((ev.currentTarget as HTMLInputElement).value) })} />
              <span>{`${charge}%`}</span>
            </label>
          );
        })}
        <div class="au-drawer-row">
          <button type="button" onClick={() => act.press(BUTTON.allPhasers)}>All banks</button>
          <button type="button" onClick={() => act.press(BUTTON.noPhasers)}>No banks</button>
        </div>
      </>
    );
  } else if (page === 'torpedoes') {
    body = (
      <>
        {([0, 1] as const).map(tube => (
          <label key={tube}>
            {tube === 0 ? 'Fore salvo' : 'Aft salvo'}
            <input type="range" min={0} max={10} step={1} value={c.salvo[tube].setting} aria-label={tube === 0 ? 'Fore salvo' : 'Aft salvo'}
              onInput={ev => act.drag({ type: 'salvo', tube, setting: Number((ev.currentTarget as HTMLInputElement).value) })} />
            <span>{`${c.salvo[tube].loaded} loaded`}</span>
          </label>
        ))}
        <div class="au-drawer-row" role="group" aria-label="Spread">
          {Array.from({ length: 10 }, (_, cell) => toggle(`${cell * 5}°`, BUTTON.spread + cell, c.spreadDegrees === cell * 5))}
        </div>
      </>
    );
  } else if (page === 'conn') {
    body = (
      <>
        <div class="au-drawer-row">
          {toggle('Shields', BUTTON.shields, on.shieldsRaised)}
          {toggle('Weapons lock', BUTTON.weaponsLock, on.weaponsLock)}
          {toggle('Self-destruct', BUTTON.selfDestruct, c.selfDestructTime !== 0)}
          {toggle('Delegate', BUTTON.delegate, on.delegate)}
        </div>
        <div class="au-drawer-row" role="group" aria-label="Power level">
          {[0, 1, 2, 3, 4].map(level => (
            <button key={level} type="button" aria-pressed={c.powerLevel === level} onClick={() => act.send({ type: 'powerLevel', level })}>{`Power ${level}`}</button>
          ))}
        </div>
        {c.selfDestructTime !== 0 && <p role="timer">{selfDestructText(c.selfDestructTime, b.now)}</p>}
      </>
    );
  } else if (page === 'tactics') {
    body = (
      <>
        <ol class="au-drawer-rows" aria-label="Maneuvers">
          {Array.from({ length: MANEUVER_ROWS }, (_, row) => {
            const item = maneuverAt(b as BattleState, row);
            return (
              <li key={row}>
                <button type="button" aria-current={c.menuSelected === row ? 'true' : undefined} disabled={!item} onClick={() => act.send({ type: 'maneuver', row })}>
                  {item ? `${item.heading ? (item.open ? '▾ ' : '▸ ') : ''}${item.label}` : ''}
                </button>
              </li>
            );
          })}
        </ol>
        <div class="au-drawer-row">
          <button type="button" onClick={() => act.send({ type: 'scrollManeuvers', direction: -1 }, true)}>Maneuvers up</button>
          <button type="button" onClick={() => act.send({ type: 'scrollManeuvers', direction: 1 }, true)}>Maneuvers down</button>
          <button type="button" aria-pressed={c.engageButton} onClick={() => act.send({ type: 'engage' }, true)}>{c.engageButton ? 'Disengage' : 'Engage'}</button>
        </div>
      </>
    );
  } else {
    body = <canvas ref={scanner} class="au-drawer-scanner" width={SCANNER_CROP[2]} height={SCANNER_CROP[3]} aria-hidden="true" />;
  }
  return (
    <div class={open ? 'au-drawer au-drawer-open' : 'au-drawer'} data-hud="drawer">
      {/* (the handle and, open, the body are over the wide view: the target's arrow keeps clear of them, hudPanels.ts) */}
      <button type="button" class="au-drawer-handle" aria-expanded={open} onClick={onToggle} {...{ [HUD_PANEL]: '' }}>Console</button>
      {open && (
        <div class="au-drawer-body" role="region" aria-label="Console drawer" data-page={page} {...{ [HUD_PANEL]: '' }}>
          <div class="au-drawer-row" role="tablist" aria-label="Pages">
            {CONSOLE_PAGES.map((p, i) => (
              <button key={p} type="button" role="tab" aria-selected={p === page} onClick={() => act.page(p)}>{PAGE_LABELS[i]}</button>
            ))}
          </div>
          {body}
          <div class="au-drawer-row">
            <button type="button" onClick={() => act.press(BUTTON.bridge)}>{c.redAlert ? 'Hail' : 'Bridge'}</button>
            <button type="button" onClick={() => act.press(BUTTON.engineering)}>Engineering</button>
          </div>
        </div>
      )}
    </div>
  );
}
