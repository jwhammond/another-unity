// SPDX-License-Identifier: GPL-3.0-or-later
// The scan's inputs: the gate's parameters (games/unity/gate.yaml), the lifted strings (the game's yaml) and the allow-list. The history
// scan takes what it finds and says what it skipped; a tree to publish (`scan --tree`, `snapshot`) fails closed: with no gate parameters
// or no lifted text its rules would pass anything, so a missing input is an error rather than a clean scan.
import { readFileSync } from 'node:fs';
import { parseGateParams, type GateParams } from '../../../apps/web/src/gate/params';
import { sampleLiftedText } from './textSample';

export interface AllowEntry {
  /** Set for a history hit (scanRepo); a tree hit (scanTree) is matched on the line hash, and the path when given. */
  commit?: string;
  path?: string;
  lineHash?: string;
  /** A reviewed binary, media or oversized file of the tree (with `path`): its git blob id. */
  blob?: string;
  why?: string;
}

export interface ScanInputs {
  gate?: GateParams;
  text: string[];
  allow: AllowEntry[];
}

export type Sample = { count?: number; minLength?: number; skipKeys?: string[] };

/** What reading the inputs needs from the machine; the tests stand in for each. */
export interface InputDeps {
  readFile(path: string): string;
  sample(gameDir: string, o: Sample): string[];
  log(message: string): void;
}

const realDeps: InputDeps = {
  readFile: path => readFileSync(path, 'utf8'),
  sample: (dir, o) => sampleLiftedText(dir, o),
  log: m => console.log(m),
};

/** The reason text of an error, never its whole message when that could quote a file. */
const why = (err: unknown): string => (err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : 'unreadable');

/**
 * Reads the inputs. `strict` (a tree to publish) throws when gate.yaml is missing or unreadable, when the sampler throws, or when the
 * lifted text yields no string; otherwise each such rule is skipped with a line saying so.
 */
export function readScanInputs(o: { gameDir: string; allowPath: string; sample: Sample; strict: boolean }, deps: InputDeps = realDeps): ScanInputs {
  let gate: GateParams | undefined;
  try {
    gate = parseGateParams(deps.readFile(`${o.gameDir}/gate.yaml`));
  } catch (err) {
    if (o.strict) {
      throw new Error(`no usable ${o.gameDir}/gate.yaml (${why(err)}): the gate rule can't run, so the tree is not scanned. `
        + 'Run this on the machine that holds the gate (docs/publish.md)');
    }
    deps.log('scan: no usable gate.yaml; the gate rule is skipped');
  }
  let text: string[] = [];
  try {
    text = deps.sample(o.gameDir, o.sample);
  } catch (err) {
    if (o.strict) throw new Error(`reading the lifted text under ${o.gameDir} failed (${why(err)}): the lifted-text rule can't run`);
  }
  if (text.length === 0) {
    if (o.strict) {
      throw new Error(`no lifted text found under ${o.gameDir}: the lifted-text rule can't run, so the tree is not scanned. `
        + 'Lift the game first (docs/unity-local.md)');
    }
    deps.log('scan: no lifted text found; the lifted-text rule is skipped');
  }
  let allow: AllowEntry[] = [];
  try {
    allow = JSON.parse(deps.readFile(o.allowPath)) as AllowEntry[];
  } catch {
    // (no allow-list: every hit stands)
  }
  return { gate, text, allow };
}
