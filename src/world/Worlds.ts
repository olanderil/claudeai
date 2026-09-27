import { fbm, ridged } from '../util/noise';
import { clamp, lerp, smoothstep } from '../util/math';
import { airstripHeight, airstrips, planSettlements, settlements } from './Settlements';
import { addCanal, carveRivers, carveTarns, planRivers, riverStrength, type RiverSettings } from './Rivers';
import { planBoats } from './Boats';
import { planStructures } from './Structures';
import {
  addMinorAerodromes, aerodromeClearing, aerodromeHeight, aerodromes, behindLines, craterHeight, frontDistance, farAerodrome, homeAerodrome,
  planAerodromes, planFrontSites, setFront, setWaterProbe, stripAllowed, type FrontSettings,
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
  /** Flat-roofed houses (the Levant), rather than pitched roofs. */
  flatRoofs?: boolean;
  /** Share of red-brick buildings, 0..1 — Flanders and Artois were built of it. */
  brick?: number;
  /** Share of roads lined with trees, 0..1. */
  roadTrees?: number;
  /** How much of the open country is laid out in fields, 0..1. */
  farmland?: number;
  /** Share of field boundaries grown up as hedgerows and tree lines, 0..1. */
  hedges?: number;
  /** How many canals cross the country (needs `rivers`). */
  canals?: number;
  /** Whether the sector has a market town behind the home lines. */
  town?: boolean;
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

// --------------------------------------------------------------------- worlds

/**
 * Flanders: flat, drowned polder a few metres above the water table, one low
 * ridge running across it, and the North Sea far off to the north-west.
 *
 * The ridge is the whole geography of the salient — thirty metres of rise is
 * the high ground men died by the hundred thousand for — so it is kept low,
 * broad and unmistakable rather than lost in a field of hills.
 */
function flandersHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const plain = 12 + fbm(sx * 0.00007, sz * 0.00007, 3) * 7 + fbm(sx * 0.00045, sz * 0.00045, 2) * 1.8;
  // The ridge: a broad crest roughly along the lines, wandering.
  const crest = -5200 + fbm(px * 0.00006 + 3.1, 7.7, 2) * 3000;
  const across = Math.abs(pz - crest);
  const ridge = (1 - smoothstep(600, 3600, across)) * (26 + fbm(sx * 0.00012, sz * 0.00012, 2) * 12);
  // Knolls: the Hill 60s and Mont Kemmels — isolated, low.
  const knoll = Math.pow(Math.max(0, ridged(sx * 0.00011 + 9, sz * 0.00011 - 4, 3) - 0.62), 1.4) * 170;
  const land = plain + ridge + knoll;

  // The coast, twenty-odd kilometres to the north-west: dunes, then sand.
  const q = -(px + pz) * 0.7071 + fbm(sx * 0.00004, sz * 0.00004, 2) * 3500;
  if (q < 21000) return land;
  const dunes = Math.pow(Math.max(0, ridged(sx * 0.0012, sz * 0.0012, 2)), 2) * 14;
  if (q < 24500) return lerp(land, SHORE_STEP + 3 + dunes, smoothstep(21000, 24000, q));
  return -6 - smoothstep(24500, 30000, q) * 30;
}

/**
 * The Somme: chalk downland. Long smooth swells, broad plateaux between
 * steep-sided dry valleys, and the river valleys cut down through it.
 */
function sommeHeight(sx: number, sz: number, _d: number): number {
  const swell = fbm(sx * 0.00006 + 5, sz * 0.00006 - 3, 3) * 42;
  const downs = (fbm(sx * 0.00017, sz * 0.00017, 4) * 0.5 + 0.5) * 62;
  // Dry valleys: thin winding lines where a noise crosses zero, gently carved.
  const veins = 1 - Math.abs(fbm(sx * 0.00011 + 17, sz * 0.00011 - 4, 3) * 2.0);
  const valley = smoothstep(0.74, 0.97, veins) * 34;
  return 92 + swell + downs - valley + fbm(sx * 0.0009, sz * 0.0009, 2) * 2.5;
}

/**
 * Verdun: the Côtes de Meuse. A limestone plateau around 300 m cut by steep,
 * wooded ravines, falling into the broad Meuse valley.
 */
function verdunHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const plateau = 285 + fbm(sx * 0.00008, sz * 0.00008, 3) * 45
    + Math.pow(Math.max(0, ridged(sx * 0.00014 + 3, sz * 0.00014 - 8, 3) - 0.45), 1.3) * 110;
  // Ravines: the vein trick, deep and narrow — these are the "ravins" every
  // attack went up.
  const veins = 1 - Math.abs(fbm(sx * 0.00016 + 3, sz * 0.00016 - 11, 3) * 2.1);
  const cut = smoothstep(0.66, 0.95, veins) * 105;
  // The Meuse: a wide flat valley meandering north–south east of the field.
  const meander = fbm(pz * 0.00005 + 7, 1.3, 2) * 3200;
  const toRiver = Math.abs(px - 6500 - meander);
  const valley = 1 - smoothstep(700, 2300, toRiver);
  const floor = 196 + fbm(sx * 0.0003, sz * 0.0003, 2) * 4;
  return lerp(plateau - cut, floor, valley);
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
 * rising from the Adriatic plain in the south-west to the mountains the enemy
 * holds in the north.
 */
function isonzoHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  // Distance toward the south-west coast.
  const q = -0.6 * px + 0.8 * pz + fbm(sx * 0.00006, sz * 0.00006, 3) * 2600;
  // The plateau climbs in a series of scarps toward the north-east.
  const inland = clamp((-q + 3000) / 16000, 0, 1.4);
  const scarp = smoothstep(0.08, 0.20, inland) * 120 + smoothstep(0.34, 0.5, inland) * 110;
  const plateau = 38 + scarp + inland * 90
    + fbm(sx * 0.00022, sz * 0.00022, 3) * 22
    + Math.pow(Math.max(0, ridged(sx * 0.00016 + 7, sz * 0.00016 - 1, 3) - 0.5), 1.3) * 160 * smoothstep(0.2, 0.6, inland);
  // The mountains north of the lines: Monte Santo and the Julian foothills.
  const north = smoothstep(-6500, -16000, pz);
  const mountains = north * (Math.pow(Math.max(0, ridged(sx * 0.00007 + 41, sz * 0.00007 - 3, 4)), 1.3) * 1500 + 250);
  const pits = dolines(sx, sz) * smoothstep(0.14, 0.3, inland);
  const land = plateau + mountains - pits;
  // The Adriatic.
  if (q < 8200) return land;
  if (q < 9400) return lerp(land, SHORE_STEP + 1, smoothstep(8200, 9400, q));
  return -5 - smoothstep(9400, 14000, q) * 38;
}

/**
 * Gallipoli: scrub-covered ridges broken by steep ravines, falling to the
 * Aegean on the west and south.
 */
function gallipoliHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const west = px + 7500 + fbm(sz * 0.0001, 3.3, 3) * 2400;
  const south = 12500 - pz + fbm(sx * 0.0001, 8.1, 3) * 2200;
  const coast = Math.min(west, south);
  // Ridges rising inland and toward the lines: the heights the enemy held.
  const inland = smoothstep(0, 9000, coast);
  const ridges = Math.pow(Math.max(0, ridged(sx * 0.00013 + 5, sz * 0.00013 - 2, 4) - 0.25), 1.2) * 330;
  const heights = smoothstep(-1500, -9000, pz) * 120;
  const gullies = smoothstep(0.7, 0.95, 1 - Math.abs(fbm(sx * 0.0003 + 9, sz * 0.0003, 3) * 2.2)) * 45;
  const land = 26 + (ridges + heights) * inland - gullies * inland
    + fbm(sx * 0.0006, sz * 0.0006, 3) * 8;
  if (coast > 900) return Math.max(SHORE_STEP + 2, land);
  if (coast > 0) return lerp(SHORE_STEP + 1, Math.max(SHORE_STEP + 2, land), smoothstep(0, 900, coast));
  return -6 - smoothstep(0, -5000, coast) * 60;
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
 * Sinai and southern Palestine: a sand sea of transverse dunes with rock
 * standing out of it, falling to the Mediterranean on the west. The lines run
 * across it the way the Gaza–Beersheba line did.
 */
function sinaiHeight(sx: number, sz: number, _d: number): number {
  const px = sx - seedOffsetX;
  const drift = fbm(sx * 0.00002, sz * 0.00002, 2) * 2.6;
  const axis = sx * 0.866 + sz * 0.5;
  const primary = Math.pow(0.5 + 0.5 * Math.sin(axis * 0.0075 + drift * 3.1), 1.9) * 38;
  const secondary = Math.pow(0.5 + 0.5 * Math.sin(axis * 0.026 + drift * 7.4), 2.3) * 9;
  const grain = fbm(sx * 0.0016, sz * 0.0016, 2) * 2.5;
  const swell = 70 + fbm(sx * 0.00008, sz * 0.00008, 3) * 45;
  const rock = inselbergs(sx, sz) * 0.6;
  const land = swell + rock + (primary + secondary + grain) * (1 - smoothstep(20, 150, rock));
  // The Mediterranean to the west.
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

const TEMPERATE_TREES: TreePalette = { broadleaf: 1, conifer: 0.08, poplar: 1, palm: 0, shrub: 0.15 };

export const WORLD_PRESETS: WorldPreset[] = [
  {
    name: 'FLANDERS',
    town: true,
    canals: 2,
    hedges: 0.55,
    brick: 0.8,
    farmland: 1.0,
    blurb: 'Flat, drowned polder around a ruined cloth-hall town. The mud never dries.',
    fieldElevation: 14,
    hasOcean: true,
    villageSpacing: 3700,
    roadTrees: 0.7,
    front: { offset: 3900, amplitude: 1100, wavelength: 13000, width: 380, craters: 1, chalk: 0.05, flooded: 0.85 },
    trees: { broadleaf: 1, conifer: 0, poplar: 1.3, palm: 0, shrub: 0.25 },
    landmarkDensity: { castle: 0.4, monastery: 0.8 },
    style: {
      grass: [0.11, 0.165, 0.065], dry: [0.27, 0.235, 0.155], rock: [0.33, 0.32, 0.30],
      snowLine: 1500, treeLine: 900, strata: 0, wooded: 0.42, beach: 5,
    },
    rivers: { depth: 7, count: 7, sourceMin: 22, sourceMax: 60, endAt: 0,
              widthNear: 12, widthFar: 30, sourceCell: 4000 },
    height: flandersHeight,
  },
  {
    name: 'SOMME',
    canals: 1,
    hedges: 0.2,
    brick: 0.45,
    farmland: 0.95,
    blurb: 'Rolling chalk downland. Every trench is a white scar; every wood a stand of stumps.',
    fieldElevation: 110,
    hasOcean: false,
    villageSpacing: 4300,
    roadTrees: 0.5,
    front: { offset: 4100, amplitude: 850, wavelength: 16000, width: 420, craters: 1, chalk: 1, flooded: 0.2 },
    trees: TEMPERATE_TREES,
    style: {
      grass: [0.14, 0.19, 0.075], dry: [0.40, 0.36, 0.23], rock: [0.60, 0.585, 0.54],
      snowLine: 1600, treeLine: 900, strata: 0, wooded: 0.6,
    },
    rivers: { depth: 12, count: 7, sourceMin: 120, sourceMax: 190, endAt: 70,
              widthNear: 12, widthFar: 34 },
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
      snowLine: 1400, treeLine: 1200, strata: 0, wooded: 0.95,
    },
    rivers: { depth: 12, count: 8, sourceMin: 260, sourceMax: 380, endAt: 200,
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
    rivers: { depth: 14, count: 5, sourceMin: 300, sourceMax: 1200, endAt: 0,
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
      snowLine: 2500, treeLine: 700, strata: 0, wooded: 0.15, stony: 0.35,
      water: { deep: 0x06284a, shallow: 0x1f7f95, sand: 0x9a9480 },
    },
    height: gallipoliHeight,
  },
  {
    name: 'SINAI',
    hedges: 0.0,
    farmland: 0.0,
    blurb: 'Sand, scrub and wells: the Gaza line across the dunes, the sea at the western edge.',
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
      snowLine: 5000, treeLine: 900, strata: 0, wooded: 0,
      water: { deep: 0x05304a, shallow: 0x1d8f9a, sand: 0xb8a784 },
    },
    height: sinaiHeight,
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
  return lerp(active.fieldElevation, raw, smoothstep(FIELD_RADIUS, FIELD_FALLOFF, d));
}

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
    const pts: [number, number][] = [];
    if (c === 0) {
      const x0 = (r(1) < 0.5 ? -1 : 1) * (2600 + r(2) * 2200);
      for (let z = 16000; z >= -20000; z -= 4000) pts.push([x0 + (r(3 + z / 1000) - 0.5) * 900 + z * (r(4) - 0.5) * 0.12, z]);
    } else {
      const z0 = 5200 + r(5) * 3500;
      for (let x = -20000; x <= 20000; x += 4000) pts.push([x, z0 + (r(6 + x / 1000) - 0.5) * 800]);
    }
    // Keep the canal off the home field and out of the sea.
    const ok = pts.every(([x, z]) => Math.hypot(x, z) > 1800);
    if (!ok) continue;
    addCanal(pts, 13, naturalHeight);
    water.push({ pts, half: 11 });
    // The towpath, on one bank.
    const side = r(7) < 0.5 ? -1 : 1;
    const path: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const [nx, nz] = pts[Math.min(pts.length - 1, i + 1)];
      const [px, pz] = pts[Math.max(0, i - 1)];
      const dx = nx - px;
      const dz = nz - pz;
      const len = Math.hypot(dx, dz) || 1;
      path.push([x - (dz / len) * 24 * side, z + (dx / len) * 24 * side]);
    }
    out.push({ pts: path, half: 2.2, lined: true });
  }
  setWaterways(water);
  return out;
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
  setForestStyle({ wooded: worldWooded(), treeLine: active.style.treeLine, snowLine: active.style.snowLine });
  setWaterProbe(wetAt);

  // Traced against the natural ground: a river cannot be routed by a channel
  // that does not exist until it has been routed.
  planRivers(naturalHeight, active.rivers ?? null, currentSeed);

  const towpaths = planCanals();

  planAerodromes({ natural: naturalHeight, fieldElevation: field, wet: wetNatural, seed: currentSeed });
  const far = farAerodrome();

  planSettlements(naturalHeight, {
    enabled: active.hasVillages !== false,
    seed: currentSeed,
    minElevation: Math.max(5, field - 500),
    maxElevation: field + 1100,
    exclusion: FIELD_FALLOFF + 900,
    spacing: active.villageSpacing ?? 5200,
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
    maxGrade: 0.14,
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
