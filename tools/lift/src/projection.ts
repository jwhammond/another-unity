// SPDX-License-Identifier: GPL-3.0-or-later
import { CENTER_X, FOCAL_PX, NEAR_Y, Projection as MetricProjection, round3, type PixelFit } from '@another-unity/engine';

export { CENTER_X, FLAT_DEPTH, FOCAL_PX, NEAR_Y, round3 } from '@another-unity/engine';

/** Metres per pixel at full scale (256): a 144-pixel crew member is 1.8 m tall. */
export const METERS_PER_PIXEL = 0.0125;
/** Below this many scale units per row, the floor is treated as flat. */
export const MIN_SLOPE = 0.05;
/** A fit further than this (in scale units) from the polygons' scales is worth a look. */
export const MAX_RMS = 8;

/** The deepest a fit's back edge may be: depthFactor(topY) = FOCAL_PX / (topY - horizonY). Past it the horizon moves up (M3 Decision 7). */
export const MAX_BACK_DEPTH = 40;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places + 0;

/** A screen's pixel metric, with how well it fits the polygons' scales. */
export interface ProjectionParams extends PixelFit {
  /** How many polygon vertices the fit used, and how far they are from it (in scale units). */
  samples: number;
  rms: number;
  /** The fit's horizon was moved up to MAX_BACK_DEPTH (M3 Plan 8 R3). */
  capped?: true;
}

/** A least-squares line of scale over row; null without two rows, or for a floor too flat to have a horizon. */
export function fitRows(samples: [number, number][]): { slope: number; horizonY: number } | null {
  const n = samples.length;
  const meanY = samples.reduce((s, [y]) => s + y, 0) / n;
  const meanS = samples.reduce((s, [, v]) => s + v, 0) / n;
  const sxx = samples.reduce((s, [y]) => s + (y - meanY) ** 2, 0);
  if (n < 2 || sxx === 0) return null;
  const slope = samples.reduce((s, [y, v]) => s + (y - meanY) * (v - meanS), 0) / sxx;
  if (slope < MIN_SLOPE) return null;
  return { slope: round(slope, 6), horizonY: round3(meanY - meanS / slope) };
}

export type ProjectionOverride = Partial<Pick<ProjectionParams, 'kind' | 'slope' | 'horizonY' | 'meanScale' | 'topY'>>;

export interface CameraParams {
  kind: 'perspective' | 'flat';
  position: [number, number, number];
  /** The vertical field of view, in radians, over the 480-pixel screen. */
  yfov: number;
  /** The horizon's row: the view's centre is that far above the screen's (an off-axis view). */
  horizonY: number;
}

export interface ScalePolygon {
  /** 0 closed and 1 walkable (PathBlocks switch between them); 3 and 4 aren't floor. */
  type: number;
  points: { x: number; y: number }[];
  distances: number[];
}

/** The engine's projection (one implementation for the lifter, the sim and the diff), with the fit's numbers and the greybox camera. */
export class Projection extends MetricProjection<ProjectionParams> {
  /** The screen's content: the fitted metric without the fit's numbers. */
  fit(): PixelFit {
    const { kind, slope, horizonY, meanScale, topY, metersPerPixel } = this.params;
    return { kind, slope, horizonY, meanScale, topY, metersPerPixel };
  }

  camera(): CameraParams {
    const p = this.params;
    const yfov = round(2 * Math.atan(240 / FOCAL_PX), 4);
    if (p.kind === 'flat') {
      return { kind: 'flat', position: [0, 20, this.toWorld(CENTER_X, 200).z], yfov, horizonY: p.horizonY };
    }
    // the camera is at the floor's z for distance 0, at the height that makes the fitted scales come out
    const height = round3((p.metersPerPixel * 256) / p.slope);
    return { kind: 'perspective', position: [0, height, round3(FOCAL_PX * this.unitsPerPixel(NEAR_Y))], yfov, horizonY: p.horizonY };
  }
}

export function fitProjection(polygons: ScalePolygon[], override: ProjectionOverride = {}, metersPerPixel = METERS_PER_PIXEL): Projection {
  const samples: [number, number][] = [];
  let topY = Infinity;
  for (const poly of polygons) {
    // (scaleAt only interpolates over floor; type 3 and 4 polygons, such as the full-screen one at 256, aren't floor)
    if (poly.type !== 0 && poly.type !== 1) continue;
    poly.points.forEach((pt, i) => {
      topY = Math.min(topY, pt.y);
      // (a scale of 0 is never drawn: loadScreenPolys)
      if (poly.distances[i] > 0) samples.push([pt.y, poly.distances[i]]);
    });
  }
  const n = samples.length;
  const meanY = n ? samples.reduce((s, [y]) => s + y, 0) / n : 0;
  const meanS = n ? samples.reduce((s, [, v]) => s + v, 0) / n : 256;
  let slope = 0;
  let intercept = meanS;
  const sxx = samples.reduce((s, [y]) => s + (y - meanY) ** 2, 0);
  if (n >= 2 && sxx > 0) {
    slope = samples.reduce((s, [y, v]) => s + (y - meanY) * (v - meanS), 0) / sxx;
    intercept = meanS - slope * meanY;
  }
  const kind = override.kind ?? (slope >= MIN_SLOPE ? 'perspective' : 'flat');
  let fittedHorizon = slope >= MIN_SLOPE ? -intercept / slope : 0;
  const top = override.topY ?? (Number.isFinite(topY) ? topY : 0);
  const lowest = top - FOCAL_PX / MAX_BACK_DEPTH;
  let capped = false;
  if (slope >= MIN_SLOPE && override.horizonY === undefined && override.slope === undefined && fittedHorizon > lowest) {
    // (pivot about the samples' mean row: the scale there stays, and the horizon goes up to the cap)
    fittedHorizon = lowest;
    slope = meanS / (meanY - lowest);
    intercept = -slope * lowest;
    capped = true;
  }
  const rms = n ? Math.sqrt(samples.reduce((s, [y, v]) => s + (v - (slope * y + intercept)) ** 2, 0) / n) : 0;
  return new Projection({
    kind,
    slope: round(override.slope ?? slope, 6),
    horizonY: round3(override.horizonY ?? fittedHorizon),
    meanScale: round3(override.meanScale ?? meanS),
    topY: top,
    metersPerPixel,
    samples: n,
    rms: round3(rms),
    ...(capped ? { capped: true as const } : {}),
  });
}
