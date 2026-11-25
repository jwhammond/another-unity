// SPDX-License-Identifier: GPL-3.0-or-later
import { render, type ComponentType } from 'preact';
import { Frame } from './lcars/Frame';
import { NAV } from './pages/nav';

const pages: Record<string, () => Promise<{ default: ComponentType }>> = {
  home: () => import('./pages/Home'),
  engine: () => import('./pages/Engine'),
  afu: () => import('./pages/Afu'),
  characters: () => import('./pages/Characters'),
  enterprise: () => import('./pages/Enterprise'),
  mission: () => import('./pages/Mission'),
  missions: () => import('./pages/MissionList'),
  tactical: () => import('./pages/Tactical'),
};

export class UnknownPage extends Error {}

/** The page named by <body data-page>; each page file default-exports its component. */
export async function pageFor(name: string): Promise<ComponentType> {
  const load = pages[name];
  if (!load) throw new UnknownPage(`No site page "${name}"`);
  return (await load()).default;
}

/** Only an unknown page is "not found"; any other failure is a real error, so it goes to the console. */
export function showError(e: unknown, into: Element) {
  if (e instanceof UnknownPage) {
    render(<Frame section="home" title="Not found" code="01-1701" nav={NAV('home')}><p class="lc-missing">Page not found. <a href="/">Back to the home console</a></p></Frame>, into);
    return;
  }
  console.error(e);
  render(<Frame section="home" title="Error" code="01-1701" nav={NAV('home')}><p class="lc-missing">This page failed to load. <a href="/">Back to the home console</a></p></Frame>, into);
}
