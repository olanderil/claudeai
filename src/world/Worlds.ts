import { fbm, noise2, ridged } from '../util/noise';
import { clamp, lerp, smoothstep } from '../util/math';
import { airstripHeight, airstrips, planSettlements, settlements } from './Settlements';
import { addCanal, addRiverPath, carveRivers, carveTarns, planRivers, riverStrength, type RiverSettings } from './Rivers';
import { planBoats } from './Boats';
import { planStructures } from './Structures';
import {
  addMinorAerodromes, aerodromeClearing, aerodromeHeight, aerodromes, behindLines, craterHeight, frontDistance, frontZ, farAerodrome,
  homeAerodrome, planAerodromes, planFrontSites, setFront, setGroundProbe, setWaterProbe, stripAllowed, type FrontSettings,
} from './Front';
import { forestCover, setForestStyle } from './Forest';
import { nearestRoad, planRoads, roadValidity, setWaterways, waterSignedDistance } from './Roads';
import { farmland, farmlandHome } from './Settlements';
import { SEA_LEVEL } from './Sea';

/** Ground palette and snow line for a world, before the season modifies it. */
export interface TerrainStyle {
  grass: [number, number, number];
  dry: [number, number, number];
  rock: [number, number, number];
  snowLine: number;
  /**
   * Altitude where vegetation gives way to bare ground, metres. Per-world: a
   * fixed band is right for a lowland front and wrong in the Dolomites.
   */
  treeLine: number;
  /** The sea, as deep water / shallow water / wet sand. Temperate coast if omitted. */
  water?: { deep: number; shallow: number; sand: number; glow?: number };
  /** Strength of horizontal rock banding, 0 = none. */
  strata: number;
  /**
   * How wooded the world is, 0..1. Derived from the grass colour when left
   * out; stated where the palette would guess wrong.
   */
  wooded?: number;
  /** Height below which the ground is beach sand, metres. Defaults by coast. */
  beach?: number;
  /** Bare limestone breaking through thin soil, 0..1. */
  stony?: number;
  /**
   * How readily bare rock shows on a slope, 0..1: at 1 a thirty-degree bank
   * is already bare — chalk bluffs, raw gully walls. Defaults to 0, where it
   * takes a cliff.
   */
  bluffs?: number;
}

/** Which kinds of tree grow here, as relative shares of the scatter. */
export interface TreePalette {
  broadleaf: number;
  conifer: number;
  poplar: number;
  palm: number;
  shrub: number;
}

export interface WorldPreset {
  name: string;
  blurb: string;
  /** Elevation of the home aerodrome's flat ground, metres. */
  fieldElevation: number;
  /** Whether the sea is visible at all. */
  hasOcean: boolean;
  /** Always true now: every front has a home aerodrome. Kept for main.ts. */
  hasAirfield?: boolean;
  /**
   * Landing direction of the home field, degrees. North–south by default; a
   * field on the floor of an east–west valley has to lie along it.
   */
  homeHeading?: number;
  /** Where the aircraft starts. Defaults to the south end of the home field. */
  spawn?: { x: number; z: number; heading: number };
  /** Whether period sailing craft belong on this world's sea. */
  hasSailboats?: boolean;
  /** Whether lighthouses, castles, forts and monasteries appear. */
  hasLandmarks?: boolean;
  /** Per-kind multiplier on each landmark's chance. */
  landmarkDensity?: Partial<Record<string, number>>;
  /** Whether the world is inhabited. */
  hasVillages?: boolean;
  /** River network, or omitted for a world that is dry on purpose. */
  rivers?: RiverSettings;
  /** Spacing of the village placement grid, metres. */
  villageSpacing?: number;
  /** The roughest ground villages may be sited on (see `planSettlements`). */
  villageTier?: number;
  /** Flat-roofed houses (the Levant), rather than pitched roofs. */
  flatRoofs?: boolean;
  /** Share of red-brick buildings, 0..1 — Flanders and Artois were built of it. */
  brick?: number;
  /** Share of roads lined with trees, 0..1. */
  roadTrees?: number;
  /** Steepest average grade a road will take (default 0.14). Downland roads
   *  go straight down into the valleys. */
  roadGrade?: number;
  /** How much of the open country is laid out in fields, 0..1. */
  farmland?: number;
  /** Share of field boundaries grown up as hedgerows and tree lines, 0..1. */
  hedges?: number;
  /** How many canals cross the country (needs `rivers`). */
  canals?: number;
  /** Whether the sector has a market town behind the home lines. */
  town?: boolean;
  /**
   * Rivers laid down valleys the height field was built around, downstream
   * order, on top of the traced ones. Read after the front and the seed's
   * layout are set.
   */
  channels?: () => { pts: [number, number, number][]; widthNear: number; widthFar: number }[];
  /** The first canal's course, where the world has one in mind. */
  canalRoute?: () => [number, number][];
  /** The front line through this world. */
  front?: FrontSettings;
  /** Tree kinds, for the 3D scatter. */
  trees?: TreePalette;
  style: TerrainStyle;
  /**
   * Raw elevation before the aerodrome pad is blended in. `sx`/`sz` carry the
   * seed offset; `d` is the *unseeded* distance from the origin, so terms that
   * must stay anchored to the home field use it.
   */
  height(sx: number, sz: number, d: number): number;
}

/**
 * Least height a shoreline stands above the water, metres. Both sides are held
 * clear of y = 0 so the coast never lies coplanar with the sea and flickers.
 */
const SHORE_STEP = 4;

/**
 * The home field's flat ground. A 1917 aerodrome is a grass field under a
 * kilometre long, not a jet runway, so the pad is far smaller than it was — the
 * country starts rolling again well short of the lines.
 */
const FIELD_RADIUS = 1150;
const FIELD_FALLOFF = 3300;

/** Deterministic [0,1) per integer cell. */
function cellRandom(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// --------------------------------------------------------------------- shapes

/**
 * Ridged multifractal noise, 0..1, with every octave turned against the last.
 *
 * Plain ridged noise stacks its octaves on one lattice, and from the air the
 * crests line up with it: mountains in rows and squares. Rotating each octave
 * breaks the grid for the price of four multiplies. Each octave is also
 * weighted by the one before, so detail gathers on the crests and the valleys
 * between stay smooth — which is what makes a range look eroded rather than
 * crumpled.
 */
function ridgedTurned(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(noise2(x, y));
    n *= n;
    n *= weight;
    weight = n * 1.6 > 1 ? 1 : n * 1.6;
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    const nx = (x * 0.8 - y * 0.6) * 2.03 + 17.3;
    y = (x * 0.6 + y * 0.8) * 2.03 - 5.1;
    x = nx;
  }
  return sum / norm;
}

/** fBm with each octave turned, for the same reason. Roughly −1..1. */
function fbmTurned(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y) * amp;
    norm += amp;
    amp *= 0.5;
    const nx = (x * 0.8 - y * 0.6) * 2.03 + 11.7;
    y = (x * 0.6 + y * 0.8) * 2.03 + 3.9;
    x = nx;
  }
  return sum / norm;
}

/** Fractional part, for sawtooth profiles. */
function fract(v: number): number {
  return v - Math.floor(v);
}

/** 1 on a thin winding line where a noise crosses zero, 0 away from it. */
function vein(n: number, lo: number, hi: number): number {
  return smoothstep(lo, hi, 1 - Math.abs(n));
}

/**
 * Hills on the skyline: country that rises well outside the sector, so the
 * horizon is never a ruled line. On a flat world only ground higher than the
 * eye stands against the sky, so these have to be real hills — peaks up to
 * `height` — to show from a few hundred metres up. Free inside `start`, which
 * is where every height sample the game actually flies over is taken.
 */
function farHills(sx: number, sz: number, d: number, start: number, full: number, height: number): number {
  if (d < start) return 0;
  const t = smoothstep(start, full, d + fbm(sx * 0.00003 + 4.1, sz * 0.00003 - 2.7, 2) * 4000);
  if (t <= 0) return 0;
  return t * (0.22 + 0.78 * Math.pow(ridgedTurned(sx * 0.00004 + 8.3, sz * 0.00004 - 1.9, 4), 0.8)) * height;
}

/** A round hill: flat-shouldered, smooth-footed, 0..1 at `r` over radius `R`. */
function knoll(r: number, R: number): number {
  if (r >= R) return 0;
  const t = r / R;
  const u = 1 - t * t;
  return u * u;
}

/**
 * Where each world's set pieces stand for this seed — which flank the spur
 * runs down, where the Kemmel of this sector rises, which way the Ancre
 * comes in. Chosen once per seed so the height field only reads numbers.
 */
const L = {
  s1: 1, s2: 1,
  p1: 0, p2: 0, p3: 0, p4: 0,
  /** Flanders: the Monts, as x, z, radius, height. */
  monts: [] as { x: number; z: number; r: number; h: number }[],
  spurX: 8000,
  sommeZ0: 6500,
  ancreX0: 4800,
  /** Where the Ancre runs into the Somme. */
  joinX: 4800,
  joinZ: 6500,
  galZ: -6300,
  /** Alps: the two massifs flanking the pass, x and z of each. */
  alpsPeaks: [5600, -4800, -5600, -4800],
  scarpX: 8000,
};

function planLayout(): void {
  const r = (k: number): number => cellRandom(currentSeed, 77, 900 + k);
  L.s1 = r(1) < 0.5 ? -1 : 1;
  L.s2 = r(2) < 0.5 ? -1 : 1;
  L.p1 = r(3) * Math.PI * 2;
  L.p2 = r(4) * Math.PI * 2;
  L.p3 = r(5) * Math.PI * 2;
  L.p4 = r(6) * Math.PI * 2;
  // Flanders. The Messines spur comes down one flank of the sector, the
  // Monts de Flandre stand behind the home lines on the other.
  L.spurX = L.s1 * (7200 + r(7) * 2200);
  const kx = -L.s1 * (5600 + r(8) * 2000);
  const kz = 900 + r(9) * 1400;
  L.monts = [{ x: kx, z: kz, r: 2100, h: 300 + r(10) * 25 }];
  const heights = [175, 140, 105];
  for (let i = 0; i < heights.length; i++) {
    const along = -L.s1 * (i + 1) * (2500 + r(11 + i) * 900);
    L.monts.push({
      x: kx + along, z: kz + (r(15 + i) - 0.5) * 1800 + 400 * (i + 1),
      r: 1200 + r(19 + i) * 500, h: heights[i] * (0.85 + r(23 + i) * 0.3),
    });
  }
  // The Somme and the Ancre.
  L.sommeZ0 = 6400 + r(27) * 1200;
  L.ancreX0 = L.s2 * (4400 + r(28) * 1400);
  // The confluence: where the Ancre's own course meets the Somme's.
  let zj = L.sommeZ0;
  for (let i = 0; i < 8; i++) zj = sommeZ(ancreX(zj));
  L.joinZ = zj;
  L.joinX = ancreX(zj);
  // Gallipoli: the heights, on the far side of the line.
  L.galZ = -5700 - r(29) * 600;
  // Alps: the massifs either side of the pass, on or near the line.
  for (let i = 0; i < 2; i++) {
    const x = (i === 0 ? 1 : -1) * (5300 + r(31 + i) * 1100);
    L.alpsPeaks[i * 2] = x;
    L.alpsPeaks[i * 2 + 1] = frontZ(x) + (r(33 + i) - 0.5) * 1400;
  }
  // Sinai: the escarpment, off to the east (the sea is west).
  L.scarpX = 7600 + r(30) * 2000;
}

// --------------------------------------------------------------------- worlds

/**
 * Flanders: drowned polder a few metres above the water table, with the
 * ridges every attack was made for — a long Passchendaele crest across the
 * far side of the lines, a Messines spur running down one flank, and behind
 * the home lines the Monts de Flandre, Kemmel the tallest of them. The North
 * Sea lies far off to the north-west.
 *
 * Heights are exaggerated two or three times over the real thing: sixty
 * metres of ridge is a whole campaign on the ground and nothing at all from
 * a thousand metres up.
 */
function flandersHeight(sx: number, sz: number, d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const plain = 11 + fbm(sx * 0.00007, sz * 0.00007, 3) * 7 + fbm(sx * 0.00045, sz * 0.00045, 2) * 2.2;

  // The main ridge: broad-backed, a steeper face toward the home lines, its
  // width swelling into spurs and pinching into re-entrants along its length.
  const crest = -5300 + px * 0.09 + fbm(px * 0.00006 + 3.1, 7.7, 2) * 2200;
  const across = pz - crest;
  const lobes = fbm(sx * 0.00032 + 1.7, sz * 0.00032 - 4.2, 2);
  const half = (across > 0 ? 1500 : 2600) * (1 + 0.5 * lobes);
  const s = clamp(1 - Math.abs(across) / half, 0, 1);
  const crestH = 112 + fbm(px * 0.00011 + 5.3, 2.3, 2) * 50;
  let ridge = crestH * s * s * (3 - 2 * s);

  // The spur, from the crest down toward the home lines.
  const spurAlong = clamp(across / 4200, 0, 1);
  const spurOff = Math.abs(px - L.spurX - across * 0.22 * L.s1) / (1500 * (1 - 0.4 * spurAlong));
  if (across > -600 && spurOff < 1) {
    const k = 1 - spurOff;
    ridge = Math.max(ridge, k * k * (3 - 2 * k) * lerp(crestH * 0.8, 30, spurAlong) * smoothstep(-600, 200, across));
  }

  // Beeks: little stream valleys notched into the flanks.
  if (ridge > 8) ridge *= 1 - 0.38 * vein(fbm(sx * 0.00026 + 7.7, sz * 0.00026 - 2.2, 2), 0.72, 0.96);

  // The Monts: steep-sided, isolated, wooded.
  let hills = 0;
  for (let i = 0; i < L.monts.length; i++) {
    const m = L.monts[i];
    const dx = px - m.x;
    const dz = pz - m.z;
    if (Math.abs(dx) > m.r * 1.3 || Math.abs(dz) > m.r * 1.3) continue;
    const wob = 1 + 0.22 * fbm(sx * 0.0007 + i, sz * 0.0007, 2);
    hills = Math.max(hills, knoll(Math.hypot(dx, dz), m.r * wob) * m.h);
  }

  const land = plain + ridge + hills + farHills(sx, sz, d, 18000, 32000, 750);

  // The coast, twenty-odd kilometres to the north-west: dunes, then sand.
  const q = -(px + pz) * 0.7071 + fbm(sx * 0.00004, sz * 0.00004, 2) * 3500;
  if (q < 21000) return land;
  const dunes = Math.pow(Math.max(0, ridged(sx * 0.0012, sz * 0.0012, 2)), 2) * 14;
  if (q < 24500) return lerp(land, SHORE_STEP + 3 + dunes, smoothstep(21000, 24000, q));
  return -6 - smoothstep(24500, 30000, q) * 30;
}

/** Centre of the Somme valley at x (it runs east–west behind the home lines). */
function sommeZ(x: number): number {
  return L.sommeZ0 + 900 * Math.sin(x * 0.00019 + L.p1) + 380 * Math.sin(x * 0.00061 + L.p2);
}
function sommeSlope(x: number): number {
  return 900 * 0.00019 * Math.cos(x * 0.00019 + L.p1) + 380 * 0.00061 * Math.cos(x * 0.00061 + L.p2);
}
/** The Somme's water level: it falls to the west. */
function sommeFloor(x: number): number {
  return 46 + x * 0.0007;
}
/** Centre of the Ancre at z (it comes down from the north through the lines). */
function ancreX(z: number): number {
  return L.ancreX0 + 650 * Math.sin(z * 0.00023 + L.p3) + 260 * Math.sin(z * 0.00071 + L.p4);
}
function ancreSlope(z: number): number {
  return 650 * 0.00023 * Math.cos(z * 0.00023 + L.p3) + 260 * 0.00071 * Math.cos(z * 0.00071 + L.p4);
}
/** The Ancre's floor, climbing north from where it meets the Somme. */
function ancreFloor(z: number): number {
  return sommeFloor(L.joinX) + Math.max(0, L.joinZ - z) * 0.0032;
}

/** The larger of two values with the corner rounded over about `k`. */
function smoothMax(a: number, b: number, k: number): number {
  const d = a - b;
  return (a + b + Math.sqrt(d * d + k * k)) * 0.5;
}

/** Valley cross-section: 1 on a flat floor of half-width `half`, 0 past a wall `wall` wide. */
function valleyMask(dist: number, half: number, wall: number): number {
  return 1 - smoothstep(half, half + wall, dist);
}

/**
 * The Somme: chalk downland. Long smooth ridges between steep-sided dry
 * valleys, and two river valleys cut a hundred and fifty metres down through
 * it with white chalk in their bluffs — the Somme behind the home lines and
 * the Ancre coming down through the front to join it.
 */
function sommeHeight(sx: number, sz: number, d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  // Long swells, drawn out along the WNW–ESE grain of the country.
  const u = sx * 0.94 + sz * 0.34;
  const v = -sx * 0.34 + sz * 0.94;
  const swell = fbm(u * 0.00005 + 5, v * 0.00014 - 3, 3) * 120;
  const downs = (fbm(sx * 0.00019, sz * 0.00019, 3) * 0.5 + 0.5) * 80;
  let h = 150 + swell + downs + fbm(sx * 0.0009, sz * 0.0009, 2) * 3;
  // Dry valleys: flat-bottomed, steep-sided, a big network and a finer one.
  const cut1 = vein(fbm(sx * 0.00012 + 17, sz * 0.00012 - 4, 3) * 2, 0.8, 0.95) * 90;
  const cut2 = vein(fbm(sx * 0.00031 - 3, sz * 0.00031 + 8, 2) * 2, 0.78, 0.97) * 34;
  h -= cut1 + cut2;
  // Nothing in the chalk lies lower than the rivers draining it: a dry valley
  // bottoms out on the Somme's level rather than sinking into a pit.
  h = smoothMax(h, sommeFloor(px) + 6, 24);
  h += farHills(sx, sz, d, 18000, 32000, 850);

  // The river valleys.
  // (Both centrelines wander a bounded distance, so most samples skip them.)
  if (Math.abs(pz - L.sommeZ0) < 2500) {
    const dS = Math.abs(pz - sommeZ(px)) / Math.sqrt(1 + sommeSlope(px) ** 2);
    if (dS < 1100) h = lerp(h, Math.min(h, sommeFloor(px)), valleyMask(dS, 650, 360));
  }
  const join = L.joinZ;
  if (pz < join + 400 && Math.abs(px - L.ancreX0) < 1700) {
    const dA = Math.abs(px - ancreX(pz)) / Math.sqrt(1 + ancreSlope(pz) ** 2);
    if (dA < 700) h = lerp(h, Math.min(h, ancreFloor(pz)), valleyMask(dA, 280, 320) * smoothstep(join + 400, join - 200, pz));
  }
  return h;
}

/** The Somme and the Ancre as polylines, downstream order, on their own floors. */
function sommeChannels(): { pts: [number, number, number][]; widthNear: number; widthFar: number }[] {
  const somme: [number, number, number][] = [];
  for (let x = 30000; x >= -30000; x -= 400) somme.push([x, sommeZ(x), sommeFloor(x)]);
  const ancre: [number, number, number][] = [];
  for (let z = -26000; z < L.joinZ; z += 400) ancre.push([ancreX(z), z, ancreFloor(z)]);
  ancre.push([L.joinX, L.joinZ, ancreFloor(L.joinZ)]);
  return [
    { pts: somme, widthNear: 26, widthFar: 34 },
    { pts: ancre, widthNear: 12, widthFar: 22 },
  ];
}

/** The Canal de la Somme, beside the river on its valley floor. */
function sommeCanal(): [number, number][] {
  const pts: [number, number][] = [];
  for (let x = -26000; x <= 26000; x += 1300) pts.push([x, sommeZ(x) + 330]);
  return pts;
}

/**
 * Verdun: the Côtes de Meuse. A limestone plateau cut by steep, wooded
 * ravines, falling west into the broad Meuse valley and east over the scarp
 * of the Côtes to the flat Woëvre.
 */
function verdunHeight(sx: number, sz: number, d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const plateau = 296 + fbm(sx * 0.00008, sz * 0.00008, 3) * 52
    + Math.pow(Math.max(0, ridged(sx * 0.00014 + 3, sz * 0.00014 - 8, 3) - 0.45), 1.3) * 175;
  // Ravines: the vein trick, deep and narrow — these are the "ravins" every
  // attack went up.
  const cut = vein(fbm(sx * 0.00016 + 3, sz * 0.00016 - 11, 3) * 2.1, 0.68, 0.94) * 150;
  let high = plateau - cut + farHills(sx, sz, d, 19000, 33000, 950);
  // The scarp of the Côtes, and the Woëvre plain below it (east of where the
  // scarp's bounded wander can reach, and nowhere else).
  if (px > 9700) {
    const scarpAt = 12500 + fbm(pz * 0.00009 + 2.2, 4.4, 2) * 2600;
    const scarp = smoothstep(scarpAt - 200, scarpAt + 700, px);
    if (scarp > 0) high = lerp(high, 214 + noise2(sx * 0.0002, sz * 0.0002) * 6 + farHills(sx, sz, d, 19000, 33000, 600), scarp);
  }
  // The Meuse: a wide flat valley meandering north–south east of the field.
  const meander = fbm(pz * 0.00005 + 7, 1.3, 2) * 3200;
  const toRiver = Math.abs(px - 6500 - meander);
  const valley = 1 - smoothstep(650, 2100, toRiver);
  if (valley <= 0) return high;
  const floor = 192 + fbm(sx * 0.0003, sz * 0.0003, 2) * 4;
  return lerp(high, floor, valley);
}

/** Karst dolines: round sinkholes pocking the plateau, returned as a depth. */
function dolines(sx: number, sz: number): number {
  const CELL = 250;
  const gx = Math.floor(sx / CELL - 0.5);
  const gz = Math.floor(sz / CELL - 0.5);
  let deepest = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const cx = gx + i;
      const cz = gz + j;
      if (cellRandom(cx, cz, 401) > 0.58) continue;
      const x = (cx + 0.25 + 0.5 * cellRandom(cx, cz, 402)) * CELL;
      const z = (cz + 0.25 + 0.5 * cellRandom(cx, cz, 403)) * CELL;
      const r = 32 + cellRandom(cx, cz, 404) * 50;
      const t = Math.hypot(sx - x, sz - z) / r;
      if (t >= 1) continue;
      const depth = (1 - t * t) * (1 - t * t) * r * 0.24;
      if (depth > deepest) deepest = depth;
    }
  }
  return deepest;
}

/**
 * The Isonzo: the Carso, a stony limestone plateau pocked with dolines,
 * rising in scarps from the Adriatic plain in the south-west, with the Julian
 * Alps the enemy holds standing over the northern horizon.
 */
function isonzoHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  // Distance toward the south-west coast.
  const q = -0.6 * px + 0.8 * pz + fbm(sx * 0.00006, sz * 0.00006, 3) * 2600;
  // The plateau climbs in a series of scarps toward the north-east.
  const inland = clamp((-q + 3000) / 16000, 0, 1.4);
  const scarp = smoothstep(0.08, 0.18, inland) * 150 + smoothstep(0.34, 0.46, inland) * 140;
  const plateau = 38 + scarp + inland * 105
    + fbm(sx * 0.00022, sz * 0.00022, 3) * 26
    + Math.pow(Math.max(0, ridged(sx * 0.00016 + 7, sz * 0.00016 - 1, 3) - 0.5), 1.3) * 240 * smoothstep(0.2, 0.6, inland);
  // The mountains north of the lines: Monte Santo and the Julian Alps.
  const north = smoothstep(-8000, -17500, pz);
  const mountains = north > 0
    ? north * (Math.pow(ridgedTurned(sx * 0.00007 + 41, sz * 0.00007 - 3, 5), 1.15) * 2100 + 260)
    : 0;
  const pits = dolines(sx, sz) * smoothstep(0.14, 0.3, inland);
  const land = plateau + mountains - pits;
  // The Adriatic.
  if (q < 8200) return land;
  if (q < 9400) return lerp(land, SHORE_STEP + 1, smoothstep(8200, 9400, q));
  return -5 - smoothstep(9400, 14000, q) * 38;
}

/**
 * 1 over the ground behind the far lines where the enemy's aerodrome is
 * looked for, 0 away from it. Worlds with no flat ground to speak of calm
 * their roughness here — a plain in the dunes, a plateau behind the heights —
 * so the field has somewhere believable to sit.
 */
function farFieldCalm(px: number, pz: number, width: number): number {
  const vz = pz - frontZ(px);
  const mid = -(width / 2 + 4150);
  return (1 - smoothstep(700, 1500, Math.abs(vz - mid))) * (1 - smoothstep(5500, 8000, Math.abs(px)));
}

/**
 * Gallipoli: scrub ridges and sheer gullies. The Sari Bair heights run
 * across the far side of the line, four and five hundred metres of them,
 * their seaward spurs split by ravines; the home side is lower, broken
 * scrub country falling to the Aegean in cliffs and coves. Imbros stands
 * out to sea in the west, and across the straits to the south the hills of
 * Asia.
 */
function gallipoliHeight(sx: number, sz: number, d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  // Distance to the sea, west and south. Only worked out near enough to it to
  // matter: the coast noise is bounded, so well inland it cannot be close.
  let coast = 1e5;
  if (px < -3700) coast = px + 7500 + fbm(sz * 0.0001, 3.3, 3) * 2400;
  if (pz > 8600) coast = Math.min(coast, 12500 - pz + fbm(sx * 0.0001, 8.1, 3) * 2200);
  // The hills come right down to the water: that is what makes the cliffs.
  const inland = smoothstep(-100, 500, coast);
  const calm = Math.abs(px) < 8000 ? farFieldCalm(px, pz, 160) : 0;

  // Razorback scrub ridges everywhere, rougher inland.
  const hills = Math.pow(ridgedTurned(sx * 0.00019 + 5, sz * 0.00019 - 2, 4), 0.7) * 330 * (1 - 0.55 * calm);
  // The heights: a crest across the far side of the line with summits along
  // it, a steep face toward the home lines and a long back slope.
  const crestZ = L.galZ + px * 0.12 * L.s1 + 700 * Math.sin(px * 0.00017 + L.p1);
  const across = pz - crestZ;
  const half = across > 0 ? 2500 : 3600;
  const s = clamp(1 - Math.abs(across) / half, 0, 1);
  let range = 0;
  if (s > 0) {
    // Distinct summits along the crest with saddles between — a Chunuk Bair,
    // a Hill 971 — rather than one even wall.
    const summits = 0.62 + 0.38 * Math.pow(0.5 + 0.5 * noise2(px * 0.00034 + 3.3, pz * 0.00005), 1.4);
    range = Math.pow(s, 1.2) * 500 * summits;
  }
  let land = 24 + Math.max(hills, range + hills * 0.35) * inland + fbm(sx * 0.0006, sz * 0.0006, 2) * 8;

  // Ravines and gullies, deepest where the ground is highest: a big dendritic
  // set and a finer one inside it.
  const relief = Math.max(0, land - 20);
  if (relief > 1) {
    const g1 = vein(fbmTurned(sx * 0.00021 + 9, sz * 0.00021, 3) * 1.8, 0.78, 0.95);
    const g2 = vein(fbmTurned(sx * 0.00068 - 4, sz * 0.00068 + 6, 2) * 1.8, 0.84, 0.96);
    // And the maze of little ravines between the razorbacks.
    const g3 = vein(fbmTurned(sx * 0.0017 + 2.6, sz * 0.0017 - 8.1, 2) * 1.8, 0.86, 0.97);
    land -= relief * (0.5 * g1 + (0.3 * g2 + 0.14 * g3) * (1 - g1)) * (1 - 0.7 * calm);
  }
  land += farHills(sx, sz, d, 16000, 32000, 320);
  if (coast > 1200) return Math.max(SHORE_STEP + 2, land);

  // Out to sea: Imbros in the west, and Asia across the straits.
  if (coast <= 900) {
    let far = -Infinity;
    const ix = px + 29000;
    const iz = pz + 5000;
    if (Math.abs(ix) < 9000 && Math.abs(iz) < 9000) {
      const k = knoll(Math.hypot(ix * 1.3, iz), 8000 * (1 + 0.2 * fbm(sx * 0.0003, sz * 0.0003, 2)));
      if (k > 0) far = -20 + k * 620 + ridged(sx * 0.0006, sz * 0.0006, 3) * 60 * k;
    }
    const asia = pz - 25500 + fbm(sx * 0.00005 + 1.1, 2.2, 3) * 3000;
    if (asia > 0) far = Math.max(far, -20 + smoothstep(0, 9000, asia) * (260 + ridgedTurned(sx * 0.00008, sz * 0.00008, 4) * 700));
    if (far > SHORE_STEP) return Math.max(far, SHORE_STEP + 1);
  }

  // The shore: sea cliffs along most of it, with coves and a strand of
  // beach where the cliffs break — Anzac Cove, Suvla.
  const cove = smoothstep(-0.05, 0.25, fbm(sx * 0.00018 + 2.2, sz * 0.00018 - 7.7, 2));
  const reach = lerp(1100, 180, cove);
  const top = Math.max(SHORE_STEP + 2, land);
  if (coast > reach) return top;
  if (coast > 0) {
    const t = coast / reach;
    // A cliff rises almost at once; a beach climbs gently.
    const cliff = smoothstep(0, 0.45, t);
    return lerp(SHORE_STEP + 1, top, lerp(t * t * (3 - 2 * t), cliff, cove));
  }
  return -6 - smoothstep(0, -5000, coast) * 60 - cove * 8 * smoothstep(0, -600, coast);
}

/** Rocky inselbergs standing out of the sand: steep sides, flat tops. */
function inselbergs(sx: number, sz: number): number {
  const CELL = 19000;
  const gx = Math.floor(sx / CELL);
  const gz = Math.floor(sz / CELL);
  let tallest = 0;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      const pick = cellRandom(cx, cz, 61);
      if (pick > 0.45) continue;

      const centreX = (cx + 0.2 + cellRandom(cx, cz, 62) * 0.6) * CELL;
      const centreZ = (cz + 0.2 + cellRandom(cx, cz, 63) * 0.6) * CELL;
      const radius = 800 + pick * 2400;
      const r = Math.hypot(sx - centreX, sz - centreZ);
      if (r > radius) continue;

      // Saturating early in the falloff is what makes the top a mesa rather
      // than a dome.
      const h = smoothstep(0, 0.3, 1 - r / radius) * (170 + pick * 700);
      if (h > tallest) tallest = h;
    }
  }
  return tallest;
}

/**
 * Sinai and southern Palestine: a sand sea of great dune ridges between
 * gravel plains cut by wadis, a rock escarpment stepping up to one flank, and
 * beyond it the Judaean hills standing along the eastern horizon. The
 * Mediterranean is to the west; the lines run across the sand the way the
 * Gaza–Beersheba line did, with the Wadi Ghazze's plain behind the far one.
 */
function sinaiHeight(sx: number, sz: number, d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const calm = Math.abs(px) < 8000 ? farFieldCalm(px, pz, 500) : 0;
  const swell = 70 + fbm(sx * 0.00008, sz * 0.00008, 3) * 40;

  // Where the sand lies: seas of it with gravel plains between, and the ground
  // round the home field kept to a plain.
  // The sector itself always lies in a sand sea: that is where the flying is.
  const sea = smoothstep(-0.55, 0.05, fbm(sx * 0.000045 + 3.3, sz * 0.000045 - 1.2, 2) + 0.45 * (1 - smoothstep(8000, 18000, d)))
    * smoothstep(1800, 4200, d) * (1 - 0.85 * calm);
  let dunes = 0;
  if (sea > 0.001) {
    const drift = fbm(sx * 0.00002, sz * 0.00002, 2) * 2.6;
    const axis = sx * 0.866 + sz * 0.5;
    const size = 45 + 75 * (0.5 + 0.5 * fbm(sx * 0.00005 - 7, sz * 0.00005 + 2, 2));
    // Long windward backs and short steep slip faces, the way the wind
    // builds them: a sawtooth, not a sine.
    const t = fract(axis * 0.00068 + drift * 0.5);
    const draa = smoothstep(0, 0.8, t) * (1 - smoothstep(0.8, 0.95, t)) * size;
    const axis2 = sx * 0.34 - sz * 0.94;
    const cross = Math.pow(0.5 + 0.5 * Math.sin(axis2 * 0.011 + drift * 5.3), 2.4) * size * 0.2;
    const ripple = Math.pow(0.5 + 0.5 * Math.sin(axis * 0.026 + drift * 7.4), 2.3) * 9;
    dunes = (draa + cross + ripple + noise2(sx * 0.0016, sz * 0.0016) * 2.5) * sea;
  }
  // Wadis in the gravel.
  const wadi = sea < 0.999 ? vein(fbm(sx * 0.00012 + 5.5, sz * 0.00012 - 2.5, 2) * 2, 0.86, 0.97) * 28 * (1 - sea) : 0;
  const rock = inselbergs(sx, sz) * 0.6;
  const low = swell + rock + dunes * (1 - smoothstep(20, 150, rock)) - wadi;
  let land = low;

  // The escarpment: a rock step a hundred and fifty metres high, its edge
  // broken into bays and buttresses, and the plateau beyond climbing to the
  // hills of Judaea. (The edge noise is bounded, so west of it nothing here
  // can reach.)
  if (px > L.scarpX - 2400) {
    const edge = L.scarpX + fbm(pz * 0.00012 + 1.3, 5.1, 3) * 1800
      + (ridged(sx * 0.0011, sz * 0.0011, 2) - 0.5) * 260;
    const up = smoothstep(edge - 420, edge + 140, px);
    if (up > 0) {
      const beyond = Math.max(0, px - edge);
      let plateau = 150 + fbm(sx * 0.00015, sz * 0.00015, 2) * 30;
      if (beyond < 9000) plateau -= vein(fbm(sx * 0.00017 - 2.2, sz * 0.00017 + 9.1, 2) * 2, 0.84, 0.96) * 70 * (1 - smoothstep(2000, 9000, beyond));
      if (beyond > 5000) plateau += smoothstep(5000, 24000, beyond) * (480 + ridgedTurned(sx * 0.00006 + 2, sz * 0.00006, 4) * 620);
      land = lerp(low, Math.max(low, swell + plateau), up);
    }
  }
  land += farHills(sx, sz, d, 22000, 40000, 260);

  // The Mediterranean to the west.
  if (px > -6900) return land;
  const q = -px - 9500 + fbm(sz * 0.00008, 2.2, 3) * 2500;
  if (q < 0) return land;
  if (q < 1400) return lerp(land, SHORE_STEP + 1.5, smoothstep(0, 1400, q));
  return -5 - smoothstep(1400, 6000, q) * 35;
}

/**
 * One arm of a glacial valley: 1 at the floor, 0 at the rim.
 *
 * `along` and `across` are passed separately so the same function can cut a
 * valley on either axis. The centreline is a 1D noise of the along-coordinate,
 * so the valley wanders rather than running dead straight.
 */
function uValley(
  across: number, along: number,
  freq: number, seed: number, halfWidth: number, meander: number,
): number {
  const centre = fbm(along * freq + seed, seed * 1.7, 2) * meander;
  const off = Math.abs(across - centre) / halfWidth;
  // Flat floor for the inner half, then the wall packed into a narrow band. A
  // wall spread over the whole half-width climbs at about 30°, which reads as a
  // hillside; confining it to the outer 40% is what makes it a wall.
  return 1 - smoothstep(0.5, 0.92, off);
}

/**
 * High alpine country cut by deep U-shaped glacial valleys — flat floors,
 * steep walls, snow on everything above the treeline. Unlike the Himalaya,
 * which is ridges seen from above, this is flying *inside* the range.
 */
function alpineHeight(sx: number, sz: number, d: number): number {
  const base = 1460 + fbm(sx * 0.00004, sz * 0.00004, 3) * 430;
  const massif = Math.pow(Math.max(0, ridged(sx * 0.00006 + 91, sz * 0.00006 - 23, 5)), 1.35) * 2500;
  const detail = fbm(sx * 0.0007, sz * 0.0007, 2) * 22;
  // Ease the peaks away near the field, as the Himalaya does.
  const peaks = base + massif * smoothstep(3000, 11000, d) + detail;

  const floor = 1180 + fbm(sx * 0.0002, sz * 0.0002, 2) * 40;
  const carve = Math.max(
    uValley(sx, sz, 0.00005, 7.3, 1450, 6400),
    uValley(sz, sx, 0.000045, 2.1, 1250, 5300),
    // Guarantee the airfield sits on a valley floor rather than a mountainside,
    // whatever the seed does with the two valley systems.
    smoothstep(6000, 1500, d),
  );

  return lerp(peaks, Math.min(peaks, floor), carve);
}

// ------------------------------------------------------------------------ Alps

/** The Alps front's geography, anchored to the line (see `alpsHeight`). */
const ALPS_OFFSET = 4800;
const ALPS_WIDTH = 300;
/** The home valley floor at the field, and how it falls toward the east. */
const ALPS_HOME_FLOOR = 850;
/** The pass, at its lowest. */
const ALPS_SADDLE = 1960;
/** The enemy's valley floor. */
const ALPS_FAR_FLOOR = 1180;
/** How far beyond the line the enemy's valley runs (its centre, vertically). */
const ALPS_FAR_AT = -(ALPS_WIDTH / 2 + 4150);

/** 0..1 between two edges: straight in the middle, eased at each end. */
function ramp(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return 0.5 * (t + t * t * (3 - 2 * t));
}

/** Where the pass valley runs at z: north from the field, wandering a little. */
function alpsPassX(z: number): number {
  return 380 * Math.sin(z * 0.00031) + 160 * Math.sin(z * 0.00083);
}

/**
 * The Ortler and Adamello: the White War. Granite and glacier to 3,900 m,
 * deep U-shaped valleys between. The home aerodrome lies on the floor of a
 * broad valley at 800 m; a side valley climbs north from it to a high, wide
 * saddle at a little over 2,000 m where the line crosses between the big
 * peaks; beyond, the ground falls to the enemy's own valley and his field.
 * East and west of the saddle the line climbs onto the ice.
 *
 * Every valley is laid out relative to the front's curve, so whatever the
 * seed does with the line the pass is always where the line crosses it and
 * both fields always lie on a valley floor.
 */
function alpsHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  // The peaks: knife ridges and cirques, glaciers between.
  const r = ridgedTurned(sx * 0.0001 + 91, sz * 0.0001 - 23, 5);
  let massif = 1250 + Math.pow(r, 1.2) * 2700;
  // The two great massifs the line climbs onto either side of the pass —
  // the Ortler and the Adamello of this sector — so the pass is a gap
  // between walls, not a dip in a plateau.
  for (let i = 0; i < 2; i++) {
    const mx = L.alpsPeaks[i * 2];
    const mz = L.alpsPeaks[i * 2 + 1];
    const k = knoll(Math.hypot(px - mx, pz - mz), 6200);
    if (k > 0) massif += k * 1100;
  }
  // The mountain's bulk tops out a little over three thousand metres...
  if (massif > 3000) massif = 3000 + 520 * (1 - Math.exp(-(massif - 3000) / 520));
  // ...and on it, arêtes and couloirs: two sets of sharp ridge lines at
  // different pitches and angles, crossing into horns where they meet. This,
  // not the bulk, is what turns a snowy hill into a mountain.
  const hi = smoothstep(1900, 2900, massif);
  let peaks = massif + fbm(sx * 0.0011, sz * 0.0011, 2) * 30;
  if (hi > 0) {
    const a = 1 - Math.abs(noise2(sx * 0.00052 + 7.7, sz * 0.00052 - 3.1));
    const b = 1 - Math.abs(noise2((sx * 0.6 - sz * 0.8) * 0.00093 + 1.3, (sx * 0.8 + sz * 0.6) * 0.00093 + 9.2));
    peaks += (a * a * 0.62 + b * b * 0.38 - 0.42) * 1250 * hi;
  }
  // The very tops eased down, so the highest summits stand a little under
  // four thousand metres rather than running on up.
  if (peaks > 3650) peaks = 3650 + 280 * (1 - Math.exp(-(peaks - 3650) / 280));

  // Vertical offset from the line: the frame every valley is laid out in.
  const vz = pz - frontZ(px);
  let h = peaks;

  // The home valley: east–west, through the field.
  const dHome = Math.abs(vz - ALPS_OFFSET);
  if (dHome < 4600) {
    const floor = ALPS_HOME_FLOOR - px * 0.006 + noise2(sx * 0.0003, sz * 0.0003) * 12;
    h = Math.min(h, lerp(peaks, Math.min(peaks, floor), valleyMask(dHome, 1600, 2100)));
  }
  // The enemy's valley, the same way, beyond the line.
  const dFar = Math.abs(vz - ALPS_FAR_AT);
  if (dFar < 4400) {
    const floor = ALPS_FAR_FLOOR + px * 0.005 + noise2(sx * 0.0003 + 5, sz * 0.0003) * 12;
    h = Math.min(h, lerp(peaks, Math.min(peaks, floor), valleyMask(dFar, 1300, 2000)));
  }
  // The pass valley: north from the field to the saddle and down the far
  // side into the enemy's valley, opening out into a broad high pass where it
  // crosses the line.
  const dPass = Math.abs(px - alpsPassX(pz));
  if (dPass < 8500 && vz < ALPS_OFFSET + 2600 && vz > ALPS_FAR_AT - 2600) {
    const saddle = 1 - smoothstep(900, 3300, Math.abs(vz));
    // A long, even climb: the valley floor rises about one in four from the
    // field to the pass, less than a scout climbs at.
    const up = vz > 0
      ? lerp(ALPS_HOME_FLOOR + 40, ALPS_SADDLE, ramp(ALPS_OFFSET - 900, 200, vz))
      : lerp(ALPS_SADDLE, ALPS_FAR_FLOOR + 30, ramp(-1300, ALPS_FAR_AT + 1200, vz));
    // Knolls, hollows and tarns on the pass: a boulder-strewn plateau, broad
    // enough on the far side of the line for the enemy's guns to stand on.
    const bumps = saddle > 0.01 ? fbm(sx * 0.0011 + 3.3, sz * 0.0011 - 1.7, 2) * 42 * saddle : 0;
    const half = lerp(950, 3800, saddle);
    const wall = lerp(1900, 2100, saddle);
    // It ends where it meets the two valleys rather than running on through.
    const reach = smoothstep(ALPS_OFFSET + 2600, ALPS_OFFSET + 700, vz)
      * smoothstep(ALPS_FAR_AT - 2600, ALPS_FAR_AT - 700, vz);
    h = Math.min(h, lerp(peaks, Math.min(peaks, up + bumps), valleyMask(dPass, half, wall) * reach));
  }
  return h;
}

const TEMPERATE_TREES: TreePalette = { broadleaf: 1, conifer: 0.08, poplar: 1, palm: 0, shrub: 0.15 };

export const WORLD_PRESETS: WorldPreset[] = [
  {
    name: 'FLANDERS',
    town: true,
    canals: 2,
    hedges: 0.55,
    brick: 0.8,
    farmland: 1.0,
    blurb: 'Drowned polder under the ridges: Passchendaele across the lines, Kemmel behind them. The mud never dries.',
    fieldElevation: 14,
    hasOcean: true,
    villageSpacing: 3700,
    roadTrees: 0.7,
    front: { offset: 3900, amplitude: 1100, wavelength: 13000, width: 380, craters: 1, chalk: 0.05, flooded: 0.85, floodLine: 36 },
    trees: { broadleaf: 1, conifer: 0, poplar: 1.3, palm: 0, shrub: 0.25 },
    landmarkDensity: { castle: 0.4, monastery: 0.8 },
    style: {
      grass: [0.11, 0.165, 0.065], dry: [0.27, 0.235, 0.155], rock: [0.33, 0.32, 0.30],
      snowLine: 1500, treeLine: 900, strata: 0, wooded: 0.42, beach: 5,
    },
    rivers: { depth: 7, count: 7, sourceMin: 32, sourceMax: 120, endAt: 0,
              widthNear: 12, widthFar: 30, sourceCell: 4000 },
    height: flandersHeight,
  },
  {
    name: 'SOMME',
    canals: 1,
    hedges: 0.2,
    brick: 0.45,
    farmland: 0.95,
    blurb: 'Chalk downland cut by the Somme and the Ancre. Every trench is a white scar; every wood a stand of stumps.',
    fieldElevation: 175,
    hasOcean: false,
    villageSpacing: 4300,
    roadTrees: 0.5,
    roadGrade: 0.2,
    front: { offset: 4100, amplitude: 850, wavelength: 16000, width: 420, craters: 1, chalk: 1, flooded: 0.2 },
    trees: TEMPERATE_TREES,
    style: {
      grass: [0.14, 0.19, 0.075], dry: [0.40, 0.36, 0.23], rock: [0.63, 0.61, 0.54],
      snowLine: 1600, treeLine: 900, strata: 0, wooded: 0.6, bluffs: 0.6,
    },
    rivers: { depth: 12, count: 6, sourceMin: 150, sourceMax: 260, endAt: 30,
              widthNear: 12, widthFar: 30 },
    channels: sommeChannels,
    canalRoute: sommeCanal,
    height: sommeHeight,
  },
  {
    name: 'VERDUN',
    town: true,
    hedges: 0.3,
    brick: 0.15,
    farmland: 0.55,
    blurb: 'Steep wooded heights above the Meuse, ringed with forts. Near the line, not a tree stands.',
    fieldElevation: 300,
    hasOcean: false,
    villageSpacing: 5000,
    roadTrees: 0.35,
    front: { offset: 4300, amplitude: 700, wavelength: 12000, width: 640, craters: 1, chalk: 0.45, flooded: 0.3 },
    trees: { broadleaf: 1, conifer: 0.3, poplar: 0.5, palm: 0, shrub: 0.1 },
    landmarkDensity: { castle: 0.5, monastery: 0.5, fort: 1.6 },
    style: {
      grass: [0.11, 0.17, 0.068], dry: [0.34, 0.31, 0.21], rock: [0.50, 0.48, 0.43],
      snowLine: 1400, treeLine: 1200, strata: 0, wooded: 0.95, bluffs: 0.3,
    },
    rivers: { depth: 12, count: 8, sourceMin: 280, sourceMax: 470, endAt: 195,
              widthNear: 12, widthFar: 36 },
    height: verdunHeight,
  },
  {
    name: 'ISONZO',
    hedges: 0.12,
    farmland: 0.3,
    blurb: 'The Carso: a stone plateau pocked with sinkholes, the Adriatic at your back.',
    fieldElevation: 40,
    hasOcean: true,
    villageSpacing: 5200,
    roadTrees: 0.25,
    front: { offset: 4000, amplitude: 800, wavelength: 11000, width: 300, craters: 0.85, chalk: 0.75, flooded: 0 },
    trees: { broadleaf: 0.6, conifer: 0.6, poplar: 0.4, palm: 0, shrub: 1 },
    style: {
      grass: [0.16, 0.17, 0.085], dry: [0.36, 0.27, 0.17], rock: [0.50, 0.49, 0.45],
      snowLine: 1700, treeLine: 1300, strata: 0, wooded: 0.3, stony: 0.6,
      water: { deep: 0x08304a, shallow: 0x2a7f86, sand: 0x8c8f7c },
    },
    rivers: { depth: 14, count: 5, sourceMin: 300, sourceMax: 1500, endAt: 0,
              widthNear: 14, widthFar: 44 },
    height: isonzoHeight,
  },
  {
    name: 'DOLOMITES',
    hedges: 0.15,
    farmland: 0.35,
    blurb: 'War in the high Alps: trenches cut in snow and rock between pale dolomite towers.',
    fieldElevation: 1210,
    hasOcean: false,
    villageSpacing: 5200,
    roadTrees: 0.1,
    front: { offset: 4200, amplitude: 1000, wavelength: 14000, width: 360, craters: 0.6, chalk: 0.5, flooded: 0 },
    trees: { broadleaf: 0.25, conifer: 1, poplar: 0.15, palm: 0, shrub: 0.1 },
    style: {
      grass: [0.14, 0.23, 0.10], dry: [0.38, 0.35, 0.27], rock: [0.52, 0.49, 0.45],
      snowLine: 2550, treeLine: 1850, strata: 0, wooded: 1, stony: 0.15,
    },
    rivers: { depth: 30, count: 20, sourceMin: 1900, sourceMax: 3400, endAt: 1180,
              widthNear: 18, widthFar: 70 },
    height: alpineHeight,
  },
  {
    name: 'GALLIPOLI',
    hedges: 0.06,
    farmland: 0.25,
    blurb: 'Scrub ridges and sheer gullies above the Aegean. The heights are theirs.',
    fieldElevation: 30,
    hasOcean: true,
    villageSpacing: 6500,
    flatRoofs: true,
    roadTrees: 0.1,
    front: { offset: 3700, amplitude: 700, wavelength: 9000, width: 160, craters: 0.7, chalk: 0.25, flooded: 0 },
    trees: { broadleaf: 0.2, conifer: 0.5, poplar: 0.2, palm: 0, shrub: 1 },
    landmarkDensity: { castle: 0.8, monastery: 0.3 },
    style: {
      grass: [0.20, 0.19, 0.095], dry: [0.44, 0.35, 0.22], rock: [0.46, 0.41, 0.33],
      snowLine: 2500, treeLine: 700, strata: 0, wooded: 0.15, stony: 0.35, bluffs: 0.55,
      water: { deep: 0x06284a, shallow: 0x1f7f95, sand: 0x9a9480 },
    },
    height: gallipoliHeight,
  },
  {
    name: 'SINAI',
    hedges: 0.0,
    farmland: 0.0,
    blurb: 'Dune seas, wadis and wells: the Gaza line across the sand, the hills of Judaea on the skyline.',
    fieldElevation: 60,
    hasOcean: true,
    villageSpacing: 9000,
    flatRoofs: true,
    roadTrees: 0,
    front: { offset: 4000, amplitude: 900, wavelength: 17000, width: 500, craters: 0.55, chalk: 0, flooded: 0 },
    trees: { broadleaf: 0, conifer: 0, poplar: 0, palm: 1, shrub: 0.6 },
    landmarkDensity: { castle: 0.3, monastery: 0.5 },
    style: {
      grass: [0.60, 0.43, 0.24], dry: [0.52, 0.37, 0.22], rock: [0.44, 0.31, 0.20],
      snowLine: 5000, treeLine: 900, strata: 0, wooded: 0, bluffs: 0.4,
      water: { deep: 0x05304a, shallow: 0x1d8f9a, sand: 0xb8a784 },
    },
    height: sinaiHeight,
  },
  {
    name: 'ALPS',
    hedges: 0.1,
    farmland: 0.3,
    blurb: 'The White War on the Ortler and Adamello: guns hauled onto the glaciers, trenches cut in ice between walls of rock.',
    fieldElevation: ALPS_HOME_FLOOR,
    // Along the valley: north or south there is a mountain in the way.
    homeHeading: 90,
    hasOcean: false,
    villageSpacing: 5200,
    villageTier: 0,
    roadTrees: 0.05,
    front: { offset: ALPS_OFFSET, amplitude: 700, wavelength: 14000, width: ALPS_WIDTH, craters: 0.55, chalk: 0.35, flooded: 0 },
    trees: { broadleaf: 0.15, conifer: 1, poplar: 0.05, palm: 0, shrub: 0.12 },
    landmarkDensity: { castle: 0.5, monastery: 0.6, fort: 1.5 },
    style: {
      grass: [0.13, 0.205, 0.09], dry: [0.36, 0.33, 0.26], rock: [0.27, 0.265, 0.26],
      snowLine: 2350, treeLine: 1950, strata: 0, wooded: 0.85, stony: 0.12, bluffs: 0.8,
    },
    rivers: { depth: 22, count: 14, sourceMin: 1500, sourceMax: 2700, endAt: 650,
              widthNear: 13, widthFar: 42 },
    height: alpsHeight,
  },
];

// ------------------------------------------------------------------- sampling

let active: WorldPreset = WORLD_PRESETS[0];
let seedOffsetX = 0;
let seedOffsetZ = 0;
let currentSeed = 1;

export function setWorld(index: number): WorldPreset {
  active = WORLD_PRESETS[Math.max(0, Math.min(index, WORLD_PRESETS.length - 1))];
  replanAll();
  return active;
}

export function activeWorld(): WorldPreset {
  return active;
}

/**
 * Move the height field to a different part of the noise domain. Offsets apply
 * to the noise lookups only, never to the radial distance from the origin, so
 * the home field stays flat and at its own elevation.
 */
export function setTerrainSeed(seed: number): void {
  currentSeed = seed;
  seedOffsetX = ((seed * 9871.13) % 100000) + 1000;
  seedOffsetZ = ((seed * 4517.77) % 100000) - 1000;
  replanAll();
}

export function getTerrainSeed(): number {
  return currentSeed;
}

export function fieldElevation(): number {
  return active.fieldElevation;
}

/** Elevation before anything is cut into it. */
function naturalHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const raw = active.height(x + seedOffsetX, z + seedOffsetZ, d);
  const h = lerp(active.fieldElevation, raw, smoothstep(FIELD_RADIUS, FIELD_FALLOFF, d));
  // The home field's approaches: out along the landing line both ways the
  // ground is held under a shallow climb-out, so nothing stands across the
  // take-off run or the glide in — and, the landing line running toward the
  // lines, nothing walls off the climb from the field to the front.
  const along = Math.abs(x * homeDirX + z * homeDirZ);
  if (along > APPROACH_REACH) return h;
  const across = Math.abs(x * homeDirZ - z * homeDirX);
  if (across > APPROACH_HALF + APPROACH_EDGE) return h;
  const cap = active.fieldElevation + 25 + Math.max(0, along - 500) * APPROACH_CLIMB;
  if (h <= cap) return h;
  const t = (1 - smoothstep(APPROACH_HALF, APPROACH_HALF + APPROACH_EDGE, across))
    * (1 - smoothstep(APPROACH_REACH - 600, APPROACH_REACH, along));
  return lerp(h, cap, t);
}

/** The home field's approach funnel: how far out, how wide, how steep. */
const APPROACH_REACH = 3800;
const APPROACH_HALF = 450;
const APPROACH_EDGE = 550;
const APPROACH_CLIMB = 0.07;
/** Unit vector along the home field's landing line (set per world). */
let homeDirX = 0;
let homeDirZ = -1;

/**
 * Terrain elevation at a world position, metres.
 *
 * The single source of truth for the ground: collision and every terrain chunk
 * read it. Rivers are cut into the natural ground, the big shell holes are
 * bitten out of that, and the aerodromes are graded flat over the top.
 */
export function terrainHeight(x: number, z: number): number {
  const natural = naturalHeight(x, z);
  const watered = carveTarns(x, z, carveRivers(x, z, natural));
  const cratered = watered + craterHeight(x, z);
  return airstripHeight(x, z, aerodromeHeight(x, z, cratered));
}

/** River strength at the point `terrainHeight` was last called for. */
export { riverStrength } from './Rivers';

/** Sea, river or lake at a point (not shell holes — the front adds those). */
function wetAt(x: number, z: number): boolean {
  const h = terrainHeight(x, z);
  if (active.hasOcean && h < SEA_LEVEL + 0.4) return true;
  if (riverStrength() > 0.35) return true;
  return onCanal(x, z);
}

/** Within a canal's water. */
function onCanal(x: number, z: number): boolean {
  const d = waterSignedDistance(x, z);
  return roadValidity() > 0.5 && Math.abs(d) < 12;
}

/** The same, against ground with no pads or craters cut in yet. */
function wetNatural(x: number, z: number): boolean {
  const h = carveTarns(x, z, carveRivers(x, z, naturalHeight(x, z)));
  if (active.hasOcean && h < SEA_LEVEL + 0.4) return true;
  if (riverStrength() > 0.3) return true;
  return onCanal(x, z);
}

/** Woodedness the world asks for, or the one its grass colour implies. */
export function worldWooded(p: WorldPreset = active): number {
  if (p.style.wooded !== undefined) return p.style.wooded;
  const g = p.style.grass;
  const t = clamp((g[1] - Math.max(g[0], g[2]) - 0.02) / 0.08, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Forest cover at a point, from scratch — for the planners and the tree
 * scatter. The terrain computes the same thing per vertex from values it
 * already has.
 */
export function forestAt(x: number, z: number): number {
  const h = terrainHeight(x, z);
  const wet = riverStrength();
  const e = 6;
  const hx = terrainHeight(x + e, z);
  const hz = terrainHeight(x, z + e);
  const ny = 1 / Math.hypot((hx - h) / e, 1, (hz - h) / e);
  const settled = Math.max(farmland(x, z), farmlandHome());
  return forestCover(x, z, h, 1 - ny, clearingAt(x, z, settled, wet));
}

/**
 * How much of a point is spoken for by something that is not forest:
 * fields, water, the aerodromes. Roads are handled by the callers, which have
 * the distance already.
 */
export function clearingAt(x: number, z: number, settled: number, river: number): number {
  return Math.max(settled * 0.95, smoothstep(0.02, 0.3, river), aerodromeClearing(x, z));
}

/**
 * Cut the world's canals and return their towpaths.
 *
 * The first runs roughly north–south straight through the lines, a few
 * kilometres to one side of the home field, the way the Yser canal ran through
 * the salient; the second, if there is one, crosses the country east–west
 * behind the home lines. Both are ruled straight with a few gentle kinks.
 */
function planCanals(): { pts: [number, number][]; half: number; lined: boolean }[] {
  const out: { pts: [number, number][]; half: number; lined: boolean }[] = [];
  const water: { pts: [number, number][]; half: number }[] = [];
  const count = active.rivers ? active.canals ?? 0 : 0;
  for (let c = 0; c < count; c++) {
    const r = (k: number): number => cellRandom(c, currentSeed, 511 + k);
    let pts: [number, number][] = [];
    if (c === 0 && active.canalRoute) {
      pts = active.canalRoute();
    } else if (c === 0) {
      const x0 = (r(1) < 0.5 ? -1 : 1) * (2600 + r(2) * 2200);
      for (let z = 16000; z >= -20000; z -= 4000) pts.push([x0 + (r(3 + z / 1000) - 0.5) * 900 + z * (r(4) - 0.5) * 0.12, z]);
    } else {
      const z0 = 5200 + r(5) * 3500;
      for (let x = -20000; x <= 20000; x += 4000) pts.push([x, z0 + (r(6 + x / 1000) - 0.5) * 800]);
    }
    // Keep the canal off the home field and out of the sea.
    const ok = pts.every(([x, z]) => Math.hypot(x, z) > 1800);
    if (!ok) continue;
    const side = r(7) < 0.5 ? -1 : 1;
    for (const run of lowRuns(pts)) {
      addCanal(run, 13, naturalHeight);
      water.push({ pts: run, half: 11 });
      // The towpath, on one bank.
      const path: [number, number][] = [];
      for (let i = 0; i < run.length; i++) {
        const [x, z] = run[i];
        const [nx, nz] = run[Math.min(run.length - 1, i + 1)];
        const [px, pz] = run[Math.max(0, i - 1)];
        const dx = nx - px;
        const dz = nz - pz;
        const len = Math.hypot(dx, dz) || 1;
        path.push([x - (dz / len) * 24 * side, z + (dx / len) * 24 * side]);
      }
      out.push({ pts: path, half: 2.2, lined: true });
    }
  }
  setWaterways(water);
  return out;
}

/** Length of a canal pound, metres — `addCanal` levels the water over each. */
const POUND = 700;
/** A stretch shorter than this is not worth digging, in pounds. */
const MIN_POUNDS = 5;

/**
 * The stretches of a canal's course that keep to low ground.
 *
 * A canal is levelled pound by pound, so one laid across a ridge would be a
 * cutting a hundred metres deep — the Ypres–Comines canal was abandoned at
 * exactly that ridge. A pound is kept where the ground along it is nearly
 * level and not far above the lowest the course reaches; runs of kept pounds
 * long enough to matter become canals, and the rest is never dug.
 */
function lowRuns(pts: [number, number][]): [number, number][][] {
  const pounds: [number, number][] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / POUND));
    for (let k = 1; k <= n; k++) pounds.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  const lo: number[] = [];
  const hi: number[] = [];
  let lowest = Infinity;
  for (let i = 0; i < pounds.length - 1; i++) {
    const [ax, az] = pounds[i];
    const [bx, bz] = pounds[i + 1];
    let a = Infinity;
    let b = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const h = naturalHeight(ax + (bx - ax) * t, az + (bz - az) * t);
      if (h < a) a = h;
      if (h > b) b = h;
    }
    lo.push(a);
    hi.push(b);
    if (a < lowest) lowest = a;
  }
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  const flush = (): void => {
    if (run.length > MIN_POUNDS) runs.push(run);
    run = [];
  };
  for (let i = 0; i < lo.length; i++) {
    const good = hi[i] - lo[i] < 16 && lo[i] < lowest + 45 && lo[i] > SEA_LEVEL + 1;
    if (!good) { flush(); continue; }
    if (run.length === 0) run.push(pounds[i]);
    run.push(pounds[i + 1]);
  }
  flush();
  return runs;
}

/** Whether a point is on an aerodrome's landing ground or among its buildings. */
function onAerodrome(x: number, z: number): boolean {
  for (const a of aerodromes()) {
    const hr = (a.headingDeg * Math.PI) / 180;
    const dx = x - a.x;
    const dz = z - a.z;
    const along = dx * Math.sin(hr) - dz * Math.cos(hr);
    const right = dx * Math.cos(hr) + dz * Math.sin(hr);
    // The main fields keep their camp clear as well; a minor field only its strip.
    const camp = a.main ? 230 : 45;
    if (Math.abs(along) < a.halfLength + 40 && right > -(a.halfWidth + camp) && right < a.halfWidth + 35) return true;
  }
  return false;
}

/**
 * Re-plan everything for the current world and seed.
 *
 * Order matters and is the dependency order: the front's curve first (the
 * height field reads it), rivers against the natural ground, then the enemy
 * aerodrome clear of the rivers, then villages clear of both, then roads
 * between them, then everything that stands on the finished ground.
 */
function replanAll(): void {
  const field = active.fieldElevation;
  setFront(active.front, currentSeed);
  planLayout();
  const hr = ((active.homeHeading ?? 0) * Math.PI) / 180;
  homeDirX = Math.sin(hr);
  homeDirZ = -Math.cos(hr);
  setForestStyle({ wooded: worldWooded(), treeLine: active.style.treeLine, snowLine: active.style.snowLine });
  setWaterProbe(wetAt);
  setGroundProbe(terrainHeight);

  // Traced against the natural ground: a river cannot be routed by a channel
  // that does not exist until it has been routed.
  planRivers(naturalHeight, active.rivers ?? null, currentSeed);
  for (const c of active.channels?.() ?? []) addRiverPath(c.pts, c.widthNear, c.widthFar);

  const towpaths = planCanals();

  planAerodromes({ natural: naturalHeight, fieldElevation: field, wet: wetNatural, seed: currentSeed, homeHeading: active.homeHeading });
  const far = farAerodrome();

  planSettlements(naturalHeight, {
    enabled: active.hasVillages !== false,
    seed: currentSeed,
    minElevation: Math.max(5, field - 500),
    maxElevation: field + 1100,
    exclusion: FIELD_FALLOFF + 900,
    spacing: active.villageSpacing ?? 5200,
    maxTier: active.villageTier,
    siteAllowed: (x, z) => Math.hypot(x - far.x, z - far.z) > 1500 && !wetNatural(x, z),
    // The sector's market town: in the salient, a kilometre or so behind the
    // home lines, near the middle of the map — the ruined Ypres of this front.
    town: active.town ? (x, z) => {
      const u = behindLines(x, z);
      if (frontDistance(x, z) < 0 || u < 500 || u > 2400 || Math.abs(x) > 7000) return Infinity;
      return Math.abs(u - 1300) + Math.abs(x) * 0.3;
    } : undefined,
    stripAllowed: (x, z) => stripAllowed(x, z) && !wetNatural(x, z),
  });
  addMinorAerodromes(airstrips());

  planRoads([
    ...settlements().map((v) => ({ x: v.x, z: v.z, weight: v.fields ? 1 : 1.5 })),
    ...aerodromes().filter((a) => a.main).map((a) => {
      // Behind the camp on the hangar side, not across the landing ground.
      const hr = (a.headingDeg * Math.PI) / 180;
      return { x: a.x - Math.cos(hr) * (a.halfWidth + 290), z: a.z - Math.sin(hr) * (a.halfWidth + 290), weight: 2 };
    }),
  ], {
    seed: currentSeed,
    blocked: onAerodrome,
    sample: terrainHeight,
    wet: (x, z) => active.hasOcean && terrainHeight(x, z) < SEA_LEVEL + 0.6,
    lined: active.roadTrees ?? 0.4,
    maxGrade: active.roadGrade ?? 0.14,
    extra: towpaths,
  });

  // Landmarks against the finished ground.
  planStructures(terrainHeight, {
    enabled: active.hasLandmarks !== false,
    peopled: active.hasVillages !== false,
    coastal: active.hasOcean,
    seed: currentSeed,
    exclusion: FIELD_FALLOFF + 800,
    snowLine: active.style.snowLine > 0 ? active.style.snowLine : 4000,
    field,
    density: active.landmarkDensity ?? {},
    city: null,
  });

  planFrontSites({
    ground: terrainHeight,
    seed: currentSeed,
    forest: forestAt,
    villages: settlements().map((v) => ({ x: v.x, z: v.z, houses: v.houses.length })),
    roadDistance: (x, z) => nearestRoad(x, z, 1500),
  });

  planBoats(terrainHeight, {
    enabled: active.hasOcean,
    sail: active.hasSailboats !== false,
    seed: currentSeed,
    exclusion: FIELD_FALLOFF + 1200,
  });
}

/** Ground height for collision. The same as the terrain: nothing stands on it that you can land on. */
export function groundHeight(x: number, z: number): number {
  return terrainHeight(x, z);
}

/** Where the aircraft should start: the downwind end of the home field, facing the take-off run. */
export function spawnPoint(): { x: number; z: number; heading: number } {
  if (active.spawn) return active.spawn;
  const a = homeAerodrome();
  const hr = (a.headingDeg * Math.PI) / 180;
  const back = a.halfLength - 60;
  return { x: a.x - Math.sin(hr) * back, z: a.z + Math.cos(hr) * back, heading: a.headingDeg };
}

// The default world needs its plan before the first terrain sample, and
// nothing calls setWorld/setTerrainSeed at boot.
replanAll();
