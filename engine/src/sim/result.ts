// SPDX-License-Identifier: GPL-3.0-or-later
/** Result flags, with the original's values (object.h), so traces can be compared. */
export const R = {
  FAILOTHER: 0x2,
  WALKING: 0x4,
  FAILSKILL: 0x8,
  NOTARGET: 0x10,
  OTHERPOS: 0x20,
  FAILPOS: 0x40,
  AWAYTEAM: 0x80,
  INVENTORY: 0x100,
  INACTIVE: 0x200,
  FAILSCREEN: 0x400,
  STOPPED: 0x800,
  FAILSTATE: 0x1000,
  MATCHOTHER: 0x2000,
  EMPTYTALK: 0x4000,
  DIDSOMETHING: 0x8000,
  COUNTER_DOWHEN: 0x10000,
  COUNTER_DOUNTIL: 0x20000,
  STUNNED: 0x40000,
  FAILPHASER: 0x80000,
  TRICORDER: 0x100000,
} as const;
