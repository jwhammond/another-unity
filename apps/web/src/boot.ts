// SPDX-License-Identifier: GPL-3.0-or-later
import { bindFullscreenButtons, bindOrientation } from './landscape';
import { bindLoading, LOADING_STEPS, trackDownloads } from './loading';
import { onUpdating, registerServiceWorker } from './swRegister';

// (the loading screen's first script, and nearly nothing else: the app and its libraries are imported after it is
// running, so the screen can count their download instead of sitting at nothing until all of it has come)
bindOrientation();
bindFullscreenButtons();
const loading = bindLoading();
loading.begin(LOADING_STEPS[0]!.label);
const stop = trackDownloads(loading);
// (the offline cache: swRegister.ts, docs/web.md; a new version found waiting takes over and the page reloads once)
onUpdating(() => loading.setNote('Updating…'));
void registerServiceWorker();
import('./main')
  .then(() => stop())
  .catch((err: unknown) => {
    stop();
    console.error(err);
    loading.fail(err);
  });
