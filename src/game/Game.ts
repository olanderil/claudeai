import * as THREE from 'three';
import { clamp } from '../util/math';
import { groundHeight } from '../world/Terrain';
import { farAerodrome, frontZ, homeAerodrome, isWater } from '../world/Front';
import { Battle } from '../combat/Battle';
import type { Plane } from '../combat/Plane';
import type { Brain } from '../combat/Brain';
import type { PlaneVisual } from '../combat/PlaneVisual';
import { FIGHTERS, type AirframeId, type Team } from '../combat/Types';
import { DEFAULT_LEVEL, type Level } from '../combat/Levels';
import type { Sfx } from '../audio/Sfx';
import { Mode, type ModeHost, type Report } from './Mode';
import { QuickBattle } from './QuickBattle';
import { MISSIONS, type MissionInfo } from './Campaign';

/**
 * The game around the battle: which mode is running, the player's hands on
 * the stick, target selection, the "watch" autopilot, and the attract-mode
 * dogfight that plays behind the title screen.
 */

export interface StickSource {
  pitch: number;
  roll: number;
  yaw: number;
  throttleAxis: number;
  isDown(code: string): boolean;
  wasPressed(code: string): boolean;
  readonly usingMouse: boolean;
}

export interface PilotSettings {
  pitchSensitivity: number;
  rollSensitivity: number;
  rudderSensitivity: number;
  invertPitch: boolean;
  /** Rudder follows the roll input, for keyboard pilots. */
  autoRudder: boolean;
}

export const DEFAULT_PILOT: PilotSettings = {
  pitchSensitivity: 1,
  rollSensitivity: 1,
  rudderSensitivity: 1,
  invertPitch: false,
  autoRudder: true,
};

export type GameState = 'attract' | 'playing' | 'over';

export interface GameEvents {
  notify(text: string, sub?: string, seconds?: number): void;
  cue(kind: 'objective' | 'fail' | 'victory'): void;
  killCam(subject: { position: THREE.Vector3; velocity: THREE.Vector3 }): void;
  subjectChanged(v: PlaneVisual | null): void;
  hurt(): void;
  /** A flak burst this close to the player, metres. */
  flakNear(distance: number): void;
  hitConfirm(): void;
  report(r: Report): void;
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export class Game {
  readonly battle: Battle;
  mode: Mode | null = null;
  mission: MissionInfo | null = null;
  state: GameState = 'attract';
  target: Plane | null = null;
  targetLocked = false;
  private targetT = 0;
  /** The AI is flying the player's machine (watch mode). */
  autopilot = false;
  readonly pilot: PilotSettings = { ...DEFAULT_PILOT };
  /** The opponents' level for the sorties that follow. */
  level: Level = DEFAULT_LEVEL;
  private kp = 0;
  private kr = 0;
  private ky = 0;
  private attractT = 0;
  /** The machine the camera follows during the attract dogfight. */
  private attractSubject: Plane | null = null;
  private attractSwitchT = 0;
  private reported = false;

  constructor(private readonly events: GameEvents, readonly sfx: Sfx | null) {
    this.battle = new Battle(groundHeight, isWater);
    this.battle.sfx = sfx;
    const host: ModeHost = {
      notify: (t, s, sec) => events.notify(t, s, sec),
      cue: (k) => events.cue(k),
      killCam: (s) => events.killCam(s),
      playerSpawned: (p) => {
        this.target = null;
        this.targetLocked = false;
        if (this.autopilot) this.battle.setBrain(p, 0.7);
        events.subjectChanged(this.battle.visualOf(p) ?? null);
      },
    };
    this.host = host;
    this.battle.listener = {
      planeDown: (p, k) => {
        this.mode?.planeDown(p, k);
        // The title fight has no score to keep, but its kills are still kills.
        if (this.state === 'attract' && k !== null && k === this.attractSubject) {
          events.killCam({ position: p.position, velocity: p.velocity });
        }
      },
      targetDestroyed: (t, by) => this.mode?.targetDestroyed(t, by),
      landed: (p) => this.mode?.landed(p),
      playerHit: () => events.hurt(),
      playerScored: () => events.hitConfirm(),
      gunsJammed: () => events.notify('Guns jammed', 'clearing the stoppage…', 2.2),
      gunsCleared: () => events.notify('Guns cleared', undefined, 1.4),
      flakNear: (d) => events.flakNear(d),
    };
  }

  private readonly host: ModeHost;

  get player(): Plane | null {
    return this.battle.player;
  }

  /** The aircraft the camera should follow. */
  get subject(): PlaneVisual | null {
    const p = this.subjectPlane;
    return p ? this.battle.visualOf(p) ?? null : null;
  }

  /** The machine being filmed: the player's, or the title fight's current star. */
  get subjectPlane(): Plane | null {
    return this.state === 'attract' ? this.attractSubject : this.battle.player;
  }

  /**
   * Who the filmed machine is really fighting, for the camera: when an AI pilot
   * is flying it (watch, the title fight) that is its own target, not the
   * nearest thing in front of the nose.
   */
  get storyTarget(): Plane | null {
    const p = this.subjectPlane;
    const brain = p?.brain as Brain | null | undefined;
    const own = brain?.target ?? null;
    if (this.state === 'attract') return own?.alive ? own : null;
    if (this.autopilot && own?.alive) return own;
    return this.target;
  }

  /* ------------------------------------------------------------- modes */

  startQuickBattle(team: Team, aircraft: AirframeId, livery?: string): void {
    this.begin(new QuickBattle(this.battle, this.host, { team, aircraft, livery }), null);
  }

  startMission(info: MissionInfo, team: Team, aircraft: AirframeId, livery?: string): void {
    this.begin(info.make(this.battle, this.host, { team, aircraft, livery }), info);
  }

  private begin(mode: Mode, mission: MissionInfo | null): void {
    this.battle.clear();
    this.battle.resetTerrain();
    this.battle.level = this.level;
    this.mode = mode;
    this.mission = mission;
    this.state = 'playing';
    this.reported = false;
    this.target = null;
    this.targetLocked = false;
    this.kp = this.kr = this.ky = 0;
    this.centreArena();
    mode.start();
    this.fitArena();
    if (this.autopilot && this.player) this.battle.setBrain(this.player, 0.7);
  }

  /** Aim the arena between the home field and the enemy's. */
  private centreArena(): void {
    const h = homeAerodrome();
    const f = farAerodrome();
    const cx = (h.x + f.x) / 2;
    this.battle.arenaCentre.set(cx, 0, frontZ(cx));
    this.battle.arenaRadius = Math.max(7000, Math.hypot(h.x - f.x, h.z - f.z) * 0.75);
  }

  /** Grow the arena until it holds every target the sortie placed, with room to turn. */
  private fitArena(): void {
    const b = this.battle;
    for (const t of b.targets) {
      const d = Math.hypot(t.position.x - b.arenaCentre.x, t.position.z - b.arenaCentre.z);
      b.arenaRadius = Math.max(b.arenaRadius, d + 1800);
    }
  }

  /** Back to the title-screen dogfight. */
  startAttract(): void {
    this.battle.clear();
    this.battle.resetTerrain();
    this.mode = null;
    this.mission = null;
    this.state = 'attract';
    this.battle.level = DEFAULT_LEVEL;
    this.autopilot = false;
    this.attractT = 0;
    this.attractSubject = null;
    this.centreArena();
    this.maintainAttract(1);
  }

  /** The world under the battle was regenerated: re-seat everything. */
  worldChanged(): void {
    this.battle.resetTerrain();
    if (this.state === 'attract') this.startAttract();
  }

  /** Change the opponents' level; in a sortie it applies to what spawns next. */
  setLevel(level: Level): void {
    this.level = level;
    if (this.state === 'attract') return;
    this.battle.level = level;
    const p = this.player;
    if (p) p.stallGuard = level.stallGuard;
  }

  setAutopilot(on: boolean): void {
    this.autopilot = on;
    const p = this.player;
    if (!p) return;
    if (on) this.battle.setBrain(p, 0.7);
    else p.brain = null;
  }

  /* -------------------------------------------------------------- update */

  fixedUpdate(dt: number, stick: StickSource | null): void {
    if (this.state === 'playing' && stick && !this.autopilot) this.fly(dt, stick);
    this.battle.step(dt);
    if (this.state === 'attract') this.maintainAttract(dt);
  }

  private ordersT = 0;

  /**
   * Watching, the autopilot flies the sortie as a pilot would: straight at
   * the objective the HUD is pointing to — a balloon, a gun pit, the airship
   * — and only turns on fighters that come close. With nothing to point at,
   * it hunts.
   */
  private orderAutopilot(dt: number): void {
    this.ordersT -= dt;
    const p = this.player;
    const brain = p?.brain as Brain | null | undefined;
    if (!p || !p.alive || !brain || this.ordersT > 0) return;
    this.ordersT = 2;
    const marker = this.mode?.objectives.find((o) => o.marker && !o.done && !o.failed)?.marker ?? null;
    const target = marker ? this.battle.targets.find((t) => t.alive && t.position === marker) ?? null : null;
    if (target && target.team !== p.team) {
      const o = brain.orders;
      if (o.kind !== 'attack' || o.target !== target) {
        brain.orders = { kind: 'attack', target, ground: target.kind !== 'balloon' && target.kind !== 'zeppelin' };
      }
    } else if (brain.orders.kind === 'attack') {
      brain.orders = { kind: 'hunt' };
    }
  }

  /** Per rendered frame: modes, targeting, the end of the sortie. */
  frame(dt: number): void {
    const m = this.mode;
    if (this.state === 'playing' && m) {
      m.update(dt);
      if (this.autopilot) this.orderAutopilot(dt);
      this.updateTargeting(dt);
      if (m.status !== 'running' && m.endT <= 0 && !this.reported) {
        this.reported = true;
        this.state = 'over';
        this.events.report(m.report());
      }
    } else if (this.state === 'over' && m) {
      m.update(dt);
    }
  }

  /** Keyboard, mouse and pad into the player's stick. */
  private fly(dt: number, s: StickSource): void {
    const p = this.player;
    if (!p || !p.alive) return;
    const cfg = this.pilot;
    // Keyboards are binary: ease onto full deflection, snap back to centre.
    const rate = (cur: number, tgt: number): number => dt * (tgt === 0 || Math.sign(tgt) !== Math.sign(cur) ? 6 : 2.8);
    const step = (cur: number, tgt: number): number => cur + clamp(tgt - cur, -rate(cur, tgt), rate(cur, tgt));
    const pitchIn = clamp(s.pitch * (cfg.invertPitch ? -1 : 1), -1, 1);
    this.kp = step(this.kp, pitchIn);
    this.kr = step(this.kr, clamp(s.roll, -1, 1));
    this.ky = step(this.ky, clamp(s.yaw, -1, 1));
    p.input.pitch = clamp(this.kp * cfg.pitchSensitivity, -1, 1);
    p.input.roll = clamp(this.kr * cfg.rollSensitivity, -1, 1);
    let yaw = this.ky * cfg.rudderSensitivity;
    if (cfg.autoRudder && Math.abs(s.yaw) < 0.05) yaw += this.kr * 0.25;
    p.input.yaw = clamp(yaw, -1, 1);
    p.throttle = clamp(p.throttle + s.throttleAxis * dt * 0.6, 0, 1);
    p.input.fire = s.isDown('Space') || this.mouseFire || this.padFire;
  }

  /** Set by main from pointer and gamepad state. */
  mouseFire = false;
  padFire = false;

  setThrottle(v: number): void {
    const p = this.player;
    if (p) p.throttle = clamp(v, 0, 1);
  }

  dropBomb(): void {
    const p = this.player;
    if (!p || !p.alive) return;
    if (p.bombs <= 0) {
      this.events.notify('No bombs left', undefined, 1.4);
      return;
    }
    if (p.state === 'ground') return;
    p.input.bomb = true;
  }

  cycleTarget(): void {
    const p = this.player;
    if (!p || !p.alive) return;
    const list = this.battle.planes
      .filter((o) => o.alive && o.team !== p.team && o.role !== 'parked')
      .sort((a, b) => a.position.distanceTo(p.position) - b.position.distanceTo(p.position));
    if (!list.length) return;
    const i = this.target ? list.indexOf(this.target) : -1;
    this.target = list[(i + 1) % list.length];
    this.targetLocked = true;
    this.events.notify('Target', this.target.name, 1.2);
  }

  private updateTargeting(dt: number): void {
    this.battle.assistTarget = this.target;
    const p = this.player;
    if (!p || !p.alive) {
      this.target = null;
      return;
    }
    if (this.target && !this.target.alive) {
      this.target = null;
      this.targetLocked = false;
    }
    this.targetT -= dt;
    if (this.targetLocked || this.targetT > 0) return;
    this.targetT = 0.4;
    let best: Plane | null = null;
    let bs = Infinity;
    const v = new THREE.Vector3();
    for (const o of this.battle.planes) {
      if (!o.alive || o.team === p.team || o.role === 'parked') continue;
      v.subVectors(o.position, p.position);
      const d = v.length();
      if (d > 3500) continue;
      const ang = Math.acos(clamp(v.divideScalar(d).dot(p.fwd), -1, 1));
      const sc = ang * 1500 + d;
      if (sc < bs) {
        bs = sc;
        best = o;
      }
    }
    this.target = best;
  }

  /** The enemy most likely to be shooting at the player right now. */
  threat(p: Plane | null = this.player): Plane | null {
    if (!p || !p.alive) return null;
    const v = new THREE.Vector3();
    let best: Plane | null = null;
    let bd = 700;
    for (const o of this.battle.planes) {
      if (!o.alive || o.team === p.team || o.type.guns === 0) continue;
      v.subVectors(p.position, o.position);
      const d = v.length();
      if (d > bd) continue;
      if (o.fwd.dot(v.divideScalar(d)) > 0.8) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ attract */

  /** Keep a small fight going near the home field for the title screen. */
  private maintainAttract(dt: number): void {
    const b = this.battle;
    this.attractT -= dt;
    this.attractSwitchT -= dt;
    if (!this.attractSubject || !this.attractSubject.alive || this.attractSwitchT <= 0) {
      const alive = b.planes.filter((q) => q.alive);
      // Follow somebody with a fight on their hands: a story needs an enemy.
      const fighting = alive.filter((q) => {
        const t = (q.brain as Brain | null)?.target;
        return t?.alive === true && t.position.distanceTo(q.position) < 1200;
      });
      const next = fighting.length ? pick(fighting) : alive.length ? pick(alive) : null;
      if (next !== this.attractSubject) {
        this.attractSubject = next;
        this.events.subjectChanged(next ? b.visualOf(next) ?? null : null);
      }
      this.attractSwitchT = 24;
    }
    if (this.attractT > 0) return;
    this.attractT = 3;
    const h = homeAerodrome();
    const cx = h.x;
    const cz = (h.z + frontZ(h.x)) / 2;
    const count = (team: Team): number => b.planes.filter((q) => q.team === team && q.alive).length;
    const floor = (x: number, z: number): number => b.ground(x, z) + 450;
    while (count('allied') < 3) {
      const x = cx + rand(-600, 600);
      const z = cz + 900 + rand(-200, 200);
      b.spawn(pick(FIGHTERS.allied), 'allied', { x, y: floor(x, z) + rand(0, 250), z, heading: 0, skill: rand(0.5, 0.8), speed: 45 });
    }
    while (count('central') < 3) {
      const x = cx + rand(-600, 600);
      const z = cz - 900 + rand(-200, 200);
      const liv = Math.random() < 0.3 ? 'red' : 'standard';
      b.spawn(pick(FIGHTERS.central), 'central', { x, y: floor(x, z) + rand(0, 250), z, heading: Math.PI, skill: rand(0.4, 0.75), speed: 45, livery: liv });
    }
  }
}

export { MISSIONS };
