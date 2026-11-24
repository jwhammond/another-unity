// SPDX-License-Identifier: GPL-3.0-or-later
import { chirp } from './chirp';
export type NavItem = { label: string; href: string; current?: boolean; code?: string };

export function SideNav({ items }: { items: NavItem[] }) {
  if (items.length > 6) throw new Error('The side column holds at most six blocks');
  return (
    <nav class="lc-side" aria-label="Sections">
      {items.map(i => (
        <a key={i.href} class={`lc-block${i.current ? ' is-current' : ''}`} href={i.href} aria-current={i.current ? 'page' : undefined} onClick={() => chirp('press')}>
          {i.code && <span class="lc-code" aria-hidden="true">{i.code}</span>}
          <span>{i.label}</span>
        </a>
      ))}
      <div class="lc-side-fill" aria-hidden="true" />
    </nav>
  );
}
