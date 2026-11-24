// SPDX-License-Identifier: GPL-3.0-or-later
import { AI_SEAMS } from './ai';
import { CAMERA_SEAMS } from './camera';
import { DAMAGE_SEAMS } from './damage';
import { TACTICS_SEAMS } from './tactics';
import type { CombatSeams } from './types';
import { WEAPON_SEAMS } from './weapons';

/**
 * Every seam the sim fills itself: weapons, damage, the AI and tactics (Plans 20 and 21), and the camera (M8, which
 * reads no random number and writes only the camera). A context takes `{ ...NO_SEAMS, ...SIM_SEAMS }`, and Plan 22 adds
 * the world's (its scripts, the hail, the bridge, astrogation's warp).
 */
export const SIM_SEAMS: Readonly<Partial<CombatSeams>> = Object.freeze({ ...WEAPON_SEAMS, ...DAMAGE_SEAMS, ...AI_SEAMS, ...TACTICS_SEAMS, ...CAMERA_SEAMS });
