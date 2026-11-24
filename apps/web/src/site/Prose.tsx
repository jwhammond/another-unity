// SPDX-License-Identifier: GPL-3.0-or-later
/** A page's Markdown, rendered at build time (mdPlugin.ts). The HTML is our own committed content, not user input. */
export function Prose({ html }: { html: string }) {
  return <div class="lc-prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
