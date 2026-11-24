// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The screenshot check's views (M8 spec §9.3): which views a battle is shot in, the harness lines that set and shoot
 * them, and the shots a run took, read back from its log.
 */

/** A view to shoot: set by the `view` input at step `at` (Plan 22's grammar), shot SHOT_DELAY steps later. */
export interface ShotView { name: string; view: number; ship: 'enterprise' | 'target'; at: number }

/**
 * The six views of the spec (chase, side, top, overview, target, forward: Combat::kView*, combat.h:284-303), ten steps
 * apart from step 60: a battle's start can hold the harness's inputs back (its Enter object's conversation, clicked
 * through while the battle steps on: docs/trace-format.md), and the fighting's effects come later.
 */
export const SHOT_VIEWS: readonly ShotView[] = [
  { name: 'chase', view: 0, ship: 'enterprise', at: 60 },
  { name: 'side', view: 1, ship: 'enterprise', at: 70 },
  { name: 'top', view: 3, ship: 'enterprise', at: 80 },
  { name: 'overview', view: 7, ship: 'enterprise', at: 90 },
  { name: 'target', view: 0xc, ship: 'enterprise', at: 100 },
  { name: 'forward', view: 0x12, ship: 'enterprise', at: 110 },
];
/**
 * Steps from a view's input to its shot: the input lands before a step, the step places the camera, the next frame
 * draws it, and the shot at the frame after shows that drawing (harness.inc `shot`: the hook comes before drawScene).
 */
export const SHOT_DELAY = 3;
/** The cap the shooting run fights to (harness.inc `fight <cap>`): past the last shot. */
export const SHOT_CAP = 130;

/** The views' inputs, as an inputs file (`at <step> view <view> <ship>`) for `tracediff combat-script --inputs`. */
export function viewInputs(views: readonly ShotView[] = SHOT_VIEWS): string {
  return views.map(v => `at ${v.at} view ${v.view} ${v.ship}`).join('\n') + '\n';
}

/**
 * A harness script with the shots added (`at <at + SHOT_DELAY> shot @DIR@/scummvm-<name>.png`), its at-lines in step
 * order before its `fight`: the harness takes them in the order written, each once its step has come (harness.inc), so a
 * line written after a later one waits for it.
 */
export function addShots(script: string, views: readonly ShotView[] = SHOT_VIEWS): string {
  const lines = script.split('\n');
  const fight = lines.findIndex(l => l.startsWith('fight '));
  if (fight < 0) throw new Error('the script has no fight line');
  const step = (l: string) => Number(/^at (\d+) /.exec(l)?.[1] ?? NaN);
  const ats = [...lines.slice(0, fight).filter(l => l.startsWith('at ')), ...views.map(v => `at ${v.at + SHOT_DELAY} shot @DIR@/scummvm-${v.name}.png`)];
  // (stable: two lines at one step keep their order, an input before a shot)
  ats.sort((a, b) => step(a) - step(b));
  const head = lines.slice(0, fight).filter(l => !l.startsWith('at '));
  return [...head, ...ats, ...lines.slice(fight)].join('\n');
}

/** A shot the run took: its view's name, its file, and the step the battle had taken when it was shot. */
export interface Shot { name: string; file: string; step: number }

/** The shots a run's log says it took (harness.inc: `HARNESS shot <file> at step <n>`), in order. */
export function readShots(log: string): Shot[] {
  const out: Shot[] = [];
  for (const m of log.matchAll(/HARNESS shot (\S+\/scummvm-([\w-]+)\.png) at step (\d+)/g)) out.push({ name: m[2]!, file: m[1]!, step: Number(m[3]) });
  return out;
}

/** The step whose state a shot shows: the frame drawn after the step before the one it was taken at (unity.cpp:1834-1836). */
export const shownStep = (shot: Shot): number => shot.step - 1;
