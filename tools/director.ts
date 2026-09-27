/**
 * Check what the director's knobs actually do to the camera, and that the
 * library frames a 1917 scout rather than the jet it was first written for.
 *
 * Hold and travel are multipliers buried in an easing curve, which is exactly
 * the kind of thing that looks right in a screenshot and is out by a factor of
 * two. So this drives the director at the physics rate and measures the
 * quantities the sliders claim to set: how many seconds a shot is held, and
 * how far the camera moves while it is.
 *
 * Self-contained on purpose: the terrain and the flying here are synthetic, so
 * the camera is tested against the camera's claims and not against whatever
 * state the world or the flight model happens to be in.
 *
 * `Math.random` is pinned to 0.5 wherever a duration is measured. Shot
 * durations are drawn from a range and the shot choice is a random pick from a
 * pool; without pinning, a measured duration means nothing.
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
const { CameraRig } = await import('../src/camera/CameraRig');
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

/** A scout at a brisk cruise, m/s. */
const CRUISE = 50;
/** The reference airframe, across the wings. */
const SPAN = 8.5;
/** Nearest a carried camera may come to the CG — half the span and a metre. */
const GAP = 5.2;
/** The floor the director keeps above the ground. */
const FLOOR = 3;

const DT = 1 / 120;
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1e6);
// Straight and level on purpose: the sections below are arithmetic, and the
// director watches bank, climb and g for cut beats. Spelling those out as
// "nothing happening" keeps every deterministic case deterministic.
const telemetry = { tas: CRUISE, agl: 2000, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
const ground = (): number => -Infinity;
const AIRCRAFT = new THREE.Vector3(0, 2000, 0);
const LEVEL = new THREE.Quaternion();

/**
 * Synthetic country: rolling fields, a line of hills, and one steep ridge.
 * Three "worlds" by amplitude, so a shot that works over Flanders and fails
 * over the Vosges shows up.
 */
const WORLDS: [string, number][] = [['FLANDERS', 25], ['ARTOIS', 90], ['VOSGES', 420]];
function terrain(amplitude: number): (x: number, z: number) => number {
  return (x: number, z: number): number => amplitude * (
    0.55 * Math.sin(x / 820 + 0.3) * Math.cos(z / 640 - 1.1)
    + 0.3 * Math.sin((x + z) / 310 + 2.0)
    + 0.15 * Math.cos((x - 2 * z) / 150)
    + 0.6 * Math.max(0, 1 - Math.abs(Math.sin(z / 1900 + x / 5200)) * 3)
  );
}

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

/** A stand-in aircraft for the rig: it reads the root's pose, the eye and the cockpit switch. */
function stub(position: THREE.Vector3, quaternion: THREE.Quaternion, scale?: number):
Parameters<InstanceType<typeof CameraRig>['update']>[1] {
  return {
    root: { position, quaternion },
    eyePoint: new THREE.Vector3(0, 1.0, 0.5),
    cameraScale: scale,
    setCockpitVisible: () => undefined,
  } as unknown as Parameters<InstanceType<typeof CameraRig>['update']>[1];
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
// its offset, which makes a dolly a hopeless ruler. "crane pass" is locked, so
// its boom is applied straight to the world position with no easing anywhere.
const BOOM = 56;
console.log(`\nTRAVEL — metres the camera moves across one shot (planted crane, ${BOOM} m boom)`);
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
  if (Math.abs(travelled - expected) > 0.4) {
    fail(`moved ${travelled.toFixed(1)} m, not ${expected.toFixed(1)} m`);
  }
}

// And on a real dolly, where the easing is in play: doubling the travel still
// doubles what the camera does, because both the move and the follow's error
// scale with it.
console.log('\n  …and on an eased dolly ("departure", written move '
  + `${Math.hypot(0, 28, 159).toFixed(0)} m)`);
const dolly: Record<string, number> = {};
for (const [label, travel] of [['as written', 1], ['double', 2], ['still', 0]] as [string, number][]) {
  const d = new CinematicDirector();
  d.setTweak('departure', { azimuth: 0, height: 0, scale: 1, hold: 1, travel });
  dolly[label] = playOne(d, 'departure').travelled;
  console.log(`    ${label.padEnd(16)} ${dolly[label].toFixed(1)} m`);
}
if (dolly.still > 0.5) fail(`at travel 0 the camera still moved ${dolly.still.toFixed(1)} m`);
if (!near(dolly.double / dolly['as written'], 2, 0.02)) {
  fail(`double travel gave ${(dolly.double / dolly['as written']).toFixed(2)}x, not 2x`);
}

// ------------------------------------------------------- replay and looping
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
  if (looping && high - low < BOOM * 0.45) fail(`a looping shot only covered ${(high - low).toFixed(1)} m`);
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
  if (finished - restarted < BOOM * 0.8) fail('replay did not take the move back to the start');
  if (Math.abs(top - finished) > 1) fail(`the replayed move ended at ${top.toFixed(1)}, not ${finished.toFixed(1)}`);
}

// A planted shot is anchored where the aircraft was when it was planted. Played
// again later, it has to re-anchor, or the boom runs in the piece of sky the
// aeroplane left.
console.log('\nREPLANT — a planted shot replayed after the aircraft has moved on');
{
  const d = new CinematicDirector();
  d.setLooping(false);
  d.force('crane pass');
  d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  d.togglePin();
  for (let i = 0; i < 120 * 12; i++) d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground);
  const wasNear = camera.position.distanceTo(AIRCRAFT);

  const moved = AIRCRAFT.clone().add(new THREE.Vector3(4000, 0, -2000));
  for (let i = 0; i < 4; i++) d.update(DT, moved, LEVEL, telemetry, camera, ground);
  const stranded = camera.position.distanceTo(moved);
  d.replay();
  d.update(DT, moved, LEVEL, telemetry, camera, ground);
  const replanted = camera.position.distanceTo(moved);
  console.log(`  ${wasNear.toFixed(0)} m from the aircraft, ${stranded.toFixed(0)} m after it flew `
    + `4.5 km away, ${replanted.toFixed(0)} m once replayed`);
  if (replanted > wasNear + 1) fail(`replay left the camera ${replanted.toFixed(0)} m away`);
}

// ------------------------------------------- re-timing a shot that is pinned
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
console.log('\nOLD SAVES — a file with no hold or travel in it');
{
  const d = new CinematicDirector();
  d.loadTweaks([['wingtip', { azimuth: 0.4, height: 6, scale: 1.5 }]]);
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
  const scout = stub(AIRCRAFT, LEVEL);
  const rig = new CameraRig(camera, () => -Infinity);
  rig.setMode('director');
  rig.forceShot('open cockpit');
  rig.update(DT, scout, telemetry);
  rig.setShotHold(1.8);
  rig.setShotTravel(0.25);
  const saved = rig.storeShotSlot(2);
  const shape = { ...rig.shotTweak };

  // Move on, and change the shot that was saved, before recalling it.
  rig.forceShot('side profile');
  rig.update(DT, scout, telemetry);
  rig.setShotHold(0.6);
  rig.forceShot('open cockpit');
  rig.update(DT, scout, telemetry);
  rig.setShotHold(1);
  rig.setShotTravel(1);

  const recalled = rig.recallShotSlot(2);
  rig.update(DT, scout, telemetry);
  const now = rig.shotTweak;
  console.log(`  saved ${saved ? 'ok' : 'FAILED'}: ${shape.hold}x hold, ${shape.travel}x travel`);
  console.log(`  recalled "${recalled?.shot}" as ${now.hold}x hold, ${now.travel}x travel, `
    + `pinned ${rig.shotPinned}`);
  if (recalled?.shot !== 'open cockpit') fail(`slot 3 recalled "${recalled?.shot ?? 'nothing'}"`);
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
  if (back?.shot !== 'open cockpit' || !near(back.tweak.hold, shape.hold)) {
    fail('the slot did not survive being saved and loaded');
  }
}

// Every shot must still be reachable and finite with the knobs at their limits.
console.log(`\nLIMITS — every shot at 0x and ${MAX_TRAVEL}x travel, 0.4x and 2.5x hold`);
{
  let worst = 0;
  let worstAt = '';
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
      const gap = camera.position.distanceTo(AIRCRAFT);
      if (gap > worst) {
        worst = gap;
        worstAt = shot.name;
      }
    }
  }
  console.log(`  furthest the camera ever got from the aircraft: ${worst.toFixed(0)} m, on "${worstAt}"`);
  if (worst > 2000) fail(`${worst.toFixed(0)} m is not a shot of an aeroplane`);
}

// ---------------------------------------------------------------- the reel
console.log('\nREEL — four saved shots, played in order');
{
  const rig = new CameraRig(camera, () => -Infinity);
  rig.setMode('director');
  const scout = stub(AIRCRAFT, LEVEL);

  // Save four setups into slots 1, 3, 5 and 9, each with its own shape.
  const wanted = ['wingtip', 'crane pass', 'into the sun', 'high astern'];
  const into = [0, 2, 4, 8];
  wanted.forEach((name, i) => {
    rig.forceShot(name);
    rig.update(DT, scout, telemetry);
    rig.setShotHold(1 + i * 0.25);
    rig.storeShotSlot(into[i]);
  });
  console.log(`  saved into slots ${into.map((i) => i + 1).join(', ')}: ${wanted.join(', ')}`);

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
    rig.update(DT, scout, telemetry);
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

  rig.stopReel();
  console.log(`  stopped: reelPlaying = ${rig.reelPlaying}`);
  if (rig.reelPlaying) fail('the reel would not stop');

  // Choosing a shot by hand takes it off the air.
  rig.playReel();
  rig.stepShot(1);
  console.log(`  after stepping by hand: reelPlaying = ${rig.reelPlaying}`);
  if (rig.reelPlaying) fail('stepping by hand left the reel running');

  console.log(`  slots available: ${rig.shotSlots.length}`);
  if (rig.shotSlots.length !== 9) fail(`there are ${rig.shotSlots.length} slots, not 9`);
}

// ------------------------------------------------------ the reserved shot
console.log('\nRESERVED — 400 cuts of an ordinary sequence');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  const seen = new Map<string, number>();
  let last = '';
  for (let i = 0; i < 120 * 60 * 40; i++) {
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
  // No enemy anywhere: nothing that needs one may be dealt.
  const combatOnly = shotCatalogue().filter((sh) => sh.needsTarget).map((sh) => sh.name);
  const leaked = combatOnly.filter((n) => seen.has(n));
  if (leaked.length > 0) fail(`combat setups dealt with no enemy about: ${leaked.join(', ')}`);

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
const LEVEL_SHOTS = ['long lens', 'level astern', 'sun path', 'wing walk',
  'level orbit', 'level pass'];

console.log('\nHEIGHT ABOVE THE AIRCRAFT, by wide shot');
{
  Math.random = (): number => 0.5;
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
      if (floorAt > -Infinity && camera.position.y <= floorAt + FLOOR + 0.001) clamped = true;
    }
    const ang = 2 * Math.atan((SPAN / 2) / Math.max(dist, 1)) * (180 / Math.PI);
    return { lo, hi, dist, onScreen: (ang / fov) * 100, clamped };
  };

  for (const sh of shotCatalogue().filter((x) => x.scale === 'wide' && !x.needsTarget
    && x.name !== LANDMARK_TRIPOD)) {
    const h = run(sh.name, LEVEL);
    const level = LEVEL_SHOTS.includes(sh.name);
    console.log(`  ${sh.name.padEnd(16)} ${h.lo.toFixed(0).padStart(5)} to `
      + `${h.hi.toFixed(0).padStart(5)} m   ${h.dist.toFixed(0).padStart(4)} m out   `
      + `${h.onScreen.toFixed(1).padStart(5)}% of frame${level ? '   <- level' : ''}`);
    if (level && (Math.abs(h.lo) > 4 || Math.abs(h.hi) > 4)) {
      fail(`${sh.name} is meant to be level but runs ${h.lo.toFixed(0)}..${h.hi.toFixed(0)} m`);
    }
    // A wide shot of a scout that shows less than a per cent of frame is a
    // shot of the sky; the landmark ones (framed on something else) excepted.
    if (!sh.locked && sh.framing === null && h.onScreen < 1.5) {
      fail(`${sh.name} leaves the aircraft ${h.onScreen.toFixed(1)}% of the frame`);
    }
  }

  // Level has to survive an attitude. The offset is rotated by yaw alone, so a
  // climbing or banking aeroplane must not carry the camera up with it.
  console.log('\n  and they stay level through a climb and a bank');
  const climbing = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(14 * (Math.PI / 180), 0, 0));
  const banked = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(0, 0.7, 60 * (Math.PI / 180)));
  for (const name of LEVEL_SHOTS) {
    const c = run(name, climbing);
    const b = run(name, banked);
    console.log(`  ${name.padEnd(16)} climbing ${c.lo.toFixed(0).padStart(4)}..`
      + `${c.hi.toFixed(0).padStart(4)} m   banked ${b.lo.toFixed(0).padStart(4)}..`
      + `${b.hi.toFixed(0).padStart(4)} m`);
    if (Math.abs(c.hi) > 5 || Math.abs(b.hi) > 5) {
      fail(`${name} is carried off level by the aircraft's attitude`);
    }
  }

  // The director floors every camera above the ground, and a level shot has no
  // headroom by definition. This is how much room each one needs.
  console.log('\nGROUND CLEARANCE NEEDED, before the floor lifts the shot');
  for (const name of [...LEVEL_SHOTS, 'establishing', 'high astern']) {
    let needed = -1;
    for (let agl = 5; agl <= 200; agl += 5) {
      if (!run(name, LEVEL, AIRCRAFT.y - agl).clamped) {
        needed = agl;
        break;
      }
    }
    console.log(`  ${name.padEnd(16)} clear above `
      + `${needed < 0 ? '200+' : String(needed).padStart(3)} m AGL`);
    // Scouts fight and tour a few hundred metres up; a shot that needs more
    // than two hundred would be lifted on most low flying.
    if (needed < 0) fail(`${name} needs more than 200 m of ground clearance`);
  }
}

// ------------------------------------------------ level shots over real ground
//
// The flat-floor test above only asks how far the camera hangs below the
// aircraft. The case that decides whether these shots work is terrain rising
// *beside* the flight path, so this flies each shot over hills, at the height
// a scenic flight cruises at, and counts how much of it survives.
console.log('\nOVER HILLS, at 150 m AGL — a low patrol');
{
  const TOUR_AGL = 150;
  const d = new CinematicDirector();
  const spots: [number, number][] = [
    [0, -3000], [4000, 1500], [-2500, 5000], [7000, -6000], [-8000, -2000],
  ];

  for (const [name, amp] of WORLDS) {
    const groundAt = terrain(amp);
    let frames = 0;
    let clamped = 0;
    let worst = 0;
    for (const [x, z] of spots) {
      const here = new THREE.Vector3(x, groundAt(x, z) + TOUR_AGL, z);
      for (const shot of LEVEL_SHOTS) {
        d.force(shot);
        d.update(DT, here, LEVEL, telemetry, camera, groundAt);
        for (let i = 0; i < 120 * 60; i++) {
          d.update(DT, here, LEVEL, telemetry, camera, groundAt);
          if (d.shotName !== shot) break;
          frames++;
          const lift = camera.position.y - here.y;
          if (lift > 4) {
            clamped++;
            worst = Math.max(worst, lift);
          }
        }
      }
    }
    const pct = (clamped / Math.max(frames, 1)) * 100;
    console.log(`  ${name.padEnd(9)} ${pct.toFixed(1).padStart(5)}% of frames lifted`
      + `, worst ${worst.toFixed(0)} m above level`);
    if (pct > 25) fail(`${name}: ${pct.toFixed(0)}% of level frames are lifted off level`);
  }
}

// ------------------------------------------------ the scout, and bigger ones
//
// Every framing distance is written for a scout and multiplied by the
// subject's scale, so a Gotha is framed as a Camel is. Measured on shots of
// each kind: a carried dolly, a sun shot, a planted tripod's miss.
console.log('\nSCALE — the same shots on a scout and on a bomber 2.5x its size');
{
  Math.random = (): number => 0.5;
  const at = (name: string, scale: number): number => {
    const d = new CinematicDirector();
    d.force(name);
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground, { scale });
    for (let i = 0; i < 120; i++) d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground, { scale });
    return camera.position.distanceTo(AIRCRAFT);
  };
  for (const name of ['side profile', 'wingtip', 'tail chase', 'into the sun', 'establishing']) {
    const one = at(name, 1);
    const big = at(name, 2.5);
    console.log(`  ${name.padEnd(14)} ${one.toFixed(1).padStart(6)} m -> ${big.toFixed(1).padStart(6)} m`
      + `   x${(big / one).toFixed(2)}`);
    if (Math.abs(big / one - 2.5) > 0.05) fail(`${name} scales x${(big / one).toFixed(2)}, not x2.5`);
  }
  // A tripod's miss — how far off the track it stands — scales; how far up the
  // track does not, because that is set by the airspeed and the timing.
  const miss = (scale: number): number => {
    const d = new CinematicDirector();
    d.force('whip pass');
    d.update(DT, AIRCRAFT, LEVEL, telemetry, camera, ground, { scale });
    return Math.abs(camera.position.x - AIRCRAFT.x);
  };
  const m1 = miss(1);
  const m2 = miss(2.5);
  console.log(`  whip pass miss ${m1.toFixed(1)} m -> ${m2.toFixed(1)} m`);
  if (Math.abs(m2 / m1 - 2.5) > 0.05) fail(`a tripod's miss scales x${(m2 / m1).toFixed(2)}`);
}

// ------------------------------------------------------- nothing inside
//
// The airframe reaches 4.25 m to the side, 3.5 m aft and a little over three
// ahead of the CG, so a carried camera must stay 5.2 m out; the bolted-on ones
// were placed by hand and are checked against the parts they sit beside.
console.log('\nCLOSEST the lens ever comes to the aircraft, carried shots');
{
  Math.random = (): number => 0.5;
  const d = new CinematicDirector();
  let tightest = Infinity;
  let tightestAt = '';
  for (const sh of shotCatalogue()) {
    if (sh.locked || sh.mounted) continue; // planted shots are flown past, not held off
    for (const reversed of [false, true]) {
      d.setReverseAll(reversed);
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
  }
  d.setReverseAll(false);
  console.log(`  ${tightest.toFixed(1)} m, on "${tightestAt}"`);
  if (tightest < GAP - 0.05) {
    fail(`"${tightestAt}" puts the lens ${tightest.toFixed(1)} m out — inside the aircraft`);
  }

  console.log('\n  and the on-board ones, in the body frame');
  const inv = new THREE.Quaternion();
  const pitched = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.8, -0.9, 'YXZ'));
  for (const sh of shotCatalogue().filter((x) => x.mounted)) {
    const e = new THREE.Vector3();
    let worstProp = Infinity;
    let fromEye = 0;
    d.force(sh.name);
    d.update(DT, AIRCRAFT, pitched, telemetry, camera, ground);
    for (let i = 0; i < 120 * 60; i++) {
      d.update(DT, AIRCRAFT, pitched, telemetry, camera, ground);
      if (d.shotName !== sh.name) break;
      e.copy(camera.position).sub(AIRCRAFT).applyQuaternion(inv.copy(pitched).invert());
      fromEye = Math.max(fromEye, e.distanceTo(new THREE.Vector3(0, 1, 0.5)));
      // Clear of the propeller disc: 1.3 m round the thrust line, 3.1 m ahead.
      if (e.z < -2.6 && e.z > -3.6) worstProp = Math.min(worstProp, Math.hypot(e.x, e.y));
    }
    console.log(`  ${sh.name.padEnd(18)} at ${e.toArray().map((v) => v.toFixed(2)).join(', ')}`
      + `  (≤ ${fromEye.toFixed(2)} m from the eye)`);
    if (worstProp < 1.45) fail(`${sh.name} passes through the propeller disc`);
    if (sh.name !== 'prop close-up' && fromEye > 1.3) fail(`${sh.name} wandered ${fromEye.toFixed(2)} m from the eye`);
  }
}

// -------------------------------------------------------- the default pace
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
console.log('\nREVERSAL, the same move run the other way');
{
  Math.random = (): number => 0.5;

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
    let worst = 0;
    for (const p of back) {
      let nearest = Infinity;
      for (const q of ahead) nearest = Math.min(nearest, p.distanceTo(q));
      worst = Math.max(worst, nearest);
    }
    const ends = ahead[0].distanceTo(back[9]) + ahead[9].distanceTo(back[0]);
    const span = ahead[0].distanceTo(ahead[9]) || 1;
    console.log(`  ${name.padEnd(13)} retraces to within ${worst.toFixed(1).padStart(5)} m`
      + `, ends swap to within ${ends.toFixed(1)} m of a ${span.toFixed(0)} m move`);
    if (worst > Math.max(3, span * 0.22)) fail(`${name} reversed is not the same path`);
    if (ends > Math.max(2.5, span * 0.2)) fail(`${name} reversed does not start where it ended`);
  }
}

// --------------------------------------------------- continuity of movement
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

  const flying = AIRCRAFT.clone();
  for (let i = 0; i < 120 * 60 * 60 && cuts < 600; i++) {
    const before = camera.position.clone().sub(flying);
    flying.z -= telemetry.tas * DT;
    d.update(DT, flying, LEVEL, telemetry, camera, ground);
    if (d.shotName !== lastName) {
      if (lastPos !== null) {
        const swing = Math.atan2(before.x, before.z)
          - Math.atan2(lastPos.x, lastPos.z);
        let d2 = swing;
        while (d2 > Math.PI) d2 -= Math.PI * 2;
        while (d2 < -Math.PI) d2 += Math.PI * 2;
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
console.log('\nTHE LANDMARK FLOURISH, given a landmark');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
    new THREE.Vector3(2000, 0, -3000), null, 2000);
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

// ---------------------------------------------------------- the narrative four
console.log('\nTHE NARRATIVE SHOTS, dealt over 3000 cuts with a landmark');
{
  Math.random = realRandom;
  const d = new CinematicDirector();
  d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
    new THREE.Vector3(2000, 0, -3000), null, 2000);
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
  for (const name of ['over the shoulder', 'the rest', 'the approach', 'ground witness',
    'pilot’s shoulder', 'prop close-up']) {
    const n = tally.get(name) ?? 0;
    console.log(`  ${name.padEnd(18)} x${n}`);
    if (n < 12) fail(`${name} dealt only ${n} times in 3000 cuts — it is starved`);
  }
}

// ----------------------------------------- the narrative shots, over hills
console.log('\nTHE NARRATIVE SHOTS OVER HILLS, at 300 m AGL');
{
  Math.random = (): number => 0.5;
  const TOUR_AGL = 300;
  const d = new CinematicDirector();
  const NAMES = ['over the shoulder', 'the rest', 'the approach', 'ground witness'];

  for (const [world, amp] of WORLDS) {
    const groundAt = terrain(amp);
    for (const name of NAMES) {
      const flying = new THREE.Vector3(0, groundAt(0, -3000) + TOUR_AGL, -3000);
      d.setContext(new THREE.Vector3(0.3, 0.5, 0.8).normalize(),
        new THREE.Vector3(2000, 0, -8000), null, TOUR_AGL);
      d.force(name);
      d.update(DT, flying, LEVEL, telemetry, camera, groundAt);
      let frames = 0;
      let onScreen = 0;
      let clearance = Infinity;
      let bad = false;
      for (let i = 0; i < 120 * 60; i++) {
        flying.z -= telemetry.tas * DT;
        flying.y = groundAt(flying.x, flying.z) + TOUR_AGL;
        d.update(DT, flying, LEVEL, telemetry, camera, groundAt);
        if (d.shotName !== name) break;
        frames++;
        if (!Number.isFinite(camera.position.x) || !Number.isFinite(camera.position.y)
          || !Number.isFinite(camera.position.z)) bad = true;
        clearance = Math.min(clearance,
          camera.position.y - groundAt(camera.position.x, camera.position.z));
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
      if (share < 55) fail(`${name} shows the aircraft for only ${share.toFixed(0)}% of the shot over ${world}`);
    }
  }
}

// ------------------------------------------------- tripods, across the envelope
//
// A planted camera is placed by time, not by distance: `pass` says where in
// the shot the aeroplane should reach it, and the metres follow from airspeed.
// The claim is that the pass lands in the same place whatever the speed —
// from a scout climbing out at thirty metres a second to one diving at seventy.
console.log('\nTRIPODS, where the pass lands at 30 / 50 / 70 m/s');
{
  Math.random = (): number => 0.5;
  const locked = shotCatalogue().filter((sh) => sh.locked === true
    && sh.name !== LANDMARK_TRIPOD);
  for (const sh of locked) {
    const seen: number[] = [];
    for (const tas of [30, 50, 70]) {
      const tel = { tas, agl: 2000, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
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
        if (at < 0 && flying.z < camera.position.z) at = frames;
      }
      seen.push(at < 0 ? Number.NaN : at / Math.max(frames, 1));
    }
    console.log(`  ${sh.name.padEnd(16)} ${seen.map((v) => (Number.isNaN(v) ? ' never' : v.toFixed(2))).join('   ')}`);
    if (seen.some((v) => Number.isNaN(v))) {
      fail(`${sh.name} never gets its pass at some airspeed`);
    }
    const spread = Math.max(...seen) - Math.min(...seen);
    if (spread > 0.08) {
      fail(`${sh.name} passes anywhere from ${Math.min(...seen).toFixed(2)} to `
        + `${Math.max(...seen).toFixed(2)} — still speed-dependent`);
    }
  }
}

// --------------------------------------------------- cutting on the aeroplane
//
// The clock is still the cap, but inside the last stretch of a shot a
// manoeuvre starting or ending can bring the cut forward. Whether that is worth
// anything depends on how often a beat actually turns up — so this flies a
// scripted patrol with a dogfight in the middle of it, the way a scout is
// actually flown, and counts.
console.log('\nCUTTING ON THE AEROPLANE, over a patrol and a dogfight');
{
  Math.random = realRandom;
  // Seconds, bank (deg), climb (m/s), g — held, and eased between.
  const PATROL: [number, number, number, number][] = [
    [14, 0, 0, 1], [7, 30, 0, 1.15], [10, 0, 0, 1], [6, 0, 4, 1.05], [12, 0, 0, 1],
    [8, -35, 0, 1.2], [9, 0, -3, 1], [16, 0, 0, 1], [5, 25, 1, 1.1], [12, 0, 0, 1],
  ];
  const FIGHT: [number, number, number, number][] = [
    [5, 70, 0, 3.2], [3, 20, 8, 1.6], [4, -75, -2, 3.8], [3, 0, -12, 0.8], [6, 65, 3, 3.0],
    [2, 0, 10, 1.4], [5, -80, 0, 4.2], [4, 40, -6, 1.8], [3, 0, 0, 1],
  ];
  const script = [...PATROL, ...FIGHT, ...FIGHT, ...PATROL, ...FIGHT, ...PATROL];
  const d = new CinematicDirector();
  let cuts = 0;
  let last = '';
  let seconds = 0;
  const tel = { tas: CRUISE, agl: 400, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
  const pos = AIRCRAFT.clone();
  const quat = new THREE.Quaternion();
  let heading = 0;
  for (const [len, bank, climb, g] of script) {
    for (let i = 0; i < len * 120; i++) {
      const k = 1 - Math.exp(-3 * DT);
      tel.bank = (tel.bank ?? 0) + (bank * (Math.PI / 180) - (tel.bank ?? 0)) * k;
      tel.verticalSpeed = (tel.verticalSpeed ?? 0) + (climb - (tel.verticalSpeed ?? 0)) * k;
      tel.loadFactor = (tel.loadFactor ?? 1) + (g - (tel.loadFactor ?? 1)) * k;
      heading += Math.tan(tel.bank ?? 0) * 9.81 / CRUISE * DT;
      pos.x -= Math.sin(heading) * CRUISE * DT;
      pos.z -= Math.cos(heading) * CRUISE * DT;
      quat.setFromEuler(new THREE.Euler(0, heading, tel.bank ?? 0, 'YXZ'));
      d.update(DT, pos, quat, tel, camera, ground);
      seconds += DT;
      if (d.shotName !== last) {
        last = d.shotName;
        cuts++;
      }
    }
  }
  const onBeat = d.beatCuts;
  const share = (onBeat / Math.max(cuts, 1)) * 100;
  console.log(`  ${(seconds / 60).toFixed(1)} min flown, ${cuts} cuts, `
    + `mean shot ${(seconds / Math.max(cuts, 1)).toFixed(1)} s`);
  console.log(`  ${onBeat} of them brought forward by a manoeuvre  (${share.toFixed(0)}%)`);
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

  for (const name of ['bird’s eye', 'establishing', 'high astern', 'level astern',
    'long lens', 'over the shoulder', 'the rest', 'wingtip', 'open cockpit', 'tail chase',
    'nose chase', 'underside', 'prop close-up']) {
    const f = framing(name);
    console.log(`  ${name.padEnd(18)} ${f.lo.toFixed(2).padStart(6)} to ${f.hi.toFixed(2).padStart(6)}`);
    if (f.lo < -1 || f.hi > 1) {
      fail(`${name} puts the aircraft off screen (${f.lo.toFixed(2)}..${f.hi.toFixed(2)})`);
    }
    if (name === 'over the shoulder') {
      // The aeroplane low, the country it is flying into above it.
      if (f.hi > -0.15) fail(`${name} rides too high (${f.hi.toFixed(2)}) — it is a chase shot`);
      if (f.lo < -0.85) fail(`${name} pushes the aircraft off the bottom (${f.lo.toFixed(2)})`);
    }
    if (name === 'bird’s eye') {
      if (Math.min(Math.abs(f.lo), Math.abs(f.hi)) > 0.45 || f.hi < -0.45 || f.lo > 0.45) {
        fail(`${name} keeps the aircraft ${f.lo.toFixed(2)}..${f.hi.toFixed(2)} — not near centre`);
      }
    }
  }
}

// ---------------------------------------------------------- landmark tripods
//
// These put the camera *at* a thing in the world instead of on the flight
// path, which is a compositional claim: the landmark has to end up between the
// lens and the aeroplane, filling a sensible share of the frame, and the
// aeroplane has to come past at a size you can see. Measured at the kinds of
// thing the Western Front has — a church, a castle, a fort, a ruined village, a
// mill — at the sizes they are drawn.
console.log('\nTHE LANDMARK TRIPOD, at each kind of landmark');
console.log('  kind         setup            camera→mark  in line  mark fills  scout size');
{
  Math.random = realRandom;
  /** What each kind stands, metres, and how far it spreads. */
  const HEIGHT: Record<string, number> = {
    church: 42, castle: 32, fort: 14, village: 11, ruin: 9, windmill: 18, abbey: 30, bridge: 9,
  };
  const RADIUS: Record<string, number> = {
    church: 14, castle: 38, fort: 70, village: 110, ruin: 45, windmill: 7, abbey: 36, bridge: 40,
  };
  const KINDS = Object.keys(HEIGHT);
  const FILL: Record<string, [number, number]> = {
    'the sentinel': [0.30, 0.80],
    'the battlement': [0.22, 0.70],
    'landmark rack': [0.30, 0.85],
    'ruin pass': [0.45, 1.50],
    'mill sails': [0.30, 1.30],
  };
  const GENERAL = new Set(['landmark rack']);
  const FITTED: Record<string, string> = {
    church: 'the sentinel',
    castle: 'the battlement', fort: 'the battlement', abbey: 'the battlement',
    village: 'ruin pass', ruin: 'ruin pass',
    windmill: 'mill sails',
    // Nothing is written for a bridge; the general setup carries it.
    bridge: 'landmark rack',
  };
  const tas = CRUISE;
  const AGL = 120;
  const tel = { tas, agl: AGL, bank: 0, verticalSpeed: 0, loadFactor: 1 } as Tel;
  const sun = new THREE.Vector3(0.3, 0.5, 0.8).normalize();

  for (const kind of KINDS) {
    const d = new CinematicDirector();
    const flying = new THREE.Vector3(0, AGL, 0);
    const mark = {
      x: 110, y: 0, z: flying.z - tas * 5 * 0.5,
      height: HEIGHT[kind], radius: RADIUS[kind], kind,
    };
    d.setContext(sun, null, mark, AGL);
    if (!d.force(LANDMARK_TRIPOD)) {
      fail(`no landmark setup was offered at a ${kind}`);
      continue;
    }
    d.update(DT, flying, LEVEL, tel, camera, ground);
    const setup = d.shotName;
    const shotFov = camera.fov;

    const toMark = Math.hypot(camera.position.x - mark.x, camera.position.z - mark.z);
    const a = new THREE.Vector3(mark.x - camera.position.x, 0, mark.z - camera.position.z);
    const b = new THREE.Vector3(flying.x - camera.position.x, 0, flying.z - camera.position.z);
    const inLine = a.normalize().dot(b.normalize());

    let closest = Infinity;
    for (let i = 0; i < 60 * 30; i++) {
      flying.z -= tas * DT;
      d.setContext(sun, null, mark, AGL);
      d.update(DT, flying, LEVEL, tel, camera, ground);
      if (d.shotName !== setup) break;
      closest = Math.min(closest, camera.position.distanceTo(flying));
    }

    const deg = 180 / Math.PI;
    const fovH = 2 * Math.atan(Math.tan((shotFov / 2) / deg) * 1.6) * deg;
    const fill = Math.max(
      2 * Math.atan((mark.height / 2) / toMark) * deg / shotFov,
      2 * Math.atan(mark.radius / toMark) * deg / fovH,
    );
    const scoutAngle = 2 * Math.atan((SPAN / 2) / closest) * deg;
    console.log(`  ${kind.padEnd(12)} ${setup.padEnd(16)} ${toMark.toFixed(0).padStart(7)} m ${inLine.toFixed(2).padStart(8)} ${(fill * 100).toFixed(0).padStart(9)}% ${scoutAngle.toFixed(2).padStart(11)}°`);

    const want = FILL[setup] ?? [0.25, 0.9];
    if (fill < want[0]) {
      fail(`${setup} gives the ${kind} only ${(fill * 100).toFixed(0)}% of frame — it is scenery, not the subject`);
    }
    if (fill > want[1]) {
      fail(`${setup} fills ${(fill * 100).toFixed(0)}% of frame with ${kind} — nothing else is in shot`);
    }
    if (inLine < 0.55) fail(`${setup} puts the ${kind} out of line (${inLine.toFixed(2)}) — nothing is framed`);
    if (scoutAngle < 1.2) fail(`${setup} never shows the aircraft bigger than ${scoutAngle.toFixed(2)}°`);

    const drawn = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const p = new CinematicDirector();
      p.setContext(sun, null, mark, AGL);
      p.force(LANDMARK_TRIPOD);
      p.update(DT, new THREE.Vector3(0, AGL, 0), LEVEL, tel, camera, ground);
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
