// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The triggers a new game has enabled (triggers.json: 16, 3, 19, 20, 21, 64 and 74, all the ship's), which
 * ScummVM's walkthrough harness turns off before it starts tracing, as tools/rawcheck/harness/walk does.
 * The TypeScript runner turns off the lifted ones among them, so both engines start alike (Plan 6 Decision 3).
 */
export const SHIP_TRIGGERS_OFF = [0x10, 3, 0x13, 0x14, 0x15, 0x40, 0x4a];
