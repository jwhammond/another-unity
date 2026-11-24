// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'preact/hooks';
import { updateBattle } from '../sim/combat/battle';
import { setupBattle } from '../sim/combat/setup';
import { applyCommand, type CombatCommand } from '../sim/combat/commands';
import { shipTickToMs, STEP_TIME, systemsToBattleClock } from '../sim/combat/time';
import { DAMAGE_SEAMS } from '../sim/combat/damage';
import { SIM_SEAMS } from '../sim/combat/seams';
import { NO_SEAMS, type BattleContext, type BattleState, type CombatSeams } from '../sim/combat/types';
import { WEAPON_SEAMS } from '../sim/combat/weapons';
import type { World } from '../sim/world';
import { combatReadError, ensureCombat } from '../sim/combatData';
import { BattleView, WRAP } from './battleView';
import { keepWarning } from './combatTactics';

interface Running { ctx: BattleContext; b: BattleState; clock: number }

/**
 * The debug view (spec §4.8): a battle from the lifted data, fought on a copy of the ship's systems with weapons,
 * damage, the AI and tactics (the AI button leaves the last two out of the next battle, for a target that sits still),
 * and `seams` over them; drawn from above with its beams, torpedoes, explosions, shield flashes and debris, with the
 * console's commands as plain controls, Delegate and the scripts' state, the maneuver menu and the tactics' warnings.
 * It never changes the game: the world's scripts don't run (NO_SEAMS), and Plan 22 starts real battles.
 */
export function CombatPanel({ world, seams = {} }: { world: World; seams?: Partial<CombatSeams> }) {
  const ship = world.content.ship;
  const combat = ship?.combat;
  const scenarios = combat ? Object.keys(combat.battles).map(Number).sort((a, c) => a - c) : [];
  const preferred = ship?.data.astro.defaultBattle;
  const [scenario, setScenario] = useState(String(preferred !== undefined && combat?.battles[preferred] ? preferred : scenarios[0] ?? ''));
  const [seed, setSeed] = useState('1');
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ai, setAi] = useState(true);
  const warnings = useRef<string[]>([]);
  const [, setVersion] = useState(0);
  const running = useRef<Running | null>(null);
  const bump = () => setVersion(v => v + 1);

  // (combat.yaml, read when the tab first opens in a game parsed without it, as a battle reads it: M8 spec §8; a failed read
  // says why, and Try again reads again)
  const [readError, setReadError] = useState<string | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    if (combat) return;
    setReadError(null);
    void ensureCombat(world).then(read => {
      if (!read) {
        setReadError(combatReadError(world) ?? 'combat.yaml could not be read.');
        return;
      }
      const ids = Object.keys(read.battles).map(Number).sort((a, c) => a - c);
      setScenario(String(preferred !== undefined && read.battles[preferred] ? preferred : ids[0] ?? ''));
    });
  }, [world, readAttempt]);

  // (the battle clock runs with the page's time while playing; each update steps whatever 66 ms steps are due)
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(t) {
      const r = running.current;
      if (r) {
        r.clock += t - last;
        advance(r.ctx, r.b, Math.floor(r.clock));
        bump();
      }
      last = t;
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const b = running.current?.b ?? null;

  if (!ship || !combat) {
    if (!world.combatSource) return <p>This game has no combat.yaml.</p>;
    if (readError === null) return <p>Reading combat.yaml…</p>;
    return (
      <p role="alert">
        {readError} <button type="button" onClick={() => setReadAttempt(n => n + 1)}>Try again</button>
      </p>
    );
  }

  const start = () => {
    setPlaying(false);
    // (a copy of the ship's systems: the dev view never touches the game)
    const systems = structuredClone(world.state.ship.systems);
    const now = shipTickToMs(world.state.tick);
    systemsToBattleClock(systems, world.state.tick, now);
    warnings.current = [];
    const ctx: BattleContext = {
      combat, enterpriseUnits: ship.data.units,
      seams: { ...NO_SEAMS, ...(ai ? SIM_SEAMS : { ...WEAPON_SEAMS, ...DAMAGE_SEAMS }), ...seams },
      // (the latest few, each once: a stuck script warns every step)
      onWarning: m => { warnings.current = keepWarning(warnings.current, m); },
    };
    try {
      const previous = running.current?.b;
      const { battle, warnings: setupWarnings } = setupBattle(ctx, {
        scenario: Number(scenario), seed: Number(seed) >>> 0, now, difficulty: world.difficulty,
        active: id => world.state.objects[id]?.active ?? false, enterprise: systems, ...(previous ? { previous } : {}),
      });
      running.current = battle ? { ctx, b: battle, clock: now } : null;
      setError(setupWarnings.length > 0 ? setupWarnings.join('; ') : null);
    } catch (err) {
      running.current = null;
      setError(err instanceof Error ? err.message : String(err));
    }
    bump();
  };
  const send = (cmd: CombatCommand) => {
    const r = running.current;
    if (!r) return;
    applyCommand(r.ctx, r.b, cmd);
    bump();
  };
  const stepOnce = () => {
    const r = running.current;
    if (!r) return;
    r.clock = r.b.lastStep + STEP_TIME;
    advance(r.ctx, r.b, r.clock);
    bump();
  };

  return (
    <div class="au-dev-combat">
      <div class="au-group" style={WRAP}>
        <select aria-label="Battle" value={scenario} onChange={ev => setScenario((ev.currentTarget as HTMLSelectElement).value)}>
          {scenarios.map(n => <option key={n} value={String(n)}>{`${n} (0x${n.toString(16)}) ${combat.battles[n]!.screen}`}</option>)}
        </select>
        <input aria-label="Seed" size={8} value={seed} onInput={ev => setSeed((ev.currentTarget as HTMLInputElement).value)} />
        <button onClick={start}>Start</button>
        <button disabled={!b} onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
        <button disabled={!b} onClick={stepOnce}>Step</button>
        <button aria-pressed={ai} onClick={() => setAi(a => !a)}>AI</button>
      </div>
      {error && <p class="au-dev-error">{error}</p>}
      {b && <BattleView b={b} combat={combat} send={send} warnings={warnings.current} />}
    </div>
  );
}

/** updateBattle, then drop the cues and sounds it asked for: the dev view plays nothing (Plan 22 plays them), so they'd pile up. */
function advance(ctx: BattleContext, b: BattleState, now: number): void {
  updateBattle(ctx, b, now);
  b.cues.length = 0;
  b.sounds.length = 0;
}
