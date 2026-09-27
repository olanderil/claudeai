import * as THREE from 'three';
import { clamp } from '../util/math';
import { segSphere, type Plane } from './Plane';
import type { Team } from './Types';
import { buildGround, buildKiteBalloon, buildZeppelin, type GroundKind, type HitSphere, type ModelRig } from './GroundModels';

/**
 * Everything that can be shot that isn't an aeroplane: observation balloons,
 * the airship, and what stands on the ground — hangars, guns, nests, lorries.
 *
 * Each target owns its model and a set of hit spheres in model space. The
 * battle sweeps rounds against them the same way it does aircraft.
 */

export type TargetKind = GroundKind | 'balloon' | 'zeppelin' | 'parked';

export interface TargetHooks {
  targetHit(t: Target, point: THREE.Vector3, attacker: Plane | null): void;
  targetDestroyed(t: Target, attacker: Plane | null): void;
}

const _p = new THREE.Vector3();
const _w = new THREE.Vector3();

let sequence = 500000;

export class Target {
  /** Stable id (sound voices, markers); above any aircraft id. */
  readonly id = ++sequence;
  readonly kind: TargetKind;
  readonly name: string;
  readonly team: Team;
  readonly model: ModelRig;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly base = new THREE.Vector3();
  readonly spheres: HitSphere[];
  maxHp: number;
  hp: number;
  score: number;
  alive = true;
  /** Seconds since destruction (drives the wreck look and falling). */
  deadT = 0;
  /** Mission tag. */
  role = '';
  /** For balloons: ground winch pulls it down when attacked. */
  winch = 0;
  /** Used by guns on targets (AA, MG, zeppelin gunners). */
  cooldown = Math.random() * 2;
  readonly aim = new THREE.Vector3(0, 1, 0);
  /** Hit radius for the broad phase. */
  readonly reach: number;
  private cable: THREE.Line | null = null;

  constructor(opts: {
    kind: TargetKind; name: string; team: Team; model: ModelRig; position: THREE.Vector3;
    rotY?: number; hp: number; score: number;
  }) {
    this.kind = opts.kind;
    this.name = opts.name;
    this.team = opts.team;
    this.model = opts.model;
    this.position.copy(opts.position);
    this.base.copy(opts.position);
    this.model.root.position.copy(opts.position);
    this.model.root.rotation.y = opts.rotY ?? 0;
    this.model.root.updateMatrixWorld(true);
    this.spheres = opts.model.hitSpheres;
    this.maxHp = this.hp = opts.hp;
    this.score = opts.score;
    let r = 0;
    for (const s of this.spheres) r = Math.max(r, s.o.length() + s.r);
    this.reach = r;
  }

  hitTest(a: THREE.Vector3, b: THREE.Vector3): number {
    // Broad phase: the segment must pass within reach of the origin.
    _p.subVectors(b, a);
    const len2 = _p.lengthSq();
    const t = len2 > 0 ? clamp(_w.subVectors(this.position, a).dot(_p) / len2, 0, 1) : 0;
    if (_w.copy(a).addScaledVector(_p, t).distanceToSquared(this.position) > this.reach * this.reach) return -1;
    let best = -1;
    const q = this.model.root.quaternion;
    for (const s of this.spheres) {
      _w.copy(s.o).applyQuaternion(q).add(this.position);
      const k = segSphere(a, b, _w, s.r);
      if (k >= 0 && (best < 0 || k < best)) best = k;
    }
    return best;
  }

  damage(amount: number, attacker: Plane | null, point: THREE.Vector3, hooks: TargetHooks): void {
    if (!this.alive) return;
    this.hp -= amount;
    hooks.targetHit(this, point, attacker);
    if (this.kind === 'balloon') this.winch = 1;
    if (this.hp <= 0) {
      this.alive = false;
      this.deadT = 0;
      hooks.targetDestroyed(this, attacker);
    }
  }

  /** Tether line for balloons. */
  attachCable(parent: THREE.Object3D, groundY: number): void {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x2a2722, transparent: true, opacity: 0.55 }));
    line.frustumCulled = false;
    line.userData.groundY = groundY;
    parent.add(line);
    this.cable = line;
  }

  update(dt: number, time: number, ground: (x: number, z: number) => number): void {
    const m = this.model;
    if (this.kind === 'balloon') {
      if (this.alive) {
        // Winched down at ~4 m/s once attacked, then back up after a while.
        const floor = ground(this.base.x, this.base.z) + 60;
        if (this.winch > 0) {
          this.position.y = Math.max(floor, this.position.y - 4.2 * dt);
          this.winch = Math.max(0, this.winch - dt / 40);
        } else if (this.position.y < this.base.y) {
          this.position.y = Math.min(this.base.y, this.position.y + 2 * dt);
        }
        const sway = Math.sin(time * 0.4 + this.base.x) * 2;
        m.root.position.set(this.position.x, this.position.y + sway, this.position.z);
      } else {
        this.deadT += dt;
        this.velocity.y -= 3.2 * dt;
        this.position.addScaledVector(this.velocity, dt);
        m.root.position.copy(this.position);
        m.setDestroyed(this.deadT);
        if (this.position.y < ground(this.position.x, this.position.z) + 2) m.root.visible = false;
      }
      if (this.cable) {
        const a = (this.cable.geometry.getAttribute('position') as THREE.BufferAttribute);
        const top = (m as ModelRig & { cableTop?: THREE.Vector3 }).cableTop;
        _w.copy(top ?? new THREE.Vector3(0, -12, 0)).applyQuaternion(m.root.quaternion).add(m.root.position);
        a.setXYZ(0, _w.x, _w.y, _w.z);
        a.setXYZ(1, this.base.x, this.cable.userData.groundY as number, this.base.z);
        a.needsUpdate = true;
        this.cable.visible = this.alive;
      }
    } else if (this.kind === 'zeppelin') {
      m.root.position.copy(this.position);
      if (!this.alive) {
        this.deadT += dt;
        m.setDestroyed(this.deadT);
        // Nose drops as the burning hull breaks its back.
        m.root.rotation.x = Math.min(0.5, this.deadT * 0.05);
      }
    } else if (!this.alive) {
      this.deadT += dt;
      m.setDestroyed(this.deadT);
    }
    m.animate(dt, time, this.alive && this.kind === 'aagun' ? this.aim : undefined);
  }

  dispose(): void {
    this.model.root.removeFromParent();
    this.cable?.removeFromParent();
    this.cable?.geometry.dispose();
    this.model.dispose();
  }
}

/* ---------------------------------------------------------------- factory */

const GROUND_STATS: Record<GroundKind, { name: string; hp: number; score: number }> = {
  hangar: { name: 'Hangar', hp: 70, score: 75 },
  aagun: { name: 'Anti-aircraft gun', hp: 45, score: 60 },
  artillery: { name: 'Artillery battery', hp: 55, score: 70 },
  mgnest: { name: 'Machine-gun nest', hp: 40, score: 50 },
  lorry: { name: 'Supply lorry', hp: 25, score: 30 },
  dump: { name: 'Ammunition dump', hp: 60, score: 90 },
  hq: { name: 'Headquarters', hp: 80, score: 120 },
  hut: { name: 'Hut', hp: 20, score: 15 },
  tent: { name: 'Tent', hp: 12, score: 10 },
  winch: { name: 'Balloon winch', hp: 25, score: 30 },
  searchlight: { name: 'Searchlight', hp: 15, score: 25 },
};

export function makeGroundTarget(kind: GroundKind, team: Team, x: number, y: number, z: number, rotY: number): Target {
  const s = GROUND_STATS[kind];
  return new Target({
    kind, name: s.name, team, model: buildGround(kind, team), position: new THREE.Vector3(x, y, z),
    rotY, hp: s.hp, score: s.score,
  });
}

export function makeBalloon(team: Team, x: number, groundY: number, z: number, height: number, windYaw: number): Target {
  const t = new Target({
    kind: 'balloon', name: 'Kite balloon', team, model: buildKiteBalloon(team),
    position: new THREE.Vector3(x, groundY + height, z), rotY: windYaw, hp: 36, score: 150,
  });
  return t;
}

export function makeZeppelin(team: Team, position: THREE.Vector3, heading: number): Target {
  const t = new Target({
    kind: 'zeppelin', name: 'Zeppelin', team, model: buildZeppelin(), position, rotY: heading, hp: 900, score: 1000,
  });
  return t;
}
