import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { behindLines } from './Front';

/**
 * Landmarks: things worth flying towards.
 *
 * A landscape can be beautiful and still give you no reason to go anywhere in
 * particular. What turns scenery into somewhere to explore is a silhouette on
 * the horizon that resolves into a thing — a light on a headland, a castle on
 * a hill, a fort crowning a ridge. You go and look, and on the way you
 * see the country in between.
 *
 * Each kind is placed by rules read off the height field, the way the boats
 * and the villages are: a jittered cell grid seeded from the world, so a seed
 * always puts the same castle on the same hill and nothing has to be streamed
 * or stored. The rules are the interesting part — a lighthouse wants a
 * promontory with sea on most sides, a monastery wants height and solitude —
 * and each is a handful of height samples.
 */

export type StructureKind = 'lighthouse' | 'castle' | 'monastery' | 'fort';

export interface Structure {
  x: number;
  z: number;
  /** Ground height it stands on, metres. */
  y: number;
  /** Facing, radians. */
  angle: number;
  kind: StructureKind;
  /**
   * Which design, for kinds that have more than one.
   *
   * Castles and abbeys carry two apiece. One design repeated across a world is
   * the difference between a landmark and a decal — you stop looking once you
   * have seen the first.
   */
  variant: number;
  size: number;
  /**
   * Which wind farm a turbine belongs to, or -1.
   *
   * Turbines in one row stand a few hundred metres apart on purpose, so the
   * spacing rule that keeps everything else away from everything else has to
   * know not to pull a farm apart.
   */
  farm: number;
}

export interface StructureOptions {
  enabled: boolean;
  /** No castles or abbeys where nobody has ever lived. */
  peopled: boolean;
  /** Worlds with no sea get no lighthouses and no offshore wind. */
  coastal: boolean;
  seed: number;
  /** Keep clear of wherever the flight begins. */
  exclusion: number;
  /**
   * The city, if this world has one: nothing is built inside it.
   *
   * A castle in the middle of a downtown is the one placement that looks like
   * a bug rather than a choice, and the city's own ground is laid in after
   * these are placed, so the height field gives no warning about it.
   */
  city: { x: number; z: number; radius: number } | null;
  /** Snow line, so nothing is built on a glacier. */
  snowLine: number;
  /**
   * The airfield's elevation, as the height this world calls "ground level".
   *
   * Every height rule here is relative to it. Absolute bands do not survive
   * contact with these worlds: a castle band of 40 to 1300 m is right for an
   * island and puts *nothing* in the Alps, whose valley floors start at
   * 1210 m — measured, that rule gave Alpine no castles at all.
   */
  field: number;
  /**
   * Per-world tuning, as a multiplier on each kind's chance. Zero removes a
   * kind entirely.
   *
   * The rules below are about ground — is it high, is it flat, is there sea
   * nearby — and ground is not the whole story. A canyon has plenty of flat
   * benches that satisfy everything a castle asks for, and a castle is still
   * the wrong thing to find in one. This is where a world says so, rather than
   * every rule growing a list of exceptions.
   */
  density: Partial<Record<StructureKind, number>>;
}

/**
 * How much larger than life these are drawn.
 *
 * A lighthouse is thirty metres tall. At a mile up that is under a pixel, and
 * a landmark nobody can see is not a landmark — the same lesson the shipping
 * taught, where a correct 190 m freighter was invisible and a wrong 380 m one
 * reads perfectly. Applied at instancing so the shapes below stay in real
 * metres and the rules that place them stay honest about the ground.
 */
const EXAGGERATION = 1.7;

/** How far out landmarks are placed, metres. */
const REACH = 60_000;

/**
 * How much room every landmark needs, metres.
 *
 * Landmarks are scattered kind by kind, and nothing in that arrangement stops
 * two different kinds landing on the same hill — which is how a power station
 * ended up standing next to a monastery. This is the rule that is applied
 * afterwards, across the whole set: a site is dropped if anything already
 * accepted is inside the larger of the two kinds' claims.
 *
 * The numbers are what each thing needs to read as its own place rather than
 * as part of a group. A lighthouse wants the most, because a coastline with
 * three of them in a row looks like a fence.
 */
const ROOM: Record<StructureKind, number> = {
  lighthouse: 8000,
  castle: 9500,
  monastery: 8500,
  fort: 3200,
};

/** Kinds that are off unless a world asks for them. */
const DEFAULT_DENSITY: Partial<Record<StructureKind, number>> = { fort: 0.35 };
const densityOf = (
  density: Partial<Record<StructureKind, number>>,
  kind: StructureKind,
): number => density[kind] ?? DEFAULT_DENSITY[kind] ?? 1;

/**
 * How much of that claim applies between two *different* kinds: half, with a
 * floor, so a fort and an abbey can share a ridge without looking like a pair.
 */
const MIXED = 0.5;
const MIXED_FLOOR = 2500;

const PROBE8: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707],
];

/**
 * @deprecated kept for main.ts until the combat rewrite — there are no wind
 * turbines in 1917. A number nobody reads.
 */
export const turbineSpin = { value: 0 };

let sites: Structure[] = [];

export function structures(): Structure[] {
  return sites;
}

/** The scale they are actually drawn at, for anything that measures them. */
export function structureScale(): number {
  return EXAGGERATION;
}

/**
 * How tall one landmark stands above its own footing, metres.
 *
 * Measured off the geometry rather than tabulated. A table of heights beside a
 * set of geometry builders is a second copy of the same fact, and the copy is
 * the one that goes stale the first time a tower gains a spire — which matters
 * here because the camera plants tripods at these things and a wrong height
 * aims the lens at the sky.
 *
 * Local units, cached per kind, then scaled the way `buildStructureMeshes`
 * scales the instance — including the two units it sinks the footing by.
 */
const localTop = new Map<string, number>();
const localWide = new Map<string, number>();

/**
 * How far one landmark spreads from its own axis, metres.
 *
 * Height alone does not say how much frame a thing takes. A mast is 400 m tall
 * and a hand's breadth wide; a castle is 100 m tall and two hundred across,
 * and a camera placed by height alone stood 218 m from one and filled the
 * whole picture with wall. Anything composing a shot at a landmark needs both.
 */
export function structureRadius(s: Structure): number {
  const key = `${s.kind}:${s.variant}`;
  let wide = localWide.get(key);
  if (wide === undefined) {
    const build = GEOMETRY[s.kind][s.variant] ?? GEOMETRY[s.kind][0];
    const geo = build();
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    wide = b === null ? 0 : Math.max(-b.min.x, b.max.x, -b.min.z, b.max.z);
    geo.dispose();
    localWide.set(key, wide);
  }
  return wide * s.size * EXAGGERATION;
}

export function structureHeight(s: Structure): number {
  // Keyed by variant as well as kind. A castle has two designs and they are
  // not the same height — reading the first one's box for both is the sort of
  // near-miss that gives a camera a plausible number and the wrong frame.
  const key = `${s.kind}:${s.variant}`;
  let top = localTop.get(key);
  if (top === undefined) {
    const build = GEOMETRY[s.kind][s.variant] ?? GEOMETRY[s.kind][0];
    const geo = build();
    geo.computeBoundingBox();
    top = geo.boundingBox === null ? 0 : geo.boundingBox.max.y;
    geo.dispose();
    localTop.set(key, top);
  }
  return Math.max(0, top - 2) * s.size * EXAGGERATION;
}

/** Deterministic value in [0, 1) for a cell, matching the other scatterers. */
function cellRandom(x: number, y: number, salt: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Choose where the landmarks are.
 *
 * `sample` is the finished ground: negative is sea, and the rules below are
 * almost entirely questions about what the ground does around a point rather
 * than at it — how much sea is nearby, how much of the country it looks down
 * on, how far the nearest neighbour is.
 */
export function planStructures(
  sample: (x: number, z: number) => number,
  opts: StructureOptions,
): void {
  sites = [];
  if (!opts.enabled) return;

  const salt = (opts.seed | 0) * 32;

  /** How much of a ring around a point is sea. */
  const seaAround = (x: number, z: number, radius: number): number => {
    let wet = 0;
    for (const [dx, dz] of PROBE8) {
      if (sample(x + dx * radius, z + dz * radius) <= 0) wet++;
    }
    return wet / PROBE8.length;
  };

  /** How far a point stands above the country around it, metres. */
  const prominence = (x: number, z: number, radius: number): number => {
    const here = sample(x, z);
    let low = here;
    for (const [dx, dz] of PROBE8) {
      low = Math.min(low, sample(x + dx * radius, z + dz * radius));
    }
    return here - low;
  };

  /** Inside the city, or close enough to its edge to look like part of it. */
  const inTown = (x: number, z: number): boolean => {
    const c = opts.city;
    if (c === null) return false;
    return Math.hypot(x - c.x, z - c.z) < c.radius * 1.12 + 1800;
  };

  /** Steepness right where the thing would stand, as a rise over run. */
  const slopeAt = (x: number, z: number): number => {
    const here = sample(x, z);
    let worst = 0;
    for (const [dx, dz] of PROBE8) {
      worst = Math.max(worst, Math.abs(sample(x + dx * 90, z + dz * 90) - here) / 90);
    }
    return worst;
  };

  /**
   * Walk uphill to the top.
   *
   * A jittered point in an eleven-kilometre cell lands within a few hundred
   * metres of a summit essentially never, and a dome is three hundred metres
   * across — measured, sixty-one of the granite domes' hundred and twenty
   * tallest summits satisfied every rule a mast has, and the scatter reached
   * none of them. Climbing from wherever the grid drops you is what turns
   * "somewhere on this hillside" into "on that top".
   */
  const climb = (x: number, z: number, reach: number): { x: number; z: number } => {
    let cx = x;
    let cz = z;
    let ch = sample(x, z);
    let step = reach * 0.5;
    for (let i = 0; i < 7; i++) {
      let moved = false;
      for (const [dx, dz] of PROBE8) {
        const nx = cx + dx * step;
        const nz = cz + dz * step;
        // Bounded to the reach it was given: this is "climb the hill you
        // landed on", not "go and find the highest peak in the county". Let
        // loose, seven steps of nine hundred metres walk six kilometres uphill
        // and arrive somewhere above the height a castle is allowed — which
        // took Alpine from twenty-three castles to two.
        if (Math.hypot(nx - x, nz - z) > reach) continue;
        const h = sample(nx, nz);
        if (h > ch) { ch = h; cx = nx; cz = nz; moved = true; }
      }
      if (!moved) step *= 0.5;
    }
    return { x: cx, z: cz };
  };

  const scatter = (
    kind: StructureKind,
    cell: number,
    chance: number,
    saltBase: number,
    keep: (x: number, z: number, ground: number) => boolean,
    sizeRange: [number, number] = [0.85, 1.2],
    variants = 1,
    /** Climb to the local summit within this radius before testing. */
    snap = 0,
  ): void => {
    if (densityOf(opts.density, kind) <= 0) return;
    const span = Math.ceil(REACH / cell);
    for (let gx = -span; gx <= span; gx++) {
      for (let gz = -span; gz <= span; gz++) {
        if (cellRandom(gx, gz, saltBase + 1) > chance * densityOf(opts.density, kind)) continue;
        const px = (gx + (cellRandom(gx, gz, saltBase + 2) - 0.5) * 0.82) * cell;
        const pz = (gz + (cellRandom(gx, gz, saltBase + 3) - 0.5) * 0.82) * cell;
        // The summit first, then where the grid actually landed.
        //
        // Trying both is what makes climbing strictly an improvement. Taking
        // only the summit meant that anywhere the climb ended somewhere the
        // rules refuse — above a castle's height ceiling, most often — the site
        // was lost outright rather than falling back to the perfectly good
        // hillside it started on.
        const spots: [number, number][] = [[px, pz]];
        if (snap > 0) {
          const top = climb(px, pz, snap);
          spots.unshift([top.x, top.z]);
        }

        let x = 0;
        let z = 0;
        let ground = 0;
        let ok = false;
        for (const [sx, sz] of spots) {
          if (Math.hypot(sx, sz) < opts.exclusion || Math.hypot(sx, sz) > REACH) continue;
          if (inTown(sx, sz)) continue;
          const g = sample(sx, sz);
          if (!keep(sx, sz, g)) continue;
          x = sx; z = sz; ground = g; ok = true;
          break;
        }
        if (!ok) continue;
        sites.push({
          x, z, y: ground,
          angle: cellRandom(gx, gz, saltBase + 4) * Math.PI * 2,
          kind,
          variant: Math.min(variants - 1,
            Math.floor(cellRandom(gx, gz, saltBase + 7) * variants)),
          farm: -1,
          size: sizeRange[0] + cellRandom(gx, gz, saltBase + 5) * (sizeRange[1] - sizeRange[0]),
        });
      }
    }
  };

  // --------------------------------------------------------------- lighthouse
  //
  // A headland: dry ground, low, with sea round most of it. The ring test is
  // the whole rule — a light on a beach is a shed, and a light on a point
  // sticking into the sea is a landmark you can see from twenty miles.
  if (opts.coastal) {
    scatter('lighthouse', 3400, 0.86, salt + 10, (x, z, ground) => {
      if (ground < 2 || ground > opts.field + 260) return false;
      if (slopeAt(x, z) > 0.6) return false;
      // Three of eight bearings at close range and three further out. Half was
      // too strict to be met: measured, it gave the Isles, the Fjords, Iceland,
      // Karst and the Lagoon no lighthouses whatsoever — a true half-surrounded
      // promontory is much rarer than it feels when you look at a map.
      return seaAround(x, z, 430) >= 0.37 && seaAround(x, z, 1200) >= 0.37;
    });
  }

  // ---------------------------------------------------------------- castles
  //
  // On a hill, and looking down on somewhere worth looking down on: a castle
  // sits above the country it holds, not in the middle of nowhere. Prominence
  // over a shorter radius than a mast — a castle crag is a knoll, not a peak.
  if (opts.peopled) {
  scatter('castle', 11_000, 0.62, salt + 40, (x, z, ground) => {
    if (ground < Math.max(20, opts.field - 320)) return false;
    // Up onto the mountains. The old ceiling was the lower of the snow line
    // and a thousand metres over the field, which in the Alps left a band six
    // hundred metres wide and three castles in a whole world — and a fortress
    // on a snowy crag is the best thing this list has to offer.
    if (ground > Math.min(opts.snowLine * 1.15, opts.field + 2400)) return false;
    if (slopeAt(x, z) > 0.34) return false;
    return prominence(x, z, 800) > 34;
  }, [0.9, 1.3], 2, 1500);

  // ------------------------------------------------------------- monasteries
  //
  // The same hills, higher and further from everything. What separates one
  // from a castle is solitude, so the rule is prominence *and* distance from
  // any castle already placed.
  scatter('monastery', 11_500, 0.78, salt + 50, (x, z, ground) => {
    if (ground < Math.max(40, opts.field - 120)) return false;
    if (ground > Math.min(opts.snowLine * 1.2, opts.field + 2600)) return false;
    if (slopeAt(x, z) > 0.34) return false;
    if (prominence(x, z, 1200) < 52) return false;
    for (const s of sites) {
      if (s.kind !== 'castle') continue;
      if (Math.hypot(s.x - x, s.z - z) < 5200) return false;
    }
    return true;
  }, [0.85, 1.15], 2, 2600);
  }

  // ------------------------------------------------------------------- forts
  //
  // Ring forts on the heights behind the lines, the way the Verdun forts
  // crowned every ridge of the Meuse: prominent, broad-topped ground, and
  // never in no-man's-land.
  scatter('fort', 6500, 0.7, salt + 90, (x, z, ground) => {
    if (ground < Math.max(15, opts.field - 250)) return false;
    if (ground > opts.snowLine * 0.9) return false;
    if (slopeAt(x, z) > 0.16) return false;
    const u = behindLines(x, z);
    if (u < 400 || u > 9000) return false;
    return prominence(x, z, 900) > 22;
  }, [0.9, 1.15], 1, 1200);

  spaceOut();
}

/**
 * Drop anything standing too close to something already accepted.
 *
 * Run once over the finished set rather than inside each scatter, because the
 * clashes that matter are between *different* kinds and no scatter can see the
 * others. Order is deliberate: the rarest and most sited things are kept and
 * the commonest give way, so a wind farm loses a turbine rather than a
 * lighthouse losing its headland.
 */
function spaceOut(): void {
  // Rarest first. Power stations are one or two a world and lighthouses a
  // dozen, and both want flat coastal ground — ranked the other way round the
  // lighthouses took every site and five worlds ended up with no station at
  // all.
  //
  // The observatory sits above the mast for the same reason: both want the
  // highest ground for miles, there are two observatories in a world and
  // eleven masts, and ranked the other way the masts would take every summit.
  const rank: StructureKind[] = ['fort', 'lighthouse', 'monastery', 'castle'];
  const order = [...sites].sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind));
  const kept: Structure[] = [];
  for (const s of order) {
    let clear = true;
    for (const k of kept) {
      const gap = s.kind === k.kind
        ? ROOM[s.kind]
        : Math.max(MIXED_FLOOR, Math.max(ROOM[s.kind], ROOM[k.kind]) * MIXED);
      if (gap > 0 && Math.hypot(s.x - k.x, s.z - k.z) < gap) { clear = false; break; }
    }
    if (clear) kept.push(s);
  }
  sites = kept;
}

/** A box, positioned and coloured, ready to be merged. */
function part(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  colour: THREE.Color,
  spin = 0,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (spin !== 0) geo.rotateZ(spin);
  geo.translate(x, y, z);
  const n = geo.attributes.position.count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  // Flattened, because `mergeGeometries` will not mix indexed and non-indexed
  // geometry — and it returns null rather than throwing, so the first sign of
  // getting it wrong is a mesh with no geometry at all.
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/** A tapered tower — a cylinder, coloured like the boxes. */
function drum(
  rTop: number, rBase: number, h: number,
  x: number, y: number, z: number,
  colour: THREE.Color,
  faces = 8,
): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(rTop, rBase, h, faces);
  geo.translate(x, y + h / 2, z);
  const n = geo.attributes.position.count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

const WHITE = new THREE.Color(0.93, 0.93, 0.91);
const RED = new THREE.Color(0.62, 0.13, 0.11);
const LAMP = new THREE.Color(1.0, 0.92, 0.62);
const STONE = new THREE.Color(0.52, 0.50, 0.46);
const DARK_STONE = new THREE.Color(0.40, 0.38, 0.35);

const SLATE = new THREE.Color(0.22, 0.24, 0.29);

/** Base of the tower is y = 0, so a site sits it straight on the ground. */
function lighthouseGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    drum(3.4, 5.4, 30, 0, 0, 0, WHITE),
    // Two red bands. The stripes are what say "lighthouse" rather than "tower".
    drum(4.4, 4.9, 5, 0, 9, 0, RED),
    drum(3.7, 4.1, 5, 0, 19, 0, RED),
    // Lantern room and cap.
    drum(4.6, 4.6, 4.2, 0, 30, 0, LAMP),
    drum(0.6, 5.2, 3.2, 0, 34.2, 0, SLATE),
    // Keeper's house at the foot, which gives the tower its scale.
    part(11, 5, 8, 9, 2.5, 2, WHITE),
    part(12, 1.6, 9, 9, 5.6, 2, SLATE),
  ], false);
}

function castleGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // Curtain wall, as four runs round a courtyard.
    part(46, 11, 3.4, 0, 5.5, -21, STONE),
    part(46, 11, 3.4, 0, 5.5, 21, STONE),
    part(3.4, 11, 39, -21, 5.5, 0, STONE),
    part(3.4, 11, 39, 21, 5.5, 0, STONE),
    // Corner towers, taller than the wall so the outline is not a plain box.
    ...[[-21, -21], [21, -21], [-21, 21], [21, 21]].map(([cx, cz]) =>
      drum(4.6, 5.4, 19, cx, 0, cz, STONE)),
    ...[[-21, -21], [21, -21], [-21, 21], [21, 21]].map(([cx, cz]) =>
      drum(5.6, 5.6, 1.6, cx, 19, cz, DARK_STONE)),
    // The keep, off centre, and the tallest thing on the hill.
    part(19, 27, 17, -4, 13.5, 0, STONE),
    part(21, 2, 19, -4, 27.5, 0, DARK_STONE),
    // Battlement suggestion: a lighter band under the parapet.
    part(47, 1.4, 4.2, 0, 11.2, -21, DARK_STONE),
    part(47, 1.4, 4.2, 0, 11.2, 21, DARK_STONE),
  ];
  return mergeGeometries(parts, false);
}

/**
 * The other castle: a single round donjon inside a ring wall.
 *
 * Deliberately a different silhouette rather than a different decoration — a
 * tall drum against the sky reads as nothing like a square keep behind curtain
 * walls, which is the whole point of having two.
 */
function castleRoundGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // The motte: a low bank the whole thing sits on.
    drum(30, 36, 5, 0, 0, 0, DARK_STONE, 10),
    // Ring wall with a gatehouse.
    ...Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2;
      return part(9.4, 9, 3.2, Math.sin(a) * 27, 9.5, Math.cos(a) * 27, STONE,
        0);
    }),
    part(11, 15, 8, 0, 12.5, 28, STONE),
    part(12.5, 2, 9.5, 0, 20.5, 28, DARK_STONE),
    // The donjon, tall and round, with a conical cap.
    drum(9.5, 11, 34, 0, 5, 0, STONE, 12),
    drum(11.5, 11.5, 2, 0, 39, 0, DARK_STONE, 12),
    drum(0.6, 11, 12, 0, 41, 0, SLATE, 12),
    // A lower hall against the wall, so it is not one lonely tower.
    part(20, 11, 12, -13, 10.5, -8, STONE),
    part(21.5, 2, 13.5, -13, 16.5, -8, SLATE),
  ];
  return mergeGeometries(parts, false);
}

function monasteryGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    // A long nave with a pitched roof, a bell tower, and a cloister block —
    // the three things that make a monastery read as one and not as a farm.
    part(15, 13, 40, 0, 6.5, 0, WHITE),
    part(17, 3.2, 42, 0, 14.6, 0, RED),
    drum(3.6, 4.4, 30, 0, 0, -23, WHITE),
    drum(0.5, 5.2, 8, 0, 30, -23, RED),
    // Cloister, a low square wing with its own roof.
    part(26, 7, 24, 20, 3.5, 12, WHITE),
    part(28, 2.2, 26, 20, 8, 12, RED),
    // Wall round the yard, low enough to read as an enclosure.
    part(30, 4, 2.2, 20, 2, 25, STONE),
  ];
  return mergeGeometries(parts, false);
}

/**
 * The other abbey: stacked terraces under a dome.
 *
 * The first one is a western abbey — long nave, pitched roof, bell tower. This
 * is the other kind: a huddle of blocks stepping up a crag with a dome on top
 * and one thin tower, which is what a monastery looks like anywhere the ground
 * is too steep to build long.
 */
function monasteryDomedGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [
    part(26, 9, 20, 0, 4.5, 0, WHITE),
    part(19, 9, 15, -3, 13, -2, WHITE),
    part(13, 9, 12, -5, 21.5, -3, WHITE),
    // The dome, as a squat drum and a cap.
    drum(6.5, 7.5, 5, -5, 26, -3, WHITE, 12),
    drum(1.2, 7.0, 7, -5, 31, -3, RED, 12),
    // One thin tower off the end, for the silhouette.
    drum(2.6, 3.2, 26, 12, 4, 6, WHITE, 8),
    drum(0.5, 3.8, 6, 12, 30, 6, RED, 8),
    // Terrace walls stepping down the crag.
    part(28, 3.5, 2.4, 0, 1.8, 11, STONE),
    part(2.4, 3.5, 22, -14, 1.8, 0, STONE),
  ];
  return mergeGeometries(parts, false);
}

/**
 * A ring fort of the Séré de Rivières system, as Douaumont was: a low
 * pentagon of earth ramparts behind a dry ditch, concrete barracks buried in
 * the middle and a couple of retractable gun turrets on top. From the air it is
 * an outline, not a building — which is exactly how the observers saw them.
 */
function fortGeometry(): THREE.BufferGeometry {
  const EARTH = new THREE.Color(0.30, 0.29, 0.22);
  const DITCH = new THREE.Color(0.17, 0.16, 0.13);
  const CONCRETE = new THREE.Color(0.58, 0.57, 0.53);
  const parts: THREE.BufferGeometry[] = [];
  const R = 70;
  for (let i = 0; i < 5; i++) {
    const a0 = (i / 5) * Math.PI * 2;
    const a1 = ((i + 1) / 5) * Math.PI * 2;
    const x0 = Math.sin(a0) * R;
    const z0 = Math.cos(a0) * R;
    const x1 = Math.sin(a1) * R;
    const z1 = Math.cos(a1) * R;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    const mid = [(x0 + x1) / 2, (z0 + z1) / 2];
    const bank = new THREE.BoxGeometry(14, 7, len + 12);
    bank.translate(0, 1.5, 0);
    bank.rotateY(yaw);
    bank.translate(mid[0], 0, mid[1]);
    parts.push(colourise(bank, EARTH));
    const ditch = new THREE.BoxGeometry(10, 1, len + 22);
    ditch.rotateY(yaw);
    ditch.translate(mid[0] * 1.22, 2.3, mid[1] * 1.22);
    parts.push(colourise(ditch, DITCH));
  }
  parts.push(part(58, 6, 22, 0, 3, 8, CONCRETE));
  parts.push(part(30, 3, 12, -6, 7.5, -18, CONCRETE));
  parts.push(drum(5, 5.5, 3, 18, 6, -10, DARK_STONE, 10));
  parts.push(drum(5, 5.5, 3, -24, 6, 20, DARK_STONE, 10));
  parts.push(drum(0.8, 5, 1.6, 18, 9, -10, SLATE, 10));
  parts.push(drum(0.8, 5, 1.6, -24, 9, 20, SLATE, 10));
  return mergeGeometries(parts, false);
}

/** Give a geometry one flat colour and flatten it for merging. */
function colourise(geo: THREE.BufferGeometry, colour: THREE.Color): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

const GEOMETRY: Record<StructureKind, (() => THREE.BufferGeometry)[]> = {
  lighthouse: [lighthouseGeometry],
  castle: [castleGeometry, castleRoundGeometry],
  monastery: [monasteryGeometry, monasteryDomedGeometry],
  fort: [fortGeometry],
};

/**
 * Build the planned landmarks into one group.
 *
 * Instanced per kind and merged per kind, so the whole set is five draw calls
 * however many of them there are. Not frustum-culled: one mesh spans the map,
 * so its bounding sphere is the map and the test can only ever say yes.
 */
export function buildStructureMeshes(): THREE.Group {
  const group = new THREE.Group();
  if (sites.length === 0) return group;

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.04,
  });

  const dummy = new THREE.Object3D();
  for (const kind of Object.keys(GEOMETRY) as StructureKind[]) {
   for (let v = 0; v < GEOMETRY[kind].length; v++) {
    const of = sites.filter((s) => s.kind === kind && s.variant === v);
    if (of.length === 0) continue;
    const geo = GEOMETRY[kind][v]();
    const mesh = new THREE.InstancedMesh(geo, material, of.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    of.forEach((s, i) => {
      // Sunk slightly, so a tower on sloping ground has its footing in the
      // hill rather than standing on one corner of it.
      dummy.position.set(s.x, s.y - 2 * s.size * EXAGGERATION, s.z);
      dummy.rotation.set(0, s.angle, 0);
      dummy.scale.setScalar(s.size * EXAGGERATION);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    group.add(mesh);
   }
  }
  return group;
}

export function disposeStructureMeshes(group: THREE.Group): void {
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
