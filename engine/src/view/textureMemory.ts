// SPDX-License-Identifier: GPL-3.0-or-later
import type { Texture } from 'three';

/** One texture the page holds: where it came from and what its pixels cost on the GPU (RGBA, plus the mip chain when it has one). */
export interface TextureRecord {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/** The bytes a width x height RGBA texture takes: four a pixel, a third more for its mip chain. */
export function textureBytes(width: number, height: number, mips: boolean): number {
  return Math.round(width * height * 4 * (mips ? 4 / 3 : 1));
}

/**
 * What the page's textures add up to. `renderer.info.memory` only counts them; this knows each one's size, so a log
 * (or a test) can say how much the art costs. A texture is counted when it is loaded and leaves the count when three
 * disposes it, so a texture that is never freed shows as a total that only grows.
 */
export class TextureLedger {
  private readonly live = new Map<Texture, { url: string; width: number; height: number }>();

  /** A texture's record now: its mip chain counts only while it has one to make. */
  private record(texture: Texture, seen: { url: string; width: number; height: number }): TextureRecord {
    return { ...seen, bytes: textureBytes(seen.width, seen.height, texture.generateMipmaps) };
  }

  /** Counts a loaded texture (its image must be there); returns it. */
  track(texture: Texture, url: string): Texture {
    const image = texture.image as { width?: number; height?: number; naturalWidth?: number } | undefined;
    const width = image?.width ?? 0;
    const height = image?.height ?? 0;
    if (width === 0 || height === 0 || this.live.has(texture)) return texture;
    this.live.set(texture, { url, width, height });
    texture.addEventListener('dispose', () => this.live.delete(texture));
    return texture;
  }

  get count(): number {
    return this.live.size;
  }

  /** The bytes of every texture not yet disposed. */
  get bytes(): number {
    let total = 0;
    for (const [t, seen] of this.live) total += this.record(t, seen).bytes;
    return total;
  }

  /** The bytes of the live textures `uploaded` says are on the GPU (a texture's image is decoded long before it is first drawn, and the GPU holds only what was drawn). */
  uploadedBytes(uploaded: (texture: Texture) => boolean): number {
    let total = 0;
    for (const [t, seen] of this.live) if (uploaded(t)) total += this.record(t, seen).bytes;
    return total;
  }

  /** The live textures, biggest first. */
  records(): TextureRecord[] {
    return [...this.live].map(([t, seen]) => this.record(t, seen)).sort((a, b) => b.bytes - a.bytes);
  }

  /** "12 textures, 96.4 MB" and the biggest few, for a console line. */
  summary(top = 3): string {
    const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;
    const biggest = this.records().slice(0, top).map(r => `${r.url.split('/').slice(-3).join('/')} ${r.width}x${r.height} ${mb(r.bytes)}`);
    return `${this.count} textures, ${mb(this.bytes)}${biggest.length > 0 ? ` (${biggest.join('; ')})` : ''}`;
  }
}

/** The textures the default loaders have made, for the whole page. */
export const textureLedger = new TextureLedger();
