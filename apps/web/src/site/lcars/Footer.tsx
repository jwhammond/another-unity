// SPDX-License-Identifier: GPL-3.0-or-later
import { Coffee } from 'lucide-preact';

/** (lucide dropped brand icons in 1.x, so the GitHub mark is drawn here) */
const GithubMark = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>
);
export function Footer() {
  return (
    <footer class="lc-footer">
      <p class="lc-legal">Star Trek and all related marks, characters and game assets belong to their owners (CBS Studios / Paramount and the original publishers). Another Unity claims no ownership of them. It is a non-commercial fan project made for preservation and study under fair use, and is not affiliated with or endorsed by the rights holders.</p>
      <div class="lc-footer-links">
        <a class="lc-pill tone-a1" href="https://github.com/jwhammond/another-unity" target="_blank" rel="noopener"><GithubMark /> GitHub</a>
        <a class="lc-pill tone-a2" href="https://ko-fi.com/sz750108" target="_blank" rel="noopener"><Coffee size={16} aria-hidden="true" /> Buy Me a Coffee</a>
      </div>
    </footer>
  );
}
