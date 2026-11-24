// SPDX-License-Identifier: GPL-3.0-or-later
import { render } from 'preact';
import './site.css';
import { pageFor, showError } from './loader';
import { registerServiceWorker } from '../swRegister';

const root = document.getElementById('site')!;
void pageFor(document.body.dataset.page ?? 'home')
  .then(Page => render(<Page />, root))
  .catch(e => showError(e, root));
// (a waiting worker is left for the game page to switch to; the same worker as the game's: one online visit to any page of the site keeps the site and the game's shell for offline use)
void registerServiceWorker({ activate: false });
