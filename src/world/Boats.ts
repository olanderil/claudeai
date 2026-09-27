import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SEA_LEVEL } from './Sea';

/**
 * Shipping: sailing boats near the coast and cargo ships out in the deep.
 *
 * An empty ocean reads as a texture rather than as a place. One ship on it and
 * the same water suddenly has a scale — you can see how far away the horizon
 * is, and how fast you are going over it, which a flat blue plane never tells
 * you however good its normal map is.
 *
 * They are placed the way the villages and the pyramids are: a jittered cell
 * grid seeded from the world, so a given seed always puts the same boat in the
 * same place, and nothing has to be stored or streamed. Each kind gets its own
 * grid, because they want opposite things — sailing boats want the coast in
 * sight, cargo ships want open water — and one grid asked to produce both ends
 * up with the density of neither.
 */

export type BoatKind = 'sail' | 'cargo';

export interface Boat {
  x: number;
  z: number;
  /** Heading, radians. */
  angle: number;
  kind: BoatKind;
  /** Multiplier on the kind's nominal size. */
  size: number;
}

export interface BoatOptions {
  /** Worlds with no sea get none of this. */
  enabled: boolean;
  /**
   * Whether sailing boats belong here.
   *
   * The Antarctic gets cargo ships and no yachts: a fibreglass sloop among the
   * ice is the one thing on this ocean that would look like a mistake.
   */
  sail: boolean;
  seed: number;
  /** Keep this clear of the origin — the runway, or the carrier's water. */
  exclusion: number;
}

/**
 * How much bigger than life the boats are drawn.
 *
 * At true size they were correct and nearly invisible: a 190 m ship seen from
 * a mile up through haze is a few pixels, and an 11 m yacht is less than one.
 * This is a deliberate lie in favour of being able to see them at all — the
 * same kind of lie the pyramids and the cities already tell — and it is applied
 * here rather than in the geometry so the shapes below stay in real metres and
 * the draught check has something honest to measure.
 *
 * It does put the freighters past the length of any ship afloat. That is the
 * trade: on this ocean, at these speeds, a realistic hull reads as nothing.
 */
const EXAGGERATION = 2;

/** How far out boats are placed, metres. Beyond this the haze has them anyway. */
const REACH = 62_000;
/** Cell size per kind. Cargo ships are rarer and much bigger. */
const SAIL_CELL = 5200;
const CARGO_CELL = 12_500;
/** Chance a cell offers a boat at all, before the water is even looked at. */
const SAIL_CHANCE = 0.34;
const CARGO_CHANCE = 0.5;

/**
 * Depth limits, metres.
 *
 * The floor keeps hulls off the beach: a boat aground on a sandbar is worse
 * than no boat at all.
 *
 * There is deliberately no ceiling on the sailing boats. There was one, at
 * 140 m, standing in for "coastal" — and measuring the actual seabeds showed
 * how badly that misread them: most of these worlds have a flat floor at one
 * depth, 328 m under the Isles, 320 in the Fjords, 275 off Iceland, so the
 * ceiling was quietly excluding yachts from four whole oceans. Proximity to
 * land is the thing that actually makes a boat coastal, and the sight test
 * below already measures exactly that.
 *
 * The freighters' floor is low for the same reason, found the same way: the
 * island city's deepest water is 40 m, so a 45 m minimum gave it no shipping
 * whatsoever.
 */
const SAIL_MIN_DEPTH = 4;
const CARGO_MIN_DEPTH = 24;

/** How far around a site the water has to stay water. */
const SAIL_CLEAR = 260;
const CARGO_CLEAR = 900;
/** A sailing boat has to be able to see the coast; this is how far it looks. */
const SAIL_SIGHT = 7000;

const PROBE: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** Eight bearings for the shore test, so a coast is not missed for being diagonal. */
const SIGHT: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707],
];

let fleet: Boat[] = [];

export function boats(): Boat[] {
  return fleet;
}

/** The scale the hulls are actually drawn at, for anything that measures them. */
export function boatScale(): number {
  return EXAGGERATION;
}

/** Deterministic value in [0, 1) for a cell, matching the other scatterers. */
function cellRandom(x: number, y: number, salt: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Choose where the shipping is, for the current world and seed.
 *
 * `sample` is the height field: negative is under water, and how far under is
 * what decides which kind of boat — if any — a place can hold.
 */
export function planBoats(
  sample: (x: number, z: number) => number,
  opts: BoatOptions,
): void {
  fleet = [];
  if (!opts.enabled) return;

  const salt = (opts.seed | 0) * 24;
  const depthAt = (x: number, z: number): number => SEA_LEVEL - sample(x, z);

  const scatter = (
    cell: number,
    chance: number,
    kind: BoatKind,
    saltBase: number,
    keep: (x: number, z: number, depth: number) => boolean,
  ): void => {
    const span = Math.ceil(REACH / cell);
    for (let gx = -span; gx <= span; gx++) {
      for (let gz = -span; gz <= span; gz++) {
        if (cellRandom(gx, gz, saltBase + 1) > chance) continue;

        // Jittered well inside the cell, so two neighbouring boats cannot end
        // up alongside each other on the shared edge.
        const x = (gx + (cellRandom(gx, gz, saltBase + 2) - 0.5) * 0.8) * cell;
        const z = (gz + (cellRandom(gx, gz, saltBase + 3) - 0.5) * 0.8) * cell;
        if (Math.hypot(x, z) < opts.exclusion) continue;
        if (Math.hypot(x, z) > REACH) continue;

        const depth = depthAt(x, z);
        if (!keep(x, z, depth)) continue;

        fleet.push({
          x,
          z,
          angle: cellRandom(gx, gz, saltBase + 4) * Math.PI * 2,
          kind,
          size: 0.8 + cellRandom(gx, gz, saltBase + 5) * 0.45,
        });
      }
    }
  };

  if (opts.sail) {
    scatter(SAIL_CELL, SAIL_CHANCE, 'sail', salt + 100, (x, z, depth) => {
      if (depth < SAIL_MIN_DEPTH) return false;
      // Clear water immediately around, or it is sitting on a rock.
      for (const [dx, dz] of PROBE) {
        if (depthAt(x + dx * SAIL_CLEAR, z + dz * SAIL_CLEAR) < 2) return false;
      }
      // And land somewhere in sight, or it is a yacht in the middle of an
      // ocean, which is a different and much lonelier picture.
      for (const [dx, dz] of SIGHT) {
        if (depthAt(x + dx * SAIL_SIGHT, z + dz * SAIL_SIGHT) <= 0) return true;
      }
      return false;
    });
  }

  scatter(CARGO_CELL, CARGO_CHANCE, 'cargo', salt + 200, (x, z, depth) => {
    if (depth < CARGO_MIN_DEPTH) return false;
    // A wide berth of deep water: a 200 m ship needs room, and the eye reads a
    // freighter tucked into a bay as a mistake even when the depth is fine.
    for (const [dx, dz] of PROBE) {
      if (depthAt(x + dx * CARGO_CLEAR, z + dz * CARGO_CLEAR) < CARGO_MIN_DEPTH * 0.5) {
        return false;
      }
    }
    return true;
  });
}

/** A box, positioned and coloured, ready to be merged into one hull. */
function part(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  colour: THREE.Color,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  const n = geo.attributes.position.count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  // Flattened to match the sails, which are built face by face and have no
  // index. `mergeGeometries` will not mix the two — it returns null rather
  // than throwing, so the first sign of getting this wrong is a mesh with no
  // geometry at all rather than an error saying so.
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/**
 * A thin triangular slab, for a sail.
 *
 * Sails were boxes to begin with, because everything else here is and boxes
 * merge without thinking about it. Seen from alongside they were white
 * rectangles standing on a hull, which is not what a sailing boat looks like
 * from any distance — the triangle *is* the silhouette, and it is the only
 * part of this shape anyone will recognise from a mile up.
 *
 * `outline` is the sail in the fore-and-aft plane as (z, y) metres; the slab is
 * given a little thickness so it does not vanish when seen exactly edge-on.
 */
function sailcloth(
  outline: [number, number][],
  thickness: number,
  colour: THREE.Color,
): THREE.BufferGeometry {
  const half = thickness / 2;
  const tri: number[] = [];
  const push = (x: number, p: [number, number]): void => {
    tri.push(x, p[1], p[0]);
  };
  const [a, b, c] = outline;
  // The two faces, wound opposite ways so both point outward.
  push(half, a); push(half, b); push(half, c);
  push(-half, a); push(-half, c); push(-half, b);
  // And the three edges between them.
  for (const [p, q] of [[a, b], [b, c], [c, a]] as [[number, number], [number, number]][]) {
    push(half, p); push(-half, p); push(half, q);
    push(half, q); push(-half, p); push(-half, q);
  }

  const geo = new THREE.BufferGeometry();
  const position = new Float32Array(tri);
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  const n = position.length / 3;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  // Merging needs every geometry to carry the same attributes, and the boxes
  // this is merged with bring UVs whether anything reads them or not.
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  // Not indexed, so this gives each face its own normal — which is what a sail
  // wants anyway: the two sides should catch the light differently.
  geo.computeVertexNormals();
  return geo;
}

/**
 * One boat, as a single geometry.
 *
 * Every boat is a handful of boxes merged into one mesh and coloured per
 * vertex, which is what keeps the whole fleet down to two draw calls: the
 * alternative — a mesh per part — multiplies by however many parts a boat has,
 * for shapes that are a few pixels across most of the time they are on screen.
 *
 * Sizes are in metres and the waterline is y = 0, because the sea is a flat
 * plane at exactly that height and a hull that floats has to agree with it.
 */
function cargoGeometry(): THREE.BufferGeometry {
  const hull = new THREE.Color(0.34, 0.11, 0.09); // oxide red, above the boot top
  const deck = new THREE.Color(0.22, 0.24, 0.26);
  const house = new THREE.Color(0.86, 0.86, 0.84);
  const funnel = new THREE.Color(0.15, 0.15, 0.17);
  const boxes = [
    new THREE.Color(0.55, 0.16, 0.14),
    new THREE.Color(0.16, 0.34, 0.50),
    new THREE.Color(0.62, 0.52, 0.16),
    new THREE.Color(0.20, 0.42, 0.26),
  ];

  const parts = [
    // Hull. Sitting a little into the water so there is no gap at the waterline
    // when the sea's normal map lifts a wave against it.
    part(26, 15, 190, 0, 1.5, 0, hull),
    // The bow, narrowed and carried forward — enough to break the slab.
    part(14, 15, 26, 0, 1.5, -104, hull),
    part(24, 1.6, 150, 0, 9.4, -8, deck),
    // Containers, four rows of two, which is what makes it read as a container
    // ship rather than as a barge from a mile up.
    ...boxes.flatMap((c, i) => [
      part(8.4, 7.6, 30, -5.6, 13.6, -60 + i * 34, c),
      part(8.4, 7.6, 30, 5.6, 13.6, -60 + i * 34, boxes[(i + 2) % boxes.length]),
    ]),
    part(18, 13, 22, 0, 16, 72, house),
    part(5, 9, 6, 0, 26, 80, funnel),
  ];
  return mergeGeometries(parts, false);
}

function sailGeometry(): THREE.BufferGeometry {
  const hull = new THREE.Color(0.92, 0.92, 0.90);
  const stripe = new THREE.Color(0.12, 0.20, 0.34);
  const canvas = new THREE.Color(0.97, 0.96, 0.93);

  const parts = [
    part(3.4, 1.5, 11, 0, 0.25, 0, hull),
    part(2.6, 1.4, 4.4, 0, 0.3, -4.4, hull),
    part(3.5, 0.35, 11.2, 0, 1.0, 0, stripe),
    // Mast and boom.
    part(0.3, 13, 0.3, 0, 7.4, -0.6, hull),
    part(0.25, 0.25, 6.4, 0, 1.6, 1.8, hull),
    // The mainsail: luff up the mast, foot along the boom, head at the top.
    sailcloth([[-0.5, 1.5], [4.6, 1.5], [-0.5, 12.6]], 0.2, canvas),
    // And a jib forward of it. Between them these two triangles are most of
    // what makes the silhouette read as a sailing boat rather than a stick.
    sailcloth([[-1.0, 1.4], [-5.0, 1.0], [-1.0, 9.6]], 0.18, canvas),
  ];
  return mergeGeometries(parts, false);
}

/**
 * Build the planned fleet into one group.
 *
 * Instanced per kind, and not frustum-culled: a single mesh covers the whole
 * map, so its bounding sphere is the map and the test can only ever say yes —
 * paying for it every frame is the same deal the settlements take.
 */
export function buildBoatMeshes(): THREE.Group {
  const group = new THREE.Group();
  if (fleet.length === 0) return group;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.05,
  });

  const dummy = new THREE.Object3D();
  for (const [kind, geo] of [
    ['cargo', cargoGeometry()],
    ['sail', sailGeometry()],
  ] as [BoatKind, THREE.BufferGeometry][]) {
    const of = fleet.filter((b) => b.kind === kind);
    if (of.length === 0) {
      geo.dispose();
      continue;
    }
    const mesh = new THREE.InstancedMesh(geo, material, of.length);
    mesh.castShadow = true;
    mesh.receiveShadow = false; // a hull at sea has nothing above it to be shadowed by
    mesh.frustumCulled = false;
    of.forEach((b, i) => {
      dummy.position.set(b.x, SEA_LEVEL, b.z);
      dummy.rotation.set(0, b.angle, 0);
      dummy.scale.setScalar(b.size * EXAGGERATION);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
  }

  return group;
}

export function disposeBoatMeshes(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
  group.clear();
}
