// SPDX-License-Identifier: GPL-3.0-or-later
import { packageFromGlobs, type GamePackage } from '@another-unity/engine/web';
import { registerUnityHooks } from '../../../../games/unity/hooks/register';
import '../../../../games/unity/theme.css';
import { contentChanged } from '../hot';

/**
 * A Final Unity, as tools/lift wrote it into games/unity (local only: the content is Paramount's and never
 * committed; docs/unity-local.md). overrides/ is the lifter's input, already merged, so it isn't loaded.
 */
export function unity(): GamePackage {
  return packageFromGlobs({
    id: 'unity',
    base: '../../../../games/unity/',
    // (combat.yaml, about half a megabyte, is read when a battle needs it, from a chunk of its own: M8 spec §8)
    yaml: import.meta.glob<string>(['../../../../games/unity/**/*.yaml', '!../../../../games/unity/overrides/**', '!../../../../games/unity/combat.yaml'], { query: '?raw', import: 'default', eager: true }),
    lazyYaml: import.meta.glob<string>('../../../../games/unity/combat.yaml', { query: '?raw', import: 'default' }),
    // (not the transcoder's *.cmd notes beside the audio: they aren't the game's, and Vite would inline each into the bundle)
    assets: import.meta.glob<string>(['../../../../games/unity/{art,audio,models,movies,space}/**/*', '!../../../../games/unity/**/*.cmd'], { query: '?url', import: 'default', eager: true }),
    registerHooks: registerUnityHooks,
  });
}

// (a changed YAML file, or a changed hook, re-runs this module: the session swaps the new package in)
if (import.meta.hot) {
  import.meta.hot.accept(next => {
    const fresh = (next as { unity?: () => GamePackage } | undefined)?.unity;
    if (fresh) contentChanged(fresh);
  });
}
