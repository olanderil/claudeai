import * as THREE from 'three';

/**
 * Built landmarks that are neither terrain nor settlement — currently the
 * pyramid groups in the sand sea.
 *
 * A pyramid is the one thing here that must be *sharp*. The height field is
 * sampled at whatever spacing the terrain LOD happens to be using, so a pyramid
 * expressed only as terrain rounds off into a lump as soon as you are a couple
 * of kilometres away, which is exactly when its silhouette matters most. So it
 * exists twice: as a mesh, which is crisp at any distance and costs one draw
 * call for the whole map, and in the height field, so you can fly into it.
 *
 * Planning happens in *world* coordinates, like the villages, rather than in the
 * seeded noise domain — that is what lets the mesh and the collision surface be
 * generated from one shared list instead of two functions that have to agree.
 */

export interface Pyramid {
  x: number;
  z: number;
  /** Half the base width, metres. */
  half: number;
  height: number;
  /** Ground elevation the base sits on. */
  base: number;
  /** Yaw, radians. */
  angle: number;
}

export interface PyramidOptions {
  enabled: boolean;
  seed: number;
  /** Ground outside this band is sea, marsh or mountain — nothing gets built. */
  minElevation: number;
  maxElevation: number;
  exclusion: number;
}

/** Spacing of the placement grid, metres. Groups are rare and far apart. */
const CELL = 16000;
const SPAN = 4;
/**
 * How far a pyramid's base is sunk below the lowest ground under it.
 *
 * The solid sits at one elevation while the sand under it does not, so without
 * a skirt the uphill corner is buried and the downhill one hangs in the air.
 * Anchoring to the lowest corner and burying that fixes the second case; this
 * covers the first.
 */
const FOOTING = 14;
/** Bound on any pyramid's footprint, for the hash grid. */
const REACH = 900;
const BUCKET = 1024;

let sites: Pyramid[] = [];
let index = new Map<number, Pyramid[]>();

export function pyramids(): Pyramid[] {
  return sites;
}

function cellRandom(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function bucketKey(x: number, z: number): number {
  const gx = Math.floor(x / BUCKET);
  const gz = Math.floor(z / BUCKET);
  return ((gx & 0xffff) << 16) | (gz & 0xffff);
}

/**
 * Height of the pyramid surface here, or −Infinity clear of one.
 *
 * Combined into the terrain with a max, the same way the carrier deck is: the
 * flight model then treats a pyramid face as ordinary sloping ground and needs
 * no idea that pyramids exist.
 */
export function pyramidHeight(x: number, z: number): number {
  if (sites.length === 0) return -Infinity;
  const bucket = index.get(bucketKey(x, z));
  if (bucket === undefined) return -Infinity;

  let tallest = -Infinity;
  for (let i = 0; i < bucket.length; i++) {
    const p = bucket[i];
    const dx = x - p.x;
    const dz = z - p.z;
    if (Math.abs(dx) > p.half * 1.5 || Math.abs(dz) > p.half * 1.5) continue;

    const ca = Math.cos(p.angle);
    const sa = Math.sin(p.angle);
    const rx = Math.abs(dx * ca + dz * sa);
    const rz = Math.abs(-dx * sa + dz * ca);

    // Square base, straight faces: the surface is a function of the Chebyshev
    // distance from the axis, which is what makes the four ridges meet at a
    // point instead of rounding into a cone.
    const t = 1 - Math.max(rx, rz) / p.half;
    if (t <= 0) continue;
    const top = p.base + p.height * t;
    if (top > tallest) tallest = top;
  }
  return tallest;
}

/** Probes around a candidate site, to reject dunes and slopes. */
const PROBE: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function planPyramids(
  sample: (x: number, z: number) => number,
  opts: PyramidOptions,
): void {
  sites = [];
  index = new Map();
  if (!opts.enabled) return;

  const salt = (opts.seed | 0) * 16 + 3;

  for (let gx = -SPAN; gx <= SPAN; gx++) {
    for (let gz = -SPAN; gz <= SPAN; gz++) {
      if (cellRandom(gx, gz, salt + 1) > 0.55) continue;

      const cx = (gx + (cellRandom(gx, gz, salt + 2) - 0.5) * 0.7) * CELL;
      const cz = (gz + (cellRandom(gx, gz, salt + 3) - 0.5) * 0.7) * CELL;
      if (Math.hypot(cx, cz) < opts.exclusion) continue;

      const centre = sample(cx, cz);
      if (centre < opts.minElevation || centre > opts.maxElevation) continue;

      // A pyramid on a dune crest would look absurd, so demand a level plot —
      // but probed at the scale of the group's footprint. Probing at twice that
      // measures the dune train rather than the plot, and in a sand sea with 60 m
      // dunes it rejects nearly everywhere, leaving the nearest group 60 km out.
      let lo = centre;
      let hi = centre;
      for (const [ox, oz] of PROBE) {
        const h = sample(cx + ox * 260, cz + oz * 260);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      if (hi - lo > 46) continue;

      // Three of them on a diagonal, decreasing in size, as at Giza.
      const angle = cellRandom(gx, gz, salt + 4) * Math.PI * 2;
      const run = Math.cos(angle + Math.PI / 4);
      const rise = Math.sin(angle + Math.PI / 4);
      // Doubled. At 184 to 280 m across these were life size — the Great
      // Pyramid is 230 m — and life size is the wrong size here for the same
      // reason it was wrong for the shipping: from a mile up through desert
      // haze, a real pyramid is a smudge. These are 370 to 560 m across and
      // 240 to 360 m tall, which is what it takes for one to sit on the
      // horizon and pull you towards it.
      const biggest = 184 + cellRandom(gx, gz, salt + 5) * 96;

      for (let k = 0; k < 3; k++) {
        const half = biggest * (1 - k * 0.26);
        const step = k === 0 ? 0 : (biggest * 1.9 + half * 1.9) * 0.55 * k;
        const px = cx + run * step;
        const pz = cz + rise * step;

        // Anchor to the lowest ground under the footprint, not the centre — a
        // pyramid may be partly buried, but it must never hover.
        let base = sample(px, pz);
        for (const [ox, oz] of PROBE) {
          const h = sample(px + ox * half * 0.95, pz + oz * half * 0.95);
          if (h < base) base = h;
        }

        sites.push({
          x: px,
          z: pz,
          half,
          // The Great Pyramid is about 0.64 as tall as its base is wide.
          height: half * 2 * 0.64,
          base: base - FOOTING,
          angle,
        });
      }
    }
  }

  for (const p of sites) addToIndex(p);
}

function addToIndex(p: Pyramid): void {
  const gx0 = Math.floor((p.x - REACH) / BUCKET);
  const gx1 = Math.floor((p.x + REACH) / BUCKET);
  const gz0 = Math.floor((p.z - REACH) / BUCKET);
  const gz1 = Math.floor((p.z + REACH) / BUCKET);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
      const bucket = index.get(key);
      if (bucket) bucket.push(p);
      else index.set(key, [p]);
    }
  }
}

/**
 * A unit pyramid: 1 × 1 square base on y = 0, apex at y = 1.
 *
 * A four-sided cone has its base *vertices* on the axes, so it is a diamond
 * rather than a square; rotating it an eighth of a turn puts the edges on the
 * axes, and then the half-side is the radius over root two.
 */
function unitPyramid(): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
  geo.rotateY(Math.PI / 4);
  geo.translate(0, 0.5, 0);
  return geo;
}

/** Build every planned pyramid into one instanced mesh. */
export function buildPyramidMeshes(groundTone: [number, number, number]): THREE.Group {
  const group = new THREE.Group();
  if (sites.length === 0) return group;

  const tone = new THREE.Color().setRGB(...groundTone, THREE.LinearSRGBColorSpace);
  const mat = new THREE.MeshStandardMaterial({
    color: tone.clone().lerp(new THREE.Color(0.66, 0.60, 0.48), 0.55),
    roughness: 0.92,
    // Flat shading is the point: it gives four distinct faces meeting at hard
    // ridges, which is the whole silhouette.
    flatShading: true,
  });

  const mesh = new THREE.InstancedMesh(unitPyramid(), mat, sites.length);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  sites.forEach((p, i) => {
    dummy.position.set(p.x, p.base, p.z);
    dummy.rotation.set(0, p.angle, 0);
    // Slightly proud of the height-field copy, so the terrain that approximates
    // it at coarse LOD never pokes through the faces.
    dummy.scale.set(p.half * 2 * 1.02, p.height * 1.02, p.half * 2 * 1.02);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });

  group.add(mesh);
  return group;
}

export function disposePyramidMeshes(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}
