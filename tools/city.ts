/**
 * Check every city world.
 *
 * Three things must hold for each, and one across all of them:
 *
 * - the meshes and the collision sampler agree about where the buildings are,
 * - streets and gaps stay walkable ground rather than becoming roofs,
 * - the renderer can cull and shadow-gate what it draws,
 *
 * and no world *without* a city may see one. That last check exists because the
 * ground tint leaked once: it was sampled for every terrain vertex in every
 * world without asking whether the world had a city, so one city's street grid
 * and park were painted across all of them.
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { WORLD_PRESETS, setWorld, terrainHeight, groundHeight } =
  await import('../src/world/Worlds');
const { buildCityMeshes, cityHeight, cityDensity, citySites } = await import('../src/world/City');

let failures = 0;
const fail = (why: string): void => { failures++; console.log(`      <-- ${why}`); };

// Plan one world and throw it away, so the timings below are of the planner
// running rather than of V8 compiling it. Cold, the first town costs 21 ms and
// warm it costs 8 — measuring the cold number would be measuring the JIT.
{
  const w = WORLD_PRESETS.findIndex((p) => p.city !== undefined);
  setWorld(w);
  const city = buildCityMeshes();
  const eye = new THREE.Vector3();
  for (let leg = 0; leg <= 20; leg++) {
    eye.set(0, 600, -6000 + leg * 1400);
    city.update({ position: eye } as unknown as THREE.Camera, 1400, eye);
  }
}

for (let w = 0; w < WORLD_PRESETS.length; w++) {
  const preset = WORLD_PRESETS[w];
  if (preset.city === undefined) continue;
  const t0 = Date.now();
  setWorld(w);
  const planMs = Date.now() - t0;

  const city = buildCityMeshes();
  // Fly a long straight line and let the planner stream places in, so this
  // measures what a pilot actually meets rather than one starting position.
  const eye = new THREE.Vector3();
  const seen = new Set<string>();
  let peakInstances = 0;
  let worstUpdate = 0;

  // The metropolis is planned on the first update, at world load, alongside a
  // terrain rebuild that costs far more — so it is timed separately from the
  // places that stream in mid-flight, where a long frame is a stutter.
  eye.set(0, 600, -6000);
  const loadT = performance.now();
  city.update({ position: eye } as unknown as THREE.Camera, 1400, eye);
  const loadMs = performance.now() - loadT;
  console.log(`  planning the metropolis: ${loadMs.toFixed(0)} ms (at world load)`);
  if (loadMs > 250) fail(`the metropolis costs ${loadMs.toFixed(0)} ms to plan`);

  for (let leg = 0; leg <= 90; leg++) {
    eye.set(0, 600, -6000 + leg * 1400);
    for (let step = 0; step < 4; step++) {
      const t = performance.now();
      city.update({ position: eye } as unknown as THREE.Camera, 1400, eye);
      worstUpdate = Math.max(worstUpdate, performance.now() - t);
    }
    for (const s of citySites()) seen.add(`${s.x.toFixed(0)}|${s.z.toFixed(0)}`);
    peakInstances = Math.max(peakInstances, city.buildings());
  }
  console.log(`  flying 126 km: ${seen.size} places met, at most ` +
    `${peakInstances} buildings loaded at once`);
  if (seen.size < 8) fail(`only ${seen.size} places over 126 km — the world runs out`);

  // Towns are planned in the frame they come into range, so the cost of
  // planning one is a hitch the pilot sees. A frame is 16.7 ms, and at most one
  // place is planned per frame; the dearest is the large satellite next to
  // Manhattan, at 4300 lots.
  console.log(`  worst place streamed in while flying: ${worstUpdate.toFixed(1)} ms`);
  if (worstUpdate > 12) fail(`streaming a place costs ${worstUpdate.toFixed(0)} ms — visible hitch`);

  // Back to the metropolis for the rest of the checks.
  eye.set(preset.city.primary.x, 600, preset.city.primary.z);
  for (let i = 0; i < 40; i++) city.update({ position: eye } as unknown as THREE.Camera, 1400, eye);
  let instances = 0;
  let meshes = 0;
  let bounded = 0;
  city.group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    meshes++;
    instances += o.count;
    if (o.boundingSphere !== null && o.boundingSphere.radius > 1 && o.frustumCulled) bounded++;
  });

  console.log(`\n${preset.name}`);
  console.log(`  ${instances} buildings, ${meshes} meshes, planned in ${planMs} ms`);
  if (instances < 2000) fail(`only ${instances} buildings — the placement rule found nowhere to build`);
  if (bounded !== meshes) fail(`${meshes - bounded} meshes cannot be frustum-culled`);

  // Heights: a skyline needs spread, not a mean.
  const area = { ...preset.city.primary };
  const heights: number[] = [];
  for (let z = area.z - area.radius; z < area.z + area.radius; z += 53) {
    for (let x = area.x - area.radius; x < area.x + area.radius; x += 47) {
      const h = cityHeight(x, z);
      if (h > -Infinity) heights.push(h - terrainHeight(x, z));
    }
  }
  heights.sort((a, b) => a - b);
  const at = (p: number): number => heights[Math.floor(p * (heights.length - 1))] ?? 0;
  console.log(`  heights: median ${at(0.5).toFixed(0)} m, 90th ${at(0.9).toFixed(0)} m, ` +
    `tallest ${at(1).toFixed(0)} m`);

  // The places themselves: one metropolis and the towns to find around it.
  const places = citySites();
  const size = (v: number): string => (v > 0.85 ? 'metropolis' : v > 0.55 ? 'city' : v > 0.35 ? 'town' : 'village');
  console.log(`  ${places.length} places: ` + places.map((s, i) =>
    `${size(s.scale)}@${(Math.hypot(s.x, s.z) / 1000).toFixed(0)}km` + (i === 0 ? '*' : '')).join(' '));
  let closest = Infinity;
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      closest = Math.min(closest,
        Math.hypot(places[i].x - places[j].x, places[i].z - places[j].z)
          - places[i].radius - places[j].radius);
    }
  }
  console.log(`  countryside between the nearest two: ${(closest / 1000).toFixed(1)} km`);
  if (places.length < 4) fail(`only ${places.length} places — nothing to discover`);
  if (closest < 500) fail('places have merged into one sprawl');
  if (at(1) < 150) fail('nothing tall enough to be a skyline');

  // Do the meshes and the collision sampler agree?
  let checked = 0;
  let worst = 0;
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  city.group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || o.geometry.type !== 'BoxGeometry') return;
    for (let i = 0; i < o.count; i += 11) {
      o.getMatrixAt(i, m);
      m.decompose(pos, quat, scale);
      const expected = pos.y + scale.y / 2;
      worst = Math.max(worst, Math.abs(groundHeight(pos.x, pos.z) - expected));
      checked++;
    }
  });
  console.log(`  mesh vs collision: ${checked} roofs, worst ${worst.toFixed(2)} m`);
  if (worst > 0.5) fail(`roofs disagree by up to ${worst.toFixed(2)} m`);

  // No two buildings may share ground. Where they do, the collision sampler
  // returns the taller one and the shorter one's roof is a lie — which is how
  // a landmark clearing that ignored the neighbour's own width was caught.
  const CELL = 200;
  const grid = new Map<string, { x: number; z: number; w: number; d: number }[]>();
  city.group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || o.geometry.type !== 'BoxGeometry') return;
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m);
      m.decompose(pos, quat, scale);
      const box = { x: pos.x, z: pos.z, w: scale.x, d: scale.z };
      const k = `${Math.floor(box.x / CELL)}|${Math.floor(box.z / CELL)}`;
      const list = grid.get(k);
      if (list) list.push(box); else grid.set(k, [box]);
    }
  });
  let overlaps = 0;
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if ((list[a].w + list[b].w) / 2 - Math.abs(list[a].x - list[b].x) > 0.01
          && (list[a].d + list[b].d) / 2 - Math.abs(list[a].z - list[b].z) > 0.01) overlaps++;
      }
    }
  }
  console.log(`  overlapping footprints: ${overlaps}`);
  if (overlaps > 0) fail(`${overlaps} pairs of buildings share ground`);

  // Streets and gaps must stay ground.
  let solid = 0;
  let samples = 0;
  // The whole search area, not a box around its centre: a city that hugs a
  // coastline leaves the middle of its own area in open water, and a test that
  // only looks there samples nothing at all.
  for (let z = area.z - area.radius; z < area.z + area.radius; z += 29) {
    for (let x = area.x - area.radius; x < area.x + area.radius; x += 23) {
      if (cityHeight(x, z) === -Infinity && cityDensity(x, z) > 0.5) {
        samples++;
        if (groundHeight(x, z) > terrainHeight(x, z) + 0.01) solid++;
      }
    }
  }
  console.log(`  streets and gaps: ${samples} samples, ${solid} wrongly solid`);
  if (solid > 0) fail(`${solid} street samples are solid`);
  if (samples < 500) fail(`only ${samples} street samples — the test found no city`);

  // Culling and shadow gating, seen from inside the city.
  const p = preset.city.primary;
  const centre = new THREE.Vector3(p.x, terrainHeight(p.x, p.z) + 300, p.z);
  city.update({ position: centre } as unknown as THREE.Camera, 1400, centre);
  let casting = 0;
  let hidden = 0;
  city.group.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh)) return;
    if (o.castShadow) casting += o.count;
    if (!o.visible) hidden += o.count;
  });
  console.log(`  from inside: ${(100 * casting / instances).toFixed(0)}% cast shadows, ` +
    `${hidden} distant low-rise dropped`);
  if (casting > instances * 0.75) fail('almost everything still casts shadows');

  // The airfield has to stay dry land whatever the city did to the water.
  const field = terrainHeight(0, -1200);
  console.log(`  airfield: ${field.toFixed(1)} m`);
  if (field < 4) fail(`airfield is ${field.toFixed(1)} m — under water`);
}

console.log('\nLEAKAGE INTO WORLDS WITHOUT A CITY');
let leaked = 0;
for (let w = 0; w < WORLD_PRESETS.length; w++) {
  if (WORLD_PRESETS[w].city !== undefined) continue;
  setWorld(w);
  let tint = 0;
  let solid = 0;
  for (let z = -4000; z < 30000; z += 311) {
    for (let x = -8000; x < 8000; x += 197) {
      if (cityDensity(x, z) !== 0) tint++;
      if (cityHeight(x, z) !== -Infinity) solid++;
    }
  }
  if (tint > 0 || solid > 0) {
    leaked++;
    console.log(`  ${WORLD_PRESETS[w].name.padEnd(10)} ${tint} tinted, ${solid} solid  <-- LEAKED`);
  }
}
console.log(leaked === 0 ? '  clean' : `  ${leaked} world(s) contaminated`);

console.log(failures === 0 && leaked === 0 ? '\nALL CITIES OK' : `\n${failures + leaked} PROBLEM(S)`);
