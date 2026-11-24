// SPDX-License-Identifier: GPL-3.0-or-later
import type { Ending, MissionDef } from '@another-unity/engine';
import { useEffect, useRef, useState } from 'preact/hooks';
import './missionSelect.css';

export interface MissionSelectText {
  /** Each mission's name, by its world's slug; a mission without one shows its world. */
  missions: Record<string, string>;
}

/** What the bridge needs from the session. */
export interface MissionSelectPort {
  /** game.yaml's missions, in the order the bridge offers them. */
  missions(): MissionDef[];
  /** A new game at the mission's beam-down screen, before anything runs. */
  choose(world: string): Promise<void>;
  /** The arrival movie's URL, if this mission has one (presentation.yaml `arrival`). */
  arrivalMovie(): string | undefined;
  /** Starts the game loop: the team beams down, with the transporter's effect and beam-down piece or without. */
  beamDown(effect: boolean): void;
  /** Null while the away mission goes on; else back on the ship, with the game-over reason if any. */
  onShip(): { gameOver: number | null } | null;
  /** A new game, held on the bridge (the loop and the music stop) until the team beams down again. */
  restart(): Promise<void> | void;
  /** endGame: won, or the reason's line. */
  ending(reason: number): Ending;
  subscribe(listener: () => void): () => void;
}

/**
 * Spec §9's minimal bridge: choose a mission, the ship arrives (the arrival movie), the team beams down, and the
 * bridge says when the mission is over. The team is game.yaml's, as ScummVM's walkthrough `start` uses; choosing it
 * in the transporter room is sub-project 4's (Plan 6 Decision 10).
 */
const WAIT = 'Wait until nothing is happening, then try again.';

export function MissionSelect({ text, port }: { text: MissionSelectText; port: MissionSelectPort }) {
  const [phase, setPhase] = useState<'briefing' | 'arriving' | 'away'>('briefing');
  const [chosen, setChosen] = useState<MissionDef | null>(null);
  // (a mission loads for a moment: a second click, even in the same tick, must not start another)
  const loading = useRef(false);
  const [busy, setBusy] = useState(false);
  // (a refused choice or restart: nothing is lost, and the player can try again)
  const [problem, setProblem] = useState<string | null>(null);
  const [, setRevision] = useState(0);
  useEffect(() => port.subscribe(() => setRevision(n => n + 1)), [port]);
  const beamDown = (m: MissionDef | null) => {
    setPhase('away');
    port.beamDown(m?.beamEffect !== false);
  };
  const choose = async (m: MissionDef) => {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    setChosen(m);
    setProblem(null);
    try {
      await port.choose(m.world);
    } catch (err) {
      console.warn(err);
      setChosen(null);
      setProblem(WAIT);
      return;
    } finally {
      loading.current = false;
      setBusy(false);
    }
    if (port.arrivalMovie() === undefined) beamDown(m);
    else setPhase('arriving');
  };

  if (phase === 'briefing') {
    return (
      <div class="au-bridge" role="dialog" aria-label="Bridge">
        <p>Choose a mission.</p>
        {problem !== null ? <p class="au-problem" role="alert">{problem}</p> : null}
        {port.missions().map(m => (
          <button key={m.world} type="button" data-world={m.world} disabled={busy} onClick={() => void choose(m)}>{text.missions[m.world] ?? m.world}</button>
        ))}
      </div>
    );
  }
  if (phase === 'arriving') {
    // (a movie that can't play ends at once: the game never waits on media)
    return (
      <div class="au-bridge au-arrival" role="dialog" aria-label="Arrival">
        <video src={port.arrivalMovie()} autoplay playsInline onEnded={() => beamDown(chosen)} onError={() => beamDown(chosen)} />
        <button type="button" onClick={() => beamDown(chosen)}>Skip</button>
      </div>
    );
  }
  const ship = port.onShip();
  if (!ship) return null;
  const restart = async () => {
    setProblem(null);
    try {
      await port.restart();
      setPhase('briefing');
    } catch (err) {
      console.warn(err);
      setProblem(WAIT);
    }
  };
  const trouble = problem !== null ? <p class="au-problem" role="alert">{problem}</p> : null;
  if (ship.gameOver === null) {
    return (
      <div class="au-bridge" role="dialog" aria-label="Bridge">
        <p>The away team is back aboard the Enterprise. Mission complete.</p>
        {trouble}
        <button type="button" onClick={() => void restart()}>Beam down again</button>
      </div>
    );
  }
  const end = port.ending(ship.gameOver);
  return (
    <div class="au-bridge" role="dialog" aria-label="Game over">
      <p>{end.won ? 'The end.' : `Game over (${ship.gameOver}).`}</p>
      {!end.won && end.text ? <p class="au-ending">{end.text}</p> : null}
      {trouble}
      <button type="button" onClick={() => void restart()}>Start a new game</button>
    </div>
  );
}
