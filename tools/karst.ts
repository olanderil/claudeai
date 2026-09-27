/**
 * Measure the karst tower field: how many, how big, and how varied.
 *
 * "Fewer towers, more variety, some enormous" is three claims about a
 * distribution, and a distribution is exactly the kind of thing that looks
 * right in one screenshot and is wrong everywhere else. This samples the height
 * field over a large area, finds the summits, and reports what is actually
 * there — count per square kilometre, the spread of heights, and whether the
 * airfield is clear.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { WORLD_PRESETS, setWorld, setTerrainSeed, terrainHeight } =
  await import('../src/world/Worlds');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

const index = WORLD_PRESETS.findIndex((w) => w.name === 'KARST');
if (index < 0) throw new Error('no KARST preset');
setWorld(index);
setTerrainSeed(20250817);

/**
 * Local maxima of the height field, which is what a tower summit is.
 *
 * Sampled on a grid fine enough that a tower cannot hide between two samples:
 * the narrowest is 55 m across, so 40 m steps put at least one sample on every
 * one of them. A summit is a sample higher than all eight of its neighbours and
 * standing clear of the plain around it.
 */
const STEP = 40;
const HALF = 24_000; // a 48 km square, about what a flight crosses
const PLAIN = 90; // the alluvial plain sits near 42 m; anything above this is rock

function survey(): { peaks: { x: number; z: number; h: number }[]; areaKm2: number } {
  const n = Math.floor((HALF * 2) / STEP);
  const row = (j: number): Float64Array => {
    const out = new Float64Array(n + 2);
    for (let i = 0; i <= n + 1; i++) {
      out[i] = terrainHeight(-HALF + (i - 1) * STEP, -HALF + j * STEP);
    }
    return out;
  };
  let above = row(0);
  let here = row(1);
  const peaks: { x: number; z: number; h: number }[] = [];
  for (let j = 1; j <= n; j++) {
    const below = row(j + 1);
    for (let i = 1; i <= n; i++) {
      const h = here[i];
      if (h < PLAIN) continue;
      if (h < here[i - 1] || h < here[i + 1]) continue;
      if (h < above[i] || h < below[i]) continue;
      if (h < above[i - 1] || h < above[i + 1]) continue;
      if (h < below[i - 1] || h < below[i + 1]) continue;
      peaks.push({ x: -HALF + (i - 1) * STEP, z: -HALF + j * STEP, h });
    }
    above = here;
    here = below;
  }
  return { peaks, areaKm2: ((n * STEP) / 1000) ** 2 };
}

const { peaks, areaKm2 } = survey();

/**
 * Tower or hilltop?
 *
 * Now that there is real relief under the towers, "a local maximum" is no
 * longer the same thing as "a tower" — every hill has a top too, and counting
 * those as towers would report the field getting denser precisely when it was
 * being thinned. What separates them is the wall: a limestone tower drops
 * hundreds of metres over a few tens, and no hill does. So this walks outward
 * from each summit and keeps the steepest single step it finds.
 */
const PROBE_STEP = 40;
const PROBE_REACH = 1600;
const WALL_DROP = 60; // metres lost in one 40 m step: about 56 degrees

function shape(x: number, z: number, top: number): { drop: number; foot: number } {
  let steepest = 0;
  let foot = top;
  for (let a = 0; a < 8; a++) {
    const th = (a / 8) * Math.PI * 2;
    const dx = Math.cos(th) * PROBE_STEP;
    const dz = Math.sin(th) * PROBE_STEP;
    let last = top;
    for (let i = 1; i * PROBE_STEP <= PROBE_REACH; i++) {
      const h = terrainHeight(x + dx * i, z + dz * i);
      steepest = Math.max(steepest, last - h);
      foot = Math.min(foot, h);
      last = h;
    }
  }
  return { drop: steepest, foot };
}

const towers: { top: number; rise: number }[] = [];
const hills: number[] = [];
for (const p of peaks) {
  const { drop, foot } = shape(p.x, p.z, p.h);
  if (drop >= WALL_DROP) towers.push({ top: p.h, rise: p.h - foot });
  else hills.push(p.h);
}
towers.sort((a, b) => b.rise - a.rise);
const density = towers.length / areaKm2;

console.log(`SURVEY    ${peaks.length} summits over ${Math.round(areaKm2)} km²`);
console.log(`  ${towers.length} are towers (walls steeper than ${WALL_DROP} m per ${PROBE_STEP} m)`);
console.log(`  ${hills.length} are hilltops — the country the towers stand on`);
console.log(`  towers: ${density.toFixed(3)} per km²`);

// Thinned twice: 0.83/km² originally, 0.152 after the first pass, and the brief
// this time was "still fewer".
console.log(`  against 0.83/km² originally and 0.152 last pass`);
if (density > 0.12) fail(`${density.toFixed(3)}/km² is not fewer than last pass's 0.152`);
if (density < 0.03) fail(`${density.toFixed(3)}/km² is too empty to read as karst`);

// ------------------------------------------------------------------- relief
//
// "Hills and mountains from which the high cliffs rise" is a claim about the
// ground, so it is measured with the towers taken out.
console.log('\nRELIEF    the country under the towers');
{
  // Measured off the ground itself, not off summits. A long ridge has very few
  // local maxima along its crest, so counting hilltops said "416 m" about
  // country with kilometre-high ridges in it — it was measuring the wrong thing.
  //
  // Towers are narrow and the ground they stand on is not, so taking the
  // *lowest* point within 400 m strips the towers out and leaves the country.
  const bare = (x: number, z: number): number => {
    let low = terrainHeight(x, z);
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2;
      low = Math.min(low, terrainHeight(x + Math.cos(th) * 400, z + Math.sin(th) * 400));
    }
    return low;
  };
  const ground: number[] = [];
  for (let x = -HALF; x <= HALF; x += 300) {
    for (let z = -HALF; z <= HALF; z += 300) {
      const g = bare(x, z);
      if (g > 5) ground.push(g); // dry land only
    }
  }
  ground.sort((a, b) => b - a);
  const q = (f: number): number => ground[Math.min(ground.length - 1, Math.floor(ground.length * f))];
  console.log(`  highest ground ${Math.round(ground[0])} m`
    + `, 2nd percentile ${Math.round(q(0.02))} m`
    + `, 20th ${Math.round(q(0.2))} m, median ${Math.round(q(0.5))} m`);
  if (ground[0] < 900) fail(`the highest ground is ${Math.round(ground[0])} m — no mountains`);
  if (q(0.2) < 120) fail('most of the country is still flat paddy');
  if (q(0.5) > 700) fail('there is no low ground left for the towers to stand out of');

  // Height alone said this country was hilly when it plainly was not: 164 m of
  // rise spread over a seven-kilometre wavelength is a two per cent slope, and
  // from a mile up that is a table. What makes ground read as hills is how much
  // it changes *within sight* — so this measures the spread of the bare ground
  // over a three-kilometre window, which is about what fills the windscreen.
  const relief: number[] = [];
  for (let x = -HALF + 3000; x <= HALF - 3000; x += 1500) {
    for (let z = -HALF + 3000; z <= HALF - 3000; z += 1500) {
      let lo = Infinity;
      let hi = -Infinity;
      let wet = false;
      for (let a = 0; a < 9; a++) {
        const px = x + ((a % 3) - 1) * 1500;
        const pz = z + (Math.floor(a / 3) - 1) * 1500;
        const g = bare(px, pz);
        if (g <= 5) wet = true;
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
      }
      if (!wet) relief.push(hi - lo);
    }
  }
  relief.sort((a, b) => b - a);
  const rq = (f: number): number => relief[Math.min(relief.length - 1, Math.floor(relief.length * f))];
  console.log(`  ground rises and falls, over any 3 km of dry land: `
    + `median ${Math.round(rq(0.5))} m, 20th percentile ${Math.round(rq(0.2))} m`
    + `, most ${Math.round(relief[0])} m`);
  if (rq(0.5) < 130) fail(`typical 3 km of country moves ${Math.round(rq(0.5))} m — that is a plain`);
  if (rq(0.2) < 260) fail('even the hillier fifth of the country is barely rolling');
}

// ------------------------------------------------------------------- heights
console.log('\nTOWERS    how far they stand above their own feet');
for (const [label, i] of [['tallest', 0], ['5th', 4], ['20th', 19]] as [string, number][]) {
  const t = towers[Math.min(i, towers.length - 1)];
  console.log(`  ${label.padEnd(8)} rises ${Math.round(t.rise)} m, summit at ${Math.round(t.top)} m`);
}
const enormous = towers.filter((t) => t.rise >= 1000);
const huge = towers.filter((t) => t.rise >= 1800);
console.log(`\n  ${enormous.length} rise over 1 km, of which ${huge.length} over 1.8 km`);
console.log(`  tallest summit anywhere: ${Math.round(Math.max(...towers.map((t) => t.top)))} m`);
// "More enormous cliffs" — last pass put 9 over a kilometre in this same area.
if (enormous.length <= 9) fail(`only ${enormous.length} over 1 km — no more than last pass's 9`);
if (huge.length === 0) fail('nothing rises 1.8 km');
// ...but still rare against the common towers.
if (enormous.length > towers.length * 0.35) {
  fail(`${enormous.length} of ${towers.length} towers are giants — that is not rare`);
}

// --------------------------------------------------------------------- shore
//
// "In the shores there should not be high cliffs at all."
console.log('\nSHORE     what stands at the waterline');
{
  let worst = 0;
  let coastHigh = 0;
  let worstAt = { x: 0, z: 0 };
  let tested = 0;
  // Wider than the tower survey: the airfield sits well inland, and most of the
  // coast this world has is outside the 48 km square the summits are counted in.
  const SHORE_HALF = 46_000;
  for (let x = -SHORE_HALF; x <= SHORE_HALF; x += 300) {
    for (let z = -SHORE_HALF; z <= SHORE_HALF; z += 300) {
      const h = terrainHeight(x, z);
      if (h < -2 || h > 12) continue; // the waterline itself
      // The *sea* shore, not a lake shore. The lakes are cut to below sea level
      // so the ocean plane fills them, which makes their rims look exactly like
      // coast to a height test — and a tower standing over a lake is the
      // silhouette this world exists for, not a defect. A lake is at most a
      // kilometre or so across, so a ring at two and a half tells them apart:
      // open sea keeps going, a tarn does not.
      let wet = 0;
      for (let a = 0; a < 12; a++) {
        const th = (a / 12) * Math.PI * 2;
        if (terrainHeight(x + Math.cos(th) * 2500, z + Math.sin(th) * 2500) <= 2) wet++;
      }
      if (wet < 6) continue;
      tested++;
      // A *cliff*, not merely high ground. Hills running down to the sea are
      // landscape; what must not be here is a wall, so this looks for the same
      // near-vertical step the tower classifier uses rather than for altitude.
      // Measuring height instead called a mountainside sloping into a bay a
      // cliff, which is a different complaint from the one being checked.
      let near = 0;
      let tallest = 0;
      for (let a = 0; a < 12; a++) {
        const th = (a / 12) * Math.PI * 2;
        const dx = Math.cos(th) * PROBE_STEP;
        const dz = Math.sin(th) * PROBE_STEP;
        let last = h;
        for (let i = 1; i * PROBE_STEP <= 900; i++) {
          const g = terrainHeight(x + dx * i, z + dz * i);
          near = Math.max(near, g - last);
          tallest = Math.max(tallest, g);
          last = g;
        }
      }
      coastHigh = Math.max(coastHigh, tallest);
      if (near > worst) {
        worst = near;
        worstAt = { x, z };
      }
    }
  }
  console.log(`  ${tested} points of coastline sampled`);
  console.log(`  tallest ground within 900 m of the water: ${Math.round(coastHigh)} m`);
  console.log(`  steepest step within 900 m of the water: ${Math.round(worst)} m per `
    + `${PROBE_STEP} m  (at ${worstAt.x}, ${worstAt.z})`);
  if (tested < 200) fail('too little coastline in the survey area to say anything');
  if (worst >= WALL_DROP) {
    fail(`a wall rises ${Math.round(worst)} m per ${PROBE_STEP} m at the shore`);
  }
}

// ------------------------------------------------------------------ airfield
//
// The runway pad flattens the ground within 1.9 km and ramps out to 5.2 km, so
// ordinary towers near the field are handled — but a 3 km giant standing at the
// edge of that ramp would be a wall across the departure.
console.log('\nAIRFIELD  what stands near the runway');
let worst = 0;
let worstAt = 0;
for (let r = 0; r <= 9000; r += 60) {
  for (let a = 0; a < 64; a++) {
    const th = (a / 64) * Math.PI * 2;
    const h = terrainHeight(Math.cos(th) * r, Math.sin(th) * r);
    if (h > worst) {
      worst = h;
      worstAt = r;
    }
  }
}
console.log(`  tallest ground within 9 km of the field: ${Math.round(worst)} m, at ${worstAt} m out`);
if (worst > 900) fail(`${Math.round(worst)} m within 9 km of the runway is a wall, not a view`);

// And the runway itself is still flat.
let runwayMin = Infinity;
let runwayMax = -Infinity;
for (let x = -900; x <= 900; x += 30) {
  for (let z = -900; z <= 900; z += 30) {
    const h = terrainHeight(x, z);
    runwayMin = Math.min(runwayMin, h);
    runwayMax = Math.max(runwayMax, h);
  }
}
console.log(`  the field itself: ${runwayMin.toFixed(1)} m to ${runwayMax.toFixed(1)} m`);
if (runwayMax - runwayMin > 1) fail('the airfield is no longer flat');

console.log(`\n${failures === 0 ? 'KARST STANDS UP' : `${failures} PROBLEM(S)`}`);

export {};
