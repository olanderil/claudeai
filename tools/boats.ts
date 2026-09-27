/**
 * Where the shipping ended up, world by world.
 *
 * "Here and there in every world that has sea" is a claim about a distribution
 * across fifteen landscapes, and a distribution is exactly the thing that looks
 * right in the one screenshot you happen to take and is wrong everywhere else.
 * So this counts the fleet in every world and checks the things a pilot would
 * notice: that there are boats where there is sea, none where there is not, no
 * yachts in the Antarctic, and — the one that actually matters — that not a
 * single hull is sitting on dry land or aground in the shallows.
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { WORLD_PRESETS, setWorld, setTerrainSeed, terrainHeight, spawnPoint } =
  await import('../src/world/Worlds');
const { boats, boatScale, buildBoatMeshes, disposeBoatMeshes } =
  await import('../src/world/Boats');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

console.log('THE FLEET, by world');
console.log('  world          ocean   sail  cargo   shallowest hull   nearest the start');

let seaWorlds = 0;
for (let w = 0; w < WORLD_PRESETS.length; w++) {
  const preset = WORLD_PRESETS[w];
  setWorld(w);
  setTerrainSeed(20250817);

  const fleet = boats();
  const sail = fleet.filter((b) => b.kind === 'sail').length;
  const cargo = fleet.filter((b) => b.kind === 'cargo').length;

  // The one that would be visible from a mile away: a ship on a beach.
  let shallowest = Infinity;
  let aground = 0;
  for (const b of fleet) {
    const depth = -terrainHeight(b.x, b.z);
    shallowest = Math.min(shallowest, depth);
    if (depth <= 0) aground++;
  }
  const spawn = spawnPoint();
  let nearest = Infinity;
  for (const b of fleet) {
    nearest = Math.min(nearest, Math.hypot(b.x - spawn.x, b.z - spawn.z));
  }

  console.log(`  ${preset.name.padEnd(13)} ${String(preset.hasOcean).padEnd(7)} `
    + `${String(sail).padStart(4)} ${String(cargo).padStart(6)}   `
    + `${(fleet.length === 0 ? '-' : shallowest.toFixed(0) + ' m').padStart(14)}   `
    + `${(fleet.length === 0 ? '-' : (nearest / 1000).toFixed(1) + ' km').padStart(9)}`);

  if (aground > 0) fail(`${preset.name}: ${aground} boats are on dry land`);

  if (preset.hasOcean) {
    seaWorlds++;
    if (fleet.length < 6) fail(`${preset.name} has sea but only ${fleet.length} boats`);
    if (cargo === 0) fail(`${preset.name} has sea but no cargo ships`);
    if (preset.name === 'ANTARCTIC') {
      if (sail > 0) fail(`${sail} sailing boats in the Antarctic`);
    } else if (sail === 0) {
      fail(`${preset.name} has sea but no sailing boats`);
    }
    // Deep enough that the hull is floating, not resting on the bottom.
    if (shallowest < 3) fail(`${preset.name}: a hull sits in ${shallowest.toFixed(1)} m of water`);
    // And not parked on the runway's doorstep.
    if (nearest < 3000) fail(`${preset.name}: a boat is ${Math.round(nearest)} m from the start`);
  } else if (fleet.length > 0) {
    fail(`${preset.name} has no ocean but ${fleet.length} boats`);
  }
}

console.log(`\n  ${seaWorlds} of ${WORLD_PRESETS.length} worlds have sea`);

// ------------------------------------------------------------------- the meshes
//
// Two draw calls for the whole fleet is the reason the boats are merged
// geometry rather than a mesh per part, so it is worth stating as a number.
console.log('\nTHE MESHES');
const deepestHull = (() => {
  setWorld(WORLD_PRESETS.findIndex((p) => p.name === 'ISLES'));
  setTerrainSeed(20250817);
  const group = buildBoatMeshes();
  let calls = 0;
  let tris = 0;
  let instances = 0;
  group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    calls++;
    instances += o.count;
    // `mergeGeometries` returns null when the parts disagree about being
    // indexed, so a boat with no geometry is a thing that can actually happen.
    if (o.geometry === null || o.geometry === undefined) {
      fail('a boat mesh has no geometry — the parts failed to merge');
      return;
    }
    const idx = o.geometry.getIndex();
    tris += (idx ? idx.count : o.geometry.getAttribute('position').count) / 3;
  });
  console.log(`  ${instances} boats in ${calls} draw calls, `
    + `${tris} triangles a hull between them`);
  if (calls > 2) fail(`${calls} draw calls — the parts are not merged`);
  if (instances === 0) fail('the fleet built no instances');
  // Floating, not sunk or hovering: every hull's waterline is the sea's.
  const dummy = new THREE.Matrix4();
  const at = new THREE.Vector3();
  let offWater = 0;
  group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, dummy);
      at.setFromMatrixPosition(dummy);
      if (Math.abs(at.y) > 0.001) offWater++;
    }
  });
  console.log(`  ${offWater} hulls sit away from the waterline`);
  if (offWater > 0) fail(`${offWater} boats are not floating at sea level`);

  // Draught, per kind. The hulls are drawn larger than life, which pushes their
  // bottoms further down, so how deep each kind now reaches has to be checked
  // against the shallowest water *that kind* is allowed into — a freighter's
  // draught says nothing about a yacht's anchorage, and comparing the two gave
  // a failure that was purely an artefact of mixing them up.
  const draught = new Map<string, number>();
  group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox;
    if (box === null) return;
    let biggest = 0;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, dummy);
      biggest = Math.max(biggest, new THREE.Vector3().setFromMatrixScale(dummy).y);
    }
    // Instance order follows the build order: cargo first, then sail.
    draught.set(draught.has('cargo') ? 'sail' : 'cargo', -box.min.y * biggest);
  });
  console.log(`  drawn at ${boatScale()}x: `
    + [...draught].map(([k, d]) => `${k} draws ${d.toFixed(1)} m`).join(', '));
  disposeBoatMeshes(group);
  return draught;
})();

// Every world's shallowest boat, against how deep the hulls actually reach.
console.log('\nDRAUGHT, per kind, against the shallowest berth that kind uses');
{
  const worst = new Map<string, { depth: number; where: string }>();
  for (let w = 0; w < WORLD_PRESETS.length; w++) {
    setWorld(w);
    setTerrainSeed(20250817);
    for (const b of boats()) {
      const depth = -terrainHeight(b.x, b.z);
      const held = worst.get(b.kind);
      if (held === undefined || depth < held.depth) {
        worst.set(b.kind, { depth, where: WORLD_PRESETS[w].name });
      }
    }
  }
  for (const [kind, { depth, where }] of worst) {
    const draws = deepestHull.get(kind) ?? 0;
    const clear = depth - draws;
    console.log(`  ${kind.padEnd(6)} draws ${draws.toFixed(1)} m, shallowest berth `
      + `${depth.toFixed(1)} m (${where}) — ${clear.toFixed(1)} m under the keel`);
    if (clear <= 0) {
      fail(`a ${kind} draws ${draws.toFixed(1)} m and sits in ${depth.toFixed(1)} m of water`);
    }
  }
}

console.log(`\n${failures === 0 ? 'THE FLEET FLOATS' : `${failures} PROBLEM(S)`}`);

export {};
