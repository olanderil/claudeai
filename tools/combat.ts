/**
 * Headless check of the biplane flight model and the AI pilots.
 *
 * Runs in node (no DOM, no rendering): flies each type level at full throttle
 * to find its top speed, reports stall speeds, then lets AI flights fight over
 * flat ground and checks that they actually fight — rounds fired, hits scored,
 * machines shot down — without flying into the ground or producing NaNs. Also
 * a bomber holding its route and a parked scout scrambling off the grass.
 *
 * Run: npm run check:combat
 */
import * as THREE from 'three';
import { Plane, type PlaneEvents } from '../src/combat/Plane';
import { Brain, type BrainWorld } from '../src/combat/Brain';
import { Ballistics, type Shootable } from '../src/combat/Ballistics';
import { TYPES, stallSpeed, type AirframeId } from '../src/combat/Types';

const DT = 1 / 120;
const ground = (x: number, z: number): number => 20 + 15 * Math.sin(x / 900) * Math.cos(z / 700);
const water = (): boolean => false;

let failures = 0;
function check(ok: boolean, what: string): void {
  console.log(`${ok ? '  ok ' : ' FAIL'}  ${what}`);
  if (!ok) failures++;
}

const quiet: PlaneEvents = { hit() {}, killed() {}, exploded() {}, landed() {} };

// Stand-in hitboxes, the size of a scout, since the models aren't built here.
function boxes(p: Plane): void {
  const s = p.type.mass > 2000 ? 2.6 : p.type.mass > 1200 ? 1.4 : 1;
  p.hitboxes = [
    { c: new THREE.Vector3(0, 0, 0.5 * s), h: new THREE.Vector3(0.6, 0.7, 3.2).multiplyScalar(s) },
    { c: new THREE.Vector3(0, 0.6 * s, -0.4 * s), h: new THREE.Vector3(4.3, 0.9, 0.9).multiplyScalar(s) },
  ];
  p.radius = 6 * s;
}

/* ---------------------------------------------------------- performance */

console.log('\nPerformance (full throttle, level, 90 s):');
for (const id of Object.keys(TYPES) as AirframeId[]) {
  const p = new Plane(id, TYPES[id].team);
  p.spawnAt(0, 1200, 0, 0, 40);
  p.throttle = 1;
  let climb = 0;
  for (let t = 0; t < 90; t += DT) {
    // Hold level: a little proportional pitch on the vertical speed.
    p.input.pitch = Math.max(-1, Math.min(1, -p.velocity.y * 0.08 + (1200 - p.position.y) * 0.004));
    p.input.roll = Math.max(-1, Math.min(1, p.telemetry.bank * 2 - p.telemetry.rollRate * 0.3));
    p.step(DT, ground, water, quiet, t);
  }
  const vmax = p.speed;
  // Climb rate at the best climb speed, roughly: hold 1.35 × stall.
  const q = new Plane(id, TYPES[id].team);
  q.spawnAt(0, 800, 0, 0, stallSpeed(TYPES[id]) * 1.4);
  q.throttle = 1;
  const y0 = 800;
  for (let t = 0; t < 30; t += DT) {
    const want = stallSpeed(TYPES[id]) * 1.4;
    q.input.pitch = Math.max(-1, Math.min(1, (q.speed - want) * 0.08));
    q.input.roll = Math.max(-1, Math.min(1, q.telemetry.bank * 2 - q.telemetry.rollRate * 0.3));
    q.step(DT, ground, water, quiet, t);
  }
  climb = (q.position.y - y0) / 30;
  const vs = stallSpeed(TYPES[id]);
  console.log(`  ${TYPES[id].name.padEnd(16)} top ${(vmax * 3.6).toFixed(0).padStart(4)} km/h  stall ${(vs * 3.6).toFixed(0).padStart(3)} km/h  climb ${climb.toFixed(1)} m/s`);
  check(Number.isFinite(vmax) && vmax > vs * 1.6, `${id}: flies well above its stall speed`);
}

/* -------------------------------------------------------------- dogfight */

function arena(g: (x: number, z: number) => number = ground): { planes: Plane[]; world: BrainWorld; guns: Ballistics; events: PlaneEvents; stats: { kills: number; hits: number; rounds: number; crashes: number; unshot: number } } {
  const planes: Plane[] = [];
  const stats = { kills: 0, hits: 0, rounds: 0, crashes: 0, unshot: 0 };
  const world: BrainWorld = {
    planes, time: 0, ground: g, arenaCentre: new THREE.Vector3(0, 0, 0), arenaRadius: 5000,
  };
  const events: PlaneEvents = {
    hit() { stats.hits++; },
    killed(_p, k) { if (k) stats.kills++; else stats.unshot++; },
    exploded(_p, midAir) { if (!midAir) stats.crashes++; },
    landed() {},
  };
  return { planes, world, guns: new Ballistics(), events, stats };
}

function stepArena(a: ReturnType<typeof arena>, seconds: number): void {
  const _m = new THREE.Vector3();
  const _d = new THREE.Vector3();
  for (let t = 0; t < seconds; t += DT) {
    (a.world as { time: number }).time = t;
    for (const p of a.planes) {
      if (p.state === 'dead') continue;
      if (p.brain && p.alive) p.brain.update(DT);
      p.step(DT, a.world.ground, water, a.events, t);
      // Guns, as the battle fires them.
      const g = p.gun;
      g.heat = Math.max(0, g.heat - DT * 0.28);
      if (g.jam > 0) { g.jam -= DT; continue; }
      if (!p.input.fire || !p.alive || p.type.guns === 0) { g.cooldown = Math.max(0, g.cooldown - DT); continue; }
      g.cooldown -= DT;
      while (g.cooldown <= 0) {
        g.cooldown += 1 / p.type.rateOfFire;
        _m.copy(p.position).addScaledVector(p.fwd, 2);
        _d.copy(p.position).addScaledVector(p.fwd, p.type.converge).sub(_m).normalize();
        a.guns.fire(_m, _d, p.velocity, p, p.team, 4.5, true);
        a.stats.rounds++;
        g.heat += 0.036;
        if (g.heat >= 1) { g.jam = 2.6; break; }
      }
    }
    const targets: Shootable[] = a.planes.filter((p) => p.alive);
    a.guns.step(DT, targets, a.world.ground, water, null, {
      strike: (target, r, point) => (target as Plane).damage(r.damage, r.owner, point, a.events, t),
      impact() {},
      whiz() {},
    });
  }
}

console.log('\nDogfight: 3 Camels v 3 Albatros/Dr.I, AI skill 0.6, 150 s:');
{
  const a = arena();
  const types: AirframeId[][] = [['camel', 'camel', 'spad'], ['albatros', 'dr1', 'albatros']];
  types.forEach((list, side) => list.forEach((id, i) => {
    const p = new Plane(id, side === 0 ? 'allied' : 'central');
    boxes(p);
    p.spawnAt((i - 1) * 80, 700 + i * 20, side === 0 ? 1500 : -1500, side === 0 ? 0 : Math.PI, 45);
    p.brain = new Brain(p, 0.6, a.world);
    a.planes.push(p);
  }));
  let nan = false;
  stepArena(a, 150);
  for (const p of a.planes) if (!Number.isFinite(p.position.x + p.position.y + p.position.z)) nan = true;
  const down = a.planes.filter((p) => !p.alive).length;
  console.log(`  rounds ${a.stats.rounds}, hits ${a.stats.hits}, shot down ${a.stats.kills}, crashed ${a.stats.crashes}, out of the fight ${down}`);
  check(!nan, 'no NaN positions');
  check(a.stats.rounds > 300, 'the AI opens fire');
  check(a.stats.hits > 20, 'the AI hits things');
  check(a.stats.kills >= 1, 'somebody gets shot down');
  check(a.stats.crashes <= 2, 'few machines fly into the ground unshot');
}

console.log('\nMountain dogfight: the same fight in an alpine valley over a 2,000 m pass, 150 s:');
{
  // A valley along z between 3,500 m walls, crossed by a saddle at z = 0.
  const smooth = (a: number, b: number, v: number): number => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const alps = (x: number, z: number): number =>
    700 + 2800 * smooth(700, 2000, Math.abs(x + 200 * Math.sin(z / 900)))
    + 1300 * Math.exp(-((z / 600) ** 2)) * (0.75 + 0.25 * Math.sin(x / 260))
    + 120 * Math.sin(x / 170) * Math.cos(z / 230);
  const a = arena(alps);
  const types: AirframeId[][] = [['camel', 'camel', 'spad'], ['albatros', 'dr1', 'albatros']];
  types.forEach((list, side) => list.forEach((id, i) => {
    const p = new Plane(id, side === 0 ? 'allied' : 'central');
    boxes(p);
    const z = side === 0 ? 1500 : -1500;
    p.spawnAt((i - 1) * 80, 2300 + i * 20, z, side === 0 ? 0 : Math.PI, 45);
    p.brain = new Brain(p, 0.6, a.world);
    a.planes.push(p);
  }));
  stepArena(a, 150);
  console.log(`  rounds ${a.stats.rounds}, hits ${a.stats.hits}, shot down ${a.stats.kills}, flew into the ground ${a.stats.unshot}`);
  check(a.stats.rounds > 200, 'they still fight between the walls');
  check(a.stats.unshot <= 1, 'nobody flies into a mountain unshot');
}

console.log('\nBomber holds its route:');
{
  const a = arena();
  const b = new Plane('dh4', 'allied');
  boxes(b);
  b.spawnAt(0, 800, 0, 0, 42);
  const route = [new THREE.Vector3(0, 800, -3000), new THREE.Vector3(2500, 800, -3000), new THREE.Vector3(2500, 800, 0)];
  const brain = new Brain(b, 0.5, a.world);
  brain.orders = { kind: 'route', points: route, loop: false, speed: 40, index: 0 };
  b.brain = brain;
  a.planes.push(b);
  stepArena(a, 240);
  const o = brain.orders;
  const reached = o.kind === 'route' ? o.index : -1;
  console.log(`  waypoint ${reached} of ${route.length - 1}, alt ${b.position.y.toFixed(0)} m, speed ${(b.speed * 3.6).toFixed(0)} km/h`);
  check(b.alive && reached >= 2, 'reaches its waypoints alive');
  check(Math.abs(b.position.y - 800) < 250, 'keeps roughly its height');
}

console.log('\nRecruit stall guard: full back stick at low throttle, 30 s:');
{
  for (const guard of [false, true]) {
    const p = new Plane('camel', 'allied');
    boxes(p);
    p.stallGuard = guard;
    p.spawnAt(0, 1500, 0, 0, 40);
    p.throttle = p.rpm = 0.3;
    let stalledT = 0;
    for (let t = 0; t < 30; t += DT) {
      p.input.pitch = 1;
      p.input.roll = 0;
      p.step(DT, ground, water, quiet, t);
      if (p.stalled) stalledT += DT;
    }
    console.log(`  ${guard ? 'guarded  ' : 'unguarded'}: stalled ${stalledT.toFixed(1)} s of 30`);
    if (guard) check(stalledT < 0.5, 'the guarded machine never stalls');
    else check(stalledT > 1, 'without the guard, it does');
  }
}

console.log('\nParked scout scrambles:');
{
  const a = arena();
  const s = new Plane('albatros', 'central');
  boxes(s);
  s.parkAt(0, ground(0, 0), 0, 0);
  s.throttle = 1;
  s.brain = new Brain(s, 0.5, a.world);
  a.planes.push(s);
  stepArena(a, 40);
  const agl = s.position.y - ground(s.position.x, s.position.z);
  console.log(`  after 40 s: ${s.state}, ${agl.toFixed(0)} m above the ground, ${(s.speed * 3.6).toFixed(0)} km/h`);
  check(s.alive && s.state === 'flying' && agl > 40, 'gets airborne and climbs away');
}

console.log(failures === 0 ? '\nAll combat checks passed.\n' : `\n${failures} check(s) failed.\n`);
// Node's exit code, without pulling in @types/node for one line.
(globalThis as unknown as { process: { exitCode: number } }).process.exitCode = failures === 0 ? 0 : 1;
