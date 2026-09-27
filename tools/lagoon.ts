/**
 * Measure the lagoon: is it actually an atoll, and can the sea see it?
 *
 * The world is a set of claims about a radial profile — island, then lagoon,
 * then reef, then a drop-off — and a radial profile is exactly the kind of
 * thing that can be right on one bearing and wrong on the other three hundred
 * and fifty-nine. So this walks outward on many bearings and checks that the
 * four regions are where they are supposed to be on all of them.
 *
 * It also checks the depth map the ocean colours itself by, because a lagoon
 * whose water is the same navy as the open sea is not a lagoon, and that map is
 * the only thing standing between those two outcomes.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { WORLD_PRESETS, setWorld, setTerrainSeed, terrainHeight } =
  await import('../src/world/Worlds');
const { DEEP_WATER } = await import('../src/world/Shallows');
const { airstrips, settlements } = await import('../src/world/Settlements');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

const index = WORLD_PRESETS.findIndex((w) => w.name === 'LAGOON');
if (index < 0) throw new Error('no LAGOON preset');
const preset = setWorld(index);
setTerrainSeed(20250817);

/** The island sits here, in metres from the airfield. */
const ISLAND_X = 7000;
const ISLAND_Z = 0;
const BEARINGS = 72;
/** Roughly where the home atoll's reef lies, for "is this strip away from home". */
const LAGOON_REEF_GUESS = 22_000;

const at = (r: number, th: number): number =>
  terrainHeight(ISLAND_X + Math.cos(th) * r, ISLAND_Z + Math.sin(th) * r);

// ------------------------------------------------------------------- island
console.log('ISLAND    a volcanic peak, not a hill');
{
  let peak = -Infinity;
  let peakAt = 0;
  for (let r = 0; r <= 9000; r += 40) {
    for (let a = 0; a < BEARINGS; a++) {
      const h = at(r, (a / BEARINGS) * Math.PI * 2);
      if (h > peak) {
        peak = h;
        peakAt = r;
      }
    }
  }
  console.log(`  highest point ${Math.round(peak)} m, ${peakAt} m from the island's centre`);
  if (peak < 1200) fail(`the peak is only ${Math.round(peak)} m — that is a hill`);
  if (peak > 2400) fail(`${Math.round(peak)} m is a mountain, not a high island`);

  // A shoreline on every bearing: the island has to be an island.
  let shoreMin = Infinity;
  let shoreMax = 0;
  let missing = 0;
  for (let a = 0; a < BEARINGS; a++) {
    const th = (a / BEARINGS) * Math.PI * 2;
    let shore = -1;
    for (let r = 200; r <= 12000; r += 40) {
      if (at(r, th) <= 0) {
        shore = r;
        break;
      }
    }
    if (shore < 0) missing++;
    else {
      shoreMin = Math.min(shoreMin, shore);
      shoreMax = Math.max(shoreMax, shore);
    }
  }
  console.log(`  shoreline between ${shoreMin} m and ${shoreMax} m out, on all `
    + `${BEARINGS} bearings`);
  if (missing > 0) fail(`${missing} bearings never reach the sea — it is not an island`);
  if (shoreMax - shoreMin < 600) fail('the shoreline is a perfect circle');
}

// ------------------------------------------------------------------- lagoon
console.log('\nLAGOON    shallow water all the way round, inside the reef');
{
  const depths: number[] = [];
  let dry = 0;
  for (let a = 0; a < BEARINGS; a++) {
    const th = (a / BEARINGS) * Math.PI * 2;
    // Between the island's shore and the reef.
    for (let r = 10_000; r <= 13_000; r += 250) {
      const h = at(r, th);
      if (h > 0) dry++;
      else depths.push(-h);
    }
  }
  depths.sort((x, y) => x - y);
  const q = (f: number): number => depths[Math.floor(depths.length * f)];
  console.log(`  floor between ${Math.round(q(0.02))} m and ${Math.round(q(0.98))} m down`
    + `, typically ${Math.round(q(0.5))} m`);
  console.log(`  ${dry} of ${dry + depths.length} samples stand out of the water (coral heads)`);
  // Shallow enough that the surface will be coloured by it — that is the point.
  if (q(0.5) > DEEP_WATER * 0.8) {
    fail(`a ${Math.round(q(0.5))} m floor is too deep to tint at DEEP_WATER=${DEEP_WATER}`);
  }
  if (q(0.5) < 4) fail('the lagoon is a mudflat');
  if (q(0.98) - q(0.02) < 6) fail('the floor is perfectly flat');
}

// --------------------------------------------------------------------- reef
console.log('\nREEF      a ring that breaks the surface, cut by passes');
{
  let crestFound = 0;
  let motus = 0;
  let passes = 0;
  const ringAt: number[] = [];
  for (let a = 0; a < BEARINGS; a++) {
    const th = (a / BEARINGS) * Math.PI * 2;
    let shallowest = -Infinity;
    let where = 0;
    for (let r = 12_500; r <= 16_500; r += 25) {
      const h = at(r, th);
      if (h > shallowest) {
        shallowest = h;
        where = r;
      }
    }
    ringAt.push(where);
    if (shallowest > -3) crestFound++;
    if (shallowest > 1) motus++;
    if (shallowest < -8) passes++;
  }
  ringAt.sort((x, y) => x - y);
  console.log(`  the ring runs between ${ringAt[0]} m and ${ringAt[ringAt.length - 1]} m out`);
  console.log(`  ${crestFound} of ${BEARINGS} bearings have a crest within 3 m of the surface`);
  console.log(`  ${motus} carry a sand islet; ${passes} are cut by a pass`);
  if (crestFound < BEARINGS * 0.6) fail('the reef is mostly too deep to see');
  if (motus === 0) fail('no motus anywhere on the reef');
  if (motus > BEARINGS * 0.7) fail('the reef is a solid wall of sand, not a reef');
  if (passes === 0) fail('the reef has no passes — the lagoon is sealed');
  if (passes > BEARINGS * 0.4) fail('the reef is more gap than reef');
  if (ringAt[ringAt.length - 1] - ringAt[0] < 700) fail('the reef is a perfect circle');
}

// ----------------------------------------------------------------- drop-off
console.log('\nDROP-OFF  turquoise to navy, fast');
{
  const falls: number[] = [];
  for (let a = 0; a < BEARINGS; a++) {
    const th = (a / BEARINGS) * Math.PI * 2;
    // How much deeper it is a kilometre outside the ring than at the ring.
    const outer = at(17_500, th);
    const far = at(21_000, th);
    falls.push(-far);
    if (outer > -20) fail(`bearing ${a} is still ${Math.round(-outer)} m deep well outside the reef`);
  }
  falls.sort((x, y) => x - y);
  console.log(`  6 km outside the ring the bottom is ${Math.round(falls[0])}`
    + `-${Math.round(falls[falls.length - 1])} m down`);
  if (falls[0] < 200) fail('there is no drop-off — the shallows just carry on');
}

// ------------------------------------------------------------------ airfield
console.log('\nAIRFIELD  a coastal strip, on land, with the sea close by');
{
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = -900; x <= 900; x += 30) {
    for (let z = -900; z <= 900; z += 30) {
      const h = terrainHeight(x, z);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
  }
  console.log(`  the field: ${lo.toFixed(1)} m to ${hi.toFixed(1)} m`);
  if (hi - lo > 1) fail('the airfield is not flat');
  if (lo < 1) fail('the airfield is under water');

  // Water within a short flight, or this is not a coastal field.
  let nearest = Infinity;
  for (let a = 0; a < BEARINGS; a++) {
    const th = (a / BEARINGS) * Math.PI * 2;
    for (let r = 500; r <= 12_000; r += 50) {
      if (terrainHeight(Math.cos(th) * r, Math.sin(th) * r) < -1) {
        nearest = Math.min(nearest, r);
        break;
      }
    }
  }
  console.log(`  open water ${nearest} m from the runway`);
  if (nearest > 6000) fail('the sea is too far from the field to be the point of the world');
}

// ------------------------------------------------------------ the other atolls
//
// One island in an empty ocean is a diorama. These are the rest of the group,
// and the thing that matters about them is that you can land on them.
console.log('\nTHE GROUP  other atolls, and somewhere to put down on them');
{
  // Walk a wide grid and find every separate patch of land that is not the main
  // island. Flood-fill would be exact; a coarse grid plus a merge is enough to
  // count islands that are kilometres apart.
  const seen: { x: number; z: number; top: number }[] = [];
  const OUT = 70_000;
  for (let x = -OUT; x <= OUT; x += 400) {
    for (let z = -OUT; z <= OUT; z += 400) {
      const h = terrainHeight(x, z);
      if (h <= 2) continue;
      // Not the main island.
      if (Math.hypot(x - ISLAND_X, z - ISLAND_Z) < 11_000) continue;
      const near = seen.find((p) => Math.hypot(p.x - x, p.z - z) < 6000);
      if (near === undefined) seen.push({ x, z, top: h });
      else if (h > near.top) near.top = h;
    }
  }
  seen.sort((a, b) => b.top - a.top);
  const raised = seen.filter((p) => p.top > 30);
  console.log(`  ${seen.length} separate pieces of land beyond the main island`);
  console.log(`  ${raised.length} of them stand over 30 m — high enough to be built on`);
  console.log(`  tallest ${raised.slice(0, 4).map((p) => Math.round(p.top) + ' m').join(', ')}`);
  if (seen.length < 4) fail(`only ${seen.length} other islands — the ocean is still empty`);
  if (raised.length < 2) fail('no raised islands, so nowhere for an airport');

  // And the payoff: airstrips, out on those islands rather than all at home.
  const strips = airstrips();
  const away = strips.filter((st) => Math.hypot(st.x, st.z) > LAGOON_REEF_GUESS);
  console.log(`\n  ${strips.length} airstrips in all, ${away.length} of them outside `
    + 'the home atoll');
  for (const st of away.slice(0, 5)) {
    console.log(`    ${Math.round(Math.hypot(st.x, st.z) / 1000)} km out, `
      + `pad at ${Math.round(st.elevation)} m`);
  }
  console.log(`  ${settlements().length} villages`);
  if (strips.length === 0) fail('no airstrips anywhere');
  if (away.length === 0) fail('every airstrip is on the home atoll — nowhere to fly to');
}

// -------------------------------------------------------------- the sea's map
//
// The ocean colours itself from a coarse depth map. If the lagoon does not land
// in the shallow part of that map, none of the above matters — the water will
// be the same navy as the open sea and the world is a green island in a puddle.
console.log('\nTHE SEA    what the surface will actually be coloured by');
{
  const band = (h: number): string => {
    const depth = -h;
    if (depth <= 0) return 'land';
    const t = Math.min(1, depth / DEEP_WATER);
    if (t < 0.22) return 'sand';
    if (t < 0.92) return 'shallow';
    return 'deep';
  };
  const seen: Record<string, number> = { land: 0, sand: 0, shallow: 0, deep: 0 };
  for (let a = 0; a < BEARINGS; a++) {
    const th = (a / BEARINGS) * Math.PI * 2;
    for (let r = 200; r <= 20_000; r += 200) seen[band(at(r, th))]++;
  }
  const total = Object.values(seen).reduce((x, y) => x + y, 0);
  for (const k of ['land', 'sand', 'shallow', 'deep']) {
    console.log(`  ${k.padEnd(8)} ${((seen[k] / total) * 100).toFixed(1)}%`);
  }
  if (seen.shallow / total < 0.12) fail('almost none of this world is turquoise');
  if (seen.deep / total < 0.2) fail('there is no open ocean to contrast against');
  if (preset.style.water === undefined) fail('the preset never set a water palette');
}

console.log(`\n${failures === 0 ? 'THE LAGOON HOLDS WATER' : `${failures} PROBLEM(S)`}`);

export {};
