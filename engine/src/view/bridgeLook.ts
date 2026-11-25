// SPDX-License-Identifier: GPL-3.0-or-later
import type { CardLook, CardShadow } from './cardLook';

/**
 * How the bridge's crew are set into the repainted bridge (cardLook.ts): their cut-out edge softened, their crushed blacks lifted to the room's
 * darkest, the room's warm overhead light over them, and a soft shadow on the carpet under each. Judged by eye against the published plate.
 */
export const BRIDGE_LOOK: CardLook = {
  lift: [0.13, 0.13, 0.16],
  gain: [1.0, 0.97, 0.93],
  saturation: 0.9,
  feather: 4,
  erode: 0.35,
};

/**
 * Each crew member's shadow (the original's pixels), centred under their feet as measured in their idle strip's first frame: dx is the feet's
 * centre from the frame's, dy the rows the frame leaves under them. Standing wider than seated, Worf's further back smaller.
 */
export const BRIDGE_SHADOWS: Record<string, CardShadow> = {
  picard: { width: 62, height: 11, opacity: 0.55, dx: 4, dy: -2 },
  riker: { width: 52, height: 10, opacity: 0.55, dx: 9.5, dy: -11 },
  worf: { width: 36, height: 6, opacity: 0.35, dx: -1.5, dy: -7 },
  troi: { width: 22, height: 5, opacity: 0.35, dx: -8.5, dy: -6 },
  data: { width: 48, height: 8, opacity: 0.4, dx: 23, dy: -2 },
};
