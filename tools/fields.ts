/**
 * Two kinds of village, and the ordinary one must not have been eaten.
 *
 * Fields were added by turning ordinary villages into field villages, which
 * quietly deleted the ordinary village from every world — you could fly for a
 * long time and never see the thing the fields were supposed to be an addition
 * to. So the counts below are a baseline, not a description: they are what
 * each world held before any of this started, and the field villages are a
 * separate population layered on top. If an ordinary count moves, something
 * has started converting them again.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { WORLD_PRESETS, setWorld, setTerrainSeed } = await import('../src/world/Worlds');
const { settlements, farmland, farmlandHome } = await import('../src/world/Settlements');

/** Villages each world had before fields existed, at seed 20250817. */
const BASELINE: Record<string, number> = {
  ISLES: 98, CANYON: 300, FJORDS: 112, HIMALAYA: 165, ICELAND: 92,
  KARST: 90, DUNES: 101, ALPINE: 199, LAGOON: 8, PACIFIC: 67,
};
const FIELD_GAP = 2400;
const FIELD_SPACING = 3200;

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

const RING: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.707, 0.707], [-0.707, 0.707], [0.707, -0.707], [-0.707, -0.707],
];
/** Strongest of each kind on a ring at radius r. */
const around = (x: number, z: number, r: number): [number, number] => {
  let field = 0;
  let home = 0;
  for (const [dx, dz] of RING) {
    field = Math.max(field, farmland(x + dx * r, z + dz * r));
    home = Math.max(home, farmlandHome());
  }
  return [field, home];
};

console.log('VILLAGES, by world');
console.log('  world         ordinary  (was)   with fields   home tint  patch reach');

for (let w = 0; w < WORLD_PRESETS.length; w++) {
  setWorld(w);
  setTerrainSeed(20250817);
  const all = settlements();
  const name = WORLD_PRESETS[w].name;
  if (all.length === 0) {
    console.log(`  ${name.padEnd(13)}        -  uninhabited`);
    if (BASELINE[name] !== undefined) fail(`${name} used to have ${BASELINE[name]} villages and now has none`);
    continue;
  }
  const plain = all.filter((v) => !v.fields);
  const fields = all.filter((v) => v.fields);

  // The ordinary village must still tint its own ground — that belt is what
  // makes a settlement visible from cruise, and it is the whole of what was
  // lost. Measured at 300 m, inside HOME_OUTER.
  let bare = 0;
  let tint = 0;
  for (const v of plain) {
    const [, home] = around(v.x, v.z, 300);
    if (home < 0.2) bare++;
    tint = Math.max(tint, home);
  }

  // A field village must lay down a patchwork, and it must reach.
  let flat = 0;
  let reach = 0;
  for (const v of fields) {
    const [near] = around(v.x, v.z, 500);
    if (near < 0.2) flat++;
    // Only on a village with nobody else inside 4 km. Field villages sit
    // FIELD_SPACING apart, so a ring at 2400 m from one lands well inside the
    // next one's belt — and the reading would be that neighbour's patchwork
    // reported as this one overrunning.
    const lonely = all.every((o) => o === v || Math.hypot(o.x - v.x, o.z - v.z) > 4000);
    if (!lonely) continue;
    for (let r = 200; r <= 2400; r += 100) {
      if (around(v.x, v.z, r)[0] > 0.02) reach = Math.max(reach, r);
    }
  }

  const was = BASELINE[name];
  console.log(
    `  ${name.padEnd(13)} ${String(plain.length).padStart(8)}  ${String(was ?? '-').padStart(5)}  ${String(fields.length).padStart(11)}  ${tint.toFixed(2).padStart(10)}  ${String(reach).padStart(11)}`,
  );

  if (was !== undefined && plain.length !== was) {
    fail(`${name} has ${plain.length} ordinary villages, not the ${was} it had before fields existed`);
  }
  if (bare > 0) fail(`${bare} ordinary village(s) have no farmland around them at all`);
  if (fields.length === 0) fail('no field villages were added here');
  if (flat > 0) fail(`${flat} field village(s) lay down no patchwork`);
  if (reach > 1600) fail(`a patchwork reaches ${reach} m — past FARM_OUTER`);

  // The two kinds keep out of each other's way, or the ordinary one is found
  // standing in somebody else's hedged fields with its own belt drowned.
  let crowded = 0;
  for (const f of fields) {
    if (plain.some((v) => Math.hypot(v.x - f.x, v.z - f.z) < FIELD_GAP)) crowded++;
    if (fields.some((o) => o !== f && Math.hypot(o.x - f.x, o.z - f.z) < FIELD_SPACING)) crowded++;
  }
  if (crowded > 0) fail(`${crowded} field village(s) sit too close to another village`);
}

console.log(failures === 0 ? '\nORDINARY VILLAGES INTACT, FIELDS ON TOP' : `\n${failures} PROBLEM(S)`);

export {};
