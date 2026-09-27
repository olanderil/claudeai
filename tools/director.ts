/**
 * Check what the director's two new knobs actually do to the camera.
 *
 * Hold and travel are multipliers buried in an easing curve, which is exactly
 * the kind of thing that looks right in a screenshot and is out by a factor of
 * two. So this drives the director at the physics rate with the aircraft held
 * still, and measures the two quantities the sliders claim to set: how many
 * seconds a shot is held, and how far the camera moves while it is.
 *
 * `Math.random` is pinned to 0.5 throughout. Shot durations are drawn from a
 * range and the shot choice is a random pick from a pool; without pinning, a
 * measured duration means nothing.
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { CinematicDirector, DIRECTOR_STYLES, MAX_TRAVEL, shotCatalogue, LANDMARK_TRIPOD } =
  await import('../src/camera/Cinematic');
const { WORLD_PRESETS, setWorld, setTerrainSeed, terrainHeight } =
  await import('../src/world/Worlds');
const { CameraRig } = await import('../src/camera/CameraRig');
const { FlightModel, HORNET } = await import('../src/flight/FlightModel');
const { Controls, DEFAULT_SETTINGS } = await import('../src/flight/Controls');
const { Autopilot } = await import('../src/flight/Autopilot');
const { groundHeight, spawnPoint, fieldElevation } = await import('../src/world/Worlds');
const { airstrips } = await import('../src/world/Settlements');
const { citySites } = await import('../src/world/City');
type Tel = Parameters<InstanceType<typeof CinematicDirector>['update']>[3];

const realRandom = Math.random;
Math.random = (): number => 0.5;

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};
/** Within a tenth of a per cent — these are arithmetic, not simulations. */
const near = (a: number, b: number, tolerance = 0.001): boolean =>
  Math.abs(a - b) <= Math.abs(b) * tolerance + 1e-6;

const DT = 1 / 120;
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1e6);
// Straight and level on purpose: the sections below are arithmetic, and the
// director now watches bank, climb and g for cut beats. Spelling those out as
// "nothing happening" keeps every deterministic case deterministic.
const telemetry = { tas: 220, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
const ground = (): number => -Infinity;
const AIRCRAFT = new THREE.Vector3(0, 2000, 0);
const LEVEL = new THREE.Quaternion();

/** Run one forced shot to its end; report how long it was held and how far the camera went. */
function playOne(d: InstanceType<typeof CinematicDirector>, name: string): {
  seconds: number;
  travelled: number;
} {
  d.force(name);
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  if (d.shotName !== name) throw new Error(`could not force "${name}" — got "${d.shotName}"`);

  const start = camera.position.clone();
  let far = 0;
  let seconds = 0;
  for (let i = 0; i < 120 * 60; i++) {
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    if (d.shotName !== name) break;
    seconds += DT;
    far = Math.max(far, camera.position.distanceTo(start));
  }
  return { seconds, travelled: far };
}

// ---------------------------------------------------------------- hold
//
// A close shot is written to be held 3.0-4.2 s, so with the dice pinned to the
// middle it is 3.6 s. Everything below is measured against that.
console.log('HOLD — seconds a shot is held');
const BASE = 3.6;
for (const [label, hold, style, expected] of [
  ['as written', 1, 1, BASE],
  ['hold 0.5x', 0.5, 1, BASE * 0.5],
  ['hold 2x', 2, 1, BASE * 2],
  ['Calm', 1, 0, BASE * DIRECTOR_STYLES[0].hold],
  ['Kinetic', 1, 2, BASE * DIRECTOR_STYLES[2].hold],
  ['Kinetic + hold 2x', 2, 2, BASE * 2 * DIRECTOR_STYLES[2].hold],
] as [string, number, number, number][]) {
  const d = new CinematicDirector();
  d.setStyle(style);
  d.setTweak('wingtip', { azimuth: 0, height: 0, scale: 1, hold, travel: 1 });
  const { seconds } = playOne(d, 'wingtip');
  console.log(`  ${label.padEnd(18)} ${seconds.toFixed(2)} s  (want ${expected.toFixed(2)})`);
  // One frame of slop: the cut lands on the update that crosses the duration.
  if (Math.abs(seconds - expected) > DT * 2) {
    fail(`held ${seconds.toFixed(2)} s, not ${expected.toFixed(2)} s`);
  }
}

// -------------------------------------------------------------- travel
//
// Measured on a planted crane. Every shot that rides with the aircraft eases
// its offset — a first-order follow — and a follow chasing a target moving at
// v settles a constant v/k behind it, so the camera arrives short of the
// written end by an amount that depends on how fast the move was. That is
// correct behaviour and it makes a dolly a hopeless ruler. "crane pass" is
// locked, so its boom is applied straight to the world position with no easing
// anywhere: 120 m of boom means exactly 120 m of travel.
console.log('\nTRAVEL — metres the camera moves across one shot (planted crane, 120 m boom)');
const BOOM = 120;
for (const [label, travel, style, expected] of [
  ['still (0x)', 0, 1, 0],
  ['as written', 1, 1, BOOM],
  ['double', 2, 1, BOOM * 2],
  ['Calm', 1, 0, BOOM * DIRECTOR_STYLES[0].travel],
  ['Kinetic', 1, 2, BOOM * DIRECTOR_STYLES[2].travel],
] as [string, number, number, number][]) {
  const d = new CinematicDirector();
  d.setStyle(style);
  d.setTweak('crane pass', { azimuth: 0, height: 0, scale: 1, hold: 1, travel });
  const { travelled, seconds } = playOne(d, 'crane pass');
  console.log(`  ${label.padEnd(18)} ${travelled.toFixed(1)} m over ${seconds.toFixed(1)} s `
    + `(want ${expected.toFixed(1)} m)`);
  if (Math.abs(travelled - expected) > 0.6) {
    fail(`moved ${travelled.toFixed(1)} m, not ${expected.toFixed(1)} m`);
  }
}

// And on a real dolly, where the easing is in play: the absolute distance falls
// short of the written move by the follow's steady-state error, but doubling
// the travel still doubles what the camera does, because both the move and the
// error scale with it.
console.log('\n  …and on an eased dolly ("departure", written move '
  + `${Math.hypot(0, 60, 340).toFixed(0)} m)`);
const dolly: Record<string, number> = {};
for (const [label, travel] of [['as written', 1], ['double', 2], ['still', 0]] as [string, number][]) {
  const d = new CinematicDirector();
  d.setTweak('departure', { azimuth: 0, height: 0, scale: 1, hold: 1, travel });
  dolly[label] = playOne(d, 'departure').travelled;
  console.log(`    ${label.padEnd(16)} ${dolly[label].toFixed(1)} m`);
}
if (dolly.still > 1) fail(`at travel 0 the camera still moved ${dolly.still.toFixed(1)} m`);
if (!near(dolly.double / dolly['as written'], 2, 0.02)) {
  fail(`double travel gave ${(dolly.double / dolly['as written']).toFixed(2)}x, not 2x`);
}

// ------------------------------------------------------- replay and looping
//
// A pinned shot used to run its move once and then hold its last frame for as
// long as it was held, which is a photograph rather than a shot. Measured on
// the planted crane again: with nothing eased, the camera's height *is* the
// move, so the range it covers over a stretch of time says plainly whether
// anything is still happening.
console.log('\nLOOP — height the crane covers in the last 4 s of a 20 s hold');
for (const looping of [false, true]) {
  const d = new CinematicDirector();
  d.setLooping(looping);
  d.force('crane pass');
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  d.togglePin();
  for (let i = 0; i < 120 * 16; i++) d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < 120 * 4; i++) {
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    low = Math.min(low, camera.position.y);
    high = Math.max(high, camera.position.y);
  }
  console.log(`  loop ${looping ? 'on ' : 'off'}: ${(high - low).toFixed(1)} m`);
  if (looping && high - low < 60) fail(`a looping shot only covered ${(high - low).toFixed(1)} m`);
  if (!looping && high - low > 0.5) fail(`a held shot moved ${(high - low).toFixed(1)} m`);
}

console.log('\nREPLAY — a held shot that has finished, played again');
{
  const d = new CinematicDirector();
  d.setLooping(false);
  d.force('crane pass');
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  d.togglePin();
  for (let i = 0; i < 120 * 12; i++) d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  const finished = camera.position.y;
  d.replay();
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  const restarted = camera.position.y;
  let top = -Infinity;
  for (let i = 0; i < 120 * 8; i++) {
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    top = Math.max(top, camera.position.y);
  }
  console.log(`  finished at ${finished.toFixed(1)} m, restarted at ${restarted.toFixed(1)} m, `
    + `climbed back to ${top.toFixed(1)} m`);
  if (finished - restarted < 100) fail('replay did not take the move back to the start');
  if (Math.abs(top - finished) > 1) fail(`the replayed move ended at ${top.toFixed(1)}, not ${finished.toFixed(1)}`);
}

// A planted shot is anchored where the aircraft was when it was planted. Played
// again half a minute later, it has to re-anchor, or the boom runs in the piece
// of sky the aeroplane left.
console.log('\nREPLANT — a planted shot replayed after the aircraft has moved on');
{
  const d = new CinematicDirector();
  d.setLooping(false);
  d.force('crane pass');
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  d.togglePin();
  for (let i = 0; i < 120 * 12; i++) d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  const wasNear = camera.position.distanceTo(AIRCRAFT);

  const moved = AIRCRAFT.clone().add(new THREE.Vector3(9000, 0, -4000));
  for (let i = 0; i < 4; i++) d.update(DT, moved, LEVEL, telemetry, camera, ground);
  const stranded = camera.position.distanceTo(moved);
  d.replay();
  d.update(DT, moved, LEVEL, telemetry, camera, ground);
  const replanted = camera.position.distanceTo(moved);
  console.log(`  ${wasNear.toFixed(0)} m from the aircraft, ${stranded.toFixed(0)} m after it flew `
    + `9.8 km away, ${replanted.toFixed(0)} m once replayed`);
  if (replanted > wasNear + 1) fail(`replay left the camera ${replanted.toFixed(0)} m away`);
}

// ------------------------------------------- re-timing a shot that is pinned
//
// A pin holds a shot past its duration, so `elapsed` climbs for as long as it
// is held. The guard that stops a leftward drag ending the shot must not read
// that as "this shot is half a minute long", or the slider reads out a number
// nobody asked for and the sequence really waits through it on unpinning.
console.log('\nPINNED — dragging hold after holding a shot for 40 s');
{
  const d = new CinematicDirector();
  d.force('wingtip');
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  d.togglePin();
  for (let i = 0; i < 120 * 40; i++) d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  const held = d.shotSeconds;
  d.setHold(2);
  console.log(`  held ${held.toFixed(1)} s written; after hold 2x it is ${d.shotSeconds.toFixed(1)} s`);
  if (d.shotSeconds > BASE * 2 + 0.5) {
    fail(`the pinned shot stretched to ${d.shotSeconds.toFixed(1)} s, not ${(BASE * 2).toFixed(1)}`);
  }
  d.setHold(0.5);
  console.log(`  and after 0.5x, ${d.shotSeconds.toFixed(1)} s`);
  if (d.shotSeconds > BASE + 0.5) fail(`0.5x left it at ${d.shotSeconds.toFixed(1)} s`);
}

// ------------------------------------------------------- old saved files
//
// Saves written before hold and travel existed have neither. A missing
// multiplier read as `undefined` is NaN in the offset, which is a black screen.
console.log('\nOLD SAVES — a file with no hold or travel in it');
{
  const d = new CinematicDirector();
  d.loadTweaks([['wingtip', { azimuth: 0.4, height: 12, scale: 1.5 }]]);
  d.force('wingtip');
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  const t = d.tweak;
  console.log(`  loaded as hold ${t.hold}x, travel ${t.travel}x; `
    + `camera at ${camera.position.toArray().map((v) => v.toFixed(0)).join(', ')}`);
  if (t.hold !== 1 || t.travel !== 1) fail('missing multipliers did not default to 1');
  if (!camera.position.toArray().every(Number.isFinite)) fail('camera position is not finite');
  if (!near(t.scale, 1.5)) fail('the three older fields did not survive the load');
}

// ------------------------------------------------------------- the slots
console.log('\nSLOTS — save the shape, recall it on the number key');
{
  // The rig reads three things off the aircraft; nothing here needs a model.
  const jet = {
    root: { position: AIRCRAFT, quaternion: LEVEL },
    setCockpitVisible: () => undefined,
  } as unknown as Parameters<InstanceType<typeof CameraRig>['update']>[1];

  const rig = new CameraRig(camera, () => -Infinity);
  rig.setMode('director');
  rig.forceShot('canopy');
  rig.update(DT, jet, telemetry);
  rig.setShotHold(1.8);
  rig.setShotTravel(0.25);
  const saved = rig.storeShotSlot(2);
  const shape = { ...rig.shotTweak };

  // Move on, and change the shot that was saved, before recalling it.
  rig.forceShot('side profile');
  rig.update(DT, jet, telemetry);
  rig.setShotHold(0.6);
  rig.forceShot('canopy');
  rig.update(DT, jet, telemetry);
  rig.setShotHold(1);
  rig.setShotTravel(1);

  const recalled = rig.recallShotSlot(2);
  rig.update(DT, jet, telemetry);
  const now = rig.shotTweak;
  console.log(`  saved ${saved ? 'ok' : 'FAILED'}: ${shape.hold}x hold, ${shape.travel}x travel`);
  console.log(`  recalled "${recalled?.shot}" as ${now.hold}x hold, ${now.travel}x travel, `
    + `pinned ${rig.shotPinned}`);
  if (recalled?.shot !== 'canopy') fail(`slot 3 recalled "${recalled?.shot ?? 'nothing'}"`);
  if (!near(now.hold, shape.hold) || !near(now.travel, shape.travel)) {
    fail('the recalled shape is not the one that was saved');
  }
  if (!rig.shotPinned) fail('recalling a saved shot did not hold it');
  if (rig.recallShotSlot(5) !== null) fail('an empty slot recalled something');

  // A slot survives the round trip through storage.
  const wire = JSON.parse(JSON.stringify(rig.shotSlots)) as typeof rig.shotSlots;
  const fresh = new CameraRig(camera, () => -Infinity);
  fresh.loadShotSlots(wire);
  const back = fresh.shotSlots[2];
  console.log(`  through storage: "${back?.shot}" ${back?.tweak.hold}x / ${back?.tweak.travel}x`);
  if (back?.shot !== 'canopy' || !near(back.tweak.hold, shape.hold)) {
    fail('the slot did not survive being saved and loaded');
  }
}

// Every shot must still be reachable and finite with the knobs at their limits.
console.log(`\nLIMITS — every shot at 0x and ${MAX_TRAVEL}x travel, 0.4x and 2.5x hold`);
{
  let worst = 0;
  for (const shot of shotCatalogue()) {
    for (const [hold, travel] of [[0.4, 0], [2.5, MAX_TRAVEL]] as [number, number][]) {
      const d = new CinematicDirector();
      d.setTweak(shot.name, { azimuth: 0, height: 0, scale: 1, hold, travel });
      d.force(shot.name);
      for (let i = 0; i < 600; i++) {
        d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
        if (d.shotName !== shot.name) break;
      }
      if (!camera.position.toArray().every(Number.isFinite) || !Number.isFinite(camera.fov)) {
        fail(`"${shot.name}" at hold ${hold} travel ${travel} put the camera at a bad number`);
      }
      worst = Math.max(worst, camera.position.distanceTo(AIRCRAFT));
    }
  }
  console.log(`  furthest the camera ever got from the aircraft: ${worst.toFixed(0)} m`);
  if (worst > 4000) fail(`${worst.toFixed(0)} m is not a shot of an aeroplane`);
}

// ---------------------------------------------------------------- the reel
//
// A running order made of saved slots. The point of it is that it plays what
// you put in it, in the order you put it in, and keeps doing so — so that is
// what gets measured: the sequence of setups over several laps.
console.log('\nREEL — four saved shots, played in order');
{
  const rig = new CameraRig(camera, () => -Infinity);
  rig.setMode('director');
  const jet = {
    root: { position: AIRCRAFT, quaternion: LEVEL },
    setCockpitVisible: () => undefined,
  } as unknown as Parameters<InstanceType<typeof CameraRig>['update']>[1];

  // Save four setups into slots 1, 3, 5 and 9, each with its own shape.
  const wanted = ['wingtip', 'crane pass', 'into the sun', 'high astern'];
  const into = [0, 2, 4, 8];
  wanted.forEach((name, i) => {
    rig.forceShot(name);
    rig.update(DT, jet, telemetry);
    rig.setShotHold(1 + i * 0.25);
    rig.storeShotSlot(into[i]);
  });
  console.log(`  saved into slots ${into.map((i) => i + 1).join(', ')}: ${wanted.join(', ')}`);

  // Default order is the filled slots in slot order.
  console.log(`  default order: ${rig.reelOrder.map((i) => i + 1).join(' → ')}`);
  if (rig.reelOrder.join() !== into.join()) fail('the default order is not the filled slots in order');

  // Compose one: last, first, third, second.
  const order = [into[3], into[0], into[2], into[1]];
  rig.setReelOrder(order);
  const count = rig.playReel();
  console.log(`  playing ${count} setups in the order ${order.map((i) => i + 1).join(' → ')}`);

  const played: string[] = [];
  let last = '';
  for (let i = 0; i < 120 * 60 * 4 && played.length < 9; i++) {
    rig.update(DT, jet, telemetry);
    const now = rig.shotName ?? '';
    if (now !== last) { last = now; played.push(now); }
  }
  const expected = order.map((slot) => rig.shotSlots[slot]?.shot ?? '');
  console.log(`  played: ${played.join(' → ')}`);
  const wantedRun = [...expected, ...expected, ...expected].slice(0, played.length);
  if (played.join('|') !== wantedRun.join('|')) {
    fail(`the reel played ${played.join(' → ')}, not ${wantedRun.join(' → ')}`);
  }
  if (rig.reelPosition === '') fail('a playing reel reports no position');
  console.log(`  position readout while playing: ${rig.reelPosition}`);

  // The saved shape travels with the entry.
  rig.stopReel();
  console.log(`  stopped: reelPlaying = ${rig.reelPlaying}`);
  if (rig.reelPlaying) fail('the reel would not stop');

  // Choosing a shot by hand takes it off the air.
  rig.playReel();
  rig.stepShot(1);
  console.log(`  after stepping by hand: reelPlaying = ${rig.reelPlaying}`);
  if (rig.reelPlaying) fail('stepping by hand left the reel running');

  // Nine slots, not eight.
  console.log(`  slots available: ${rig.shotSlots.length}`);
  if (rig.shotSlots.length !== 9) fail(`there are ${rig.shotSlots.length} slots, not 9`);
}

// ------------------------------------------------------ the reserved shot
//
// "departure" is the aeroplane leaving. It reads as an ending, so it is kept
// out of the rotation and reached only when the takeoff asks for it.
console.log('\nRESERVED — 400 cuts of an ordinary sequence');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  const seen = new Map<string, number>();
  let last = '';
  for (let i = 0; i < 120 * 60 * 20; i++) {
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    if (d.shotName !== last) {
      last = d.shotName;
      seen.set(last, (seen.get(last) ?? 0) + 1);
    }
    if ([...seen.values()].reduce((a, b) => a + b, 0) >= 400) break;
  }
  const cuts = [...seen.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${cuts} cuts across ${seen.size} setups; "departure" appeared `
    + `${seen.get('departure') ?? 0} time(s)`);
  if ((seen.get('departure') ?? 0) > 0) fail('the reserved shot turned up in the rotation');
  if (seen.size < 20) fail(`only ${seen.size} setups were used — the pool is too narrow`);

  // …and the takeoff can still ask for it.
  const onRequest = new CinematicDirector();
  let found = false;
  for (let attempt = 0; attempt < 40 && !found; attempt++) {
    onRequest.request('takeoff');
    onRequest.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    if (onRequest.shotName === 'departure') found = true;
  }
  console.log(`  asked for by the takeoff: ${found ? 'yes' : 'never'}`);
  if (!found) fail('the takeoff could not reach the reserved shot');
}

// ------------------------------------------------- level with the aircraft
//
// The wide library used to look down at the aeroplane from every angle it had.
// These six sit at its own altitude, and "level" is a claim worth measuring:
// the offset is applied in the yaw frame, so it should hold whatever the
// attitude, and a shot that drifts thirty metres up over its run is a high
// shot with a level first frame.
const LEVEL_SHOTS = ['long lens', 'level astern', 'sun path', 'wing walk',
  'level orbit', 'level pass'];

console.log('\nHEIGHT ABOVE THE AIRCRAFT, by wide shot');
{
  const d = new CinematicDirector();

  /** Camera height relative to the aircraft, across a whole shot. */
  const run = (name: string, quat: THREE.Quaternion, floorAt = -Infinity): {
    lo: number; hi: number; dist: number; onScreen: number; clamped: boolean;
  } => {
    const floor = (): number => floorAt;
    d.force(name);
    d.update(DT, AIRCRAFT, quat, telemetry, camera, floor);
    let lo = Infinity;
    let hi = -Infinity;
    let dist = 0;
    let fov = 40;
    let clamped = false;
    for (let i = 0; i < 120 * 60; i++) {
      d.update(DT, AIRCRAFT, quat, telemetry, camera, floor);
      if (d.shotName !== name) break;
      const dy = camera.position.y - AIRCRAFT.y;
      lo = Math.min(lo, dy);
      hi = Math.max(hi, dy);
      dist = camera.position.distanceTo(AIRCRAFT);
      fov = camera.fov;
      if (floorAt > -Infinity && camera.position.y <= floorAt + 6.001) clamped = true;
    }
    const ang = 2 * Math.atan((17.85 / 2) / Math.max(dist, 1)) * (180 / Math.PI);
    return { lo, hi, dist, onScreen: (ang / fov) * 100, clamped };
  };

  for (const sh of shotCatalogue().filter((x) => x.scale === 'wide')) {
    const h = run(sh.name, LEVEL);
    const level = LEVEL_SHOTS.includes(sh.name);
    console.log(`  ${sh.name.padEnd(16)} ${h.lo.toFixed(0).padStart(5)} to `
      + `${h.hi.toFixed(0).padStart(5)} m   ${h.dist.toFixed(0).padStart(4)} m out   `
      + `${h.onScreen.toFixed(1).padStart(5)}% of frame${level ? '   <- level' : ''}`);
    if (level && (Math.abs(h.lo) > 8 || Math.abs(h.hi) > 8)) {
      fail(`${sh.name} is meant to be level but runs ${h.lo.toFixed(0)}..${h.hi.toFixed(0)} m`);
    }
  }

  // Level has to survive an attitude. The offset is rotated by yaw alone, so a
  // climbing or banking aeroplane must not carry the camera up with it.
  console.log('\n  and they stay level through a climb and a bank');
  const climbing = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(14 * (Math.PI / 180), 0, 0));
  const banked = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(0, 0.7, 42 * (Math.PI / 180)));
  for (const name of LEVEL_SHOTS) {
    const c = run(name, climbing);
    const b = run(name, banked);
    console.log(`  ${name.padEnd(16)} climbing ${c.lo.toFixed(0).padStart(4)}..`
      + `${c.hi.toFixed(0).padStart(4)} m   banked ${b.lo.toFixed(0).padStart(4)}..`
      + `${b.hi.toFixed(0).padStart(4)} m`);
    if (Math.abs(c.hi) > 10 || Math.abs(b.hi) > 10) {
      fail(`${name} is carried off level by the aircraft's attitude`);
    }
  }

  // The one real risk in a level shot: the director floors every camera six
  // metres above the ground, and a level shot has no headroom by definition.
  // Where the terrain comes up to the aircraft's altitude the floor lifts the
  // camera, and a lifted level shot is just another high shot. This is how much
  // room each one needs before that happens.
  console.log('\nGROUND CLEARANCE NEEDED, before the floor lifts the shot');
  for (const name of [...LEVEL_SHOTS, 'establishing', 'high astern']) {
    let needed = -1;
    for (let agl = 10; agl <= 400; agl += 10) {
      if (!run(name, LEVEL, AIRCRAFT.y - agl).clamped) {
        needed = agl;
        break;
      }
    }
    console.log(`  ${name.padEnd(16)} clear above `
      + `${needed < 0 ? '400+' : String(needed).padStart(3)} m AGL`);
    // The scenic flight cruises at 620 m above the ground, so anything under
    // that is safe on a tour. Beyond 400 m the shot would be lifted on most of
    // a low-level flight, which is the thing these exist not to be.
    if (needed < 0) fail(`${name} needs more than 400 m of ground clearance`);
  }
}

// ------------------------------------------------ level shots over real ground
//
// The flat-floor test above only asks how far the camera hangs below the
// aircraft, which for a level shot is nothing — so it always passes. The case
// that decides whether these shots work is terrain rising *beside* the flight
// path: a camera five hundred metres off the wing is over ground that may be
// nowhere near the ground under the aeroplane, and where that ground comes up
// the floor lifts the camera and the shot stops being level.
//
// So this flies each shot over the real worlds, at the height the scenic flight
// actually cruises at, and counts how much of it survives.
console.log('\nOVER REAL TERRAIN, at the scenic flight\'s 620 m AGL');
{
  const TOUR_AGL = 620;
  const d = new CinematicDirector();
  const spots: [number, number][] = [
    [0, -9000], [12_000, 4000], [-7000, 15_000], [21_000, -18_000], [-26_000, -6000],
  ];

  for (const name of ['ALPINE', 'KARST', 'HIMALAYA', 'LAGOON', 'GULF']) {
    const idx = WORLD_PRESETS.findIndex((w) => w.name === name);
    setWorld(idx);
    setTerrainSeed(20250817);
    const ground = (x: number, z: number): number => terrainHeight(x, z);

    let frames = 0;
    let clamped = 0;
    let worst = 0;
    for (const [x, z] of spots) {
      const here = new THREE.Vector3(x, terrainHeight(x, z) + TOUR_AGL, z);
      for (const shot of LEVEL_SHOTS) {
        d.force(shot);
        d.update(DT, here, LEVEL, telemetry, camera, ground);
        for (let i = 0; i < 120 * 60; i++) {
          d.update(DT, here, LEVEL, telemetry, camera, ground);
          if (d.shotName !== shot) break;
          frames++;
          const lift = camera.position.y - here.y;
          if (lift > 8) {
            clamped++;
            worst = Math.max(worst, lift);
          }
        }
      }
    }
    const pct = (clamped / Math.max(frames, 1)) * 100;
    console.log(`  ${name.padEnd(9)} ${pct.toFixed(1).padStart(5)}% of frames lifted`
      + `, worst ${worst.toFixed(0)} m above level`);
    // A quarter of the frames pushed off level would mean these read as high
    // shots more often than not in that world.
    if (pct > 25) fail(`${name}: ${pct.toFixed(0)}% of level frames are lifted off level`);
  }
}

// ------------------------------------------------------- the tuned shots
//
// Six shots were retuned by ratio — "2.5x the travel", "twice the length". Both
// halves of that need care.
//
// Travel is *path length*, not how far the camera ends up from where it began.
// For an orbiting shot those are wildly different things: halving a 135-degree
// sweep halves the arc but only shortens the chord by a third, because a chord
// goes as sin(theta/2). Measuring displacement said `level orbit` had been made
// six times longer when it had in fact been halved.
//
// The baselines are what these actually measured before the change, taken by
// running the previous specs — not recomputed from the numbers, which is how a
// golden value ends up agreeing with the bug it was meant to catch.
console.log('\nTUNED SHOTS, against what was asked for');
{
  // The reserved-shot section above unpins the dice on purpose — it needs four
  // hundred real cuts — and never puts them back. Durations are drawn from a
  // range, so measuring one here on live randomness reports a number somewhere
  // inside that range and calls it the answer: `orbit close` read x2.19 and
  // x2.00 on alternate runs, both from the same correct spec.
  Math.random = (): number => 0.5;
  const d = new CinematicDirector();

  /** Seconds held and metres of path, over one run of a shot. */
  const measure = (name: string): { seconds: number; path: number } => {
    d.force(name);
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    let seconds = 0;
    let path = 0;
    const last = camera.position.clone();
    for (let i = 0; i < 120 * 60; i++) {
      d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
      if (d.shotName !== name) break;
      seconds += DT;
      path += camera.position.distanceTo(last);
      last.copy(camera.position);
    }
    return { seconds, path };
  };

  const tuned: [string, 'travel' | 'length', number, number][] = [
    // shot, what changed, asked-for ratio, measured before the change
    ['wing walk', 'travel', 2.5, 15.5],
    ['level orbit', 'travel', 0.5, 549.5],
    ['wingtip', 'travel', 1.15, 7.6],
    ['canopy', 'travel', 1.8, 5.5],
    ['orbit close', 'length', 2, 3.6],
    ['rising arc', 'length', 1.25, 3.6],
  ];
  for (const [name, what, want, before] of tuned) {
    const m = measure(name);
    const now = what === 'travel' ? m.path : m.seconds;
    const ratio = now / before;
    const unit = what === 'travel' ? 'm' : 's';
    console.log(`  ${name.padEnd(12)} ${what.padEnd(6)} ${before.toFixed(1).padStart(6)} -> `
      + `${now.toFixed(1).padStart(6)} ${unit}   x${ratio.toFixed(2)}  (asked x${want})`);
    if (Math.abs(ratio - want) > Math.max(0.06, want * 0.06)) {
      fail(`${name} came out x${ratio.toFixed(2)}, not x${want}`);
    }
  }

  // And nothing may end up inside the aeroplane. It is 12.7 m across the wings
  // and 17.85 m long, so the airframe reaches 6.35 m to the side and about 8.9 m
  // fore and aft of the origin every shot is measured from. `canopy` asked for
  // 1.8x travel, and scaled from its far end it would have finished 3.4 m out.
  console.log('\n  closest the lens ever comes to the aircraft');
  let tightest = Infinity;
  let tightestAt = '';
  for (const sh of shotCatalogue()) {
    if (sh.locked) continue; // planted shots are flown past, not held off
    d.force(sh.name);
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    for (let i = 0; i < 120 * 60; i++) {
      d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
      if (d.shotName !== sh.name) break;
      const gap = camera.position.distanceTo(AIRCRAFT);
      if (gap < tightest) {
        tightest = gap;
        tightestAt = sh.name;
      }
    }
  }
  console.log(`  ${tightest.toFixed(1)} m, on "${tightestAt}"`);
  if (tightest < 7) {
    fail(`"${tightestAt}" puts the lens ${tightest.toFixed(1)} m out — inside the aircraft`);
  }
}

// -------------------------------------------------------- the default pace
//
// Standard, and nothing else: a fresh director opens on 1x hold and 1x travel,
// which is what both the cinematic view and the director show before anyone
// touches a slider.
console.log('\nDEFAULT PACE');
{
  const fresh = new CinematicDirector();
  Math.random = realRandom;
  const pace = fresh.pace;
  const standard = DIRECTOR_STYLES[1];
  console.log(`  hold x${pace.hold}, travel x${pace.travel}`
    + `  (Standard is x${standard.hold} / x${standard.travel})`);
  if (pace.hold !== standard.hold || pace.travel !== standard.travel) {
    fail('a fresh director does not open on Standard');
  }
}

// ------------------------------------------------------------- reversal
//
// A shot played backwards has to be the same shot run the other way, not a
// different shot that happens to start elsewhere: the path must be the same
// path, walked from the far end.
console.log('\nREVERSAL, the same move run the other way');
{
  Math.random = (): number => 0.5;

  /**
   * The camera's path through a shot, sampled at ten points.
   *
   * A fresh director each time, and for a reason: running a shot to its end
   * makes the sequencer cut, and a cut may flip which side of the line it is
   * working. Reusing one director compared a left-hand forward run against a
   * right-hand reversed one and called the mirror image a bug — 460 m of
   * "error" on a path that was in fact being retraced exactly.
   */
  const path = (name: string, back: boolean): THREE.Vector3[] => {
    const d = new CinematicDirector();
    d.setReverseAll(back);
    d.force(name);
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    const seen: THREE.Vector3[] = [];
    for (let i = 0; i < 120 * 60; i++) {
      d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
      if (d.shotName !== name) break;
      seen.push(camera.position.clone());
    }
    const out: THREE.Vector3[] = [];
    for (let k = 0; k <= 9; k++) out.push(seen[Math.floor((seen.length - 1) * (k / 9))]);
    return out;
  };

  for (const name of ['establishing', 'orbit close', 'wingtip', 'level orbit', 'crane pass']) {
    const ahead = path(name, false);
    const back = path(name, true);
    // Compared end to end: the reversed path read backwards should retrace the
    // forward one. Easing makes the sampling uneven, so this asks how far each
    // reversed sample is from the *nearest* point of the forward path.
    let worst = 0;
    for (const p of back) {
      let near = Infinity;
      for (const q of ahead) near = Math.min(near, p.distanceTo(q));
      worst = Math.max(worst, near);
    }
    const ends = ahead[0].distanceTo(back[9]) + ahead[9].distanceTo(back[0]);
    const span = ahead[0].distanceTo(ahead[9]) || 1;
    console.log(`  ${name.padEnd(13)} retraces to within ${worst.toFixed(1).padStart(5)} m`
      + `, ends swap to within ${ends.toFixed(1)} m of a ${span.toFixed(0)} m move`);
    // Generous on the path, tight on the ends. Ten samples of a 550 m arc are
    // 55 m apart, and the lag filter trails the target one way forwards and the
    // other way back, so the same curve is sampled at different points along it.
    // Where the shot *starts and finishes* has no such excuse.
    if (worst > Math.max(8, span * 0.22)) fail(`${name} reversed is not the same path`);
    if (ends > Math.max(6, span * 0.2)) fail(`${name} reversed does not start where it ended`);
  }
}

// --------------------------------------------------- continuity of movement
//
// The point of scoring both orientations: at a cut the camera should carry on
// swinging the way it already was. This runs long sequences and counts how
// often it does, against what the old sequencer managed — which, picking one
// orientation at random, could only ever be a coin toss.
console.log('\nCONTINUITY across cuts, over 600 cuts');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  let cuts = 0;
  let kept = 0;
  let judged = 0;
  const scales: string[] = [];
  const flourishes = new Map<string, number>();
  let lastName = '';
  let lastPos: THREE.Vector3 | null = null;
  let lastSwing = 0;

  // The aeroplane flies, which it must: a planted camera only sweeps because
  // the aircraft goes past it, and measuring continuity against a stationary
  // subject reported every fly-by as having no direction at all.
  const flying = AIRCRAFT.clone();
  for (let i = 0; i < 120 * 60 * 60 && cuts < 600; i++) {
    const before = camera.position.clone().sub(flying);
    flying.z -= telemetry.tas * DT;
    d.update(DT, flying, LEVEL, telemetry, camera, ground);
    if (d.shotName !== lastName) {
      // A cut. The swing of the shot just finished is measured from how the
      // camera actually moved, not from the spec — which is the only way to see
      // what reversal did.
      if (lastPos !== null) {
        // Bearings taken in the aircraft's own frame, which is the frame the
        // audience watches in — the subject stays put on screen and the camera
        // is what goes round it.
        const swing = Math.atan2(before.x, before.z)
          - Math.atan2(lastPos.x, lastPos.z);
        let d2 = swing;
        while (d2 > Math.PI) d2 -= Math.PI * 2;
        while (d2 < -Math.PI) d2 += Math.PI * 2;
        // Judged only between shots that actually swung. Most of the library
        // sweeps under ten degrees, and scoring those is scoring noise.
        const MATTERS = 0.52;
        if (Math.abs(d2) > MATTERS && Math.abs(lastSwing) > MATTERS) {
          judged++;
          if (Math.sign(d2) === Math.sign(lastSwing)) kept++;
        }
        if (Math.abs(d2) > MATTERS) lastSwing = d2;
      }
      lastName = d.shotName ?? '';
      const info = shotCatalogue().find((sh) => sh.name === lastName);
      if (info) scales.push(info.scale);
      // Read off the catalogue, not off a list written here: a hard-coded trio
      // kept counting only the original three long after there were nine, and
      // reported the punctuation as having got rarer when it had got broader.
      if (info?.flourish === true) {
        flourishes.set(lastName, (flourishes.get(lastName) ?? 0) + 1);
      }
      lastPos = camera.position.clone().sub(flying);
      cuts++;
    }
  }

  const rate = (kept / Math.max(judged, 1)) * 100;
  console.log(`  the camera keeps swinging the same way across `
    + `${rate.toFixed(0)}% of ${judged} judged cuts  (chance would be 50%)`);
  if (rate < 62) fail(`${rate.toFixed(0)}% continuity is no better than picking at random`);

  // The ladder: neighbouring shots should be a step apart, not a jump from wide
  // to close and back.
  const order = ['wide', 'medium', 'close'];
  let steps = 0;
  let jumps = 0;
  for (let i = 1; i < scales.length; i++) {
    const gap = Math.abs(order.indexOf(scales[i]) - order.indexOf(scales[i - 1]));
    if (gap === 1) steps++;
    else if (gap === 2) jumps++;
  }
  console.log(`  scale moves one step ${steps} times, jumps the middle ${jumps} times`);
  if (jumps > steps * 0.25) fail('the ladder skips the medium too often');

  const total = [...flourishes.values()].reduce((a, b) => a + b, 0);
  console.log(`  ${total} flourishes in ${cuts} cuts: `
    + `${[...flourishes].map(([n, c]) => `${n} x${c}`).join(', ') || 'none'}`);
  if (total === 0) fail('no flourishes were ever dealt');
  if (total > cuts * 0.2) fail('flourishes are no longer occasional');
  const known = shotCatalogue().filter((sh) => sh.flourish);
  const never = known.filter((sh) => !flourishes.has(sh.name)).map((sh) => sh.name);
  if (never.length > 0) console.log(`  never dealt: ${never.join(', ')}`);
  // `landmark plant` needs a landmark, and this harness offers none.
  const excusable = new Set(['landmark plant']);
  const missing = never.filter((n) => !excusable.has(n));
  if (missing.length > 0) fail(`never dealt: ${missing.join(', ')}`);
  if (flourishes.size < 4) fail('the punctuation is coming from too few setups');
}

// ------------------------------------------- the landmark flourish, in context
//
// It is the one flourish that needs the world to be offering something, so the
// sequence above — which offers nothing — is right to skip it. This gives it a
// city to frame against and checks that it then turns up.
console.log('\nTHE LANDMARK FLOURISH, given a landmark');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
    new THREE.Vector3(4000, 0, -6000), null, 2000);
  // Counted in cuts, not in distinct setups. This used to stop as soon as it
  // had seen forty different names, which was a fine proxy while the library
  // was small and became a coin toss once it passed fifty: the flourish is
  // dealt at most once every five cuts out of a pool of seven, so whether it
  // landed inside the first forty names was luck. The claim was never about
  // forty names anyway — it is that a landmark shot appears when there is a
  // landmark.
  let seen = 0;
  let last = '';
  let cuts = 0;
  const flying = AIRCRAFT.clone();
  for (let i = 0; i < 120 * 60 * 120 && cuts < 900; i++) {
    flying.z -= telemetry.tas * DT;
    d.update(DT, flying, LEVEL, telemetry, camera, ground);
    if (d.shotName !== last) {
      last = d.shotName ?? '';
      if (last === 'landmark plant') seen++;
      cuts++;
    }
  }
  console.log(`  landmark plant dealt x${seen} over ${cuts} cuts`);
  if (seen < 4) fail(`the landmark flourish appeared only ${seen} times given a landmark`);
}

// ------------------------------------------------ where the subject sits
//
// A framing claim, so it is measured in the frame: the aircraft is projected
// through the camera and reported as a fraction of the picture. Zero is dead
// centre, +1 is the top edge, -1 the bottom.
// ---------------------------------------------------------- the narrative four
//
// Four shots were added to give a sequence a beginning and a middle rather than
// only a set of angles, and three of them are gated: "the approach" needs a
// landmark to frame against, "ground witness" is punctuation dealt only at the
// turn of a run, and both of the others compete with fifty other shots for a
// slot. Being in the array is not the same as reaching the screen, so this
// counts what a real run actually deals.
console.log('\nTHE NARRATIVE SHOTS, dealt over 3000 cuts with a landmark');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
    new THREE.Vector3(4000, 0, -6000), null, 2000);
  const tally = new Map<string, number>();
  let last = '';
  let cuts = 0;
  const flying = AIRCRAFT.clone();
  for (let i = 0; i < 120 * 60 * 300 && cuts < 3000; i++) {
    flying.z -= telemetry.tas * DT;
    d.update(DT, flying, LEVEL, telemetry, camera, ground);
    if (d.shotName !== last) {
      last = d.shotName ?? '';
      tally.set(last, (tally.get(last) ?? 0) + 1);
      cuts++;
    }
  }
  for (const name of ['over the shoulder', 'the rest', 'the approach', 'ground witness']) {
    const n = tally.get(name) ?? 0;
    console.log(`  ${name.padEnd(18)} x${n}`);
    // A rate, not merely "more than none". Two of these four were structurally
    // incapable of winning a slot when they were added — not filtered out, just
    // permanently outscored — and "it appeared once" is the symptom of that
    // being half-fixed. Three thousand cuts so the floor is not noise.
    if (n < 12) fail(`${name} dealt only ${n} times in 3000 cuts — it is starved`);
  }
}

// ----------------------------------------- the narrative shots, over real hills
//
// Three of the four sit a long way from the aircraft and one of them is planted
// five hundred metres below it, which over real country means the ground clamp
// gets a say. A planted wide whose subject never crosses the frame is a dead
// shot, and a camera that ends up inside a hill is worse, so both are measured
// here against actual terrain rather than the flat plane used above.
console.log('\nTHE NARRATIVE SHOTS OVER REAL TERRAIN, at 620 m AGL');
{
  Math.random = (): number => 0.5;
  const TOUR_AGL = 620;
  const d = new CinematicDirector();
  const NAMES = ['over the shoulder', 'the rest', 'the approach', 'ground witness'];

  for (const world of ['ALPINE', 'KARST', 'LAGOON']) {
    setWorld(WORLD_PRESETS.findIndex((w) => w.name === world));
    setTerrainSeed(20250817);
    const ground = (x: number, z: number): number => terrainHeight(x, z);

    for (const name of NAMES) {
      // Flying, not parked. A planted camera only sweeps because the aeroplane
      // goes past it; measured against a stationary subject every one of these
      // would report as showing nothing at all.
      const flying = new THREE.Vector3(0, terrainHeight(0, -9000) + TOUR_AGL, -9000);
      d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
        new THREE.Vector3(4000, 0, -16_000), null, TOUR_AGL);
      d.force(name);
      d.update(DT, flying, LEVEL, telemetry, camera, ground);
      let frames = 0;
      let onScreen = 0;
      let clearance = Infinity;
      let bad = false;
      for (let i = 0; i < 120 * 60; i++) {
        flying.z -= telemetry.tas * DT;
        flying.y = terrainHeight(flying.x, flying.z) + TOUR_AGL;
        d.update(DT, flying, LEVEL, telemetry, camera, ground);
        if (d.shotName !== name) break;
        frames++;
        if (!Number.isFinite(camera.position.x) || !Number.isFinite(camera.position.y)
          || !Number.isFinite(camera.position.z)) bad = true;
        clearance = Math.min(clearance,
          camera.position.y - terrainHeight(camera.position.x, camera.position.z));
        camera.updateMatrixWorld(true);
        camera.updateProjectionMatrix();
        const ndc = flying.clone().project(camera);
        if (Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z < 1) onScreen++;
      }
      const share = (onScreen / Math.max(frames, 1)) * 100;
      console.log(`  ${world.padEnd(9)} ${name.padEnd(18)} ${share.toFixed(0).padStart(3)}% on screen`
        + `, clears the ground by ${clearance.toFixed(0)} m`);
      if (bad) fail(`${name} put the camera at a non-finite position over ${world}`);
      if (clearance < 0) fail(`${name} goes ${(-clearance).toFixed(0)} m into the ground over ${world}`);
      // The subject has to be in the picture for most of the shot. The planted
      // one is allowed to let the aeroplane leave at the end — that is what a
      // camera standing still does — so the bar is a majority, not all of it.
      if (share < 55) fail(`${name} shows the aircraft for only ${share.toFixed(0)}% of the shot over ${world}`);
    }
  }
}

// ------------------------------------------------- tripods, across the envelope
//
// A planted camera is placed by time now, not by distance: `pass` says where in
// the shot the aeroplane should reach it, and the metres follow from airspeed.
// The claim is that the pass lands in the same place whatever the speed, which
// is exactly what the fixed offsets could not do — measured, the same shots ran
// their pass anywhere from a third of the way in to never arriving at all.
//
// Measured at the along-track station rather than by 3-D distance: two of these
// booms move the camera while the shot plays, and the nearest point in space
// then drifts away from the moment the aeroplane actually goes past.
console.log('\nTRIPODS, where the pass lands at 150 / 300 / 450 kt');
{
  Math.random = (): number => 0.5;
  // The landmark tripod is left out, and not because it is awkward. `pass` is
  // the along-track station of a camera planted on the flight path, and these
  // are not planted on the flight path — their station is the landmark, and
  // when the aeroplane reaches it follows from where that is. Timing them
  // against a field they do not carry would be checking arithmetic nobody
  // does. What they should do instead is checked below, on its own terms.
  const locked = shotCatalogue().filter((sh) => sh.locked === true
    && sh.name !== LANDMARK_TRIPOD);
  for (const sh of locked) {
    const seen: number[] = [];
    for (const kt of [150, 300, 450]) {
      const tas = kt * 0.514444;
      const tel = { tas, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
      const d = new CinematicDirector();
      const flying = AIRCRAFT.clone();
      d.force(sh.name);
      d.update(DT, flying, LEVEL, tel, camera, ground);
      let frames = 0;
      let at = -1;
      for (let i = 0; i < 120 * 60; i++) {
        flying.z -= tas * DT;
        d.update(DT, flying, LEVEL, tel, camera, ground);
        if (d.shotName !== sh.name) break;
        frames++;
        // The aeroplane flies down -Z, so it has gone past the camera's station
        // the moment its own Z drops below the camera's.
        if (at < 0 && flying.z < camera.position.z) at = frames;
      }
      seen.push(at < 0 ? Number.NaN : at / Math.max(frames, 1));
    }
    console.log(`  ${sh.name.padEnd(16)} ${seen.map((v) => (Number.isNaN(v) ? ' never' : v.toFixed(2))).join('   ')}`);
    if (seen.some((v) => Number.isNaN(v))) {
      fail(`${sh.name} never gets its pass at some airspeed`);
    }
    const spread = Math.max(...seen) - Math.min(...seen);
    // The floor on how far up the track a tripod may be planted deliberately
    // bites at low speed on the closest of these, so this is not zero.
    if (spread > 0.08) {
      fail(`${sh.name} passes anywhere from ${Math.min(...seen).toFixed(2)} to `
        + `${Math.max(...seen).toFixed(2)} — still speed-dependent`);
    }
  }
}

// --------------------------------------------------- cutting on the aeroplane
//
// The clock is still the cap, but inside the last fifth of a shot a manoeuvre
// starting or ending can bring the cut forward. Whether that is worth anything
// depends entirely on how often a beat actually turns up, and that is a
// property of the autopilot rather than of the camera — so this flies the real
// tour, with the real flight model, and counts.
console.log('\nCUTTING ON THE AEROPLANE, over a real scenic tour');
{
  Math.random = realRandom;
  const w = WORLD_PRESETS.findIndex((pr) => pr.name === 'ALPINE');
  setWorld(w);
  setTerrainSeed(20250817);

  const model = new FlightModel(HORNET, groundHeight);
  model.windPhase = 17.5; // the same gusts every run
  const controls = new Controls(HORNET);
  Object.assign(controls.settings, DEFAULT_SETTINGS);
  const spawn = spawnPoint();
  model.reset(new THREE.Vector3(spawn.x, 0, spawn.z), spawn.heading);
  const deg = 180 / Math.PI;
  const home = {
    x: 0, z: 0, dirX: Math.sin(spawn.heading / deg), dirZ: -Math.cos(spawn.heading / deg),
    elevation: fieldElevation(), name: 'HOME FIELD',
  };
  const ap = new Autopilot();
  ap.engage({
    ground: groundHeight,
    terrain: terrainHeight,
    strips: [home, ...airstrips().map((st, i) => ({ ...st, name: `STRIP ${i + 1}` }))],
    cities: citySites(),
    villages: [],
  } as Parameters<InstanceType<typeof Autopilot>['engage']>[0],
  model.position.x, model.position.z, true);

  const d = new CinematicDirector();
  const terrainAt = (x: number, z: number): number => terrainHeight(x, z);
  let cuts = 0;
  let airborne = 0;
  let held = 0;
  let last = '';
  let since = 0;
  for (let i = 0; i < 120 * 60 * 14 && ap.active && ap.phase !== 'done'; i++) {
    ap.update(DT, model.telemetry, model.position.x, model.position.z);
    controls.gearDown = ap.wantsGearDown(model.telemetry);
    controls.update(DT, ap.stick, model.telemetry);
    model.step(DT, controls);
    const tel = model.telemetry;
    d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(), null, null, tel.agl);
    d.update(DT, model.position, model.orientation, tel, camera, terrainAt);
    if (tel.onGround) continue;
    airborne += DT;
    since += DT;
    if (d.shotName !== last) {
      last = d.shotName ?? '';
      if (cuts > 0) held += since;
      since = 0;
      cuts++;
    }
  }
  const onBeat = d.beatCuts;
  const share = (onBeat / Math.max(cuts, 1)) * 100;
  console.log(`  ${(airborne / 60).toFixed(1)} min airborne, ${cuts} cuts, `
    + `mean shot ${(held / Math.max(cuts - 1, 1)).toFixed(1)} s`);
  console.log(`  ${onBeat} of them brought forward by a manoeuvre  (${share.toFixed(0)}%)`);
  // Often enough to be felt, rare enough to stay an accent. Both ends matter:
  // at nothing the feature is inert, and much past a quarter the pace control
  // stops being the thing that sets the pace.
  if (share < 4) fail(`only ${share.toFixed(0)}% of cuts landed on a beat — the window is too tight`);
  if (share > 30) fail(`${share.toFixed(0)}% of cuts were pulled early — the clock no longer sets the pace`);
}

console.log('\nSUBJECT ON SCREEN, by shot (0 = centre, -1 = bottom edge)');
{
  Math.random = (): number => 0.5;
  const d = new CinematicDirector();
  camera.aspect = 16 / 9;

  const framing = (name: string): { lo: number; hi: number } => {
    d.force(name);
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 120 * 60; i++) {
      d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
      if (d.shotName !== name) break;
      camera.updateMatrixWorld(true);
      camera.updateProjectionMatrix();
      const ndc = AIRCRAFT.clone().project(camera);
      lo = Math.min(lo, ndc.y);
      hi = Math.max(hi, ndc.y);
    }
    return { lo, hi };
  };

  for (const name of ['bird\u2019s eye', 'establishing', 'high astern', 'level astern',
    'long lens', 'over the shoulder', 'the rest']) {
    const f = framing(name);
    console.log(`  ${name.padEnd(16)} ${f.lo.toFixed(2).padStart(6)} to ${f.hi.toFixed(2).padStart(6)}`);
    // Nothing is worth framing if it is not in the picture.
    if (f.lo < -1 || f.hi > 1) {
      fail(`${name} puts the aircraft off screen (${f.lo.toFixed(2)}..${f.hi.toFixed(2)})`);
    }
    if (name === 'over the shoulder') {
      // The whole shot is "the aeroplane low, the country it is flying into
      // above it". Too high and it is just another chase; off the bottom and
      // there is no aeroplane in the shot at all. The 420 m lead was arrived at
      // by measuring this, not by drawing the triangle.
      if (f.hi > -0.15) fail(`${name} rides too high (${f.hi.toFixed(2)}) — it is a chase shot`);
      if (f.lo < -0.85) fail(`${name} pushes the aircraft off the bottom (${f.lo.toFixed(2)})`);
    }
    if (name === 'bird\u2019s eye') {
      // Looking straight down there is no "space to move into" to leave: from
      // overhead a big lead just shoves the subject at the edge of the picture.
      if (Math.min(Math.abs(f.lo), Math.abs(f.hi)) > 0.45 || f.hi < -0.45 || f.lo > 0.45) {
        fail(`${name} keeps the aircraft ${f.lo.toFixed(2)}..${f.hi.toFixed(2)} — not near centre`);
      }
    }
  }
}

// ---------------------------------------------------------- landmark tripods
//
// These put the camera *at* a thing in the world instead of on the flight
// path, which is a compositional claim and not a timing one: the landmark has
// to end up between the lens and the aeroplane, or the shot is a picture of a
// tower with the aircraft somewhere behind the camera. That is the failure the
// geometry makes easy — stand the camera on the near side and everything still
// runs, points somewhere plausible, and shows nothing — so it is what this
// measures, at every kind of landmark there is.
console.log('\nTHE LANDMARK TRIPOD, at each kind of landmark');
  console.log('  kind         setup            camera→mark  in line  mark fills  jet size');
{
  Math.random = realRandom;
  const KINDS = ['lighthouse', 'mast', 'castle', 'monastery', 'powerplant',
    'turbine', 'observatory', 'solar'];
  /** What each kind actually stands, metres, at the scale they are drawn. */
  const HEIGHT: Record<string, number> = {
    lighthouse: 130, mast: 444, castle: 99, monastery: 133,
    powerplant: 221, turbine: 400, observatory: 141, solar: 18,
  };
  /** And how far each one spreads. A powerplant is 630 m across. */
  const RADIUS: Record<string, number> = {
    lighthouse: 55, mast: 64, castle: 99, monastery: 129,
    powerplant: 302, turbine: 132, observatory: 148, solar: 302,
  };
  /**
   * How much of the frame each setup is written to give the landmark, as a
   * fraction of the frame's larger dimension.
   *
   * Not one range for all of them, because they do not all want the same
   * thing. The sentinel, the battlement and the rack are shots *of* a landmark
   * and have to fit it in; the stack pass and the turbine wash put the camera
   * among one on purpose — a cooling tower running off the top of frame is the
   * shot, not a mistake. What is common to all five is the aeroplane, and that
   * is checked the same way for every one.
   */
  const FILL: Record<string, [number, number]> = {
    'the sentinel': [0.30, 0.80],
    'the battlement': [0.22, 0.70],
    'landmark rack': [0.30, 0.85],
    'stack pass': [0.45, 1.50],
    'turbine wash': [0.30, 1.30],
  };
  /**
   * Setups that work at anything, and so may legitimately turn up anywhere.
   *
   * The exclusivity test below says a setup written for one landmark must
   * never appear at another. The general one is the exception by definition,
   * and without naming it here the test would fail every kind at once.
   */
  const GENERAL = new Set(['landmark rack']);
  /** The setup each kind of landmark is supposed to attract. */
  const FITTED: Record<string, string> = {
    lighthouse: 'the sentinel', mast: 'the sentinel',
    castle: 'the battlement', monastery: 'the battlement',
    observatory: 'the battlement',
    powerplant: 'stack pass', turbine: 'turbine wash',
    // Nothing is written for a solar farm: it is flat, and the setups that
    // exist are all about height. The general one carries it.
    solar: 'landmark rack',
  };
  const tas = 300 * 0.514444;
  /** The aeroplane, nose to tail. */
  const HORNET_LENGTH = 17.1;
  const tel = { tas, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
  const sun = new THREE.Vector3(0.3, 0.5, 0.8).normalize();

  for (const kind of KINDS) {
    const d = new CinematicDirector();
    // Down low. The camera stands at the landmark, so the aircraft's height is
    // its distance from the lens at the closest point — the rest of this file
    // flies at 2000 m, and from there these shots are of a tower with a fly on
    // it. Which is the gate the director now applies, and this is the altitude
    // it applies it below.
    const flying = new THREE.Vector3(0, 260, 0);
    // Ahead and a little off to one side — inside the window a tripod is
    // offered at, so this is testing the shot rather than the gate.
    // Real drawn heights, measured off the geometry. These shots size their
    // standoff by the landmark, so testing them all at one height would test
    // the arithmetic and none of the composition — and it is exactly the
    // spread between a castle and a mast that broke the first version.
    const mark = {
      x: 240, y: 0, z: flying.z - tas * 5 * 0.5,
      height: HEIGHT[kind], radius: RADIUS[kind], kind,
    };
    d.setContext(sun, null, mark, 260);
    if (!d.force(LANDMARK_TRIPOD)) {
      fail(`no landmark setup was offered at a ${kind}`);
      continue;
    }
    d.update(DT, flying, LEVEL, tel, camera, ground);
    const setup = d.shotName;
    const shotFov = camera.fov;

    const toMark = Math.hypot(camera.position.x - mark.x, camera.position.z - mark.z);
    // Is the landmark on the way to the aeroplane, or behind the camera?
    const a = new THREE.Vector3(mark.x - camera.position.x, 0, mark.z - camera.position.z);
    const b = new THREE.Vector3(flying.x - camera.position.x, 0, flying.z - camera.position.z);
    const inLine = a.normalize().dot(b.normalize());

    let closest = Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      flying.z -= tas * DT;
      d.setContext(sun, null, mark, 260);
      d.update(DT, flying, LEVEL, tel, camera, ground);
      if (d.shotName !== setup) break;
      closest = Math.min(closest, camera.position.distanceTo(flying));
    }

    // Measured as angles rather than as metres, and that is the point.
    //
    // A first version of this asserted a standoff in metres, which was a rule
    // about distance dressed up as a rule about pictures: 635 m from a mast
    // failed it and 205 m from a lighthouse passed, and the two frames are
    // near enough identical — each fills about a third of the height with the
    // landmark, which is what the standoff was chosen to do. What these shots
    // promise is a composition, so the composition is what gets measured.
    const deg = 180 / Math.PI;
    // Both dimensions, against both dimensions of the frame — a landmark can
    // swamp a shot sideways while measuring modestly in height, which is
    // exactly how a castle 200 m across passed a height-only test with the
    // frame full of wall.
    const fovH = 2 * Math.atan(Math.tan((shotFov / 2) / deg) * 1.6) * deg;
    const fill = Math.max(
      2 * Math.atan((mark.height / 2) / toMark) * deg / shotFov,
      2 * Math.atan(mark.radius / toMark) * deg / fovH,
    );
    const jetAngle = 2 * Math.atan((HORNET_LENGTH / 2) / closest) * deg;
    console.log(`  ${kind.padEnd(12)} ${setup.padEnd(16)} ${toMark.toFixed(0).padStart(7)} m ${inLine.toFixed(2).padStart(8)} ${(fill * 100).toFixed(0).padStart(9)}% ${jetAngle.toFixed(2).padStart(11)}\u00b0`);

    // A foreground element, not a detail on the horizon — and not a wall
    // either. Only the lower bound was checked at first, which passed a castle
    // filling 39\u00b0 of a 40\u00b0 frame: the keep covered the picture and
    // the aeroplane was somewhere behind it. Both ends matter.
    const want = FILL[setup] ?? [0.25, 0.9];
    if (fill < want[0]) {
      fail(`${setup} gives the ${kind} only ${(fill * 100).toFixed(0)}% of frame — it is scenery, not the subject`);
    }
    if (fill > want[1]) {
      fail(`${setup} fills ${(fill * 100).toFixed(0)}% of frame with ${kind} — nothing else is in shot`);
    }
    // The landmark between lens and subject: the whole point of the setup.
    if (inLine < 0.55) fail(`${setup} puts the ${kind} out of line (${inLine.toFixed(2)}) — nothing is framed`);
    // And the aeroplane has to arrive at a size you can see it at.
    if (jetAngle < 0.7) fail(`${setup} never shows the aircraft bigger than ${jetAngle.toFixed(2)}\u00b0`);

    // And it has to be choosing, not just picking something that happens to
    // work. Over enough presses the setup written for this landmark must turn
    // up, and one written for a different landmark must never turn up at all —
    // a wind farm shot at a lighthouse is the failure the whole `anchorKind`
    // idea exists to prevent, and it would look merely odd rather than broken.
    const drawn = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const p = new CinematicDirector();
      p.setContext(sun, null, mark, 260);
      p.force(LANDMARK_TRIPOD);
      p.update(DT, new THREE.Vector3(0, 260, 0), LEVEL, tel, camera, ground);
      drawn.add(p.shotName);
    }
    const fitted = FITTED[kind];
    if (!drawn.has(fitted)) fail(`${fitted} never came up at a ${kind} in 60 presses`);
    for (const other of Object.entries(FITTED)) {
      if (other[0] !== kind && other[1] !== fitted && !GENERAL.has(other[1])
        && drawn.has(other[1])) {
        fail(`${other[1]} came up at a ${kind} — it is written for a ${other[0]}`);
      }
    }
  }
  Math.random = (): number => 0.5;
}

console.log(failures === 0 ? '\nDIRECTOR KNOBS DO WHAT THEY SAY' : `\n${failures} PROBLEM(S)`);
