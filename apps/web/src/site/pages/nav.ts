// SPDX-License-Identifier: GPL-3.0-or-later
import type { NavItem } from '../lcars/SideNav';
export type PageKey = 'home' | 'engineering' | 'engine' | 'afu' | 'characters' | 'enterprise' | 'mission';
export function NAV(current: PageKey): NavItem[] {
  return [
    { label: 'Home', href: '/', code: '01-1701', current: current === 'home' },
    { label: 'Engineering', href: '/engineering/', code: '02-0947', current: current === 'engineering' },
    { label: 'The engine', href: '/engineering/engine/', code: '03-2266', current: current === 'engine' },
    { label: 'A Final Unity', href: '/engineering/afu/', code: '04-1995', current: ['afu', 'characters', 'enterprise', 'mission'].includes(current) },
  ];
}
