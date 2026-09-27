import { fbm, ridged } from '../util/noise';
import { lerp, smoothstep } from '../util/math';
import { CARRIER_SPAWN, CARRIER_X, CARRIER_Z, carrierDeckHeight } from './Carrier';
import { airstripHeight, planSettlements } from './Settlements';
import { planPyramids, pyramidHeight } from './Landmarks';
import { carveRivers, carveTarns, planRivers, type RiverSettings } from './Rivers';
import { CITY_CONFIGS, cityGround, cityHeight, setCity, type CityConfig } from './City';
import { planBoats } from './Boats';
import { planBalloons } from './Balloons';
import { planStructures } from './Structures';

/** Ground palette and snow line for a world, before the season modifies it. */
export interface TerrainStyle {
  grass: [number, number, number];
  dry: [number, number, number];
  rock: [number, number, number];
  snowLine: number;
  /**
   * Altitude where vegetation gives way to bare ground, metres.
   *
   * Has to be per-world. It was a constant 420–1000 m band, which is right for a
   * coastline and wrong everywhere else: an alpine valley floor at 1200 m came
   * out the colour of high scree, so the one world built around green valleys
   * under snow peaks rendered uniformly grey.
   */
  treeLine: number;
  /**
   * The sea, as deep water / shallow water / wet sand.
   *
   * Optional: a world that leaves it out gets a temperate coast, which is what
   * most of them are. The tropical world sets it, and that is the whole reason
   * the lagoon reads as a lagoon rather than as a hole in the ocean.
   */
  water?: { deep: number; shallow: number; sand: number; glow?: number };
  /** Strength of horizontal rock banding, 0 = none. Canyon country only. */
  strata: number;
}

export interface WorldPreset {
  name: string;
  blurb: string;
  /** Elevation of the flat airfield plateau, metres. */
  fieldElevation: number;
  /** Whether the sea is visible at all — pointless in a high mountain range. */
  hasOcean: boolean;
  /** Some worlds start you on a carrier rather than a runway. */
  hasAirfield?: boolean;
  /** Where the aircraft starts. Defaults to the runway threshold. */
  spawn?: { x: number; z: number; heading: number };
  /** Whether the carrier group is present. */
  hasCarrier?: boolean;
  /**
   * Whether sailing boats belong on this world's sea. Defaults to yes wherever
   * there is an ocean at all; the Antarctic sets it false and keeps the
   * freighters, because a yacht among the ice reads as a mistake.
   */
  hasSailboats?: boolean;
  /** Whether lighthouses, turbines, masts, castles and monasteries appear. */
  hasLandmarks?: boolean;
  /**
   * Per-kind tuning of the landmarks, as a multiplier on each one's chance.
   *
   * For the cases the placement rules cannot see: the ground in a canyon
   * satisfies everything a castle asks of it, and a castle is still not a thing
   * you find at the bottom of one.
   */
  landmarkDensity?: Partial<Record<string, number>>;
  /**
   * Whether the world is inhabited. Off for places nobody farms — a cluster of
   * pitched-roof farmhouses on an ice shelf would be worse than an empty one.
   */
  hasVillages?: boolean;
  /** Whether pyramid groups are built on the flat ground. */
  hasPyramids?: boolean;
  /**
   * The city planted in this world, if any. Its towers are geometry rather than
   * height field, so they join the ground through `groundHeight` the way the
   * carrier deck does.
   */
  city?: CityConfig;
  /** River network, or omitted for a world that is dry on purpose. */
  rivers?: RiverSettings;
  /**
   * Spacing of the village placement grid, metres. Only worth overriding where
   * the habitable land is much smaller than the default grid — a single tropical
   * island would otherwise fall between two cells and end up uninhabited.
   */
  villageSpacing?: number;
  style: TerrainStyle;
  /**
   * Raw elevation before the airfield pad is blended in. `sx`/`sz` carry the
   * seed offset; `d` is the *unseeded* distance from the origin, so terms that
   * must stay anchored to the airfield (coastal plain, land bias) use it.
   */
  height(sx: number, sz: number, d: number): number;
}

/**
 * Least height a shoreline stands above the water, metres.
 *
 * The ocean is one flat plane at y = 0 and the terrain is a quadtree whose
 * coarser chunks are 40 to 170 m per vertex. Where the land surface eases down
 * to meet the water, a wide band of those big triangles ends up level with the
 * plane and the two fight for the depth buffer — a coastline that flashes as
 * you fly along it. Both sides are held clear of y = 0 instead: land starts a
 * few metres up, the seabed a few metres down. The step itself is invisible —
 * one side of it is under water.
 */
const SHORE_STEP = 4;

const FIELD_RADIUS = 1900;
const FIELD_FALLOFF = 5200;

/**
 * Quantise height into benches: flat for the first `flatness` of each step, then
 * a quick riser. This one function is what turns rolling desert into stacked
 * mesas — the strata are geometry, not a texture.
 */
function terrace(h: number, step: number, flatness: number): number {
  const t = h / step;
  const base = Math.floor(t);
  return (base + smoothstep(flatness, 1, t - base)) * step;
}

/** Deterministic [0,1) per integer cell — used to seed volcano placement. */
function cellRandom(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Volcanic cones on a jittered grid.
 *
 * Only the nine cells around the sample are considered and most are rejected
 * immediately, so this stays cheap enough to evaluate per vertex. Each cone is a
 * smooth power falloff with a crater bitten out of the summit — the crater is
 * what stops them reading as generic hills.
 */
function volcanoes(sx: number, sz: number): number {
  const CELL = 17000;
  const gx = Math.floor(sx / CELL);
  const gz = Math.floor(sz / CELL);
  let tallest = 0;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      const pick = cellRandom(cx, cz, 1);
      if (pick > 0.5) continue; // only about half the cells carry a volcano

      const centreX = (cx + 0.2 + cellRandom(cx, cz, 2) * 0.6) * CELL;
      const centreZ = (cz + 0.2 + cellRandom(cx, cz, 3) * 0.6) * CELL;
      const radius = 3400 + pick * 7000;
      const r = Math.hypot(sx - centreX, sz - centreZ);
      if (r > radius) continue;

      const t = 1 - r / radius;
      let cone = Math.pow(t, 1.9) * (700 + pick * 3400);

      const craterRadius = radius * 0.12;
      if (r < craterRadius) cone -= (1 - r / craterRadius) * cone * 0.42;

      if (cone > tallest) tallest = cone;
    }
  }
  return tallest;
}

// --------------------------------------------------------------------- worlds

/** The original: scattered land and sea with a coastal airfield. */
function islesHeight(sx: number, sz: number, d: number): number {
  const continent = fbm(sx * 0.000055, sz * 0.000055, 4) * 0.9 + smoothstep(42000, 6000, d) * 0.85;
  const land = smoothstep(-0.02, 0.26, continent);

  const hills = (fbm(sx * 0.00012, sz * 0.00012, 4) * 0.5 + 0.5) * 380;
  const ridges =
    Math.max(0, ridged(sx * 0.00016 + 100, sz * 0.00016 - 50, 5) - 0.3) *
    2400 *
    smoothstep(0.15, 0.6, continent);
  const detail = fbm(sx * 0.0009, sz * 0.0009, 3) * 20;

  const above = hills * land + ridges + detail * land;
  const below = -(8 + (1 - land) * 320);

  const plainStrength = smoothstep(15000, 4000, d);
  const natural = lerp(below, above, land);
  return lerp(natural, Math.max(natural, 40), plainStrength);
}

/**
 * A high desert plateau split by a deep meandering canyon, with tributary side
 * canyons branching off it. The airfield sits up on the rim, so the canyon opens
 * up beneath you shortly after takeoff.
 */
function canyonHeight(sx: number, sz: number, d: number): number {
  const rim = 1450 + fbm(sx * 0.00004, sz * 0.00004, 3) * 240;

  // The main gorge wanders north-south; its centreline is a 1D noise of z.
  const meander = fbm(sz * 0.000045 + 11, 3.7, 2) * 5200;
  const fromAxis = Math.abs(sx - meander);
  // The width term is offset so it can never collapse. It used to be
  // 1700 ± 1100, and where the noise ran low the "mile-deep gorge" narrowed to
  // a 600 m slot — present in the height field, invisible unless you flew into
  // it.
  const halfWidth = 2700 + fbm(sz * 0.00016, 4.5, 2) * 900;
  const main = 1 - smoothstep(halfWidth * 0.45, halfWidth, fromAxis);

  // A branching network across the whole plateau, so there is canyon to see
  // wherever you happen to arrive rather than one ribbon to go and find. The
  // idiom is the fjords': `1 − |noise|` gives thin winding lines where a noise
  // field crosses zero, instead of the round blobs its peaks would give. The
  // threshold is calibrated against the noise's own distribution to carve about
  // a fifth of the map — enough to be everywhere, little enough to leave a
  // plateau for the buttes to stand on.
  const veins = 1 - Math.abs(fbm(sx * 0.000055 + 17, sz * 0.000055 - 4, 4) * 2.0);
  const side = smoothstep(0.80, 0.98, veins);

  const carve = Math.min(1, Math.max(main, side * 0.72));
  // Buttes stand on the plateau, not in the gorge, and not on the airfield.
  const buttes = monumentButtes(sx, sz)
    * (1 - carve)
    * smoothstep(FIELD_RADIUS, FIELD_FALLOFF, d);

  const h = rim - 1180 * carve + buttes + fbm(sx * 0.0006, sz * 0.0006, 2) * 14;
  // Benches, then keep the airfield rim clear of them so the runway stays flat.
  // Terracing *after* the buttes are added is deliberate: the bands wrap them
  // too, and banded strata is most of what makes a butte read as a butte.
  const banded = terrace(h, 78, 0.62);
  return lerp(h, banded, smoothstep(FIELD_RADIUS, FIELD_FALLOFF, d));
}

/**
 * Monument Valley buttes: isolated flat-topped towers with sheer walls.
 *
 * The silhouette is the whole thing, and it has three parts — a talus skirt of
 * fallen debris at the base, a vertical cliff above it, and a flat cap. A cone
 * gives none of them at any exponent. Saturation does: full height across most
 * of the radius, then a wall in the last third. That is the same shape the
 * karst towers use, with a flat top in place of a rounded crown.
 */
function monumentButtes(sx: number, sz: number): number {
  const CELL = 4600;
  const gx = Math.floor(sx / CELL);
  const gz = Math.floor(sz / CELL);
  let tallest = 0;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      if (cellRandom(cx, cz, 61) > 0.50) continue;

      const centreX = (cx + 0.2 + cellRandom(cx, cz, 62) * 0.6) * CELL;
      const centreZ = (cz + 0.2 + cellRandom(cx, cz, 63) * 0.6) * CELL;
      // Radius and height drawn from separate streams, so the field is not one
      // mesa scaled up and down — reusing a draw makes every tall butte a fat
      // one and the valley reads as a row of copies.
      // Tall and narrow. The first pass was 440-1400 m wide and only 170-470
      // tall, which is a mesa — a low table you fly over without noticing.
      // A butte is a tower: it has to be taller than it is wide to read as one.
      const radius = 150 + cellRandom(cx, cz, 64) * 330;
      const height = 260 + cellRandom(cx, cz, 65) * 400;
      const skirt = radius * 1.55;

      const r = Math.hypot(sx - centreX, sz - centreZ);
      if (r > skirt) continue;

      const wall = smoothstep(0, 0.22, 1 - Math.min(1, r / radius));
      const talus = Math.max(0, 1 - r / skirt) * 0.20;
      const top = height * Math.max(wall, talus);
      if (top > tallest) tallest = top;
    }
  }
  return tallest;
}

/**
 * The mainland the city's airfield sits on, and the harbour beyond it.
 *
 * Deliberately unremarkable: low wooded shore falling into open water. The
 * island is the subject, and it is laid in afterwards by `cityGround`, which
 * also forces water around itself so a reseed cannot beach it.
 */
function islandCityHeight(sx: number, sz: number, d: number): number {
  const relief = fbm(sx * 0.00009, sz * 0.00009, 4);
  // Land around the airfield, water further out. The bias term is what keeps
  // the far harbour open rather than letting the noise scatter islands into it.
  // The far term used to sink everything past eighteen kilometres, leaving the
  // metropolis alone on a disc of sea with nowhere to discover. The coast
  // continues now; the island stays an island because the harbour guard below
  // forces open water around it regardless.
  const land = smoothstep(13000, 5200, d) * 1.0 + relief * 0.6 - 0.12;

  // Rolling country, not a plain. The first version took `max(0, relief)` for
  // its height, which threw away the half of the noise that is negative and
  // left most of the mainland sitting at the 9 m base — six kilometres of dead
  // flat ground between 3 and 12 m. The splat blends beach sand into anything
  // below 34 m, so the whole shore came out a pale featureless sheet, and a
  // pale featureless sheet at sea level reads as water. The shape term is a
  // 0..1 profile rather than a signed relief, so nothing is discarded.
  const hills = Math.max(0, fbm(sx * 0.00016, sz * 0.00016, 4) * 0.5 + 0.5);
  // Wooded ridges and bluffs over the rolling ground, so the islands and
  // headlands around the city have shape of their own rather than being flat
  // green shelves with towns on them. Manhattan is untouched by any of this:
  // its ground comes from `islandLand`, laid over whatever is here.
  const bluffs = Math.pow(Math.max(0, ridged(sx * 0.00023 + 41, sz * 0.00023 - 19, 4) - 0.28), 1.2);
  // Amplitudes chosen against the distance you see them from: an island 15 km
  // away, seen from 2 km up, needs hundreds of metres of relief before it reads
  // as anything but a flat green table. At 240 m of hill it was still a table.
  const above = 26 + Math.pow(hills, 1.6) * 430 + bluffs * 900
    + fbm(sx * 0.0006, sz * 0.0006, 3) * 14;

  // The land rises out of the water instead of being blended down into it.
  // Fading `above` across a wide band of the land mask flattened every island
  // and headland into a green shelf a few metres proud of the sea — the hills
  // were in the height field and scaled away to nothing before they were drawn.
  if (land <= 0) return -8 - smoothstep(0, -0.55, land) * 32;
  return SHORE_STEP + above * smoothstep(0, 0.13, land);
}

/**
 * A drowned mountain range: steep peaks straight out of deep water, with a
 * narrow shelf around their feet.
 *
 * The shape is the whole point. A power falloff would give cones, and a city
 * cannot sit on a cone — what is wanted is a flat coastal fringe that ends in a
 * wall, which is *saturation*: near-level for the first few metres of the land
 * mask, then a steep climb. The city's slope rule then finds the fringe on its
 * own and leaves the peaks green.
 */
function harbourHeight(sx: number, sz: number, d: number): number {
  // Where land is at all: coarse, so the islands are big.
  const coast = fbm(sx * 0.00006 + 11, sz * 0.00006 - 5, 3);
  const land = coast + smoothstep(9000, 2400, d) * 0.5 - 0.16;
  if (land <= 0) return -22 - smoothstep(0, -0.40, land) * 110;

  // The peaks are a *separate*, much finer field. Driving both from one noise
  // gave ridges thirteen kilometres from crest to crest — 600 m of height
  // spread over that distance is a swell, not a mountain, and the city's slope
  // rule happily built across the whole thing. At this wavelength a peak is
  // about a kilometre wide, which is a wall.
  const relief = Math.pow(Math.max(0, ridged(sx * 0.00042 + 3, sz * 0.00042 - 8, 3)), 1.3);
  const shelf = 4 + fbm(sx * 0.0004, sz * 0.0004, 3) * 10;
  // The flat shelf survives only at the water's edge; inland the ridges take
  // over, which is what squeezes the city onto the shore.
  return shelf + relief * 640 * smoothstep(0.0, 0.20, land);
}

/**
 * Granite domes standing out of a bay.
 *
 * A dome is not a cone and not a butte: it is steep at the foot and rounded
 * over the top, which is what a sphere section gives and no power curve does.
 * `sqrt(1 - t^2)` is exactly that, and it is why these read as rock rather than
 * as hills.
 */
function domeField(sx: number, sz: number): number {
  const CELL = 3200;
  const gx = Math.floor(sx / CELL);
  const gz = Math.floor(sz / CELL);
  let tallest = 0;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      // Thinned from 0.34. At that density the bay was wall-to-wall granite
      // and the individual shapes stopped registering — a field of domes reads
      // as texture, where a scattering of them reads as landmarks.
      if (cellRandom(cx, cz, 71) > 0.23) continue;

      const centreX = (cx + 0.2 + cellRandom(cx, cz, 72) * 0.6) * CELL;
      const centreZ = (cz + 0.2 + cellRandom(cx, cz, 73) * 0.6) * CELL;
      // Size skewed small, so that the occasional giant reads as a giant rather
      // than as one more of the same. Height follows radius but not tightly:
      // squat pancakes and slender stacks come out of the same rule.
      const radius = 150 + Math.pow(cellRandom(cx, cz, 74), 1.7) * 1150;
      const height = radius * (0.5 + cellRandom(cx, cz, 75) * 1.25);

      const dx = sx - centreX;
      const dz = sz - centreZ;
      // Cheap rejection before the trigonometry: 1.32 is the widest either axis
      // can be stretched below.
      if (Math.abs(dx) > radius * 1.32 || Math.abs(dz) > radius * 1.32) continue;

      // Elliptical, and turned — a field of circles reads as a pattern however
      // much the sizes vary.
      const a = cellRandom(cx, cz, 76) * Math.PI;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ux = (dx * ca + dz * sa) / (radius * (0.62 + cellRandom(cx, cz, 77) * 0.7));
      const uz = (dz * ca - dx * sa) / (radius * (0.62 + cellRandom(cx, cz, 78) * 0.7));
      const t2 = ux * ux + uz * uz;
      if (t2 >= 1) continue;

      // The profile exponent varies the *shape*: below 0.5 a flat-topped mesa
      // with sheer sides, 0.5 the hemisphere these all used to be, above 1 a
      // rounded spire.
      const shape = 0.32 + cellRandom(cx, cz, 79) * 1.05;
      const top = height * Math.pow(1 - t2, shape);
      if (top > tallest) tallest = top;
    }
  }
  return tallest;
}

function domeHeight(sx: number, sz: number, d: number): number {
  const shore = fbm(sx * 0.00007 + 4, sz * 0.00007 + 9, 4);
  // A broad headland around the airfield breaking into bays further out. The
  // bias has to reach past the city's search area: at half this range the whole
  // downtown fell in open water and the placement rule found nowhere to build.
  const land = shore * 0.9 + smoothstep(14000, 2500, d) * 0.85 - 0.17;
  const domes = domeField(sx, sz);
  if (land <= 0) {
    // Domes rising straight out of the water are most of the drama, so they are
    // allowed to stand in the bay as well as on the shore.
    const sea = -SHORE_STEP - 2 - smoothstep(0, -0.4, land) * 68;
    return domes > 40 ? Math.max(sea, domes - 40) : sea;
  }
  // Country between the domes rather than a table they stand on: rolling hills
  // with the occasional ridge running through them. The domes are the drama, so
  // this stays well below them — but at a flat 5 to 19 m the whole world was
  // domes and nothing, which reads as a diagram of domes.
  const hills = fbm(sx * 0.00013 - 8, sz * 0.00013 + 3, 4) * 0.5 + 0.5;
  const ridges = Math.pow(Math.max(0, ridged(sx * 0.00021 + 15, sz * 0.00021 - 6, 4) - 0.42), 1.25);
  // Taller country under the domes, so some of them stand on high ground and
  // some at the waterline. With hills to 150 m and ridges to 700 m every dome
  // rose off much the same plate, and a dome on a mountain shoulder is a far
  // better thing to fly at than a dome on a lawn.
  const relief = 12 + Math.pow(Math.max(0, hills), 1.7) * 320 + ridges * 1250
    + fbm(sx * 0.00035, sz * 0.00035, 3) * 16;
  // Faded out at the waterline. Held at full height right up to it, land barely
  // above the threshold came out as a paper-flat green plate with a
  // twenty-metre cliff into the sea, instead of a beach.
  return SHORE_STEP + relief * smoothstep(0, 0.10, land) + domes;
}

/**
 * A desert shore: flat coastal plain, a dune sea running in behind it, and the
 * Gulf beyond. The plain is deliberately featureless — it is the setting for
 * one very tall building, and dunes on the doorstep would just hide it.
 */
function gulfHeight(sx: number, sz: number, d: number): number {
  // A long coastline, not an island. Keying the shore to distance from the
  // origin made the whole world a sixteen-kilometre disc of land with open sea
  // beyond it, so flying out simply ran out of ground for towns to stand on.
  const COAST = 16000;
  // The city's own peninsula stays radial, and so seed-independent. The
  // metropolis is placed at a fixed point 13.6 km out; keying the shore to
  // noise instead put it 54 m under water, and the world built nothing at all.
  const peninsula = smoothstep(COAST, COAST - 5200, d);
  // Past the gulf a real coastline picks up again. Without it the world was a
  // sixteen-kilometre disc with open sea beyond, so flying out simply ran out
  // of ground for towns to stand on.
  const shore = fbm(sx * 0.000055 + 21, sz * 0.000055 - 13, 4);
  // Signed on purpose — positive on land, negative at sea. Clamping it at zero
  // first, which is what `smoothstep` does, left every point just inside the
  // coast contour sitting at sea level with a cliff into deep water: flat pale
  // plates floating offshore instead of islands with beaches.
  const mainland = (shore - 0.06) * 2.4;
  const farCoast = smoothstep(COAST + 2000, COAST + 9000, d);
  const land = lerp(peninsula, mainland, farCoast);

  // The sea side drops clear of the ocean plane at once rather than easing down
  // to it. Approaching y = 0 asymptotically leaves a wide band of terrain
  // coplanar with the water, which at a grazing angle stipples and stairsteps
  // along the whole coast. The step is under water, so nothing shows.
  if (land <= 0) return -6 - smoothstep(0, -0.5, land) * 43;

  // Dune trains everywhere the ground is dry, on the peninsula behind the city
  // and across the far desert. The threshold on the far shore is deliberately
  // low: at 0.30 only its deepest interior raised any, and everything you
  // actually fly over came out a flat pale plain for forty kilometres.
  const ridgeField = ridged(sx * 0.00019 + 7, sz * 0.00011 - 4, 3);
  const duneMask = Math.max(
    peninsula * (1 - smoothstep(7000, 12500, d)),
    farCoast * smoothstep(0.05, 0.45, land),
  );
  const dunes = Math.pow(Math.max(0, ridgeField), 1.5) * 260 * duneMask;

  // Bare rock ranges standing out of the sand, on the far shore only. On the
  // peninsula a range is as likely to land on the metropolis as behind it —
  // the city is at a fixed point but the noise moves with the seed — and a
  // mountain through downtown is not a trade worth making.
  const massif = Math.max(0, ridged(sx * 0.00007 - 31, sz * 0.00007 + 17, 4) - 0.30);
  const mountains = Math.pow(massif, 1.35) * 1900 * farCoast * smoothstep(0.16, 0.62, land);

  // The land rises out of the water rather than being blended down into it: the
  // city belt used to sit two metres above the waterline for kilometres, which
  // from the air is a city standing on a shoal.
  // The plain stands well clear of the shader's beach band, which paints
  // everything below 34 m in its own pale sand. At 18 to 28 m the whole desert
  // was inside that band: the world's sand colour never got used at all, and a
  // flat white sheet is what a desert looks like from three kilometres up.
  const plain = 46 + fbm(sx * 0.00022, sz * 0.00022, 3) * 14;
  return SHORE_STEP + (plain + dunes + mountains) * smoothstep(0, 0.16, land);
}

/**
 * Steep coastal mountains cut by long, narrow sea inlets.
 *
 * The fjords come from the *zero crossings* of a noise field rather than from
 * noise peaks: taking 1 − |noise| makes thin winding lines, which is what gives
 * channels that snake inland instead of round bays.
 */
function fjordHeight(sx: number, sz: number, d: number): number {
  const continent = fbm(sx * 0.00004, sz * 0.00004, 3) * 0.95 + smoothstep(52000, 9000, d) * 0.9;
  const land = smoothstep(-0.05, 0.3, continent);

  const relief = Math.pow(Math.max(0, ridged(sx * 0.00009 + 5, sz * 0.00009 - 3, 4)), 1.25) * 1450;
  const plateau = (180 + relief) * land;

  const veins = 1 - Math.abs(fbm(sx * 0.000075 + 21, sz * 0.000075 - 9, 3) * 2.2);
  // A narrow smoothstep band is what makes the walls sheer rather than sloped.
  const inlet = smoothstep(0.74, 0.96, veins) * land;

  const carved = lerp(plateau, -260, inlet);
  const seabed = -(20 + (1 - land) * 300);
  const natural = lerp(seabed, carved, land);

  // Keep a dry shelf for the airfield at the head of the fjord.
  return lerp(natural, Math.max(natural, 55), smoothstep(11000, 3500, d));
}

/**
 * A high mountain range: a raised basin with ridged massifs on top. The airfield
 * sits at nearly 3 km, which the flight model handles on its own — thin air
 * means a noticeably longer takeoff roll, purely from the density term.
 */
function himalayaHeight(sx: number, sz: number, d: number): number {
  const basin = 2350 + fbm(sx * 0.00005, sz * 0.00005, 3) * 850;
  const massif = Math.pow(Math.max(0, ridged(sx * 0.00005 + 61, sz * 0.00005 - 17, 5)), 1.5) * 5200;
  const valleys = fbm(sx * 0.00018, sz * 0.00018, 3) * 240;
  const detail = fbm(sx * 0.0008, sz * 0.0008, 2) * 20;

  // Ease the massif away near the field so the strip sits in an open valley.
  return basin + massif * smoothstep(4000, 12000, d) + valleys + detail;
}

/**
 * A volcanic island: mossy coastal lowlands, black lava highlands, ice caps that
 * reach unusually far down, and scattered volcanoes with cratered summits.
 */
function icelandHeight(sx: number, sz: number, d: number): number {
  const continent = fbm(sx * 0.00005, sz * 0.00005, 3) * 0.9 + smoothstep(38000, 7000, d) * 0.95;
  const land = smoothstep(-0.03, 0.28, continent);

  const highland = (fbm(sx * 0.00013, sz * 0.00013, 4) * 0.5 + 0.5) * 560;
  const cones = volcanoes(sx, sz) * smoothstep(0.05, 0.35, continent);
  const detail = fbm(sx * 0.0007, sz * 0.0007, 2) * 18;

  const above = highland * land + cones + detail * land;
  const seabed = -(15 + (1 - land) * 260);
  const natural = lerp(seabed, above, land);

  // A coastal shelf so the airfield sits on dry ground.
  return lerp(natural, Math.max(natural, 35), smoothstep(12000, 3500, d));
}

/**
 * A tropical volcanic island: white sand, lush lowlands and a steep dark cone,
 * with open ocean around it for the carrier to sit in.
 */
function pacificHeight(sx: number, sz: number, d: number): number {
  // A compact island rather than a continent — the point is open water. The
  // carrier term guarantees deep water under the ship: without it the island
  // noise can raise land right where it floats, and the aircraft would spawn on
  // a hillside instead of the deck.
  const toCarrier = Math.hypot(sx - CARRIER_X, sz - CARRIER_Z);
  const island =
    fbm(sx * 0.00008, sz * 0.00008, 3) * 0.75 +
    smoothstep(9000, 2500, d) * 0.95 -
    smoothstep(5200, 1300, toCarrier) * 1.5;
  const land = smoothstep(0.06, 0.4, island);

  const lowland = (fbm(sx * 0.00022, sz * 0.00022, 3) * 0.5 + 0.5) * 180;
  const cone = volcanoes(sx, sz) * smoothstep(0.1, 0.45, island);
  const detail = fbm(sx * 0.0009, sz * 0.0009, 2) * 12;

  const above = lowland * land + cone + detail * land;
  // A broad shallow shelf, then the deep ocean the carrier operates in.
  const seabed = -(12 + smoothstep(0.05, -0.5, island) * 320);
  return lerp(seabed, above, land);
}

/**
 * One population of limestone towers on a jittered grid.
 *
 * The whole character is in the profile. A power falloff gives a cone at any
 * exponent — a high one is pointed, a low one is a dome with a flared skirt,
 * and neither is a tower. What is needed is *saturation*: full height across
 * most of the radius, then a wall in the last quarter of it. That is a
 * smoothstep, the same shape the desert inselbergs use for their mesa tops.
 *
 * Parameterised because karst is not one size of thing. A single grid can only
 * ever produce one scale of tower, and a field of those — however jittered —
 * reads as a texture rather than as landscape: nothing to fly *at*, because
 * everything is the same size as everything else. Two calls on different grids
 * give a common population you thread between and a rare one you can see from
 * twenty kilometres out.
 */
/**
 * How much dry land a tower needs around its own footprint, metres.
 *
 * Enough that the wall and the water are never in the same glance: at the
 * coast you get the plain running out to the bays, and the cliffs start once
 * you are properly over land.
 */
const SHORE_MARGIN = 900;

/**
 * How far from round a tower's footprint may be.
 *
 * `MAX_ASPECT` is load-bearing twice over: it stretches the ellipse, and it is
 * what the neighbour-cell bound above is computed from. Raising one without the
 * other would quietly clip the far end of the widest ridges.
 */
const MIN_ASPECT = 0.62;
const MAX_ASPECT = 1.52;

interface TowerField {
  /** Grid pitch, metres. Must be at least the widest tower, for the 3x3 scan. */
  cell: number;
  /** Fraction of cells carrying a tower, 0..1. */
  chance: number;
  /** Keeps the populations independent of each other. */
  salt: number;
  minRadius: number;
  maxRadius: number;
  minHeight: number;
  maxHeight: number;
  /** Metres around the airfield to leave empty; 0 to place them anywhere. */
  keepClear: number;
  /**
   * How far inland a tower has to stand, as a raw continent value.
   *
   * Measured against `karstContinent`, where the waterline is about 0.06. The
   * land *mask* is no use for this: it saturates a few hundred metres ashore,
   * so every threshold expressible in it is the beach.
   *
   * The shore is the one place a cliff must not be. A tower half in the water
   * reads as a sea stack, and a field of them along the coast hides the thing
   * that makes this world legible from the air — the plain running out to the
   * bays. The giants are held further in still, so what you meet at the coast
   * is open water and low ground, and the drama starts once you are over land.
   */
  minLand: number;
}

function towerField(sx: number, sz: number, f: TowerField): number {
  const gx = Math.floor(sx / f.cell);
  const gz = Math.floor(sz / f.cell);
  let tallest = -Infinity;

  // Which neighbouring cells can reach this sample at all.
  //
  // A full 3x3 scan is nine cells for every sample of every chunk, and almost
  // all of that work is wasted: a tower's centre sits between 0.15 and 0.85 of
  // its cell, so the closest a neighbour's tower can *start* is 0.15 of a cell
  // away, and the widest of them reaches nowhere near that. Only samples within
  // a sliver of a cell edge need to look next door.
  //
  //   centre of cell cx-1, at furthest:  (gx - 0.15) * cell
  //   this sample:                       (gx + fx)   * cell
  //   so it is in range only when        (fx + 0.15) * cell <= reach
  //
  // With the giants that sliver is a fifth of a cell and with the common towers
  // it is about one part in a hundred, which turns nine cells into a little
  // over one. The bound uses the *widest* tower the field can draw, so nothing
  // is ever missed — this changes the cost, not the terrain.
  const span = (f.maxRadius * MAX_ASPECT) / f.cell;
  const fx = sx / f.cell - gx;
  const fz = sz / f.cell - gz;
  const iFrom = fx <= span - 0.15 ? -1 : 0;
  const iTo = fx >= 1.15 - span ? 1 : 0;
  const jFrom = fz <= span - 0.15 ? -1 : 0;
  const jTo = fz >= 1.15 - span ? 1 : 0;

  for (let i = iFrom; i <= iTo; i++) {
    for (let j = jFrom; j <= jTo; j++) {
      const cx = gx + i;
      const cz = gz + j;
      if (cellRandom(cx, cz, f.salt) > f.chance) continue;

      const centreX = (cx + 0.15 + cellRandom(cx, cz, f.salt + 1) * 0.7) * f.cell;
      const centreZ = (cz + 0.15 + cellRandom(cx, cz, f.salt + 2) * 0.7) * f.cell;
      // Tested at the centre, so a tower is wholly present or wholly absent —
      // gating the *height* near the airfield would leave a sliced one leaning
      // over the runway instead. The field sits at the seed offset, because
      // that is where world (0,0) lands in this coordinate space.
      const centreD = Math.hypot(centreX - seedOffsetX, centreZ - seedOffsetZ);
      if (f.keepClear > 0 && centreD < f.keepClear) continue;

      // Height first, and the footprint follows it loosely. Drawn wholly
      // independently the tallest tower is as likely as not to be the
      // thinnest, which reads as a mast rather than as rock; drawn from the
      // same number every tower is the same shape. Half of each.
      const tall = cellRandom(cx, cz, f.salt + 3);
      const height = f.minHeight + tall * (f.maxHeight - f.minHeight);
      const spread = cellRandom(cx, cz, f.salt + 4);
      const radius = f.minRadius
        + (f.maxRadius - f.minRadius) * (tall * 0.55 + spread * 0.45);

      // An elliptical, rotated footprint. Circles give a field of cylinders,
      // all of them facing the same way because they have no way to face; the
      // ellipse is what turns some of them into ridges and blades.
      const aspect = MIN_ASPECT + cellRandom(cx, cz, f.salt + 5) * (MAX_ASPECT - MIN_ASPECT);
      const dx = sx - centreX;
      const dz = sz - centreZ;
      const reach = radius * Math.max(1, aspect);
      if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
      const ang = cellRandom(cx, cz, f.salt + 6) * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ex = dx * ca + dz * sa;
      const ez = (-dx * sa + dz * ca) / aspect;
      const r = Math.hypot(ex, ez);
      if (r > radius) continue;

      // Tested only now that the sample is known to be on this tower — the
      // land mask and the ground under it are noise lookups, and running them
      // for every cell of every sample would cost more than the towers.
      //
      // Tested around the whole footprint, not just under the middle. The mask
      // says how much land is *here*; it says nothing about how far the water
      // is, and a tower whose centre reads 0.9 can still have its foot in a bay
      // eight hundred metres away. A ring at the tower's own reach plus a
      // margin is what actually keeps cliffs off the shore.
      const inland = karstContinent(centreX, centreZ, centreD);
      if (inland < f.minLand) continue;
      if (f.minLand > 0) {
        // Sixteen bearings at two radii. Eight at one radius leaves nearly two
        // kilometres of arc unsampled at a giant's reach, and a bay poking into
        // that gap put a two-kilometre wall on a headland. Only samples already
        // known to be on this tower get here, so the cost is a rounding error
        // against the terrain it is guarding.
        let ashore = false;
        for (let k = 0; k < 16 && !ashore; k++) {
          const th = (k / 16) * Math.PI * 2;
          const cw = Math.cos(th);
          const sw = Math.sin(th);
          for (const ring of [reach * 0.6 + 400, reach + SHORE_MARGIN]) {
            const px = centreX + cw * ring;
            const pz = centreZ + sw * ring;
            const pd = Math.hypot(px - seedOffsetX, pz - seedOffsetZ);
            if (karstContinent(px, pz, pd) < f.minLand) {
              ashore = true;
              break;
            }
          }
        }
        if (ashore) continue;
      }

      const t = 1 - r / radius;
      // Where the wall ends and how the summit finishes, per tower: a sheer
      // column with a rounded crown, a tapered cone, a flat table, or anything
      // between. This is the rest of "different forms" — the ellipse decides
      // the plan, this decides the elevation.
      const wallEnd = 0.16 + cellRandom(cx, cz, f.salt + 7) * 0.30;
      const crownShare = 0.10 + cellRandom(cx, cz, f.salt + 8) * 0.30;
      const crownPower = 0.35 + cellRandom(cx, cz, f.salt + 9) * 1.10;
      const wall = smoothstep(0, wallEnd, t);
      const crown = (1 - crownShare) + crownShare * Math.pow(t, crownPower);
      // Footed on the ground under its own centre, not on sea level. Measured
      // at the centre so the foot is level: sampling underneath each point
      // would drape the tower over the hillside and tilt its summit.
      const foot = karstBase(centreX, centreZ, centreD, inland);
      const top = foot + wall * crown * height;
      if (top > tallest) tallest = top;
    }
  }
  return tallest;
}

/**
 * The common towers: what you fly between.
 *
 * Thinned twice now, to about a ninth of what this originally placed. The first
 * grid put one every 850 m across the whole map, and at that spacing they stop
 * being towers and become ground texture — you cannot fly *through* something
 * that is everywhere, only over it, which is the one thing this world exists
 * not to be. What is left is sparse enough that the country between them, and
 * the giants standing over it, is what you actually look at.
 */
const KARST_COMMON: TowerField = {
  cell: 2050, chance: 0.20, salt: 41,
  minRadius: 55, maxRadius: 175, minHeight: 170, maxHeight: 520,
  keepClear: 0, minLand: 0.34,
};

/**
 * The giants: what you fly *at*.
 *
 * A finer grid than the last pass and more often accepted, so there are enough
 * of them to steer by rather than one an hour — but still an order of magnitude
 * rarer than the common towers, because the point of an enormous thing is that
 * the others are not. They now stand on the hills and massifs as well, so their
 * summits run well past their own height. Held twelve kilometres clear of the
 * airfield: near enough to be what you climb out towards, far enough that the
 * departure is over open country and the aircraft has the height to look down
 * at them rather than up.
 */
const KARST_GIANTS: TowerField = {
  cell: 5000, chance: 0.55, salt: 61,
  minRadius: 380, maxRadius: 1000, minHeight: 1250, maxHeight: 2700,
  keepClear: 12000, minLand: 0.46,
};

function karstTowers(sx: number, sz: number): number {
  return Math.max(towerField(sx, sz, KARST_COMMON), towerField(sx, sz, KARST_GIANTS));
}

/**
 * Lakes scattered across the karst plain, as a 0..1 mask.
 *
 * Karst country is riddled with them — the same dissolution that leaves the
 * towers standing collapses the ground between them.
 */
function karstLakes(sx: number, sz: number): number {
  const CELL = 3600;
  const gx = Math.floor(sx / CELL);
  const gz = Math.floor(sz / CELL);
  let deepest = 0;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      const pick = cellRandom(cx, cz, 71);
      if (pick > 0.42) continue;

      const centreX = (cx + 0.2 + cellRandom(cx, cz, 72) * 0.6) * CELL;
      const centreZ = (cz + 0.2 + cellRandom(cx, cz, 73) * 0.6) * CELL;
      const radius = 170 + cellRandom(cx, cz, 74) * 520;
      const r = Math.hypot(sx - centreX, sz - centreZ);
      if (r > radius * 1.5) continue;

      // Only on ground that is properly inland and properly flat. A bowl cut
      // into the coastal ramp or a rising paddy shelf leaves most of its rim
      // dry and above the waterline, which reads as a lake painted up a slope.
      // Tested at the lake's *centre*, so a lake is wholly present or absent.
      // Only where the ground is properly inland. A bowl cut into the coastal
      // ramp leaves most of its rim dry and above the waterline, which reads as
      // a lake painted up a slope. Tested at the lake's *centre*, so a lake is
      // wholly present or wholly absent rather than sliced down the boundary.
      const inland = fbm(centreX * 0.00005, centreZ * 0.00005, 3) * 0.85
        + smoothstep(40000, 8000, Math.hypot(centreX, centreZ)) * 0.9;
      if (inland < 0.26) continue;

      // Wobble the rim. A circular bowl cut by a flat water plane gives a
      // perfectly circular shoreline, which reads as a drilled hole rather than
      // a lake — the irregular edge is most of what sells it.
      const wobble = 1 + fbm(sx * 0.0035 + cx * 7.1, sz * 0.0035 + cz * 3.3, 2) * 0.5;
      const edge = radius * wobble;
      if (r > edge) continue;

      // Shore shelving into a flat bed, rather than a cone.
      const bowl = smoothstep(edge, edge * 0.62, r);
      if (bowl > deepest) deepest = bowl;
    }
  }
  return deepest;
}

/**
 * How far inland this point is, as a raw continent value.
 *
 * This rather than the land mask is what everything coastal is measured
 * against. The mask saturates: it reaches 1 within a few hundred metres of the
 * water, so fading anything over it fades it over nothing — a massif keyed to
 * the mask rose seventeen hundred metres in twelve hundred, straight out of the
 * sea, and the mask said "inland" the whole way up. The continent value keeps
 * climbing long after the mask has stopped, over a twenty-kilometre wavelength,
 * so a band of it is a real distance.
 *
 * The waterline falls at about 0.06 — that is where the seabed and the land
 * above it cross zero. Everything below is stated relative to that.
 */
function karstContinent(sx: number, sz: number, d: number): number {
  return fbm(sx * 0.00005, sz * 0.00005, 3) * 0.85 + smoothstep(40000, 8000, d) * 0.9;
}

/** How much of this point is land: 0 at sea, 1 ashore. */
function karstLandMask(continent: number): number {
  return smoothstep(-0.08, 0.2, continent);
}

/**
 * The country the towers stand on, before any lake is cut into it.
 *
 * This used to be a flat paddy plain, and towers on a flat plain are a diagram:
 * every one of them the same height above the same ground, so the eye reads
 * a row of posts rather than a landscape. Now there is relief underneath —
 * rolling hills over the whole interior and a few real massifs — and a tower's
 * foot sits on whatever it happens to stand on, so the tall ones on high ground
 * genuinely tower and the ones down in the paddy do not.
 *
 * Held down near the airfield. The runway pad flattens 1.9 km and ramps out to
 * 5.2, which is enough to bury a hill and not enough to bury a massif; letting
 * the mountains start further out means the field sits on its plain and the
 * country rises as you fly away from it, which is also the better departure.
 */
function karstBase(sx: number, sz: number, d: number, continent: number): number {
  const land = karstLandMask(continent);
  const paddy = 42 + fbm(sx * 0.00035, sz * 0.00035, 3) * 14;
  // Biased to positive rather than clipped at zero. `Math.max(0, fbm)` leaves
  // half the map at exactly paddy level, which is why the median height stayed
  // at 44 m however tall the massifs got — most of the country was still the
  // flat plain this was supposed to stop being.
  const detail = fbm(sx * 0.0007, sz * 0.0007, 3) * 11;

  // Held back twice over. Away from the airfield, so departures are over the
  // plain and the country rises as you leave it — and away from the water, so
  // the coast is the flat paddy running out to the bays rather than a mountain
  // dropping into it. Multiplying by the land mask alone is not enough for the
  // second: the mask is already 1 a few hundred metres inland, which put a
  // kilometre of ground within a kilometre of the sea.
  //
  // Taken first so the noise below can be skipped where it would be multiplied
  // by nothing. Both terms are exactly zero over real areas — the whole coastal
  // strip, and everything within six kilometres of the field — and the hills
  // and ridges are the expensive half of the most expensive world here.
  const reach = smoothstep(6000, 20000, d) * smoothstep(0.12, 0.78, continent);

  let relief = detail;
  if (reach > 0) {
    // Biased to positive rather than clipped at zero. `Math.max(0, fbm)` leaves
    // half the map at exactly paddy level, which is why the median height
    // stayed at 44 m however tall the massifs got — most of the country was
    // still the flat plain this was supposed to stop being.
    // A three-kilometre wavelength, not seven. The amplitude was never the
    // problem — four hundred metres of rise stretched over seven kilometres is
    // a two per cent slope, which from a mile up is a table with a paint job.
    // What makes ground read as hills is how much of it moves within one
    // windscreen, so the frequency is what had to change.
    const hills = (fbm(sx * 0.00030 + 61, sz * 0.00030 - 27, 3) * 0.5 + 0.5) * 950;
    // A few massifs rather than mountains everywhere, gated by a much
    // larger-scale mask — and where that gate is shut the ridged field, which
    // is the single costliest lookup in this world, is never evaluated.
    const massif = smoothstep(0.12, 0.66, fbm(sx * 0.000032 + 7, sz * 0.000032 - 33, 2) + 0.5);
    const ridges = massif <= 0 ? 0
      : Math.pow(Math.max(0, ridged(sx * 0.00016 + 19, sz * 0.00016 - 5, 3) - 0.14), 1.1)
        * 2900 * massif;
    relief += (hills + ridges) * reach;
  }

  const above = paddy + relief * land;
  const seabed = -(9 + (1 - land) * 150);
  return lerp(seabed, above, land);
}

/**
 * Karst country: hills and massifs rising out of an alluvial plain and shallow
 * bays, out of which near-vertical limestone towers stand. The only world you
 * fly *through* rather than over.
 */
function karstHeight(sx: number, sz: number, d: number): number {
  const continent = karstContinent(sx, sz, d);
  const land = karstLandMask(continent);
  const base = karstBase(sx, sz, d, continent);

  // Lakes are pulled below sea level so the existing ocean plane fills them —
  // no second water surface, and they read as water for free. Only on the low
  // ground: a tarn punched into the side of a massif is a hole, not a lake.
  const low = smoothstep(260, 110, base);
  const ground = lerp(base, -7, karstLakes(sx, sz) * land * low);

  // Towers carry their own footing, so this is still a maximum rather than a
  // sum — a tower standing in a lake or in the shallows still stands, which is
  // the silhouette the whole world is for.
  return Math.max(ground, karstTowers(sx, sz));
}

/* --------------------------------------------------------------------- lagoon
 *
 * A drowned volcano inside a barrier reef. Unlike every other world here the
 * shape is *placed* rather than grown: the island, the lagoon and the reef sit
 * at fixed distances from the airfield, and reseeding changes their detail —
 * where the reef wobbles, where the passes cut, how the ridges run — without
 * moving them. An atoll whose reef landed somewhere different every time would
 * not be a place you could learn.
 */

/**
 * Island centre, in metres from the airfield. The field sits on its west coast.
 *
 * East rather than north because the runway is north-south and cannot be
 * turned: with the island up the centreline, the approach gate eight
 * kilometres out sat inside a two-kilometre mountain and the scenic flight
 * could never get down. Offset to the side, both ends of the runway have open
 * lagoon in front of them and the peak is off the wing where you can see it.
 */
const LAGOON_ISLAND_X = 7000;
const LAGOON_ISLAND_Z = 0;
/** Mean radius of the island's shoreline, and of the barrier reef, metres. */
const LAGOON_SHORE = 8600;
const LAGOON_REEF = 14500;
/** Height of the volcanic peak above the sea, metres. */
const LAGOON_PEAK = 1780;
/** How deep the lagoon floor lies, and how deep the ocean is outside the reef. */
const LAGOON_FLOOR = -17;
const LAGOON_ABYSS = -1250;

/**
 * The volcanic island: a steep basalt cone cut by radial ridges and valleys.
 *
 * The ridges are angular rather than positional — a function of the bearing
 * from the summit, not of where you are — which is what makes them run *down*
 * the mountain the way erosion does, instead of lying across it like a rumpled
 * cloth. Straight fbm on the surface gives lumps; this gives spurs and gullies.
 */
function lagoonIsland(ix: number, iz: number, r: number, sx: number, sz: number): number {
  const shore = LAGOON_SHORE * (1 + fbm(sx * 0.00007 + 31, sz * 0.00007 - 17, 3) * 0.16);
  if (r > shore) return 0;

  const t = 1 - r / shore;
  // Steep in the middle, flattening into a coastal plain at the foot — the
  // profile a young volcanic island has once the sea has cut a bench round it.
  const cone = Math.pow(t, 1.9) * LAGOON_PEAK;

  // Radial spurs. `bearing` is 0..1 round the compass and wraps, so the noise
  // is sampled on a circle to keep the ridge either side of due north the same
  // ridge rather than a seam.
  const bearing = Math.atan2(iz, ix);
  const ridgeSeed = ridged(Math.cos(bearing) * 2.6 + 40, Math.sin(bearing) * 2.6 - 12, 3);
  const spurs = (ridgeSeed - 0.45) * 620 * Math.pow(t, 1.15) * smoothstep(0.02, 0.35, t);

  // Gullies bitten into the flanks, fading out at the summit and the shore.
  const gullies = -Math.abs(fbm(sx * 0.00045 + 9, sz * 0.00045 + 5, 3)) * 190
    * smoothstep(0.03, 0.4, t) * smoothstep(1.0, 0.6, t);

  const detail = fbm(sx * 0.0012, sz * 0.0012, 3) * 9 * smoothstep(0.0, 0.15, t);
  // The last hundred metres of shore run down under the water rather than
  // stopping at it, so the island has a beach instead of a cut edge.
  const beach = smoothstep(0, 0.055, t);
  return (cone + spurs + gullies + detail) * beach - (1 - beach) * 6;
}

/**
 * The barrier reef: a ring a few hundred metres wide, breaking the surface.
 *
 * Everything interesting about it is in the modulation. A clean ring is a
 * bathtub; what makes a reef read as a reef is that it wanders, that sand
 * islets sit on it in some places and not others, and that it is cut through
 * by passes deep enough to take a ship.
 */
function lagoonReef(bearing: number, r: number, sx: number, sz: number): number {
  const wobble = fbm(Math.cos(bearing) * 1.9 + 71, Math.sin(bearing) * 1.9 - 23, 3);
  const ring = LAGOON_REEF * (1 + wobble * 0.075);
  const width = 620 + fbm(Math.cos(bearing) * 3.4 - 5, Math.sin(bearing) * 3.4 + 8, 2) * 260;
  const across = Math.abs(r - ring);
  if (across > width * 2.2) return LAGOON_ABYSS;

  // The crest, just under the surface, falling away on both sides.
  const crest = smoothstep(width, width * 0.32, across);

  // Motus: sand islets sitting on the reef where the crest is widest. Drawn
  // from a coarser bearing noise so they come in stretches rather than one
  // every kilometre all the way round.
  const motuSeed = fbm(Math.cos(bearing) * 5.2 + 13, Math.sin(bearing) * 5.2 - 41, 2);
  const motu = smoothstep(0.16, 0.52, motuSeed)
    * smoothstep(width * 0.62, width * 0.16, across)
    * (5.5 + fbm(sx * 0.0016, sz * 0.0016, 2) * 2.6);

  // Passes: a few deep cuts, on their own much coarser noise so they are rare
  // and wide rather than a dotted line of gaps.
  // Thresholds set against what this noise actually produces on a circle of
  // this radius — it spans about -0.73 to +0.25, so anything asked of it above
  // a quarter never happens, and the reef came out sealed all the way round.
  const passSeed = fbm(Math.cos(bearing) * 1.35 - 60, Math.sin(bearing) * 1.35 + 29, 2);
  const pass = smoothstep(0.155, 0.235, passSeed);

  const reefTop = -0.7 + fbm(sx * 0.0009 + 3, sz * 0.0009 - 7, 2) * 1.1;
  const built = lerp(LAGOON_FLOOR, reefTop, crest) + motu * (1 - pass);
  // A pass cuts the ring down to a channel, and takes the motus with it.
  return lerp(built, -15 - crest * 4, pass * crest);
}

/**
 * The other atolls.
 *
 * One island in an empty ocean is a diorama: you fly out, you fly back, and
 * there is nowhere else. These are the rest of the group — raised coral islands
 * inside their own reefs, and some reefs with no island at all, which is what an
 * atoll proper is once the volcano has gone under.
 *
 * The ones with an island get a flat interior well above the sea, because that
 * is what the settlement planner needs to put a village and its airstrip
 * somewhere: it wants ground over 25 m that moves less than 70 m across six
 * hundred, and a raised limestone island — steep rim, flat top — is exactly
 * that shape. So the airports come for free from the terrain being the right
 * shape, rather than from anything placing them.
 */
const LAGOON_ATOLL_CELL = 19_000;
/** Fraction of cells carrying an atoll. */
const LAGOON_ATOLL_CHANCE = 0.70;
/** Widest a satellite's reef can be, for the neighbour-cell bound. */
const LAGOON_ATOLL_REACH = 9500;
/** Base salt for the group's layout; the seed is added to it. */
const LAGOON_ATOLL_SALT = 91;

function lagoonAtolls(px: number, pz: number, sx: number, sz: number): number {
  const cell = LAGOON_ATOLL_CELL;
  // Salted with the seed so a new landscape re-sites the whole group.
  //
  // The main atoll deliberately stays put — it is the place you learn — but
  // these are laid out on cell coordinates alone, which do not move when the
  // world is reseeded. Without this, "New World" gave back the same thirty-one
  // islands in the same thirty-one places every time, which is the one thing
  // that button is for.
  const salt = LAGOON_ATOLL_SALT + (currentSeed % 4096) * 8;
  const gx = Math.floor(px / cell);
  const gz = Math.floor(pz / cell);
  // The same narrow scan the karst towers use: a satellite reaches nowhere near
  // a cell's width, so only samples close to a cell edge need to look next door.
  const span = LAGOON_ATOLL_REACH / cell;
  const fx = px / cell - gx;
  const fz = pz / cell - gz;
  let best = LAGOON_ABYSS;

  for (let i = fx <= span - 0.15 ? -1 : 0; i <= (fx >= 1.15 - span ? 1 : 0); i++) {
    for (let j = fz <= span - 0.15 ? -1 : 0; j <= (fz >= 1.15 - span ? 1 : 0); j++) {
      const cx = gx + i;
      const cz = gz + j;
      if (cellRandom(cx, cz, salt) > LAGOON_ATOLL_CHANCE) continue;

      const centreX = (cx + 0.18 + cellRandom(cx, cz, salt + 1) * 0.64) * cell;
      const centreZ = (cz + 0.18 + cellRandom(cx, cz, salt + 2) * 0.64) * cell;

      // Clear of the main atoll, and clear of the airfield: a reef across the
      // departure would be a reef across the departure.
      const fromMain = Math.hypot(centreX - LAGOON_ISLAND_X, centreZ - LAGOON_ISLAND_Z);
      if (fromMain < LAGOON_REEF + LAGOON_ATOLL_REACH + 7000) continue;
      if (Math.hypot(centreX, centreZ) < LAGOON_REEF + 5500) continue;

      const dx = px - centreX;
      const dz = pz - centreZ;
      const reefR = 3400 + cellRandom(cx, cz, salt + 3) * 3600;
      if (Math.abs(dx) > reefR * 1.4 || Math.abs(dz) > reefR * 1.4) continue;
      const r = Math.hypot(dx, dz);
      if (r > reefR * 1.4) continue;

      const bearing = Math.atan2(dz, dx);
      // A third of them have lost their island entirely — a ring of motus round
      // an empty lagoon, which is what the word atoll actually means.
      const drowned = cellRandom(cx, cz, salt + 4) < 0.26;
      const islandR = drowned ? 0 : reefR * (0.34 + cellRandom(cx, cz, salt + 5) * 0.20);

      let here = LAGOON_ABYSS;
      if (!drowned && r < islandR) {
        // Raised coral: a steep rim and a flat top. Deliberately not a cone —
        // a cone has no flat ground on it anywhere, and these are the islands
        // that have to carry an airstrip.
        const top = 55 + cellRandom(cx, cz, salt + 6) * 115;
        const t = 1 - r / islandR;
        // A narrow rim and a wide top. The settlement planner wants ground that
        // moves less than seventy metres across six hundred, and how much of
        // the island qualifies is decided entirely by this number.
        const rim = smoothstep(0, 0.20, t);
        here = top * rim
          + fbm(sx * 0.0006 + 12, sz * 0.0006 - 30, 3) * 11 * rim
          - (1 - rim) * 5;
      } else {
        // Lagoon inside the ring, reef on it, and the drop-off outside.
        const wobble = fbm(Math.cos(bearing) * 2.2 + cx * 3.7, Math.sin(bearing) * 2.2 + cz * 2.9, 3);
        const ring = reefR * (1 + wobble * 0.085);
        const width = 380 + cellRandom(cx, cz, salt + 7) * 260;
        const across = Math.abs(r - ring);
        const crest = smoothstep(width, width * 0.3, across);
        const motuSeed = fbm(Math.cos(bearing) * 4.6 + cz * 5.1, Math.sin(bearing) * 4.6 - cx * 4.3, 2);
        const motu = smoothstep(0.10, 0.46, motuSeed)
          * smoothstep(width * 0.6, width * 0.15, across)
          * (4.5 + fbm(sx * 0.0018, sz * 0.0018, 2) * 2.2);
        const reef = lerp(-9, -0.6, crest) + motu;

        const floor = -7 + fbm(sx * 0.0006 - 8, sz * 0.0006 + 14, 3) * 2.6;
        const inside = smoothstep(ring * 1.02, ring * 0.86, r);
        const outside = lerp(-26, LAGOON_ABYSS, smoothstep(ring * 1.05, ring * 1.35, r));
        here = lerp(Math.max(reef, outside), Math.max(floor, reef), inside);
      }
      if (here > best) best = here;
    }
  }
  return best;
}

/**
 * Lagoon: a volcanic island inside a barrier reef, in water shallow enough to
 * see the bottom through. The one world here that is about colour.
 */
function lagoonHeight(sx: number, sz: number, d: number): number {
  // Field-relative, so the atoll keeps its place while the noise reseeds.
  const px = sx - seedOffsetX;
  const pz = sz - seedOffsetZ;
  const ix = px - LAGOON_ISLAND_X;
  const iz = pz - LAGOON_ISLAND_Z;
  const r = Math.hypot(ix, iz);
  const bearing = Math.atan2(iz, ix);

  const island = lagoonIsland(ix, iz, r, sx, sz);
  if (island > 0) return island;

  const reef = lagoonReef(bearing, r, sx, sz);

  // Inside the reef: a shallow floor with coral heads standing on it, deepening
  // gently away from the island the way a real lagoon does.
  const shelf = smoothstep(LAGOON_SHORE * 0.86, LAGOON_SHORE * 1.35, r);
  const floor = lerp(-2.5, LAGOON_FLOOR, shelf)
    + fbm(sx * 0.0004 + 21, sz * 0.0004 - 9, 3) * 3.5;
  // Coral heads: isolated bommies that break up the floor and, in a few places,
  // very nearly break the surface.
  const heads = Math.max(0, fbm(sx * 0.0013 - 44, sz * 0.0013 + 16, 3) - 0.34) * 26;
  const lagoon = Math.min(-0.4, floor + heads);

  // Outside the reef the bottom falls away. This is the drop-off, and it is
  // what makes the reef edge read from the air: turquoise to navy in a few
  // hundred metres, with nothing gradual about it.
  const beyond = smoothstep(LAGOON_REEF * 1.02, LAGOON_REEF * 1.4, r);
  const outside = lerp(-30, LAGOON_ABYSS, Math.pow(beyond, 0.7));

  // The three regions, combined by which one this point is in.
  const inRing = smoothstep(LAGOON_REEF * 1.02, LAGOON_REEF * 0.9, r);
  const open = Math.max(reef, outside);
  const water = lerp(open, lagoon, inRing);

  // The airfield's own coastal shelf: the pad flattening handles the runway
  // itself, but the ground it sits on should be a low sand flat rather than the
  // side of a volcano.
  const home = lerp(water, Math.max(water, 9), smoothstep(4200, 1500, d));

  // The rest of the group, out in the deep water. A maximum rather than a
  // blend: every satellite is placed clear of this atoll, so the two never have
  // anything to say about the same square metre.
  return Math.max(home, lagoonAtolls(px, pz, sx, sz));
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
 * A sand sea. Transverse dune trains whose crest lines wander with a very slow
 * noise, a shorter ripple across them, and a broad swell underneath.
 *
 * Almost no relief, which is the point: with the sun low, a 40 m dune crest
 * throws a kilometre of shadow and the surface itself becomes the subject.
 */
function duneHeight(sx: number, sz: number, _d: number): number {
  const drift = fbm(sx * 0.00002, sz * 0.00002, 2) * 2.6;
  // Dune trains run roughly north-east; the axis is a rotated coordinate.
  const axis = sx * 0.866 + sz * 0.5;

  const primary = Math.pow(0.5 + 0.5 * Math.sin(axis * 0.0075 + drift * 3.1), 1.9) * 64;
  const secondary = Math.pow(0.5 + 0.5 * Math.sin(axis * 0.026 + drift * 7.4), 2.3) * 13;
  const grain = fbm(sx * 0.0016, sz * 0.0016, 2) * 3;

  const swell = 70 + fbm(sx * 0.00008, sz * 0.00008, 3) * 85;

  // Bare rock: flat-topped inselbergs everywhere, plus ridged massifs confined
  // to a few regions. Gating the range on a very low-frequency noise is what
  // keeps it a *sand sea with mountains in it* rather than mountains with sand
  // between them — an ungated ridged field covers the whole map.
  const massifMask = smoothstep(0.12, 0.44, fbm(sx * 0.000017 + 53, sz * 0.000017 - 11, 2) + 0.5);
  // The mask is zero over most of the map, and a five-octave ridged field is the
  // single most expensive term in this world — so test the mask before paying
  // for it rather than multiplying the result by zero afterwards.
  const range = massifMask > 0.002
    ? Math.pow(Math.max(0, ridged(sx * 0.000045 + 17, sz * 0.000045 - 29, 5)), 1.45) * 1750 * massifMask
    : 0;
  const rock = Math.max(inselbergs(sx, sz), range);

  // Sand thins out as the rock rises, so dunes don't ripple over a mesa top.
  return swell + rock + (primary + secondary + grain) * (1 - smoothstep(20, 150, rock));
}

/** Where the ice shelf is, before the radial term that anchors it to the field. */
function shelfNoise(sx: number, sz: number): number {
  return fbm(sx * 0.000035, sz * 0.000035, 3) * 0.95;
}

/** Tabular icebergs: rotated rectangles with sheer walls and dead-flat tops. */
function tabularBergs(sx: number, sz: number): number {
  const CELL = 6000;
  const gx = Math.floor(sx / CELL);
  const gz = Math.floor(sz / CELL);
  let tallest = -Infinity;

  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const cx = gx + i;
      const cz = gz + j;
      const pick = cellRandom(cx, cz, 51);
      if (pick > 0.4) continue;

      const centreX = (cx + 0.2 + cellRandom(cx, cz, 52) * 0.6) * CELL;
      const centreZ = (cz + 0.2 + cellRandom(cx, cz, 53) * 0.6) * CELL;

      const halfX = 550 + pick * 2600;
      const halfZ = 450 + cellRandom(cx, cz, 54) * 2200;
      const dx = sx - centreX;
      const dz = sz - centreZ;
      if (Math.hypot(dx, dz) > Math.hypot(halfX, halfZ)) continue;

      // Bergs float in open water, not on the shelf they calved from. Testing
      // at the berg's *centre* keeps each one wholly present or wholly absent —
      // per sample would slice a berg in half down the boundary. Kept *after*
      // the bounding-circle test because it costs an octave-3 noise lookup, and
      // running it for all nine cells made this the most expensive world here.
      if (shelfNoise(centreX, centreZ) > 0.06) continue;

      const a = cellRandom(cx, cz, 55) * Math.PI;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const rx = Math.abs(dx * ca + dz * sa);
      const rz = Math.abs(-dx * sa + dz * ca);
      if (rx > halfX || rz > halfZ) continue;

      const edge = Math.min(1 - rx / halfX, 1 - rz / halfZ);
      const top = (30 + pick * 110) * smoothstep(0, 0.05, edge);
      if (top > tallest) tallest = top;
    }
  }
  return tallest;
}

/**
 * Sea ice. A flat shelf a few tens of metres above the water, cracked by leads
 * of open sea, with tabular bergs adrift beyond the shelf edge.
 *
 * The leads are the fjord trick reused unchanged: 1 − |noise| picks out the
 * *zero crossings* of a field rather than its peaks, which is what makes thin
 * winding cracks instead of round holes.
 */
function antarcticHeight(sx: number, sz: number, d: number): number {
  const shelfMask = smoothstep(0.0, 0.28, shelfNoise(sx, sz) + smoothstep(44000, 9000, d) * 0.85);

  /**
   * Ice plateaus: two tiers, each with an edge you could walk off.
   *
   * The shelf was 44 m give or take seven, which is a table — and a table is
   * the one landscape a flight simulator cannot make interesting, because
   * nothing on it casts a shadow or hides anything else. Real ice is stepped:
   * broad flat sheets meeting at faces tens of metres tall.
   *
   * The sharpness is the whole point, and it comes from how narrow the
   * smoothstep band is rather than from the noise. At a band of 0.04 the
   * transition spreads over half a kilometre and reads as a hill; at 0.010 it
   * happens in about ninety metres, which the terrain's finest vertices are
   * ten metres apart and can therefore actually draw as a cliff.
   */
  // Mapped to roughly 0..1 first. Thresholded raw, the bands at 0.50 and 0.61
  // sat outside the range this noise actually returns and the plateaus came
  // out twenty metres tall instead of two hundred.
  const bench = fbm(sx * 0.000045 + 61, sz * 0.000045 - 29, 3) * 0.5 + 0.5;
  const plateau = smoothstep(0.470, 0.482, bench) * 118
    + smoothstep(0.560, 0.572, bench) * 96
    // A little roll on top of each tier, so a plateau is not a sheet of glass.
    + fbm(sx * 0.00021 + 5, sz * 0.00021 - 11, 3) * 9;

  const shelf = 44 + fbm(sx * 0.00012, sz * 0.00012, 3) * 7 + plateau;
  // Two vein fields at different scales: a few wide leads and a lot of narrow
  // ones. A single field at the fjords' settings gives cracks so rare that most
  // of the shelf is featureless white.
  const wide = 1 - Math.abs(fbm(sx * 0.00007 + 31, sz * 0.00007 - 13, 3) * 2.3);
  const fine = 1 - Math.abs(fbm(sx * 0.00019 - 7, sz * 0.00019 + 41, 3) * 2.4);
  const lead = Math.max(smoothstep(0.74, 0.95, wide), smoothstep(0.86, 0.99, fine)) * shelfMask;

  const surface = lerp(shelf, -34, lead);
  const sea = -(28 + (1 - shelfMask) * 170);

  return Math.max(lerp(sea, surface, shelfMask), tabularBergs(sx, sz));
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

export const WORLD_PRESETS: WorldPreset[] = [
  {
    name: 'ISLES',
    blurb: 'Rolling coastal country, open sea and scattered islands.',
    fieldElevation: 16,
    hasOcean: true,
    style: {
      grass: [0.16, 0.28, 0.1], dry: [0.44, 0.39, 0.21], rock: [0.37, 0.35, 0.33],
      snowLine: 1750, treeLine: 710, strata: 0,
    },
    rivers: { depth: 26, count: 26, sourceMin: 240, sourceMax: 1500, endAt: 0,
              widthNear: 26, widthFar: 95 },
    height: islesHeight,
  },
  {
    name: 'CANYON',
    // No fortresses in a gorge, and barely any industry: what belongs out here
    // is a line of turbines on the rim and not much else.
    // The abbeys are held down as well: with the castles gone they inherited
    // every hilltop the castles had been taking and went from eleven to
    // seventeen, which is more religion than the gorge had before, not less.
    // Solar is opt-in, and a gorge country of flat sun-baked benches is one of
    // the three places it belongs.
    landmarkDensity: {
      castle: 0, powerplant: 0.12, turbine: 1.5, monastery: 0.6, solar: 1,
    },
    blurb: 'High desert plateau split by a mile-deep gorge. Fly below the rim.',
    fieldElevation: 1470,
    hasOcean: false,
    style: {
      grass: [0.42, 0.28, 0.16], dry: [0.55, 0.34, 0.19], rock: [0.46, 0.26, 0.17],
      snowLine: 4200, treeLine: 700, strata: 1,
    },
    height: canyonHeight,
  },
  {
    name: 'FJORDS',
    blurb: 'Sheer coastal walls and long sea inlets winding far inland.',
    fieldElevation: 45,
    hasOcean: true,
    style: {
      grass: [0.14, 0.24, 0.12], dry: [0.30, 0.32, 0.26], rock: [0.32, 0.33, 0.35],
      snowLine: 900, treeLine: 620, strata: 0,
    },
    rivers: { depth: 30, count: 26, sourceMin: 320, sourceMax: 1400, endAt: 0,
              widthNear: 26, widthFar: 85 },
    height: fjordHeight,
  },
  {
    name: 'HIMALAYA',
    blurb: 'A 3 km-high airstrip under 8 km peaks. Thin air, long takeoff.',
    fieldElevation: 2900,
    hasOcean: false,
    style: {
      grass: [0.26, 0.26, 0.20], dry: [0.42, 0.39, 0.33], rock: [0.34, 0.33, 0.34],
      snowLine: 5300, treeLine: 3200, strata: 0,
    },
    rivers: { depth: 42, count: 26, sourceMin: 3600, sourceMax: 6200, endAt: 2200,
              widthNear: 30, widthFar: 120 },
    height: himalayaHeight,
  },
  {
    name: 'ICELAND',
    // No fortresses on the lava. Turf farms and churches, historically — the
    // one thing the island never had is a castle on a crag.
    landmarkDensity: { castle: 0 },
    blurb: 'Volcanic island — black lava fields, cratered cones and low glaciers.',
    fieldElevation: 28,
    hasOcean: true,
    style: {
      // Moss over basalt: dark, desaturated ground with ice sitting low on it.
      grass: [0.17, 0.27, 0.13], dry: [0.15, 0.14, 0.13], rock: [0.20, 0.19, 0.19],
      snowLine: 820, treeLine: 640, strata: 0,
    },
    rivers: { depth: 24, count: 26, sourceMin: 260, sourceMax: 1800, endAt: 0,
              widthNear: 24, widthFar: 90 },
    height: icelandHeight,
  },
  {
    name: 'KARST',
    blurb: 'Limestone towers over paddy and shallow bays. Fly between them, not over.',
    fieldElevation: 44,
    hasOcean: true,
    style: {
      // Subtropical green on the flats; pale limestone wherever it is steep,
      // which on a tower is everywhere.
      grass: [0.13, 0.32, 0.10], dry: [0.32, 0.36, 0.19], rock: [0.24, 0.235, 0.21],
      snowLine: 3200, treeLine: 900, strata: 0,
    },
    rivers: { depth: 16, count: 22, sourceMin: 40, sourceMax: 130, endAt: 0,
              widthNear: 32, widthFar: 130 },
    height: karstHeight,
  },
  {
    name: 'DUNES',
    blurb: 'A sand sea of transverse dunes and red inselbergs. Best at low sun.',
    fieldElevation: 90,
    hasOcean: false,
    // Every square metre of a sand sea passes the habitability test, so the
    // default grid fills it to the ceiling. Settlements here are oases.
    villageSpacing: 11000,
    hasPyramids: true,
    // A sand sea is where a solar plant actually goes.
    landmarkDensity: { solar: 1 },
    style: {
      // No vegetation at all: the "grass" slot carries the sand, because that is
      // the tone the shader uses across the elevations dunes actually occupy.
      grass: [0.88, 0.58, 0.24], dry: [0.60, 0.32, 0.19], rock: [0.48, 0.27, 0.17],
      snowLine: 5000, treeLine: 900, strata: 0,
    },
    height: duneHeight,
  },
  {
    name: 'ANTARCTIC',
    blurb: 'Ice shelf split by black leads, with tabular bergs adrift. Land anywhere.',
    fieldElevation: 46,
    hasOcean: true,
    hasSailboats: false,
    hasVillages: false,
    style: {
      // A negative snow line puts snow on everything at any season — the season
      // scales this value, so a small negative would go positive in summer.
      grass: [0.74, 0.79, 0.85], dry: [0.80, 0.84, 0.89], rock: [0.54, 0.59, 0.66],
      snowLine: -2000, treeLine: 300, strata: 0,
    },
    // Supraglacial meltwater: shallow, and it ends in a lead rather than a sea.
    rivers: { depth: 11, count: 22, sourceMin: 44, sourceMax: 60, endAt: 0,
              widthNear: 22, widthFar: 70 },
    height: antarcticHeight,
  },
  {
    name: 'ALPINE',
    blurb: 'Glacial valleys with flat floors and 2 km walls. Villages on the floor.',
    fieldElevation: 1210,
    hasOcean: false,
    style: {
      grass: [0.16, 0.30, 0.13], dry: [0.40, 0.38, 0.30], rock: [0.36, 0.35, 0.36],
      snowLine: 2350, treeLine: 1780, strata: 0,
    },
    rivers: { depth: 34, count: 26, sourceMin: 1900, sourceMax: 3400, endAt: 1180,
              widthNear: 26, widthFar: 105 },
    height: alpineHeight,
  },
  {
    name: 'LAGOON',
    blurb: 'A volcanic peak inside a barrier reef. Turquoise all the way to the drop-off.',
    fieldElevation: 9,
    hasOcean: true,
    // Villages ring the island's coastal plain rather than filling a continent.
    villageSpacing: 3400,
    style: {
      // Tropical: dense green on the flanks, coral sand at the waterline, dark
      // basalt where it is steep.
      grass: [0.11, 0.30, 0.11], dry: [0.66, 0.60, 0.44], rock: [0.20, 0.18, 0.17],
      // Nothing here is ever cold; the snow line is above the peak on purpose.
      snowLine: 2600, treeLine: 900, strata: 0,
      // The whole point of the world. Deep ocean stays near-navy, the lagoon
      // goes turquoise, and the reef flat reads as wet coral sand.
      water: { deep: 0x06283f, shallow: 0x1fb5b0, sand: 0x8fe6d2, glow: 0.55 },
    },
    // Short, steep streams off a volcanic cone, straight into the lagoon.
    rivers: { depth: 12, count: 12, sourceMin: 120, sourceMax: 1400, endAt: 0,
              widthNear: 14, widthFar: 44, sourceCell: 1500 },
    height: lagoonHeight,
  },
  {
    name: 'PACIFIC',
    blurb: 'Carrier ops off a volcanic island. You start on the deck — 300 m of it.',
    fieldElevation: 12,
    hasOcean: true,
    hasAirfield: false,
    hasCarrier: true,
    // The island is a few kilometres across, far smaller than the default grid.
    villageSpacing: 2600,
    spawn: { x: CARRIER_SPAWN.x, z: CARRIER_SPAWN.z, heading: CARRIER_SPAWN.heading },
    style: {
      grass: [0.15, 0.30, 0.12], dry: [0.30, 0.26, 0.18], rock: [0.22, 0.20, 0.19],
      snowLine: 3000, treeLine: 700, strata: 0,
    },
    rivers: { depth: 18, count: 14, sourceMin: 60, sourceMax: 900, endAt: 0,
              widthNear: 20, widthFar: 60, sourceCell: 1700 },
    height: pacificHeight,
  },
  {
    name: 'ISLAND CITY',
    blurb: 'A megacity island in a broad harbour, with towns along the coast beyond it.',
    // Above the shader's 34 m beach band, so the airfield is on a low bluff
    // rather than on sand.
    fieldElevation: 48,
    hasOcean: true,
    hasVillages: false,
    city: CITY_CONFIGS.ISLAND_CITY,
    // The palette is the *mainland's*, not the city's — the island paints its own
    // asphalt through the terrain's city attribute. Greys chosen to read as
    // "urban" only ever landed on the countryside, and bleached it to the colour
    // of shallow water.
    style: {
      grass: [0.13, 0.26, 0.11], dry: [0.27, 0.24, 0.15], rock: [0.30, 0.30, 0.31],
      snowLine: 3200, treeLine: 520, strata: 0,
    },
    height: islandCityHeight,
  },
  {
    name: 'HARBOUR',
    blurb: 'A megacity between steep green peaks and deep water, towns scattered down the coast.',
    fieldElevation: 26,
    hasOcean: true,
    hasVillages: false,
    city: CITY_CONFIGS.HARBOUR,
    style: {
      grass: [0.10, 0.24, 0.09], dry: [0.24, 0.24, 0.16], rock: [0.29, 0.29, 0.28],
      snowLine: 2600, treeLine: 700, strata: 0,
    },
    height: harbourHeight,
  },
  {
    name: 'DOMES',
    blurb: 'Granite domes standing out of a bay, with settlements strung along the shore.',
    fieldElevation: 22,
    hasOcean: true,
    hasVillages: false,
    city: CITY_CONFIGS.DOMES,
    style: {
      grass: [0.12, 0.27, 0.10], dry: [0.36, 0.30, 0.20], rock: [0.34, 0.30, 0.28],
      snowLine: 3000, treeLine: 600, strata: 0,
    },
    height: domeHeight,
  },
  {
    name: 'GULF',
    blurb: 'A supertall on a desert shore, a dune sea behind, a far coast across the water.',
    // Matches the coastal plain around it: at 22 m the runway sat in a bowl.
    fieldElevation: 50,
    hasOcean: true,
    hasVillages: false,
    city: CITY_CONFIGS.GULF,
    // The desert behind the city, which is where the power for it comes from.
    landmarkDensity: { solar: 1 },
    style: {
      // The DUNES idiom: no vegetation anywhere, so the "grass" slot carries
      // the sand itself and the tree line is pushed above everything the dunes
      // reach. The olive green it held before was right only while the whole
      // coastal plain sat a couple of metres above the water and the shader's
      // own beach sand covered it; once the land stood up at twenty metres,
      // the desert came out the colour of a wet meadow.
      grass: [0.66, 0.47, 0.26], dry: [0.54, 0.39, 0.24], rock: [0.50, 0.42, 0.32],
      snowLine: 4000, treeLine: 700, strata: 0,
    },
    height: gulfHeight,
  },
];

// ------------------------------------------------------------------- sampling

let active: WorldPreset = WORLD_PRESETS[0];
let seedOffsetX = 0;
let seedOffsetZ = 0;
let currentSeed = 1;

export function setWorld(index: number): WorldPreset {
  active = WORLD_PRESETS[Math.max(0, Math.min(index, WORLD_PRESETS.length - 1))];
  replanCity();
  replanSettlements();
  return active;
}

/**
 * Plan the city against the ground it will stand on.
 *
 * The sampler is `terrainHeight` itself, which is safe because buildings live
 * in `groundHeight` rather than in the height field — so nothing the planner
 * reads depends on the plan it is producing. It has to run again on a reseed:
 * the terrain moves, and a city planned against the old one would be standing
 * in the sea.
 */
function replanCity(): void {
  setCity(active.city ?? null, terrainHeight, currentSeed);
}

export function activeWorld(): WorldPreset {
  return active;
}

/**
 * Move the height field to a different part of the noise domain.
 *
 * Offsets apply to the noise lookups only, never to the radial distance from the
 * origin — so however a world is reshaped, the airfield stays flat, at its own
 * elevation, and in the terrain each world intends around it.
 */
export function setTerrainSeed(seed: number): void {
  currentSeed = seed;
  seedOffsetX = ((seed * 9871.13) % 100000) + 1000;
  seedOffsetZ = ((seed * 4517.77) % 100000) - 1000;
  replanCity();
  replanSettlements();
}

export function getTerrainSeed(): number {
  return currentSeed;
}

export function fieldElevation(): number {
  return active.fieldElevation;
}

/**
 * Elevation before any settlement is cut into it.
 *
 * Village placement reads this rather than `terrainHeight`, so an airstrip's own
 * flattened pad can't be what makes its site look flat enough to build on.
 */
function naturalHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const raw = active.height(x + seedOffsetX, z + seedOffsetZ, d);
  // Worlds without a land airfield skip the flattened pad entirely.
  const pad = active.hasAirfield === false ? 1 : smoothstep(FIELD_RADIUS, FIELD_FALLOFF, d);
  return lerp(active.fieldElevation, raw, pad);
}

/**
 * Terrain elevation at a world position, metres.
 *
 * The single source of truth for the ground: the flight model samples it for
 * collision and every terrain chunk is built from it, so the visible surface and
 * the collision surface cannot disagree. Airstrips ride on that seam — flatten
 * the height field and a village strip becomes landable with no changes to the
 * flight model at all, exactly as the carrier deck did.
 */
export function terrainHeight(x: number, z: number): number {
  // Rivers are cut into the natural ground, then the built things go on top of
  // the result — a runway or a pyramid overrides whatever was underneath, and
  // takes the water shading with it.
  const natural = naturalHeight(x, z);
  const watered = carveTarns(x, z, carveRivers(x, z, natural));
  // The island is laid in before the runway, so the airfield still wins where
  // the two meet — and in unseeded coordinates, so reseeding moves the mainland
  // and the harbour around it without moving the city.
  const shaped = cityGround(x, z, watered);
  const ground = airstripHeight(x, z, shaped);

  const built = pyramidHeight(x, z);
  if (built > ground) return built;
  return ground;
}

/** River strength at the point `terrainHeight` was last called for. */
export { riverStrength } from './Rivers';

/**
 * Re-site the villages for the current world and seed.
 *
 * Placement is a search over ~100 candidate sites needing a dozen height
 * evaluations each, so it runs once here rather than per terrain sample. Both
 * callers already drop every terrain chunk, so the few milliseconds land inside
 * a rebuild that costs far more.
 */
function replanSettlements(): void {
  const field = active.fieldElevation;
  planSettlements(naturalHeight, {
    enabled: active.hasVillages !== false,
    seed: currentSeed,
    // Habitable band, relative to whatever elevation this world sits at: a
    // fixed "below 400 m" rule would leave a 2.9 km Himalayan basin empty.
    minElevation: Math.max(25, field - 500),
    maxElevation: field + 1100,
    // Just clear of the airfield pad, whose blend ends at FIELD_FALLOFF — near
    // enough that the first settlement is a minute after takeoff, not twenty.
    exclusion: active.hasAirfield === false ? 2200 : FIELD_FALLOFF + 1300,
    spacing: active.villageSpacing ?? 5200,
  });

  // Traced against the *natural* ground: a river cannot be routed by a channel
  // that does not exist until it has been routed.
  planRivers(naturalHeight, active.rivers ?? null, currentSeed);

  planPyramids(naturalHeight, {
    enabled: active.hasPyramids === true,
    seed: currentSeed,
    minElevation: Math.max(25, field - 200),
    maxElevation: field + 260,
    exclusion: FIELD_FALLOFF + 2500,
  });

  // Landmarks, against the finished ground: a lighthouse cares whether the
  // point it stands on is above water once everything is cut and filled, not
  // whether the noise put land there to begin with.
  planStructures(terrainHeight, {
    enabled: active.hasLandmarks !== false,
    // A world with a city has people in it even when it has no villages —
    // read the other way, the island city and the harbour got no turbines,
    // no masts and no power stations at all.
    peopled: active.hasVillages !== false || active.city !== undefined,
    coastal: active.hasOcean,
    seed: currentSeed,
    exclusion: active.hasAirfield === false ? 5000 : FIELD_FALLOFF + 1500,
    snowLine: active.style.snowLine > 0 ? active.style.snowLine : 4000,
    field: active.fieldElevation,
    density: active.landmarkDensity ?? {},
    city: active.city === undefined ? null : {
      x: active.city.primary.x, z: active.city.primary.z, radius: active.city.primary.radius,
    },
  });

  // Balloons, over the same country the villages are in. Planned against the
  // natural ground like the landmarks: they hang in the air, so what is laid
  // in underneath them afterwards cannot put one inside a hill.
  planBalloons(terrainHeight, {
    enabled: active.hasVillages !== false || active.city !== undefined,
    seed: currentSeed,
    exclusion: active.hasAirfield === false ? 6000 : FIELD_FALLOFF + 2200,
    field: active.fieldElevation,
    city: active.city === undefined ? null : {
      x: active.city.primary.x, z: active.city.primary.z, radius: active.city.primary.radius,
    },
  });

  // Shipping, planned last and against the *finished* ground rather than the
  // natural one — unlike everything above it.
  //
  // A boat is the one thing here that cares about the surface as it ends up
  // being, not as the noise first drew it: an island city is laid into open
  // water after the fact, and planning against the natural height put a
  // freighter fifteen metres up a made hillside. Everything this samples is
  // already planned by the time it runs, which is why it runs here.
  planBoats(terrainHeight, {
    enabled: active.hasOcean,
    sail: active.hasSailboats !== false,
    seed: currentSeed,
    // Clear of wherever the flight begins — a runway threshold, or the water
    // the carrier group is sitting in.
    exclusion: active.hasAirfield === false ? 6000 : FIELD_FALLOFF + 1200,
  });
}

/**
 * Ground height for collision: the terrain, or the carrier deck where it is
 * higher. Feeding the deck through the same sampler means the flight model
 * treats it as ordinary ground — rollout, gear contact, liftoff and crash
 * detection all work with no special cases for landing on a ship.
 */
export function groundHeight(x: number, z: number): number {
  let h = terrainHeight(x, z);
  // A roof is ground that happens to be three hundred metres up: gear contact,
  // crash detection and the camera's ground clearance all work unchanged.
  h = Math.max(h, cityHeight(x, z));
  if (active.hasCarrier) h = Math.max(h, carrierDeckHeight(x, z));
  return h;
}

/** Where the aircraft should start in the current world. */
export function spawnPoint(): { x: number; z: number; heading: number } {
  return active.spawn ?? { x: 0, z: -1200, heading: 180 };
}

// The default world needs its villages before the first terrain sample, and
// nothing calls setWorld/setTerrainSeed at boot.
replanSettlements();
