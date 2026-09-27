import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAD, lerp, smoothstep } from '../util/math';
import { behindLines } from './Front';

/**
 * Villages and their airstrips.
 *
 * Placement is decided **once per world and seed**, not per terrain sample. That
 * matters: choosing a village site needs a dozen height evaluations to check the
 * ground is flat and dry enough, and `terrainHeight` is called ~700 times per
 * terrain chunk across hundreds of chunks. Doing the search per sample would
 * multiply the cost of the whole height field by an order of magnitude and bring
 * back the chunk-build overrun that used to punch holes in the terrain.
 *
 * So the plan is computed up front into a small array, and the only thing the
 * per-sample path does is one hash-grid lookup that is empty almost everywhere.
 */

/** A landable strip flattened into the terrain beside a village. */
export interface Airstrip {
  /** Centre of the strip. */
  x: number;
  z: number;
  /**
   * Unit vector along the runway centreline, oriented in the *landing*
   * direction — the end with the clear approach.
   */
  dirX: number;
  dirZ: number;
  /** Landing heading, degrees, same convention as the aircraft (0 = north). */
  headingDeg: number;
  /** Elevation of the flattened pad, metres. */
  elevation: number;
}

/**
 * What the war has left of a building. Decided per house from how far behind
 * the lines it stands, so a village astride the front is rubble at one end and
 * roofless shells at the other.
 */
export type HouseState = 'intact' | 'ruin' | 'rubble';

interface House {
  x: number;
  z: number;
  y: number;
  /** The church is the first building of every village. */
  church: boolean;
  state: HouseState;
  width: number;
  depth: number;
  height: number;
  rotation: number;
  roofHeight: number;
  wall: THREE.Color;
  roof: THREE.Color;
}

export interface Village {
  x: number;
  z: number;
  elevation: number;
  houses: House[];
  strip: Airstrip | null;
  /**
   * The angle its street runs at, radians.
   *
   * Kept on the village because the fields want it too. What makes a village
   * read as a place rather than as scattered huts is that every roof shares one
   * angle, and farmland works the same way — fields and the lane they sit along
   * share a grid, because historically one was laid out from the other.
   */
  street: number;
  /**
   * Whether this is one of the added field villages.
   *
   * There are two kinds of village and both farm. The original kind — every
   * village the world has ever had — clears a small belt of soft, noisy plots
   * around its houses, and that belt is what makes a settlement visible from
   * cruise at all. The field village is a second, *additional* population laid
   * on top: fewer of them, further apart, each at the centre of a proper
   * hedged patchwork reaching more than a kilometre out.
   *
   * The distinction is which farmland the ground draws, not whether it draws
   * any. Turning half the original villages into bare grass to make room for
   * the new ones deleted the sight the fields were supposed to be added to.
   */
  fields: boolean;
}

export interface SettlementOptions {
  /** Whether this world is inhabited at all. */
  enabled: boolean;
  /** Terrain seed, so a fresh landscape moves the villages with it. */
  seed: number;
  /** Ground below this is sea, marsh or canyon floor — no villages. */
  minElevation: number;
  /** Ground above this is too high to settle. */
  maxElevation: number;
  /** Radius around the origin to leave clear of the main airfield. */
  exclusion: number;
  /** Spacing of the jittered placement grid, metres. */
  spacing: number;
  /** Veto on a village site (the enemy aerodrome, water). */
  siteAllowed?: (x: number, z: number) => boolean;
  /** Veto on an airstrip site (too near the lines). */
  stripAllowed?: (x: number, z: number) => boolean;
}

// -------------------------------------------------------------------- geometry

/** How far out village sites are searched for, metres. */
const REACH = 68000;
/** Cap on cells searched each way, so a tight spacing can't explode the cost. */
const MAX_SPAN = 13;

/**
 * Ceilings on what a world gets, whatever its terrain offers.
 *
 * Habitability varies enormously between worlds — the canyon rim is a flat
 * plateau where nearly every candidate site passes, while the isles are half
 * ocean. Without a cap the same rules give one world 9 villages and another 71.
 * Selecting by a per-site rank keeps the choice deterministic and evenly spread.
 *
 * These are set for *flying*, not for plausible rural population density. At a
 * realistic one settlement per few hundred square kilometres you cross one every
 * several minutes at cruise and never notice the feature exists; the first
 * version of this put the nearest village 16–29 km from the runway, and it may
 * as well not have been there.
 */
const MAX_VILLAGES = 300;
const MAX_STRIPS = 26;
/** Far enough apart that two strips are never in the same view. */
const MIN_STRIP_SEPARATION = 9000;
/**
 * How many sites may be tested for a runway. Each test sweeps eight headings
 * against the height field, so this is the term that decides what re-siting a
 * world costs; the rest of the plan is an order of magnitude cheaper.
 */
const MAX_STRIP_SEARCHES = 100;

/** Flat, landable part of a strip. Comfortably longer than the takeoff roll. */
const STRIP_HALF_LENGTH = 460;
const STRIP_HALF_WIDTH = 60;
/**
 * How far the pad grades back into natural ground. Generous on purpose: a short
 * grade puts a visible step at the edge of the strip, and — because coarse LOD
 * chunks may only have one vertex across the whole shoulder — a long ramp is
 * also what keeps the terrain next to the runway mesh at pad height instead of
 * cutting through it.
 */
const GRADE_ALONG = 340;
const GRADE_ACROSS = 210;
/** Conservative bound on a strip's influence, whatever its heading. */
const STRIP_REACH = Math.hypot(
  STRIP_HALF_LENGTH + GRADE_ALONG,
  STRIP_HALF_WIDTH + GRADE_ACROSS,
);

/** Hash-grid cell for the per-sample lookup, metres. */
const BUCKET = 1024;

/**
 * Radius of the cleared, cultivated ground around a village.
 *
 * This is what actually makes a settlement visible from the air. Houses are
 * 8–13 m across: from a normal cruise they are one or two pixels and simply
 * vanish, which is why a first version with villages every few kilometres still
 * looked like empty wilderness. Farmland is hundreds of metres of *colour*, and
 * colour survives distance.
 */
/**
 * How far an ordinary village's worked land reaches, metres.
 *
 * The original figures, and they are right for what they do. A belt twelve
 * hundred metres across holds about half a dozen soft-edged plots — not enough
 * to read as a patchwork, which is exactly why the field village exists, but
 * plenty to put a ring of cultivated colour around the houses and make the
 * place carry from altitude.
 */
const HOME_INNER = 200;
const HOME_OUTER = 580;

/**
 * How far a field village's patchwork reaches, metres.
 *
 * Much wider, because this belt has to hold enough plots to read as a grid of
 * them. At the original 580 there was room for six fields, and six fields is a
 * smudge rather than farmland.
 */
const FARM_INNER = 420;
const FARM_OUTER = 1400;

/**
 * How far a field village keeps off an ordinary one, metres.
 *
 * Comfortably outside the patchwork, so an ordinary village is never found
 * standing in somebody else's hedged fields with its own soft belt drowned
 * underneath them.
 */
const FIELD_GAP = 2400;
/** And off each other, so two patchworks never merge into one big one. */
const FIELD_SPACING = 3200;
/** Ceiling on the added population, per world. */
const MAX_FIELD_VILLAGES = 80;

// ----------------------------------------------------------------------- state

let villages: Village[] = [];
let strips: Airstrip[] = [];
/** Strips by hash-grid cell. Undefined for the overwhelming majority of cells. */
let index = new Map<number, Airstrip[]>();
/** Villages by hash-grid cell, for the farmland tint. */
let farmIndex = new Map<number, Village[]>();

export function settlements(): Village[] {
  return villages;
}

export function airstrips(): Airstrip[] {
  return strips;
}

/** Deterministic [0,1) from three integers. */
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
 * Elevation with any airstrip pad blended in.
 *
 * Called for every terrain vertex and every collision sample, so the fast path —
 * nowhere near a strip — is a single map lookup that misses.
 */
export function airstripHeight(x: number, z: number, natural: number): number {
  if (strips.length === 0) return natural;
  const bucket = index.get(bucketKey(x, z));
  if (bucket === undefined) return natural;

  for (let i = 0; i < bucket.length; i++) {
    const s = bucket[i];
    const dx = x - s.x;
    const dz = z - s.z;

    // Along and across the runway. Rotating the sample rather than the pad keeps
    // this an exact rectangle test at any heading.
    const along = Math.abs(dx * s.dirX + dz * s.dirZ);
    const across = Math.abs(dx * s.dirZ - dz * s.dirX);

    const t = Math.max(
      smoothstep(STRIP_HALF_LENGTH, STRIP_HALF_LENGTH + GRADE_ALONG, along),
      smoothstep(STRIP_HALF_WIDTH, STRIP_HALF_WIDTH + GRADE_ACROSS, across),
    );
    if (t < 1) return lerp(s.elevation, natural, t);
  }
  return natural;
}

/**
 * How cultivated the ground is here, 0 (wild) to 1 (village fields).
 *
 * Sampled once per terrain vertex and carried through the terrain shader as a
 * vertex attribute, rather than drawn as decals on top. That is what makes it
 * survive the LOD: a flat patch laid over rolling ground has to be lifted clear
 * of the coarse chunks that replace it at distance, and then it floats when you
 * fly close. Blended into the surface itself, it is correct at every level.
 */
/**
 * Where the last `farmland` call landed, in the winning village's own frame.
 *
 * A stash rather than a return value, matching `riverStrength` — the terrain
 * samples the height field once per vertex and reads everything else off the
 * back of that call, and adding a second traversal to fetch two numbers would
 * cost more than the numbers are worth.
 */
let plotU = 0;
let plotV = 0;
let homeStrength = 0;

export function farmlandPlot(): [number, number] {
  return [plotU, plotV];
}

/**
 * How strongly an ordinary village's belt covers the last point asked about.
 *
 * Stashed by the same traversal for the same reason as the plot frame: the two
 * kinds of village live in one bucket, and answering for both costs nothing on
 * top of the walk that has to happen anyway.
 */
export function farmlandHome(): number {
  return homeStrength;
}

export function farmland(x: number, z: number): number {
  plotU = 0;
  plotV = 0;
  homeStrength = 0;
  if (villages.length === 0) return 0;
  const bucket = farmIndex.get(bucketKey(x, z));
  if (bucket === undefined) return 0;

  let strongest = 0;
  let winner: Village | null = null;
  for (let i = 0; i < bucket.length; i++) {
    const v = bucket[i];
    const d = Math.hypot(x - v.x, z - v.z);
    if (!v.fields) {
      const h = 1 - smoothstep(HOME_INNER, HOME_OUTER, d);
      if (h > homeStrength) homeStrength = h;
      continue;
    }
    const t = 1 - smoothstep(FARM_INNER, FARM_OUTER, d);
    if (t > strongest) { strongest = t; winner = v; }
  }
  if (winner !== null) {
    // Rotated into the village's grid, so its fields line up with its street
    // and the next village along has its own quite different orientation.
    const dx = x - winner.x;
    const dz = z - winner.z;
    const c = Math.cos(-winner.street);
    const sn = Math.sin(-winner.street);
    plotU = dx * c - dz * sn;
    plotV = dx * sn + dz * c;
  }
  return strongest;
}

/** Nearest strip to a position, or null if this world has none. */
export function nearestAirstrip(x: number, z: number): { strip: Airstrip; distance: number } | null {
  let best: Airstrip | null = null;
  let bestSq = Infinity;
  for (const s of strips) {
    const dsq = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (dsq < bestSq) {
      bestSq = dsq;
      best = s;
    }
  }
  return best ? { strip: best, distance: Math.sqrt(bestSq) } : null;
}

// -------------------------------------------------------------------- planning

/** Directions probed around a candidate site to reject sloping ground. */
const PROBE: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7],
];

/**
 * Successively looser standards for what counts as a buildable site.
 *
 * The first tier is what you would choose freely: flat ground well inside the
 * world's habitable band. But some seeds simply don't offer that — a Himalayan
 * range where every valley floor is steep left one seed with no villages at all.
 * Rather than tune each world's band until no seed can fail, settle for rougher,
 * higher ground when the good sites run out, the way real settlement does.
 */
const TIERS = [
  { slope: 70, below: 0, above: 0, stripSpread: 46 },
  { slope: 115, below: 250, above: 450, stripSpread: 58 },
  { slope: 170, below: 500, above: 1000, stripSpread: 72 },
  { slope: 250, below: 900, above: 1900, stripSpread: 78 },
];
/**
 * Candidates below this trigger the next tier. Sized against the density the
 * map wants, not against "at least a few" — a threshold of 8 left the Himalaya
 * on its strictest standard with 20 sites across 130 km of terrain, which reads
 * as an empty world even though the check technically passed.
 */
const ENOUGH_CANDIDATES = 90;

/**
 * Choose village sites for the current world.
 *
 * `sample` must be the *natural* height field — the one without airstrip pads —
 * otherwise a strip would flatten the ground its own placement test reads. House
 * heights are taken afterwards from the finished field, once the pads exist.
 */
export function planSettlements(
  sample: (x: number, z: number) => number,
  opts: SettlementOptions,
): void {
  villages = [];
  strips = [];
  index = new Map();
  farmIndex = new Map();
  if (!opts.enabled) return;

  const { seed, minElevation, maxElevation, exclusion, spacing } = opts;
  const salt = (seed | 0) * 16;
  const span = Math.min(MAX_SPAN, Math.max(1, Math.round(REACH / spacing)));

  // --- Pass 1: every cell that offers habitable, gentle ground. --------------
  interface Candidate { x: number; z: number; elevation: number; gx: number; gz: number; rank: number }
  let candidates: Candidate[] = [];
  let tier = TIERS[0];

  for (let t = 0; t < TIERS.length; t++) {
    tier = TIERS[t];
    const floor = Math.max(25, minElevation - tier.below);
    const ceiling = maxElevation + tier.above;
    candidates = [];

    for (let gx = -span; gx <= span; gx++) {
      for (let gz = -span; gz <= span; gz++) {
        if (cellRandom(gx, gz, salt + 1) > 0.62) continue;

        const cx = (gx + (cellRandom(gx, gz, salt + 2) - 0.5) * 0.72) * spacing;
        const cz = (gz + (cellRandom(gx, gz, salt + 3) - 0.5) * 0.72) * spacing;
        if (Math.hypot(cx, cz) < exclusion) continue;
        if (opts.siteAllowed && !opts.siteAllowed(cx, cz)) continue;

        const centre = sample(cx, cz);
        if (centre < floor || centre > ceiling) continue;

        // Gentle ground only: a village on a 1-in-3 slope reads as buildings
        // stuck to a cliff, and an airstrip there would be a quarry.
        let lo = centre;
        let hi = centre;
        for (const [ox, oz] of PROBE) {
          const h = sample(cx + ox * 300, cz + oz * 300);
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
        if (hi - lo > tier.slope || lo < floor) continue;

        candidates.push({ x: cx, z: cz, elevation: centre, gx, gz, rank: cellRandom(gx, gz, salt + 9) });
      }
    }

    if (candidates.length >= ENOUGH_CANDIDATES) break;
  }

  // --- Pass 2: thin to the ceiling, then site the strips. -------------------
  candidates.sort((a, b) => a.rank - b.rank);
  const kept = candidates.slice(0, MAX_VILLAGES);

  // Strips go to the closest eligible villages first. Assigning them in rank
  // order spreads them evenly over the whole map, which sounds fair and means
  // the nearest one to the runway can be 30 km away — far enough that you never
  // find one. The player always starts at the origin, so bias toward it.
  kept.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));

  let stripSearches = 0;
  for (const c of kept) {
    // No random gate: in mountains and fjords most near sites fail the flatness
    // and approach tests anyway, and skipping a fifth of them at random on top
    // of that pushed the first airstrip 30 km out. Separation and the ceiling
    // control how many there are; the search budget controls what it costs.
    const wantsStrip =
      strips.length < MAX_STRIPS &&
      stripSearches < MAX_STRIP_SEARCHES &&
      (opts.stripAllowed === undefined || opts.stripAllowed(c.x, c.z)) &&
      strips.every((s) => Math.hypot(s.x - c.x, s.z - c.z) >= MIN_STRIP_SEPARATION);
    if (wantsStrip) stripSearches++;

    // Searching for a runway heading costs a few hundred height samples, so it
    // only runs for sites that could actually receive one.
    const strip = wantsStrip
      ? findStrip(sample, c.x, c.z, c.gx, c.gz, salt, Math.max(25, minElevation - tier.below), tier.stripSpread)
      : null;

    villages.push({
      // Push the houses off to one side so the runway stays clear.
      x: strip ? c.x + strip.dirZ * 380 : c.x,
      z: strip ? c.z - strip.dirX * 380 : c.z,
      elevation: strip ? strip.elevation : c.elevation,
      // Filled in by the layout, which is what chooses it.
      street: 0,
      fields: false,
      houses: [],
      strip,
    });
    if (strip) {
      strips.push(strip);
      addToIndex(strip);
    }
  }

  // --- Pass 2b: the field villages, added on top. ---------------------------
  //
  // Everything above this line is untouched, so a world has exactly the
  // villages it has always had, in the same places, with the same airstrips.
  // The field villages are a separate population layered over that, drawn from
  // the cells the first pass *rejected* — the gate above keeps a cell when its
  // hash is at or under 0.62, so the land above that line has always been
  // empty and is free to build on without moving anything.
  //
  // No airstrips: strip siting is what decides where an ordinary village ends
  // up standing, and letting a second population bid for them would shift the
  // first one.
  const floor = Math.max(25, minElevation - tier.below);
  const ceiling = maxElevation + tier.above;
  interface FieldSite { x: number; z: number; elevation: number; rank: number }
  const fieldSites: FieldSite[] = [];
  for (let gx = -span; gx <= span; gx++) {
    for (let gz = -span; gz <= span; gz++) {
      if (cellRandom(gx, gz, salt + 1) <= 0.62) continue;
      // Thinned hard. Fields are a kilometre and a half wide and the eye reads
      // three of them in a valley as farming country; thirty reads as wallpaper.
      if (cellRandom(gx, gz, salt + 31) > 0.42) continue;

      const cx = (gx + (cellRandom(gx, gz, salt + 32) - 0.5) * 0.72) * spacing;
      const cz = (gz + (cellRandom(gx, gz, salt + 33) - 0.5) * 0.72) * spacing;
      if (Math.hypot(cx, cz) < exclusion) continue;
      if (opts.siteAllowed && !opts.siteAllowed(cx, cz)) continue;

      const centre = sample(cx, cz);
      if (centre < floor || centre > ceiling) continue;

      // Flatter ground than an ordinary village needs. A patchwork is only
      // convincing where there is room to lay one out.
      let lo = centre;
      let hi = centre;
      for (const [ox, oz] of PROBE) {
        const h = sample(cx + ox * 300, cz + oz * 300);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      if (hi - lo > tier.slope * 0.8 || lo < floor) continue;

      fieldSites.push({ x: cx, z: cz, elevation: centre, rank: cellRandom(gx, gz, salt + 39) });
    }
  }

  fieldSites.sort((a, b) => a.rank - b.rank);
  const placed: FieldSite[] = [];
  for (const f of fieldSites) {
    if (placed.length >= MAX_FIELD_VILLAGES) break;
    if (villages.some((v) => Math.hypot(v.x - f.x, v.z - f.z) < FIELD_GAP)) continue;
    if (placed.some((o) => Math.hypot(o.x - f.x, o.z - f.z) < FIELD_SPACING)) continue;
    placed.push(f);
    villages.push({
      x: f.x,
      z: f.z,
      elevation: f.elevation,
      street: 0,
      fields: true,
      houses: [],
      strip: null,
    });
  }

  // --- Pass 3: houses stand on the finished ground, so the ones beside a strip
  // sit on its graded shoulder rather than hovering over the slope it replaced.
  const finished = (x: number, z: number): number => airstripHeight(x, z, sample(x, z));
  for (const v of villages) {
    layoutHouses(v, finished);
    addFarmland(v);
  }
}

/**
 * Register a village in the farmland grid so `farmland()` can find it.
 *
 * Farming villages are found so their fields can be drawn, plain ones so their
 * clearing can be taken back out — both want the same lookup.
 */
function addFarmland(v: Village): void {
  const reach = v.fields ? FARM_OUTER : HOME_OUTER;
  const gx0 = Math.floor((v.x - reach) / BUCKET);
  const gx1 = Math.floor((v.x + reach) / BUCKET);
  const gz0 = Math.floor((v.z - reach) / BUCKET);
  const gz1 = Math.floor((v.z + reach) / BUCKET);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
      const bucket = farmIndex.get(key);
      if (bucket) bucket.push(v);
      else farmIndex.set(key, [v]);
    }
  }
}

/**
 * Try a few headings for a runway at this site and keep the first that lies on
 * ground flat enough to grade without a visible cut. Returns null if none does —
 * the village still gets built, it just has no strip.
 */
function findStrip(
  sample: (x: number, z: number) => number,
  cx: number,
  cz: number,
  gx: number,
  gz: number,
  salt: number,
  minElevation: number,
  maxSpread: number,
): Airstrip | null {
  // Heading is the main lever for finding a clear approach, so sweep several
  // rather than giving up after a couple of unlucky draws.
  const ATTEMPTS = 8;
  const offset = cellRandom(gx, gz, salt + 5) * Math.PI;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const angle = offset + (attempt * Math.PI) / ATTEMPTS;
    const dirX = Math.sin(angle);
    const dirZ = Math.cos(angle);

    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let n = 0;
    for (let t = -STRIP_HALF_LENGTH; t <= STRIP_HALF_LENGTH + 1; t += STRIP_HALF_LENGTH / 4) {
      for (const side of [-1, 0, 1]) {
        const off = side * STRIP_HALF_WIDTH;
        const h = sample(cx + dirX * t + dirZ * off, cz + dirZ * t - dirX * off);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        sum += h;
        n++;
      }
    }
    if (hi - lo > maxSpread) continue;

    // The mean minimises cut and fill, so the pad blends into what was there.
    const elevation = sum / n;
    if (elevation < minElevation) continue;

    // A flat pad in the bottom of a bowl is not a runway. Require the ground on
    // the extended centreline to stay under a 4° approach surface from at least
    // one end, and make that end the landing direction.
    const towardPlus = approachIsClear(sample, cx, cz, dirX, dirZ, elevation, -1);
    const towardMinus = approachIsClear(sample, cx, cz, dirX, dirZ, elevation, 1);
    if (!towardPlus && !towardMinus) continue;

    const flip = towardPlus ? 1 : -1;
    const lx = dirX * flip;
    const lz = dirZ * flip;

    return {
      x: cx,
      z: cz,
      dirX: lx,
      dirZ: lz,
      headingDeg: (Math.atan2(lx, -lz) * RAD + 360) % 360,
      elevation,
    };
  }
  return null;
}

/**
 * Approach surface angle, tangent, measured from the threshold.
 *
 * Deliberately *shallower* than the ~3° an aircraft actually flies. An approach
 * surface as steep as the glide path guarantees nothing: terrain sitting right
 * on the limit is then exactly where the aeroplane wants to be, and a strip that
 * passes the check still flies you into a hill on short final.
 */
const APPROACH_SLOPE = Math.tan(2.5 * Math.PI / 180);
const APPROACH_START = 500;
const APPROACH_END = 3200;

/**
 * Whether the ground off one end of the strip stays below the approach surface.
 * `side` is −1 to test the ground before the −dir threshold (which is what an
 * aircraft landing along +dir flies over) and +1 for the other end.
 */
function approachIsClear(
  sample: (x: number, z: number) => number,
  cx: number,
  cz: number,
  dirX: number,
  dirZ: number,
  elevation: number,
  side: number,
): boolean {
  // 80 m steps rather than a coarser sweep: a ridge narrower than the sampling
  // interval slips between two clear samples and ends up on short final.
  for (let d = APPROACH_START; d <= APPROACH_END; d += 80) {
    const t = side * d;
    const h = sample(cx + dirX * t, cz + dirZ * t);
    if (h - elevation > (d - STRIP_HALF_LENGTH) * APPROACH_SLOPE) return false;
  }
  return true;
}

function addToIndex(strip: Airstrip): void {
  const gx0 = Math.floor((strip.x - STRIP_REACH) / BUCKET);
  const gx1 = Math.floor((strip.x + STRIP_REACH) / BUCKET);
  const gz0 = Math.floor((strip.z - STRIP_REACH) / BUCKET);
  const gz1 = Math.floor((strip.z + STRIP_REACH) / BUCKET);
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gz = gz0; gz <= gz1; gz++) {
      const key = ((gx & 0xffff) << 16) | (gz & 0xffff);
      const bucket = index.get(key);
      if (bucket) bucket.push(strip);
      else index.set(key, [strip]);
    }
  }
}

// Muted on purpose. Saturated walls and roofs at this scale turn a village into
// a handful of bright confetti dots rather than a settlement in the landscape.
const WALL_COLOURS = [0xcfc7b6, 0xbdb3a1, 0xada393, 0xc6b99f, 0x9e9a92, 0xd2ccc0];
const ROOF_COLOURS = [0x7a4b39, 0x6d4433, 0x565b60, 0x474a4f, 0x5e4438, 0x6a625a];

/** Plot rows either side of the street; the street itself (0) stays clear. */
const HOUSE_ROWS = [-2, -1, 1, 2];
const HOUSE_COLS = 5;

/**
 * How much of a house is left, from how far behind the lines it stands.
 *
 * In no-man's-land nothing is; within a kilometre almost nothing; out to two
 * and a half kilometres the villages are roofless shells, thinning to the odd
 * gutted house among intact ones.
 */
function houseState(x: number, z: number, roll: number): HouseState {
  const u = behindLines(x, z);
  if (u < 0) return 'rubble';
  if (u < 800) return roll < 0.72 ? 'rubble' : 'ruin';
  if (u < 2500) {
    const ruined = 1 - ((u - 800) / 1700) * 0.85;
    if (roll < ruined * 0.25) return 'rubble';
    return roll < ruined ? 'ruin' : 'intact';
  }
  return 'intact';
}

/**
 * Lay a village out on a jittered local grid.
 *
 * Slots rather than free scatter, so houses never intersect, and a single shared
 * street angle with only slight per-house jitter — a village where every roof
 * points a different way reads as debris rather than a settlement. A taller
 * building on the square gives the cluster a centre to read against.
 */
function layoutHouses(v: Village, height: (x: number, z: number) => number): void {
  const rnd = (k: number): number => cellRandom(Math.round(v.x), Math.round(v.z), k);

  const street = rnd(11) * Math.PI * 2;
  v.street = street;
  const cos = Math.cos(street);
  const sin = Math.sin(street);
  const along = 26;
  const across = 24;
  const target = 20 + Math.floor(rnd(12) * 15);

  const place = (
    lx: number, lz: number, s: number,
    width: number, depth: number, wallHeight: number, roofHeight: number,
  ): void => {
    const x = v.x + lx * cos - lz * sin;
    const z = v.z + lx * sin + lz * cos;
    v.houses.push({
      x,
      z,
      y: height(x, z),
      church: v.houses.length === 0,
      state: houseState(x, z, rnd(1100 + s)),
      width,
      depth,
      height: wallHeight,
      rotation: street + (rnd(700 + s) - 0.5) * 0.5,
      roofHeight,
      wall: new THREE.Color(WALL_COLOURS[Math.floor(rnd(900 + s) * WALL_COLOURS.length)]),
      roof: new THREE.Color(ROOF_COLOURS[Math.floor(rnd(1000 + s) * ROOF_COLOURS.length)]),
    });
  };

  // The church, on the square where the street widens.
  place(0, 0, 1, 13, 11, 13, 9 + rnd(13) * 2);

  const slots: [number, number][] = [];
  for (let i = -HOUSE_COLS; i <= HOUSE_COLS; i++) {
    for (const j of HOUSE_ROWS) slots.push([i * along, j * across]);
  }

  for (let s = 0; s < slots.length && v.houses.length < target; s++) {
    // Deterministic thinning, so a village is a cluster rather than a full block.
    if (rnd(100 + s) > 0.8) continue;

    const [lx, lz] = slots[s];
    place(
      lx + (rnd(200 + s) - 0.5) * 16,
      lz + (rnd(300 + s) - 0.5) * 13,
      s,
      8 + rnd(400 + s) * 5,
      7 + rnd(500 + s) * 4,
      4.5 + rnd(600 + s) * 3,
      2.6 + rnd(800 + s) * 1.8,
    );
  }
}

// --------------------------------------------------------------------- geometry

/** Unit box with its base on y = 0, so instances scale up from the ground. */
function unitBox(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  return geo;
}

/** Unit gable roof: 1 × 1 footprint, ridge along Z at y = 1. */
function unitGable(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0);
  shape.lineTo(0.5, 0);
  shape.lineTo(0, 1);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geo.translate(0, 0, -0.5);
  return geo;
}

/** A box in unit or metre space, flattened for merging. */
function slab(w: number, h: number, d: number, x: number, y: number, z: number, colour?: THREE.Color): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  if (colour) {
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = colour.r; c[i * 3 + 1] = colour.g; c[i * 3 + 2] = colour.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/**
 * A roofless shell: four walls broken off at different heights, gaps where
 * whole stretches have come down, and a heap of fallen masonry inside.
 *
 * Unit footprint, unit wall height; the instance stretches it to the house it
 * was. Three variants so a street of ruins is not one ruin repeated.
 */
function ruinShell(variant: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const t = 0.075;
  const r = (k: number): number => cellRandom(variant, k, 77);
  const wall = (along: 'x' | 'z', offset: number, seed: number): void => {
    const n = 5;
    for (let k = 0; k < n; k++) {
      const roll = r(seed + k);
      // Some stretches gone to the footings, most broken off part way, the odd
      // gable end still standing to the old roof line.
      const h = roll < 0.18 ? 0.08 : roll > 0.9 ? 1.25 : 0.3 + r(seed + k + 40) * 0.7;
      const len = 1 / n;
      const c = -0.5 + len * (k + 0.5);
      if (along === 'x') parts.push(slab(len * 1.02, h, t, c, 0, offset));
      else parts.push(slab(t, h, len * 1.02, offset, 0, c));
    }
  };
  wall('x', -0.5 + t / 2, 0);
  wall('x', 0.5 - t / 2, 10);
  wall('z', -0.5 + t / 2, 20);
  wall('z', 0.5 - t / 2, 30);
  // Fallen roof and masonry inside.
  parts.push(slab(0.62, 0.16, 0.5, (r(50) - 0.5) * 0.2, 0, (r(51) - 0.5) * 0.2));
  parts.push(slab(0.3, 0.1, 0.34, (r(52) - 0.5) * 0.4, 0.14, (r(53) - 0.5) * 0.4));
  return mergeGeometries(parts, false);
}

/** A heap of brick and stone with one stub of wall standing out of it. */
function rubbleMound(): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(0.5, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    let y = pos.getY(i);
    const z = pos.getZ(i);
    const jitter = 0.78 + 0.4 * cellRandom(Math.round(x * 97), Math.round(z * 89 + y * 31), 5);
    y = Math.max(0, y) * 0.42 * jitter;
    pos.setXYZ(i, x * (0.9 + 0.2 * jitter), y, z * (0.9 + 0.2 * jitter));
  }
  geo.computeVertexNormals();
  const mound = geo.toNonIndexed();
  geo.dispose();
  mound.deleteAttribute('uv');
  const stub = slab(0.08, 0.55, 0.32, 0.28, 0, -0.1);
  stub.deleteAttribute('uv');
  return mergeGeometries([mound, stub], false);
}

/** Church tower and spire, in metres, base at y = 0, centred on its footprint. */
function towerGeometry(): THREE.BufferGeometry {
  const stone = new THREE.Color(0.66, 0.63, 0.57);
  const slate = new THREE.Color(0.20, 0.22, 0.25);
  const spire = new THREE.ConeGeometry(3.9, 12, 4, 1);
  spire.rotateY(Math.PI / 4);
  spire.translate(0, 19 + 6, 0);
  const n = spire.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = slate.r; c[i * 3 + 1] = slate.g; c[i * 3 + 2] = slate.b; }
  spire.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const flatSpire = spire.toNonIndexed();
  spire.dispose();
  return mergeGeometries([
    slab(5.6, 19, 5.6, 0, 0, 0, stone),
    slab(6.0, 0.6, 6.0, 0, 18.6, 0, stone.clone().multiplyScalar(0.85)),
    flatSpire,
  ], false);
}

/** What shellfire leaves of a tower: a stump with a broken, stepped top. */
function towerStump(): THREE.BufferGeometry {
  const stone = new THREE.Color(0.55, 0.52, 0.47);
  const parts: THREE.BufferGeometry[] = [slab(5.6, 5, 5.6, 0, 0, 0, stone)];
  const heights = [9.5, 6.5, 12.5, 7.5];
  const offs: [number, number][] = [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]];
  offs.forEach(([x, z], k) => parts.push(slab(2.8, heights[k], 2.8, x, 0, z, stone)));
  return mergeGeometries(parts, false);
}

function instanced(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  count: number,
  shadows = true,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // one mesh spans the whole map; its bounds never cull
  return mesh;
}

export interface SettlementMeshOptions {
  /** Flat-roofed houses (the Levant): a low slab rather than a pitched roof. */
  flatRoofs?: boolean;
}

/**
 * Build every village in the current plan into one group: intact houses and
 * their churches, the shells of the ones near the lines, and the rubble of the
 * ones on them.
 *
 * `groundTone` is the world's dry-ground colour; the rubble is derived from it
 * so a ruined village sits in its own country's dust.
 */
export function buildSettlementMeshes(
  groundTone: [number, number, number],
  opts: SettlementMeshOptions = {},
): THREE.Group {
  const group = new THREE.Group();
  const all = villages.flatMap((v) => v.houses.map((h) => ({ h, v })));
  if (all.length === 0) return group;

  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 });
  const towerMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
  const ruinMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });

  const dust = new THREE.Color().setRGB(...groundTone, THREE.LinearSRGBColorSpace);
  const ash = new THREE.Color(0.30, 0.28, 0.25);
  const dummy = new THREE.Object3D();

  const intact = all.filter((e) => e.h.state === 'intact');
  const ruins = all.filter((e) => e.h.state === 'ruin');
  const rubble = all.filter((e) => e.h.state === 'rubble');

  if (intact.length > 0) {
    const bodies = instanced(unitBox(), wallMat, intact.length);
    const roofs = instanced(unitGable(), roofMat, intact.length);
    intact.forEach(({ h }, i) => {
      dummy.position.set(h.x, h.y - 0.4, h.z);
      dummy.rotation.set(0, h.rotation, 0);
      dummy.scale.set(h.width, h.height + 0.4, h.depth);
      dummy.updateMatrix();
      bodies.setMatrixAt(i, dummy.matrix);
      bodies.setColorAt(i, h.wall);

      dummy.position.set(h.x, h.y + h.height, h.z);
      const pitch = opts.flatRoofs && !h.church ? 0.35 : h.roofHeight;
      const eave = opts.flatRoofs && !h.church ? 1.04 : 1.16;
      dummy.scale.set(h.width * eave, pitch, h.depth * eave);
      dummy.updateMatrix();
      roofs.setMatrixAt(i, dummy.matrix);
      roofs.setColorAt(i, opts.flatRoofs && !h.church ? h.wall.clone().multiplyScalar(0.92) : h.roof);
    });
    group.add(bodies, roofs);

    const churches = intact.filter((e) => e.h.church && !opts.flatRoofs);
    if (churches.length > 0) {
      const towers = instanced(towerGeometry(), towerMat, churches.length);
      churches.forEach(({ h }, i) => {
        const back = h.depth / 2 + 2.6;
        dummy.position.set(h.x - Math.sin(h.rotation) * back, h.y - 0.5, h.z - Math.cos(h.rotation) * back);
        dummy.rotation.set(0, h.rotation, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        towers.setMatrixAt(i, dummy.matrix);
      });
      group.add(towers);
    }
  }

  if (ruins.length > 0) {
    const variants = [0, 1, 2].map((k) => ruins.filter((_, i) => i % 3 === k));
    variants.forEach((list, k) => {
      if (list.length === 0) return;
      const mesh = instanced(ruinShell(k + 1), ruinMat, list.length);
      list.forEach(({ h }, i) => {
        dummy.position.set(h.x, h.y - 0.3, h.z);
        dummy.rotation.set(0, h.rotation + (k === 1 ? Math.PI : 0), 0);
        dummy.scale.set(h.width, h.height + (h.church ? 2 : 0.3), h.depth);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // Scorched and dusted: the wall colour pushed toward ash and dirt.
        const c = h.wall.clone().lerp(ash, 0.45).lerp(dust, 0.12).multiplyScalar(0.82);
        mesh.setColorAt(i, c);
      });
      group.add(mesh);
    });
    const stumps = ruins.filter((e) => e.h.church);
    if (stumps.length > 0 && !opts.flatRoofs) {
      const mesh = instanced(towerStump(), towerMat, stumps.length);
      stumps.forEach(({ h }, i) => {
        const back = h.depth / 2 + 2.6;
        dummy.position.set(h.x - Math.sin(h.rotation) * back, h.y - 0.5, h.z - Math.cos(h.rotation) * back);
        dummy.rotation.set(0, h.rotation, 0);
        dummy.scale.set(1, 0.85 + cellRandom(Math.round(h.x), Math.round(h.z), 3) * 0.4, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      group.add(mesh);
    }
  }

  // Rubble: every flattened house, and a spill of it round each ruin.
  const heaps = [...rubble, ...ruins.filter((_, i) => i % 2 === 0)];
  if (heaps.length > 0) {
    const mesh = instanced(rubbleMound(), ruinMat, heaps.length);
    heaps.forEach(({ h }, i) => {
      const spill = h.state === 'ruin';
      const ox = spill ? (cellRandom(Math.round(h.x), Math.round(h.z), 8) - 0.5) * h.width : 0;
      const oz = spill ? (cellRandom(Math.round(h.x), Math.round(h.z), 9) - 0.5) * h.depth : 0;
      dummy.position.set(h.x + ox, h.y - 0.2, h.z + oz);
      dummy.rotation.set(0, h.rotation + cellRandom(Math.round(h.x), Math.round(h.z), 10) * 6.28, 0);
      const k = spill ? 0.55 : 1.15;
      dummy.scale.set(h.width * k, (spill ? 2.2 : 3.4 + h.height * 0.2) * (h.church ? 1.4 : 1), h.depth * k);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const c = h.wall.clone().lerp(ash, 0.5).lerp(dust, 0.3).multiplyScalar(0.78);
      mesh.setColorAt(i, c);
    });
    group.add(mesh);
  }

  return group;
}

/** Release the GPU resources of a group returned by `buildSettlementMeshes`. */
export function disposeSettlementMeshes(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
}
