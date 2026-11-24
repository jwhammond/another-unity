// SPDX-License-Identifier: GPL-3.0-or-later
// The gate's parameters: which byte ranges of the CD feed the key, and the salt. YAML or JSON in, JSON out.
import { parse as parseYaml } from 'yaml';

export interface GateRange { path: string; offset: number; length: number }
export interface GateParams { version: 1; salt: Uint8Array; ranges: GateRange[] }

const MIN_OFFSET = 5000;
const MIN_LENGTH = 65536;
const MAX_LENGTH = 1048576;
const MIN_RANGES = 3;
const MAX_RANGES = 6;
const SALT_BYTES = 32;

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function toBase64(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin);
}

/** Parses and checks the parameters; the messages name the rule, never a value. */
export function parseGateParams(text: string): GateParams {
  // (JSON is YAML, so one parser reads both)
  const raw = parseYaml(text) as { version?: unknown; salt?: unknown; ranges?: unknown } | null;
  if (!raw || typeof raw !== 'object') throw new Error('gate params: expected a mapping');
  if (raw.version !== 1) throw new Error('gate params: version must be 1');
  if (typeof raw.salt !== 'string') throw new Error('gate params: salt must be a base64 string');
  let salt: Uint8Array;
  try { salt = fromBase64(raw.salt); } catch { throw new Error('gate params: salt is not valid base64'); }
  if (salt.length !== SALT_BYTES) throw new Error(`gate params: salt must be ${SALT_BYTES} bytes`);
  if (!Array.isArray(raw.ranges)) throw new Error('gate params: ranges must be a list');
  if (raw.ranges.length < MIN_RANGES || raw.ranges.length > MAX_RANGES) {
    throw new Error(`gate params: there must be ${MIN_RANGES} to ${MAX_RANGES} ranges`);
  }
  const ranges = raw.ranges.map((r: { path?: unknown; offset?: unknown; length?: unknown }): GateRange => {
    if (!r || typeof r.path !== 'string' || !Number.isInteger(r.offset) || !Number.isInteger(r.length)) {
      throw new Error('gate params: a range needs a path, an integer offset and an integer length');
    }
    const offset = r.offset as number;
    const length = r.length as number;
    if (offset < MIN_OFFSET) throw new Error(`gate params: a range may not start under offset ${MIN_OFFSET}`);
    if (length < MIN_LENGTH || length > MAX_LENGTH) throw new Error(`gate params: a range length must be ${MIN_LENGTH} to ${MAX_LENGTH}`);
    return { path: r.path, offset, length };
  });
  return { version: 1, salt, ranges };
}

export function gateParamsJson(p: GateParams): string {
  return JSON.stringify({ version: p.version, salt: toBase64(p.salt), ranges: p.ranges }, null, 2) + '\n';
}
