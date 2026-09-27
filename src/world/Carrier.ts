import * as THREE from 'three';

/** Deck dimensions, metres. Roughly Nimitz-class proportions. */
export const DECK_LENGTH = 330;
export const DECK_HALF_WIDTH = 39;
export const DECK_HEIGHT = 20;

/**
 * The angled landing area: centre, half-extents and cant, all in ship space.
 * Painted onto the deck rather than laid on it as a separate plate.
 */
const ANGLED = { x: -16, z: 30, halfWidth: 13, halfLength: 105, yaw: -0.16 };

/**
 * Texture resolution for the deck, pixels per metre.
 *
 * The deck is 78 x 330 m, so this is a 780 x 3300 canvas. Enough that a 0.9 m
 * painted line is nine pixels across and still reads as a line from the
 * cockpit before takeoff, which is the closest anyone gets to it.
 */
const DECK_PX_PER_M = 10;

/** Is a point on the deck inside the angled landing area? */
function onAngledDeck(x: number, z: number, margin = 0): boolean {
  const dx = x - ANGLED.x;
  const dz = z - ANGLED.z;
  // Into the angled deck's own frame: undo its yaw.
  const c = Math.cos(-ANGLED.yaw);
  const sn = Math.sin(-ANGLED.yaw);
  return Math.abs(dx * c + dz * sn) <= ANGLED.halfWidth + margin
    && Math.abs(-dx * sn + dz * c) <= ANGLED.halfLength + margin;
}

/** Where the ship sits in the Pacific world. Axis-aligned, bow toward −Z. */
export const CARRIER_X = 9000;
export const CARRIER_Z = 7000;

/**
 * Height of the flight deck at a world position, or −Infinity clear of the ship.
 *
 * The flight model takes its ground height from this combined with the terrain,
 * so the deck is simply *ground that happens to be 20 m above the sea* — takeoff,
 * rollout, gear contact and crash detection all work unchanged. Keeping the ship
 * axis-aligned means this stays an exact rectangle test rather than a transform.
 */
export function carrierDeckHeight(x: number, z: number): number {
  const dx = x - CARRIER_X;
  const dz = z - CARRIER_Z;
  if (Math.abs(dx) > DECK_HALF_WIDTH || Math.abs(dz) > DECK_LENGTH / 2) return -Infinity;
  return DECK_HEIGHT;
}

/** Spawn point on the deck: aft end, pointing down the angled deck toward the bow. */
export const CARRIER_SPAWN = {
  x: CARRIER_X,
  z: CARRIER_Z + DECK_LENGTH / 2 - 26,
  heading: 0, // 0 = north = −Z = toward the bow
};

/**
 * A simplified but recognisable carrier: hull, flight deck, starboard island and
 * deck markings. Built from primitives for the same reason the aircraft is — it
 * keeps the whole build self-contained with no external model files.
 */
export function buildCarrier(): THREE.Group {
  const group = new THREE.Group();
  group.position.set(CARRIER_X, 0, CARRIER_Z);

  const hullMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.75, metalness: 0.35 });
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.95 });
  const islandMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.7, metalness: 0.3 });

  // Hull: a slab below the waterline plus a tapered forward section.
  //
  // Its top is buried a metre inside the deck slab rather than flush with it.
  // At `DECK_HEIGHT - 13` the hull's top face landed at exactly 20.000 — the
  // same plane as the flight deck's own top face, over 58 x 304 m of it. Two
  // opaque upward faces at identical depth fight for the whole middle of the
  // deck, which is what was flashing before takeoff: parked, you look down the
  // deck almost edge-on, and that is where coplanar surfaces are worst.
  const hull = new THREE.Mesh(new THREE.BoxGeometry(58, 26, DECK_LENGTH - 26), hullMat);
  hull.position.y = DECK_HEIGHT - 14;
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  const bow = new THREE.Mesh(new THREE.ConeGeometry(29, 60, 4), hullMat);
  bow.rotation.x = -Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.scale.set(1, 1, 0.45);
  bow.position.set(0, DECK_HEIGHT - 14, -DECK_LENGTH / 2 - 4);
  group.add(bow);

  // Flight deck.
  //
  // One surface, with every marking painted into its texture.
  //
  // This used to be six stacked plates — the deck, the angled landing area laid
  // over it, and the paint laid over that — and their spacing had drifted to
  // 5 mm in one place. That is invisible from the air and awful on the ground:
  // parked before takeoff the chase camera sits about 6 m up looking down 330 m
  // of deck, very nearly edge-on, and at that angle the depth difference
  // between two almost-coplanar plates projects to almost nothing along the
  // view ray. `polygonOffset`, the usual remedy for decals, is unavailable —
  // the renderer runs a logarithmic depth buffer, so fragments write
  // gl_FragDepth and polygon offset does not apply to a shader-written depth.
  //
  // Rather than keep tuning millimetres, the stack is gone. A single plate
  // cannot fight itself, so the whole class of defect is unreachable — and it
  // is five fewer draw calls. The top face gets the painted material and the
  // sides keep the plain one, via the per-face material list BoxGeometry
  // already supports (group 2 is +Y).
  const deckTop = new THREE.MeshStandardMaterial({
    map: makeDeckTexture(), roughness: 0.95,
  });
  const deck = new THREE.Mesh(
    new THREE.BoxGeometry(DECK_HALF_WIDTH * 2, 2.2, DECK_LENGTH),
    [deckMat, deckMat, deckTop, deckMat, deckMat, deckMat],
  );
  deck.position.y = DECK_HEIGHT - 1.1;
  deck.receiveShadow = true;
  deck.castShadow = true;
  group.add(deck);

  // Starboard island.
  const island = new THREE.Mesh(new THREE.BoxGeometry(11, 22, 46), islandMat);
  island.position.set(DECK_HALF_WIDTH - 7, DECK_HEIGHT + 11, 14);
  island.castShadow = true;
  group.add(island);

  const bridge = new THREE.Mesh(new THREE.BoxGeometry(13, 5, 20), islandMat);
  bridge.position.set(DECK_HALF_WIDTH - 7, DECK_HEIGHT + 20, 6);
  bridge.castShadow = true;
  group.add(bridge);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 26, 8), islandMat);
  mast.position.set(DECK_HALF_WIDTH - 7, DECK_HEIGHT + 35, 16);
  mast.castShadow = true;
  group.add(mast);

  return group;
}

/**
 * The flight deck's markings, drawn once into a canvas.
 *
 * Ship space maps straight onto the canvas: x = −39..39 across, z = −165..165
 * along. A yaw of ψ about Y sends the local +X axis to (cos ψ, −sin ψ) in the
 * (x, z) plane, while a canvas rotation of θ sends it to (cos θ, sin θ) — so
 * the canvas angle is the negation of the ship's.
 */
function makeDeckTexture(): THREE.CanvasTexture {
  const width = Math.round(DECK_HALF_WIDTH * 2 * DECK_PX_PER_M);
  const height = Math.round(DECK_LENGTH * DECK_PX_PER_M);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Carrier: could not create a 2D context for the deck');

  const toX = (x: number): number => (x + DECK_HALF_WIDTH) * DECK_PX_PER_M;
  const toY = (z: number): number => (z + DECK_LENGTH / 2) * DECK_PX_PER_M;
  const rect = (
    cx: number, cz: number, w: number, l: number, yaw: number, fill: string,
  ): void => {
    ctx.save();
    ctx.translate(toX(cx), toY(cz));
    ctx.rotate(-yaw);
    ctx.fillStyle = fill;
    ctx.fillRect(
      -w * DECK_PX_PER_M / 2, -l * DECK_PX_PER_M / 2,
      w * DECK_PX_PER_M, l * DECK_PX_PER_M,
    );
    ctx.restore();
  };

  ctx.fillStyle = '#2b2e33';
  ctx.fillRect(0, 0, width, height);

  // The landing area reads as a slightly different wear pattern, not a step.
  rect(ANGLED.x, ANGLED.z, ANGLED.halfWidth * 2, ANGLED.halfLength * 2, ANGLED.yaw, '#25282d');

  // Axial centreline, interrupted where the landing area crosses it.
  for (let z = -DECK_LENGTH / 2 + 24; z < DECK_LENGTH / 2 - 24; z += 26) {
    if (onAngledDeck(6, z, 7)) continue;
    rect(6, z, 0.9, 12, 0, '#d8dde2');
  }

  // Landing-area centreline and the arrestor wires across it.
  rect(ANGLED.x, ANGLED.z, 0.9, 190, ANGLED.yaw, '#c8a83a');
  for (let i = 0; i < 4; i++) {
    rect(ANGLED.x, 82 + i * 14, 24, 0.4, ANGLED.yaw, '#d8dde2');
  }

  // Deck edge stripe, so the drop is legible on the roll-out.
  rect(-DECK_HALF_WIDTH + 1.2, 0, 0.5, DECK_LENGTH - 30, 0, '#8d949c');
  rect(DECK_HALF_WIDTH - 1.2, 0, 0.5, DECK_LENGTH - 30, 0, '#8d949c');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // The deck is seen at a grazing angle down its whole length before takeoff,
  // where a pixel's footprint is stretched far along the view direction.
  texture.anisotropy = 16;
  return texture;
}
