// SPDX-License-Identifier: GPL-3.0-or-later
import { DataTexture, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, RGBAFormat, type Texture } from 'three';

/**
 * How a card is set into a repainted plate, so it sits in the room rather than on it: its edge feathered (the cut-out's hard edge, softened and
 * drawn in a little, which also takes off the last texel of the picture it was cut from), its colours graded toward the room's (its blacks lifted
 * to the room's darkest, the room's light over it, a little less saturation), and a soft shadow on the floor under it. Drawn in the shader, so
 * the published strips are unchanged and the look can be tuned without making any art again.
 */
export interface CardLook {
  /** The darkest the card goes, as an sRGB colour (0-1): its blacks lifted to the room's. */
  lift: [number, number, number];
  /** The room's light over the card: each channel multiplied by this (1 leaves it). */
  gain: [number, number, number];
  /** 1 keeps the card's colours; less moves them toward grey. */
  saturation: number;
  /** How far the edge is softened, in texels of the strip (a scale-4 strip: 4 texels to an original pixel). */
  feather: number;
  /** How much of the softened edge is drawn in (0-1): 0 feathers about the edge; more pulls the edge inside the figure. */
  erode: number;
}

/** A soft shadow on the floor under a card: an ellipse at its feet, in the original's pixels. */
export interface CardShadow {
  width: number;
  height: number;
  /** How dark its middle is (0-1). */
  opacity: number;
  /** Moves it right (+) or left of the card's place: where the feet are in its frame. */
  dx?: number;
  /** Moves it down (+) or up from the card's place: the frame's foot is below the feet by however much the frame leaves under them. */
  dy?: number;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The uniforms a card's look draws with: the cell it shows (so the edge's samples stay in its own frame) and the strip's texel size. */
export interface LookUniforms {
  uCell: { value: [number, number, number, number] };
  uTexel: { value: [number, number] };
}

/**
 * Sets the look on a card's material, and answers the uniforms to keep up to date as its frame changes (`setCell`). The material's map is the
 * card's strip; its frame is the map's offset and repeat.
 */
export function applyLook(material: MeshBasicMaterial, look: CardLook): LookUniforms {
  const uniforms: LookUniforms & Record<string, { value: unknown }> = {
    uCell: { value: [0, 0, 1, 1] },
    uTexel: { value: [1 / 1024, 1 / 1024] },
    uLift: { value: look.lift.map(toLinear) },
    uGain: { value: [...look.gain] },
    uSat: { value: look.saturation },
    uFeather: { value: look.feather },
    uErode: { value: look.erode },
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `uniform vec4 uCell;
uniform vec2 uTexel;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uSat;
uniform float uFeather;
uniform float uErode;
void main() {`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  // (the edge: the alpha averaged over a ring round the texel, staying inside the frame's own cell, then drawn in by uErode)
  vec2 lo = uCell.xy + 0.5 * uTexel;
  vec2 hi = uCell.zw - 0.5 * uTexel;
  float edge = 2.0 * sampledDiffuseColor.a;
  for ( int i = 0; i < 8; i ++ ) {
    float t = float( i ) * 0.7853982;
    vec2 at = clamp( vMapUv + uFeather * uTexel * vec2( cos( t ), sin( t ) ), lo, hi );
    edge += texture2D( map, at ).a;
  }
  edge /= 10.0;
  float alpha = smoothstep( uErode, 1.0, edge );
  // (the colours: toward grey by uSat, the blacks lifted to uLift, the room's light by uGain; in linear colour)
  vec3 c = sampledDiffuseColor.rgb;
  float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c = mix( vec3( luma ), c, uSat );
  c = uLift + ( vec3( 1.0 ) - uLift ) * c;
  c *= uGain;
  diffuseColor *= vec4( c, alpha );
#endif`);
  };
  material.customProgramCacheKey = () => 'au-card-look';
  material.needsUpdate = true;
  return uniforms;
}

/** Keeps a look's uniforms on the frame the map shows now: its cell (from the map's offset and repeat) and its texel size. */
export function setCell(u: LookUniforms, map: Texture): void {
  u.uCell.value = [map.offset.x, map.offset.y, map.offset.x + map.repeat.x, map.offset.y + map.repeat.y];
  const img = map.image as { width?: number; height?: number } | undefined;
  u.uTexel.value = [1 / Math.max(1, img?.width ?? 1024), 1 / Math.max(1, img?.height ?? 1024)];
}

let shadowTexture: DataTexture | null = null;
/** A soft round shadow, black with its alpha falling off from the middle; one, shared by every shadow. */
function softDisc(): DataTexture {
  if (shadowTexture) return shadowTexture;
  const n = 64;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      // (a smooth fall-off to nothing at the rim)
      const a = (1 - r * r) ** 2;
      data[(y * n + x) * 4 + 3] = Math.round(a * 255);
    }
  }
  shadowTexture = new DataTexture(data, n, n, RGBAFormat);
  shadowTexture.magFilter = LinearFilter;
  shadowTexture.minFilter = LinearFilter;
  shadowTexture.needsUpdate = true;
  return shadowTexture;
}

/** A card's shadow, as a quad at its feet (the plate's pixels: x right, y down, as the cards are placed). */
export function shadowMesh(shadow: CardShadow, at: [number, number], scale = 1): Mesh<PlaneGeometry, MeshBasicMaterial> {
  const mesh = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: 0x000000, map: softDisc(), transparent: true, opacity: shadow.opacity, depthTest: false, depthWrite: false }));
  placeShadow(mesh, shadow, at, scale);
  return mesh;
}

export function placeShadow(mesh: Mesh, shadow: CardShadow, at: [number, number], scale = 1): void {
  mesh.scale.set(shadow.width * scale, shadow.height * scale, 1);
  mesh.position.set(at[0] + (shadow.dx ?? 0) * scale, -(at[1] + (shadow.dy ?? 0) * scale), 0);
}
