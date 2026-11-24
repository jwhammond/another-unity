// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'preact/hooks';
import type { CombatData } from '../content/types';
import { distance } from '../sim/combat/battle';
import type { CombatCommand, Held } from '../sim/combat/commands';
import { MANEUVER_ROWS } from '../sim/combat/maneuvers';
import { NO_EXIT, type BattleState } from '../sim/combat/types';
import { combatScene, type CombatScene } from './combatScene';
import { consoleLine, maneuverRows, shipLine } from './combatTactics';

/** The canvas's size, in CSS pixels. */
export const SIZE = 400;
/** The overlay is 420 px wide: the console's rows wrap. */
export const WRAP = { flexWrap: 'wrap' } as const;
type Axis = 'yaw' | 'pitch' | 'roll' | 'throttle';
/** The flight keys as hold-down buttons: label, axis, direction. */
const HOLDS: [string, Axis, Held][] = [
  ['Yaw ←', 'yaw', -1], ['Yaw →', 'yaw', 1], ['Pitch ↑', 'pitch', 1], ['Pitch ↓', 'pitch', -1],
  ['Roll ←', 'roll', -1], ['Roll →', 'roll', 1], ['Faster', 'throttle', 1], ['Slower', 'throttle', -1],
];
/** The console's other commands, as plain buttons. The tactical screen's (hail, bridge, engineering) are the world's: in the dev tab's battle they do nothing (NO_SEAMS). */
const BUTTONS: [string, CombatCommand][] = [
  ['All stop', { type: 'allStop' }], ['Phasers', { type: 'fire', weapon: 'phasers' }], ['Torpedoes', { type: 'fire', weapon: 'torpedoes' }],
  ['Both', { type: 'fire', weapon: 'both' }], ['Target ◀', { type: 'target', which: 'prev' }], ['Target ▶', { type: 'target', which: 'next' }],
  ['No target', { type: 'target', ship: null }], ['Self-destruct', { type: 'selfDestruct' }],
  ['Hail', { type: 'hail' }], ['Bridge', { type: 'bridge' }], ['Engineering', { type: 'engineering' }],
];
/** The Phasers page's All and None (pressButton, tactical.cpp:565-569). */
const BANK_BUTTONS: [string, CombatCommand][] = [['All banks', { type: 'banks', all: true }], ['No banks', { type: 'banks', all: false }]];
/** The Torpedoes page's tubes: the fore tube is 0 (tactical.cpp:627-630). */
const SALVOES: [string, 0 | 1][] = [['Fore salvo', 0], ['Aft salvo', 1]];
/** The Tactics page's arrows and Engage (mouseClick, tactical.cpp:666-686). */
const TACTICS_BUTTONS: [string, CombatCommand][] = [
  ['Maneuvers ▲', { type: 'scrollManeuvers', direction: -1 }], ['Maneuvers ▼', { type: 'scrollManeuvers', direction: 1 }], ['Engage', { type: 'engage' }],
];
/**
 * The camera keys kActionCameraView1-8 (actionStart, tactical.cpp:789-813): the view, and whose. The views are
 * Combat::kViewTarget 0xc, kViewChase 0, kViewForward 0x12, kViewChaseClose 5, kViewOverview 7, kViewDrop 0x11 and
 * kViewSpinRoll 9 (combat.h:285-301).
 */
const VIEWS: [number, 'enterprise' | 'target'][] = [
  [0xc, 'enterprise'], [0, 'enterprise'], [0xc, 'target'], [0x12, 'enterprise'], [5, 'enterprise'], [7, 'enterprise'], [0x11, 'enterprise'], [9, 'enterprise'],
];
const CAMERA_BUTTONS: [string, CombatCommand][] = [
  ['Cycle view', { type: 'cycleView' }], ['Zoom in', { type: 'zoom', direction: 'in' }], ['Zoom out', { type: 'zoom', direction: 'out' }],
];
/** The camera's orbit keys, held like the flight keys. */
const ORBITS: [string, Held][] = [['Orbit ←', -1], ['Orbit →', 1]];

/**
 * A battle as the debug view shows it (spec §4.8), split from CombatPanel for Plan 23's battle in the game: drawn from
 * above with its beams, torpedoes, explosions, shield flashes and debris, with the console's commands as plain controls
 * (each given to `send`), Delegate and the scripts' state, the maneuver menu, the ships, a ship's log and the warnings.
 * `redFlash` is the last frame's flash where the battle's own flag has been taken (the game's).
 */
export function BattleView({ b, combat, send, warnings = [], redFlash }: {
  b: Readonly<BattleState>; combat: CombatData; send: (cmd: CombatCommand) => void; warnings?: readonly string[]; redFlash?: boolean;
}) {
  const [shown, setShown] = useState(0);
  const held = useRef<Record<Axis, Held>>({ yaw: 0, pitch: 0, roll: 0, throttle: 0 });
  const orbiting = useRef<Held>(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  // (a new battle holds no keys: setup clears them)
  useEffect(() => {
    held.current = { yaw: 0, pitch: 0, roll: 0, throttle: 0 };
    orbiting.current = 0;
    setShown(0);
  }, [b]);
  useEffect(() => { paint(canvas.current, combatScene(b as BattleState, SIZE, SIZE)); });
  const hold = (axis: Axis, dir: Held) => {
    held.current = { ...held.current, [axis]: dir };
    send({ type: 'steer', ...held.current });
  };
  const orbit = (direction: Held) => {
    orbiting.current = direction;
    send({ type: 'orbit', direction });
  };
  const e = b.ships[0];
  if (!e) return null;
  const logShip = b.ships[shown] ?? e;
  return (
    <>
      <p aria-label="Battle status" data-steps={b.steps}>
        {`step ${b.steps} · ${b.now} ms · exit ${b.exitCode === NO_EXIT ? 'none' : `0x${b.exitCode.toString(16)}`} · target ${b.target ?? 'none'}`}
      </p>
      <p aria-label="Enterprise">
        {`speed ${e.speed.toFixed(1)} of ${e.maxSpeed.toFixed(0)} · throttle ${e.controls.throttle.toFixed(1)} · heading ${e.angles[0]} · yaw ${e.controls.yaw.toFixed(1)}`}
      </p>
      <p aria-label="Effects">
        {`beams ${b.ships.reduce((n, s) => n + s.activeBeams, 0)} · torpedoes ${b.torpedoes.filter(t => t.active).length} · debris ${b.debris.length} · rolls ${b.random.draws}${(redFlash ?? b.console.redFlash) ? ' · red flash' : ''}`}
      </p>
      <p aria-label="Console">
        {`banks ${e.banks.map(bank => bank.setting).join(',')} · salvo ${b.console.salvo[0].setting}/${b.console.salvo[1].setting} · view 0x${b.view.view.toString(16)} of ${b.view.viewShip ?? 'none'} · zoom ${b.view.zoomLevel} · held 0x${b.input.held.toString(16)} · wide ${b.view.wide ? 'on' : 'off'}`}
      </p>
      <p aria-label="Tactics">{consoleLine(b)}</p>
      <canvas ref={canvas} width={SIZE} height={SIZE} style={{ width: `${SIZE}px`, height: `${SIZE}px`, background: '#000' }} aria-label="Battle from above" />
      <div class="au-group" style={WRAP}>
        {HOLDS.map(([label, axis, dir]) => (
          <button key={label} {...holdable(() => hold(axis, dir), () => { if (held.current[axis] === dir) hold(axis, 0); })}>{label}</button>
        ))}
      </div>
      <div class="au-group" style={WRAP}>
        {BUTTONS.map(([label, cmd]) => <button key={label} onClick={() => send(cmd)}>{label}</button>)}
        <button aria-pressed={b.console.shieldsRaised} onClick={() => send({ type: 'shields', on: !b.console.shieldsRaised })}>Shields</button>
        <button aria-pressed={b.console.weaponsLock} onClick={() => send({ type: 'weaponsLock', on: !b.console.weaponsLock })}>Lock</button>
        <button aria-pressed={b.console.delegate} onClick={() => send({ type: 'delegate', on: !b.console.delegate })}>Delegate</button>
        {[0, 1, 2, 3, 4].map(level => <button key={level} aria-pressed={b.console.powerLevel === level} onClick={() => send({ type: 'powerLevel', level })}>{`Power ${level}`}</button>)}
      </div>
      <div class="au-group" style={WRAP}>
        {e.banks.length === 0 && <span>no phaser banks</span>}
        {e.banks.map((bank, i) => (
          <label key={i}>
            {`Bank ${i} `}
            <input type="range" min={0} max={100} aria-label={`Bank ${i}`} value={bank.setting} onInput={ev => send({ type: 'bank', bank: i, setting: Number((ev.currentTarget as HTMLInputElement).value) })} />
          </label>
        ))}
        {BANK_BUTTONS.map(([label, cmd]) => <button key={label} onClick={() => send(cmd)}>{label}</button>)}
      </div>
      <div class="au-group" style={WRAP}>
        {SALVOES.map(([label, tube]) => (
          <label key={label}>
            {`${label} `}
            <input type="range" min={0} max={10} aria-label={label} value={b.console.salvo[tube].setting} onInput={ev => send({ type: 'salvo', tube, setting: Number((ev.currentTarget as HTMLInputElement).value) })} />
          </label>
        ))}
        {Array.from({ length: 10 }, (_, cell) => <button key={cell} onClick={() => send({ type: 'spread', cell })}>{`Spread ${cell}`}</button>)}
      </div>
      <ol aria-label="Maneuvers" start={0}>
        {maneuverRows(b).map((row, i) => <li key={i} aria-current={row.selected ? 'true' : undefined}>{row.label}</li>)}
      </ol>
      <div class="au-group" style={WRAP}>
        {Array.from({ length: MANEUVER_ROWS }, (_, row) => <button key={row} onClick={() => send({ type: 'maneuver', row })}>{`Maneuver ${row}`}</button>)}
        {TACTICS_BUTTONS.map(([label, cmd]) => (
          <button key={label} {...(cmd.type === 'engage' ? { 'aria-pressed': b.console.engageButton } : {})} onClick={() => send(cmd)}>{label}</button>
        ))}
      </div>
      <div class="au-group" style={WRAP}>
        {VIEWS.map(([view, whose], i) => <button key={i} onClick={() => send({ type: 'view', view, ship: whose })}>{`View ${i + 1}`}</button>)}
        {CAMERA_BUTTONS.map(([label, cmd]) => <button key={label} onClick={() => send(cmd)}>{label}</button>)}
        {ORBITS.map(([label, dir]) => (
          <button key={label} {...holdable(() => orbit(dir), () => { if (orbiting.current === dir) orbit(0); })}>{label}</button>
        ))}
        <button aria-pressed={b.view.wide} onClick={() => send({ type: 'wide', on: !b.view.wide })}>Wide</button>
      </div>
      <table aria-label="Ships">
        <tbody>
          {b.ships.map(s => (
            <tr key={s.index}>
              <td>{s.index}</td><td>{s.object}</td><td>{combat.kinds[s.type]?.name}</td><td>{`${s.condition}%`}</td>
              <td>{s.index === 0 ? '' : Math.round(distance(e, s))}</td>
              <td>{s.destroyed ? 'destroyed' : s.decloakTime ? 'cloaked' : ''}</td>
              <td><button onClick={() => send({ type: 'target', ship: s.index })}>Target</button></td>
              <td><button aria-label={`Log of ship ${s.index}`} aria-pressed={s.index === shown} onClick={() => setShown(s.index)}>Log</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <ol aria-label="Scripts" start={0}>{b.ships.map(s => <li key={s.index}>{shipLine(b, s)}</li>)}</ol>
      <ol aria-label="Ship log">{(logShip?.log ?? []).map((line, i) => <li key={i}>{line}</li>)}</ol>
      {warnings.length > 0 && <ul aria-label="Warnings">{warnings.map(w => <li key={w}>{w}</li>)}</ul>}
    </>
  );
}

/** A hold-down button's handlers: pressed by the pointer or by Space or Enter (not their repeats); let go on release, leaving, cancel or blur. */
function holdable(press: () => void, release: () => void) {
  const key = (ev: KeyboardEvent) => ev.key === ' ' || ev.key === 'Enter';
  return {
    onPointerDown: press, onPointerUp: release, onPointerLeave: release, onPointerCancel: release, onBlur: release,
    onKeyDown: (ev: KeyboardEvent) => {
      if (!key(ev)) return;
      ev.preventDefault();
      if (!ev.repeat) press();
    },
    onKeyUp: (ev: KeyboardEvent) => {
      if (!key(ev)) return;
      ev.preventDefault();
      release();
    },
  };
}

/** Draws the scene; with no 2D context (a test's DOM), nothing. */
function paint(el: HTMLCanvasElement | null, scene: CombatScene): void {
  const g = el?.getContext('2d');
  if (!g) return;
  g.fillStyle = '#000';
  g.fillRect(0, 0, SIZE, SIZE);
  if (scene.range) {
    g.strokeStyle = '#334';
    g.beginPath();
    g.arc(scene.range.x, scene.range.y, scene.range.r, 0, Math.PI * 2);
    g.stroke();
  }
  for (const beam of scene.beams) {
    g.strokeStyle = beam.miss ? '#996' : '#ff6';
    g.beginPath();
    g.moveTo(beam.from.x, beam.from.y);
    g.lineTo(beam.to.x, beam.to.y);
    g.stroke();
  }
  for (const t of scene.torpedoes) {
    g.fillStyle = t.enterprise ? '#fc6' : '#f96';
    g.fillRect(t.x - 1.5, t.y - 1.5, 3, 3);
  }
  for (const d of scene.debris) {
    g.globalAlpha = d.alpha;
    g.fillStyle = '#999';
    g.fillRect(d.x - 1, d.y - 1, 2, 2);
  }
  g.globalAlpha = 1;
  g.strokeStyle = '#6ff';
  for (const s of scene.shields) {
    g.beginPath();
    g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#6ff';
    g.fillRect(s.impact.x - 2, s.impact.y - 2, 4, 4);
  }
  g.strokeStyle = '#f93';
  for (const x of scene.explosions) {
    g.beginPath();
    g.arc(x.x, x.y, x.r, 0, Math.PI * 2);
    g.stroke();
  }
  g.font = '10px monospace';
  for (const s of scene.ships) {
    g.globalAlpha = s.cloaked ? 0.35 : 1;
    g.strokeStyle = g.fillStyle = s.colour;
    g.beginPath();
    g.arc(s.x, s.y, 5, 0, Math.PI * 2);
    if (s.destroyed) g.stroke();
    else g.fill();
    g.beginPath();
    g.moveTo(s.x, s.y);
    g.lineTo(s.x + s.hx * 14, s.y + s.hy * 14);
    g.stroke();
    if (s.target) g.strokeRect(s.x - 8, s.y - 8, 16, 16);
    g.fillText(s.label, s.x + 8, s.y - 8);
    g.globalAlpha = 1;
  }
}
