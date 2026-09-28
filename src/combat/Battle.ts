import * as THREE from 'three';
import { clamp, lerp } from '../util/math';
import { frontSide, frontZ } from '../world/Front';
import type { Sfx } from '../audio/Sfx';
import { Ballistics, type Round, type Shootable } from './Ballistics';
import { Brain, type Orders } from './Brain';
import { Effects } from './Effects';
import { HeightCache } from './HeightCache';
import { DEFAULT_LEVEL, type Level } from './Levels';
import { Plane, type PlaneEvents } from './Plane';
import { PlaneVisual } from './PlaneVisual';
import { Target, type TargetHooks } from './Targets';
import { BULLET_GRAVITY, BULLET_SPEED, type AirframeId, type Team } from './Types';

/**
 * The air battle: every aircraft, target, round, bomb and burst, stepped at
 * the physics rate and drawn at the frame rate.
 *
 * It knows nothing about missions or menus. Game modes spawn into it, give AI
 * pilots their orders, and listen for what happens.
 */

export interface BattleListener {
  planeDown?(p: Plane, killer: Plane | null): void;
  targetDestroyed?(t: Target, by: Plane | null): void;
  playerHit?(amount: number): void;
  playerScored?(kind: 'hit'): void;
  landed?(p: Plane): void;
  gunsJammed?(p: Plane): void;
  gunsCleared?(p: Plane): void;
  bombImpact?(pos: THREE.Vector3, owner: Plane | null): void;
  /** A flak burst went off this close to the player. */
  flakNear?(distance: number): void;
}

export interface SpawnOptions {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed?: number;
  skill?: number;
  isPlayer?: boolean;
  livery?: string;
  name?: string;
  hp?: number;
  score?: number;
  orders?: Orders;
  parked?: boolean;
  role?: string;
}

interface Bomb {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  owner: Plane | null;
  team: Team;
  alive: boolean;
}

export interface PlayerStats {
  rounds: number;
  hits: number;
  kills: number;
  balloons: number;
  ground: number;
  bombs: number;
  damageTaken: number;
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _t3 = new THREE.Vector3();
const _mz = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const TRACER_GLOW = [1.0, 0.72, 0.36];

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
function randDir(out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(a), u, s * Math.sin(a));
}

export class Battle implements PlaneEvents, TargetHooks {
  readonly group = new THREE.Group();
  readonly planes: Plane[] = [];
  readonly visuals = new Map<Plane, PlaneVisual>();
  readonly targets: Target[] = [];
  readonly ballistics = new Ballistics();
  readonly fx = new Effects();
  readonly heights: HeightCache;
  player: Plane | null = null;
  time = 0;
  readonly arenaCentre = new THREE.Vector3(0, 0, -3500);
  arenaRadius = 7500;
  /** The team whose lines are on the home (south) side of the front. */
  homeTeam: Team = 'allied';
  listener: BattleListener = {};
  sfx: Sfx | null = null;
  readonly stats: PlayerStats = { rounds: 0, hits: 0, kills: 0, balloons: 0, ground: 0, bombs: 0, damageTaken: 0 };
  /** Flak over the far side of the lines, and how long the player has loitered there. */
  archie = true;
  private flakT = 3;
  private overLinesT = 0;
  /** Shelling along the front for atmosphere. */
  barrage = 1;
  private barrageT = 0;
  private readonly bombs: Bomb[] = [];
  private readonly bombMesh: THREE.InstancedMesh;
  private readonly shootables: Shootable[] = [];
  /** Where the listener is, for whizzing rounds. */
  readonly ear = new THREE.Vector3();
  /** How good the enemy is, and the aids the player gets. */
  level: Level = DEFAULT_LEVEL;
  /** The player's current target, for the recruit's aim assist. */
  assistTarget: Plane | null = null;
  /** 0 by day, 1 at night: searchlight beams fade in with it. */
  night = 0;
  private readonly beams = new Map<Target, THREE.Mesh>();
  private beamGeo: THREE.BufferGeometry | null = null;
  private beamMat: THREE.MeshBasicMaterial | null = null;

  constructor(private readonly exactGround: (x: number, z: number) => number, wet: (x: number, z: number) => boolean) {
    this.heights = new HeightCache(exactGround, wet);
    this.group.add(this.fx.group, this.ballistics.tracers);
    const bombGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.9, 8);
    bombGeo.rotateX(Math.PI / 2);
    this.bombMesh = new THREE.InstancedMesh(bombGeo, new THREE.MeshStandardMaterial({ color: 0x3b3f36, roughness: 0.6, metalness: 0.4 }), 64);
    this.bombMesh.count = 0;
    this.bombMesh.frustumCulled = false;
    this.group.add(this.bombMesh);
  }

  /* ----------------------------------------------------------- queries */

  ground = (x: number, z: number): number => this.heights.height(x, z);

  /** Which team holds the ground at (x, z); null in no-man's-land. */
  holder(x: number, z: number): Team | null {
    const side = frontSide(x, z);
    if (side === 0) return null;
    return side === 1 ? this.homeTeam : this.homeTeam === 'allied' ? 'central' : 'allied';
  }

  visualOf(p: Plane): PlaneVisual | undefined {
    return this.visuals.get(p);
  }

  enemiesOf(team: Team): Plane[] {
    return this.planes.filter((p) => p.alive && p.team !== team);
  }

  /* ----------------------------------------------------------- lifecycle */

  clear(): void {
    for (const v of this.visuals.values()) v.dispose();
    this.visuals.clear();
    this.planes.length = 0;
    for (const t of this.targets) t.dispose();
    this.targets.length = 0;
    for (const b of this.beams.values()) b.removeFromParent();
    this.beams.clear();
    this.player = null;
    this.ballistics.clear();
    this.fx.clear();
    this.bombs.length = 0;
    this.time = 0;
    Object.assign(this.stats, { rounds: 0, hits: 0, kills: 0, balloons: 0, ground: 0, bombs: 0, damageTaken: 0 });
  }

  /** The world changed under the battle. */
  resetTerrain(): void {
    this.heights.clear();
  }

  spawn(type: AirframeId, team: Team, o: SpawnOptions): Plane {
    const p = new Plane(type, team, { isPlayer: o.isPlayer, name: o.name, hp: o.hp, score: o.score, livery: o.livery });
    if (o.parked) p.parkAt(o.x, this.exactGround(o.x, o.z), o.z, o.heading);
    else p.spawnAt(o.x, o.y, o.z, o.heading, o.speed ?? 45);
    p.role = o.role ?? '';
    const v = new PlaneVisual(p, this.group);
    this.visuals.set(p, v);
    this.planes.push(p);
    if (o.isPlayer) {
      this.player = p;
      p.invuln = 3;
      p.stallGuard = this.level.stallGuard;
    }
    if (o.skill !== undefined) {
      // Sorties are tuned for the Pilot level; the chosen level rescales the enemy.
      const skill = team !== this.homeTeam && !o.isPlayer ? this.level.skill(o.skill) : o.skill;
      const brain = new Brain(p, skill, this);
      if (o.orders) brain.orders = o.orders;
      p.brain = brain;
    }
    return p;
  }

  remove(p: Plane): void {
    const i = this.planes.indexOf(p);
    if (i >= 0) this.planes.splice(i, 1);
    this.visuals.get(p)?.dispose();
    this.visuals.delete(p);
    if (this.player === p) this.player = null;
  }

  addTarget(t: Target): Target {
    this.targets.push(t);
    this.group.add(t.model.root);
    if (t.kind === 'balloon') t.attachCable(this.group, this.exactGround(t.base.x, t.base.z));
    return t;
  }

  /** Give a plane an AI pilot (or take it away with null). */
  setBrain(p: Plane, skill: number | null, orders?: Orders): void {
    if (skill === null) {
      p.brain = null;
      return;
    }
    const b = new Brain(p, skill, this);
    if (orders) b.orders = orders;
    p.brain = b;
  }

  /* --------------------------------------------------------------- step */

  step(dt: number): void {
    this.time += dt;
    const ground = this.ground;
    const exact = this.exactGround;
    const water = this.heights.water;
    for (const p of this.planes) {
      if (p.state === 'dead') {
        p.deadT += dt;
        continue;
      }
      if (p.brain && p.alive) p.brain.update(dt);
      // Aircraft near the ground use the exact surface; the lattice is for everything else.
      const agl = p.position.y - ground(p.position.x, p.position.z);
      p.step(dt, agl < 30 ? exact : ground, water, this, this.time);
      if (p.alive || p.state === 'falling') {
        this.updateGuns(p, dt);
        if (p.type.gunner) this.updateGunner(p, dt);
        if (p.input.bomb) {
          p.input.bomb = false;
          this.dropBomb(p);
        }
      }
    }
    this.collisions();
    this.shootables.length = 0;
    for (const p of this.planes) if (p.alive) this.shootables.push(p);
    for (const t of this.targets) if (t.alive) this.shootables.push(t);
    this.ballistics.step(dt, this.shootables, ground, water, this.player?.alive ? this.ear : null, {
      strike: (target, round, point) => this.strike(target, round, point),
      impact: (point, wet) => this.fx.impact(point, wet),
      whiz: (point) => this.sfx?.whiz(point),
    });
    this.stepBombs(dt);
    this.stepTargetGuns(dt);
    this.stepSearchlights(dt);
    if (this.archie) this.stepArchie(dt);
  }

  /**
   * Searchlights sweep the sky in slow arcs until an enemy machine comes
   * within reach, then hold it — with a lag, as a crew cranking a 90 cm
   * projector by hand would.
   */
  private stepSearchlights(dt: number): void {
    for (const t of this.targets) {
      if (t.kind !== 'searchlight' || !t.alive) continue;
      let best: THREE.Vector3 | null = null;
      let bd = 3200;
      for (const p of this.planes) {
        if (!p.alive || p.team === t.team) continue;
        const d = p.position.distanceTo(t.position);
        if (d < bd) {
          bd = d;
          best = p.position;
        }
      }
      for (const z of this.targets) {
        if (z.kind !== 'zeppelin' || !z.alive || z.team === t.team) continue;
        const d = z.position.distanceTo(t.position);
        if (d < bd) {
          bd = d;
          best = z.position;
        }
      }
      if (best) _t1.subVectors(best, t.position).normalize();
      else {
        const a = this.time * 0.12 + t.base.x * 0.01;
        _t1.set(Math.sin(a), 0.75 + 0.2 * Math.sin(a * 1.7), Math.cos(a * 0.8)).normalize();
      }
      t.aim.lerp(_t1, 1 - Math.exp(-dt * (best ? 1.4 : 0.6))).normalize();
    }
  }

  private strike(target: Shootable, r: Round, point: THREE.Vector3): void {
    if (r.owner?.isPlayer) this.stats.hits++;
    if (target instanceof Plane) target.damage(target === this.player ? r.damage * this.level.hurt : r.damage, r.owner, point, this, this.time);
    else if (target instanceof Target) target.damage(r.damage, r.owner, point, this);
  }

  private updateGuns(p: Plane, dt: number): void {
    const g = p.gun;
    g.heat = Math.max(0, g.heat - dt * 0.28);
    if (g.jam > 0) {
      g.jam -= dt;
      if (g.jam <= 0) {
        g.heat = 0.55;
        if (p.isPlayer) {
          this.listener.gunsCleared?.(p);
          this.sfx?.clear();
        }
      }
      return;
    }
    if (!p.input.fire || !p.alive || g.ammo <= 0 || p.type.guns === 0) {
      g.cooldown = Math.max(g.cooldown - dt, 0);
      return;
    }
    g.cooldown -= dt;
    const forgiving = p.isPlayer && this.level.noJams;
    while (g.cooldown <= 0) {
      if (forgiving && g.heat > 0.97) {
        // Hot guns just slow to the rate they can cool at.
        g.cooldown = 0;
        break;
      }
      g.cooldown += 1 / p.type.rateOfFire;
      this.fireRound(p);
      g.ammo--;
      g.heat += 0.036;
      if (!forgiving && (g.heat >= 1 || (g.heat > 0.75 && Math.random() < 0.004))) {
        g.jam = 2.6;
        if (p.isPlayer) {
          this.listener.gunsJammed?.(p);
          this.sfx?.jam();
        }
        break;
      }
      if (g.ammo <= 0) break;
    }
  }

  private fireRound(p: Plane): void {
    const v = this.visuals.get(p);
    const muzzles = v?.rig.muzzles;
    const side = (p.gun.side ^= 1);
    if (muzzles && muzzles.length > 0) _mz.copy(muzzles[side % muzzles.length]);
    else _mz.set(side ? 0.13 : -0.13, 0.55, -1.9);
    _mz.applyQuaternion(p.orientation).add(p.position);
    _aim.copy(p.position).addScaledVector(p.fwd, p.type.converge).sub(_mz).normalize();
    const spread = p.isPlayer ? 0.0035 : 0.006;
    _aim.x += (Math.random() - 0.5) * spread * 2;
    _aim.y += (Math.random() - 0.5) * spread * 2;
    _aim.z += (Math.random() - 0.5) * spread * 2;
    _aim.normalize();
    if (p.isPlayer && this.level.aimAssist > 0) this.assistAim(p);
    const damage = p.isPlayer ? p.type.damage : p.team === this.player?.team ? 5 : 4.2;
    this.ballistics.fire(_mz, _aim, p.velocity, p, p.team, damage, p.gun.side === 0 || !p.isPlayer);
    if (p.isPlayer) this.stats.rounds++;
    if (v) v.firingT = 0.08;
    if (Math.random() < 0.25) this.fx.gunSmoke(_mz, p.velocity);
  }

  /**
   * The recruit's aid: a round fired within a few degrees of the lead on the
   * current target is bent part of the way onto it.
   */
  private assistAim(p: Plane): void {
    const t = this.assistTarget;
    if (!t || !t.alive || t.team === p.team) return;
    const d = t.position.distanceTo(_mz);
    if (d > 650) return;
    const tof = d / BULLET_SPEED;
    _t1.copy(t.position).addScaledVector(_rel.subVectors(t.velocity, p.velocity), tof);
    _t1.y += 0.5 * BULLET_GRAVITY * tof * tof;
    _t1.sub(_mz).normalize();
    const off = Math.acos(clamp(_t1.dot(_aim), -1, 1));
    const cone = 0.045;
    if (off > cone) return;
    _aim.lerp(_t1, this.level.aimAssist * (1 - off / cone) ** 0.5).normalize();
  }

  /** Rear gunner in two-seaters and bombers: swings onto whatever's behind and fires in bursts. */
  private updateGunner(p: Plane, dt: number): void {
    const g = p.gun;
    const v = this.visuals.get(p);
    if (!p.alive) return;
    let best: Plane | null = null;
    let bd = 520;
    for (const o of this.planes) {
      if (!o.alive || o.team === p.team) continue;
      const d = o.position.distanceTo(p.position);
      if (d > bd) continue;
      _t1.subVectors(o.position, p.position).applyQuaternion(p.invQ);
      // Rear hemisphere and above the fuselage line, where the Scarff ring can reach.
      if (_t1.z < -0.25 * d || _t1.y < -0.35 * d) continue;
      bd = d;
      best = o;
    }
    const want = _t2.set(0, 0.15, 1);
    let fire = false;
    if (best) {
      const tof = bd / BULLET_SPEED;
      _t1.copy(best.position).addScaledVector(_rel.subVectors(best.velocity, p.velocity), tof);
      _t1.y += 0.5 * BULLET_GRAVITY * tof * tof;
      want.subVectors(_t1, p.position).applyQuaternion(p.invQ).normalize();
      fire = bd < 420 && g.gunnerAim.dot(want) > 0.992;
    }
    g.gunnerAim.lerp(want, 1 - Math.exp(-dt * 4)).normalize();
    g.gunnerCooldown -= dt;
    if (fire && g.gunnerCooldown <= 0) {
      // Bursts: 9 rounds a second for a second or so, then a pause.
      g.gunnerCooldown = Math.random() < 0.08 ? 0.9 : 1 / 9;
      const mount = v?.rig.gunnerMount;
      _mz.copy(mount ?? _t3.set(0, 1, 2)).applyQuaternion(p.orientation).add(p.position);
      _aim.copy(g.gunnerAim).applyQuaternion(p.orientation);
      const err = 0.012;
      _aim.x += (Math.random() - 0.5) * err * 2;
      _aim.y += (Math.random() - 0.5) * err * 2;
      _aim.z += (Math.random() - 0.5) * err * 2;
      _aim.normalize();
      _mz.addScaledVector(_aim, 1.2);
      this.ballistics.fire(_mz, _aim, p.velocity, p, p.team, 4.5, true);
      if (v) v.gunnerFiringT = 0.08;
    }
  }

  /** Guns on the ground and on the airship. */
  private stepTargetGuns(dt: number): void {
    for (const t of this.targets) {
      if (!t.alive) continue;
      if (t.kind !== 'aagun' && t.kind !== 'mgnest' && t.kind !== 'zeppelin') continue;
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const range = t.kind === 'aagun' ? 2600 : t.kind === 'mgnest' ? 650 : 550;
      let best: Plane | null = null;
      let bd = range;
      for (const p of this.planes) {
        if (!p.alive || p.team === t.team) continue;
        const d = p.position.distanceTo(t.position);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (!best) {
        t.cooldown = 0.7;
        continue;
      }
      t.aim.subVectors(best.position, t.position).normalize();
      if (t.kind === 'aagun') {
        if (best.position.y - t.position.y < 120) {
          t.cooldown = 1;
          continue;
        }
        // A 77 mm shell with a time fuse: aim at where the target will be, badly.
        t.cooldown = rand(2.2, 4);
        const tof = bd / 520;
        const err = (30 + bd * 0.045) * (t.team !== this.homeTeam ? this.level.flak : 1);
        _t1.copy(best.position).addScaledVector(best.velocity, tof * rand(0.7, 1.2)).add(randDir(_t2).multiplyScalar(rand(0.2, 1) * err));
        this.flakBurst(_t1, t.team);
      } else {
        // Streams of rounds at anything low and close.
        const mount = t.model.muzzle;
        t.cooldown = Math.random() < 0.1 ? 1.2 : 1 / 8;
        if (t.kind === 'zeppelin') {
          const guns = (t.model as { gunPositions?: THREE.Vector3[] }).gunPositions ?? [];
          let gp = guns[0] ?? _t3.set(0, 14, 0);
          let gd = Infinity;
          for (const c of guns) {
            _t2.copy(c).applyQuaternion(t.model.root.quaternion).add(t.position);
            const d = _t2.distanceToSquared(best.position);
            if (d < gd) {
              gd = d;
              gp = c;
            }
          }
          _mz.copy(gp).applyQuaternion(t.model.root.quaternion).add(t.position);
        } else {
          _mz.copy(mount ?? _t3.set(0, 1, 0)).applyQuaternion(t.model.root.quaternion).add(t.position);
        }
        const tof = bd / BULLET_SPEED;
        _t1.copy(best.position).addScaledVector(best.velocity, tof);
        _t1.y += 0.5 * BULLET_GRAVITY * tof * tof;
        _aim.subVectors(_t1, _mz).normalize();
        const err = 0.018 * (t.team !== this.homeTeam ? Math.sqrt(this.level.flak) : 1);
        _aim.x += (Math.random() - 0.5) * err * 2;
        _aim.y += (Math.random() - 0.5) * err * 2;
        _aim.z += (Math.random() - 0.5) * err * 2;
        _aim.normalize();
        this.ballistics.fire(_mz, _aim, t.velocity, null, t.team, 4, true);
      }
    }
  }

  /** Archie: flak over enemy-held ground, getting better the longer you loiter. */
  private stepArchie(dt: number): void {
    const p = this.player;
    if (!p || !p.alive) return;
    const agl = p.position.y - this.ground(p.position.x, p.position.z);
    const holder = this.holder(p.position.x, p.position.z);
    if (holder && holder !== p.team && agl > 120) {
      this.overLinesT += dt;
      this.flakT -= dt;
      if (this.flakT <= 0) {
        this.flakT = rand(0.8, 2.1);
        const err = lerp(170, 45, clamp(this.overLinesT / 45, 0, 1)) * this.level.flak;
        _t1.copy(p.position).addScaledVector(p.velocity, rand(0.4, 1.6));
        randDir(_t2).multiplyScalar(rand(0.3, 1) * err);
        _t1.add(_t2);
        this.flakBurst(_t1, holder);
      }
    } else {
      this.overLinesT = Math.max(0, this.overLinesT - dt * 2);
    }
  }

  flakBurst(pos: THREE.Vector3, byTeam: Team): void {
    this.fx.flak(pos, byTeam === 'central');
    this.sfx?.flak(pos);
    const pl = this.player;
    if (pl?.alive && pl.team !== byTeam) {
      const d = pos.distanceTo(pl.position);
      if (d < 260) this.listener.flakNear?.(d);
    }
    for (const q of this.planes) {
      if (!q.alive || q.team === byTeam) continue;
      const d = pos.distanceTo(q.position);
      if (d < 26) q.damage(14 * (1 - d / 26) * (q === pl ? this.level.hurt : 1), null, q.position, this, this.time);
    }
  }

  private collisions(): void {
    const ps = this.planes;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (!b.alive) continue;
        const reach = Math.min(a.radius, b.radius) * 0.75;
        if (a.position.distanceToSquared(b.position) > reach * reach) continue;
        if (a.invuln > 0 || b.invuln > 0) continue;
        if (a.state === 'ground' && b.state === 'ground') continue;
        a.kill(null, this, this.time);
        b.kill(null, this, this.time);
        a.explode(true, this);
        b.explode(true, this);
      }
      for (const t of this.targets) {
        if (t.kind !== 'balloon' && t.kind !== 'zeppelin') continue;
        if (a.position.distanceToSquared(t.position) > (t.reach + 4) ** 2) continue;
        _t1.subVectors(a.position, t.position);
        // Inside any sphere of the envelope is a collision.
        const q = t.model.root.quaternion;
        for (const s of t.spheres) {
          _t2.copy(s.o).applyQuaternion(q).add(t.position);
          if (_t2.distanceToSquared(a.position) < (s.r + 1.5) ** 2) {
            a.crash(this, this.time);
            if (t.alive) t.damage(9999, a, a.position, this);
            break;
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- bombs */

  dropBomb(p: Plane): boolean {
    if (p.bombs <= 0 || !p.alive || p.state === 'ground') return false;
    p.bombs--;
    this.bombs.push({
      pos: p.position.clone().addScaledVector(p.up, -0.9),
      vel: p.velocity.clone(),
      owner: p, team: p.team, alive: true,
    });
    if (p.isPlayer) {
      this.stats.bombs++;
      this.sfx?.bombRelease();
    }
    return true;
  }

  private stepBombs(dt: number): void {
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vel.y -= 9.81 * dt;
      b.vel.multiplyScalar(1 - 0.02 * dt);
      b.pos.addScaledVector(b.vel, dt);
      const gh = this.ground(b.pos.x, b.pos.z);
      if (b.pos.y > gh) continue;
      b.pos.y = gh;
      this.bombs.splice(i, 1);
      this.fx.explosion(b.pos, 0.8, true);
      this.sfx?.explosion(b.pos, 1.2);
      this.listener.bombImpact?.(b.pos, b.owner);
      const R = 24;
      for (const t of this.targets) {
        if (!t.alive || t.team === b.team) continue;
        const d = t.position.distanceTo(b.pos);
        if (d < R + t.reach * 0.5) t.damage(110 * (1 - clamp(d / (R + t.reach * 0.5), 0, 1)) + 10, b.owner, t.position, this);
      }
      for (const p of this.planes) {
        if (!p.alive || p.state !== 'ground' || p.team === b.team) continue;
        const d = p.position.distanceTo(b.pos);
        if (d < R) p.damage(120 * (1 - d / R), b.owner, p.position, this, this.time);
      }
    }
  }

  /* --------------------------------------------------- plane / target events */

  hit(plane: Plane, point: THREE.Vector3, attacker: Plane | null): void {
    this.fx.sparks(point, plane.velocity);
    this.sfx?.hit(point, plane.isPlayer);
    if (plane.isPlayer) {
      this.listener.playerHit?.(1);
      this.stats.damageTaken++;
    } else if (attacker?.isPlayer) {
      this.listener.playerScored?.('hit');
      this.sfx?.hitConfirm();
    }
  }

  killed(plane: Plane, killer: Plane | null): void {
    if (killer?.isPlayer && plane.team !== killer.team) this.stats.kills++;
    this.listener.planeDown?.(plane, killer);
  }

  exploded(plane: Plane, midAir: boolean): void {
    const scale = plane.type.mass > 2000 ? 2 : plane.type.mass > 1200 ? 1.4 : 1;
    this.fx.explosion(plane.position, midAir ? scale : scale * 1.3, !midAir);
    this.sfx?.explosion(plane.position, scale * 1.2);
    if (!midAir) this.fx.addEmitter(plane.position, 'wreck', 26, scale);
  }

  landed(plane: Plane): void {
    this.listener.landed?.(plane);
  }

  // TargetHooks
  targetHit(t: Target, point: THREE.Vector3, attacker: Plane | null): void {
    this.fx.sparks(point, t.velocity);
    this.sfx?.hit(point, false);
    if (attacker?.isPlayer) {
      this.listener.playerScored?.('hit');
      this.sfx?.hitConfirm();
    }
  }

  targetDestroyed(t: Target, by: Plane | null): void {
    if (by?.isPlayer) {
      if (t.kind === 'balloon') this.stats.balloons++;
      else if (t.kind !== 'zeppelin') this.stats.ground++;
    }
    if (t.kind === 'balloon') {
      this.fx.explosion(t.position, 1.2);
      this.fx.addEmitter(t.position, 'burning', 9, 2, t.position);
      this.sfx?.balloonBurn(t.position);
      t.velocity.set(0, -1, 0);
    } else if (t.kind === 'zeppelin') {
      this.fx.explosion(t.position, 3.5);
      const len = (t.model as { length?: number }).length ?? 160;
      for (let i = -2; i <= 2; i++) {
        _t1.set(0, 0, (i * len) / 5).applyQuaternion(t.model.root.quaternion).add(t.position);
        this.fx.addEmitter(_t1, 'burning', 14, 4);
      }
      this.sfx?.explosion(t.position, 3);
    } else {
      this.fx.explosion(t.position, t.kind === 'dump' ? 2.2 : 1.1, true);
      this.fx.addEmitter(t.position, 'wreck', t.kind === 'dump' ? 60 : 32, t.kind === 'hangar' || t.kind === 'dump' ? 2 : 1);
      this.sfx?.explosion(t.position, t.kind === 'dump' ? 2.4 : 1.2);
    }
    this.listener.targetDestroyed?.(t, by);
  }

  /* --------------------------------------------------------------- render */

  render(alpha: number, dt: number, camera: THREE.Camera): void {
    this.fx.eye.copy(camera.position);
    for (const v of this.visuals.values()) v.update(alpha, dt, this.time, this.fx);
    for (const t of this.targets) t.update(dt, this.time, this.ground);
    // Burning balloons shed flame as they fall.
    for (const t of this.targets) {
      if (t.kind === 'balloon' && !t.alive && t.deadT < 6 && t.model.root.visible) this.fx.balloonFire(t.position, 14);
      if (t.kind === 'zeppelin' && !t.alive && t.deadT < 20) {
        t.velocity.y = Math.max(t.velocity.y - 1.2 * dt, -14);
        t.position.addScaledVector(t.velocity, dt);
        if (Math.random() < 0.6) {
          const len = (t.model as { length?: number }).length ?? 160;
          _t1.set(rand(-6, 6), rand(-4, 8), rand(-0.5, 0.5) * len).applyQuaternion(t.model.root.quaternion).add(t.position);
          this.fx.balloonFire(_t1, 20);
        }
        if (t.position.y < this.ground(t.position.x, t.position.z) + 5) {
          t.velocity.set(0, 0, 0);
          if (t.model.root.visible) {
            this.fx.explosion(t.position, 3);
            this.sfx?.explosion(t.position, 3);
          }
          t.model.root.visible = false;
        }
      }
    }
    // Remove long-dead machines.
    for (let i = this.planes.length - 1; i >= 0; i--) {
      const p = this.planes[i];
      if (p.state === 'dead' && p.deadT > 15 && !p.isPlayer) this.remove(p);
    }
    this.renderBombs();
    this.renderBeams();
    const spark = this.fx.spark;
    const tracerGlow = (pos: THREE.Vector3, size: number): void => {
      // One frame's life: redrawn fresh at the round's position every frame.
      spark.spawn(pos.x, pos.y, pos.z, 0, 0, 0, Math.max(dt, 1 / 240) * 1.5, size, size, TRACER_GLOW, TRACER_GLOW, 1, 1, 0, 0);
    };
    this.ballistics.render(camera.position, tracerGlow);
    if (this.barrage > 0) this.stepBarrage(dt, camera.position);
    this.fx.update(dt);
    this.updateAudio();
  }

  private renderBeams(): void {
    for (const t of this.targets) {
      if (t.kind !== 'searchlight') continue;
      let beam = this.beams.get(t);
      if (!beam) {
        if (!this.beamGeo || !this.beamMat) {
          // An open cone, bright at the lamp and fading to nothing 2.5 km out.
          const g = new THREE.CylinderGeometry(55, 0.6, 2500, 20, 8, true);
          g.translate(0, 1250, 0);
          const pos = g.getAttribute('position');
          const col = new Float32Array(pos.count * 3);
          for (let i = 0; i < pos.count; i++) {
            const k = Math.pow(1 - pos.getY(i) / 2500, 2.2);
            col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = k;
          }
          g.setAttribute('color', new THREE.BufferAttribute(col, 3));
          this.beamGeo = g;
          this.beamMat = new THREE.MeshBasicMaterial({
            color: new THREE.Color(1, 0.95, 0.82).multiplyScalar(0.22), vertexColors: true,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
            toneMapped: false, fog: false,
          });
        }
        beam = new THREE.Mesh(this.beamGeo, this.beamMat);
        beam.frustumCulled = false;
        beam.renderOrder = 8;
        this.group.add(beam);
        this.beams.set(t, beam);
      }
      beam.visible = t.alive && this.night > 0.05;
      t.model.setLit?.(beam.visible ? this.night : 0);
      if (!beam.visible) continue;
      beam.position.copy(t.position);
      beam.position.y += 2.2;
      beam.quaternion.setFromUnitVectors(Y_AXIS, t.aim);
    }
    if (this.beamMat) this.beamMat.opacity = Math.min(1, this.night * 1.2);
  }

  private renderBombs(): void {
    let n = 0;
    for (const b of this.bombs) {
      if (n >= 64) break;
      _t1.copy(b.vel).normalize();
      _q.setFromUnitVectors(Z_AXIS, _t1);
      _m.compose(b.pos, _q, _s);
      this.bombMesh.setMatrixAt(n++, _m);
    }
    this.bombMesh.count = n;
    this.bombMesh.instanceMatrix.needsUpdate = true;
  }

  /** Shells landing along the front: dirt, smoke and a thump, near where you're looking. */
  private stepBarrage(dt: number, eye: THREE.Vector3): void {
    this.barrageT -= dt * this.barrage;
    if (this.barrageT > 0) return;
    this.barrageT = rand(0.25, 1.4);
    const x = eye.x + rand(-4500, 4500);
    const z = frontZ(x) + (Math.random() < 0.7 ? rand(-280, 280) : rand(-1500, 1500));
    const y = this.ground(x, z);
    _t1.set(x, y, z);
    if (_t1.distanceTo(eye) > 6500) return;
    this.fx.dirtFountain(_t1, rand(0.7, 1.4));
    this.fx.fire.spawn(x, y + 2, z, 0, 0, 0, 0.18, 4, 16, [1, 0.9, 0.7], [1, 0.6, 0.3], 1, 0, 0, 0);
    this.sfx?.artillery(_t1, rand(0.4, 1));
  }

  private updateAudio(): void {
    const sfx = this.sfx;
    if (!sfx || !sfx.ready) return;
    const p = this.player;
    for (const q of this.planes) {
      if (q.state === 'dead') continue;
      const kind = q.type.mass > 1400 ? 'heavy' : q.type.engine;
      const damaged = 1 - q.engine;
      sfx.engine(q.id, kind, q.position, q.velocity, q.state === 'falling' ? q.rpm * 0.3 : q.rpm, q.throttle, q === p, damaged);
      const v = this.visuals.get(q);
      const firing = (v?.firingT ?? 0) > 0;
      sfx.gunfire(q.id, q.position, q === p, firing, q.team === 'allied' ? 'vickers' : 'spandau');
      if (q.type.gunner) sfx.gunfire(q.id + 100000, q.position, false, (v?.gunnerFiringT ?? 0) > 0, 'lewis');
    }
    for (const t of this.targets) {
      if (t.kind === 'zeppelin' && t.alive) sfx.engine(t.id, 'heavy', t.position, t.velocity, 0.8, 0.8, false, 0);
    }
    if (p && p.alive) sfx.wind(p.speed, p.gload, p.stalled);
    else sfx.wind(0, 1, false);
  }
}
