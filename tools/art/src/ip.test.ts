// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { manifestSchema } from './refs';

const REPO = join(__dirname, '..', '..', '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean);
const BINARY = /\.(png|jpe?g|webp|gif|bmp|tga|tiff?|glb|gltf|blend|exr|hdr|ktx2?|safetensors|pth|ckpt|onnx|bin)$/i;
/** Synthetic fixtures drawn or built by tests, and checked in on purpose. Add a path here only if it holds nothing from the game. */
const ALLOWED = new Set<string>([]);
/** The guards themselves, run on the tracked files and on made-up lists alike. */
const binaries = (files: string[]): string[] => files.filter(f => BINARY.test(f) && !ALLOWED.has(f));
const strayRefs = (files: string[]): string[] => files.filter(f => f.startsWith('art/refs/') && !/^art\/refs\/[a-z0-9-]+\.yaml$/.test(f));
const underGameArt = (files: string[]): string[] => files.filter(f => f.startsWith('games/unity/art/'));

describe('art IP rules (spec Decision 9)', () => {
  it('git tracks no image, .glb, .exr or .safetensors outside the allowlisted synthetic fixtures', () => {
    expect(binaries(tracked)).toEqual([]);
  });

  it('git tracks nothing under art/refs/ but top-level manifests (no show frames, crops or sheets)', () => {
    expect(strayRefs(tracked)).toEqual([]);
  });

  it('every art/refs/*.yaml is a schema-valid manifest (ids, numbers, boxes, tags, hashes only)', () => {
    for (const f of tracked.filter(f => /^art\/refs\/[^/]+\.yaml$/.test(f))) {
      expect(() => manifestSchema.parse(parseYaml(readFileSync(join(REPO, f), 'utf8'))), f).not.toThrow();
    }
    expect(() => manifestSchema.parse(parseYaml('title: not a manifest\nnotes: [a]'))).toThrow();
  });

  it('the guards catch a .webp, a stray file under art/refs/ and a file under games/unity/art/', () => {
    expect(binaries(['x/plate.webp', 'x/room.glb', 'src/a.ts'])).toEqual(['x/plate.webp', 'x/room.glb']);
    expect(strayRefs(['art/refs/crops/a.png', 'art/refs/notes.txt', 'art/refs/show.yaml', 'art/recipes/a.yaml'])).toEqual(['art/refs/crops/a.png', 'art/refs/notes.txt']);
    expect(underGameArt(['games/unity/art/rooms/lab/s01/plate.webp', 'games/unity/game.yaml'])).toEqual(['games/unity/art/rooms/lab/s01/plate.webp']);
  });

  it('git tracks nothing under games/unity/art/', () => {
    expect(underGameArt(tracked)).toEqual([]);
  });

  it('git tracks nothing from the cache', () => {
    expect(tracked.filter(f => /unity-art-cache|(^|\/)comfy-io\//.test(f))).toEqual([]);
  });

  it.skipIf(!existsSync(join(homedir(), 'pcode', 'unity-art-cache', 'jellyfin.env')))('git tracks no file holding the Jellyfin key', () => {
    // the value is read here, at run time, only to search the tracked tree: it is never printed or asserted on
    const env = readFileSync(join(homedir(), 'pcode', 'unity-art-cache', 'jellyfin.env'), 'utf8');
    const secrets = [...env.matchAll(/^\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*\s*=\s*['"]?([^'"\s#]+)/gm)].map(m => m[1]!).filter(v => v.length >= 16);
    expect(secrets.length).toBeGreaterThan(0);
    const leaks = tracked.filter(f => {
      let text: string;
      try {
        text = readFileSync(join(REPO, f), 'latin1');
      } catch {
        return false;
      }
      return secrets.some(k => text.includes(k));
    });
    expect(leaks, 'tracked files that contain the Jellyfin key').toEqual([]);
  });

  it('git tracks no .env file but the pinned-sources one', () => {
    expect(tracked.filter(f => /(^|\/)[^/]*\.env$/.test(f) && f !== 'tools/art/setup/pins.env')).toEqual([]);
  });

  it('.gitignore keeps *.env out except pins.env', () => {
    const ignored = (f: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', f], { cwd: REPO });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('jellyfin.env')).toBe(true);
    expect(ignored('tools/art/setup/pins.env')).toBe(false);
  });
});
