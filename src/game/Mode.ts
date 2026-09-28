import * as THREE from 'three';
import { clamp } from '../util/math';
import { aerodromes, balloonAnchors, farAerodrome, frontTargets, frontZ, homeAerodrome, ridgeClearance, type Aerodrome } from '../world/Front';
import type { Battle, SpawnOptions } from '../combat/Battle';
import type { Orders } from '../combat/Brain';
import type { Plane } from '../combat/Plane';
import { makeBalloon, makeGroundTarget, type Target } from '../combat/Targets';
import { FIGHTERS, TYPES, other, type AirframeId, type Team } from '../combat/Types';

/**
 * What every game mode shares: the player's machine and lives, respawning,
 * the ground crew at the home aerodrome, objectives for the HUD, and the
 * combat report at the end.
 */

export interface Objective {
  text: string;
  /** e.g. "2 / 3". */
  progress?: string;
  done: boolean;
  failed?: boolean;
  optional?: boolean;
  /** Where the HUD should point, if anywhere. */
  marker?: THREE.Vector3 | null;
}

export interface ModeHost {
  notify(text: string, sub?: string, seconds?: number): void;
  /** Soft UI cue. */
  cue(kind: 'objective' | 'fail' | 'victory' | 'alarm'): void;
  /** Ask the camera for a kill cam on this aircraft/target position. */
  killCam(subject: { position: THREE.Vector3; velocity: THREE.Vector3 }): void;
  /** Called after (re)spawn so the camera can snap to the new machine. */
  playerSpawned(p: Plane): void;
}

export interface Report {
  title: string;
  subtitle: string;
  outcome: 'victory' | 'defeat' | 'ended';
  rows: [string, string][];
  remarks: string;
  score: number;
}

export interface ModeConfig {
  team: Team;
  aircraft: AirframeId;
  livery?: string;
}

export const headingTo = (fx: number, fz: number, tx: number, tz: number): number =>
  Math.atan2(-(tx - fx), -(tz - fz));

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export abstract class Mode {
  status: 'running' | 'won' | 'lost' = 'running';
  objectives: Objective[] = [];
  score = 0;
  lives = 3;
  /** Heading shown top-left, e.g. "WAVE 3" or the mission name. */
  abstract readonly title: string;
  time = 0;
  protected respawnT = 0;
  private repairMsgT = 0;
  private boundsMsgT = 0;
  /** Seconds after the end before the report shows, so the last kill plays out. */
  endT = 0;
  readonly team: Team;
  readonly enemy: Team;
  readonly home: Aerodrome;
  readonly far: Aerodrome;

  constructor(protected readonly battle: Battle, protected readonly host: ModeHost, readonly config: ModeConfig) {
    this.team = config.team;
    this.enemy = other(config.team);
    this.home = homeAerodrome();
    this.far = farAerodrome();
    battle.homeTeam = this.team;
  }

  get player(): Plane | null {
    return this.battle.player;
  }

  abstract start(): void;
  protected abstract tick(dt: number): void;
  abstract report(): Report;

  /** Hooks, forwarded from the battle. */
  planeDown(p: Plane, killer: Plane | null): void {
    if (p.isPlayer) {
      this.playerDown();
      return;
    }
    if (p.team === this.enemy) {
      if (killer?.isPlayer) {
        this.host.notify(`${p.name} down`, `+${this.award(p.score)}`, 2.6);
        this.host.killCam({ position: p.position, velocity: p.velocity });
      } else if (killer && killer.team === this.team) {
        this.host.notify('Wingman scored', p.name, 2.2);
      }
    } else if (!p.isPlayer && p.role !== 'parked') {
      this.host.notify(p.role === 'bomber' ? 'A bomber is down' : 'A wingman is down', undefined, 2.4);
    }
  }

  targetDestroyed(t: Target, by: Plane | null): void {
    if (by?.isPlayer && t.team === this.enemy) {
      this.host.notify(`${t.name} destroyed`, `+${this.award(t.score)}`, 2.6);
      if (t.kind === 'balloon' || t.kind === 'zeppelin') this.host.killCam({ position: t.position, velocity: t.velocity });
    }
  }

  /** Add points, weighted by the opponents' level. Returns what was added. */
  protected award(points: number): number {
    const n = Math.round(points * this.battle.level.score);
    this.score += n;
    return n;
  }

  landed(p: Plane): void {
    if (p.isPlayer) this.host.notify('Wheels down', undefined, 1.4);
  }

  protected playerDown(): void {
    this.lives -= 1;
    this.respawnT = 5;
    this.host.notify(this.lives > 0 ? 'Shot down' : 'Shot down — no machines left',
      this.lives > 0 ? `${this.lives} ${this.lives === 1 ? 'machine' : 'machines'} remaining` : undefined, 4.5);
    if (this.lives <= 0) this.lose();
  }

  protected win(): void {
    if (this.status !== 'running') return;
    this.status = 'won';
    this.endT = 3.5;
    this.host.cue('victory');
  }

  protected lose(): void {
    if (this.status !== 'running') return;
    this.status = 'lost';
    this.endT = 4;
    this.host.cue('fail');
  }

  update(dt: number): void {
    this.time += dt;
    if (this.status !== 'running') {
      this.endT -= dt;
      return;
    }
    const p = this.player;
    if (!p || !p.alive) {
      if (this.lives > 0 && this.respawnT > 0) {
        this.respawnT -= dt;
        if (this.respawnT <= 0) this.spawnPlayer(false);
      }
    } else {
      this.refit(p, dt);
      this.bounds(p, dt);
    }
    this.tick(dt);
  }

  /** Ground crew at the home aerodrome patch up and rearm a machine that stops there. */
  private refit(p: Plane, dt: number): void {
    if (p.state !== 'ground' || p.speed > 3) return;
    const fields = aerodromes().filter((a) => this.sideTeam(a.side) === this.team);
    const near = fields.some((a) => Math.hypot(p.position.x - a.x, p.position.z - a.z) < 520);
    if (!near) return;
    const needs = p.hp < p.maxHp || p.gun.ammo < p.gun.maxAmmo || p.engine < 1 || p.bombs < p.type.bombs;
    p.hp = Math.min(p.maxHp, p.hp + 14 * dt);
    p.gun.ammo = Math.min(p.gun.maxAmmo, p.gun.ammo + 160 * dt);
    p.gun.heat = 0;
    p.gun.jam = 0;
    if (p.hp > p.maxHp * 0.6) {
      p.engine = 1;
      p.fire = 0;
    }
    if (p.bombs < p.type.bombs && Math.random() < dt) p.bombs++;
    this.repairMsgT -= dt;
    if (needs && this.repairMsgT <= 0) {
      this.host.notify('Ground crew refitting', 'hold here until they wave you off', 2.2);
      this.repairMsgT = 2.6;
    }
  }

  private bounds(p: Plane, dt: number): void {
    const b = this.battle;
    const d = Math.hypot(p.position.x - b.arenaCentre.x, p.position.z - b.arenaCentre.z);
    if (d > b.arenaRadius + 400) {
      this.boundsMsgT -= dt;
      if (this.boundsMsgT <= 0) {
        this.host.notify('Leaving the sector', 'turn back', 2);
        this.boundsMsgT = 3.5;
      }
    }
  }

  /** Side of the front (+1 south/home, -1 north/far) → team holding it. */
  sideTeam(side: 1 | -1): Team {
    return side === 1 ? this.team : this.enemy;
  }

  /* ---------------------------------------------------------- spawning kit */

  protected spawnPlayer(first: boolean, at?: { x: number; y: number; z: number; heading: number }): Plane {
    const b = this.battle;
    if (b.player) b.remove(b.player);
    const h = this.home;
    const x = at?.x ?? h.x + rand(-80, 80);
    const z = at?.z ?? h.z - 350;
    // High enough to clear whatever ridge stands between the field and the lines.
    const y = at?.y ?? Math.max(b.ground(x, z) + 650, ridgeClearance(x, z, x, frontZ(x)) + 300);
    const heading = at?.heading ?? headingTo(x, z, x, frontZ(x));
    const p = b.spawn(this.config.aircraft, this.team, {
      x, y, z, heading, speed: 46, isPlayer: true, livery: this.config.livery,
    });
    p.throttle = p.rpm = 0.9;
    this.host.playerSpawned(p);
    if (!first) this.host.notify('A fresh machine', `${this.lives} remaining`, 3);
    return p;
  }

  protected wingmen(count: number, skill = 0.6): Plane[] {
    const p = this.player;
    if (!p) return [];
    const slots = [new THREE.Vector3(38, 4, 28), new THREE.Vector3(-38, 6, 30), new THREE.Vector3(70, 10, 55), new THREE.Vector3(-70, 12, 58)];
    const out: Plane[] = [];
    p.axes();
    for (let i = 0; i < count; i++) {
      const s = slots[i % slots.length];
      const x = p.position.x + p.right.x * s.x - p.fwd.x * s.z;
      const z = p.position.z + p.right.z * s.x - p.fwd.z * s.z;
      const type = FIGHTERS[this.team][i % 2 === 0 ? 0 : Math.min(1, FIGHTERS[this.team].length - 1)];
      const w = this.battle.spawn(type, this.team, {
        x, y: p.position.y + s.y, z, heading: Math.atan2(-p.fwd.x, -p.fwd.z),
        speed: p.speed, skill, livery: 'standard', name: 'Wingman',
        orders: { kind: 'escort', leader: p, slot: s, range: 1400 },
      });
      w.velocity.copy(p.velocity);
      out.push(w);
    }
    return out;
  }

  /** A flight of enemy scouts, fanned out, heading at `toward`. */
  protected enemyFlight(count: number, at: THREE.Vector3, toward: THREE.Vector3, skill: number, opts: {
    ace?: boolean; orders?: Orders; types?: AirframeId[]; liveries?: string[];
  } = {}): Plane[] {
    const heading = headingTo(at.x, at.z, toward.x, toward.z);
    const f = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const r = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    const out: Plane[] = [];
    const types = opts.types ?? FIGHTERS[this.enemy];
    const level = this.battle.level;
    count = Math.max(1, count + level.flight);
    for (let i = 0; i < count; i++) {
      const ace = opts.ace === true && i === 0;
      // At the Ace level every formation has a leader of nearly that quality.
      const leader = !ace && i === 0 && level.leaders;
      const lat = (i - (count - 1) / 2) * 60;
      const back = Math.abs(i - (count - 1) / 2) * 35;
      const type = ace ? types[0] : pick(types);
      const extra: Partial<SpawnOptions> = ace
        ? { name: this.enemy === 'central' ? 'Red triplane' : 'Allied ace', hp: 150, score: 400,
          livery: this.enemy === 'central' ? 'red' : 'ace' }
        : leader
          ? { name: this.enemy === 'central' ? 'Staffelführer' : 'Flight commander', hp: 120, score: 220,
            livery: opts.liveries ? pick(opts.liveries) : 'standard' }
          : { livery: opts.liveries ? pick(opts.liveries) : 'standard' };
      out.push(this.battle.spawn(type, this.enemy, {
        x: at.x + r.x * lat - f.x * back,
        y: at.y + rand(-20, 20),
        z: at.z + r.z * lat - f.z * back,
        heading, speed: 45,
        skill: ace ? Math.min(skill + 0.25, 0.97) : leader ? Math.min(skill + 0.15, 0.95) : clamp(skill + rand(-0.08, 0.08), 0.1, 0.92),
        orders: opts.orders, ...extra,
      }));
    }
    return out;
  }

  /** Kite balloons over one side's lines, with an AA gun beside each winch. */
  protected balloons(side: 1 | -1, count = 3, guns = true): Target[] {
    const team = this.sideTeam(side);
    const out: Target[] = [];
    // The sites nearest home first: a balloon 11 km along the line is out of the fight.
    const anchors = balloonAnchors(side)
      .slice()
      .sort((a, b) => Math.hypot(a.x - this.home.x, a.z - this.home.z) - Math.hypot(b.x - this.home.x, b.z - this.home.z))
      .slice(0, count);
    for (const a of anchors) {
      const gy = this.battle.ground(a.x, a.z);
      const t = makeBalloon(team, a.x, gy, a.z, rand(340, 420), -Math.atan2(1.0, 2.4) + Math.PI / 2);
      this.battle.addTarget(t);
      out.push(t);
      const w = makeGroundTarget('winch', team, a.x + 14, gy, a.z + 6, rand(0, 6));
      this.battle.addTarget(w);
      if (guns) {
        const gx = a.x + rand(-160, 160);
        const gz = a.z + rand(90, 200) * side;
        this.battle.addTarget(makeGroundTarget('aagun', team, gx, this.battle.ground(gx, gz), gz, rand(0, 6)));
      }
    }
    return out;
  }

  /** Front-line ground targets of one side. */
  protected groundTargets(side: 1 | -1, kinds?: string[], limit = 99): Target[] {
    const team = this.sideTeam(side);
    const out: Target[] = [];
    const sites = frontTargets(side)
      .slice()
      .sort((a, b) => Math.hypot(a.x - this.home.x, a.z - this.home.z) - Math.hypot(b.x - this.home.x, b.z - this.home.z));
    for (const s of sites) {
      if (kinds && !kinds.includes(s.kind)) continue;
      if (out.length >= limit) break;
      const t = makeGroundTarget(s.kind, team, s.x, this.battle.ground(s.x, s.z), s.z, s.rotY);
      this.battle.addTarget(t);
      out.push(t);
    }
    return out;
  }

  /** Hangars, parked machines and AA at an aerodrome. */
  protected dressAerodrome(a: Aerodrome, parked: number): { hangars: Target[]; planes: Plane[] } {
    const team = this.sideTeam(a.side);
    const hangars: Target[] = [];
    for (const s of a.hangarSlots) {
      const t = makeGroundTarget('hangar', team, s.x, this.battle.ground(s.x, s.z), s.z, s.rotY);
      this.battle.addTarget(t);
      hangars.push(t);
    }
    const planes: Plane[] = [];
    const types = FIGHTERS[team];
    for (const s of a.parkingSlots.slice(0, parked)) {
      const p = this.battle.spawn(pick(types), team, {
        x: s.x, y: 0, z: s.z, heading: s.rotY, parked: true, role: 'parked', score: 50,
      });
      p.name = `Parked ${TYPES[p.type.id].short}`;
      planes.push(p);
    }
    if (a.main) {
      for (let i = 0; i < 2; i++) {
        const gx = a.x + rand(-420, 420);
        const gz = a.z + rand(-420, 420);
        this.battle.addTarget(makeGroundTarget('aagun', team, gx, this.battle.ground(gx, gz), gz, rand(0, 6)));
      }
    }
    return { hangars, planes };
  }

  /** A point over enemy lines ahead of the player, at fighting height. */
  protected enemyApproach(distance = 2400): THREE.Vector3 {
    const p = this.player;
    const from = p?.alive ? p.position : new THREE.Vector3(this.home.x, this.home.elevation + 650, this.home.z);
    const x = clamp(from.x + rand(-700, 700), -4000, 4000);
    let z = from.z - distance;
    const b = this.battle;
    if (Math.hypot(x - b.arenaCentre.x, z - b.arenaCentre.z) > b.arenaRadius) z = from.z + distance * 0.5;
    const y = Math.max(from.y + rand(50, 300), b.ground(x, z) + 450, ridgeClearance(x, z, from.x, from.z) + 200);
    return new THREE.Vector3(x, y, z);
  }

  protected accuracy(): string {
    const s = this.battle.stats;
    return s.rounds > 0 ? `${Math.round((100 * s.hits) / s.rounds)}%` : '—';
  }
}
