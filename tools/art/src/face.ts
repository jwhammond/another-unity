// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Likeness scores (tools/art/face/score.py): InsightFace embeddings of each picture's face against held-out reference frames of the
 * person, and the margin over the nearest other person. The Python runs in its own venv (FACE_PY, default
 * <cache>/venv-face/bin/python); without it, scoring is skipped. InsightFace's weights are non-commercial: allowed for this
 * personal project (art/models.yaml).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FaceScore {
  /** Mean cosine similarity to the held-out frames. */
  sim: number;
  /** sim minus the highest mean similarity to another person. */
  margin: number;
  nearestOther: string | null;
}

export interface ScoreRequest {
  target: string[];
  others: Record<string, string[]>;
  /** A path, or [path, guide]: embedded at the face found in `guide` (the picture before pixelation). Results are keyed by path. */
  images: (string | [string, string])[];
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'face', 'score.py');

export function facePython(cacheRoot: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const py = env.FACE_PY ?? join(cacheRoot, 'venv-face', 'bin', 'python');
  return existsSync(py) ? py : undefined;
}

/** Scores per image path (null: no face found); throws when the script fails. */
export function scoreFaces(python: string, req: ScoreRequest, run: typeof spawnSync = spawnSync): Record<string, FaceScore | null> {
  // -I: the script's own directory and the environment do not reach the interpreter's import path
  const r = run(python, ['-I', SCRIPT], { input: JSON.stringify(req), encoding: 'utf8', maxBuffer: 16 << 20, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (r.status !== 0) throw new Error(`face/score.py exited ${r.status}: ${String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
  return (JSON.parse(String(r.stdout)) as { images: Record<string, FaceScore | null> }).images;
}

/** A score as a short label: "0.62 +0.48". */
export function scoreLabel(s: FaceScore | null | undefined): string {
  if (s === undefined) return '';
  if (s === null) return 'no face';
  return `${s.sim.toFixed(2)} ${s.margin >= 0 ? '+' : ''}${s.margin.toFixed(2)}`;
}

export type FaceBox = [number, number, number, number];

/** Each picture's largest face box [x0, y0, x1, y1] in its own pixels (null: no face); throws when the script fails. */
export function faceBoxes(python: string, paths: string[], run: typeof spawnSync = spawnSync): Record<string, FaceBox | null> {
  const r = run(python, ['-I', SCRIPT], { input: JSON.stringify({ boxes: paths }), encoding: 'utf8', maxBuffer: 16 << 20, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (r.status !== 0) throw new Error(`face/score.py exited ${r.status}: ${String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`);
  return (JSON.parse(String(r.stdout)) as { boxes: Record<string, FaceBox | null> }).boxes;
}
