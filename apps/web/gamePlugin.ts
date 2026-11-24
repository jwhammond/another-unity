// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const NO_GAME = '\0au-no-game';
const SEALED_DIR = fileURLToPath(new URL('../../games/unity/.sealed', import.meta.url));

/**
 * The unity modules games/index.ts imports that a build replaces with an empty one. A plain build never takes the sealed module; a
 * deploy build never takes the plain one, nor the sealed one when `gate:seal` hasn't written games/unity/.sealed (a demo-only deploy):
 * its imports of the sealed files would not resolve.
 */
export function gameModuleStubs(deploy: boolean, sealedPresent: boolean): string[] {
  if (!deploy) return ['./unitySealed'];
  return sealedPresent ? ['./unity'] : ['./unity', './unitySealed'];
}

/**
 * Keeps the unity module a build doesn't take out of it altogether. games/index.ts's choice is a constant, but Rollup still loads a
 * module behind a dead `import()`, and Vite emits that module's `?url` media as it loads it: without this, a deploy build would carry
 * the plain games/unity media beside the sealed copies. It also tells games/index.ts whether the sealed game is in the build
 * (import.meta.env.VITE_AU_SEALED). `sealedDir` is where the sealed files are looked for (AU_SEALED_DIR overrides it, for a test build).
 */
export function gameModules(deploy: boolean, sealedDir = process.env.AU_SEALED_DIR || SEALED_DIR): Plugin {
  const sealed = deploy && existsSync(`${sealedDir}/gate.json`);
  const stubs = gameModuleStubs(deploy, sealed);
  return {
    name: 'au-game-modules',
    enforce: 'pre',
    config() {
      return { define: { 'import.meta.env.VITE_AU_SEALED': JSON.stringify(sealed ? '1' : '') } };
    },
    resolveId(source, importer) {
      if (stubs.includes(source) && importer?.replace(/\\/g, '/').endsWith('/src/games/index.ts')) return NO_GAME;
      return null;
    },
    load(id) {
      return id === NO_GAME ? 'export {};' : null;
    },
  };
}
