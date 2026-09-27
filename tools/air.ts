/**
 * The things in the sky: balloons, plumes, contrails.
 *
 * All three are drawn by shaders that displace geometry, which is the one kind
 * of code where being wrong looks like being absent. A plume whose lean was
 * given in the wrong units drew as a four-kilometre horizontal smear at two
 * percent alpha and looked exactly like a plume that had failed to build. So
 * this measures the things that would be invisible either way: where they are,
 * how many, what colour, and — for the balloons — that they are not in the sky
 * at lunchtime.
 */
if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
import * as THREE from 'three';
const { WORLD_PRESETS, setWorld, setTerrainSeed, terrainHeight } =
  await import('../src/world/Worlds');
const { balloons, balloonsFlyAt, buildBalloonMeshes } = await import('../src/world/Balloons');
const { structures, coolingTowers } = await import('../src/world/Structures');
const { buildContrails } = await import('../src/world/Contrails');

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

// ------------------------------------------------------------------ balloons
console.log('BALLOONS, by world');
console.log('  world          how many   lowest AGL  highest AGL   over 3 km  over water');
let anyFlock = 0;
for (let w = 0; w < WORLD_PRESETS.length; w++) {
  setWorld(w);
  setTerrainSeed(20250817);
  const flock = balloons();
  if (flock.length === 0) {
    console.log(`  ${WORLD_PRESETS[w].name.padEnd(13)}        -`);
    continue;
  }
  anyFlock++;
  let lo = Infinity;
  let hi = -Infinity;
  let wet = 0;
  for (const b of flock) {
    const ground = terrainHeight(b.x, b.z);
    const agl = b.y - ground;
    lo = Math.min(lo, agl);
    hi = Math.max(hi, agl);
    if (ground <= 0) wet++;
  }
  const tall = flock.filter((b) => b.y - terrainHeight(b.x, b.z) > 3000).length;
  console.log(`  ${WORLD_PRESETS[w].name.padEnd(13)} ${String(flock.length).padStart(8)} ${lo.toFixed(0).padStart(12)} m ${hi.toFixed(0).padStart(11)} m ${String(tall).padStart(10)} ${String(wet).padStart(11)}`);
  // Hanging in the air, not parked on a hill or lost in the stratosphere.
  if (lo < 150) fail(`a balloon in ${WORLD_PRESETS[w].name} is only ${lo.toFixed(0)} m up`);
  // The ceiling is 12 km on purpose, so height alone is not a fault — the
  // spread is meant to reach the flight levels. The bound below is not a
  // judgement about how many *should* be high, which is a taste question and
  // was set here once at 35% purely because I had guessed it; it is the much
  // weaker claim that they have not all gone to the stratosphere and left the
  // fields empty.
  if (hi > 12_100) fail(`a balloon in ${WORLD_PRESETS[w].name} is ${hi.toFixed(0)} m up, over the ceiling`);
  const high = flock.filter((b) => b.y - terrainHeight(b.x, b.z) > 3000).length;
  if (high > flock.length * 0.5) {
    fail(`${high} of ${flock.length} balloons in ${WORLD_PRESETS[w].name} are above 3 km — the low country has been left empty`);
  }
  if (wet > 0) fail(`${wet} balloons in ${WORLD_PRESETS[w].name} are over open water`);
}
if (anyFlock < 6) fail(`only ${anyFlock} worlds have balloons at all`);

// One hue each. Read back off the built mesh rather than from the function
// that generates them, so this covers the wiring and not just the arithmetic.
console.log('\nONE COLOUR EACH');
{
  setWorld(0);
  setTerrainSeed(20250817);
  const group = buildBalloonMeshes();
  const mesh = group.children[0] as THREE.InstancedMesh | undefined;
  if (mesh === undefined || mesh.instanceColor === null) {
    fail('the balloons were built with no per-instance colour at all');
  } else {
    const hsl = { h: 0, s: 0, l: 0 };
    const colour = new THREE.Color();
    const hues: number[] = [];
    for (let i = 0; i < mesh.count; i++) {
      colour.fromBufferAttribute(mesh.instanceColor, i);
      colour.getHSL(hsl);
      hues.push(hsl.h);
    }
    // Closest pair on the colour wheel, which is the number that decides
    // whether two of them read as "the same balloon again".
    let closest = 1;
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = Math.abs(hues[i] - hues[j]);
        closest = Math.min(closest, Math.min(d, 1 - d));
      }
    }
    console.log(`  ${mesh.count} balloons, closest two hues ${(closest * 360).toFixed(1)}° apart`);
    if (closest * 360 < 8) fail(`two balloons are only ${(closest * 360).toFixed(1)}° apart in hue`);
  }
}

// The hours. Up at either end of the day, gone in the middle of it.
console.log('\nWHEN THEY FLY');
{
  const up: string[] = [];
  for (let h = 0; h < 24; h += 0.5) if (balloonsFlyAt(h)) up.push(h.toFixed(1));
  console.log(`  aloft at: ${up.join(' ')}`);
  if (balloonsFlyAt(12.6)) fail('balloons are up at midday');
  if (balloonsFlyAt(2)) fail('balloons are up in the middle of the night');
  if (!balloonsFlyAt(18.1)) fail('balloons are not up at golden hour — the default start time');
  if (!balloonsFlyAt(5.6)) fail('balloons are not up at dawn');
}

// --------------------------------------------------------------------- steam
console.log('\nPLUMES');
{
  let towers = 0;
  let plants = 0;
  let underground = 0;
  let worlds = 0;
  for (let w = 0; w < WORLD_PRESETS.length; w++) {
    setWorld(w);
    setTerrainSeed(20250817);
    const here = structures().filter((s) => s.kind === 'powerplant').length;
    const rims = coolingTowers();
    plants += here;
    towers += rims.length;
    if (rims.length > 0) worlds++;
    // A rim is the top of a tower, so it is well clear of the ground it stands
    // on. Anything at or below the terrain means the sink or the scale is out.
    for (const r of rims) if (r.y - terrainHeight(r.x, r.z) < 60) underground++;
  }
  console.log(`  ${towers} cooling towers on ${plants} power stations across ${worlds} worlds`);
  console.log(`  ${underground} rims level with the ground or below it`);
  if (towers !== plants * 2) fail(`${towers} towers for ${plants} stations — each has two`);
  if (underground > 0) fail(`${underground} plumes would start inside the hill`);
}

// ----------------------------------------------------------------- contrails
console.log('\nCONTRAILS');
{
  const group = buildContrails();
  let lowest = Infinity;
  let highest = -Infinity;
  for (const t of group.children) {
    lowest = Math.min(lowest, t.position.y);
    highest = Math.max(highest, t.position.y);
  }
  console.log(`  ${group.children.length} trails between ${lowest.toFixed(0)} m and ${highest.toFixed(0)} m`);
  if (group.children.length < 3) fail('too few contrails to read as traffic');
  // Above anything this aircraft or this landscape reaches, or they are not
  // contrails — they are streaks lying across the hills.
  if (lowest < 9000) fail(`a contrail sits at ${lowest.toFixed(0)} m, low enough to hit a mountain`);
}

// ------------------------------------------------------------------- weather
//
// The panel builds its weather row straight from this array, in this order, so
// where an entry sits in the list is where the button sits on screen.
console.log('\nWEATHER, in panel order');
{
  const { WEATHER_PRESETS } = await import('../src/world/World');
  for (const w of WEATHER_PRESETS) {
    console.log(`  ${w.name.padEnd(9)} puffs ${w.cloud.toFixed(2)}  deck ${w.deck.toFixed(2)} at ${String(w.deckY).padStart(6)} m  haze to ${String(w.hazeScale).padStart(4)} m  ground fog ${w.groundFog.toFixed(2)} in banks of ${(1 / w.fogScale / 1000).toFixed(0)} km`);
  }
  // The order is the whole of what the panel shows, so it is stated here in
  // full rather than as a rule about one neighbour. Pairwise assertions drift:
  // "CLOUDS follows HAZY" stayed true through a reorder that moved both.
  const names = WEATHER_PRESETS.map((w) => w.name);
  const WANTED = ['CLEAR', 'CLOUDS', 'CIRRUS', 'HAZY', 'FOG', 'INVERSION',
    'OVERCAST', 'RAIN', 'STORM'];
  if (names.join(' ') !== WANTED.join(' ')) {
    fail(`the weather row reads ${names.join(', ')}`);
    console.log(`      it should read ${WANTED.join(', ')}`);
  }
  // The whole point of the setting: cumulus to fly among, and nothing laid
  // across the horizon behind them.
  const c = WEATHER_PRESETS.find((w) => w.name === 'CLOUDS');
  if (c === undefined) fail('there is no CLOUDS weather');
  else {
    if (c.deck > 0.02) fail(`CLOUDS carries a far deck of ${c.deck} — it is meant to have none`);
    if (c.cloud < 0.5) fail(`CLOUDS has only ${c.cloud} of puffs — it is meant to be a cloudy day`);
  }
  // And every other setting still has to say what its deck is, or it silently
  // inherits whatever the default happens to be.
  for (const w of WEATHER_PRESETS) {
    if (typeof w.deck !== 'number') fail(`${w.name} has no deck coverage`);
    if (typeof w.deckY !== 'number') fail(`${w.name} has no deck altitude`);
    if (typeof w.hazeScale !== 'number') fail(`${w.name} has no haze scale height`);
  }

  // The two that exist *because* the deck can be put anywhere. Both are
  // defined by where they sit relative to the cumulus layer, which runs
  // 1500–3480 m: fog is under it, cirrus is a long way over it. Get either
  // altitude wrong and the preset is just a differently-tinted overcast.
  const inversion = WEATHER_PRESETS.find((w) => w.name === 'INVERSION');
  if (inversion === undefined) fail('there is no INVERSION weather');
  else {
    if (inversion.deckY > 1400) fail(`INVERSION's deck is at ${inversion.deckY} m — that is not fog in the valleys`);
    if (inversion.deck < 0.4) fail('INVERSION is not solid enough to read as a cloud sea');
    if (inversion.deck > 0.85) fail('INVERSION covers everything — the fog should lie in some valleys and not others');
    // The haze has to be held down with it, or the layer is a lid over
    // perfectly clear air and the murk never lifts as you climb.
    if (inversion.hazeScale > 900) fail(`INVERSION's haze reaches ${inversion.hazeScale} m — it should hug the ground`);
    // And the ground has to be fogged as well as the air above it. A sheet on
    // its own meets a hillside in a razor-sharp contour, which is the one
    // thing fog never has — the soft edge comes from the terrain fading into
    // the same colour underneath it.
    if (inversion.groundFog <= 0) {
      fail('INVERSION has no ground fog — its sheet will cut a hard line across every slope');
    }
  }
  // How much of the country each fogged weather actually covers.
  //
  // "Sparingly" is a number, and it is not one you can read off the preset:
  // the threshold interacts with the shape of the wave sum, so changing either
  // moves it. Measured over a 120 km square at 400 m spacing.
  const { fogCover } = await import('../src/world/GroundFog');
  const measure = (scale: number, bias: number, soft: number): number => {
    let sum = 0;
    let n = 0;
    for (let x = -60_000; x <= 60_000; x += 400) {
      for (let z = -60_000; z <= 60_000; z += 400) {
        sum += fogCover(x, z, scale, bias, soft);
        n++;
      }
    }
    return sum / n;
  };
  for (const w of WEATHER_PRESETS) {
    if (w.groundFog <= 0) continue;
    const cover = measure(w.fogScale, w.fogPatch, w.fogSoft);
    console.log(`  ${w.name} fogs ${(cover * 100).toFixed(0)}% of the country`);
    if (cover > 0.75) fail(`${w.name} fogs ${(cover * 100).toFixed(0)}% of the country — that is everything`);
    if (cover < 0.15) fail(`${w.name} fogs only ${(cover * 100).toFixed(0)}% — you would never fly into it`);
  }

  const fog = WEATHER_PRESETS.find((w) => w.name === 'FOG');
  if (fog === undefined) fail('there is no FOG weather');
  else {
    if (fog.groundFog <= 0) fail('FOG has no ground fog');
    // Shallow enough to climb out of in under a minute at a normal climb rate.
    if (fog.deckY > 600) fail(`FOG's top is at ${fog.deckY} m — you cannot climb out of that quickly`);
    // Banks rather than a lid. The scale is a reciprocal: bigger number,
    // smaller banks. Anything under about 20 km to a bank is a layer over the
    // whole country, which is the landscape switched off.
    const banks = 1 / fog.fogScale;
    if (banks > 20_000) fail(`FOG's banks are ${(banks / 1000).toFixed(0)} km across — that covers everything`);
    if (banks < 3000) fail('FOG is broken into wisps rather than banks');
    if (fog.fogPatch < 0.35) fail('FOG leaves too little of the country clear');
    // A tight edge band is what lets the fine waves shred the boundary; a wide
    // one turns the same waves into a gentle ripple on a gradient.
    if (fog.fogSoft > 0.14) fail('FOG\'s edge is too soft to tear');
  }

  // Ground fog belongs to the two weathers built on it: it costs a screen
  // wash and a term in every hazed material, and a weather that wants it says
  // so. INVERSION lies in the valleys; FOG is broken into banks you fly
  // through. Anything else carrying it is an accident.
  for (const w of WEATHER_PRESETS) {
    if (w.name !== 'INVERSION' && w.name !== 'FOG' && w.groundFog !== 0) {
      fail(`${w.name} carries ground fog and should not`);
    }
  }

  const cirrus = WEATHER_PRESETS.find((w) => w.name === 'CIRRUS');
  if (cirrus === undefined) fail('there is no CIRRUS weather');
  else {
    if (cirrus.deckY < 8000) fail(`CIRRUS sits at ${cirrus.deckY} m — it is meant to be above everything`);
    if (cirrus.deckStreak < 0.6) fail('CIRRUS is not combed enough to read as cirrus');
    if (cirrus.deckAlpha > 0.7) fail('CIRRUS is too opaque — it is thin however much of it there is');
    if (cirrus.cloud > 0.2) fail('CIRRUS has cumulus in it');
  }
}

// ------------------------------------------------------------- the cloud deck
console.log('\nTHE CLOUD DECK');
{
  const { FIELD, HANDOVER_IN, HANDOVER_OUT, DECK_REACH, CLOSED_IN, CLOSED_OUT, DECK_INNER } =
    await import('../src/world/Clouds');
  console.log(`  puffs wrap in a ${(FIELD / 1000).toFixed(0)} km tile, fade out ${(HANDOVER_IN / 1000).toFixed(1)}–${(HANDOVER_OUT / 1000).toFixed(1)} km`);
  console.log(`  the deck reaches ${(DECK_REACH / 1000).toFixed(0)} km`);
  // The puffs have to be gone before their own tile edge, or the edge is what
  // you see — a straight line across the sky where the overcast stops, which
  // is only invisible from low down because the haze is in front of it.
  if (HANDOVER_OUT >= FIELD / 2) {
    fail(`puffs fade out at ${HANDOVER_OUT} m but their tile edge is at ${FIELD / 2} m`);
  }
  // And the deck has to be fully in by the time they are gone, or there is a
  // ring of sky belonging to neither.
  if (HANDOVER_IN >= HANDOVER_OUT) fail('the handover runs backwards');
  if (DECK_REACH < FIELD * 4) fail('the deck barely reaches past the puffs');

  // And once you are clear of the layer the sheet closes in under you. The
  // ring it is drawn on has to start inside that, or closing the handover just
  // moves the hole in — which is the whole complaint: from above, a ring of
  // open water underneath and solid overcast from eight kilometres out reads
  // as a wall standing at a fixed distance however hard you fly at it.
  console.log(`  clear of the layer it closes to ${CLOSED_IN}–${CLOSED_OUT} m, on a ring from ${DECK_INNER} m`);
  if (DECK_INNER >= CLOSED_IN) {
    fail(`the deck's ring starts at ${DECK_INNER} m but the sheet begins at ${CLOSED_IN} m — a hole remains`);
  }
  if (CLOSED_IN >= CLOSED_OUT) fail('the closed handover runs backwards');
  if (CLOSED_OUT > HANDOVER_IN) fail('closing the handover does not actually bring the sheet nearer');
}

// ------------------------------------------------- custom shaders and depth
//
// The renderer runs with a logarithmic depth buffer. Every built-in material
// handles that through four shader chunks; a raw ShaderMaterial has to include
// them by hand, and one that does not writes ordinary perspective depth into a
// buffer full of log depth. Nothing errors. What happens instead is that the
// material is occluded by geometry that is *behind* it — the far cloud deck
// survived only against open sky and was rejected everywhere terrain lay
// behind it, which drew the whole overcast as a thin strip on the horizon.
//
// The materials are built and read, rather than the source being scanned for
// the text: what has to be true is that the shader the GPU compiles carries
// the chunks, and a file can mention them in a comment.
console.log('\nCUSTOM SHADERS AND THE DEPTH BUFFER');
{
  const { Clouds } = await import('../src/world/Clouds');
  const { TwilightSky } = await import('../src/world/TwilightSky');

  const clouds = new Clouds(60);
  const twilight = new TwilightSky();
  const raw: [string, THREE.ShaderMaterial][] = [
    ['cloud puffs', clouds.mesh.material as THREE.ShaderMaterial],
    ['far cloud deck', clouds.deck.material as THREE.ShaderMaterial],
  ];
  twilight.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material;
    if ((mat as THREE.ShaderMaterial).isShaderMaterial === true) {
      raw.push(['twilight dome', mat as THREE.ShaderMaterial]);
    }
  });

  for (const [name, mat] of raw) {
    const v = mat.vertexShader;
    const f = mat.fragmentShader;
    const missing: string[] = [];
    if (!v.includes('logdepthbuf_pars_vertex')) missing.push('pars_vertex');
    if (!v.includes('logdepthbuf_vertex')) missing.push('vertex');
    if (!f.includes('logdepthbuf_pars_fragment')) missing.push('pars_fragment');
    if (!f.includes('logdepthbuf_fragment')) missing.push('fragment');
    // `logdepthbuf_vertex` calls isPerspectiveMatrix, which only <common>
    // declares — leave it out and the program fails to link, which at least
    // announces itself, unlike the silent version above.
    if (!v.includes('#include <common>')) missing.push('common (vertex)');
    console.log(`  ${name.padEnd(16)} ${missing.length === 0 ? 'writes log depth' : 'MISSING ' + missing.join(', ')}`);
    if (missing.length > 0) {
      fail(`the ${name} shader is missing ${missing.join(', ')} — it cannot depth-test against anything`);
    }
  }
  console.log(`  ${raw.length} raw shader material(s) checked`);
  clouds.dispose();
}

console.log(failures === 0 ? '\nTHE SKY IS OCCUPIED' : `\n${failures} PROBLEM(S)`);

export {};
