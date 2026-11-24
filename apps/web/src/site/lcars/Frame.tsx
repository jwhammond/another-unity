// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChildren } from 'preact';
import { Footer } from './Footer';
import { SideNav, type NavItem } from './SideNav';
import { SoundToggle } from './SoundToggle';

export type Section = 'home' | 'engineering' | 'afu';
const NOISE = ['47751.2', '0947-1701', '21505', '3972-E'];

export function Frame(p: { section: Section; title: string; code: string; nav: NavItem[]; children: ComponentChildren }) {
  return (
    <div class={`lc-frame lc-${p.section}`}>
      <div class="lc-elbow" aria-hidden="true"><span>{p.code}</span></div>
      <header class="lc-header">
        <div class="lc-noise" aria-hidden="true">{NOISE.map(n => <span key={n}>{n}</span>)}</div>
        <h1 class="lc-title">{p.title}</h1>
        <div class="lc-bands" aria-hidden="true"><span /><span /><span /></div>
        <SoundToggle />
      </header>
      <SideNav items={p.nav} />
      <main class="lc-content">{p.children}</main>
      <Footer />
    </div>
  );
}
