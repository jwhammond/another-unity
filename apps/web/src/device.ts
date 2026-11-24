// SPDX-License-Identifier: GPL-3.0-or-later
import { isTouchDevice } from './landscape';

/** What decides whether a device is short of memory (a test gives its own). */
export interface DeviceInfo {
  /** `navigator.deviceMemory`: GB, rounded down to a power of two and capped at 8; undefined where the browser hides it (Safari, Firefox). */
  deviceMemory?: number;
  /** The shorter side of the screen, in CSS pixels. */
  screenMin: number;
  touch: boolean;
}

/** The screens this small are phones, held either way up. */
export const SMALL_SCREEN = 500;

export function deviceInfo(win: Window = window): DeviceInfo {
  const nav = win.navigator as Navigator & { deviceMemory?: number };
  return { deviceMemory: nav.deviceMemory, screenMin: Math.min(win.screen?.width ?? Infinity, win.screen?.height ?? Infinity), touch: isTouchDevice(win) };
}

/**
 * A device that gets half-resolution plates and a capped pixel ratio: 4 GB of memory or less, a small screen, or a touch
 * device. `?res=half` or `?res=full` decides it for a test or a developer.
 */
export function lowMemoryDevice(search: string = location.search, info: DeviceInfo = deviceInfo()): boolean {
  const res = new URLSearchParams(search).get('res');
  if (res === 'half') return true;
  if (res === 'full') return false;
  return (info.deviceMemory !== undefined && info.deviceMemory <= 4) || info.screenMin < SMALL_SCREEN || info.touch;
}

/** The renderer's pixel ratio: the device's, but never above 2 on a low-memory device (a 3x phone screen is a third more pixels for nothing). */
export function pixelRatioFor(devicePixelRatio: number, low: boolean): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return low ? Math.min(ratio, 2) : ratio;
}
