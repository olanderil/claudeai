import * as THREE from 'three';
import { clamp, lerp, smoothstep } from '../util/math';

/**
 * The Western Front: one meandering line of no-man's-land across every world.
 *
 * Everything here is either the *curve* — a sum of a few sines, cheap enough to
 * evaluate per terrain sample and mirrored exactly in GLSL, so the painted
 * trenches, the carved craters and every CPU query agree to the centimetre — or
 * a *plan*: aerodromes, kite-balloon winches, gun pits, dumps, lorry parks, all
 * chosen once per world and seed against the finished ground and then simply
 * read back.
 *
 * Orientation, fixed for every world: the line runs roughly east–west a few
 * kilometres north of the origin. The home side, with the home aerodrome at the
 * origin, is SOUTH (+z); the far side is NORTH (−z).
 *
 * Coordinates along the front use plain world x as the "along" axis; "across"
 * is the signed distance `frontDistance`, which is the vertical offset from the
 * centreline scaled by the curve's cosine, so it is the true perpendicular
 * distance wherever the line is locally straight. Both the CPU and the shader
 * use exactly this frame, which is what makes a machine-gun nest planned here
 * sit precisely on a trench painted there.
 */

export interface FrontSettings {
  /** Distance of the no-man's-land centreline north of the home aerodrome, metres. */
  offset: number;
  /** Meander amplitude, metres: how far the line swings north and south. */
  amplitude: number;
  /** Wavelength of the main meander, metres. */
  wavelength: number;
  /** Width of no-man's-land between the two wire belts, metres. */
  width: number;
  /** Shell-crater density, 0..1. */
  craters: number;
  /** Chalk subsoil, 0..1 — white trench spoil and crater rims, as on the Somme. */
  chalk: number;
  /** Water-logging, 0..1 — flooded shell holes and trench bottoms, as in Flanders. */
  flooded: number;
}

export const DEFAULT_FRONT: FrontSettings = {
  offset: 4000, amplitude: 900, wavelength: 15000, width: 420,
  craters: 1, chalk: 0, flooded: 0.3,
};

export interface Slot { x: number; z: number; rotY: number; }

/**
 * An aerodrome: a mown grass landing ground, nothing more solid than that.
 *
 * `headingDeg` is the main landing/take-off direction (0 = north, 90 = east),
 * the same convention as the aircraft. `rotY` in the slots is a yaw for
 * `Object3D.rotation.y` that turns a model whose front is local −Z to face the
 * right way: hangar doors face the field, parked aircraft face the take-off
 * direction.
 */
export interface Aerodrome {
  x: number;
  z: number;
  headingDeg: number;
  elevation: number;
  side: 1 | -1;
  main: boolean;
  hangarSlots: Slot[];
  parkingSlots: Slot[];
  /** Half the landing ground's length along `headingDeg`, metres. */
  halfLength: number;
  /** Half its width, metres. */
  halfWidth: number;
}

export type FrontTargetKind = 'artillery' | 'mgnest' | 'aagun' | 'dump' | 'lorry' | 'hq';

export interface FrontTarget { kind: FrontTargetKind; x: number; z: number; rotY: number; }

/** Where smoke goes up: burning ruins and the places the shells are landing. */
export interface SmokeSite { x: number; z: number; strength: number; }

// ------------------------------------------------------------------ constants

/** How far behind the no-man's-land edge the fire trench runs, metres. */
export const FIRE_BACK = 7;
/** Cell of the heavy-shell crater grid, metres. Mirrored in GLSL. */
const C1 = 34;
/** Cell of the field-gun crater grid, metres. */
const C2 = 13;
/** Cell along x of the mine-crater grid, metres. */
const MINE_CELL = 2400;
/** Crater salts, shared with the shader. */
const SALT_C1 = 101;
const SALT_C2 = 202;
const SALT_MINE = 303;

// --------------------------------------------------------------------- state

let settings: FrontSettings = { ...DEFAULT_FRONT };
let seedSalt = 0;
/** Sine terms of the centreline: amplitude, wavenumber, phase. */
const A = [0, 0, 0, 0];
const K = [0, 0, 0, 0];
const P = [0, 0, 0, 0];
let base = -4000;
/** Wobble phases of the no-man's-land edge, home side then far side. */
const WOB_HOME = [0, 0, 0];
const WOB_FAR = [0, 0, 0];

let fields: Aerodrome[] = [];
let home: Aerodrome = makeAerodrome(0, 0, 0, 0, 1, true, 470, 300);
let far: Aerodrome = makeAerodrome(0, -8000, 180, 0, -1, true, 420, 280);
let anchorsHome: { x: number; z: number }[] = [];
let anchorsFar: { x: number; z: number }[] = [];
let targetsHome: FrontTarget[] = [];
let targetsFar: FrontTarget[] = [];
let smoke: SmokeSite[] = [];
/** Aerodromes whose pads are cut into the terrain (not the home field, which the world pad covers). */
let pads: Aerodrome[] = [];
let padIndex = new Map<number, Aerodrome[]>();
const PAD_BUCKET = 1024;
const PAD_GRADE = 260;

/**
 * Uniforms for the terrain shader, shared by reference: replanning a front is
 * a handful of number writes, never a material rebuild.
 */
export const frontUniforms = {
  uFrontBase: { value: -4000 },
  uFrontA: { value: new THREE.Vector4() },
  uFrontK: { value: new THREE.Vector4() },
  uFrontP: { value: new THREE.Vector4() },
  /** Half-width of no-man's-land, craters, chalk, flooded. */
  uFrontCfg: { value: new THREE.Vector4(210, 1, 0, 0.3) },
  uWobHome: { value: new THREE.Vector3() },
  uWobFar: { value: new THREE.Vector3() },
  /** 0 switches the whole battlefield off (a world with no front). */
  uFrontOn: { value: 1 },
  /** Per-seed salt added to every crater salt, as a float (exact below 2^24). */
  uFrontSalt: { value: 13 },
};

// ------------------------------------------------------------------- hashing

/**
 * Deterministic [0,1) from two integers and a salt.
 *
 * Integer-exact on purpose: the shader has the same function in `uint`
 * arithmetic, so a crater the CPU carves is the crater the GPU paints. JS
 * wraps through `Math.imul` and the int32 coercions of `^` and `>>>`.
 */
export function hash01(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------- curve

/**
 * Set the curve for a world and seed. Called before any other planning,
 * because the terrain height itself reads it (crater carving).
 */
export function setFront(next: FrontSettings | undefined, seed: number): void {
  settings = { ...(next ?? DEFAULT_FRONT) };
  seedSalt = ((seed | 0) % 1_000_000) * 7 + 13;
  const amp = settings.amplitude;
  const wl = Math.max(2000, settings.wavelength);
  const shares = [0.56, 0.27, 0.12, 0.05];
  const lengths = [1, 0.43, 0.173, 0.0617];
  let at0 = 0;
  for (let i = 0; i < 4; i++) {
    A[i] = amp * shares[i];
    K[i] = (Math.PI * 2) / (wl * lengths[i]);
    P[i] = hash01(i, seed, 911) * Math.PI * 2;
    at0 += A[i] * Math.sin(P[i]);
  }
  // Anchored so the line crosses x = 0 exactly `offset` north of the field,
  // whatever the phases do.
  base = -settings.offset - at0;
  for (let i = 0; i < 3; i++) {
    WOB_HOME[i] = hash01(i, seed, 917) * Math.PI * 2;
    WOB_FAR[i] = hash01(i, seed, 919) * Math.PI * 2;
  }

  const u = frontUniforms;
  u.uFrontBase.value = base;
  u.uFrontA.value.set(A[0], A[1], A[2], A[3]);
  u.uFrontK.value.set(K[0], K[1], K[2], K[3]);
  u.uFrontP.value.set(P[0], P[1], P[2], P[3]);
  u.uFrontCfg.value.set(settings.width / 2, settings.craters, settings.chalk, settings.flooded);
  u.uWobHome.value.set(WOB_HOME[0], WOB_HOME[1], WOB_HOME[2]);
  u.uWobFar.value.set(WOB_FAR[0], WOB_FAR[1], WOB_FAR[2]);
  u.uFrontOn.value = next === undefined ? 0 : 1;
  u.uFrontSalt.value = seedSalt;
}

export function frontSettings(): Readonly<FrontSettings> {
  return settings;
}

/** z of the no-man's-land centreline at world x. */
export function frontZ(x: number): number {
  return base
    + A[0] * Math.sin(K[0] * x + P[0])
    + A[1] * Math.sin(K[1] * x + P[1])
    + A[2] * Math.sin(K[2] * x + P[2])
    + A[3] * Math.sin(K[3] * x + P[3]);
}

/** dz/dx of the centreline. */
function frontSlope(x: number): number {
  return A[0] * K[0] * Math.cos(K[0] * x + P[0])
    + A[1] * K[1] * Math.cos(K[1] * x + P[1])
    + A[2] * K[2] * Math.cos(K[2] * x + P[2])
    + A[3] * K[3] * Math.cos(K[3] * x + P[3]);
}

/** sqrt(1 + slope²): converts vertical offset to perpendicular distance. */
function frontNorm(x: number): number {
  const s = frontSlope(x);
  return Math.sqrt(1 + s * s);
}

/** Signed metres from the centreline, positive toward home (south). */
export function frontDistance(x: number, z: number): number {
  return (z - frontZ(x)) / frontNorm(x);
}

/** The world point `d` metres across the line at along-coordinate x. */
export function frontPoint(x: number, d: number): { x: number; z: number } {
  return { x, z: frontZ(x) + d * frontNorm(x) };
}

/**
 * How far the edge of no-man's-land wanders on one side, metres.
 *
 * Three sines per side, mirrored in GLSL. The fire trench follows it, so the
 * line is never a ruled parallel to the centreline.
 */
export function edgeWobble(s: number, side: 1 | -1): number {
  const q = side > 0 ? WOB_HOME : WOB_FAR;
  return 11 * Math.sin(s * 0.0047 + q[0])
    + 6 * Math.sin(s * 0.0131 + q[1])
    + 3 * Math.sin(s * 0.037 + q[2]);
}

/** Half-width of no-man's-land on one side at along-coordinate s. */
export function nmlHalf(s: number, side: 1 | -1): number {
  return settings.width / 2 + edgeWobble(s, side);
}

/** +1 home side, −1 far side, 0 inside no-man's-land. */
export function frontSide(x: number, z: number): 1 | 0 | -1 {
  const d = frontDistance(x, z);
  const side: 1 | -1 = d >= 0 ? 1 : -1;
  if (Math.abs(d) < nmlHalf(x, side)) return 0;
  return side;
}

/**
 * Metres behind one's own no-man's-land edge: negative inside no-man's-land,
 * 0 at the wire, a few metres at the fire trench, kilometres at the rear.
 */
export function behindLines(x: number, z: number): number {
  const d = frontDistance(x, z);
  const side: 1 | -1 = d >= 0 ? 1 : -1;
  return Math.abs(d) - nmlHalf(x, side);
}

/**
 * Crater density at a given depth behind the lines, 0..1, before the world's
 * own crater setting. Mirrored in GLSL (`bfDensity`).
 */
export function devastation(u: number): number {
  if (u <= 0) return 1;
  return 0.95 * Math.exp(-u / 380) + 0.06 * (1 - smoothstep(1000, 2800, u));
}

/**
 * How hard this patch of ground was shelled, 0..1: barrages walk, and some
 * ground is hit again and again while some survives. Sines rather than noise
 * so the shader's twin (`bfLump`) matches exactly.
 */
export function shellLump(x: number, z: number): number {
  const v = 0.5 + 0.3 * Math.sin(x * 0.0047 + 1.3) * Math.cos(z * 0.0041 - 0.7)
    + 0.2 * Math.sin((x + z) * 0.0029 + 2.1);
  return smoothstep(0.3, 0.7, v);
}

/** Crater density at a point: depth behind the lines, the world's setting and the lumping. */
function craterDensity(x: number, z: number, u: number): number {
  return devastation(u) * settings.craters * lerp(0.55, 1, shellLump(x, z));
}

// -------------------------------------------------------------------- craters

/** Profile of a crater as a height offset, r normalised to the crater radius. */
function craterProfile(r: number, depth: number, rim: number): number {
  let h = 0;
  if (r < 1) h -= depth * (1 - r * r);
  const t = (r - 0.95) / 0.28;
  h += rim * Math.exp(-t * t);
  return h;
}

/**
 * Height change from the big shell holes and mine craters, metres.
 *
 * Only the craters large enough to register at the terrain's finest vertex
 * spacing are carved; the rest are painted. Cheap where it matters: anywhere
 * further back than the dense crater belt returns after one curve evaluation.
 */
export function craterHeight(x: number, z: number): number {
  if (settings.craters <= 0) return 0;
  const d = frontDistance(x, z);
  const side: 1 | -1 = d >= 0 ? 1 : -1;
  const u = Math.abs(d) - nmlHalf(x, side);
  if (u > 420) return 0;

  let dh = 0;
  const dens = craterDensity(x, z, u);
  if (dens > 0.25) {
    // Heavy shells: the 2x2 cells nearest the sample. Centres are held inside
    // the middle half of each cell and reach at most 0.72 cell, so no crater
    // in any other cell can touch this point.
    const fx = x / C1 - 0.5;
    const fz = z / C1 - 0.5;
    const gx = Math.floor(fx);
    const gz = Math.floor(fz);
    let deepest = 0;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const cx = gx + i;
        const cz = gz + j;
        const h0 = hash01(cx, cz, SALT_C1 + seedSalt);
        if (h0 > dens * 0.9) continue;
        const px = (cx + 0.25 + 0.5 * hash01(cx, cz, SALT_C1 + 1 + seedSalt)) * C1;
        const pz = (cz + 0.25 + 0.5 * hash01(cx, cz, SALT_C1 + 2 + seedSalt)) * C1;
        const R = (0.2 + 0.25 * hash01(cx, cz, SALT_C1 + 3 + seedSalt)) * C1;
        const r = Math.hypot(x - px, z - pz) / R;
        if (r > 1.6) continue;
        const h = craterProfile(r, R * 0.28, R * 0.06);
        if (h < deepest) deepest = h;
        else if (deepest >= 0 && h > dh) dh = h;
      }
    }
    if (deepest < 0) dh = deepest;
  }

  // Mine craters: a handful of enormous ones in no-man's-land.
  if (u < 60) {
    const cx = Math.floor(x / MINE_CELL);
    const m = mineAt(cx);
    if (m !== null) {
      const r = Math.hypot(x - m.x, z - m.z) / m.r;
      if (r < 1.7) dh = Math.min(dh, 0) + craterProfile(r, m.r * 0.34, m.r * 0.12);
    }
  }
  return dh;
}

/** The mine crater of one along-cell, if it has one. Mirrored in GLSL. */
function mineAt(cx: number): { x: number; z: number; r: number } | null {
  if (hash01(cx, 0, SALT_MINE + seedSalt) > 0.38 * settings.craters) return null;
  const mx = (cx + 0.2 + 0.6 * hash01(cx, 1, SALT_MINE + seedSalt)) * MINE_CELL;
  const across = (hash01(cx, 2, SALT_MINE + seedSalt) - 0.5) * settings.width * 0.5;
  const r = 20 + 16 * hash01(cx, 3, SALT_MINE + seedSalt);
  const p = frontPoint(mx, across);
  return { x: p.x, z: p.z, r };
}

/**
 * Whether a point is standing water in a flooded shell hole.
 *
 * Mirrors the shader's flooding rule for the two crater grids, so a bomb that
 * lands where the player sees water throws up water.
 */
function floodedCrater(x: number, z: number): boolean {
  if (settings.flooded <= 0 || settings.craters <= 0) return false;
  const d = frontDistance(x, z);
  const side: 1 | -1 = d >= 0 ? 1 : -1;
  const u = Math.abs(d) - nmlHalf(x, side);
  const dens = craterDensity(x, z, u);
  if (dens < 0.05) return false;
  const wetShare = settings.flooded * 0.45;
  for (const [cell, salt, share, rMin, rSpan] of [
    [C1, SALT_C1, 0.9, 0.2, 0.25], [C2, SALT_C2, 0.62, 0.18, 0.26],
  ] as const) {
    const gx = Math.floor(x / cell - 0.5);
    const gz = Math.floor(z / cell - 0.5);
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const cx = gx + i;
        const cz = gz + j;
        if (hash01(cx, cz, salt + seedSalt) > dens * share) continue;
        if (hash01(cx, cz, salt + 4 + seedSalt) > wetShare) continue;
        const px = (cx + 0.25 + 0.5 * hash01(cx, cz, salt + 1 + seedSalt)) * cell;
        const pz = (cz + 0.25 + 0.5 * hash01(cx, cz, salt + 2 + seedSalt)) * cell;
        const R = (rMin + rSpan * hash01(cx, cz, salt + 3 + seedSalt)) * cell;
        if (Math.hypot(x - px, z - pz) < R * 0.55) return true;
      }
    }
  }
  return false;
}

// -------------------------------------------------------------------- terrain

/**
 * Terrain sampler supplied by the world, so `isWater` can ask about the sea
 * and rivers without this module importing the height field (which imports it).
 */
let waterProbe: (x: number, z: number) => boolean = () => false;

export function setWaterProbe(fn: (x: number, z: number) => boolean): void {
  waterProbe = fn;
}

/** Sea, river, lake or flooded shell hole. */
export function isWater(x: number, z: number): boolean {
  return waterProbe(x, z) || floodedCrater(x, z);
}

/**
 * Flatten the aerodrome pads into the ground. The home field is excluded: the
 * world's own pad around the origin already covers it.
 */
export function aerodromeHeight(x: number, z: number, h: number): number {
  if (pads.length === 0) return h;
  const bucket = padIndex.get(padKey(x, z));
  if (bucket === undefined) return h;
  for (let i = 0; i < bucket.length; i++) {
    const a = bucket[i];
    const t = padWeight(a, x, z);
    if (t < 1) return lerp(a.elevation, h, t);
  }
  return h;
}

/** 0 on the landing ground, 1 once clear of its grading. */
function padWeight(a: Aerodrome, x: number, z: number): number {
  const hr = (a.headingDeg * Math.PI) / 180;
  const dx = x - a.x;
  const dz = z - a.z;
  const dirX = Math.sin(hr);
  const dirZ = -Math.cos(hr);
  const along = Math.abs(dx * dirX + dz * dirZ);
  const across = Math.abs(-dx * dirZ + dz * dirX);
  // The hangar row stands off one edge, so the flat reaches past it.
  const hw = a.halfWidth + 90;
  return Math.max(
    smoothstep(a.halfLength + 30, a.halfLength + 30 + PAD_GRADE, along),
    smoothstep(hw, hw + PAD_GRADE, across),
  );
}

function padKey(x: number, z: number): number {
  const gx = Math.floor(x / PAD_BUCKET);
  const gz = Math.floor(z / PAD_BUCKET);
  return ((gx & 0xffff) << 16) | (gz & 0xffff);
}

function indexPad(a: Aerodrome): void {
  const reach = Math.hypot(a.halfLength + 30 + PAD_GRADE, a.halfWidth + 90 + PAD_GRADE);
  for (let gx = Math.floor((a.x - reach) / PAD_BUCKET); gx <= Math.floor((a.x + reach) / PAD_BUCKET); gx++) {
    for (let gz = Math.floor((a.z - reach) / PAD_BUCKET); gz <= Math.floor((a.z + reach) / PAD_BUCKET); gz++) {
      const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
      const b = padIndex.get(key);
      if (b) b.push(a);
      else padIndex.set(key, [a]);
    }
  }
}

// ------------------------------------------------------------------ aerodromes

function makeAerodrome(
  x: number, z: number, headingDeg: number, elevation: number, side: 1 | -1, main: boolean,
  halfLength: number, halfWidth: number, hangars = 4, parked = 6,
): Aerodrome {
  const a: Aerodrome = {
    x, z, headingDeg, elevation, side, main, hangarSlots: [], parkingSlots: [], halfLength, halfWidth,
  };
  layoutSlots(a, hangars, parked);
  return a;
}

/** Local field frame: `along` the landing direction, `right` of it. */
export function fieldFrame(a: Aerodrome): { dirX: number; dirZ: number; rightX: number; rightZ: number } {
  const hr = (a.headingDeg * Math.PI) / 180;
  const dirX = Math.sin(hr);
  const dirZ = -Math.cos(hr);
  return { dirX, dirZ, rightX: -dirZ, rightZ: dirX };
}

/** World position of a point given in the field frame. */
export function fieldPoint(a: Aerodrome, along: number, right: number): { x: number; z: number } {
  const f = fieldFrame(a);
  return { x: a.x + f.dirX * along + f.rightX * right, z: a.z + f.dirZ * along + f.rightZ * right };
}

/**
 * Hangars in a row along the left edge near the downwind end, doors facing the
 * field; aircraft lined up abreast in front of them, facing the take-off run.
 */
function layoutSlots(a: Aerodrome, hangars: number, parked: number): void {
  const hr = (a.headingDeg * Math.PI) / 180;
  const f = fieldFrame(a);
  // Door toward +right: forward (-sin r, -cos r) = right.
  const doorYaw = Math.atan2(-f.rightX, -f.rightZ);
  const noseYaw = -hr;
  a.hangarSlots = [];
  a.parkingSlots = [];
  const edge = -(a.halfWidth + 26);
  const start = -a.halfLength * 0.55;
  for (let i = 0; i < hangars; i++) {
    const p = fieldPoint(a, start + i * 34, edge);
    a.hangarSlots.push({ x: p.x, z: p.z, rotY: doorYaw });
  }
  const line = -(a.halfWidth - 34);
  const rowStart = start - 8;
  for (let i = 0; i < parked; i++) {
    const p = fieldPoint(a, rowStart + i * 17, line);
    a.parkingSlots.push({ x: p.x, z: p.z, rotY: noseYaw });
  }
}

export function aerodromes(): Aerodrome[] {
  return fields;
}

/** Every field, by hash-grid cell, for the per-vertex field frame. */
let fieldIndex = new Map<number, Aerodrome[]>();
/** How far past its landing ground a field's frame is carried, metres. */
const FIELD_MARGIN = 160;

function indexField(a: Aerodrome): void {
  const reach = Math.hypot(a.halfLength, a.halfWidth + 120) + FIELD_MARGIN;
  for (let gx = Math.floor((a.x - reach) / PAD_BUCKET); gx <= Math.floor((a.x + reach) / PAD_BUCKET); gx++) {
    for (let gz = Math.floor((a.z - reach) / PAD_BUCKET); gz <= Math.floor((a.z + reach) / PAD_BUCKET); gz++) {
      const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
      const b = fieldIndex.get(key);
      if (b) b.push(a);
      else fieldIndex.set(key, [a]);
    }
  }
}

/**
 * The aerodrome frame at a point: metres along the landing direction and to
 * its right, plus the field's half-length and half-width — or null clear of
 * every field. Affine in position, so interpolating it across a terrain
 * triangle is exact and the shader can paint crisp marks from it.
 */
export function fieldLocal(x: number, z: number): [number, number, number, number] | null {
  if (fields.length === 0) return null;
  const bucket = fieldIndex.get(padKey(x, z));
  if (bucket === undefined) return null;
  for (let i = 0; i < bucket.length; i++) {
    const a = bucket[i];
    const f = fieldFrame(a);
    const dx = x - a.x;
    const dz = z - a.z;
    const along = dx * f.dirX + dz * f.dirZ;
    const right = dx * f.rightX + dz * f.rightZ;
    if (Math.abs(along) > a.halfLength + FIELD_MARGIN) continue;
    if (Math.abs(right) > a.halfWidth + 120 + FIELD_MARGIN) continue;
    return [along, right, a.halfLength, a.halfWidth];
  }
  return null;
}

export function homeAerodrome(): Aerodrome {
  return home;
}

export function farAerodrome(): Aerodrome {
  return far;
}

export function balloonAnchors(side: 1 | -1): { x: number; z: number }[] {
  return side > 0 ? anchorsHome : anchorsFar;
}

export function frontTargets(side: 1 | -1): FrontTarget[] {
  return side > 0 ? targetsHome : targetsFar;
}

export function battleSmokeSites(): SmokeSite[] {
  return smoke;
}

// -------------------------------------------------------------------- planning

/** Yaw that turns a model whose front is local -Z to face along (fx, fz). */
export function yawFacing(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

/** Yaw facing straight across the line toward the other side, from `side`. */
function faceAcross(x: number, side: 1 | -1): number {
  const f = frontSlope(x);
  // Home-pointing normal is (-f, 1); the enemy is the other way for side +1.
  return yawFacing(side * f, -side);
}

type Sampler = (x: number, z: number) => number;

/** Height spread over a rotated rectangle, and its mean. */
function spreadOver(
  sample: Sampler, cx: number, cz: number, headingDeg: number, halfL: number, halfW: number,
): { spread: number; mean: number; low: number } {
  const hr = (headingDeg * Math.PI) / 180;
  const dirX = Math.sin(hr);
  const dirZ = -Math.cos(hr);
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  for (let a = -1; a <= 1.001; a += 0.25) {
    for (let b = -1; b <= 1.001; b += 0.5) {
      const al = a * halfL;
      const ac = b * halfW;
      const h = sample(cx + dirX * al - dirZ * ac, cz + dirZ * al + dirX * ac);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      sum += h;
      n++;
    }
  }
  return { spread: hi - lo, mean: sum / n, low: lo };
}

export interface FrontPlanOptions {
  /** Ground before any pad is cut into it. */
  natural: Sampler;
  /** Elevation of the home field. */
  fieldElevation: number;
  /** Whether a point is sea, river or lake (not craters). */
  wet: (x: number, z: number) => boolean;
  seed: number;
}

/**
 * Place the enemy's main aerodrome. Runs before villages and roads, since both
 * route around it, and after rivers, which it has to avoid.
 */
export function planAerodromes(opts: FrontPlanOptions): void {
  const { natural, seed } = opts;
  home = makeAerodrome(0, 0, 0, opts.fieldElevation, 1, true, 470, 300, 4, 6);
  pads = [];
  padIndex = new Map();

  let best: { x: number; z: number; heading: number; mean: number; score: number } | null = null;
  for (let attempt = 0; attempt < 90; attempt++) {
    const x = (hash01(attempt, seed, 1301) - 0.5) * 7000;
    const back = 3700 + hash01(attempt, seed, 1303) * 900;
    const p = frontPoint(x, -(settings.width / 2 + back));
    const fromHome = Math.hypot(p.x, p.z);
    if (fromHome < 6500 || fromHome > 10500) continue;
    for (let k = 0; k < 4; k++) {
      const heading = (hash01(attempt, k, 1307) * 45 + k * 45) % 180;
      // Along the heading and across it; the enemy flies toward home, so the
      // stored heading is the southerly of the two directions.
      const s = spreadOver(natural, p.x, p.z, heading, 470, 330);
      if (s.low < 3) continue;
      let wet = false;
      for (let i = -2; i <= 2 && !wet; i++) {
        for (let j = -2; j <= 2 && !wet; j++) {
          if (opts.wet(p.x + i * 200, p.z + j * 150)) wet = true;
        }
      }
      if (wet) continue;
      const score = s.spread + Math.abs(fromHome - 8200) * 0.004;
      if (best === null || score < best.score) {
        best = { x: p.x, z: p.z, heading: heading < 90 ? heading + 180 : heading, mean: s.mean, score };
      }
    }
    if (best !== null && best.score < 6) break;
  }
  if (best === null) {
    const p = frontPoint(0, -(settings.width / 2 + 4000));
    best = { x: p.x, z: p.z, heading: 180, mean: natural(p.x, p.z), score: 0 };
  }
  far = makeAerodrome(best.x, best.z, best.heading, Math.max(3, best.mean), -1, true, 420, 280, 4, 6);
  pads.push(far);
  indexPad(far);
  fields = [home, far];
  fieldIndex = new Map();
  indexField(home);
  indexField(far);
}

/**
 * Register the minor fields (village strips turned grass fields). They are
 * already flattened by the settlement planner; this only lists them.
 */
export function addMinorAerodromes(strips: { x: number; z: number; headingDeg: number; elevation: number }[]): void {
  for (const s of strips) {
    const side = frontDistance(s.x, s.z) >= 0 ? 1 : -1;
    const a = makeAerodrome(s.x, s.z, s.headingDeg, s.elevation, side, false, 430, 60, 2, 3);
    fields.push(a);
    indexField(a);
  }
}

/** Whether a minor field may go here: well clear of the lines. */
export function stripAllowed(x: number, z: number): boolean {
  if (frontUniforms.uFrontOn.value === 0) return true;
  if (Math.abs(frontDistance(x, z)) < settings.width / 2 + 2600) return false;
  // And off the two main fields.
  if (Math.hypot(x - far.x, z - far.z) < 4500) return false;
  return true;
}

export interface SitePlanOptions {
  /** The finished ground. */
  ground: Sampler;
  seed: number;
  /** Forest cover 0..1 at a point, so winches and gun pits are in the open. */
  forest: (x: number, z: number) => number;
  /** Village centres, to keep sites out of the houses and to burn the ruins. */
  villages: { x: number; z: number; houses: number }[];
  /** Distance to the nearest road, metres (Infinity if none). */
  roadDistance: (x: number, z: number) => { d: number; x: number; z: number; dirX: number; dirZ: number } | null;
}

/** How far along the front the war is planned, each way from x = 0. */
const REACH_ALONG = 14000;

/**
 * Plan everything that stands on the finished ground: winches, guns, dumps,
 * lorry parks, headquarters, and where the smoke rises.
 */
export function planFrontSites(opts: SitePlanOptions): void {
  const { ground, seed } = opts;
  anchorsHome = [];
  anchorsFar = [];
  targetsHome = [];
  targetsFar = [];
  smoke = [];
  if (frontUniforms.uFrontOn.value === 0) return;

  const slope = (x: number, z: number, r: number): number => {
    const h = ground(x, z);
    let worst = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      worst = Math.max(worst, Math.abs(ground(x + dx * r, z + dz * r) - h));
    }
    return worst / r;
  };
  const nearVillage = (x: number, z: number, gap: number): boolean =>
    opts.villages.some((v) => Math.hypot(v.x - x, v.z - z) < gap);
  const nearField = (x: number, z: number, gap: number): boolean =>
    fields.some((a) => Math.hypot(a.x - x, a.z - z) < gap + a.halfLength);
  const open = (x: number, z: number, r: number, maxSlope: number): boolean =>
    !isWater(x, z) && opts.forest(x, z) < 0.25 && slope(x, z, r) < maxSlope
    && ground(x, z) > 1.5;

  for (const side of [1, -1] as const) {
    const out = side > 0 ? targetsHome : targetsFar;
    const anchors = side > 0 ? anchorsHome : anchorsFar;
    const salt = seed * 31 + (side > 0 ? 0 : 5000);
    /** A point `u` metres behind this side's no-man's-land edge. */
    const behind = (x: number, u: number): { x: number; z: number } =>
      frontPoint(x, side * (nmlHalf(x, side) + u));

    // ---------------------------------------------------- machine-gun nests
    // On the fire trench itself, about every kilometre.
    for (let s = -REACH_ALONG; s <= REACH_ALONG; s += 1000) {
      const x = s + (hash01(s, 1, salt + 1) - 0.5) * 600;
      const p = behind(x, FIRE_BACK);
      if (isWater(p.x, p.z) || slope(p.x, p.z, 12) > 0.6) continue;
      out.push({ kind: 'mgnest', x: p.x, z: p.z, rotY: faceAcross(x, side) + (hash01(s, 2, salt) - 0.5) * 0.5 });
    }

    // ----------------------------------------------------- kite balloons
    // One winch every five or six kilometres, 1.5–2.5 km back, in the open.
    const along = [-11000, -5500, 0, 5500, 11000];
    for (let i = 0; i < along.length && anchors.length < 5; i++) {
      for (let attempt = 0; attempt < 24; attempt++) {
        const x = along[i] + (hash01(i, attempt, salt + 11) - 0.5) * 3000;
        const u = 1500 + hash01(i, attempt, salt + 12) * 1000;
        const p = behind(x, u);
        if (!open(p.x, p.z, 40, 0.14)) continue;
        if (nearVillage(p.x, p.z, 450) || nearField(p.x, p.z, 300)) continue;
        if ((opts.roadDistance(p.x, p.z)?.d ?? Infinity) < 30) continue;
        anchors.push({ x: p.x, z: p.z });
        break;
      }
    }

    // ------------------------------------------------ artillery batteries
    // Four guns abreast, 22 m apart, 1–3 km behind the fire trench.
    let batteries = 0;
    for (let i = 0; i < 40 && batteries < 8; i++) {
      const x = -REACH_ALONG + ((i * 0.618034) % 1) * 2 * REACH_ALONG + (hash01(i, 3, salt + 21) - 0.5) * 1500;
      const u = 1000 + hash01(i, 4, salt + 22) * 2000;
      const c = behind(x, u);
      if (!open(c.x, c.z, 45, 0.12)) continue;
      if (nearVillage(c.x, c.z, 350) || nearField(c.x, c.z, 250)) continue;
      if (out.some((t) => t.kind === 'artillery' && Math.hypot(t.x - c.x, t.z - c.z) < 2200)) continue;
      // The line of guns runs along the front; they all face the enemy.
      const slopeX = frontSlope(c.x);
      const len = Math.hypot(1, slopeX);
      const ax = 1 / len;
      const az = slopeX / len;
      let ok = true;
      const guns: FrontTarget[] = [];
      for (let g = 0; g < 4; g++) {
        const off = (g - 1.5) * 22;
        const gx = c.x + ax * off;
        const gz = c.z + az * off;
        if (isWater(gx, gz) || slope(gx, gz, 10) > 0.2) { ok = false; break; }
        guns.push({ kind: 'artillery', x: gx, z: gz, rotY: faceAcross(c.x, side) });
      }
      if (!ok) continue;
      out.push(...guns);
      batteries++;
    }

    // ------------------------------------------------------ anti-aircraft
    // Two round each winch, and two at each main aerodrome on this side.
    anchors.forEach((a, i) => {
      for (let k = 0; k < 2; k++) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const ang = hash01(i * 7 + k, attempt, salt + 31) * Math.PI * 2;
          const r = 260 + hash01(i * 7 + k, attempt, salt + 32) * 160;
          const x = a.x + Math.cos(ang) * r;
          const z = a.z + Math.sin(ang) * r;
          if (!open(x, z, 12, 0.25)) continue;
          out.push({ kind: 'aagun', x, z, rotY: faceAcross(x, side) });
          break;
        }
      }
    });
    for (const f of fields) {
      if (!f.main || f.side !== side) continue;
      for (const [al, ri] of [[f.halfLength + 110, f.halfWidth * 0.3], [-f.halfLength * 0.2, f.halfWidth + 170]]) {
        const p = fieldPoint(f, al, ri);
        if (isWater(p.x, p.z)) continue;
        out.push({ kind: 'aagun', x: p.x, z: p.z, rotY: faceAcross(p.x, side) });
      }
    }

    // ------------------------------------------- dumps, lorries, headquarters
    const beside = (kind: FrontTargetKind, count: number, uMin: number, uMax: number, saltK: number, gap: number): void => {
      let placed = 0;
      for (let i = 0; i < 60 && placed < count; i++) {
        const x = (hash01(i, 5, salt + saltK) - 0.5) * 2 * REACH_ALONG;
        const u = uMin + hash01(i, 6, salt + saltK) * (uMax - uMin);
        const c = behind(x, u);
        // Beside a road where there is one near: that is where the traffic is.
        const road = opts.roadDistance(c.x, c.z);
        let x0 = c.x;
        let z0 = c.z;
        let yaw = hash01(i, 7, salt + saltK) * Math.PI * 2;
        if (road !== null && road.d < 700) {
          const nx = -road.dirZ;
          const nz = road.dirX;
          const sgn = hash01(i, 8, salt + saltK) < 0.5 ? -1 : 1;
          x0 = road.x + nx * 28 * sgn;
          z0 = road.z + nz * 28 * sgn;
          yaw = yawFacing(road.dirX, road.dirZ);
        } else if (kind === 'lorry') {
          continue;
        }
        if (!open(x0, z0, 25, 0.15)) continue;
        if (nearVillage(x0, z0, kind === 'hq' ? 0 : 180) || nearField(x0, z0, 150)) continue;
        if (out.some((t) => t.kind === kind && Math.hypot(t.x - x0, t.z - z0) < gap)) continue;
        out.push({ kind, x: x0, z: z0, rotY: yaw });
        placed++;
      }
    };
    beside('dump', 5, 2500, 6000, 41, 2500);
    beside('lorry', 5, 1800, 6500, 51, 2500);
    beside('hq', 2, 4500, 8500, 61, 5000);

    // HQ prefers a village (a requisitioned château): move it into the nearest
    // intact one within reach.
    for (const t of out) {
      if (t.kind !== 'hq') continue;
      let best: { x: number; z: number } | null = null;
      let bestD = 2500;
      for (const v of opts.villages) {
        const dd = Math.hypot(v.x - t.x, v.z - t.z);
        if (dd < bestD && behindLines(v.x, v.z) > 4000 && frontDistance(v.x, v.z) * side > 0) {
          bestD = dd;
          best = v;
        }
      }
      if (best !== null) {
        const p = { x: best.x + 70, z: best.z + 40 };
        if (open(p.x, p.z, 15, 0.3)) { t.x = p.x; t.z = p.z; }
      }
    }
  }

  // ---------------------------------------------------------------- smoke
  // Ruins burning near the line, and a shelling spot every kilometre or two.
  for (const v of opts.villages) {
    const u = behindLines(v.x, v.z);
    if (u > 2000 || Math.abs(v.x) > REACH_ALONG + 4000) continue;
    smoke.push({ x: v.x, z: v.z, strength: clamp(1 - u / 2000, 0.25, 1) * 0.8 });
  }
  for (let s = -REACH_ALONG; s <= REACH_ALONG; s += 1400) {
    const x = s + (hash01(s, 9, seed + 71) - 0.5) * 900;
    const across = (hash01(s, 10, seed + 72) - 0.5) * (settings.width + 500);
    const p = frontPoint(x, across);
    if (isWater(p.x, p.z)) continue;
    smoke.push({ x: p.x, z: p.z, strength: 0.3 + hash01(s, 11, seed + 73) * 0.7 });
  }
}

// ----------------------------------------------------------------------- GLSL

/**
 * The shader half of this module: the same curve, wobble, density and hash,
 * written once here beside their CPU twins so the two cannot drift apart.
 */
export const FRONT_GLSL = /* glsl */ `
uniform float uFrontBase;
uniform vec4 uFrontA;
uniform vec4 uFrontK;
uniform vec4 uFrontP;
uniform vec4 uFrontCfg;
uniform vec3 uWobHome;
uniform vec3 uWobFar;
uniform float uFrontOn;
uniform float uFrontSalt;

float bfFrontZ(float x) {
  vec4 a = uFrontK * x + uFrontP;
  return uFrontBase + dot(uFrontA, sin(a));
}
float bfFrontSlope(float x) {
  vec4 a = uFrontK * x + uFrontP;
  return dot(uFrontA * uFrontK, cos(a));
}
float bfEdge(float s, float side) {
  vec3 q = side > 0.0 ? uWobHome : uWobFar;
  return 11.0 * sin(s * 0.0047 + q.x) + 6.0 * sin(s * 0.0131 + q.y) + 3.0 * sin(s * 0.037 + q.z);
}
float bfDensity(float u) {
  if (u <= 0.0) return 1.0;
  return 0.95 * exp(-u / 380.0) + 0.06 * (1.0 - smoothstep(1000.0, 2800.0, u));
}
float bfLump(vec2 p) {
  float v = 0.5 + 0.3 * sin(p.x * 0.0047 + 1.3) * cos(p.y * 0.0041 - 0.7)
          + 0.2 * sin((p.x + p.y) * 0.0029 + 2.1);
  return smoothstep(0.3, 0.7, v);
}
uint bfHashU(ivec2 c, uint salt) {
  uint h = uint(c.x) * 374761393u + uint(c.y) * 668265263u + salt * 2246822519u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return h;
}
float bfHash(ivec2 c, uint salt) {
  return float(bfHashU(c, salt)) / 4294967296.0;
}
`;

/** Salts and cells the shader needs as literals. */
export const FRONT_CONSTS = {
  C1, C2, SALT_C1, SALT_C2, SALT_MINE, MINE_CELL, FIRE_BACK,
};
