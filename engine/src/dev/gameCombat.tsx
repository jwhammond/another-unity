// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useState } from 'preact/hooks';
import { BATTLE_SPEEDS, COMBAT_DIFFICULTIES, type CombatDifficulty } from '../sim/combat/assists';
import { DIFFICULTY_LABELS, DIFFICULTY_NOTE, resultLine, STORY_NOTE } from '../ui/assists';
import type { BattlePort } from '../web/battlePort';
import { BattleView, WRAP } from './battleView';

// (the assists panel's words, which the players' panel shows too: ui/assists.tsx, Plan 29)
export { DIFFICULTY_NOTE, resultLine, STORY_NOTE };

/** The summary of the dev view's fold-out at tactical (given to the ship panel from here: the shipped code has no dev text). */
export const DEV_TOOLS_LABEL = 'Dev tools';

/**
 * The world's battle at tactical, behind ?dev until M8 builds the console (Plan 23): the debug view over the game's own
 * battle, its orders given to the world, with the assists (spec §5): pause, fast-forward, auto-resolve with its result
 * and the Enterprise's log, and the combat difficulty, Story's note beside it.
 */
export function GameCombat({ port }: { port: BattlePort }) {
  const [, setFrame] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = useId();
  // (the battle moves on with the world's ticks: redrawn each animation frame while shown)
  useEffect(() => {
    let id = requestAnimationFrame(function draw() {
      setFrame(f => f + 1);
      id = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(id);
  }, []);
  const view = port.battle();
  if (!view) return null;
  const assists = port.assists();
  const attempt = (p: Promise<void>) => { setProblem(null); p.catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err))); };
  return (
    <div class="au-dev-combat" role="region" aria-label="Battle" style={{ pointerEvents: 'auto' }}>
      <div class="au-group" style={WRAP}>
        {/* (the battle can end between the frame drawn and the click: pause then throws, said like the other controls' failures) */}
        <button aria-pressed={view.paused} disabled={view.resolving} onClick={() => attempt(Promise.resolve().then(() => port.pause(!view.paused)))}>{view.paused ? 'Resume' : 'Pause'}</button>
        <span role="group" aria-label="Speed">
          {BATTLE_SPEEDS.map(speed => (
            <button key={speed} aria-pressed={assists.speed === speed} onClick={() => port.setAssists({ ...port.assists(), speed })}>{`${speed}×`}</button>
          ))}
        </span>
        <button disabled={view.resolving || view.resolved !== null} onClick={() => attempt(port.autoResolve())}>Auto-resolve</button>
        <label>
          {'Combat difficulty '}
          <select aria-label="Combat difficulty" aria-describedby={noteId} onChange={ev => port.setAssists({ ...port.assists(), difficulty: (ev.currentTarget as HTMLSelectElement).value as CombatDifficulty })}>
            {COMBAT_DIFFICULTIES.map(d => <option key={d} value={d} selected={assists.difficulty === d}>{DIFFICULTY_LABELS[d]}</option>)}
          </select>
        </label>
      </div>
      <p id={noteId}>{STORY_NOTE} {DIFFICULTY_NOTE}</p>
      {view.resolved && (
        <div aria-label="Result">
          <p>{resultLine(view.resolved)}</p>
          <ol aria-label="Enterprise log">{view.resolved.log.map((line, i) => <li key={i}>{line}</li>)}</ol>
          <button onClick={() => attempt(port.finish())}>Continue</button>
        </div>
      )}
      {problem && <p class="au-dev-error" role="alert">{problem}</p>}
      <BattleView b={view.b} combat={view.combat} send={cmd => port.command(cmd)} redFlash={view.redFlash} />
    </div>
  );
}
