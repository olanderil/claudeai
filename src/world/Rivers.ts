import { clamp, lerp, smoothstep } from '../util/math';

/**
 * Rivers, traced downhill.
 *
 * The obvious way to get a river network is the same 1 − |noise| trick that
 * makes the fjord inlets: thin winding lines, nearly free, evaluated per sample.
 * That is what this used to be, and it does not work — measured, a third to a
 * half of every channel ran the wrong way, because a bed derived from noise
 * climbs wherever the noise climbs. No amount of smoothing the reference field
 * fixes it: a smoother field still has local maxima, just longer ones.
 *
 * Water does not follow noise, it follows gravity, and gravity needs a path
 * rather than a field. So rivers are *planned* — traced by actual downhill
 * descent from a source to the sea, once per world and seed — and the per-sample
 * job is only ever "how far am I from the nearest traced segment?".
 *
 * This is the same shape as the villages and the airstrips: search up front into
 * a small array, hash grid over it, one lookup that misses almost everywhere.
 * Its properties fall out for free — the bed descends monotonically because it
 * was walked downhill, the channel is continuous because a polyline is, and the
 * count is exact because you choose how many to trace.
 */

export interface RiverSettings {
  /** Depth of the channel below the traced ground, metres. */
  depth: number;
  /** How many rivers to trace. */
  count: number;
  /** Sources are seeded on ground within this band. */
  sourceMin: number;
  sourceMax: number;
  /** A trace is finished once it drops to here — the sea, or a basin floor. */
  endAt: number;
  /** Channel half-width at the source and at the mouth, metres. */
  widthNear: number;
  widthFar: number;
  /** Spacing of the grid sources are drawn from. Small worlds need a fine one. */
  sourceCell?: number;
}

interface Node {
  x: number;
  z: number;
  /** Ground elevation at this point, non-increasing along the river. */
  y: number;
  /** Channel half-width here. */
  w: number;
}

interface Segment {
  ax: number;
  az: number;
  ay: number;
  aw: number;
  /** Vector to the far end. */
  dx: number;
  dz: number;
  dy: number;
  dw: number;
  /** 1 / |d|² in the plane, for the projection. */
  invLenSq: number;
}

/** A lake where a river ends inland — a tarn with no outlet. */
export interface Tarn {
  x: number;
  z: number;
  /** Water surface. */
  y: number;
  radius: number;
}

const STEP = 190;
const MAX_STEPS = 220;
/** Directions probed at each step. */
const DIRECTIONS = 9;
/** A trace this short never became a river; discard it and try another source. */
const MIN_NODES = 16;
/** Hash-grid cell for the per-sample lookup, metres. */
const BUCKET = 512;

let segments: Segment[] = [];
let paths: Node[][] = [];
let tarns: Tarn[] = [];
let index = new Map<number, number[]>();
let settings: RiverSettings | null = null;

/** Strength at the last sampled point, 0..1. */
let strengthHere = 0;

export function riverStrength(): number {
  return strengthHere;
}

export function riverTarns(): Tarn[] {
  return tarns;
}

export function riverSegmentCount(): number {
  return segments.length;
}

/** The traced polylines, for diagnostics. */
export function riverPaths(): { x: number; z: number; y: number }[][] {
  return paths;
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

// -------------------------------------------------------------------- planning

/** Spacing of the grid that source candidates are drawn from, metres. */
const SOURCE_CELL = 6000;
const SOURCE_SPAN = 11;
/**
 * How many consecutive uphill steps a trace may push through.
 *
 * Without this a river stops at the first hollow in its path, which on real
 * terrain is within a few kilometres of every source — the first version of the
 * trace produced one river per world and none of them reached the sea. A river
 * meeting a basin fills it and overflows, so the trace does too: it keeps
 * walking, and the bed it records stays flat rather than climbing.
 */
const MAX_STALL = 34;
/**
 * Traces attempted per river kept. Most sources run into a basin they cannot
 * leave; tracing a few extra and keeping the ones that got somewhere is far
 * cheaper than trying to pick perfect sources up front.
 */
const ATTEMPTS_PER_RIVER = 2.5;

export function planRivers(
  sample: (x: number, z: number) => number,
  cfg: RiverSettings | null,
  seed: number,
): void {
  segments = [];
  paths = [];
  tarns = [];
  index = new Map();
  settings = cfg;
  if (!cfg) return;

  const salt = (seed | 0) * 16 + 7;

  // Candidate sources: high ground, ranked so the choice is deterministic and
  // spread out rather than clustered wherever the scan happened to start.
  const sources: { x: number; z: number; y: number; rank: number }[] = [];
  const cell = cfg.sourceCell ?? SOURCE_CELL;
  for (let gx = -SOURCE_SPAN; gx <= SOURCE_SPAN; gx++) {
    for (let gz = -SOURCE_SPAN; gz <= SOURCE_SPAN; gz++) {
      const x = (gx + (cellRandom(gx, gz, salt + 1) - 0.5) * 0.8) * cell;
      const z = (gz + (cellRandom(gx, gz, salt + 2) - 0.5) * 0.8) * cell;
      const y = sample(x, z);
      if (y < cfg.sourceMin || y > cfg.sourceMax) continue;
      sources.push({ x, z, y, rank: cellRandom(gx, gz, salt + 3) });
    }
  }
  sources.sort((a, b) => a.rank - b.rank);

  const attempts = Math.ceil(cfg.count * ATTEMPTS_PER_RIVER);
  let kept = 0;
  for (const source of sources.slice(0, attempts)) {
    if (kept >= cfg.count) break;
    const nodes = trace(sample, source.x, source.z, source.y, cfg);
    if (nodes.length < MIN_NODES) continue;
    kept++;
    paths.push(nodes);
    addRiver(nodes);

    // A river that stopped inland has nowhere to go: that is where a lake sits.
    const last = nodes[nodes.length - 1];
    if (last.y > cfg.endAt + 5) {
      tarns.push({ x: last.x, z: last.z, y: last.y - cfg.depth * 0.7, radius: last.w * 4.5 });
    }
  }
}

/**
 * Walk downhill from a source.
 *
 * The search is restricted to the forward half-plane after the first step. A
 * full circle lets the walk turn straight back the way it came the moment the
 * ground ahead rises, and the trace collapses into a knot instead of a river.
 */
function trace(
  sample: (x: number, z: number) => number,
  startX: number,
  startZ: number,
  startY: number,
  cfg: RiverSettings,
): Node[] {
  const nodes: Node[] = [{ x: startX, z: startZ, y: startY, w: cfg.widthNear }];

  let x = startX;
  let z = startZ;
  let y = startY;
  let headX = 0;
  let headZ = 0;
  let stalled = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    let bestX = 0;
    let bestZ = 0;
    let bestY = Infinity;

    for (let k = 0; k < DIRECTIONS; k++) {
      const angle = (k / DIRECTIONS) * Math.PI * 2;
      const dx = Math.sin(angle);
      const dz = Math.cos(angle);
      // Forward half-plane only, once there is a heading to speak of — a full
      // circle lets the walk turn straight back the way it came the moment the
      // ground ahead rises. While stalled in a basin that restriction is exactly
      // wrong, though: the spill point can be in any direction, so open it up.
      if (step > 0 && stalled === 0 && dx * headX + dz * headZ < -0.1) continue;

      const px = x + dx * STEP;
      const pz = z + dz * STEP;
      const py = sample(px, pz);
      if (py < bestY) {
        bestY = py;
        bestX = px;
        bestZ = pz;
      }
    }

    // Nowhere lower to go: a basin. Push on for a while — the water fills it
    // and spills over the low point — and give up only if it never does.
    if (bestY >= y) {
      stalled++;
      if (stalled > MAX_STALL) break;
    } else {
      stalled = 0;
    }

    headX = (bestX - x) / STEP;
    headZ = (bestZ - z) / STEP;
    x = bestX;
    z = bestZ;
    // The recorded bed never rises. Crossing a rise it stays level and the
    // carve cuts through, which is what a river gorge is; that is also what
    // makes the bed monotone by construction rather than by hope.
    y = Math.min(y, bestY);

    // Widen downstream. Real catchments widen because tributaries join; this
    // just interpolates, which reads the same from the air.
    const along = step / MAX_STEPS;
    nodes.push({ x, z, y, w: lerp(cfg.widthNear, cfg.widthFar, Math.min(1, along * 3)) });

    if (y <= cfg.endAt) break;
  }

  return nodes;
}

function addRiver(nodes: Node[]): void {
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lenSq = dx * dx + dz * dz;
    if (lenSq < 1) continue;

    const id = segments.length;
    segments.push({
      ax: a.x, az: a.z, ay: a.y, aw: a.w,
      dx, dz, dy: b.y - a.y, dw: b.w - a.w,
      invLenSq: 1 / lenSq,
    });

    // Index every cell the segment's influence touches.
    const reach = Math.max(a.w, b.w) * 2.2;
    const gx0 = Math.floor((Math.min(a.x, b.x) - reach) / BUCKET);
    const gx1 = Math.floor((Math.max(a.x, b.x) + reach) / BUCKET);
    const gz0 = Math.floor((Math.min(a.z, b.z) - reach) / BUCKET);
    const gz1 = Math.floor((Math.max(a.z, b.z) + reach) / BUCKET);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
        const bucket = index.get(key);
        if (bucket) bucket.push(id);
        else index.set(key, [id]);
      }
    }
  }
}

// -------------------------------------------------------------------- sampling

/**
 * Cut the river into a height field, and report how wet this point is.
 *
 * `maxCut` is what stops a channel notching through anything that happens to
 * stand in its way — a karst tower, a berg — without needing to know what those
 * things are. Past that limit the river is simply blocked by rock and neither
 * cuts nor paints.
 */
export function carveRivers(x: number, z: number, h: number): number {
  strengthHere = 0;
  if (segments.length === 0 || settings === null) return h;

  const bucket = index.get(bucketKey(x, z));
  if (bucket === undefined) return h;

  const cfg = settings;
  let best = 0;
  let bestBed = 0;

  for (let i = 0; i < bucket.length; i++) {
    const s = segments[bucket[i]];
    const px = x - s.ax;
    const pz = z - s.az;
    // Projection onto the segment, clamped to its ends.
    const t = clamp((px * s.dx + pz * s.dz) * s.invLenSq, 0, 1);
    const cx = px - s.dx * t;
    const cz = pz - s.dz * t;
    const dist = Math.hypot(cx, cz);

    const width = s.aw + s.dw * t;
    if (dist > width * 2.0) continue;

    // Flat core, then banks. The core is what makes it read as a water surface
    // rather than as a V-shaped ditch.
    const strength = 1 - smoothstep(width * 0.55, width * 1.9, dist);
    if (strength > best) {
      best = strength;
      bestBed = s.ay + s.dy * t - cfg.depth;
    }
  }

  if (best <= 0.002) return h;

  const maxCut = cfg.depth * 3.5;
  const blocked = smoothstep(maxCut * 0.6, maxCut, h - bestBed);
  const strength = best * (1 - blocked);
  if (strength <= 0.002) return h;

  strengthHere = strength;
  return lerp(h, Math.min(h, bestBed), strength);
}

/** Depth of a tarn below its shore, as a fraction of the channel depth. */
const TARN_DEPTH = 2.2;

/** Bowl for the lake at a river's inland terminus, or the height unchanged. */
export function carveTarns(x: number, z: number, h: number): number {
  if (tarns.length === 0 || settings === null) return h;
  let out = h;
  for (let i = 0; i < tarns.length; i++) {
    const t = tarns[i];
    const dx = x - t.x;
    const dz = z - t.z;
    if (Math.abs(dx) > t.radius || Math.abs(dz) > t.radius) continue;
    const r = Math.hypot(dx, dz);
    if (r > t.radius) continue;
    const bowl = smoothstep(t.radius, t.radius * 0.55, r);
    const bed = t.y - settings.depth * TARN_DEPTH;
    out = Math.min(out, lerp(h, bed, bowl));
    if (bowl > 0.35) strengthHere = Math.max(strengthHere, bowl);
  }
  return out;
}
