// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { gameModules } from './gamePlugin';
import { markdown } from './mdPlugin';
import { serviceWorker } from './swPlugin';
import { inSealedDir } from './src/swRules';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const app = fileURLToPath(new URL('.', import.meta.url));
/** Every index.html under the app (not node_modules, dist or public): the site's pages and the game's. */
function pages(dir = app, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', 'dist-deploy', 'public', 'e2e', 'e2e-deploy', 'test-results', 'src', 'scripts', 'deploy'].includes(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, out);
    else if (name === 'index.html') out[relative(app, dir) || 'home'] = path;
  }
  return out;
}

/** Writes each script and style file's size into index.html, for the loading screen to weigh its downloads by (loading.ts). */
function bundleSizes(): Plugin {
  return {
    name: 'au-bundle-sizes',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        const sizes: Record<string, number> = {};
        for (const file of Object.values(ctx.bundle)) {
          if (!/\.(m?js|css)$/.test(file.fileName)) continue;
          sizes[file.fileName] = Buffer.byteLength(file.type === 'chunk' ? file.code : String(file.source));
        }
        return [{ tag: 'script', attrs: { id: 'au-bundle', type: 'application/json' }, children: JSON.stringify(sizes), injectTo: 'head' }];
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [markdown(), preact(), bundleSizes(), serviceWorker(), gameModules(loadEnv(mode, app, 'VITE_').VITE_AU_DEPLOY === '1')],
  // (one copy of each, whether the engine or the app imports it)
  resolve: { dedupe: ['three', 'preact'] },
  // (the games' content and media live outside this app)
  server: { port: 5173, fs: { allow: [repo] } },
  build: {
    target: 'es2022',
    // (a deploy ships no source maps: scripts/deploy/check.ts fails if one is in the output)
    sourcemap: false,
    // (a sealed file is always a file of its own, however small: inlined as a data: URL it would never pass through the worker that opens it.
    // Anything else keeps Vite's 4 KB default)
    assetsInlineLimit: (filePath: string) => (inSealedDir(filePath) ? false : undefined),
    // (the libraries in chunks of their own: they change less often than the game)
    rollupOptions: { input: pages(), output: { manualChunks: { three: ['three'], preact: ['preact'] } } },
    // (three on its own is about 540 kB minified, and can't be split further: the limit is set just above it.
    // A local build with games/unity lifted warns about its unity chunk, which is expected: docs/web.md)
    chunkSizeWarningLimit: 600,
  },
}));
