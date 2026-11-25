// SPDX-License-Identifier: GPL-3.0-or-later
import type { NavItem } from '../lcars/SideNav';
export type PageKey = 'home' | 'engine' | 'afu' | 'characters' | 'enterprise' | 'tactical' | 'mission';
export function NAV(current: PageKey): NavItem[] {
  return [
    { label: 'Home', href: '/', code: '01-1701', current: current === 'home' },
    { label: 'The engine', href: '/engineering/engine/', code: '03-2266', current: current === 'engine' },
    { label: 'A Final Unity', href: '/engineering/afu/', code: '04-1995', current: ['afu', 'characters', 'enterprise', 'tactical', 'mission'].includes(current) },
  ];
}
