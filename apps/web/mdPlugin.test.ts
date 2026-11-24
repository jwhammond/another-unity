// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { markdownToModule } from './mdPlugin';

describe('markdownToModule', () => {
  it('exports the rendered HTML as the default string', () => {
    const code = markdownToModule('# Hi\n\nSome **bold** text.');
    expect(code).toMatch(/^export default /);
    const html = JSON.parse(code.replace(/^export default /, '').replace(/;$/, ''));
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).toContain('<strong>bold</strong>');
  });
  it('opens external links in a new tab', () => {
    const html = JSON.parse(markdownToModule('[gh](https://github.com/fuzzie)').replace(/^export default /, '').replace(/;$/, ''));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });
});
