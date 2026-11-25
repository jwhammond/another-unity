// SPDX-License-Identifier: GPL-3.0-or-later
import { Pill } from './Pill';

export type AfuPage = 'approach' | 'characters' | 'enterprise' | 'tactical' | 'missions';
const LINKS: { key: AfuPage; label: string; href: string; tone: 'a1' | 'a2' | 'a3' }[] = [
  { key: 'approach', label: 'Approach', href: '/engineering/afu/', tone: 'a1' },
  { key: 'characters', label: 'Characters & items', href: '/engineering/afu/characters/', tone: 'a2' },
  { key: 'enterprise', label: 'The Enterprise', href: '/engineering/afu/enterprise/', tone: 'a3' },
  { key: 'tactical', label: 'Tactical', href: '/engineering/afu/tactical/', tone: 'a1' },
  { key: 'missions', label: 'Missions', href: '/engineering/afu/missions/', tone: 'a2' },
];

/** The pills across the A Final Unity pages: the current one is marked, and the rest link to each other. */
export function SubNav(p: { current: AfuPage }) {
  return (
    <nav class="lc-subnav" aria-label="A Final Unity">
      {LINKS.map(l => <span key={l.key} aria-current={l.key === p.current ? 'page' : undefined}><Pill href={l.href} tone={l.tone}>{l.label}</Pill></span>)}
    </nav>
  );
}
