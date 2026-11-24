// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { addSpdx } from './spdx';

const ID = 'SPDX-License-Identifier: GPL-3.0-or-later';

describe('addSpdx', () => {
  it('adds after a shebang', () => {
    expect(addSpdx('tools/x/run.sh', '#!/bin/sh\necho hi\n')).toBe(`#!/bin/sh\n# ${ID}\necho hi\n`);
  });
  it('adds at the top of a TypeScript file', () => {
    expect(addSpdx('engine/src/a.ts', 'export {};\n')).toBe(`// ${ID}\nexport {};\n`);
  });
  it('skips a file that has one', () => {
    expect(addSpdx('engine/src/a.ts', `// ${ID}\nexport {};\n`)).toBeNull();
  });
  it('uses the CSS comment form', () => {
    expect(addSpdx('apps/web/a.css', 'body {}\n')).toBe(`/* ${ID} */\nbody {}\n`);
  });
  it('limits yaml to tools/ and art/', () => {
    expect(addSpdx('art/recipes/a.yaml', 'a: 1\n')).toBe(`# ${ID}\na: 1\n`);
    expect(addSpdx('games/unity/a.yaml', 'a: 1\n')).toBeNull();
  });
  it('skips data, notes and dependencies', () => {
    expect(addSpdx('a.json', '{}')).toBeNull();
    expect(addSpdx('README.md', '#')).toBeNull();
    expect(addSpdx('x/node_modules/p/i.js', '1')).toBeNull();
    expect(addSpdx('.superpowers/a.ts', '1')).toBeNull();
    expect(addSpdx('tools/lift/src/__golden__/mini/a.yaml', 'a: 1')).toBeNull();
    expect(addSpdx('a.walk', '1')).toBeNull();
    expect(addSpdx('a.inputs', '1')).toBeNull();
  });
});
