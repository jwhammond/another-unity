// SPDX-License-Identifier: GPL-3.0-or-later
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { buildManifest, MANIFEST_PATH, SHELL_ROOT, withVersionMeta } from './src/swRules';

const appDir = fileURLToPath(new URL('.', import.meta.url));
const entry = fileURLToPath(new URL('./src/sw.ts', import.meta.url));

/** Bundles src/sw.ts into one classic script, with the build id (and whether it is the dev variant) baked in. */
async function bundleWorker(version: string, dev: boolean, outDir?: string): Promise<string> {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    define: { __AU_VERSION__: JSON.stringify(version), __AU_DEV__: JSON.stringify(dev) },
    build: {
      write: false,
      outDir: outDir ?? 'dist',
      emptyOutDir: false,
      target: 'es2022',
      minify: !dev,
      lib: { entry, formats: ['iife'], name: 'auSw', fileName: () => 'sw.js' },
    },
  });
  const outputs = (Array.isArray(out) ? out : [out]).flatMap(o => ('output' in o ? o.output : []));
  const chunk = outputs.find(o => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('service worker: no output');
  return chunk.code;
}

/** The output's pages: every .html outside the hashed files and the site's pictures. */
function pagesIn(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== 'assets' && e.name !== 'site-media') pagesIn(join(dir, e.name), out);
    else if (e.isFile() && e.name.endsWith('.html')) out.push(join(dir, e.name));
  }
  return out;
}

/**
 * The offline cache's build side. A production build writes `au-manifest.json` (the files of the build, sorted into the worker's
 * caches: swRules.ts `buildManifest`) and `sw.js`, whose version is a hash of the files' names (they carry their content hashes).
 * The dev server serves a dev `sw.js` that caches only media.
 */
export function serviceWorker(): Plugin {
  let version = '';
  let outDir = 'dist';
  return {
    name: 'au-service-worker',
    // (after Vite's own HTML step: it drops the empty chunks that stand for each page's entry, so the manifest must not list them, and the pages are in the bundle by then)
    enforce: 'post',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res, next) => {
        bundleWorker('dev', true).then(code => {
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(code);
        }, next);
      });
    },
    generateBundle: { order: 'post', handler(_options, bundle) {
      const files = Object.values(bundle).map(f => ({
        path: f.fileName,
        size: f.type === 'chunk' ? Buffer.byteLength(f.code) : typeof f.source === 'string' ? Buffer.byteLength(f.source) : f.source.byteLength,
        // (where an asset came from: the manifest's `sealed` list is the files built from games/unity/.sealed)
        sources: f.type === 'asset' ? f.originalFileNames : undefined,
      }));
      version = createHash('sha256').update(files.map(f => `${f.path}:${f.size}`).sort().join('\n')).digest('hex').slice(0, 12);
      // (the pages are emitted after this hook runs: the ones the app has sources for are listed beside the bundle's files)
      const pages = SHELL_ROOT.filter(u => u.endsWith('/index.html') && existsSync(`${appDir}${u.slice(1)}`)).map(u => ({ path: u.slice(1), size: 0 }));
      const manifest = buildManifest(version, [...files, ...pages]);
      this.emitFile({ type: 'asset', fileName: MANIFEST_PATH.slice(1), source: JSON.stringify(manifest) });
    } },
    async writeBundle() {
      const { mkdir, writeFile } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });
      await writeFile(`${outDir}/sw.js`, await bundleWorker(version, false, outDir));
      // (each page carries the build's version, for the gate to compare with its worker's. Written once the pages are on disk: the version
      // is a hash of the files' names and sizes, and a page is listed with no size, so this changes no version)
      const { readFile } = await import('node:fs/promises');
      for (const page of pagesIn(outDir)) await writeFile(page, withVersionMeta(await readFile(page, 'utf8'), version));
    },
  };
}
