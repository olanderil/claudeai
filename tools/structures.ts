/**
 * Where the landmarks ended up, and are they standing on the right ground?
 *
 * Each kind exists because of a rule — a headland, a ridge, a summit, a hill —
 * and a rule that is slightly wrong does not produce an error, it produces a
 * lighthouse in a field. So this counts them per world and then checks the
 * ground each one is actually on.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
import * as THREE from 'three';
const { WORLD_PRESETS, setWorld, setTerrainSeed, terrainHeight, spawnPoint } =
  await import('../src/world/Worlds');
const { structures, structureScale, buildStructureMeshes, disposeStructureMeshes } =
  await import('../src/world/Structures');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

const RING: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707],
];
const prominence = (x: number, z: number, r: number): number => {
  const here = terrainHeight(x, z);
  let low = here;
  for (const [dx, dz] of RING) low = Math.min(low, terrainHeight(x + dx * r, z + dz * r));
  return here - low;
};

console.log('LANDMARKS, by world');
console.log('  world          light  turbine  mast  castle  abbey  power  dome  solar   nearest');
for (let w = 0; w < WORLD_PRESETS.length; w++) {
  const preset = WORLD_PRESETS[w];
  setWorld(w);
  setTerrainSeed(20250817);
  const all = structures();
  const n = (k: string): number => all.filter((s) => s.kind === k).length;
  const spawn = spawnPoint();
  let nearest = Infinity;
  for (const s of all) nearest = Math.min(nearest, Math.hypot(s.x - spawn.x, s.z - spawn.z));
  console.log(`  ${preset.name.padEnd(13)} ${String(n('lighthouse')).padStart(5)} `
    + `${String(n('turbine')).padStart(8)} ${String(n('mast')).padStart(5)} `
    + `${String(n('castle')).padStart(7)} ${String(n('monastery')).padStart(6)} `
    + `${String(n('powerplant')).padStart(6)} `
    + `${String(n('observatory')).padStart(5)} ${String(n('solar')).padStart(6)}   `
    + `${(all.length === 0 ? '-' : (nearest / 1000).toFixed(1) + ' km').padStart(8)}`);

  if (all.length > 0 && nearest < 2500) {
    fail(`${preset.name}: a landmark is ${Math.round(nearest)} m from the start`);
  }
}

// ------------------------------------------------------- standing on the right
console.log('\nSTANDING ON THE RIGHT GROUND');
{
  const worlds = ['ISLES', 'FJORDS', 'ALPINE', 'ICELAND', 'CANYON', 'DUNES', 'GULF'];
  let checked = 0;
  let drowned = 0;
  let landLocked = 0;
  let flat = 0;
  let observatories = 0;
  let belowSomething = 0;
  let lowlying = 0;
  let solars = 0;
  let tilted = 0;
  for (const name of worlds) {
    setWorld(WORLD_PRESETS.findIndex((p) => p.name === name));
    setTerrainSeed(20250817);
    for (const s of structures()) {
      checked++;
      const h = terrainHeight(s.x, s.z);
      // Everything but an offshore turbine stands on dry land.
      if (s.kind !== 'turbine' && h <= 0) drowned++;
      // A lighthouse with no sea near it is a folly. Deliberately not the same
      // ring fractions the rule uses — restating the rule proves nothing. This
      // asks the plainer question: is there water within sight of the tower?
      if (s.kind === 'lighthouse') {
        let wet = false;
        for (const [dx, dz] of RING) {
          for (const r of [260, 480, 700]) {
            if (terrainHeight(s.x + dx * r, s.z + dz * r) <= 0) { wet = true; break; }
          }
          if (wet) break;
        }
        if (!wet) landLocked++;
      }
      // A castle or an abbey on a plain is not on a hill.
      if ((s.kind === 'castle' || s.kind === 'monastery')
        && prominence(s.x, s.z, 900) < 25) flat++;
      // An observatory is on *the* summit, not on a hill. Asked at a wider
      // radius than the rule uses and against the surrounding country rather
      // than the eight probe bearings: what should be true is that nothing
      // nearby looks down on it.
      if (s.kind === 'observatory') {
        observatories++;
        // Two questions, neither of them the one the rule asks.
        //
        // The rule sweeps sixteen bearings at 800, 1200 and 1700 m. This
        // sweeps twenty-four at 1000 and 1450 — finer, and at radii falling
        // between the rule's, so it is a test of the property rather than a
        // copy of the arithmetic. Then it asks separately how far the site
        // stands above the country, at a radius the rule never looks at.
        const here = terrainHeight(s.x, s.z);
        let over = false;
        let low = here;
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const dx = Math.cos(a);
          const dz = Math.sin(a);
          // 1000 and 1450 m: between the radii the rule samples, not on them.
          if (terrainHeight(s.x + dx * 1000, s.z + dz * 1000) > here
            || terrainHeight(s.x + dx * 1450, s.z + dz * 1450) > here) over = true;
          low = Math.min(low, terrainHeight(s.x + dx * 3500, s.z + dz * 3500));
        }
        if (over) belowSomething++;
        if (here - low < 200) lowlying++;
      }
      // Panels want ground you could roll a ball across. Measured over the
      // array's own footprint — 544 m across at the scale these are drawn —
      // rather than the 90 m the placement rule samples at, because a bench
      // that is flat for 90 m and tips away after 200 is no use to it.
      if (s.kind === 'solar') {
        solars++;
        let lo = Infinity;
        let hi = -Infinity;
        for (const [dx, dz] of RING) {
          const g = terrainHeight(s.x + dx * 280, s.z + dz * 280);
          lo = Math.min(lo, g);
          hi = Math.max(hi, g);
        }
        if (hi - lo > 90) tilted++;
      }
    }
  }
  console.log(`  ${checked} landmarks across ${worlds.length} worlds`);
  console.log(`  ${drowned} standing in the sea that should not be`);
  console.log(`  ${landLocked} lighthouses without sea around them`);
  console.log(`  ${flat} castles or abbeys on flat ground`);
  console.log(`  ${belowSomething} of ${observatories} observatories not on their own summit`);
  console.log(`  ${lowlying} of ${observatories} observatories not standing over the country`);
  console.log(`  ${tilted} of ${solars} solar farms on ground that is not flat`);
  if (drowned > 0) fail(`${drowned} landmarks are under water`);
  if (landLocked > 0) fail(`${landLocked} lighthouses have no water within 700 m`);
  if (flat > checked * 0.1) fail(`${flat} hilltop buildings are not on hills`);
  if (belowSomething > 0) fail(`${belowSomething} observatories are not on the top of their own hill`);
  if (lowlying > 0) fail(`${lowlying} observatories stand under 200 m above the country around them`);
  if (tilted > 0) fail(`${tilted} solar farms are laid out on a slope`);

  // And the opt-in has to hold: solar belongs to three worlds by name.
  const SOLAR_WORLDS = ['CANYON', 'DUNES', 'GULF'];
  for (let w = 0; w < WORLD_PRESETS.length; w++) {
    setWorld(w);
    setTerrainSeed(20250817);
    const has = structures().some((s) => s.kind === 'solar');
    const wanted = SOLAR_WORLDS.includes(WORLD_PRESETS[w].name);
    if (has && !wanted) fail(`${WORLD_PRESETS[w].name} has a solar farm and should not`);
    if (!has && wanted) fail(`${WORLD_PRESETS[w].name} should have solar farms and has none`);
  }
}

// -------------------------------------------------------------- the meshes
console.log('\nTHE MESHES');
{
  setWorld(WORLD_PRESETS.findIndex((p) => p.name === 'ISLES'));
  setTerrainSeed(20250817);
  const group = buildStructureMeshes();
  let calls = 0;
  let instances = 0;
  let tallest = 0;
  group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    calls++;
    instances += o.count;
    if (o.geometry === null || o.geometry === undefined) {
      fail('a landmark mesh has no geometry — the parts failed to merge');
      return;
    }
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox;
    if (box) tallest = Math.max(tallest, box.max.y);
  });
  console.log(`  ${instances} landmarks in ${calls} draw calls`);
  console.log(`  drawn at ${structureScale()}x — the tallest shape is `
    + `${tallest.toFixed(0)} m before scaling, ${(tallest * structureScale()).toFixed(0)} m after`);
  // One per kind and variant: six kinds, two of which carry two designs.
  // Counting kinds alone was right until castles and abbeys got a second
  // design each, at which point the check was measuring the old plan.
  if (calls > 8) fail(`${calls} draw calls — more than one per design`);
  if (instances === 0) fail('nothing was built');
  disposeStructureMeshes(group);
}

// ------------------------------------------------------------- elbow room
//
// Nothing standing next to anything else. This is the rule that stops a power
// station being built beside a monastery, and it is applied after the kinds
// are scattered — no scatter can see the others, so nothing catches it earlier.
console.log('\nELBOW ROOM');
{
  let worstMixed = Infinity;
  let worstMixedAt = '';
  let worstSame = Infinity;
  let worstSameAt = '';
  let biggestFarm = 0;
  for (let w = 0; w < WORLD_PRESETS.length; w++) {
    setWorld(w);
    setTerrainSeed(20250817);
    const all = structures();
    const farms = new Map<number, number>();
    for (const a of all) {
      if (a.kind === 'turbine') farms.set(a.farm, (farms.get(a.farm) ?? 0) + 1);
    }
    for (const n of farms.values()) biggestFarm = Math.max(biggestFarm, n);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (a.kind === 'turbine' && b.kind === 'turbine' && a.farm === b.farm) continue;
        if (a.kind === b.kind) {
          if (d < worstSame) { worstSame = d; worstSameAt = `${a.kind} in ${WORLD_PRESETS[w].name}`; }
        } else if (d < worstMixed) {
          worstMixed = d;
          worstMixedAt = `${a.kind} and ${b.kind} in ${WORLD_PRESETS[w].name}`;
        }
      }
    }
  }
  console.log(`  closest two of different kinds: ${(worstMixed / 1000).toFixed(1)} km (${worstMixedAt})`);
  console.log(`  closest two of a kind:          ${(worstSame / 1000).toFixed(1)} km (${worstSameAt})`);
  console.log(`  largest wind farm: ${biggestFarm} turbines`);
  if (worstMixed < 2400) fail(`${worstMixedAt} are ${Math.round(worstMixed)} m apart`);
  if (worstSame < 850) fail(`${worstSameAt} are ${Math.round(worstSame)} m apart`);
  if (biggestFarm > 5) fail(`a wind farm has ${biggestFarm} turbines`);
}

// ------------------------------------------------------- nothing in the city
//
// A castle in the middle of downtown is the one placement that reads as a bug
// rather than a choice, and the city's ground is laid in *after* these are
// placed, so the height field gives no warning at all.
console.log('\nNOTHING STANDING IN A CITY');
{
  const { CITY_CONFIGS } = await import('../src/world/City');
  let intruders = 0;
  let checked = 0;
  for (let w = 0; w < WORLD_PRESETS.length; w++) {
    const preset = WORLD_PRESETS[w] as unknown as { city?: { primary: { x: number; z: number; radius: number } } };
    if (preset.city === undefined) continue;
    setWorld(w);
    setTerrainSeed(20250817);
    const c = preset.city.primary;
    checked++;
    for (const s of structures()) {
      if (Math.hypot(s.x - c.x, s.z - c.z) < c.radius) intruders++;
    }
  }
  void CITY_CONFIGS;
  console.log(`  ${checked} worlds with a city; ${intruders} landmarks inside one`);
  if (intruders > 0) fail(`${intruders} landmarks are standing in a city`);
}

console.log(`\n${failures === 0 ? 'THE LANDMARKS STAND' : `${failures} PROBLEM(S)`}`);

export {};
