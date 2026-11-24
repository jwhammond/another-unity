// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { artCache } from './cache';
import { decodePng } from './image';
import { Jellyfin } from './jellyfin';
import { ffmpegGrabber, manifestSchema } from './refs';
import { loadJellyfin } from './secrets';
import { curlLanFetch } from './lanFetch';

const envFile = process.env.JELLYFIN_ENV || join(process.env.ART_CACHE || join(homedir(), 'pcode', 'unity-art-cache'), 'jellyfin.env');
const ready = !!process.env.ART_CACHE && existsSync(envFile);
if (!ready) console.info(`live-refs skipped: needs ART_CACHE and a Jellyfin env file (${process.env.ART_CACHE ? envFile : 'ART_CACHE is not set'})`);

describe.skipIf(!ready)('live: Jellyfin references', () => {
  it('lists the series and grabs a frame at 60 s of S6E1, with the key nowhere in argv, logs or cache files', async () => {
    const cfg = await loadJellyfin();
    const logs: string[] = [];
    const j = new Jellyfin(cfg, { log: l => logs.push(l), fetchFn: curlLanFetch() });
    const manifest = manifestSchema.parse(parseYaml(readFileSync(join(__dirname, '..', '..', '..', 'art', 'refs', 'show.yaml'), 'utf8')));
    const eps = await j.episodes(manifest.series);
    expect(eps.length).toBe(176);
    const ep = eps.find(e => e.season === 6 && e.episode === 1)!;
    expect(ep).toBeTruthy();

    const root = artCache().root;
    mkdirSync(join(root, 'refs'), { recursive: true });
    const out = mkdtempSync(join(root, 'refs', 'live-test-'));
    const files = await ffmpegGrabber.grab(await j.stream(ep.item), [60_000], out);
    const img = decodePng(new Uint8Array(readFileSync(files[0]!)));
    // S6E1 decodes at 1436x1080 (the files are not all exactly 1440 wide): crop boxes are in the decoded frame's pixels
    expect(img.height).toBe(1080);
    expect(img.width).toBeGreaterThanOrEqual(1400);

    // the real key is searched for here, never printed
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(out)) if (statSync(f).size < 50e6) expect(readFileSync(f).includes(cfg.key), f).toBe(false);
    expect(logs.join('\n').includes(cfg.key)).toBe(false);
    const ps = await import('node:child_process').then(c => c.execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8' }));
    expect(ps.includes(cfg.key)).toBe(false);
    rmSync(out, { recursive: true, force: true });
  }, 120_000);
});
