import * as THREE from 'three';
import { fbm } from '../util/noise';
import { clamp, lerp, smoothstep } from '../util/math';

/**
 * Cities: a street grid, tens of thousands of towers, and lit windows at night.
 *
 * This is the one thing here that cannot be a height field. Every landscape is
 * `terrainHeight(x, z)`, sampled by both the mesh generator and the collision
 * sampler, and that works because hills are smooth. Towers are not: the
 * quadtree's finest chunk is 262144 / 2^10 = 256 m across at 24 segments, so
 * **10.7 m per vertex**. A 30 m tower is three vertices and the LOD rounds it
 * into a bump.
 *
 * So the buildings are geometry — but they are *planned* first, which is what
 * lets very different cities share one system. The plan has the same shape as
 * the ones the villages, the rivers and the pyramids use: search the ground
 * once when the world is chosen, bake the answer into a flat grid, and settle
 * every later question with one cheap lookup. That matters because `cityHeight`
 * sits on the collision path — 120 Hz for the aircraft, and again for every
 * terrain vertex — so it can afford an index but never a search.
 *
 * Where a city *goes* is a rule rather than a drawing:
 *
 *     buildable = flat enough AND low enough AND out of the water
 *
 * which is how cities actually sit, and gives a plausible footprint on any
 * terrain without anyone tracing a coastline. Towers cluster toward district
 * centres, the fringe thins to low-rise, and steep ground simply stays green —
 * so the grid breaks against the landscape on its own.
 */

// ---------------------------------------------------------------- config

/** A hand-placed supertall, positioned relative to its district's centre. */
export interface Landmark {
  dx: number;
  dz: number;
  height: number;
  radius: number;
  spire: number;
}

export interface CityConfig {
  /** The metropolis: where it is and how far it sprawls. */
  primary: { x: number; z: number; radius: number };
  /**
   * Share of the global 9 km grid that carries a town, 0 to 1.
   *
   * Places exist everywhere, for ever — not within some range of the
   * metropolis — so flying in a straight line keeps turning up new ones instead
   * of running out past its own neighbourhood. The grid is what guarantees they
   * stay apart: one candidate per cell, so no two can merge into sprawl.
   */
  density: number;
  /** Extent of the smallest and largest town. */
  satelliteRadius: [number, number];
  /** Rise over run above which nothing is built. */
  maxSlope: number;
  /** Metres above sea level above which nothing is built. */
  maxAltitude: number;
  /** Street and avenue spacing, and how many lots fit in a block. */
  blockX: number;
  blockZ: number;
  streetW: number;
  avenueW: number;
  lotsX: number;
  lotsZ: number;
  /** Grid bearing, radians. Manhattan's is famously not aligned to north. */
  gridAngle: number;
  /** Background building heights, before any district bump. */
  baseHeight: [number, number];
  /** Downtown clusters: how many, how far they reach, how tall they push. */
  districts: number;
  districtReach: number;
  districtHeight: number;
  landmarks: Landmark[];
  /** Share of tall buildings that are glass rather than masonry. */
  glassChance: number;
  /**
   * A fixed island laid into the terrain, for the one city that is a place
   * rather than a rule. Everything else is planned against the world's ground.
   */
  island?: {
    zNorth: number;
    zSouth: number;
    halfWidth: number;
    ground: number;
    park: { xHalf: number; zFrom: number; zTo: number };
  };
}

/** Deterministic per-cell randomness, the same idiom the tower fields use. */
function cellRandom(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- the island

/**
 * The fixed island's own land height.
 *
 * A pure function of position, so buildings can stand on it without asking the
 * terrain — which would be circular, since the terrain asks the city where the
 * island is.
 */
function islandLand(cfg: NonNullable<CityConfig['island']>, x: number, z: number): number {
  const t = clamp((z - cfg.zNorth) / (cfg.zSouth - cfg.zNorth), 0, 1);
  // The north end is a rock ridge, which is what stops the place reading as a
  // table.
  const ridge = (1 - smoothstep(0.02, 0.30, t)) * 46
    * Math.max(0, fbm(x * 0.0007, z * 0.0007, 3) + 0.35);
  return cfg.ground + ridge + fbm(x * 0.0004, z * 0.0004, 3) * 5;
}

/** How far inside the island a point is, 0 outside to 1 well inland. */
function islandMask(cfg: NonNullable<CityConfig['island']>, x: number, z: number): number {
  if (z < cfg.zNorth - 400 || z > cfg.zSouth + 400) return 0;
  const t = clamp((z - cfg.zNorth) / (cfg.zSouth - cfg.zNorth), 0, 1);

  const body = smoothstep(0, 0.045, t) * (1 - smoothstep(0.82, 1, t) * 0.94);
  const width = cfg.halfWidth * (0.62 + 0.38 * Math.sin(Math.PI * Math.min(1, t * 1.15))) * body;

  const drift = fbm(z * 0.00013 + 5, 2.5, 2) * 260;
  const west = -width * (0.94 + fbm(z * 0.00042 - 3, 1.5, 2) * 0.16) + drift;
  const east = width * (0.94 + fbm(z * 0.00042 + 9, 8.5, 2) * 0.16) + drift;
  if (east - west < 60) return 0;

  return Math.min(smoothstep(west, west + 26, x), smoothstep(east, east - 26, x));
}

/**
 * Lay the fixed island into the world's height field.
 *
 * Open water is forced around it rather than left to the seeded mainland noise
 * — the guard the Pacific uses to keep deep water under the carrier — with a
 * second term that stops that guard ever reaching the airfield.
 */
export function cityGround(x: number, z: number, natural: number): number {
  const island = active?.island;
  if (island === undefined) return natural;

  const dx = Math.max(0, Math.abs(x) - island.halfWidth);
  const mid = (island.zNorth + island.zSouth) / 2;
  const dz = Math.max(0, Math.abs(z - mid) - (island.zSouth - island.zNorth) / 2);
  const harbour = smoothstep(5600, 2400, Math.hypot(dx, dz))
    * smoothstep(4200, 7000, Math.hypot(x, z));
  const water = lerp(natural, -17, harbour);

  const inside = islandMask(island, x, z);
  if (inside <= 0) return water;
  return lerp(water, islandLand(island, x, z), inside);
}

// ---------------------------------------------------------------- the plan

/**
 * One inhabited place: the metropolis, or one of the towns scattered around it.
 *
 * `scale` runs from a village at 0.2 to the metropolis at 1, and drives how far
 * the place sprawls, how many districts it has, and how tall it is allowed to
 * get — a market town of 25 m blocks and a downtown of 250 m towers are the
 * same code with one number changed.
 */
interface CitySite {
  key: string;
  x: number;
  z: number;
  radius: number;
  scale: number;
  districts: number;
  island?: CityConfig['island'];
}

/** One built lot, as the meshes and the collision sampler both see it. */
interface Lot {
  cx: number;
  cz: number;
  width: number;
  depth: number;
  /** Underside of the box, below the lowest ground the footprint touches. */
  bottom: number;
  /** Roof: level, at the highest ground it touches plus the building's height. */
  top: number;
  glass: boolean;
  seed: number;
}

/**
 * A place that has been planned: its buildings, an index over them, its ground
 * tint, and its meshes.
 *
 * Everything a place owns is kept together so it can be built and thrown away
 * as a unit, which is what makes streaming possible at all.
 */
interface Planned {
  site: CitySite;
  lots: Lot[];
  bucketStart: Int32Array;
  bucketItems: Int32Array;
  gridMinX: number;
  gridMinZ: number;
  gridCols: number;
  gridRows: number;
  density: Float32Array;
  densityCols: number;
  densityRows: number;
  densityMinX: number;
  densityMinZ: number;
  group: THREE.Group;
  tiles: { cx: number; cz: number; meshes: THREE.InstancedMesh[]; low: THREE.InstancedMesh[] }[];
}

/** Bucket size for the lookup grid, metres. */
const BUCKET = 128;
/** Resolution of the coarse density field carried on the terrain mesh. */
const DENSITY_CELL = 220;

/**
 * Lowest ground a building may stand on, metres above sea level.
 *
 * Not zero: a footprint whose corner is a metre above the waterline still looks
 * like it is standing in the sea, and the ocean has waves.
 */
const SHORELINE = 4;

/**
 * How places are distributed across the world.
 *
 * One candidate per cell of this grid, everywhere, for ever — so flying in a
 * straight line keeps turning up new towns instead of running out past the
 * metropolis's own neighbourhood. Which cells actually get a place, and how big
 * it is, comes from a hash of the cell, so it is the same every time you pass.
 */
const SITE_CELL = 9000;
/** Places within this of the aircraft are planned. */
const KEEP_RADIUS = 26000;
/** And forgotten past this. The gap is hysteresis, so a place on the edge of
 *  the range is not built and dropped repeatedly. */
const DROP_RADIUS = 32000;
/** Places planned per frame. Planning one costs a few milliseconds. */
const PLAN_BUDGET = 1;

let active: CityConfig | null = null;
let sampler: (x: number, z: number) => number = () => 0;
let worldSeed = 1;
/** Everything currently planned, keyed by its cell. */
const planned = new Map<string, Planned>();
/** Cells already visited, so an empty one is not retried every frame. */
const barren = new Set<string>();
/** Where the meshes live. One group, so the scene sees a single object. */
let cityGroup: THREE.Group | null = null;
let nightUniform = { value: 0 };
let masonryMat: THREE.MeshStandardMaterial | null = null;
let glassMat: THREE.MeshStandardMaterial | null = null;

/**
 * Choose a world's city and forget whatever the last one planned.
 *
 * `sampleGround` is passed in rather than imported: the terrain module already
 * imports this one, and `planSettlements` sets the precedent for handing the
 * height field to a planner instead of reaching back for it.
 */
export function setCity(
  config: CityConfig | null,
  sampleGround: (x: number, z: number) => number,
  seed: number,
): void {
  active = config;
  sampler = sampleGround;
  worldSeed = seed;
  for (const p of planned.values()) disposePlanned(p);
  planned.clear();
  barren.clear();
}

/** The candidate place in a cell of the global grid, or null if it has none. */
function candidateAt(cfg: CityConfig, cellX: number, cellZ: number): CitySite | null {
  const key = `${cellX}|${cellZ}`;
  if (cellRandom(cellX + worldSeed, cellZ, 61) > cfg.density) return null;

  // Kept near the middle of its cell. At a wider jitter two places in
  // neighbouring cells can end up 2.7 km apart while their radii sum to 4.6 —
  // they merge, their grids overlap, and the same lot is built twice by both.
  // This bound guarantees at least 5.7 km between any two.
  const x = (cellX + 0.32 + cellRandom(cellX + worldSeed, cellZ, 62) * 0.36) * SITE_CELL;
  const z = (cellZ + 0.32 + cellRandom(cellX + worldSeed, cellZ, 63) * 0.36) * SITE_CELL;
  // Never on top of the airfield.
  if (Math.hypot(x, z) < 4600) return null;

  const scale = 0.20 + cellRandom(cellX + worldSeed, cellZ, 64) * 0.55;
  const radius = lerp(cfg.satelliteRadius[0], cfg.satelliteRadius[1], scale);

  // Never inside the metropolis. Reserving the grid cell at the origin looks
  // like it does this job, but the metropolis is nowhere near the origin — in
  // HARBOUR it is 9.5 km up the coast with a 7.2 km radius, so towns were being
  // planned in the middle of it: two overlaid street grids, buildings sharing
  // ground, and roofs disagreeing with the collision height by 130 m.
  const gap = Math.hypot(x - cfg.primary.x, z - cfg.primary.z) - cfg.primary.radius - radius;
  if (gap < 1500) return null;

  return { key, x, z, radius, scale, districts: scale > 0.5 ? 2 : 1 };
}

/** The metropolis: fixed, and always the first thing planned. */
function primarySite(cfg: CityConfig): CitySite {
  return {
    key: 'primary', x: cfg.primary.x, z: cfg.primary.z, radius: cfg.primary.radius,
    scale: 1, districts: cfg.districts, island: cfg.island,
  };
}

/**
 * Plan what is near, forget what is far.
 *
 * Budgeted the way the terrain's own chunk building is: at most one place per
 * frame, so arriving somewhere new costs a few milliseconds spread over a
 * second rather than a visible stall. The range is generous enough that a place
 * is planned long before the terrain chunks under it are built at a resolution
 * that would show its ground tint.
 */
function streamCity(focus: THREE.Vector3): void {
  const cfg = active;
  if (cfg === null || cityGroup === null) return;

  for (const [key, p] of planned) {
    if (key === 'primary') continue;
    if (Math.hypot(focus.x - p.site.x, focus.z - p.site.z) - p.site.radius > DROP_RADIUS) {
      disposePlanned(p);
      planned.delete(key);
    }
  }

  let budget = PLAN_BUDGET;
  if (!planned.has('primary')) {
    planCity(cfg, primarySite(cfg));
    budget--;
  }

  const reach = Math.ceil(KEEP_RADIUS / SITE_CELL);
  const cx = Math.floor(focus.x / SITE_CELL);
  const cz = Math.floor(focus.z / SITE_CELL);
  // Nearest first, so what you are flying at is built before what is behind you.
  const wanted: { site: CitySite; d: number }[] = [];
  for (let j = cz - reach; j <= cz + reach && budget > 0; j++) {
    for (let i = cx - reach; i <= cx + reach; i++) {
      const key = `${i}|${j}`;
      if (planned.has(key) || barren.has(key)) continue;
      const site = candidateAt(cfg, i, j);
      if (site === null) { barren.add(key); continue; }
      const d = Math.hypot(focus.x - site.x, focus.z - site.z);
      if (d > KEEP_RADIUS) continue;
      wanted.push({ site, d });
    }
  }
  wanted.sort((a, b) => a.d - b.d);
  for (let k = 0; k < wanted.length && budget > 0; k++) {
    planCity(cfg, wanted[k].site);
    budget--;
  }
}

function disposePlanned(p: Planned): void {
  cityGroup?.remove(p.group);
  p.group.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) o.geometry.dispose();
  });
}
function toGrid(cfg: CityConfig, x: number, z: number): [number, number] {
  const c = Math.cos(-cfg.gridAngle);
  const s = Math.sin(-cfg.gridAngle);
  return [x * c - z * s, x * s + z * c];
}

/** Rotate a point back out of the grid's frame. */
function fromGrid(cfg: CityConfig, x: number, z: number): [number, number] {
  const c = Math.cos(cfg.gridAngle);
  const s = Math.sin(cfg.gridAngle);
  return [x * c - z * s, x * s + z * c];
}

/**
 * How much city this ground can carry, 0 to 1.
 *
 * Flat, low and dry. The island world short-circuits it: there the footprint is
 * drawn rather than derived.
 */
function buildable(
  cfg: CityConfig,
  site: CitySite | null,
  sampleGround: (x: number, z: number) => number,
  x: number,
  z: number,
): number {
  if (site !== null && Math.hypot(x - site.x, z - site.z) > site.radius) return 0;

  const island = site?.island;
  if (island !== undefined) {
    const inside = islandMask(island, x, z);
    if (inside <= 0.5) return 0;
    const p = island.park;
    if (z > p.zFrom && z < p.zTo && Math.abs(x) < p.xHalf) return 0;
    return inside;
  }

  const h = sampleGround(x, z);
  if (h < 2) return 0; // in the water
  const low = 1 - smoothstep(cfg.maxAltitude * 0.55, cfg.maxAltitude, h);
  if (low <= 0) return 0;

  // Slope measured over 30 m, which is the scale a building cares about. A
  // gentler measure would happily terrace a cliff.
  const d = 30;
  const gx = (sampleGround(x + d, z) - sampleGround(x - d, z)) / (2 * d);
  const gz = (sampleGround(x, z + d) - sampleGround(x, z - d)) / (2 * d);
  const flat = 1 - smoothstep(cfg.maxSlope * 0.5, cfg.maxSlope, Math.hypot(gx, gz));
  return low * flat;
}

/**
 * Find the places worth building.
 *
 * The metropolis is given; the towns around it are searched for, the same way
 * villages and airstrips are — throw candidates at the map, keep the ones on
 * ground the rule likes, and enforce a separation so they stay separate places
 * with countryside between rather than merging into one sprawl.
 */
/** Plan one place: choose its buildings, index them, and build its meshes. */
function planCity(cfg: CityConfig, site: CitySite): void {
  const lots: Lot[] = [];
  const lotW = (cfg.blockX - cfg.avenueW) / cfg.lotsX;
  const lotD = (cfg.blockZ - cfg.streetW) / cfg.lotsZ;
  const sampleGround = sampler;

  // A town is not a small metropolis: its blocks are shorter and its tallest
  // building is a fraction of downtown's. Both fall out of one number.
  const baseLo = cfg.baseHeight[0] * (0.45 + 0.55 * site.scale);
  const baseHi = cfg.baseHeight[1] * (0.32 + 0.68 * site.scale);
  const districtHeight = cfg.districtHeight * Math.pow(site.scale, 1.6);
  const districtReach = cfg.districtReach * (0.4 + 0.6 * site.scale);
  const salt0 = Math.abs(Math.round(site.x * 0.01 + site.z * 0.013));

  // District centres, drawn from the seed and then nudged onto ground the rule
  // would actually build on — otherwise a downtown lands on a cliff.
  const centres: { x: number; z: number }[] = [];
  for (let i = 0; i < site.districts; i++) {
    let fallback: { x: number; z: number } | null = null;
    let placed = false;
    for (let attempt = 0; attempt < 48 && !placed; attempt++) {
      const a = cellRandom(salt0 + i * 13, attempt, 17) * Math.PI * 2;
      const r = Math.sqrt(cellRandom(salt0 + i * 13, attempt, 23)) * site.radius * 0.7;
      const x = site.x + Math.cos(a) * r;
      const z = site.z + Math.sin(a) * r;
      if (fallback === null) fallback = { x, z };
      if (buildable(cfg, site, sampleGround, x, z) > 0.55) { centres.push({ x, z }); placed = true; }
    }
    if (!placed && fallback !== null) centres.push(fallback);
  }

  // Walk the grid over this place. The centre is tested first, and only the
  // survivors pay for the five samples that give slope and footing.
  const [gx0, gz0] = toGrid(cfg, site.x, site.z);
  const span = site.radius;
  const bxFrom = Math.floor((gx0 - span) / cfg.blockX);
  const bxTo = Math.ceil((gx0 + span) / cfg.blockX);
  const bzFrom = Math.floor((gz0 - span) / cfg.blockZ);
  const bzTo = Math.ceil((gz0 + span) / cfg.blockZ);

  for (let bz = bzFrom; bz <= bzTo; bz++) {
    for (let bx = bxFrom; bx <= bxTo; bx++) {
      for (let lz = 0; lz < cfg.lotsZ; lz++) {
        for (let lx = 0; lx < cfg.lotsX; lx++) {
          const gx = bx * cfg.blockX + cfg.avenueW / 2 + (lx + 0.5) * lotW;
          const gz = bz * cfg.blockZ + cfg.streetW / 2 + (lz + 0.5) * lotD;
          const [cx, cz] = fromGrid(cfg, gx, gz);

          const salt = lx * 7 + lz * 31;
          if (cellRandom(bx, bz, salt) > 0.93) continue; // a plaza, a lot being rebuilt

          // The footprint is sampled once and used for everything: footing,
          // slope, and how much room there is. Asking `buildable` first cost
          // five samples of its own, on ground 30 m away that this lot then
          // sampled again — ten height samples per lot, and the lot loop is
          // most of the time it takes to stream a town in.
          let room: number;
          let centre = 0;
          if (site.island !== undefined) {
            // Island places are decided by the mask and never touch the height
            // field, so there is nothing to share.
            room = buildable(cfg, site, sampleGround, cx, cz);
            if (room <= 0.2) continue;
          } else {
            if (Math.hypot(cx - site.x, cz - site.z) > site.radius) continue;
            centre = sampleGround(cx, cz);
            if (centre < 2) continue; // in the water
            room = 1 - smoothstep(cfg.maxAltitude * 0.55, cfg.maxAltitude, centre);
            if (room <= 0.2) continue;
          }

          let district = 0;
          for (const c of centres) {
            district = Math.max(district,
              1 - smoothstep(0, districtReach, Math.hypot(cx - c.x, cz - c.z)));
          }

          const inset = 3 + cellRandom(bx, bz, salt + 307) * 5;
          const width = lotW - inset * 2;
          const depth = lotD - inset * 2;

          // Footing from the corners *and the centre*: four corners miss a rise
          // in the middle of the footprint, which on dunes let a crest stand
          // forty metres through a low building's roof.
          const hx = width / 2;
          const hz = depth / 2;
          const corners = [[-hx, -hz], [hx, -hz], [-hx, hz], [hx, hz]];
          const g: number[] = [];
          let lo = Infinity;
          let hi = -Infinity;
          for (const [ox, oz] of corners) {
            const [wx, wz] = fromGrid(cfg, ox, oz);
            const s = sampleGround(cx + wx, cz + wz);
            g.push(s);
            if (s < lo) lo = s;
            if (s > hi) hi = s;
          }
          // The centre matters as much as the corners: four corners miss a rise
          // in the middle of the footprint, which on dunes let a crest stand
          // forty metres through a low building's roof.
          const mid = site.island !== undefined ? sampleGround(cx, cz) : centre;
          if (mid < lo) lo = mid;
          if (mid > hi) hi = mid;
          if ((hi - lo) / Math.hypot(width, depth) > cfg.maxSlope * 1.6) continue;
          // Out of the water is a test of the *lowest corner*, not the centre.
          // Testing the centre alone put buildings on spits and sandbars with
          // half the footprint in the sea, which from the air reads as a city
          // standing on the water.
          if (site.island === undefined && lo < SHORELINE) continue;

          if (site.island === undefined) {
            // Slope across the building's own footprint rather than a fixed
            // 30 m either side — the same scale, and already paid for.
            const gradX = (g[1] + g[3] - g[0] - g[2]) / (4 * hx);
            const gradZ = (g[2] + g[3] - g[0] - g[1]) / (4 * hz);
            room *= 1 - smoothstep(cfg.maxSlope * 0.5, cfg.maxSlope, Math.hypot(gradX, gradZ));
            if (room <= 0.2) continue;
          }

          const base = baseLo + cellRandom(bx, bz, salt + 101) * (baseHi - baseLo);
          const tall = Math.pow(cellRandom(bx, bz, salt + 211), 2.2);
          // Blocks are tall on the avenue corners and lower through the middle.
          const corner = 1 - Math.abs((lx + 0.5) / cfg.lotsX - 0.5) * 1.1;
          // Never less than a couple of storeys: scaled far enough down, a
          // fringe building's roof ends up inside the ground it stands on.
          const height = Math.max(9,
            (base + district * corner * districtHeight * (0.35 + tall * 1.15))
              * (0.45 + 0.55 * room));

          lots.push({
            cx, cz, width, depth,
            bottom: lo - 5,
            top: hi + height,
            glass: height > 90 && cellRandom(bx, bz, salt + 401) < cfg.glassChance,
            seed: cellRandom(bx, bz, salt + 503),
          });
        }
      }
    }
  }

  // Landmarks belong to the metropolis alone; a market town does not have a
  // four-hundred-metre spire.
  if (site.key === 'primary') {
    for (let i = 0; i < cfg.landmarks.length; i++) {
      const l = cfg.landmarks[i];
      const c = centres[Math.min(i, centres.length - 1)];
      if (c === undefined) continue;
      const x = c.x + l.dx;
      const z = c.z + l.dz;
      const g = sampleGround(x, z);
      if (g < 2) continue; // the district drifted into the water

      // A supertall needs a city around it. Where the terrain rejected the
      // whole district the landmark was still placed, leaving a 400 m tower
      // standing alone in empty countryside.
      let neighbours = 0;
      for (const lot of lots) {
        if (Math.abs(lot.cx - x) < 700 && Math.abs(lot.cz - z) < 700) neighbours++;
      }
      if (neighbours < 40) continue;

      // Clear anything the tower's own footprint would overlap. A multiple of
      // the landmark's radius is not enough: it ignores the lot's half-width,
      // so a lot just outside that circle still shared ground with the tower
      // and the two roofs disagreed by four hundred metres.
      for (let k = lots.length - 1; k >= 0; k--) {
        const lot = lots[k];
        if (Math.abs(lot.cx - x) < l.radius + lot.width / 2 + 4
          && Math.abs(lot.cz - z) < l.radius + lot.depth / 2 + 4) {
          lots.splice(k, 1);
        }
      }
      lots.push({
        cx: x, cz: z, width: l.radius * 2, depth: l.radius * 2,
        bottom: g - 7, top: g + l.height,
        glass: i % 2 === 1, seed: 0.37 + i * 0.19,
      });
    }
  }

  // Not worth a place. Twelve buildings is a hamlet you fly over without
  // noticing — the point of these is that finding one is an event — so the bar
  // is a place you can see from the air, and the cell is marked barren so the
  // ground it failed on is never planned again.
  if (lots.length < 90) { barren.add(site.key); return; }

  const p: Planned = {
    site, lots,
    bucketStart: new Int32Array(1), bucketItems: new Int32Array(0),
    gridMinX: 0, gridMinZ: 0, gridCols: 0, gridRows: 0,
    density: new Float32Array(0), densityCols: 0, densityRows: 0,
    densityMinX: 0, densityMinZ: 0,
    group: new THREE.Group(), tiles: [],
  };
  indexLots(p);
  bakeDensity(cfg, p, sampleGround);
  buildSiteMeshes(cfg, p);
  planned.set(site.key, p);
  cityGroup?.add(p.group);
}

/**
 * Sort a place's lots into a flat bucket grid, so lookups are an index not a
 * search.
 *
 * A lot goes into every bucket its *footprint* touches, not just the one its
 * centre falls in. Indexing by centre alone leaves every building that straddles
 * a bucket edge invisible from the far side — and worse, the query comes from a
 * float32 instance matrix while the plan is float64, so a lot sitting exactly on
 * a boundary can be filed one side of it and looked up from the other. That is
 * a roof the aircraft falls straight through.
 */
function indexLots(p: Planned): void {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const l of p.lots) {
    minX = Math.min(minX, l.cx); maxX = Math.max(maxX, l.cx);
    minZ = Math.min(minZ, l.cz); maxZ = Math.max(maxZ, l.cz);
  }
  p.gridMinX = minX - BUCKET;
  p.gridMinZ = minZ - BUCKET;
  p.gridCols = Math.ceil((maxX - p.gridMinX) / BUCKET) + 2;
  p.gridRows = Math.ceil((maxZ - p.gridMinZ) / BUCKET) + 2;

  // Half the diagonal, so a rotated footprint is covered whatever its bearing.
  const spanOf = (l: Lot): [number, number, number, number] => {
    const r = Math.hypot(l.width, l.depth) / 2 + 1;
    return [
      Math.max(0, Math.floor((l.cx - r - p.gridMinX) / BUCKET)),
      Math.min(p.gridCols - 1, Math.floor((l.cx + r - p.gridMinX) / BUCKET)),
      Math.max(0, Math.floor((l.cz - r - p.gridMinZ) / BUCKET)),
      Math.min(p.gridRows - 1, Math.floor((l.cz + r - p.gridMinZ) / BUCKET)),
    ];
  };

  const counts = new Int32Array(p.gridCols * p.gridRows + 1);
  let total = 0;
  for (const l of p.lots) {
    const [x0, x1, z0, z1] = spanOf(l);
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) { counts[j * p.gridCols + i + 1]++; total++; }
    }
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  p.bucketStart = counts;
  p.bucketItems = new Int32Array(total);
  const cursor = Int32Array.from(counts);
  for (let k = 0; k < p.lots.length; k++) {
    const [x0, x1, z0, z1] = spanOf(p.lots[k]);
    for (let j = z0; j <= z1; j++) {
      for (let i = x0; i <= x1; i++) p.bucketItems[cursor[j * p.gridCols + i]++] = k;
    }
  }
}

/** Bake the coarse built-ness field the terrain shader reads for this place. */
function bakeDensity(
  cfg: CityConfig,
  p: Planned,
  sampleGround: (x: number, z: number) => number,
): void {
  const r = p.site.radius + DENSITY_CELL * 2;
  p.densityMinX = p.site.x - r;
  p.densityMinZ = p.site.z - r;
  p.densityCols = Math.ceil((2 * r) / DENSITY_CELL) + 1;
  p.densityRows = p.densityCols;
  p.density = new Float32Array(p.densityCols * p.densityRows);

  for (let j = 0; j < p.densityRows; j++) {
    for (let i = 0; i < p.densityCols; i++) {
      const x = p.densityMinX + i * DENSITY_CELL;
      const z = p.densityMinZ + j * DENSITY_CELL;
      let v = buildable(cfg, p.site, sampleGround, x, z);
      if (p.site.island !== undefined && v === 0) {
        // Parkland reads as negative, so one attribute carries both surfaces.
        const park = p.site.island.park;
        if (z > park.zFrom && z < park.zTo && Math.abs(x) < park.xHalf) {
          v = -islandMask(p.site.island, x, z);
        }
      }
      p.density[j * p.densityCols + i] = v;
    }
  }
}

// ---------------------------------------------------------------- sampling

/**
 * Height of the built surface, or -Infinity where there is nothing.
 *
 * Joined into `groundHeight` with a max, exactly as the carrier deck is: a roof
 * is ground that happens to be three hundred metres up, so gear contact, crash
 * detection and the camera's ground clearance all work unchanged.
 */
export function cityHeight(x: number, z: number): number {
  let best = -Infinity;
  for (const p of planned.values()) {
    // Cheap rejection first: most places are nowhere near.
    if (Math.abs(x - p.site.x) > p.site.radius + 200
      || Math.abs(z - p.site.z) > p.site.radius + 200) continue;
    const ix = Math.floor((x - p.gridMinX) / BUCKET);
    const iz = Math.floor((z - p.gridMinZ) / BUCKET);
    if (ix < 0 || iz < 0 || ix >= p.gridCols || iz >= p.gridRows) continue;
    const cell = iz * p.gridCols + ix;
    for (let k = p.bucketStart[cell]; k < p.bucketStart[cell + 1]; k++) {
      const l = p.lots[p.bucketItems[k]];
      if (Math.abs(x - l.cx) > l.width / 2 || Math.abs(z - l.cz) > l.depth / 2) continue;
      if (l.top > best) best = l.top;
    }
  }
  return best;
}

/** The places planned right now: the metropolis first, then whatever is near. */
export function citySites(): { x: number; z: number; radius: number; scale: number }[] {
  return [...planned.values()].map((p) => ({
    x: p.site.x, z: p.site.z, radius: p.site.radius, scale: p.site.scale,
  }));
}

/**
 * How built-up the ground is, -1 parkland to 1 city centre.
 *
 * Carried on the terrain mesh so a city reads from altitude, where the towers
 * themselves are a few pixels — the same problem the villages had, where what
 * made them visible was tinting the ground around them.
 */
export function cityDensity(x: number, z: number): number {
  for (const p of planned.values()) {
    const fx = (x - p.densityMinX) / DENSITY_CELL;
    const fz = (z - p.densityMinZ) / DENSITY_CELL;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    if (ix < 0 || iz < 0 || ix >= p.densityCols - 1 || iz >= p.densityRows - 1) continue;
    const tx = fx - ix;
    const tz = fz - iz;
    const a = p.density[iz * p.densityCols + ix];
    const b = p.density[iz * p.densityCols + ix + 1];
    const c = p.density[(iz + 1) * p.densityCols + ix];
    const d = p.density[(iz + 1) * p.densityCols + ix + 1];
    const v = lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
    if (v !== 0) return v;
  }
  return 0;
}

// ---------------------------------------------------------------- meshes

export interface CityMeshes {
  group: THREE.Group;
  /** Drive the window lights, 0 by day to 1 after dark. */
  setNight(amount: number): void;
  /** Stream places in and out, then cull and shadow-gate what is drawn. */
  update(camera: THREE.Camera, shadowRange: number, focus: THREE.Vector3): void;
  buildings(): number;
  meshes(): number;
}

/**
 * Tile size, metres.
 *
 * One pair of instanced meshes for a whole city sounds ideal — three draw calls
 * — and is the wrong trade. With `frustumCulled = false` every building is
 * submitted each frame whatever the camera is looking at, and again for the
 * shadow pass, into a frustum at most 2.2 km across. Tiles give the renderer
 * something it can actually discard.
 */
const TILE = 1600;
/** A building this tall is skyline, and is always drawn. */
const TALL = 90;
/** Beyond this the low-rise is dropped; the ground tint carries the city. */
const LOW_CUTOFF = 5500;

/** Build one place's instanced meshes, bucketed into tiles. */
function buildSiteMeshes(cfg: CityConfig, p: Planned): void {
  if (masonryMat === null || glassMat === null) return;
  const buckets = new Map<string, Lot[]>();
  for (const l of p.lots) {
    const skyline = l.top - l.bottom >= TALL;
    const key = `${Math.floor(l.cx / TILE)}|${Math.floor(l.cz / TILE)}`
      + `|${l.glass ? 'g' : 'm'}|${skyline ? 't' : 'l'}`;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [l]);
    else list.push(l);
  }

  const tiles = new Map<string, Planned['tiles'][number]>();
  for (const [key, list] of buckets) {
    const [tx, tz, mat, band] = key.split('|');
    const tileKey = `${tx}|${tz}`;
    let tile = tiles.get(tileKey);
    if (tile === undefined) {
      tile = { cx: (Number(tx) + 0.5) * TILE, cz: (Number(tz) + 0.5) * TILE, meshes: [], low: [] };
      tiles.set(tileKey, tile);
    }
    const mesh = makeInstances(list, mat === 'g' ? glassMat : masonryMat, cfg.gridAngle, band === 't');
    p.group.add(mesh);
    tile.meshes.push(mesh);
    if (band === 'l') tile.low.push(mesh);
  }
  p.tiles = [...tiles.values()];

  // Spires, so the tallest read as buildings rather than slabs.
  if (p.site.key !== 'primary') return;
  const spires = cfg.landmarks.filter((l) => l.spire > 0);
  const tops = p.lots.slice(Math.max(0, p.lots.length - cfg.landmarks.length));
  if (spires.length === 0 || tops.length === 0) return;
  const spireMat = new THREE.MeshStandardMaterial({
    color: 0xb9bec4, roughness: 0.4, metalness: 0.7,
  });
  const mesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.6, 3.2, 1, 8), spireMat, spires.length,
  );
  const dummy = new THREE.Object3D();
  let n = 0;
  cfg.landmarks.forEach((l, i) => {
    const t = tops[i];
    if (l.spire <= 0 || t === undefined) return;
    dummy.position.set(t.cx, t.top + l.spire / 2, t.cz);
    dummy.scale.set(1, l.spire, 1);
    dummy.updateMatrix();
    mesh.setMatrixAt(n++, dummy.matrix);
  });
  mesh.count = n;
  mesh.castShadow = true;
  mesh.computeBoundingSphere();
  p.group.add(mesh);
}

/** The city's meshes and the handle the world drives them with. */
export function buildCityMeshes(): CityMeshes {
  cityGroup = new THREE.Group();
  nightUniform = { value: 0 };
  masonryMat = windowLitMaterial(
    new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.86, metalness: 0.04 }),
    nightUniform,
  );
  glassMat = windowLitMaterial(
    new THREE.MeshStandardMaterial({
      color: 0x6f8496, roughness: 0.16, metalness: 0.55, envMapIntensity: 1.6,
    }),
    nightUniform,
  );

  return {
    group: cityGroup,
    setNight: (amount: number) => { nightUniform.value = amount; },
    update: (camera: THREE.Camera, shadowRange: number, focus: THREE.Vector3) => {
      streamCity(focus);
      const eye = camera.position;
      for (const p of planned.values()) {
        for (const tile of p.tiles) {
          const d = Math.hypot(eye.x - tile.cx, eye.z - tile.cz);
          // Only tiles that could land inside the shadow frustum cast into it.
          // A tile reaches half its own width past its centre, so that is the
          // margin. `receiveShadow` is deliberately left alone: unlike
          // castShadow it is part of the material's program, and toggling it
          // per frame would recompile shaders as the aircraft moved.
          const casts = d < shadowRange + TILE / 2;
          for (const mesh of tile.meshes) mesh.castShadow = casts;
          for (const mesh of tile.low) mesh.visible = d < LOW_CUTOFF;
        }
      }
    },
    buildings: () => {
      let n = 0;
      for (const p of planned.values()) n += p.lots.length;
      return n;
    },
    meshes: () => {
      let n = 0;
      for (const p of planned.values()) p.group.traverse((o) => { if (o instanceof THREE.InstancedMesh) n++; });
      return n;
    },
  };
}

export function disposeCityMeshes(city: CityMeshes): void {
  for (const p of planned.values()) disposePlanned(p);
  planned.clear();
  barren.clear();
  cityGroup = null;
  void city;
}

function makeInstances(
  list: Lot[],
  material: THREE.Material,
  angle: number,
  skyline: boolean,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, list.length);
  const dummy = new THREE.Object3D();
  const seeds = new Float32Array(list.length);

  list.forEach((l, i) => {
    dummy.position.set(l.cx, (l.top + l.bottom) / 2, l.cz);
    dummy.rotation.set(0, angle, 0);
    dummy.scale.set(l.width, l.top - l.bottom, l.depth);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    seeds[i] = l.seed;
  });
  mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  mesh.castShadow = true;
  // Receiving is a per-fragment shadow-map lookup — several taps under
  // PCFSoftShadowMap — paid whether or not the building is near the frustum.
  // The skyline keeps it; the low-rise backdrop, most of the count, does not.
  mesh.receiveShadow = skyline;
  // Bounds over the instances, not over the unit box the geometry describes:
  // without this the renderer culls a tile the moment its origin leaves view.
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * Windows, procedurally — no textures.
 *
 * The floor grid comes from the fragment's height inside its own building,
 * recovered from the instance matrix, and a hash per window decides whether
 * that one is lit. Anything constant across a building is computed in the
 * vertex shader instead: a box has 24 vertices and rather more fragments than
 * that, and the renderer's logarithmic depth buffer writes gl_FragDepth, which
 * disables early-Z — so among towers every *hidden* fragment pays for the
 * shader too.
 */
function windowLitMaterial(
  base: THREE.MeshStandardMaterial,
  night: { value: number },
): THREE.MeshStandardMaterial {
  base.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = night;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aSeed;
        varying vec3 vLocal;
        varying vec3 vFaceNormal;
        varying vec3 vSize;
        varying float vSeed;
        varying float vOccupancy;
        varying float vTone;

        float winHash(vec3 p) {
          return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSize = vec3(
          length(instanceMatrix[0].xyz),
          length(instanceMatrix[1].xyz),
          length(instanceMatrix[2].xyz));
        vLocal = position * vSize;
        vFaceNormal = normal;
        vSeed = aSeed;
        // Constant over a building, so computed once per vertex rather than
        // once per fragment. Offices empty at different rates: without the
        // per-building occupancy every tower carries the same average
        // brightness and a skyline reads as one glowing slab.
        vOccupancy = 0.12 + winHash(vec3(aSeed * 37.0, 3.0, 7.0)) * 0.46;
        vTone = 0.80 + 0.34 * winHash(vec3(aSeed * 7.3, 1.0, 2.0));`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uNight;
        varying vec3 vLocal;
        varying vec3 vFaceNormal;
        varying vec3 vSize;
        varying float vSeed;
        varying float vOccupancy;
        varying float vTone;

        float winHash(vec3 p) {
          return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vTone;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        // Side faces only: a roof has no windows.
        if (abs(vFaceNormal.y) < 0.5) {
          float across = abs(vFaceNormal.x) > 0.5 ? vLocal.z : vLocal.x;
          float up = vLocal.y + vSize.y * 0.5;
          vec2 uv = vec2(across / 3.1, up / 3.6);
          vec2 cell = floor(uv);
          vec2 f = fract(uv);
          // Mullions between the panes, so it is a grid of windows and not a
          // grid of coloured squares.
          float pane = step(0.14, f.x) * step(f.x, 0.88) * step(0.20, f.y) * step(f.y, 0.86);
          // Ground floors are lobbies and the parapet is solid wall.
          float band = step(7.0, up) * step(up, vSize.y - 2.5);

          // One hash for the whole window: whether it is lit, and what colour.
          float r = winHash(vec3(cell, vSeed * 91.7));
          float lit = step(r, vOccupancy);
          vec3 warm = mix(vec3(1.0, 0.86, 0.60), vec3(0.85, 0.93, 1.0), fract(r * 7.31));

          // Past about a window per pixel the grid cannot be resolved, and
          // sampling it anyway gives a different answer every frame — a field
          // of sparkling specks where a lit tower should be. Beyond that, use
          // the pattern's average. The same fix the sea's wave normals needed,
          // and the footprint comes from the rasteriser rather than a distance
          // guessed in advance.
          float footprint = max(fwidth(uv.x), fwidth(uv.y));
          float resolved = 1.0 - smoothstep(0.45, 1.4, footprint);
          float glow = mix(vOccupancy * 0.55, lit * pane, resolved) * band;

          totalEmissiveRadiance += warm * glow * uNight * 2.6;
          // By day the panes are darker than the wall — that contrast is most
          // of what makes a facade read as a facade.
          float shade = mix(0.55, pane, resolved) * band;
          diffuseColor.rgb *= 1.0 - shade * 0.32 * (1.0 - uNight * 0.7);
        }`);
  };
  // Otherwise this material can be handed the terrain's compiled program, or
  // the ocean's — they are all MeshStandardMaterial with an onBeforeCompile.
  base.customProgramCacheKey = () => `city-v6-${base.metalness > 0.3 ? 'glass' : 'masonry'}`;
  return base;
}

// ---------------------------------------------------------------- worlds

/**
 * The cities, as parameters rather than as code.
 *
 * Each is the same system pointed at different ground: what changes is where it
 * is allowed to build, how coarse its grid is, and how hard its districts push
 * upward. The terrain does the rest — a grid laid over steep islands fragments
 * into ribbons along the shore all by itself.
 */
export const CITY_CONFIGS: Record<string, CityConfig> = {
  /** Manhattan: the one city that is a place rather than a rule. */
  ISLAND_CITY: {
    primary: { x: 0, z: 18500, radius: 11000 },
    // A commuter belt that never runs out: roughly half the grid built on. The
    // largest town is capped below the other worlds' because the mainland here
    // is broad and almost entirely buildable — at 2300 m one fills its whole
    // disc with lots and costs a dropped frame to plan as it comes into range.
    density: 0.5, satelliteRadius: [900, 2050],
    maxSlope: 0.5, maxAltitude: 200,
    blockX: 276, blockZ: 92, streetW: 34, avenueW: 22, lotsX: 6, lotsZ: 2,
    gridAngle: 0,
    baseHeight: [20, 66], districts: 2, districtReach: 2600, districtHeight: 250,
    landmarks: [
      { dx: -120, dz: -300, height: 440, radius: 34, spire: 90 },
      { dx: 60, dz: 100, height: 500, radius: 30, spire: 110 },
    ],
    glassChance: 0.38,
    island: {
      zNorth: 9000, zSouth: 28000, halfWidth: 1750, ground: 14,
      park: { xHalf: 700, zFrom: 12500, zTo: 15500 },
    },
  },

  /**
   * HARBOUR. Mountains driven to the water's edge, so the city is squeezed onto
   * the coastal fringe and forced up the lower slopes. The slope limit is the
   * loosest of the three — this is the world that pays for the footing code.
   */
  HARBOUR: {
    primary: { x: 0, z: 9500, radius: 7200 },
    // Fishing towns and new towns tucked into the bays between the peaks. The
    // density carries the same load DOMES's does: most cells here are deep
    // water or a mountainside, and the flat shelf a town needs is only ever a
    // notch in the coast.
    density: 0.80, satelliteRadius: [700, 2000],
    maxSlope: 0.40, maxAltitude: 240,
    blockX: 150, blockZ: 84, streetW: 20, avenueW: 18, lotsX: 3, lotsZ: 2,
    gridAngle: 0.38,
    baseHeight: [34, 96], districts: 3, districtReach: 1500, districtHeight: 260,
    landmarks: [
      { dx: 40, dz: -60, height: 420, radius: 30, spire: 80 },
      { dx: -90, dz: 120, height: 350, radius: 26, spire: 0 },
    ],
    glassChance: 0.62,
  },

  /**
   * DOMES. Granite domes standing out of a bay, with the city filling every gap
   * between them. Blocks are small and the grid is turned off-axis, so the city
   * reads as fitted around the rock rather than imposed on it.
   */
  DOMES: {
    primary: { x: 0, z: 6800, radius: 5400 },
    // Settlements strung along the coast between the domes. The density is
    // higher, and the ceiling well above the 150 m the coastal strip allows,
    // because most cells here are open water or bare granite: a town has to be
    // able to climb a little way up between the domes to exist at all.
    density: 0.78, satelliteRadius: [750, 2100],
    maxSlope: 0.30, maxAltitude: 230,
    blockX: 168, blockZ: 96, streetW: 20, avenueW: 18, lotsX: 4, lotsZ: 2,
    gridAngle: -0.22,
    baseHeight: [22, 74], districts: 3, districtReach: 1700, districtHeight: 265,
    landmarks: [{ dx: 0, dz: 0, height: 300, radius: 26, spire: 60 }],
    glassChance: 0.34,
  },

  /**
   * GULF. A dead-flat coastal plain, one absurd supertall, and a tight cluster
   * around it. No slope work at all — the interest is all in the contrast with
   * the dune sea behind it.
   */
  GULF: {
    // Out on the coastal plain, clear of the dune sea behind it.
    primary: { x: 0, z: 13600, radius: 4400 },
    // Oasis towns and coastal settlements strung along the shore.
    density: 0.55, satelliteRadius: [800, 2200],
    maxSlope: 0.16, maxAltitude: 90,
    blockX: 240, blockZ: 130, streetW: 30, avenueW: 26, lotsX: 4, lotsZ: 2,
    gridAngle: 0.10,
    baseHeight: [16, 54], districts: 1, districtReach: 2100, districtHeight: 340,
    landmarks: [{ dx: 0, dz: 0, height: 760, radius: 30, spire: 240 }],
    glassChance: 0.78,
  },
};
