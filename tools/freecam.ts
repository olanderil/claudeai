/**
 * Check that the free camera's two locks are two different things.
 *
 * They were not, for a long time, and the way they failed is the reason this
 * exists: both locks kept the camera glued to the aircraft's *position*, and
 * differed only in bearing, and only mid-turn. In level flight — which is most
 * flight — they produced the same picture. A check that only yawed the aircraft
 * on the spot passed that happily, so this flies the aeroplane instead, which
 * is what the pilot does.
 *
 * The claim now: aircraft-locked travels with the aeroplane and holds it at a
 * fixed distance; world-locked stands still and lets it go past.
 *
 * Also checks the reframe toggle against the shift-drag it stands in for —
 * two routes to one behaviour, which is the kind of pair that silently drifts.
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { CameraRig } = await import('../src/camera/CameraRig');
type Rig = InstanceType<typeof CameraRig>;

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

/** The closest a fly-by ever lets the aircraft pass — mirrors `MIN_MISS` in the rig. */
const MIN_MISS = 6;
/** A scout at a brisk cruise, m/s. */
const SPEED = 50;

const DT = 1 / 120;
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1e6);
const POS = new THREE.Vector3(0, 2000, 0);
const quat = new THREE.Quaternion();
const aircraft = { root: { position: POS, quaternion: quat }, eyePoint: new THREE.Vector3(0, 1, 0.5),
  setCockpitVisible: () => undefined } as unknown as Parameters<Rig['update']>[1];
const tel = { tas: SPEED, agl: 2000 } as Parameters<Rig['update']>[2];

/** Ground height for the case in hand: bottomless by default, flat when asked. */
let ground: (x: number, z: number) => number = () => -Infinity;

function makeRig(worldLocked: boolean): Rig {
  const rig = new CameraRig(camera, (x, z) => ground(x, z));
  rig.setMode('free');
  rig.setFreeLock(worldLocked);
  POS.set(0, 2000, 0);
  quat.identity();
  // Settle first: the yaw damping and the spin decay both need a moment, and a
  // measurement taken during that is measuring the filter, not the lock.
  for (let i = 0; i < 120 * 6; i++) rig.update(DT, aircraft, tel);
  return rig;
}

// ------------------------------------------------------------------ the lock
//
// Straight and level at a scout's cruise, which is the case the old implementation got
// wrong: nothing turns, so a bearing-only difference shows nothing at all.
console.log(`THE TWO LOCKS, flying straight and level at ${SPEED} m/s`);
{
  const track = (worldLocked: boolean): { start: number; after: number; max: number } => {
    const rig = makeRig(worldLocked);
    const start = camera.position.distanceTo(POS);
    let max = start;
    for (let i = 0; i < 120 * 8; i++) {
      POS.z -= SPEED * DT;
      rig.update(DT, aircraft, tel);
      max = Math.max(max, camera.position.distanceTo(POS));
    }
    return { start, after: camera.position.distanceTo(POS), max };
  };

  const air = track(false);
  console.log(`  aircraft-locked  ${air.start.toFixed(1)} m -> ${air.after.toFixed(1)} m `
    + `(furthest ${air.max.toFixed(0)} m)`);
  if (Math.abs(air.after - air.start) > 1) {
    fail(`aircraft-locked drifted to ${air.after.toFixed(1)} m — it should travel with the aircraft`);
  }

  const world = track(true);
  console.log(`  world-locked     ${world.start.toFixed(1)} m -> ${world.after.toFixed(1)} m `
    + `(furthest ${world.max.toFixed(0)} m)`);
  // It must let the aircraft go — a long way, not a few metres of lag.
  if (world.max < 120) {
    fail(`world-locked only let the aircraft reach ${world.max.toFixed(0)} m — it is still following`);
  }
  if (world.max <= air.max * 4) fail('the two locks still produce nearly the same shot');
}

console.log('\n  and the world lock takes fresh station once the aircraft is gone');
{
  const rig = makeRig(true);
  const stations: number[] = [];
  let last = camera.position.clone();
  for (let i = 0; i < 120 * 40; i++) {
    POS.z -= SPEED * DT;
    rig.update(DT, aircraft, tel);
    // A plant is the only way this camera ever moves.
    if (camera.position.distanceTo(last) > 1) stations.push(i / 120);
    last = camera.position.clone();
  }
  console.log(`  ${stations.length} re-plants over 40 s at ${SPEED} m/s`);
  const each = 40 / Math.max(stations.length, 1);
  console.log(`  about ${each.toFixed(1)} s a shot`);
  if (stations.length < 2) fail('the shot never renews — it ends as a dot on the horizon');
  // Faster than about one every two seconds and the re-plant stops reading as a
  // cut between shots and starts reading as the camera juddering.
  if (each < 2) fail(`a fresh station every ${each.toFixed(1)} s reads as a stutter, not as cuts`);
}

// The render loop calls `moveFreeCamera` on every frame, gesture or no gesture,
// so the check has to as well — driving the rig more politely than the game
// does is how a camera that re-plants every frame passes as a planted one.
console.log('\n  and an empty mouse gesture every frame does not unplant it');
{
  const rig = makeRig(true);
  const planted = camera.position.clone();
  for (let i = 0; i < 120 * 3; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
  }
  const moved = camera.position.distanceTo(planted);
  const gap = camera.position.distanceTo(POS);
  console.log(`  camera moved ${moved.toFixed(2)} m; the aircraft is ${gap.toFixed(0)} m away`);
  if (moved > 1) fail(`an empty gesture moved the planted camera ${moved.toFixed(1)} m`);
  if (gap < 40) fail('the camera followed the aircraft despite being planted');
}

console.log('\n  and a real gesture does take fresh station');
{
  const rig = makeRig(true);
  for (let i = 0; i < 120; i++) { POS.z -= SPEED * DT; rig.update(DT, aircraft, tel); }
  const before = camera.position.clone();
  rig.moveFreeCamera(40, 0, 0, false);
  rig.update(DT, aircraft, tel);
  const moved = camera.position.distanceTo(before);
  console.log(`  dragging moved it ${moved.toFixed(1)} m`);
  if (moved < 1) fail('dragging a planted camera did nothing');
}

// The shape of the shot: in, past, away. A camera planted where the aircraft
// already is only ever gives the last of those.
console.log('\n  and the shot is a whip — the aircraft comes in, passes, and goes');
{
  const rig = makeRig(true);
  const seen: number[] = [];
  for (let i = 0; i < 120 * 8; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
    seen.push(camera.position.distanceTo(POS));
  }
  const closest = Math.min(...seen);
  const at = seen.indexOf(closest);
  console.log(`  ${seen[0].toFixed(0)} m in  ->  ${closest.toFixed(0)} m at `
    + `${(at / 120).toFixed(1)} s  ->  ${seen[seen.length - 1].toFixed(0)} m away`);
  if (at === 0) fail('the aircraft never approaches — the camera is planted behind it');
  if (at === seen.length - 1) fail('the aircraft never gets past the camera');
  if (seen[0] - closest < 150) fail('the approach is too short to read as one');
  if (seen[seen.length - 1] - closest < 100) fail('the departure is too short to read as one');
  if (seen[0] > 450) fail(`planted ${seen[0].toFixed(0)} m out — a scout is a dot from there`);
}

// Reframing mid-pass. The camera has to move — that is what the drag is for —
// without the aeroplane being sent back to the far end of the approach to come
// in all over again.
console.log('\n  and a drag changes the angle without restarting the pass');
{
  const rig = makeRig(true);
  const approach: number[] = [];
  // Run a third of the way in, then drag.
  for (let i = 0; i < 120 * 2; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
    approach.push(camera.position.distanceTo(POS));
  }
  const before = approach[approach.length - 1];
  const wasAt = camera.position.clone();

  rig.moveFreeCamera(90, -40, 0, false);
  rig.update(DT, aircraft, tel);
  const after = camera.position.distanceTo(POS);
  const stationMoved = camera.position.distanceTo(wasAt);
  console.log(`  ${before.toFixed(0)} m out, dragged: station moved ${stationMoved.toFixed(0)} m, `
    + `aircraft now ${after.toFixed(0)} m away`);
  if (stationMoved < 1) fail('the drag did not move the camera at all');
  // The pass is measured by how far the aeroplane still has to come. A restart
  // would put that back to the full lead — 250 m — in one frame.
  if (after > before + 30) {
    fail(`the drag sent the aircraft back out to ${after.toFixed(0)} m — the pass restarted`);
  }

  // And it must still finish the pass afterwards.
  let closest = after;
  for (let i = 0; i < 120 * 8; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
    closest = Math.min(closest, camera.position.distanceTo(POS));
  }
  console.log(`  and it still whips past, at ${closest.toFixed(0)} m`);
  if (closest > 40) fail(`after the drag the aircraft only reached ${closest.toFixed(0)} m`);
}

console.log('\n  and the wheel sets how close it passes, on the same pass');
{
  const rig = makeRig(true);
  for (let i = 0; i < 120 * 2; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
  }
  const before = camera.position.distanceTo(POS);
  rig.moveFreeCamera(0, 0, 900, false); // wheel out
  rig.update(DT, aircraft, tel);
  const after = camera.position.distanceTo(POS);
  let closest = after;
  for (let i = 0; i < 120 * 8; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
    closest = Math.min(closest, camera.position.distanceTo(POS));
  }
  console.log(`  wheeled out at ${before.toFixed(0)} m (still ${after.toFixed(0)} m out), `
    + `then passed at ${closest.toFixed(0)} m instead of the ${MIN_MISS} m floor`);
  if (after > before + 30) fail('the wheel restarted the pass');
  if (closest < MIN_MISS * 1.3) fail(`the wheel did not widen the pass past ${MIN_MISS} m`);
}

console.log('\n  and dragging a departing aircraft does not fly it back at you');
{
  const rig = makeRig(true);
  // Well past the camera and going.
  for (let i = 0; i < 120 * 6; i++) {
    POS.z -= SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
  }
  const before = camera.position.distanceTo(POS);
  rig.moveFreeCamera(90, 0, 0, false);
  rig.update(DT, aircraft, tel);
  const after = camera.position.distanceTo(POS);
  console.log(`  departing at ${before.toFixed(0)} m; after the drag ${after.toFixed(0)} m`);
  if (after < before - 40) fail('the drag pulled the departing aircraft back towards the camera');
}

// The case the level-flight version got away with. Under power the aeroplane
// sits nose-high and climbs, so the nose and the track point somewhere
// different, and a camera planted along the nose is planted off the path.
console.log('\n  and it works in a climb, where the nose is not the track');
{
  const rig = makeRig(true);
  // 15 degrees nose-up, climbing at 15 degrees — but a real aircraft flies at
  // an angle of attack, so pitch the nose 8 degrees above the actual path.
  const climb = 15 * (Math.PI / 180);
  quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), climb + 8 * (Math.PI / 180));
  const seen: number[] = [];
  // Long enough for a second plant: the first was taken in level flight, before
  // the climb began, and it is the one taken *on* the climb that is the test.
  for (let i = 0; i < 120 * 20; i++) {
    POS.z -= Math.cos(climb) * SPEED * DT;
    POS.y += Math.sin(climb) * SPEED * DT;
    rig.moveFreeCamera(0, 0, 0, false);
    rig.update(DT, aircraft, tel);
    seen.push(camera.position.distanceTo(POS));
  }
  const closest = Math.min(...seen);
  console.log(`  ${seen[0].toFixed(0)} m in  ->  ${closest.toFixed(0)} m closest`);
  if (closest > 30) fail(`the aircraft never got nearer than ${closest.toFixed(0)} m in a climb`);
  quat.identity();
}

// The case that a fixed 1/120 test rig cannot see. The rig is updated once per
// rendered *frame*, and on a slow machine a frame is a long time — during which
// the aircraft has advanced by however many physics steps the loop had room
// for, which is not the same thing. Anything that divides one by the other
// comes out wrong here and right at 120 fps.
console.log('\n  and the lead is right at a poor frame rate too');
{
  for (const fps of [120, 30, 4]) {
    const frame = 1 / fps;
    const rig = makeRig(true);
    // Simulated time runs behind real time when the loop cannot keep up.
    const simPerFrame = Math.min(frame, 8 / 120);
    let closest = Infinity;
    let first = 0;
    for (let i = 0; i < fps * 20; i++) {
      POS.z -= SPEED * simPerFrame;
      rig.moveFreeCamera(0, 0, 0, false);
      rig.update(frame, aircraft, tel);
      const d = camera.position.distanceTo(POS);
      if (i === 0) first = d;
      closest = Math.min(closest, d);
    }
    console.log(`  ${String(fps).padStart(3)} fps: planted ${first.toFixed(0)} m ahead, `
      + `passed at ${closest.toFixed(0)} m`);
    if (first > 400) fail(`at ${fps} fps the camera was planted ${first.toFixed(0)} m ahead`);
    if (closest > 30) fail(`at ${fps} fps the aircraft never got nearer than ${closest.toFixed(0)} m`);
  }
}

// Every case above runs over a bottomless drop, so a station planted below the
// ground could never show up. Descending towards real terrain is the case that
// broke in the sim: the plant went underground, the lift dragged it back out and
// off the flight path, and the aeroplane sailed a kilometre overhead.
console.log('\n  and a descending track does not plant the camera underground');
{
  ground = () => 0;
  // Low, because a scout fights low: a hundred metres up, a 25° dive plants
  // the station two hundred and fifty metres down the track — underground.
  for (const [label, dive] of [['shallow', 5], ['steep', 25]] as const) {
    const rig = makeRig(true);
    POS.set(0, 100, 0);
    const rad = dive * (Math.PI / 180);
    quat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -rad);
    let closest = Infinity;
    let lowest = Infinity;
    for (let i = 0; i < 120 * 12 && POS.y > 15; i++) {
      POS.z -= Math.cos(rad) * SPEED * DT;
      POS.y -= Math.sin(rad) * SPEED * DT;
      rig.moveFreeCamera(0, 0, 0, false);
      rig.update(DT, aircraft, tel);
      closest = Math.min(closest, camera.position.distanceTo(POS));
      lowest = Math.min(lowest, camera.position.y);
    }
    console.log(`  ${label} descent (${dive}deg): passed at ${closest.toFixed(0)} m, `
      + `camera never below ${lowest.toFixed(0)} m`);
    if (lowest < 0) fail(`the camera went ${(-lowest).toFixed(0)} m underground`);
    if (closest > 40) fail(`the aircraft passed ${closest.toFixed(0)} m away — the plant left the path`);
  }
  quat.identity();
  POS.set(0, 2000, 0);
  ground = () => -Infinity;
}

console.log('\n  and a reset takes fresh station rather than watching from the old world');
{
  const rig = makeRig(true);
  for (let i = 0; i < 120 * 2; i++) { POS.z -= SPEED * DT; rig.update(DT, aircraft, tel); }
  POS.set(40_000, 3000, -25_000); // a new landscape, or a flight reset
  for (let i = 0; i < 4; i++) { POS.z -= SPEED * DT; rig.update(DT, aircraft, tel); }
  const gap = camera.position.distanceTo(POS);
  console.log(`  after a 47 km jump the camera is ${gap.toFixed(0)} m from the aircraft`);
  if (gap > 600) fail(`the camera stayed ${(gap / 1000).toFixed(1)} km behind`);
  POS.set(0, 2000, 0);
}

console.log('\n  and it does not fly through the lens, whatever the framing');
{
  // View 1 is dead astern: its framing offset lies entirely along the flight
  // path, so without a minimum miss the camera would sit on the aircraft's line.
  for (const [slot, name] of [[0, 'astern'], [3, 'overhead'], [8, 'fly-by']] as const) {
    const rig = makeRig(true);
    rig.recallFreeView(slot);
    rig.setFreeLock(true);
    let closest = Infinity;
    for (let i = 0; i < 120 * 8; i++) {
      POS.z -= SPEED * DT;
      rig.moveFreeCamera(0, 0, 0, false);
      rig.update(DT, aircraft, tel);
      closest = Math.min(closest, camera.position.distanceTo(POS));
    }
    console.log(`  view ${slot + 1} (${name}): passes at ${closest.toFixed(1)} m`);
    if (closest < MIN_MISS * 0.8) fail(`view ${slot + 1} passes ${closest.toFixed(1)} m from the lens`);
  }
}

// A different aeroplane is a cut, not a very fast one. Watching another
// machine, or respawning, hands the rig a new subject somewhere else entirely —
// and a planted camera must not keep watching the spot the old one was.
console.log('\n  and a new subject takes fresh station, and gets the old cockpit put away');
{
  const rig = makeRig(true);
  for (let i = 0; i < 120 * 2; i++) { POS.z -= SPEED * DT; rig.update(DT, aircraft, tel); }
  const otherPos = new THREE.Vector3(3000, 800, 1500);
  let oldCockpit: boolean | null = null;
  const first = { root: { position: POS, quaternion: quat }, eyePoint: new THREE.Vector3(0, 1, 0.5),
    setCockpitVisible: (on: boolean) => { oldCockpit = on; } } as unknown as Parameters<Rig['update']>[1];
  const second = { root: { position: otherPos, quaternion: new THREE.Quaternion() },
    eyePoint: new THREE.Vector3(0, 1, 0.5), velocity: new THREE.Vector3(0, 0, -SPEED),
    setCockpitVisible: () => undefined } as unknown as Parameters<Rig['update']>[1];
  rig.setMode('cockpit');
  rig.update(DT, first, tel);
  const shownBefore = oldCockpit;
  rig.setMode('free');
  rig.setFreeLock(true);
  rig.update(DT, first, tel);
  rig.update(DT, second, tel);
  const gap = camera.position.distanceTo(otherPos);
  console.log(`  first subject's cockpit ${shownBefore ? 'shown' : 'hidden'} in the cockpit view, `
    + `${oldCockpit ? 'still shown' : 'hidden'} after the switch; camera ${gap.toFixed(0)} m from the new one`);
  if (shownBefore !== true) fail('the cockpit view did not show the cockpit');
  if (oldCockpit !== false) fail('the old subject was left with its cockpit showing');
  if (gap > 600) fail(`after the switch the camera is ${gap.toFixed(0)} m from the new subject`);
}

// --------------------------------------------------------------- the reframe
//
// The toggle exists so the gesture has a visible state; it must not also be a
// second, subtly different gesture.
console.log('\nREFRAME toggle vs the shift-drag it stands in for');
{
  const snapshot = (): string => `${camera.position.toArray().map((v) => v.toFixed(3)).join(',')}`
    + ` | ${new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
      .toArray().map((v) => v.toFixed(4)).join(',')}`;
  const gesture = (reframe: boolean, shift: boolean): string => {
    const rig = makeRig(false);
    rig.setFreeReframe(reframe);
    rig.recallFreeView(0);
    // A recall restores that view's own lock, so re-apply the toggle after it.
    rig.setFreeReframe(reframe);
    for (let i = 0; i < 120; i++) rig.update(DT, aircraft, tel);
    rig.moveFreeCamera(120, -60, 0, shift);
    for (let i = 0; i < 120; i++) rig.update(DT, aircraft, tel);
    return snapshot();
  };
  const shiftDrag = gesture(false, true);
  const toggled = gesture(true, false);
  const plain = gesture(false, false);
  console.log(`  shift-drag      ${shiftDrag}`);
  console.log(`  reframe toggle  ${toggled}`);
  console.log(`  plain drag      ${plain}`);
  if (toggled !== shiftDrag) fail('the reframe toggle does not match shift-drag');
  if (plain === shiftDrag) fail('reframing and orbiting produce the same camera');
}

// ----------------------------------------------------------------- the slots
console.log('\nVIEW SLOTS');
{
  const rig = makeRig(false);
  console.log(`  ${rig.freeViewCount} of them`);
  if (rig.freeViewCount !== 9) fail(`expected 9 view slots, found ${rig.freeViewCount}`);
  // Slot 9 is the one world-locked default; recalling it must bring the lock
  // with it, or the bar and the camera end up saying different things.
  rig.setFreeLock(false);
  rig.recallFreeView(8);
  console.log(`  recalling 9 sets the lock to ${rig.freeCameraLocked ? 'world' : 'aircraft'}`);
  if (!rig.freeCameraLocked) fail('view 9 did not bring its world lock with it');
  rig.recallFreeView(0);
  if (rig.freeCameraLocked) fail('view 1 did not bring its aircraft lock with it');
}

// A saved view has to carry its own lock, or every slot is at the mercy of
// whichever lock happened to be set when you pressed the number.
console.log('\n  each slot keeps its own lock');
{
  const rig = makeRig(false);
  // Slot 1 world-locked, slot 2 aircraft-locked, saved in that order.
  rig.recallFreeView(0);
  rig.setFreeLock(true);
  rig.storeFreeView(0);
  rig.recallFreeView(1);
  rig.setFreeLock(false);
  rig.storeFreeView(1);

  rig.recallFreeView(0);
  const one = rig.freeCameraLocked;
  rig.recallFreeView(1);
  const two = rig.freeCameraLocked;
  console.log(`  saved 1 as world, 2 as aircraft  ->  1 recalls `
    + `${one ? 'world' : 'aircraft'}, 2 recalls ${two ? 'world' : 'aircraft'}`);
  if (!one) fail('a view saved world-locked came back aircraft-locked');
  if (two) fail('a view saved aircraft-locked came back world-locked');

  // And it has to survive the trip through disk, which is a plain JSON round
  // trip of exactly what `savedViews` hands out.
  const onDisk = JSON.parse(JSON.stringify(rig.savedViews)) as typeof rig.savedViews;
  const fresh = makeRig(false);
  fresh.loadFreeViews(onDisk);
  fresh.recallFreeView(0);
  const reloaded = fresh.freeCameraLocked;
  console.log(`  after a save and reload, 1 recalls ${reloaded ? 'world' : 'aircraft'}`);
  if (!reloaded) fail('the lock did not survive being written out and read back');
  if (onDisk.some((v) => typeof v.worldLocked !== 'boolean')) {
    fail('a saved view reached disk without its lock');
  }
}

console.log(`\n${failures === 0 ? 'THE FREE CAMERA IS HONEST' : `${failures} PROBLEM(S)`}`);
