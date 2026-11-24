// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { BattlePort } from '../../web/battlePort';
import type { ShipPort } from '../../web/shipPort';
import { useAttempt, usePort } from './hooks';
import { hudPanelRects } from '../combat/hudPanels';

/**
 * Tactical (TacticalScreen, tactical.cpp). With the combat sim's battle (behind ?dev until M8's switch-on: Plan 23 R2) it is
 * the console (Plan 27), the combat chunk's, in a 640 x 480 box the space view is drawn in, or the whole frame when wide; `dev`,
 * the dev view, folds out over it, under the summary `devLabel` (which the dev chunk gives, so the shipped code has no dev text), with the dialog's three ways out as a test shortcut. Otherwise the placeholder combat dialog
 * (Decision 1, R3): the battle's ships, the alert, and the three ways out. A hail's conversation is the ordinary dialog, over this.
 */
export function TacticalPanel({ port, battle, dev, devLabel }: { port: ShipPort; battle?: BattlePort; dev?: ComponentChildren; devLabel?: string }) {
  usePort(port);
  const [problem, attempt] = useAttempt();
  const box = useRef<HTMLDivElement>(null);
  const wide = useRef<HTMLDivElement | null>(null);
  // (the wide view's frame, which the console's HUD is drawn into: Plan 27 R10. A ref callback of its own, made once, so a render
  // doesn't let go of the element and take it again)
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const frameRef = useCallback((el: HTMLDivElement | null) => {
    wide.current = el;
    setFrame(el);
  }, []);
  const view = port.combat();
  const fight = battle?.battle() ?? null;
  // (where the space view is drawn: the console's box, or the game frame when wide, read each frame; Plan 27 R3)
  useLayoutEffect(() => {
    if (!battle || !fight) return undefined;
    battle.viewBox(w => (w ? wide.current : box.current)?.getBoundingClientRect() ?? null);
    // (and what the wide view's HUD covers of it, for the target's arrow: Plan 32 Task 9)
    battle.hudBoxes(() => (wide.current ? hudPanelRects(wide.current) : []));
    return () => {
      battle.viewBox(null);
      battle.hudBoxes(null);
    };
  }, [battle, fight !== null]);
  if (view === null) return null;
  const ways = (
    <p>
      <button type="button" onClick={() => attempt(() => port.resolve('win'))}>Win</button>
      <button type="button" onClick={() => attempt(() => port.resolve('flee'))}>Flee</button>
      <button type="button" onClick={() => attempt(() => port.resolve('lose'))}>Lose</button>
    </p>
  );
  const ships = (
    <ul class="au-ship-ships" aria-label="Ships">
      {view.ships.map(ship => (
        <li key={ship.id} data-ship={ship.id} data-friendly={ship.friendly} data-destroyed={ship.destroyed}>
          {ship.label}{ship.friendly ? ' (friendly)' : ''}{ship.destroyed ? ' (destroyed)' : ''}
        </li>
      ))}
    </ul>
  );
  if (battle && fight) {
    const chunk = battle.chunk();
    return (
      <div class="au-console" role="region" aria-label="Tactical">
        <h2 class="au-visually-hidden">Tactical{view.redAlert ? ' (red alert)' : ''}</h2>
        <div class="au-console-wide" ref={frameRef} />
        <div class="au-ship-screen au-console-screen" ref={box} role="group" aria-label="Console">
          {chunk && <chunk.CombatConsole port={battle} wide={frame} />}
        </div>
        {dev !== undefined && (
          <details class="au-console-dev">
            <summary>{devLabel}</summary>
            {dev}
            {ships}
            {ways}
            {problem !== null && <p class="au-problem" role="alert">{problem}</p>}
          </details>
        )}
      </div>
    );
  }
  return (
    <div class="au-ship-tactical" role="region" aria-label="Tactical">
      <h2>Tactical{view.redAlert ? ' (red alert)' : ''}</h2>
      {ships}
      {view.hailWaiting && <button type="button" onClick={() => attempt(() => port.answerHail())}>Answer hail</button>}
      {ways}
      {problem !== null && <p class="au-problem" role="alert">{problem}</p>}
    </div>
  );
}
