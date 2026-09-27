/**
 * The cameras in a fight: the target view, the kill cam, the combat shots,
 * the cockpit's head and the shake hooks.
 *
 * Run with:
 *   esbuild tools/combatcam.ts --bundle --platform=node --format=esm \
 *     --outfile=node_modules/.cache/combatcam.mjs --log-level=warning \
 *     && node node_modules/.cache/combatcam.mjs
 *
 * Everything is flown synthetically — circles, merges, a spiral going down —
 * so what is measured is the camera and nothing else. The two claims that
 * matter most for the target view are simple to state and easy to break: the
 * lens is never inside either aeroplane, and both aeroplanes are always in the
 * picture. Both are checked on every frame, in fights built to make them hard.
 */
import * as THREE from 'three';

if (typeof document === 'undefined') {
  const ctx = new Proxy({}, { get: () => () => undefined });
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  };
}
const { CameraRig } = await import('../src/camera/CameraRig');
const { CinematicDirector, shotCatalogue, COMBAT_RANGE } = await import('../src/camera/Cinematic');
type Rig = InstanceType<typeof CameraRig>;
type Subject = Parameters<Rig['update']>[1];
type Tel = Parameters<Rig['update']>[2];

const realRandom = Math.random;

let failures = 0;
const fail = (why: string): void => {
  failures++;
  console.log(`      <-- ${why}`);
};

const DT = 1 / 120;
const SPEED = 50;
const G = 9.81;
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1e6);
const ground = (): number => 0;
const ALT = 900;

/** An aircraft the rig can follow, with a live pose and velocity. */
function makePlane(scale = 1): Subject & { root: THREE.Object3D; velocity: THREE.Vector3 } {
  const root = new THREE.Object3D();
  let cockpit = false;
  return {
    root,
    eyePoint: new THREE.Vector3(0, 1.0, 0.5),
    cameraScale: scale,
    velocity: new THREE.Vector3(),
    setCockpitVisible: (on: boolean) => { cockpit = on; },
    get cockpitShown(): boolean { return cockpit; },
  } as unknown as Subject & { root: THREE.Object3D; velocity: THREE.Vector3 };
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _b = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Attitude for flying along `vel`, banked by `bank` radians (positive right). */
function attitude(out: THREE.Quaternion, vel: THREE.Vector3, bank: number): THREE.Quaternion {
  _f.copy(vel).normalize();
  _r.crossVectors(_f, new THREE.Vector3(0, 1, 0));
  if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
  _r.normalize();
  _u.crossVectors(_r, _f).normalize();
  // Roll about the direction of flight.
  const q = new THREE.Quaternion().setFromAxisAngle(_f, -bank);
  _r.applyQuaternion(q);
  _u.applyQuaternion(q);
  _b.copy(_f).negate();
  _m.makeBasis(_r, _u, _b);
  return out.setFromRotationMatrix(_m);
}

/** A turning flight: circle about `centre`, radius `radius`, `dir` +1 anticlockwise from above. */
function circle(p: ReturnType<typeof makePlane>, centre: THREE.Vector3, radius: number,
  phase: number, dir: 1 | -1, t: number, speed = SPEED): void {
  const w = (speed / radius) * dir;
  const a = phase + w * t;
  p.root.position.set(centre.x + Math.cos(a) * radius, centre.y, centre.z + Math.sin(a) * radius);
  p.velocity.set(-Math.sin(a) * w * radius, 0, Math.cos(a) * w * radius);
  const bank = Math.atan((speed * speed) / (G * radius));
  // Banked into the turn: which way depends on the sense of rotation.
  attitude(p.root.quaternion, p.velocity, dir > 0 ? -bank : bank);
}

/** Straight and level (or not), from `start` along `vel`. */
function straight(p: ReturnType<typeof makePlane>, start: THREE.Vector3, vel: THREE.Vector3,
  t: number): void {
  p.root.position.copy(start).addScaledVector(vel, t);
  p.velocity.copy(vel);
  attitude(p.root.quaternion, vel, 0);
}

function ndc(point: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld(true);
  return point.clone().project(camera);
}

function inFrame(point: THREE.Vector3): boolean {
  const v = ndc(point);
  // In front of the lens (NDC z < 1 with a perspective camera) and inside.
  return v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
}

const tel: Tel = { tas: SPEED, agl: ALT, bank: 0, verticalSpeed: 0, loadFactor: 1 };

// ============================================================ the target view
console.log('TARGET VIEW — padlock from outside, over simulated fights');
interface Fight {
  name: string;
  seconds: number;
  /** Whether a strict frame check applies (the orbiting fights), or a share. */
  strict: boolean;
  fly(player: ReturnType<typeof makePlane>, target: ReturnType<typeof makePlane>,
    other: ReturnType<typeof makePlane>, t: number): 'target' | 'other';
}
const C = new THREE.Vector3(0, ALT, 0);
const FIGHTS: Fight[] = [
  {
    name: 'on his tail in a turn',
    seconds: 24,
    strict: true,
    fly: (pl, tg, _o, t) => {
      circle(pl, C, 150, 0, 1, t);
      circle(tg, C, 150, 0.45, 1, t);
      return 'target';
    },
  },
  {
    name: 'bandit on my tail',
    seconds: 24,
    strict: true,
    fly: (pl, tg, _o, t) => {
      circle(pl, C, 150, 0, 1, t);
      circle(tg, C, 150, -0.6, 1, t);
      return 'target';
    },
  },
  {
    name: 'turning the other way, above',
    seconds: 30,
    strict: true,
    fly: (pl, tg, _o, t) => {
      circle(pl, C, 150, 0, 1, t);
      circle(tg, C.clone().add(new THREE.Vector3(60, 70, -30)), 140, 1.2, -1, t, 46);
      return 'target';
    },
  },
  {
    name: 'a lufbery, one above the other',
    seconds: 24,
    strict: true,
    fly: (pl, tg, _o, t) => {
      circle(pl, C, 130, 0, 1, t);
      circle(tg, C.clone().add(new THREE.Vector3(0, 110, 0)), 130, 3.0, 1, t);
      return 'target';
    },
  },
  {
    name: 'straight across overhead',
    seconds: 12,
    strict: false,
    fly: (pl, tg, _o, t) => {
      straight(pl, new THREE.Vector3(0, ALT, 0), new THREE.Vector3(0, 0, -SPEED), t);
      straight(tg, new THREE.Vector3(-300, ALT + 25, -300), new THREE.Vector3(SPEED, 0, 0), t);
      return 'target';
    },
  },
  {
    name: 'head-on merge',
    seconds: 10,
    strict: false,
    fly: (pl, tg, _o, t) => {
      straight(pl, new THREE.Vector3(0, ALT, 0), new THREE.Vector3(0, 0, -SPEED), t);
      straight(tg, new THREE.Vector3(12, ALT + 5, -500), new THREE.Vector3(0, 0, SPEED), t);
      return 'target';
    },
  },
  {
    name: 'switching to one astern',
    seconds: 20,
    strict: false,
    fly: (pl, tg, o, t) => {
      circle(pl, C, 150, 0, 1, t);
      circle(tg, C, 150, 0.5, 1, t);
      circle(o, C.clone().add(new THREE.Vector3(0, -40, 0)), 170, -0.9, 1, t, 55);
      return t < 8 ? 'target' : 'other';
    },
  },
];

for (const fight of FIGHTS) {
  const rig = new CameraRig(camera, ground);
  rig.setMode('target');
  const player = makePlane();
  const target = makePlane();
  const other = makePlane();
  let inside = 0;
  let closest = Infinity;
  let frames = 0;
  let framed = 0;
  let worstFlip = 0;
  let worstUp = 1;
  let maxFov = 0;
  const lastFwd = new THREE.Vector3();
  const lastUp = new THREE.Vector3();
  const settle = 1.2;
  let sinceSwitch = 99;
  let lastWho = '';
  for (let i = 0; i < fight.seconds * 120; i++) {
    const t = i * DT;
    const who = fight.fly(player, target, other, t);
    if (who !== lastWho) { sinceSwitch = 0; lastWho = who; }
    sinceSwitch += DT;
    const tg = who === 'target' ? target : other;
    rig.setCombatContext({
      target: { position: tg.root.position, velocity: tg.velocity, cameraScale: 1 },
      threat: null,
    });
    rig.update(DT, player, tel);
    if (t < settle) continue;
    frames++;
    const dP = camera.position.distanceTo(player.root.position);
    const dT = camera.position.distanceTo(tg.root.position);
    closest = Math.min(closest, dP, dT);
    if (dP < 5.0 || dT < 5.0) inside++;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (frames > 1) {
      worstFlip = Math.max(worstFlip, fwd.angleTo(lastFwd) * (180 / Math.PI));
      worstUp = Math.min(worstUp, up.dot(lastUp));
    }
    lastFwd.copy(fwd);
    lastUp.copy(up);
    maxFov = Math.max(maxFov, camera.fov);
    // A new target gets a moment to swing onto; everything else is on the clock.
    if (inFrame(player.root.position) && inFrame(tg.root.position)) framed++;
    else if (sinceSwitch < 1.0) framed++;
  }
  const share = (framed / Math.max(frames, 1)) * 100;
  console.log(`  ${fight.name.padEnd(30)} both in frame ${share.toFixed(1).padStart(5)}%`
    + `  closest ${closest.toFixed(1).padStart(5)} m  worst turn ${worstFlip.toFixed(2)}°/frame`
    + `  widest ${maxFov.toFixed(0)}°`);
  if (inside > 0) fail(`${fight.name}: the lens was inside an aeroplane on ${inside} frames`);
  if (fight.strict && share < 100) fail(`${fight.name}: both were in frame only ${share.toFixed(1)}% of the time`);
  if (!fight.strict && share < 97) fail(`${fight.name}: both were in frame only ${share.toFixed(1)}% of the time`);
  // 3° a frame at 120 Hz is 360°/s: anything faster is a cut or a flip.
  if (worstFlip > 3) fail(`${fight.name}: the view swung ${worstFlip.toFixed(1)}° in one frame`);
  if (worstUp < 0.995) fail(`${fight.name}: the horizon lurched (up·up' = ${worstUp.toFixed(3)})`);
}

// With no target the view is the chase view — the same camera, not a similar one.
console.log('\n  with no target it is the chase view');
{
  const a = new CameraRig(camera, ground);
  const b = new CameraRig(camera.clone(), ground);
  a.setMode('target');
  b.setMode('chase');
  const player = makePlane();
  const camB = (b as unknown as { camera: THREE.PerspectiveCamera }).camera;
  let worst = 0;
  for (let i = 0; i < 120 * 6; i++) {
    circle(player, C, 150, 0, 1, i * DT);
    a.setCombatContext({ target: null, threat: null });
    a.update(DT, player, tel);
    const pa = camera.position.clone();
    b.update(DT, player, tel);
    if (i > 120) worst = Math.max(worst, pa.distanceTo(camB.position));
  }
  console.log(`  target view and chase view differ by at most ${worst.toFixed(3)} m`);
  if (worst > 0.01) fail('with no target the target view is not the chase view');
}

// A target appearing, and going away again, is a move and not a cut.
console.log('\n  and a target coming and going eases rather than cuts');
{
  const rig = new CameraRig(camera, ground);
  rig.setMode('target');
  const player = makePlane();
  const target = makePlane();
  let jump = 0;
  const last = new THREE.Vector3();
  for (let i = 0; i < 120 * 16; i++) {
    const t = i * DT;
    circle(player, C, 150, 0, 1, t);
    circle(target, C, 150, -1.2, 1, t);
    const on = t > 4 && t < 10;
    rig.setCombatContext({
      target: on ? { position: target.root.position, velocity: target.velocity } : null,
      threat: null,
    });
    rig.update(DT, player, tel);
    // Relative to the player, which moves 0.42 m a frame on its own.
    const rel = camera.position.clone().sub(player.root.position);
    if (i > 0) jump = Math.max(jump, rel.distanceTo(last));
    last.copy(rel);
  }
  console.log(`  largest one-frame move of the camera about the player: ${jump.toFixed(2)} m`);
  if (jump > 0.6) fail(`the camera jumped ${jump.toFixed(2)} m in one frame as the target came or went`);
}

// A bomber: the same view, with everything scaled, and still never inside.
console.log('\n  and around a Gotha');
{
  const rig = new CameraRig(camera, ground);
  rig.setMode('target');
  const player = makePlane(2.7);
  const target = makePlane(1);
  let closest = Infinity;
  let framed = 0;
  let frames = 0;
  for (let i = 0; i < 120 * 20; i++) {
    const t = i * DT;
    circle(player, C, 300, 0, 1, t, 38);
    circle(target, C.clone().add(new THREE.Vector3(0, 40, 0)), 200, 2.0, -1, t, 52);
    rig.setCombatContext({ target: { position: target.root.position, velocity: target.velocity, cameraScale: 1 }, threat: null });
    rig.update(DT, player, tel);
    if (t < 1.2) continue;
    frames++;
    closest = Math.min(closest, camera.position.distanceTo(player.root.position));
    if (inFrame(player.root.position) && inFrame(target.root.position)) framed++;
  }
  console.log(`  closest to the bomber ${closest.toFixed(1)} m, both in frame ${(framed / frames * 100).toFixed(1)}%`);
  if (closest < 5.2 * 2.7 - 0.1) fail('the target view came inside the bomber');
  if (framed < frames) fail('the bomber or its target left the frame');
}

// ================================================================ the kill cam
console.log('\nKILL CAM — a burning scout spiralling down');
/** A victim in a spinning dive: position, velocity and a tumbling attitude. */
function spiral(v: ReturnType<typeof makePlane>, start: THREE.Vector3, t: number): void {
  const r = 30;
  const w = 1.6;
  const sink = 20 + 6 * t; // accelerating down
  v.root.position.set(start.x + Math.cos(w * t) * r, start.y - (20 * t + 3 * t * t), start.z + Math.sin(w * t) * r);
  v.velocity.set(-Math.sin(w * t) * r * w, -sink, Math.cos(w * t) * r * w);
  attitude(v.root.quaternion, v.velocity, t * 5);
}

{
  Math.random = realRandom;
  for (const seconds of [3, 4.5]) {
    const d = new CinematicDirector();
    const victim = makePlane();
    const start = new THREE.Vector3(200, 700, -300);
    const player = new THREE.Vector3(0, 800, 0);
    const q = new THREE.Quaternion();
    // Some ordinary shot first.
    for (let i = 0; i < 120; i++) d.update(DT, player, q, tel, camera, () => 0);
    spiral(victim, start, 0);
    d.killCam({ position: victim.root.position, velocity: victim.velocity }, seconds);
    let held = 0;
    let framed = 0;
    let frames = 0;
    let closest = Infinity;
    let lowest = Infinity;
    let name = '';
    let after = '';
    for (let i = 0; i < 120 * (seconds + 2); i++) {
      const t = i * DT;
      spiral(victim, start, t);
      player.z -= SPEED * DT;
      d.update(DT, player, q, tel, camera, () => 0);
      if (d.shotName === 'kill cam' || d.shotName === 'kill orbit') {
        if (name === '') name = d.shotName;
        held += DT;
        frames++;
        if (inFrame(victim.root.position)) framed++;
        closest = Math.min(closest, camera.position.distanceTo(victim.root.position));
        lowest = Math.min(lowest, camera.position.y);
        if (d.focusPoint.distanceTo(victim.root.position) > 0.01) fail('the lens is not focused on the victim');
      } else if (held > 0 && after === '') {
        after = d.shotName;
      }
    }
    console.log(`  asked for ${seconds} s: "${name}" held ${held.toFixed(2)} s, victim in frame `
      + `${(framed / Math.max(frames, 1) * 100).toFixed(0)}%, closest ${closest.toFixed(1)} m, then "${after}"`);
    if (name === '') fail('the kill cam never came up');
    if (Math.abs(held - seconds) > DT * 2) fail(`the kill cam ran ${held.toFixed(2)} s, not ${seconds}`);
    if (framed < frames) fail('the victim left the frame during the kill cam');
    if (closest < 5.2) fail(`the kill cam came ${closest.toFixed(1)} m from the victim — inside it`);
    if (lowest < 3) fail('the kill cam went into the ground');
    if (after === '' || after === 'kill cam' || after === 'kill orbit') fail('the kill cam did not hand back');
  }

  // Through the rig: the cinematic view plays it, the chase view does not
  // unless asked to, the director does not while a shot is pinned.
  const rig = new CameraRig(camera, ground);
  const player = makePlane();
  const victim = makePlane();
  const fly = (n: number): void => {
    for (let i = 0; i < n; i++) {
      straight(player, new THREE.Vector3(0, ALT, 0), new THREE.Vector3(0, 0, -SPEED), i * DT);
      spiral(victim, new THREE.Vector3(100, ALT - 50, -200), i * DT);
      rig.update(DT, player, tel);
    }
  };
  rig.setMode('cinematic');
  fly(60);
  const played = rig.requestKillCam(victim, 3);
  fly(2);
  const during = rig.shotName;
  const active = rig.killCamActive;
  fly(120 * 3 + 10);
  console.log(`  cinematic: accepted ${played}, on screen "${during}", active ${active}; after 3 s "${rig.shotName}", active ${rig.killCamActive}`);
  if (!played || !active || !(during === 'kill cam' || during === 'kill orbit')) fail('the cinematic view did not play the kill cam');
  if (rig.killCamActive || rig.shotName === 'kill cam' || rig.shotName === 'kill orbit') fail('the cinematic view did not come back from it');

  rig.setMode('chase');
  fly(30);
  const chaseRefused = !rig.requestKillCam(victim, 3);
  rig.killCamOutside = true;
  fly(1);
  const chaseBefore = camera.position.clone().sub(player.root.position);
  const chaseAccepted = rig.requestKillCam(victim, 2);
  fly(3);
  const borrowed = rig.shotName;
  fly(120 * 2 + 10);
  const chaseAfter = camera.position.clone().sub(player.root.position);
  console.log(`  chase: refused by default ${chaseRefused}; with killCamOutside played "${borrowed}", `
    + `and came back to within ${chaseAfter.distanceTo(chaseBefore).toFixed(2)} m of the chase boom`);
  if (!chaseRefused) fail('the chase view gave the camera away without being asked to');
  if (!chaseAccepted || !(borrowed === 'kill cam' || borrowed === 'kill orbit')) fail('killCamOutside did not play the kill cam');
  if (chaseAfter.distanceTo(chaseBefore) > 0.5 || rig.shotName !== null) fail('the chase view did not come back after the kill cam');
  rig.killCamOutside = false;

  rig.setMode('director');
  fly(30);
  rig.pinShot();
  const pinnedRefused = !rig.requestKillCam(victim, 3);
  console.log(`  director with a pinned shot: refused ${pinnedRefused}`);
  if (!pinnedRefused) fail('a kill cam broke into a pinned shot');

  // requestShot('kill') takes the current target as the victim.
  rig.setMode('cinematic');
  fly(30);
  rig.setCombatContext({ target: { position: victim.root.position, velocity: victim.velocity }, threat: null });
  rig.requestShot('kill');
  fly(2);
  console.log(`  requestShot('kill') with a target: "${rig.shotName}"`);
  if (!(rig.shotName === 'kill cam' || rig.shotName === 'kill orbit')) fail("requestShot('kill') did not play the kill cam");
  rig.setCombatContext({ target: null, threat: null });
}

// ============================================================ the combat pool
console.log('\nTHE COMBAT SHOTS — dealt in a fight, never outside one');
{
  Math.random = realRandom;
  const combatNames = new Set(shotCatalogue().filter((s) => s.combat).map((s) => s.name));
  for (const [label, range] of [['bandit at 250 m', 250], ['bandit at 1500 m', 1500]] as const) {
    const d = new CinematicDirector();
    const player = makePlane();
    const target = makePlane();
    let cuts = 0;
    let combat = 0;
    let last = '';
    const seen = new Set<string>();
    for (let i = 0; i < 120 * 60 * 30 && cuts < 300; i++) {
      const t = i * DT;
      circle(player, C, 150, 0, 1, t);
      if (range < 1000) circle(target, C, 150, 1.4, 1, t);
      else straight(target, new THREE.Vector3(range, ALT, 0), new THREE.Vector3(0, 0, -SPEED), t);
      d.setCombat({ target: { position: target.root.position, velocity: target.velocity }, threat: null });
      d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0,
        { velocity: player.velocity });
      if (d.shotName !== last) {
        last = d.shotName;
        cuts++;
        if (combatNames.has(last)) {
          combat++;
          seen.add(last);
        }
      }
    }
    const share = (combat / cuts) * 100;
    console.log(`  ${label}: ${share.toFixed(0)}% of ${cuts} cuts were combat setups (${seen.size} different)`);
    if (range < COMBAT_RANGE && share < 55) fail(`in a fight only ${share.toFixed(0)}% of cuts were about it`);
    if (range < COMBAT_RANGE && seen.size < 7) fail(`the fight was shot from only ${seen.size} setups`);
    const needy = shotCatalogue().filter((s) => s.needsTarget).map((s) => s.name);
    if (range > COMBAT_RANGE && needy.some((n) => seen.has(n))) fail('target shots were dealt with the enemy out of reach');
  }

  // A fight opening is cut to: the first time a bandit comes well inside
  // reach, the sequence goes straight to an engagement shot.
  console.log('\n  a bandit closing from two kilometres');
  {
    Math.random = realRandom;
    const engage = new Set(['guns-eye', 'on his six', 'wingman view', 'crossing']);
    let cutAt = -1;
    let cutTo = '';
    let range = 0;
    const d = new CinematicDirector();
    const player = makePlane();
    const target = makePlane();
    let last = '';
    for (let i = 0; i < 120 * 40; i++) {
      const t = i * DT;
      straight(player, new THREE.Vector3(0, ALT, 0), new THREE.Vector3(0, 0, -SPEED), t);
      straight(target, new THREE.Vector3(30, ALT + 40, -2000), new THREE.Vector3(0, 0, SPEED), t);
      d.setCombat({ target: { position: target.root.position, velocity: target.velocity }, threat: null });
      d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0,
        { velocity: player.velocity });
      const gap = player.root.position.distanceTo(target.root.position);
      if (d.shotName !== last && i > 0 && gap < COMBAT_RANGE && cutAt < 0) {
        cutAt = t;
        cutTo = d.shotName;
        range = gap;
      }
      last = d.shotName;
    }
    console.log(`  cut to "${cutTo}" with the bandit ${range.toFixed(0)} m off`);
    if (!engage.has(cutTo)) fail('the fight opening was not cut to an engagement shot');
    if (range < COMBAT_RANGE * 0.7) fail('the engagement cut came late');
  }

  // Every shot that frames the pair, forced, in a turning fight: both in
  // frame, the lens never inside either.
  console.log('\n  every combat setup, forced, in a turning fight');
  Math.random = (): number => 0.5;
  const threatPlane = makePlane();
  for (const info of shotCatalogue().filter((s) => s.combat)) {
    const d = new CinematicDirector();
    const player = makePlane();
    const target = makePlane();
    let frames = 0;
    let both = 0;
    let closest = Infinity;
    let started = false;
    for (let i = 0; i < 120 * 12; i++) {
      const t = i * DT;
      circle(player, C, 150, 0, 1, t);
      circle(target, C, 150, 0.9, 1, t);
      circle(threatPlane, C, 150, -0.8, 1, t);
      d.setCombat({
        target: { position: target.root.position, velocity: target.velocity },
        threat: { position: threatPlane.root.position },
      });
      if (i === 0) d.force(info.name);
      d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0,
        { velocity: player.velocity, eye: new THREE.Vector3(0, 1, 0.5) });
      if (d.shotName !== info.name) {
        if (started) break;
        continue;
      }
      started = true;
      frames++;
      const other = info.framing === 'threat' ? threatPlane : target;
      if (!info.mounted && !info.locked) {
        closest = Math.min(closest, camera.position.distanceTo(player.root.position),
          camera.position.distanceTo(other.root.position));
      }
      // A two-shot holds both; a shot of the enemy holds the enemy; the rest
      // hold the player.
      // (A player within 6.5 m of the lens is foreground, and may be cropped.)
      const foreground = camera.position.distanceTo(player.root.position) < 6.5;
      const ok = info.pair ? (foreground || inFrame(player.root.position)) && inFrame(other.root.position)
        : info.subject === 'target' ? inFrame(target.root.position)
          : info.mounted || inFrame(player.root.position);
      if (ok) both++;
    }
    const share = (both / Math.max(frames, 1)) * 100;
    console.log(`  ${info.name.padEnd(18)} ${info.framing ?? '-'}`.padEnd(30)
      + ` ${share.toFixed(0).padStart(3)}% framed${closest < Infinity ? `, closest ${closest.toFixed(1)} m` : ''}`);
    if (frames === 0) fail(`${info.name} could not be forced`);
    if (closest < 5.15) fail(`${info.name} came ${closest.toFixed(1)} m from an aeroplane`);
    // A tripod lets them fly out of the picture at the end; that is the shot.
    if (!info.locked && share < 95) fail(`${info.name} held both aircraft only ${share.toFixed(0)}% of the time`);
  }

  // The crossing tripod, in a real merge: it has to stand beside the point
  // where they pass, so both of them go by it close — not beside the player's
  // track, where the bandit would pass far off.
  console.log('\n  the crossing tripod, in a head-on merge');
  {
    const d = new CinematicDirector();
    const player = makePlane();
    const target = makePlane();
    const p0 = new THREE.Vector3(0, ALT, 0);
    const t0 = new THREE.Vector3(60, ALT + 20, -380);
    const vP = new THREE.Vector3(0, 0, -SPEED);
    const vT = new THREE.Vector3(-6, 0, SPEED);
    let nearP = Infinity;
    let nearT = Infinity;
    let passAt = -1;
    let frames = 0;
    for (let i = 0; i < 120 * 8; i++) {
      straight(player, p0, vP, i * DT);
      straight(target, t0, vT, i * DT);
      d.setCombat({ target: { position: target.root.position, velocity: target.velocity }, threat: null });
      if (i === 0) d.force('crossing');
      d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0,
        { velocity: player.velocity });
      if (d.shotName !== 'crossing') { if (frames > 0) break; continue; }
      frames++;
      const a = camera.position.distanceTo(player.root.position);
      const b = camera.position.distanceTo(target.root.position);
      nearP = Math.min(nearP, a);
      nearT = Math.min(nearT, b);
      if (passAt < 0 && target.root.position.z > player.root.position.z) passAt = frames / 120;
    }
    console.log(`  they meet ${passAt.toFixed(1)} s in; the player passes the tripod at ${nearP.toFixed(0)} m, `
      + `the bandit at ${nearT.toFixed(0)} m`);
    if (nearP > 45 || nearT > 45) fail('the crossing tripod was not planted where they cross');
  }

  // A target that goes away mid-shot: the sequence cuts rather than framing
  // a hole in the sky.
  console.log('\n  a target lost mid-shot');
  {
    const d = new CinematicDirector();
    const player = makePlane();
    const target = makePlane();
    circle(player, C, 150, 0, 1, 0);
    circle(target, C, 150, 0.9, 1, 0);
    d.setCombat({ target: { position: target.root.position, velocity: target.velocity }, threat: null });
    d.force('wingman view');
    for (let i = 0; i < 60; i++) d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0);
    const before = d.shotName;
    d.setCombat({ target: null, threat: null });
    d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0);
    console.log(`  "${before}" -> "${d.shotName}" on the next frame`);
    if (d.shotName === before) fail('a combat shot held on after its target went');
  }

  // A burst of hits with somebody behind: the shot that shows him.
  console.log('\n  hits taken with a bandit astern');
  {
    Math.random = realRandom;
    const got = new Set<string>();
    for (let k = 0; k < 20; k++) {
      const d = new CinematicDirector();
      const player = makePlane();
      circle(player, C, 150, 0, 1, 0);
      circle(threatPlane, C, 150, -0.6, 1, 0);
      d.setCombat({ target: null, threat: { position: threatPlane.root.position } });
      d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0);
      d.request('hit');
      d.update(DT, player.root.position, player.root.quaternion, tel, camera, () => 0);
      got.add(d.shotName);
    }
    console.log(`  cut to: ${[...got].join(', ')}`);
    if (![...got].every((n) => n === 'tail gunner' || n === 'check six')) fail("'hit' did not cut to the threat");
  }
}

// ================================================================= the cockpit
console.log('\nCOCKPIT — near plane, lens, and the head');
{
  Math.random = (): number => 0.5;
  const rig = new CameraRig(camera, ground);
  const player = makePlane();
  straight(player, new THREE.Vector3(0, ALT, 0), new THREE.Vector3(0, 0, -SPEED), 0);
  rig.setMode('chase');
  for (let i = 0; i < 240; i++) rig.update(DT, player, tel);
  const chaseNear = camera.near;
  const chaseFov = camera.fov;
  rig.setMode('cockpit');
  for (let i = 0; i < 240; i++) rig.update(DT, player, tel);
  const pitNear = camera.near;
  const pitFov = camera.fov;
  const shown = (player as unknown as { cockpitShown: boolean }).cockpitShown;
  console.log(`  near ${pitNear} m in the cockpit, ${chaseNear} m outside; lens ${pitFov.toFixed(1)}° vs ${chaseFov.toFixed(1)}°; cockpit drawn ${shown}`);
  if (pitNear > 0.05 + 1e-9) fail('the cockpit near plane clips the gunsight');
  if (chaseNear !== 0.5) fail('the near plane was not restored outside');
  if (!(pitFov > chaseFov)) fail('the cockpit lens is not the wider one');
  if (!shown) fail('the cockpit interior is not drawn in the cockpit');

  // Look left: positive yaw turns the head toward −X.
  rig.setCockpitLook(Math.PI / 2, 0);
  for (let i = 0; i < 240; i++) rig.update(DT, player, tel);
  const left = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  console.log(`  looking 90° left, the lens points ${left.toArray().map((v) => v.toFixed(2)).join(', ')}`);
  if (left.x > -0.95) fail('a positive yaw did not look left');
  rig.setCockpitLook(0, 0);

  // Padlock, and a target that sits dead astern and wobbles across the tail.
  const target = makePlane();
  rig.setCockpitPadlock(true);
  let flips = 0;
  let lastYaw = 0;
  let aim = 0;
  for (let i = 0; i < 120 * 6; i++) {
    const t = i * DT;
    const wobble = Math.sin(t * 3) * 6;
    // Keeping station on the player's six, weaving a few metres either side.
    straight(target, new THREE.Vector3(wobble, ALT + 8, 120), new THREE.Vector3(0, 0, -SPEED), 0);
    rig.setCombatContext({ target: { position: target.root.position, velocity: target.velocity }, threat: null });
    rig.update(DT, player, tel);
    const yaw = rig.cockpitLook.yaw;
    if (i > 240 && Math.sign(yaw) !== Math.sign(lastYaw)) flips++;
    lastYaw = yaw;
  }
  console.log(`  target astern: head at ${(lastYaw * 180 / Math.PI).toFixed(0)}°, swapped shoulders ${flips} times`);
  if (flips > 0) fail('the padlock head flipped across the back of the seat');
  // And one it can reach: up and to the right.
  for (let i = 0; i < 120 * 3; i++) {
    straight(target, new THREE.Vector3(80, ALT + 60, -60), new THREE.Vector3(0, 0, -SPEED), i * DT);
    rig.setCombatContext({ target: { position: target.root.position, velocity: target.velocity }, threat: null });
    rig.update(DT, player, tel);
  }
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const want = target.root.position.clone().sub(camera.position).normalize();
  aim = look.angleTo(want) * (180 / Math.PI);
  console.log(`  target up and right: the head points ${aim.toFixed(1)}° off it`);
  if (aim > 3) fail('the padlock did not look at the target');
  rig.setCockpitPadlock(false);
  rig.setCombatContext({ target: null, threat: null });
}

// ================================================================= the shake
console.log('\nSHAKE — engine, guns and hits');
{
  Math.random = realRandom;
  const still = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1e6);
  /**
   * Two numbers: jitter — how far the aim moves frame to frame, millidegrees —
   * which is what the buzz of an engine or the guns is; and sway — the most the
   * aim is ever off where an unshaken camera would point, degrees — which is
   * what a hit is. The unshaken camera is a twin rig with everything off.
   */
  const measure = (mode: 'chase' | 'cockpit' | 'free', setup: (r: Rig) => void,
    kick = 0): { jitter: number; sway: number } => {
    const rig = new CameraRig(camera, ground);
    const twin = new CameraRig(still, ground);
    rig.setMode(mode);
    twin.setMode(mode);
    setup(rig);
    twin.setEngine(0, false);
    const player = makePlane();
    straight(player, new THREE.Vector3(0, ALT, 0), new THREE.Vector3(0, 0, -SPEED), 0);
    for (let i = 0; i < 240; i++) {
      rig.update(DT, player, tel);
      twin.update(DT, player, tel);
    }
    if (kick > 0) rig.addShake(kick);
    let sum = 0;
    let sway = 0;
    const last = new THREE.Quaternion().copy(camera.quaternion);
    for (let i = 0; i < 240; i++) {
      rig.update(DT, player, tel);
      twin.update(DT, player, tel);
      sum += camera.quaternion.angleTo(last);
      sway = Math.max(sway, camera.quaternion.angleTo(still.quaternion));
      last.copy(camera.quaternion);
      if (!Number.isFinite(camera.quaternion.w)) return { jitter: Number.NaN, sway: Number.NaN };
    }
    return { jitter: (sum / 240) * (180 / Math.PI) * 1000, sway: sway * (180 / Math.PI) };
  };
  const idle = measure('chase', (r) => r.setEngine(0.3, false));
  const rotary = measure('chase', (r) => r.setEngine(1, true));
  const guns = measure('chase', (r) => { r.setEngine(1, true); r.setGunfire(true); });
  const pitEngine = measure('cockpit', (r) => r.setEngine(1, true));
  const pit = measure('cockpit', (r) => { r.setEngine(1, true); r.setGunfire(true); });
  const hit = measure('chase', (r) => r.setEngine(0, false), 1);
  const free = measure('free', (r) => { r.setEngine(1, true); r.setGunfire(true); }, 1);
  const row = (label: string, m: { jitter: number; sway: number }): void => {
    console.log(`  ${label.padEnd(26)} jitter ${m.jitter.toFixed(1).padStart(6)} m°/frame, `
      + `sway ${m.sway.toFixed(3)}°`);
  };
  row('inline at idle, chase', idle);
  row('rotary flat out, chase', rotary);
  row('rotary and guns, chase', guns);
  row('rotary, cockpit', pitEngine);
  row('rotary and guns, cockpit', pit);
  row('a solid hit, chase', hit);
  row('all of it, free camera', free);
  const all = [idle, rotary, guns, pitEngine, pit, hit, free];
  if (all.some((m) => !Number.isFinite(m.jitter) || !Number.isFinite(m.sway))) fail('shake made a NaN');
  if (!(rotary.jitter > idle.jitter)) fail('a rotary at full power shakes no more than an inline at idle');
  if (!(guns.jitter > rotary.jitter)) fail('the guns add nothing');
  if (!(pit.jitter > guns.jitter)) fail('the cockpit shakes less than the chase view');
  if (free.sway > 1e-6) fail('the free camera shakes');
  // A hit rocks the view; an engine never does.
  if (hit.sway < 0.15) fail(`a solid hit only rocks the view ${hit.sway.toFixed(2)}°`);
  if (hit.sway > 1.5) fail(`a hit throws the view ${hit.sway.toFixed(2)}° — that is a cut`);
  if (rotary.sway > 0.1 || pitEngine.sway > 0.12) fail('the engine rocks the view rather than buzzing it');
  // Subtle: at 1920 px across a 100° field a degree is about nineteen pixels.
  if (pitEngine.jitter > 80) fail(`the engine alone shakes the cockpit ${pitEngine.jitter.toFixed(0)} m° a frame`);
  if (pit.jitter > 300) fail(`${pit.jitter.toFixed(0)} m° a frame is not subtle`);
}

console.log(failures === 0 ? '\nTHE CAMERAS KNOW THERE IS A WAR ON' : `\n${failures} PROBLEM(S)`);
