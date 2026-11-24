// SPDX-License-Identifier: GPL-3.0-or-later
import type { JSX } from 'preact';
import { BUTTON } from '../../view/combat/console';
import type { HudModel } from '../../view/combat/hud';
import { HUD_PANEL, HUD_ROOT } from './hudPanels';

/** A lamp's state in words: updateLamps' 0, 1 and 2 (weapons.cpp:731-750). */
const LAMP_STATES = ['bears', 'damaged', 'does not bear'] as const;
/** The lamps' names: the six phaser banks, then the fore and aft tubes. */
const LAMP_NAMES = ['Bank 1', 'Bank 2', 'Bank 3', 'Bank 4', 'Bank 5', 'Bank 6', 'Fore tube', 'Aft tube'] as const;

/**
 * The wide view's slim HUD (M8 spec §5.2; Plan 27 R10): a strip along the top (the hull, the shields by facing, the speed and
 * the pace, the self-destruct's count when armed), the target in the top right corner, the log in the bottom left, and the lamps
 * with the fire buttons, the camera and Split in the bottom right. Its buttons are the console's (`press`, pressButton's way:
 * a beep, the button's 498 ms). Tap targets are at least 32 CSS px. The modern view's own.
 */
export function Hud({ model, press, drawer, view, assists }: {
  model: HudModel; press: (button: number) => void; drawer?: JSX.Element | null; view?: JSX.Element | null;
  /** The assists panel (Plan 29 R9): whether it is open, its button's toggle, and the panel itself when open. */
  assists?: { open: boolean; toggle: () => void; panel: JSX.Element | null };
}): JSX.Element {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div class={HUD_ROOT} role="group" aria-label="Wide view">
      {/* (the view under the pointer, under the HUD's own parts: Plan 29 R6) */}
      {view}
      {/* (each panel over the view is marked, for the target's arrow to keep clear of: hudPanels.ts) */}
      <div class="au-combat-hud-top" {...{ [HUD_PANEL]: '' }}>
        <span class="au-combat-hud-hull" data-hud="hull">{`Hull ${model.hull}%`}</span>
        <ul class="au-combat-hud-shields" aria-label="Shields">
          {model.shields.map((s, i) => (
            <li key={i} data-hud={`shield-${i}`} aria-label={`${s.name} ${pct(s.level)}`}>
              <span style={{ width: pct(s.level) }} />
            </li>
          ))}
        </ul>
        <span data-hud="speed">{`Speed ${model.speed}`}</span>
        <span data-hud="pace">{model.pace === 'paused' ? 'Paused' : `${model.pace}×`}</span>
        {model.selfDestruct !== null && <span class="au-combat-hud-countdown" data-hud="self-destruct" role="timer">{model.selfDestruct}</span>}
        {assists && <button type="button" data-hud="assists" aria-expanded={assists.open} onClick={assists.toggle}>Assists</button>}
      </div>
      <div class="au-combat-hud-target" data-hud="target" aria-label="Target" {...{ [HUD_PANEL]: '' }}>
        {model.target ? (
          <>
            <b>{model.target.name}</b>
            <span>{`Range ${model.target.range}`}</span>
            {model.target.shield && <span>{`${model.target.shield.name} ${model.target.shield.power}`}</span>}
          </>
        ) : <span>{model.sensorsBlank ? 'Sensors blank' : 'No target'}</span>}
      </div>
      <ol class="au-combat-hud-log" data-hud="log" aria-label="Log" {...{ [HUD_PANEL]: '' }}>{model.log.map((line, i) => <li key={i}>{line}</li>)}</ol>
      <div class="au-combat-hud-fire" {...{ [HUD_PANEL]: '' }}>
        <ul class="au-combat-hud-lamps" aria-label="Lamps">
          {model.lamps.map((l, i) => <li key={i} data-lamp={l} aria-label={`${LAMP_NAMES[i]} ${LAMP_STATES[l] ?? ''}`} />)}
        </ul>
        <button type="button" data-hud="phasers" onClick={() => press(BUTTON.phasers)}>Fire phasers</button>
        <button type="button" data-hud="torpedoes" onClick={() => press(BUTTON.torpedoes)}>Fire torpedoes</button>
        <button type="button" data-hud="both" onClick={() => press(BUTTON.both)}>Fire both</button>
        <button type="button" data-hud="view" onClick={() => press(BUTTON.view)}>Camera view</button>
        <button type="button" data-hud="split" onClick={() => press(BUTTON.full)}>Split view</button>
      </div>
      {drawer}
      {assists?.panel}
    </div>
  );
}
