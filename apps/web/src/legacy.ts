// SPDX-License-Identifier: GPL-3.0-or-later
/** Before the site existed the game lived at `/`; a link with a `game` query still opens it, now at /play/afu/. */
export function legacyTarget(search: string, pathname: string): string | null {
  if (pathname !== '/' && pathname !== '/index.html') return null;
  const params = new URLSearchParams(search);
  return params.has('game') ? `/play/afu/${search}` : null;
}

/** An installed app (fullscreen or standalone display mode) opens on the home page; it should open the game, as its start_url says. */
export function installedTarget(installed: boolean, pathname: string): string | null {
  return installed && (pathname === '/' || pathname === '/index.html') ? '/play/afu/' : null;
}
