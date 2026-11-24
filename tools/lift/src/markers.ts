// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '@another-unity/engine';
import type { Problems } from './problems';
import { METERS_PER_PIXEL, round3, type Projection, type ProjectionParams } from './projection';

/** A scripted position's marker name. */
export const pointName = (x: number, y: number) => `p${x}_${y}`;

/** The slug ownerScreen gives when it has already reported that there is no screen. */
export const NO_SCREEN = '$noscreen';

export interface CoordsFile {
  metersPerPixel: number;
  screens: Record<string, { projection: ProjectionParams; depthFactor: { back: number; front: number }; markers: Record<string, [number, number]> }>;
  distances: Record<string, { px: number; y: number; units: number }>;
}

const byKey = <T>(entries: [string, T][]) => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Every marker of every lifted screen, with the pixel it came from. */
export class Markers {
  private readonly screens = new Map<string, { projection: Projection; markers: Map<string, { px: [number, number]; at: Vec2 }> }>();
  private readonly distances = new Map<string, { px: number; y: number; units: number }>();

  constructor(private readonly problems: Problems, private readonly metersPerPixel = METERS_PER_PIXEL) {}

  addScreen(slug: string, projection: Projection): void {
    this.screens.set(slug, { projection, markers: new Map() });
  }

  has(slug: string): boolean {
    return this.screens.has(slug);
  }

  projection(slug: string): Projection | undefined {
    return this.screens.get(slug)?.projection;
  }

  named(screen: string, name: string, x: number, y: number, where: string, quiet = false): string {
    if (screen === NO_SCREEN) return name;
    const s = this.screens.get(screen);
    if (!s) {
      this.problems.error(where, `no lifted screen "${screen}" for marker "${name}"`);
      return name;
    }
    const old = s.markers.get(name);
    if (old) {
      if (old.px[0] !== x || old.px[1] !== y) {
        this.problems.error(where, `marker "${name}" on ${screen} is already at (${old.px[0]}, ${old.px[1]}), not (${x}, ${y})`);
      }
      return name;
    }
    if (!quiet && s.projection.behindFloor(y)) {
      this.problems.warn(where, `(${x}, ${y}) is above the floor's back edge on ${screen} (row ${s.projection.params.topY}); it is placed on that edge`);
    }
    s.markers.set(name, { px: [x, y], at: s.projection.toWorld(x, y) });
    return name;
  }

  /** A scripted position: one marker per pixel per screen; `quiet` drops the back-edge warning (a position on every screen of a world). */
  point(screen: string, x: number, y: number, where: string, quiet = false): string {
    return this.named(screen, pointName(x, y), x, y, where, quiet);
  }

  /** A pixel distance in world units, at row y of the screen (or at full scale, for lists with no screen). */
  distance(screen: string | null, px: number, y: number, where: string): number {
    const projection = screen === null || screen === NO_SCREEN ? undefined : this.screens.get(screen)?.projection;
    const units = projection ? projection.distance(px, y) : round3(px * this.metersPerPixel);
    this.distances.set(where, { px, y, units });
    return units;
  }

  screenMarkers(slug: string): Record<string, Vec2> {
    const s = this.screens.get(slug);
    return s ? byKey([...s.markers].map(([name, m]) => [name, m.at])) : {};
  }

  coordsYaml(): CoordsFile {
    return {
      metersPerPixel: this.metersPerPixel,
      screens: byKey([...this.screens].map(([slug, s]) => [slug, {
        projection: s.projection.params,
        depthFactor: { back: round3(s.projection.depthFactor(s.projection.params.topY)), front: round3(s.projection.depthFactor(399)) },
        markers: byKey([...s.markers].map(([name, m]) => [name, m.px])),
      }])),
      distances: byKey([...this.distances]),
    };
  }
}
