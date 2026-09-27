/**
 * Check that the orbit bar's four controls do what their labels say.
 *
 * All four are stated in units the pilot can read off the bar — metres, metres,
 * revolutions per minute, and a direction — which is exactly the kind of claim
 * that is easy to make and easy to get wrong by a factor. Driving the rig at
 * the physics rate with the aircraft held still turns each label back into a
 * number that can be compared against what was asked for.
 *
 * The aircraft sits at 2000 m over ground held at -Infinity, so nothing here is
 * measuring the terrain clamp. That clamp is real and deliberate — a negative
 * height near the runway does get lifted out of the ground — but it is a
 * separate claim from "the slider sets the height".
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { CameraRig, ORBIT_LIMITS } = await import('../src/camera/CameraRig');
type Rig = InstanceType<typeof CameraRig>;
type Tel = Parameters<Rig['update']>[2];

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};
const near = (a: number, b: number, tolerance: number): boolean =>
  Math.abs(a - b) <= tolerance;

const DT = 1 / 120;
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1e6);
const telemetry = { tas: 0 } as Tel;
const POS = new THREE.Vector3(0, 2000, 0);
// The rig reads the root's pose, the eye and the cockpit switch; a stub whose
// position *is* POS keeps the two one and the same.
const aircraft = { root: { position: POS, quaternion: new THREE.Quaternion() },
  eyePoint: new THREE.Vector3(0, 1, 0.5),
  setCockpitVisible: () => undefined } as unknown as Parameters<Rig['update']>[1];

function makeRig(): Rig {
  const rig = new CameraRig(camera, () => -Infinity);
  rig.setMode('orbit');
  return rig;
}

/** Where the camera sits relative to the aircraft, after `seconds` of orbiting. */
function fly(rig: Rig, seconds: number): { radius: number; height: number; bearing: number } {
  for (let i = 0; i < Math.round(seconds / DT); i++) rig.update(DT, aircraft, telemetry);
  const c = camera.position;
  return {
    radius: Math.hypot(c.x - POS.x, c.z - POS.z),
    height: c.y - POS.y,
    bearing: Math.atan2(c.z - POS.z, c.x - POS.x) * (180 / Math.PI),
  };
}

// ------------------------------------------------------------------ distance
//
// The ring widens with airspeed on top of the slider, so this is measured at
// rest; the airspeed term gets its own case below.
console.log('DISTANCE  slider -> metres from the aircraft');
for (const want of [6, 16, 60, 120]) {
  const rig = makeRig();
  rig.setOrbit({ distance: want, rate: 0 });
  const { radius } = fly(rig, 6);
  console.log(`  ${String(want).padStart(3)} m  ->  ${radius.toFixed(1)} m`);
  if (!near(radius, want, 0.2)) fail(`asked ${want} m, orbiting at ${radius.toFixed(1)} m`);
}

console.log('\n  and it still opens out with speed');
{
  const rig = makeRig();
  rig.setOrbit({ distance: 16, rate: 0 });
  telemetry.tas = 0;
  const still = fly(rig, 6).radius;
  telemetry.tas = 50;
  const fast = fly(rig, 6).radius;
  telemetry.tas = 0;
  console.log(`  0 m/s ${still.toFixed(1)} m -> 50 m/s ${fast.toFixed(1)} m`);
  if (!(fast > still + 2.5)) fail('airspeed no longer widens the ring');
  if (fast > still + 8) fail('airspeed widens the ring out of all proportion to a scout');
}

// -------------------------------------------------------------------- height
console.log('\nHEIGHT    slider -> metres above the aircraft');
for (const want of [-15, 0, 4, 60]) {
  const rig = makeRig();
  rig.setOrbit({ height: want, rate: 0 });
  const { height } = fly(rig, 6);
  console.log(`  ${String(want).padStart(3)} m  ->  ${height.toFixed(1)} m`);
  if (!near(height, want, 0.2)) fail(`asked ${want} m, sitting at ${height.toFixed(1)} m`);
}

// ---------------------------------------------------------- rate & direction
//
// The claim on the bar is revolutions per minute, so that is what is measured:
// degrees of bearing swept over ten seconds, converted back.
console.log('\nRATE      slider -> revolutions per minute');
function rpm(rig: Rig): number {
  const a = fly(rig, 4).bearing; // let the smoothing settle first
  const b = fly(rig, 10).bearing;
  let swept = b - a;
  // Ten seconds at 8 rpm is more than a full turn; count the whole ones back in.
  const turns = Math.round((rig.orbit.rate * rig.orbit.direction * (10 / 60) * 360 - swept) / 360);
  swept += turns * 360;
  return swept / 360 * 6;
}
for (const want of [0, 1, 2.1, 4, 8]) {
  const rig = makeRig();
  rig.setOrbit({ rate: want });
  const got = rpm(rig);
  console.log(`  ${String(want).padStart(3)} rpm  ->  ${got.toFixed(2)} rpm`);
  if (!near(got, want, 0.05)) fail(`asked ${want} rpm, sweeping ${got.toFixed(2)} rpm`);
}

console.log('\nDIRECTION both ways round, at the same rate');
{
  const cw = makeRig();
  cw.setOrbit({ rate: 4, direction: 1 });
  const ccw = makeRig();
  ccw.setOrbit({ rate: 4, direction: -1 });
  const a = rpm(cw);
  const b = rpm(ccw);
  console.log(`  CW ${a.toFixed(2)} rpm   CCW ${b.toFixed(2)} rpm`);
  if (!(a > 0 && b < 0)) fail('the two directions do not have opposite signs');
  if (!near(Math.abs(a), Math.abs(b), 0.05)) fail('one direction is faster than the other');
}

console.log('\n  and reversing keeps the bearing rather than jumping across');
{
  const rig = makeRig();
  rig.setOrbit({ rate: 4, direction: 1 });
  const before = fly(rig, 5).bearing;
  rig.setOrbit({ direction: -1 });
  const after = fly(rig, DT).bearing;
  let jump = Math.abs(after - before);
  if (jump > 180) jump = 360 - jump;
  console.log(`  ${before.toFixed(1)}deg -> ${after.toFixed(1)}deg  (moved ${jump.toFixed(2)}deg)`);
  if (jump > 2) fail(`the camera jumped ${jump.toFixed(1)}deg across the aircraft`);
}

// -------------------------------------------------------------------- mouse
//
// Drag for height, wheel for distance, and nothing at all sideways — the ring
// sweeps its own bearing, so a horizontal drag has nothing to say.
console.log('\nMOUSE     drag raises, wheel opens out, sideways does nothing');
{
  const rig = makeRig();
  rig.setOrbit({ distance: 30, height: 10, rate: 0 });

  // Up is negative dy, and up is up.
  const before = rig.orbit.height;
  rig.moveOrbitCamera(-100, 0);
  const raised = rig.orbit.height;
  rig.moveOrbitCamera(100, 0);
  const back = rig.orbit.height;
  console.log(`  drag up 100px: ${before} m -> ${raised.toFixed(1)} m, and back to ${back.toFixed(1)} m`);
  if (raised <= before) fail('dragging up did not raise the camera');
  if (!near(back, before, 0.001)) fail('the drag is not reversible');

  // What the readout will say, checked against where the camera actually goes.
  rig.setOrbit({ height: 0 });
  rig.moveOrbitCamera(-200, 0);
  const asked = rig.orbit.height;
  const { height } = fly(rig, 6);
  console.log(`  200px -> ${asked.toFixed(1)} m on the bar, ${height.toFixed(1)} m in the air`);
  if (!near(asked, height, 0.2)) fail('the readout and the camera disagree');

  // The wheel is proportional, so the same click is the same *fraction* near
  // and far — that is the whole reason it is not additive.
  rig.setOrbit({ distance: 10 });
  rig.moveOrbitCamera(0, 300);
  const nearRatio = rig.orbit.distance / 10;
  rig.setOrbit({ distance: 80 });
  rig.moveOrbitCamera(0, 300);
  const farRatio = rig.orbit.distance / 80;
  console.log(`  one wheel step: x${nearRatio.toFixed(3)} at 10 m, x${farRatio.toFixed(3)} at 80 m`);
  if (!near(nearRatio, farRatio, 0.001)) fail('the wheel is not proportional');
  if (nearRatio <= 1) fail('the wheel does not open the ring out');

  // Sideways is the one gesture this view does not have.
  rig.setOrbit({ distance: 30, height: 10, rate: 2 });
  const held = { ...rig.orbit };
  const moved = rig.moveOrbitCamera(0, 0);
  console.log(`  a purely horizontal drag reports moved=${moved}`);
  if (moved) fail('a horizontal-only drag claimed to change something');
  if (JSON.stringify({ ...rig.orbit }) !== JSON.stringify(held)) fail('it changed the orbit anyway');

  // And it stays inside the bar's range however hard it is dragged.
  rig.moveOrbitCamera(-100_000, 0);
  const top = rig.orbit.height;
  rig.moveOrbitCamera(100_000, 0);
  const bottom = rig.orbit.height;
  rig.moveOrbitCamera(0, 100_000);
  const out = rig.orbit.distance;
  console.log(`  dragged to the stops: ${bottom} m to ${top} m, out to ${out} m`);
  if (top !== ORBIT_LIMITS.height[1]) fail('dragging up passed the top of the range');
  if (bottom !== ORBIT_LIMITS.height[0]) fail('dragging down passed the bottom of the range');
  if (out !== ORBIT_LIMITS.distance[1]) fail('the wheel passed the far limit');
}

// -------------------------------------------------------------------- limits
//
// The bar's min/max and this clamp are the same numbers, so a value from a
// stale save file or a hand-edited slider cannot put the camera somewhere the
// bar has no way to bring it back from.
console.log('\nLIMITS    out-of-range values are pulled back in');
{
  const rig = makeRig();
  rig.setOrbit({ distance: 1e6, height: -1e6, rate: 99, direction: 0 });
  const got = { ...rig.orbit };
  console.log(`  ${JSON.stringify(got)}`);
  if (got.distance !== ORBIT_LIMITS.distance[1]) fail('distance not clamped to its maximum');
  if (got.height !== ORBIT_LIMITS.height[0]) fail('height not clamped to its minimum');
  if (got.rate !== ORBIT_LIMITS.rate[1]) fail('rate not clamped to its maximum');
  if (got.direction !== 1) fail('a zero direction did not resolve to one of the two');
  rig.setOrbit({ distance: Number.NaN });
  if (!Number.isFinite(rig.orbit.distance)) fail('NaN got through the clamp');
}

console.log('\n  and no other view answers it');
{
  const rig = makeRig();
  rig.setOrbit({ distance: 30, height: 10 });
  for (const mode of ['chase', 'cockpit', 'target', 'cinematic', 'free', 'director'] as const) {
    rig.setMode(mode);
    if (rig.moveOrbitCamera(-100, 300)) fail(`the ${mode} view took an orbit gesture`);
  }
  console.log(`  still ${rig.orbit.distance} m and ${rig.orbit.height} m after six other views`);
  if (rig.orbit.distance !== 30 || rig.orbit.height !== 10) {
    fail('another view moved the orbit camera');
  }
}

console.log(`\n${failures === 0 ? 'THE ORBIT BAR MEANS WHAT IT SAYS' : `${failures} PROBLEM(S)`}`);
