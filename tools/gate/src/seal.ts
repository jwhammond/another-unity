// SPDX-License-Identifier: GPL-3.0-or-later
// `gate:seal`: encrypt the game's data for the deploy build. One file at a time, so ~400 MB of media never sits in memory at once.
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CHECK_PLAINTEXT, deriveGateKey, deriveIvKey, seal } from '../../../apps/web/src/gate/crypto';
import { rangeDigests, type CdSource } from '../../../apps/web/src/gate/disc';
import { gateParamsJson, type GateParams } from '../../../apps/web/src/gate/params';

const MEDIA_DIRS = ['art', 'audio', 'models', 'movies', 'space'];
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function listFiles(root: string, rel = ''): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(root, rel), { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

async function mtime(path: string): Promise<number | undefined> {
  try { return (await stat(path)).mtimeMs; } catch { return undefined; }
}

async function readOrUndefined(path: string): Promise<Uint8Array | undefined> {
  try { return await readFile(path); } catch { return undefined; }
}

export async function sealGame(o: { gameDir: string; outDir: string; params: GateParams; cd: CdSource; log?: (s: string) => void }): Promise<{ sealed: number; skipped: number }> {
  const { gameDir, outDir, params, cd } = o;
  const log = o.log ?? (() => {});
  const digests = await rangeDigests(cd, params);
  const key = await deriveGateKey(digests, params.salt);
  const ivKey = await deriveIvKey(digests, params.salt);
  let sealed = 0;
  let skipped = 0;
  const wanted = new Set<string>();

  // A different gate.json (new salt or ranges) means every old output is stale, whatever its date.
  const gateJson = gateParamsJson(params);
  const old = await readOrUndefined(join(outDir, 'gate.json'));
  const sameGate = old !== undefined && Buffer.from(old).toString('utf8') === gateJson;

  const put = async (rel: string, bytes: Uint8Array): Promise<void> => {
    const out = join(outDir, rel);
    const have = await readOrUndefined(out);
    if (have && Buffer.compare(Buffer.from(have), Buffer.from(bytes)) === 0) { skipped++; return; }
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, bytes);
    sealed++;
  };

  for (const dir of MEDIA_DIRS) {
    for (const rel of await listFiles(gameDir, dir)) {
      // (the transcoder's *.cmd notes beside the audio name local paths and aren't the game's: never sealed, and an old one is removed below)
      if (rel.endsWith('.cmd')) continue;
      wanted.add(rel);
      const input = join(gameDir, rel);
      const out = join(outDir, rel);
      const outTime = await mtime(out);
      if (sameGate && outTime !== undefined && outTime > (await stat(input)).mtimeMs) { skipped++; continue; }
      const bytes = await seal(key, ivKey, rel, new Uint8Array(await readFile(input)));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, bytes);
      sealed++;
      log(`sealed ${rel}`);
    }
  }

  // The text: every yaml but overrides and the combat tables (combat.yaml is its own pack, opened only when a fight starts).
  const content: Record<string, string> = {};
  for (const rel of await listFiles(gameDir)) {
    if (!rel.endsWith('.yaml') || rel.startsWith('overrides/') || rel === 'combat.yaml' || rel === 'gate.yaml') continue;
    if (rel.split('/').some(s => s.startsWith('.'))) continue;
    content[rel] = await readFile(join(gameDir, rel), 'utf8');
  }
  const combat = await readOrUndefined(join(gameDir, 'combat.yaml'));
  wanted.add('content.pack');
  await put('content.pack', await seal(key, ivKey, 'content.pack', utf8(JSON.stringify(content))));
  if (combat) {
    wanted.add('combat.pack');
    await put('combat.pack', await seal(key, ivKey, 'combat.pack', combat));
  }
  wanted.add('check.bin');
  await put('check.bin', await seal(key, ivKey, 'check.bin', utf8(CHECK_PLAINTEXT)));
  wanted.add('gate.json');
  await put('gate.json', utf8(gateJson));

  for (const rel of await listFiles(outDir)) {
    if (!wanted.has(rel)) await rm(join(outDir, rel));
  }
  return { sealed, skipped };
}
