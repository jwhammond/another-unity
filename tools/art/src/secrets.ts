// SPDX-License-Identifier: GPL-3.0-or-later
import { stat as fsStat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export interface JellyfinConfig {
  url: string;
  key: string;
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** RFC 1918 or loopback host. */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  if ([a, b, c, d].some(n => n > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * Whether an IP address is on the user's own network: loopback (127/8, ::1), RFC 1918 (10/8, 172.16/12, 192.168/16) or
 * link-local (169.254/16, fe80::/10), also as an IPv4-mapped IPv6 address. A host name is not an address: resolve it first.
 */
export function isLanAddress(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) return isLanAddress(mapped[1]!);
  if (h === '::1') return true;
  if (/^fe[89ab][0-9a-f]?:/.test(h)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([m[1], m[2], m[3], m[4]].some(n => Number(n) > 255)) return false;
  return (a === 169 && b === 254) || (h !== 'localhost' && isPrivateHost(h));
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Reads the Jellyfin URL and key from `$JELLYFIN_ENV`, else `$ART_CACHE/jellyfin.env`. Refuses a file that is group- or
 * world-accessible, a file inside the repo, a URL that is not private or loopback, and missing variables. No message
 * carries the file's contents.
 */
export async function loadJellyfin(
  env: NodeJS.ProcessEnv = process.env,
  opts: { repoRoot?: string; stat?: typeof fsStat } = {},
): Promise<JellyfinConfig> {
  const path = resolve(env.JELLYFIN_ENV || join(env.ART_CACHE || join(homedir(), 'pcode', 'unity-art-cache'), 'jellyfin.env'));
  const root = resolve(opts.repoRoot ?? REPO);
  if (path === root || path.startsWith(root + sep)) throw new Error(`${path} is inside the repo: keep the Jellyfin key file outside it`);
  let mode: number;
  try {
    mode = (await (opts.stat ?? fsStat)(path)).mode;
  } catch {
    throw new Error(`no Jellyfin env file at ${path} (set JELLYFIN_ENV, or put JELLYFIN_URL and JELLYFIN_KEY there, mode 600)`);
  }
  if (mode & 0o077) throw new Error(`${path} has mode ${(mode & 0o777).toString(8)}: it must not be group- or world-accessible (chmod 600)`);
  const vars = parseEnv(await readFile(path, 'utf8'));
  const missing = ['JELLYFIN_URL', 'JELLYFIN_KEY'].filter(k => !vars[k]);
  if (missing.length) throw new Error(`${path} lacks ${missing.join(' and ')}`);
  let u: URL;
  try {
    u = new URL(vars.JELLYFIN_URL!);
  } catch {
    throw new Error(`JELLYFIN_URL in ${path} is not a URL`);
  }
  if (!/^https?:$/.test(u.protocol) || !isPrivateHost(u.hostname)) throw new Error(`JELLYFIN_URL host ${u.hostname} is not a private (RFC 1918) or loopback address`);
  return { url: vars.JELLYFIN_URL!.replace(/\/+$/, ''), key: vars.JELLYFIN_KEY! };
}

/** Replaces every occurrence of each secret with "[redacted]". */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}
