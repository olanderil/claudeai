import { clamp } from '../util/math';

/**
 * Roads: straight, poplar-lined, pale with chalk dust.
 *
 * Planned once per world and seed between the villages and aerodromes, then
 * carried into the terrain as a per-vertex *signed* distance. Signed distance
 * to a straight line is an affine function of position, so interpolating it
 * across a triangle is exact: a five-metre road on a mesh with ten-metre
 * vertices comes out with crisp edges, which painting it any other way would
 * not give.
 */

export interface RoadSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit direction a → b. */
  dx: number;
  dz: number;
  len: number;
  /** Half-width of the metalled surface, metres. */
  half: number;
  /** Whether this stretch is lined with poplars. */
  lined: boolean;
  /** Which road this belongs to, for the tree rows. */
  road: number;
}

/** How far the signed distance is meaningful, metres; beyond, the attribute saturates. */
export const ROAD_REACH = 60;
const BUCKET = 512;

let segs: RoadSegment[] = [];
let index = new Map<number, number[]>();
/** The canals, as their own line set: painted as crisp water the same way roads are. */
let waterSegs: RoadSegment[] = [];
let waterIndex = new Map<number, number[]>();

export function roadSegments(): RoadSegment[] {
  return segs;
}

function hash01(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface RoadNode { x: number; z: number; weight: number; }

export interface RoadOptions {
  seed: number;
  /** Ground a road must not cross — the aerodromes' landing grounds and hangar rows. */
  blocked?: (x: number, z: number) => boolean;
  /** Finished-enough ground to test gradients and water against. */
  sample: (x: number, z: number) => number;
  /** Sea or lake: a road does not cross it. */
  wet: (x: number, z: number) => boolean;
  /** Share of roads lined with trees, 0..1. */
  lined: number;
  /** Steepest average gradient a road will take. */
  maxGrade: number;
  /** Fixed routes laid as they are: towpaths along the canals. */
  extra?: { pts: [number, number][]; half: number; lined: boolean }[];
}

/**
 * Join the settlements up.
 *
 * Every node links to its two nearest neighbours, plus two long straight
 * routes nationales crossing the whole map through the home sector — the
 * Albert–Bapaume road of this world, running straight into the lines.
 */
export function planRoads(nodes: RoadNode[], opts: RoadOptions): void {
  segs = [];
  index = new Map();
  if (nodes.length < 2) return;
  const { seed } = opts;

  const edges: [number, number][] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const near = nodes
      .map((b, j) => ({ j, d: Math.hypot(b.x - a.x, b.z - a.z) }))
      .filter((e) => e.j !== i && e.d < 8500)
      .sort((p, q) => p.d - q.d)
      .slice(0, a.weight > 1 ? 3 : 2);
    for (const e of near) {
      const key = i < e.j ? `${i}:${e.j}` : `${e.j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([i, e.j]);
    }
  }

  let road = 0;
  for (const [i, j] of edges) {
    const a = nodes[i];
    const b = nodes[j];
    if (!routeOk(a.x, a.z, b.x, b.z, opts)) continue;
    const lined = hash01(i, j, seed + 5) < opts.lined;
    addRoad([[a.x, a.z], ...bends(a.x, a.z, b.x, b.z, i * 131 + j, seed), [b.x, b.z]],
      lined ? 2.9 : 2.4, lined, road++);
  }

  for (const e of opts.extra ?? []) addRoad(e.pts, e.half, e.lined, road++);

  // Two long straight roads through the home sector, crossing the lines.
  for (let k = 0; k < 2; k++) {
    const ang = (k === 0 ? -0.35 : 0.42) + (hash01(k, seed, 77) - 0.5) * 0.3;
    const off = (k === 0 ? -2600 : 3100) + (hash01(k, seed, 78) - 0.5) * 1500;
    const dirX = Math.sin(ang);
    const dirZ = -Math.cos(ang);
    const pts: [number, number][] = [];
    for (let t = -26000; t <= 26000; t += 1300) {
      const wob = (hash01(k, t, seed + 79) - 0.5) * 40;
      pts.push([off + dirX * t - dirZ * wob, 1500 + dirZ * t + dirX * wob]);
    }
    // Split where the road meets the sea or climbs a wall; keep the rest.
    let run: [number, number][] = [];
    const flush = (): void => {
      if (run.length >= 2) addRoad(run, 3.3, true, road++);
      run = [];
    };
    for (let p = 0; p < pts.length; p++) {
      const [x, z] = pts[p];
      const bad = opts.wet(x, z) || (opts.blocked !== undefined && opts.blocked(x, z));
      if (bad || (run.length > 0 && !routeOk(run[run.length - 1][0], run[run.length - 1][1], x, z, opts))) {
        flush();
        if (!bad) run.push([x, z]);
        continue;
      }
      run.push([x, z]);
    }
    flush();
  }
}

/** Two gentle bends so a road is not ruled with a straight-edge. */
function bends(ax: number, az: number, bx: number, bz: number, id: number, seed: number): [number, number][] {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const nx = -dz / len;
  const nz = dx / len;
  const out: [number, number][] = [];
  for (const t of [0.33, 0.67]) {
    const j = (hash01(id, Math.round(t * 100), seed + 3) - 0.5) * len * 0.09;
    out.push([ax + dx * t + nx * j, az + dz * t + nz * j]);
  }
  return out;
}

function routeOk(ax: number, az: number, bx: number, bz: number, opts: RoadOptions): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(2, Math.ceil(len / 120));
  let prev = opts.sample(ax, az);
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    if (opts.wet(x, z)) return false;
    if (opts.blocked && opts.blocked(x, z)) return false;
    const h = opts.sample(x, z);
    if (Math.abs(h - prev) / (len / steps) > opts.maxGrade) return false;
    prev = h;
  }
  return true;
}

function addRoad(
  pts: [number, number][], half: number, lined: boolean, road: number,
  into: RoadSegment[] = segs, idx: Map<number, number[]> = index,
): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1) continue;
    const id = into.length;
    into.push({ ax, az, bx, bz, dx: (bx - ax) / len, dz: (bz - az) / len, len, half, lined, road });
    const r = ROAD_REACH + 10;
    for (let gx = Math.floor((Math.min(ax, bx) - r) / BUCKET); gx <= Math.floor((Math.max(ax, bx) + r) / BUCKET); gx++) {
      for (let gz = Math.floor((Math.min(az, bz) - r) / BUCKET); gz <= Math.floor((Math.max(az, bz) + r) / BUCKET); gz++) {
        // Only cells the segment actually passes near, not its whole bounding box.
        const cx = (gx + 0.5) * BUCKET;
        const cz = (gz + 0.5) * BUCKET;
        if (segmentDistance(into[id], cx, cz) > BUCKET * 0.75 + r) continue;
        const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
        const b = idx.get(key);
        if (b) b.push(id);
        else idx.set(key, [id]);
      }
    }
  }
}

function segmentDistance(s: RoadSegment, x: number, z: number): number {
  const t = clamp((x - s.ax) * s.dx + (z - s.az) * s.dz, 0, s.len);
  return Math.hypot(x - (s.ax + s.dx * t), z - (s.az + s.dz * t));
}

let lastHalf = 3;
let lastValid = 0;

/**
 * Signed distance to the nearest road centreline, metres, clamped to
 * ±ROAD_REACH (positive on the left of the road's direction).
 *
 * Signed distance alone would draw phantom roads wherever two vertices with no
 * road in common straddle zero, so `roadValidity()` says how far the number is
 * to be trusted — 1 within 40 m of a road, falling to 0 at the reach — and the
 * shader only draws where every vertex of the triangle agreed. `roadHalfWidth()`
 * is the width of the road that won. Both are read off the back of this call.
 */
export function roadSignedDistance(x: number, z: number): number {
  return signedDistance(x, z, segs, index);
}

/** The same for the canals; `roadValidity()` and `roadHalfWidth()` then describe the canal. */
export function waterSignedDistance(x: number, z: number): number {
  return signedDistance(x, z, waterSegs, waterIndex);
}

/** Replace the canal line set (centrelines and half-widths). */
export function setWaterways(lines: { pts: [number, number][]; half: number }[]): void {
  waterSegs = [];
  waterIndex = new Map();
  lines.forEach((l, i) => addRoad(l.pts, l.half, false, i, waterSegs, waterIndex));
}

function signedDistance(x: number, z: number, segs: RoadSegment[], index: Map<number, number[]>): number {
  lastHalf = 3;
  lastValid = 0;
  if (segs.length === 0) return ROAD_REACH;
  const bucket = index.get(((Math.floor(x / BUCKET) & 0xffff) << 16) | (Math.floor(z / BUCKET) & 0xffff));
  if (bucket === undefined) return ROAD_REACH;
  let best = Infinity;
  let bestSigned = ROAD_REACH;
  for (let i = 0; i < bucket.length; i++) {
    const s = segs[bucket[i]];
    const px = x - s.ax;
    const pz = z - s.az;
    const t = px * s.dx + pz * s.dz;
    // Beyond the ends: distance to the end point, keeping the side sign so
    // consecutive segments of one road join without a seam.
    const tc = clamp(t, 0, s.len);
    const d = Math.hypot(px - s.dx * tc, pz - s.dz * tc);
    if (d < best) {
      best = d;
      const side = px * -s.dz + pz * s.dx;
      bestSigned = side >= 0 ? d : -d;
      lastHalf = s.half;
    }
  }
  if (best >= ROAD_REACH) return ROAD_REACH;
  lastValid = 1 - Math.max(0, Math.min(1, (best - 40) / (ROAD_REACH - 40)));
  return bestSigned;
}

export function roadHalfWidth(): number {
  return lastHalf;
}

export function roadValidity(): number {
  return lastValid;
}

/** The nearest road point within `reach`, for the planners. */
export function nearestRoad(
  x: number, z: number, reach = 1500,
): { d: number; x: number; z: number; dirX: number; dirZ: number } | null {
  let best: { d: number; x: number; z: number; dirX: number; dirZ: number } | null = null;
  for (const s of segs) {
    // Cheap reject on the bounding box.
    if (x < Math.min(s.ax, s.bx) - reach || x > Math.max(s.ax, s.bx) + reach) continue;
    if (z < Math.min(s.az, s.bz) - reach || z > Math.max(s.az, s.bz) + reach) continue;
    const t = clamp((x - s.ax) * s.dx + (z - s.az) * s.dz, 0, s.len);
    const px = s.ax + s.dx * t;
    const pz = s.az + s.dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < reach && (best === null || d < best.d)) best = { d, x: px, z: pz, dirX: s.dx, dirZ: s.dz };
  }
  return best;
}
