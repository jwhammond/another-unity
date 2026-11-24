// SPDX-License-Identifier: GPL-3.0-or-later
import { defineConfig } from 'vitest/config';
import { markdown } from './apps/web/mdPlugin';

export default defineConfig({
  // (the site's pages import their Markdown as HTML)
  plugins: [markdown()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    include: ['engine/src/**/*.test.{ts,tsx}', 'tools/*/src/**/*.test.ts', 'apps/*/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'apps/*/scripts/**/*.test.ts', 'functions/**/*.test.ts'],
  },
});
