// SPDX-License-Identifier: GPL-3.0-or-later
import { Marked } from 'marked';
import type { Plugin } from 'vite';

const marked = new Marked({
  renderer: {
    // (text is the link's unrendered source, so its inline markup is rendered from the tokens)
    link({ href, tokens }) {
      const ext = /^https?:\/\//.test(href);
      return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
    },
  },
});
/** A .md file as a module whose default export is its HTML, rendered at build time. */
export function markdownToModule(source: string): string {
  return `export default ${JSON.stringify(marked.parse(source, { async: false }) as string)};`;
}
export function markdown(): Plugin {
  return { name: 'au-markdown', transform(code, id) { return id.endsWith('.md') ? { code: markdownToModule(code), map: null } : null; } };
}
