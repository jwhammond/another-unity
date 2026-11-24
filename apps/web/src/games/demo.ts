// SPDX-License-Identifier: GPL-3.0-or-later
import { packageFromGlobs, type GamePackage } from '@another-unity/engine/web';
import '../../../../tools/play/fixtures/demo/theme.css';
import { contentChanged } from '../hot';

/** The demo game: Plan 1-2's headless fixture, with Task 4's greybox rooms and sounds. */
export function demo(): GamePackage {
  return packageFromGlobs({
    id: 'demo',
    base: '../../../../tools/play/fixtures/demo/',
    yaml: import.meta.glob<string>('../../../../tools/play/fixtures/demo/**/*.yaml', { query: '?raw', import: 'default', eager: true }),
    assets: import.meta.glob<string>('../../../../tools/play/fixtures/demo/{audio,models,movies}/**/*', { query: '?url', import: 'default', eager: true }),
  });
}

// (a changed YAML file re-runs this module; the session swaps the new content in: Decision 12)
if (import.meta.hot) {
  import.meta.hot.accept(next => {
    const fresh = (next as { demo?: () => GamePackage } | undefined)?.demo;
    if (fresh) contentChanged(fresh);
  });
}
