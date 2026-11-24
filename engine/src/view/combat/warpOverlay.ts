// SPDX-License-Identifier: GPL-3.0-or-later
import { DataTexture, DoubleSide, Mesh, MeshBasicMaterial, OrthographicCamera, PlaneGeometry, RGBAFormat, Scene, SRGBColorSpace } from 'three';
import type { BattleAssets } from './assets';
import { frameUv } from './effects';
import { WARP_SPRITES, warpOverlayAt } from './warp';

/**
 * The warp overlay drawn (TacticalScreen::showWarp, tactical.cpp:818-854): cheap.pic in its own palette over the whole
 * 640 x 480 screen, and the three sprites (warp.ts) in theirs, cheap.pic's (Plan 24 R2). The originals' pictures, as the
 * space view's effects are (M8 spec Decision 13); one quad a frame drawn.
 */
export class WarpOverlay {
  readonly scene = new Scene();
  /** The screen's 640 x 480 pixels, y down. */
  readonly camera = new OrthographicCamera(0, 640, 0, -480, -1, 1);
  private readonly quads = new Map<string, Mesh<PlaneGeometry, MeshBasicMaterial>>();
  private readonly owned: { dispose(): void }[] = [];
  /** What is wrong with the set's warp sprites: a sheet not in cheap.pic's palette (an images export from before Plan 24). */
  readonly problems: string[] = [];

  constructor(private readonly assets: BattleAssets) {
    const stills = assets.stills;
    const pic = stills?.warp[0];
    if (stills && pic) {
      // (cheap.pic's indices in its own palette, which showWarp's setBackgroundImage sets)
      const rgba = new Uint8Array(pic.width * pic.height * 4);
      for (let i = 0; i < pic.pixels.length; i++) {
        const c = pic.pixels[i]! * 3;
        rgba.set([stills.warpPalette[c]!, stills.warpPalette[c + 1]!, stills.warpPalette[c + 2]!, 255], i * 4);
      }
      const t = new DataTexture(rgba, pic.width, pic.height, RGBAFormat);
      t.colorSpace = SRGBColorSpace;
      t.flipY = false;
      t.needsUpdate = true;
      const quad = new Mesh(new PlaneGeometry(pic.width, pic.height), new MeshBasicMaterial({ map: t, depthTest: false, depthWrite: false, side: DoubleSide }));
      quad.position.set(pic.width / 2, -pic.height / 2, 0);
      // (the plane's v runs up, the picture's rows down: turned over, so both sides are drawn)
      quad.scale.y = -1;
      quad.renderOrder = -1;
      this.scene.add(quad);
      this.owned.push(t, quad.geometry, quad.material);
    }
    for (const { file } of WARP_SPRITES) {
      const sheet = assets.sprites.get(file);
      if (sheet && sheet.palette !== 'cheap') this.problems.push(`combat: the warp overlay's ${file} is in the ${sheet.palette} palette, not cheap.pic's: re-export the images (Plan 24, docs/unity-local.md)`);
    }
  }

  /** Shows the overlay `ms` into it: each sprite's frames at their places, deepest first. */
  update(ms: number): void {
    for (const q of this.quads.values()) q.visible = false;
    let order = 0;
    for (const layer of warpOverlayAt(this.assets.sprites, ms)) {
      const [w, h] = this.assets.sprites.get(layer.file)!.cell;
      for (const frame of layer.frames) {
        const q = this.quad(layer.file, frame);
        q.position.set(layer.left + w / 2, -(layer.top + h / 2), 0);
        q.renderOrder = order++;
        q.visible = true;
      }
    }
  }

  /** The quads drawn by the last update, for the tests and `?dev`: each sprite and frame, at its top left. */
  shown(): { file: string; frame: number; left: number; top: number }[] {
    return [...this.quads.entries()].filter(([, q]) => q.visible).sort(([, a], [, b]) => a.renderOrder - b.renderOrder).map(([key, q]) => {
      const [file, frame] = key.split('#') as [string, string];
      const [w, h] = this.assets.sprites.get(file)!.cell;
      return { file, frame: Number(frame), left: q.position.x - w / 2, top: -q.position.y - h / 2 };
    });
  }

  /**
   * A frame's quad, made the first time it is drawn: the sheet's own texture (the warp sheets are the overlay's alone, loaded
   * texel for texel: assets.ts), the frame in the quad's UVs, so a new frame copies and uploads nothing (review I2).
   */
  private quad(file: string, frame: number): Mesh<PlaneGeometry, MeshBasicMaterial> {
    const key = `${file}#${frame}`;
    let q = this.quads.get(key);
    if (!q) {
      const sheet = this.assets.sprites.get(file)!;
      const [w, h] = sheet.cell;
      const geometry = new PlaneGeometry(w, h);
      const { offset, repeat } = frameUv(sheet, frame);
      const uv = geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, offset[0] + uv.getX(i) * repeat[0], offset[1] + uv.getY(i) * repeat[1]);
      // (turned over as the background is: frameUv's v runs down the frame)
      q = new Mesh(geometry, new MeshBasicMaterial({ map: sheet.texture, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide }));
      q.scale.y = -1;
      this.scene.add(q);
      this.owned.push(q.geometry, q.material);
      this.quads.set(key, q);
    }
    return q;
  }

  /** Frees what the overlay made (not the set's sheets). */
  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.owned.length = 0;
    this.quads.clear();
  }
}
