// SPDX-License-Identifier: GPL-3.0-or-later
import { DoubleSide, HemisphereLight, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, type Camera, PlaneGeometry, Scene, Vector3 } from 'three';
import { disposeRoomArt, noArt, type ArtLoaders, type CardArt } from './art';

/** A rectangle of the drawing buffer, in pixels: x from the left, y from the bottom (what the viewport takes). */
export interface Viewport { x: number; y: number; width: number; height: number }

/** A ship station's set (R4): its glTF, the camera it is seen from, and its named nodes. */
export interface ShipSet {
  scene: Scene;
  /** A perspective camera for a set; the orthographic one of a plate (R14). */
  camera: Camera;
  node(name: string): Object3D | undefined;
  update(dt: number): void;
  /** The objects that have a crew card on this set. */
  cards(): string[];
  card(object: string): Mesh | undefined;
  /** Shows the cards `shown` says yes to and hides the rest. */
  showCards(shown: (object: string) => boolean): void;
  dispose(): void;
}

/** What `art.cards` calls a ship set's card for an object: the bridge's crew are `bridge.<object>`. */
export type ShipCards = (object: string) => CardArt | undefined;
/** The original's screens are 480 pixels high: a card is sized in these. */
const SCREEN_HEIGHT = 480;

/** The original's screens are 4:3. */
const ASPECT = 4 / 3;

/**
 * The box's client rect in drawing-buffer pixels: x from the left, y from the bottom, rounded as CSS does (each edge
 * is rounded, so the box is as wide as the page paints it).
 */
export function screenViewport(box: DOMRect, canvas: DOMRect, dpr: number): Viewport {
  const edge = (v: number): number => Math.round(v * dpr);
  const left = edge(box.left - canvas.left);
  const right = edge(box.right - canvas.left);
  const top = edge(box.top - canvas.top);
  const bottom = edge(box.bottom - canvas.top);
  return { x: left, y: edge(canvas.height) - bottom, width: right - left, height: bottom - top };
}

/**
 * A perspective camera whose principal point sits `shiftY` pixels (of `height`) above the middle of the picture. glTF has
 * no lens shift, so the set's camera carries it in its extras and it is put back here: the projection's [9] is the
 * frustum's off-centre term, and the axis lands at -[9] in normalized device coordinates.
 */
export function shiftedCamera(fovY: number, shiftY: number, height: number): PerspectiveCamera {
  const camera = new PerspectiveCamera((fovY * 180) / Math.PI, ASPECT, 0.05, 200);
  const update = camera.updateProjectionMatrix.bind(camera);
  camera.updateProjectionMatrix = () => {
    update();
    camera.projectionMatrix.elements[9] = (-2 * shiftY) / height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  };
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * A node by its glTF name. GLTFLoader strips the characters three's animation paths reserve (. : / [ ]) from Object3D.name,
 * so "camera:main" arrives as "cameramain" and keeps its own spelling in userData.name.
 */
function byName(root: Object3D, name: string): Object3D | undefined {
  let found: Object3D | undefined;
  root.traverse(o => {
    if (!found && (o.userData.name === name || o.name === name)) found = o;
  });
  return found;
}

function findCamera(root: Object3D, name: string): { node: Object3D; camera: PerspectiveCamera | null } | undefined {
  const node = byName(root, name);
  if (!node) return undefined;
  let camera: PerspectiveCamera | null = null;
  node.traverse(o => { if (!camera && (o as PerspectiveCamera).isPerspectiveCamera) camera = o as PerspectiveCamera; });
  return { node, camera };
}

/**
 * A card of the original's frame standing on a `card:<object>` anchor: a plane square to the camera (the camera never moves, so
 * it faces it exactly), as many original pixels high as the frame is, at the anchor's depth, so it draws at the size and place
 * the original draws the sprite (the anchor's feet land on the sprite's feet).
 */
async function makeCard(anchor: Object3D, camera: PerspectiveCamera, fovY: number, art: CardArt, loaders: ArtLoaders): Promise<Mesh | null> {
  const texture = await loaders.texture(art.url, true);
  const img = texture.image as { width?: number; height?: number } | undefined;
  if (!img?.width || !img.height) return null;
  const framePx = { w: img.width / art.frames, h: img.height };
  const heightPx = art.pixelHeight ?? framePx.h;
  const widthPx = (heightPx * framePx.w) / framePx.h;
  const feet = new Vector3().setFromMatrixPosition(anchor.matrixWorld);
  const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const depth = feet.clone().sub(camera.position).dot(forward);
  if (depth <= 0) return null;
  // (a pixel at this depth, in metres)
  const metres = (depth * 2 * Math.tan(fovY / 2)) / SCREEN_HEIGHT;
  // (the original lays its sprites over the background, whatever the room's shapes are: they stand at the screen position
  // they were drawn at, so they aren't hidden by the set. Among themselves, a larger y_adjust (= -depth) draws later.)
  const material = new MeshBasicMaterial({ map: texture, transparent: true, alphaTest: 0.05, side: DoubleSide, depthTest: false, depthWrite: false });
  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.renderOrder = 1000 - (Number(anchor.userData.depth) || 0);
  mesh.name = `card:${anchor.userData.object as string}`;
  mesh.scale.set(widthPx * metres, heightPx * metres, 1);
  mesh.quaternion.copy(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  // (the plane is centred: lift it half its height so its bottom edge is the feet, then shift it by the card's own anchor)
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  mesh.position.copy(feet).addScaledVector(up, (heightPx * metres) / 2).addScaledVector(right, (0.5 - art.anchor[0]) * widthPx * metres);
  mesh.userData = { object: anchor.userData.object, depth: anchor.userData.depth };
  return mesh;
}

/**
 * Loads a set's glTF and takes its camera (by node name, with its lens-shift extras) and lights. Rejects if the glb has no such camera.
 * `cards` (the crew's art, by `bridge.<object>`) stands a card on each `card:<object>` anchor that has art; an anchor with none stays bare.
 */
export async function loadShipSet(url: string, cameraName: string, loaders: ArtLoaders, cards?: ShipCards): Promise<ShipSet> {
  const model = await loaders.model(url);
  const found = findCamera(model, cameraName);
  if (!found) throw new Error(`${url} has no camera called ${cameraName}`);
  model.updateMatrixWorld(true);
  const extras = { ...(found.camera?.userData ?? {}), ...found.node.userData } as { shiftY?: number; fovY?: number; height?: number };
  const fovY = extras.fovY ?? (found.camera ? (found.camera.fov * Math.PI) / 180 : 1);
  const camera = shiftedCamera(fovY, extras.shiftY ?? 0, extras.height ?? 480);
  // (the camera's pose is its node's in the world)
  (found.camera ?? found.node).matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
  camera.scale.set(1, 1, 1);
  camera.updateMatrixWorld(true);
  const scene = new Scene();
  scene.add(model);
  // (the glb's own lights do the lighting, R6; this keeps the shadows from going black)
  scene.add(new HemisphereLight(0xffffff, 0x404050, 0.25));
  // (an item's proxy box is only there for the alignment check, Blender hides it from its renders: it isn't drawn here either)
  model.traverse(o => { if (o.userData.proxy === true) o.visible = false; });
  const crew = new Map<string, Mesh>();
  if (cards) {
    const anchors: Object3D[] = [];
    model.traverse(o => {
      if (typeof o.userData.name === 'string' && o.userData.name.startsWith('card:') && typeof o.userData.object === 'string') anchors.push(o);
    });
    await Promise.all(anchors.map(async anchor => {
      const art = cards(`bridge.${anchor.userData.object as string}`);
      if (!art) return;
      const mesh = await makeCard(anchor, camera, fovY, art, loaders).catch(() => null);
      if (!mesh) return;
      scene.add(mesh);
      crew.set(anchor.userData.object as string, mesh);
    }));
  }
  return {
    scene,
    camera,
    node: name => byName(scene, name),
    update: () => {},
    cards: () => [...crew.keys()],
    card: object => crew.get(object),
    showCards: shown => { for (const [object, mesh] of crew) mesh.visible = shown(object); },
    dispose: () => {
      for (const mesh of crew.values()) {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicMaterial).map?.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
      }
      disposeRoomArt({ ...noArt(), model: scene });
    },
  };
}
