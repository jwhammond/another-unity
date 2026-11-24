// SPDX-License-Identifier: GPL-3.0-or-later
/** Adds an SPDX license line to a source file, for `publish:spdx`. */
const ID = 'SPDX-License-Identifier: GPL-3.0-or-later';

const SLASH = new Set(['.ts', '.tsx', '.js', '.mjs']);
const HASH = new Set(['.py', '.sh', '.yaml']);

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

/** Paths the run never touches: dependencies, scratch notes, lifter goldens (byte-compared), and data-like files. */
function skipped(path: string): boolean {
  return /(^|\/)(node_modules|\.superpowers|__golden__)\//.test(path) || /\.(walk|inputs|json|md)$/.test(path);
}

/** The comment line for this file, or null when its kind gets none. YAML only under tools/ and art/. */
function lineFor(path: string): string | null {
  const ext = extOf(path);
  if (SLASH.has(ext)) return `// ${ID}`;
  if (ext === '.css') return `/* ${ID} */`;
  if (ext === '.yaml') return /^(tools|art)\//.test(path) ? `# ${ID}` : null;
  if (HASH.has(ext)) return `# ${ID}`;
  return null;
}

/** The new text with the license line added (after a shebang), or null when there is nothing to do. */
export function addSpdx(path: string, text: string): string | null {
  if (skipped(path)) return null;
  const line = lineFor(path);
  if (!line) return null;
  if (text.slice(0, 600).includes('SPDX-License-Identifier')) return null;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    if (nl < 0) return `${text}\n${line}\n`;
    return `${text.slice(0, nl + 1)}${line}\n${text.slice(nl + 1)}`;
  }
  return `${line}\n${text}`;
}
