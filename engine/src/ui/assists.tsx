// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { BATTLE_SPEEDS, COMBAT_DIFFICULTIES, type CombatDifficulty } from '../sim/combat/assists';
import { BRIDGE_EXIT } from '../sim/combat/tactical';
import { GAME_OVER_EXIT } from '../sim/combat/types';
import { ASTROGATION_EXIT } from '../sim/combat/warp';
import type { BattleResult } from '../sim/tacticalScreen';
import type { BattlePort } from '../web/battlePort';

/** The combat difficulty's choices (spec §5). */
export const DIFFICULTY_LABELS: Record<CombatDifficulty, string> = { game: 'As the game', ensign: 'Ensign', lieutenant: 'Lieutenant', captain: 'Captain', story: 'Story' };
/** What the settings say of Story (spec §5): the only assist that changes a battle's numbers. */
export const STORY_NOTE = 'Story: enemies deal a quarter of the damage and hit half as often. It is the only assist that changes a battle\'s numbers.';
/** When a new difficulty counts (Plan 23 R3): a battle keeps the one it started with. */
export const DIFFICULTY_NOTE = 'A new difficulty applies from the next battle.';
/** What auto-resolve's confirmation says (M8 spec §6.2; Plan 29 R10). */
export const AUTO_RESOLVE_NOTE = 'The battle is fought to its end without you, Delegate on. It can still be lost.';

/** How an auto-resolved battle came out, in a line. */
export function resultLine(r: BattleResult): string {
  if (r.outcome === 'stoodDown') return `Stood down after ${r.steps} steps: nothing left to fight in range.`;
  if (r.outcome === 'undecided') return `Still fighting after ${r.steps} steps.`;
  if (r.leave === GAME_OVER_EXIT) return `The Enterprise was lost after ${r.steps} steps.`;
  if (r.leave === BRIDGE_EXIT) return `The battle ended after ${r.steps} steps: back to the bridge.`;
  if (r.leave === ASTROGATION_EXIT) return `Retreated to astrogation after ${r.steps} steps.`;
  return `Left for ship screen 0x${(r.leave ?? 0).toString(16)} after ${r.steps} steps.`;
}

/**
 * The assists panel (M8 spec §6.2; Plan 29 R9, R10): the combat difficulty with Story's note, and fast-forward's speed, kept per
 * player (Plan 23's CombatAssists); with a battle at tactical, its pause and auto-resolve (a confirmed button), then auto-resolve's
 * result and the Enterprise's log until the player goes on. In the settings (the saves panel) and over the battle (Escape or
 * the HUD's button). Opening it doesn't pause. Its keys are its own (`data-keys`, Plan 29 R2): Escape closes it (`onClose`).
 */
export function AssistsPanel({ port, onClose }: { port: BattlePort; onClose?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  const warpId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const autoRef = useRef<HTMLButtonElement>(null);
  const resolveRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes once the confirmation closes: Auto-resolve when cancelled, the panel when it was acted on. */
  const afterConfirm = useRef<'auto' | 'panel'>('panel');
  const view = port.battle();
  const assists = port.assists();
  // (a battle that ends or is resolved puts the question away; none under the warp overlay, whose clock jump auto-resolve's own
  // clock would drop, Plan 26's hand-on: Plan 29 R10)
  const resolvable = view !== null && !view.resolving && view.resolved === null && !view.warp;
  useEffect(() => { if (!resolvable) setConfirming(false); }, [resolvable]);
  // Focus follows what the panel shows, so a keyboard player (and Escape) stays inside it: into the question, back out of it, to
  // the result's Continue, and to the panel when that goes.
  const hadConfirm = useRef(false);
  useEffect(() => {
    if (confirming) resolveRef.current?.focus();
    else if (hadConfirm.current) (afterConfirm.current === 'auto' ? autoRef.current : rootRef.current)?.focus();
    hadConfirm.current = confirming;
  }, [confirming]);
  const hasResult = view?.resolved != null;
  const hadResult = useRef(false);
  useEffect(() => {
    if (hasResult) continueRef.current?.focus();
    else if (hadResult.current) rootRef.current?.focus();
    hadResult.current = hasResult;
  }, [hasResult]);
  const cancel = () => { afterConfirm.current = 'auto'; setConfirming(false); };
  // (the battle can end between the frame drawn and the click: the port throws, said like the other controls' failures)
  const attempt = (f: () => Promise<void> | void) => {
    setProblem(null);
    Promise.resolve().then(f).catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)));
  };
  return (
    <div class="au-assists" role="region" aria-label="Assists" data-keys="page" ref={rootRef} tabIndex={-1}
      onKeyDown={e => {
        if (e.key !== 'Escape') return;
        // (a question open: Escape withdraws it, and the panel stays)
        if (confirming) { e.preventDefault(); e.stopPropagation(); cancel(); return; }
        if (!onClose) return;
        e.preventDefault();
        onClose();
      }}>
      <div class="au-group">
        <label>
          {'Combat difficulty '}
          <select aria-label="Combat difficulty" aria-describedby={noteId} onChange={ev => port.setAssists({ ...port.assists(), difficulty: (ev.currentTarget as HTMLSelectElement).value as CombatDifficulty })}>
            {COMBAT_DIFFICULTIES.map(d => <option key={d} value={d} selected={assists.difficulty === d}>{DIFFICULTY_LABELS[d]}</option>)}
          </select>
        </label>
      </div>
      <p id={noteId}>{STORY_NOTE} {DIFFICULTY_NOTE}</p>
      <div class="au-group" role="group" aria-label="Speed">
        {BATTLE_SPEEDS.map(speed => (
          <button key={speed} type="button" aria-pressed={assists.speed === speed} onClick={() => port.setAssists({ ...port.assists(), speed })}>{`${speed}×`}</button>
        ))}
      </div>
      {view && (
        <div class="au-group">
          <button type="button" aria-pressed={view.paused} disabled={view.resolving || view.resolved !== null} onClick={() => attempt(() => port.pause(!view.paused))}>{view.paused ? 'Resume' : 'Pause'}</button>
          <button type="button" ref={autoRef} disabled={!resolvable || confirming} aria-describedby={view.warp ? warpId : undefined} onClick={() => { afterConfirm.current = 'panel'; setConfirming(true); }}>Auto-resolve</button>
        </div>
      )}
      {view?.warp && <p id={warpId}>Auto-resolve waits until the warp ends.</p>}
      {view && confirming && resolvable && (
        <div class="au-group" role="group" aria-label="Auto-resolve this battle?">
          <p>{AUTO_RESOLVE_NOTE}</p>
          <button type="button" ref={resolveRef} onClick={() => { afterConfirm.current = 'panel'; setConfirming(false); attempt(() => port.autoResolve()); }}>Resolve it</button>
          <button type="button" onClick={cancel}>Cancel</button>
        </div>
      )}
      {/* (always there with a battle, only its text changing, so the progress and the result are announced) */}
      {view && (
        <div role="status" aria-label={view.resolved ? 'Result' : undefined}>
          <p>{view.resolving ? 'Resolving the battle…' : view.resolved ? resultLine(view.resolved) : ''}</p>
        </div>
      )}
      {view?.resolved && (
        <div>
          <ol aria-label="Enterprise log">{view.resolved.log.map((line, i) => <li key={i}>{line}</li>)}</ol>
          <button type="button" ref={continueRef} onClick={() => attempt(() => port.finish())}>Continue</button>
        </div>
      )}
      {onClose && !view?.resolving && !view?.resolved && <button type="button" onClick={onClose}>Close</button>}
      {problem && <p class="au-error" role="alert">{problem}</p>}
    </div>
  );
}
