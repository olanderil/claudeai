/**
 * Sound effects for Horizon 1917 — every sound synthesised at runtime.
 *
 * The file ships offline as one HTML page, so there are no samples: the bank
 * in `sfx/bank.ts` renders exhaust loops, gunshots, explosions and the rest
 * from noise, damped modes and shock waveforms into AudioBuffers (lazily, a
 * variant at a time in idle callbacks), and this class plays, positions and
 * mixes them.
 *
 * Signal flow:
 *
 *   engines ─┐                                    ui ─────────────┐
 *   wind ────┼─ duck ─┐                                           │
 *   ambient ─┘        ├─ trim → compressor → limiter ─────────────┴→ soft clip → volume → out
 *   guns ─────────────┤
 *   one-shots ────────┤
 *   reverb return ────┘   (every positional voice sends to one convolver)
 *
 * Positional voices run through `Spatial` (air-absorption lowpass, HRTF
 * panner, reverb send). Distance loss, air absorption and doppler are all
 * computed here from the listener pose, since Web Audio dropped doppler and
 * its distance models are too blunt for sounds that must carry for miles.
 *
 * Every public method is a no-op before `init()` or when Web Audio is missing,
 * and none of them throws.
 */

import type * as THREE from 'three';
import type { ClipName, GunKind, UiKind } from './sfx/bank';
import { ClipCache } from './sfx/cache';
import {
  Listener, SPEED_OF_SOUND, Spatial, aim, airCutoff, clamp, clamp01, distGain, fin, type Vec3,
} from './sfx/space';
import { EngineVoice, GunVoice, KINDS, WindVoice, type EngineKind, type EngineReq, type Mix } from './sfx/voices';

export type { EngineKind } from './sfx/voices';
export type { GunKind, UiKind } from './sfx/bank';

type V3 = Pick<THREE.Vector3, 'x' | 'y' | 'z'>;
type Q4 = Pick<THREE.Quaternion, 'x' | 'y' | 'z' | 'w'>;

/** Player + three nearest. */
const MAX_ENGINES = 4;
const MAX_GUNS = 6;
/** One-shots (effects + ambient) alive or pending at once. */
const MAX_SHOTS = 24;
const MAX_AMBIENT = 8;
const MAX_UI = 6;

const GUN_KINDS = new Set<string>(['vickers', 'spandau', 'lewis']);
const UI_LEVEL: Record<string, number | undefined> = {
  select: 0.13, confirm: 0.15, back: 0.13, objective: 0.17, fail: 0.15, victory: 0.16,
};

/** One-shot categories, each with its own voice limit. */
const Cat = { Fx: 0, Amb: 1, Ui: 2 } as const;
type Cat = (typeof Cat)[keyof typeof Cat];

interface Layer {
  name: ClipName;
  gain: number;
  rate: number;
  at?: number;
}

interface Shot {
  cat: Cat;
  srcs: AudioBufferSourceNode[];
  nodes: AudioNode[];
  sp: Spatial | null;
  level: GainNode | null;
  pos: Vec3 | null;
  start: number;
  end: number;
  loud: number;
  killed: boolean;
}

interface SpawnOpts {
  layers: Layer[];
  /** World position, or null for a sound in the cockpit / interface. */
  pos: V3 | null;
  ref: number;
  exp: number;
  level: number;
  verb: number;
  cat: Cat;
  bus: AudioNode;
  /** Delay by distance / speed of sound. */
  travel: boolean;
  /** Listener-space position override (close, visceral sounds). */
  rel?: Vec3;
  /** Air absorption multiplier on the cutoff (1 = physical). */
  air?: number;
}


export class Sfx {
  private ctx: BaseAudioContext | null = null;
  private owned = false;
  private mix: Mix | null = null;
  private clips: ClipCache | null = null;
  private master: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private fxBus: GainNode | null = null;
  private ambBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private verbIn: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private readonly listener = new Listener();
  private _volume = 0.8;
  private _muted = false;
  private frame = 0;
  private dt = 1 / 60;

  private readonly engReqs: EngineReq[] = [];
  private engReqN = 0;
  private readonly engOrder: EngineReq[] = [];
  private readonly engines = new Map<number, EngineVoice>();
  private readonly dying: EngineVoice[] = [];
  private readonly guns = new Map<number, GunVoice>();
  private readonly dyingGuns: GunVoice[] = [];
  private windVoice: WindVoice | null = null;
  private readonly shots: Shot[] = [];
  private lastWhiz = -1;
  private lastConfirm = -1;
  private lastHit = -1;
  private warmPending = false;
  private faults = 0;

  /**
   * Diagnostic tap: the mix after compressor and limiter, before the safety
   * clipper and the volume stage. Connect it to a meter (or, offline, to the
   * destination) to see what the clipper is being asked to do.
   */
  meterTap: AudioNode | null = null;

  constructor() {
    for (let i = 0; i < 64; i++) this.engReqs.push(blankReq());
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create the AudioContext — call from a user gesture. Idempotent (a second
   * call just resumes). Best called on the first click of the title screen:
   * the sound bank then renders in idle time (~1 s) before the first flight,
   * instead of a clip per frame on demand once the action has started.
   * Pass a context to render into it instead (e.g. an OfflineAudioContext,
   * then call `prewarm()`); the caller then owns that context.
   */
  init(context?: BaseAudioContext): void {
    if (this.ctx) {
      this.resume();
      return;
    }
    try {
      let ctx: BaseAudioContext | null = context ?? null;
      if (!ctx) {
        const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const AC = g.AudioContext ?? g.webkitAudioContext;
        if (!AC) return;
        ctx = new AC({ latencyHint: 'interactive' });
        this.owned = true;
      }
      this.ctx = ctx;
      this.build(ctx);
      this.warm();
      this.resume();
    } catch (e) {
      this.teardown();
      this.fault(e);
    }
  }

  get ready(): boolean {
    return this.mix !== null;
  }

  get context(): BaseAudioContext | null {
    return this.ctx;
  }

  get volume(): number {
    return this._volume;
  }

  set volume(v: number) {
    this._volume = clamp01(fin(v, this._volume));
    this.applyMaster();
  }

  get muted(): boolean {
    return this._muted;
  }

  set muted(m: boolean) {
    this._muted = !!m;
    this.applyMaster();
  }

  setVolume(v: number): void {
    this.volume = v;
  }

  toggleMute(): boolean {
    this.muted = !this._muted;
    return this._muted;
  }

  suspend(): void {
    const c = this.realtime();
    if (c && c.state === 'running') c.suspend().catch(() => undefined);
  }

  resume(): void {
    const c = this.realtime();
    if (c && c.state !== 'running' && c.state !== 'closed') c.resume().catch(() => undefined);
  }

  /**
   * Render the whole bank now instead of in idle time. For offline rendering
   * and tests; on a live context this is a few hundred ms of main thread.
   */
  prewarm(): void {
    try {
      this.clips?.all();
      this.attachIr();
    } catch (e) {
      this.fault(e);
    }
  }

  /** Fade out and drop every voice (mission end, back to menu). */
  stopAll(): void {
    const c = this.ctx;
    if (!c || !this.mix) return;
    try {
      const now = c.currentTime;
      for (const v of this.engines.values()) {
        v.release(now);
        this.dying.push(v);
      }
      this.engines.clear();
      for (const g of this.guns.values()) {
        g.release(now);
        this.dyingGuns.push(g);
      }
      this.guns.clear();
      if (this.windVoice) this.windVoice.requested = false;
      for (const s of this.shots) this.kill(s, now);
    } catch (e) {
      this.fault(e);
    }
  }

  /** Tear everything down and close the context if we made it. */
  dispose(): void {
    try {
      const now = this.ctx?.currentTime ?? 0;
      for (const v of this.engines.values()) v.dispose();
      for (const v of this.dying) v.dispose();
      for (const g of this.guns.values()) g.dispose(now);
      for (const g of this.dyingGuns) g.dispose(now);
      this.dyingGuns.length = 0;
      this.windVoice?.dispose();
      for (const s of this.shots) this.freeShot(s);
      this.engines.clear();
      this.dying.length = 0;
      this.guns.clear();
      this.shots.length = 0;
      if (this.owned) (this.ctx as AudioContext | null)?.close().catch(() => undefined);
    } catch {
      /* going away regardless */
    }
    this.teardown();
  }

  /** Counts for a debug overlay. */
  stats(): { engines: number; guns: number; shots: number; bankComplete: boolean } {
    return {
      engines: this.engines.size,
      guns: this.guns.size,
      shots: this.shots.length,
      bankComplete: this.clips?.complete ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  setListener(position: V3, quaternion: Q4, velocity: V3, inCockpit: boolean): void {
    if (!this.mix) return;
    try {
      this.listener.set(position, quaternion, velocity, inCockpit);
    } catch (e) {
      this.fault(e);
    }
  }

  engine(
    id: number, kind: EngineKind, position: V3, velocity: V3,
    rpm: number, throttle: number, isPlayer: boolean, damaged: number,
  ): void {
    if (!this.mix || !KINDS[kind]) return;
    try {
      if (this.engReqN >= this.engReqs.length) {
        // update() is not being called; do not grow without bound.
        if (this.engReqN >= 256) return;
        this.engReqs.push(blankReq());
      }
      const r = this.engReqs[this.engReqN++];
      r.id = id;
      r.kind = kind;
      r.x = fin(position.x);
      r.y = fin(position.y);
      r.z = fin(position.z);
      r.vx = fin(velocity.x);
      r.vy = fin(velocity.y);
      r.vz = fin(velocity.z);
      r.rpm = fin(rpm);
      r.throttle = fin(throttle);
      r.isPlayer = !!isPlayer;
      r.damaged = fin(damaged);
    } catch (e) {
      this.fault(e);
    }
  }

  wind(airspeed: number, gload: number, stall: boolean): void {
    if (!this.mix) return;
    try {
      if (!this.windVoice) {
        const c = this.mix.clips;
        if (!c.ensure('noise.pink') || !c.ensure('noise.white') || !c.ensure('noise.brown')) return;
        this.windVoice = new WindVoice(this.mix, this.ctx!.currentTime);
      }
      const w = this.windVoice;
      w.requested = true;
      w.airspeed = fin(airspeed);
      w.gload = fin(gload, 1);
      w.stall = !!stall;
    } catch (e) {
      this.fault(e);
    }
  }

  /**
   * Continuous gun voice for one aircraft. Call every frame while it matters;
   * `guns` defaults to a synchronised pair for Vickers/Spandau and one Lewis.
   */
  gunfire(id: number, position: V3, isPlayer: boolean, firing: boolean, kind: GunKind, guns?: number): void {
    const mix = this.mix;
    if (!mix || !GUN_KINDS.has(kind)) return;
    try {
      const now = this.ctx!.currentTime;
      let v = this.guns.get(id);
      const n = clamp(Math.round(guns ?? (kind === 'lewis' ? 1 : 2)), 1, 2);
      if (!v) {
        if (!firing) return;
        if (!this.admitGun(position, isPlayer)) return;
        v = new GunVoice(mix, id, kind, n, isPlayer);
        this.guns.set(id, v);
      }
      v.kind = kind;
      v.guns = n;
      v.isPlayer = !!isPlayer;
      v.stamp = this.frame;
      v.target(position.x, position.y, position.z, !!firing, this.dt, now);
    } catch (e) {
      this.fault(e);
    }
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  /** Rounds striking wood, fabric and wire. `onPlayer`: close, with a thud through the seat. */
  hit(position: V3, onPlayer: boolean): void {
    if (!this.mix) return;
    try {
      const now = this.ctx!.currentTime;
      if (onPlayer) {
        // Hits on one's own machine are bunched; thin them so they stay distinct.
        if (now - this.lastHit < 0.035) return;
        this.lastHit = now;
        const d = this.listener.local(fin(position.x), fin(position.y), fin(position.z));
        const rel = { ...this.listener.rel };
        if (d > 0.1) {
          const k = Math.min(1.8, d) / d;
          rel.x *= k;
          rel.y *= k;
          rel.z *= k;
        }
        this.spawn({
          layers: [
            { name: 'hit', gain: 1, rate: 0.9 + 0.2 * Math.random() },
            { name: 'hit.thud', gain: 0.7, rate: 0.9 + 0.2 * Math.random() },
          ],
          pos: null, rel, ref: 1, exp: 1, level: 0.75, verb: 0.04, cat: Cat.Fx, bus: this.fxBus!, travel: false,
        });
      } else {
        this.spawn({
          layers: [{ name: 'hit', gain: 1, rate: 0.85 + 0.3 * Math.random() }],
          pos: position, ref: 5, exp: 1, level: 0.6, verb: 0.15, cat: Cat.Fx, bus: this.fxBus!, travel: true,
        });
      }
    } catch (e) {
      this.fault(e);
    }
  }

  /** A quiet tick when the player's rounds land. */
  hitConfirm(): void {
    if (!this.mix) return;
    try {
      const now = this.ctx!.currentTime;
      if (now - this.lastConfirm < 0.06) return;
      this.lastConfirm = now;
      this.spawn({
        layers: [{ name: 'hit.confirm', gain: 1, rate: 0.95 + 0.1 * Math.random() }],
        pos: null, ref: 1, exp: 1, level: 0.08, verb: 0, cat: Cat.Ui, bus: this.uiBus!, travel: false,
      });
    } catch (e) {
      this.fault(e);
    }
  }

  /** A round passing close: supersonic crack and zip. */
  whiz(position: V3): void {
    if (!this.mix) return;
    try {
      const now = this.ctx!.currentTime;
      if (now - this.lastWhiz < 0.04) return;
      this.lastWhiz = now;
      this.spawn({
        layers: [{ name: 'whiz', gain: 1, rate: 0.9 + 0.25 * Math.random() }],
        pos: position, ref: 4, exp: 1, level: 0.55, verb: 0.05, cat: Cat.Fx, bus: this.fxBus!, travel: false,
      });
    } catch (e) {
      this.fault(e);
    }
  }

  /**
   * Aircraft, balloon or ground target going up; `size` 0.5 (scout) … 3
   * (Zeppelin). Close: crack, boom, debris. Far: the boom and the rolling tail,
   * darkened by the air and arriving distance/343 s late.
   */
  explosion(position: V3, size: number): void {
    if (!this.mix) return;
    try {
      const s = clamp(fin(size, 1), 0.3, 3.5);
      const d = this.distance(position);
      const rate = clamp(1.12 - 0.14 * s, 0.6, 1.1);
      const j = (): number => 1 + 0.06 * (Math.random() - 0.5);
      const layers: Layer[] = [
        { name: 'exp.crack', gain: Math.exp(-d / 350) * 0.9, rate: rate * j() },
        { name: 'exp.boom', gain: 1, rate: rate * j(), at: 0.002 },
        { name: 'exp.tail', gain: 0.75 * (1 + Math.min(1, d / 600)), rate: rate * j(), at: 0.01 },
      ];
      const debris = Math.min(1, s) * Math.exp(-d / 160);
      if (debris > 0.02) layers.push({ name: 'exp.debris', gain: debris * 0.8, rate: j(), at: 0.05 });
      if (s >= 2.5) layers.push({ name: 'balloon', gain: 0.8, rate: 0.75 * j(), at: 0.05 });
      this.spawn({
        layers, pos: position, ref: 25 * s, exp: 0.95, level: 0.85 * Math.sqrt(s), verb: 0.15 + 0.5 * clamp01(d / 800),
        cat: Cat.Fx, bus: this.fxBus!, travel: true,
      });
      if (d < 250) this.duck(clamp01(0.3 * s * (1 - d / 250)), d / SPEED_OF_SOUND);
    } catch (e) {
      this.fault(e);
    }
  }

  /** Anti-aircraft burst. */
  flak(position: V3): void {
    if (!this.mix) return;
    try {
      const d = this.distance(position);
      this.spawn({
        layers: [{ name: 'flak', gain: 1, rate: 0.92 + 0.16 * Math.random() }],
        pos: position, ref: 30, exp: 0.85, level: 0.8, verb: 0.3 + 0.4 * clamp01(d / 600), cat: Cat.Fx, bus: this.fxBus!, travel: true,
      });
      if (d < 60) this.duck(0.25 * (1 - d / 60), d / SPEED_OF_SOUND);
    } catch (e) {
      this.fault(e);
    }
  }

  /** Observation balloon igniting. */
  balloonBurn(position: V3): void {
    if (!this.mix) return;
    try {
      this.spawn({
        layers: [{ name: 'balloon', gain: 1, rate: 0.95 + 0.1 * Math.random() }],
        pos: position, ref: 40, exp: 0.85, level: 0.8, verb: 0.35, cat: Cat.Fx, bus: this.fxBus!, travel: true,
      });
    } catch (e) {
      this.fault(e);
    }
  }

  /** Gun stoppage. */
  jam(): void {
    this.cockpit('jam', 0.35);
  }

  /** Stoppage cleared: cocking handle ratchet and slam. */
  clear(): void {
    this.cockpit('clear', 0.4);
  }

  bombRelease(): void {
    this.cockpit('bomb', 0.35);
  }

  /** Distant barrage; `intensity` ~0..1 (more is allowed). Meant to be called often. */
  artillery(position: V3, intensity: number): void {
    if (!this.mix) return;
    try {
      const k = clamp(fin(intensity, 0.5), 0, 2);
      if (k <= 0) return;
      this.spawn({
        layers: [{ name: 'artillery', gain: 1, rate: 0.85 + 0.3 * Math.random() }],
        pos: position, ref: 250, exp: 0.75, level: 0.45 * Math.pow(k, 0.7), verb: 0.45, cat: Cat.Amb, bus: this.ambBus!, travel: true,
      });
    } catch (e) {
      this.fault(e);
    }
  }

  ui(kind: UiKind): void {
    const level = UI_LEVEL[kind];
    if (!this.mix || !level) return;
    try {
      this.spawn({
        layers: [{ name: `ui.${kind}` as ClipName, gain: 1, rate: 1 }],
        pos: null, ref: 1, exp: 1, level, verb: 0, cat: Cat.Ui, bus: this.uiBus!, travel: false,
      });
    } catch (e) {
      this.fault(e);
    }
  }

  // -------------------------------------------------------------------------
  // Frame commit
  // -------------------------------------------------------------------------

  update(dt: number): void {
    const c = this.ctx;
    if (!c || !this.mix) return;
    try {
      const now = c.currentTime;
      this.dt = clamp(fin(dt, 1 / 60), 1e-3, 0.25);
      this.commitEngines(now);
      this.commitGuns(now);
      if (this.windVoice) {
        this.windVoice.update(now, this.listener);
        this.windVoice.requested = false;
      }
      this.sweepShots(now);
      this.warm();
      this.frame++;
      this.mix.clips.budget = 1;
    } catch (e) {
      this.fault(e);
    }
  }

  private commitEngines(now: number): void {
    const mix = this.mix!;
    const L = this.listener;
    const order = this.engOrder;
    order.length = 0;
    for (let i = 0; i < this.engReqN; i++) {
      const r = this.engReqs[i];
      const K = KINDS[r.kind];
      const d = L.cockpit && r.isPlayer ? 0 : Math.hypot(r.x - L.x, r.y - L.y, r.z - L.z);
      const held = this.engines.get(r.id);
      // Hysteresis: a voice already playing keeps its slot unless clearly outranked.
      r.score = r.isPlayer ? 1e9 : K.level * distGain(d, K.ref) * (0.3 + clamp01(r.rpm)) * (held ? 1.5 : 1);
      order.push(r);
    }
    order.sort(byScore);
    const n = Math.min(order.length, MAX_ENGINES);
    for (let i = 0; i < n; i++) {
      const r = order[i];
      let v = this.engines.get(r.id);
      if (v && v.kind !== r.kind) {
        v.release(now);
        this.dying.push(v);
        this.engines.delete(r.id);
        v = undefined;
      }
      if (!v) {
        // Its loops may not be rendered yet; the voice starts a frame or two later if so.
        const K = KINDS[r.kind];
        if (!mix.clips.ensure(K.hi) || !mix.clips.ensure(K.lo) || !mix.clips.ensure('noise.pink')) continue;
        try {
          v = new EngineVoice(mix, r.id, r.kind, now);
        } catch (e) {
          this.fault(e);
          continue;
        }
        this.engines.set(r.id, v);
      }
      v.stamp = this.frame;
      try {
        v.update(now, this.dt, r, L);
      } catch (e) {
        this.fault(e);
      }
    }
    for (const [id, v] of this.engines) {
      if (v.stamp !== this.frame) {
        v.release(now);
        this.dying.push(v);
        this.engines.delete(id);
      }
    }
    let w = 0;
    for (let i = 0; i < this.dying.length; i++) {
      const v = this.dying[i];
      if (now >= v.endAt) v.dispose();
      else this.dying[w++] = v;
    }
    this.dying.length = w;
    this.engReqN = 0;
  }

  private admitGun(position: V3, isPlayer: boolean): boolean {
    if (this.guns.size < MAX_GUNS) return true;
    const L = this.listener;
    const d = isPlayer ? 0 : Math.hypot(fin(position.x) - L.x, fin(position.y) - L.y, fin(position.z) - L.z);
    let victim: GunVoice | null = null;
    let worst = -1;
    for (const g of this.guns.values()) {
      if (g.isPlayer) continue;
      // Idle voices go first, then the farthest.
      const score = (g.firing ? 0 : 1e6) + g.lastDist;
      if (score > worst) {
        worst = score;
        victim = g;
      }
    }
    if (!victim || (!isPlayer && victim.firing && victim.lastDist <= d)) return false;
    victim.release(this.ctx!.currentTime);
    this.dyingGuns.push(victim);
    this.guns.delete(victim.id);
    return true;
  }

  private commitGuns(now: number): void {
    for (const [id, g] of this.guns) {
      if (g.stamp !== this.frame) g.firing = false;
      try {
        g.update(now, this.listener);
      } catch (e) {
        this.fault(e);
        g.firing = false;
      }
      if (!g.firing && now - g.lastFiring > 1.5) {
        g.dispose(now);
        this.guns.delete(id);
      }
    }
    let w = 0;
    for (let i = 0; i < this.dyingGuns.length; i++) {
      const g = this.dyingGuns[i];
      if (now >= g.endAt) g.dispose(now);
      else this.dyingGuns[w++] = g;
    }
    this.dyingGuns.length = w;
  }

  // -------------------------------------------------------------------------
  // One-shot machinery
  // -------------------------------------------------------------------------

  private cockpit(name: ClipName, level: number): void {
    if (!this.mix) return;
    try {
      this.spawn({
        layers: [{ name, gain: 1, rate: 0.97 + 0.06 * Math.random() }],
        pos: null, rel: { x: 0.15, y: -0.35, z: -0.8 }, ref: 1, exp: 1,
        level: level * (this.listener.cockpit ? 1 : 0.45), verb: 0.02, cat: Cat.Fx, bus: this.fxBus!, travel: false,
      });
    } catch (e) {
      this.fault(e);
    }
  }

  private distance(p: V3): number {
    const L = this.listener;
    return Math.hypot(fin(p.x) - L.x, fin(p.y) - L.y, fin(p.z) - L.z);
  }

  private spawn(o: SpawnOpts): void {
    const c = this.ctx!;
    const clips = this.clips!;
    const L = this.listener;
    const now = c.currentTime;
    let d = 0;
    let rel: Vec3 | null = o.rel ?? null;
    let pos: Vec3 | null = null;
    if (o.pos) {
      pos = { x: fin(o.pos.x), y: fin(o.pos.y), z: fin(o.pos.z) };
      d = L.local(pos.x, pos.y, pos.z);
      rel = L.rel;
    }
    const g = o.level * (o.pos ? distGain(d, o.ref, o.exp) : 1);
    if (!(g > 3e-4)) return;
    const t0 = now + 0.004 + (o.travel ? d / SPEED_OF_SOUND : 0);
    if (!this.admit(o.cat, g, now)) return;

    const shot: Shot = { cat: o.cat, srcs: [], nodes: [], sp: null, level: null, pos, start: t0, end: t0, loud: g, killed: false };
    let dest: AudioNode;
    if (rel) {
      const sp = new Spatial(c, o.bus, this.verbIn!, this.mix!.hrtf && d < 150, g);
      const cutoff = o.pos ? Math.min(20000, airCutoff(d) * (o.air ?? 1)) : 20000;
      sp.place(rel, g, o.verb, cutoff);
      shot.sp = sp;
      dest = sp.input;
    } else {
      const lv = c.createGain();
      lv.gain.value = g;
      lv.connect(o.bus);
      shot.level = lv;
      dest = lv;
    }
    for (const l of o.layers) {
      if (!(l.gain > 1e-3)) continue;
      const buf = clips.pick(l.name);
      if (!buf) continue;
      const src = c.createBufferSource();
      src.buffer = buf;
      const rate = clamp(fin(l.rate, 1), 0.25, 4);
      src.playbackRate.value = rate;
      if (Math.abs(l.gain - 1) > 1e-3) {
        const lg = c.createGain();
        lg.gain.value = l.gain;
        src.connect(lg);
        lg.connect(dest);
        shot.nodes.push(lg);
      } else {
        src.connect(dest);
      }
      const at = t0 + (l.at ?? 0);
      src.start(at);
      shot.srcs.push(src);
      shot.end = Math.max(shot.end, at + buf.duration / rate);
    }
    if (shot.srcs.length === 0) {
      this.freeShot(shot);
      return;
    }
    this.shots.push(shot);
  }

  /** Voice limiting: when full, the quietest (allowing for decay) makes way — or the newcomer is dropped. */
  private admit(cat: Cat, loud: number, now: number): boolean {
    let total = 0;
    let inCat = 0;
    let qAll: Shot | null = null;
    let qAllL = Infinity;
    let qCat: Shot | null = null;
    let qCatL = Infinity;
    for (const s of this.shots) {
      if (s.killed) continue;
      const age = now - s.start;
      const eff = age <= 0 ? s.loud : s.loud * Math.exp(-age / Math.max(0.3, (s.end - s.start) * 0.35));
      if (s.cat !== Cat.Ui) {
        total++;
        if (eff < qAllL) {
          qAllL = eff;
          qAll = s;
        }
      }
      if (s.cat === cat) {
        inCat++;
        if (eff < qCatL) {
          qCatL = eff;
          qCat = s;
        }
      }
    }
    const catMax = cat === Cat.Amb ? MAX_AMBIENT : cat === Cat.Ui ? MAX_UI : MAX_SHOTS;
    if (inCat >= catMax && qCat) {
      if (qCatL >= loud) return false;
      this.kill(qCat, now);
      if (cat !== Cat.Ui) total--;
    }
    if (cat !== Cat.Ui && total >= MAX_SHOTS && qAll && !qAll.killed) {
      if (qAllL >= loud) return false;
      this.kill(qAll, now);
    }
    return true;
  }

  private kill(s: Shot, now: number): void {
    if (s.killed) return;
    s.killed = true;
    const p = s.sp ? s.sp.input.gain : s.level?.gain;
    if (p) {
      p.cancelScheduledValues(now);
      p.setTargetAtTime(0, now, 0.01);
    }
    for (const src of s.srcs) {
      try {
        src.stop(now + 0.06);
      } catch {
        /* ignore */
      }
    }
    s.end = Math.min(s.end, now + 0.08);
  }

  private freeShot(s: Shot): void {
    for (const src of s.srcs) {
      try {
        src.stop();
      } catch {
        /* ignore */
      }
      src.disconnect();
    }
    for (const n of s.nodes) n.disconnect();
    s.sp?.dispose();
    s.level?.disconnect();
  }

  private sweepShots(now: number): void {
    const L = this.listener;
    let w = 0;
    for (let i = 0; i < this.shots.length; i++) {
      const s = this.shots[i];
      if (now > s.end + 0.05) {
        this.freeShot(s);
        continue;
      }
      // The explosion stays where it was as the listener turns and flies on.
      if (s.pos && s.sp && !s.killed) {
        L.local(s.pos.x, s.pos.y, s.pos.z);
        aim(s.sp.panner, L.rel, now, 0.03);
      }
      this.shots[w++] = s;
    }
    this.shots.length = w;
  }

  private duck(amount: number, delay: number): void {
    const g = this.duckGain;
    const c = this.ctx;
    if (!g || !c || amount <= 0.01) return;
    const t = c.currentTime + delay;
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(1 - clamp(amount, 0, 0.6), t, 0.01);
    g.gain.setTargetAtTime(1, t + 0.2, 0.5);
  }

  // -------------------------------------------------------------------------
  // Graph
  // -------------------------------------------------------------------------

  private build(c: BaseAudioContext): void {
    const gain = (v: number): GainNode => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    const master = (this.master = gain(this._muted ? 0 : this._volume));
    master.connect(c.destination);

    // Last line of defence: linear to 0.8, then a tanh knee that never passes 0.99.
    const clipIn = gain(0.5);
    const clipper = c.createWaveShaper();
    const N = 4096;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = ((i / (N - 1)) * 2 - 1) * 2;
      const a = Math.abs(x);
      const y = a < 0.8 ? a : 0.8 + 0.19 * Math.tanh((a - 0.8) / 0.19);
      curve[i] = Math.sign(x) * y;
    }
    clipper.curve = curve;
    clipper.oversample = '2x';
    clipIn.connect(clipper);
    clipper.connect(master);

    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -4.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;
    limiter.connect(clipIn);
    this.meterTap = limiter;

    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    comp.connect(limiter);

    // Chrome's compressor adds automatic makeup gain; this trims the mix back.
    const trim = gain(0.5);
    trim.connect(comp);

    const duck = (this.duckGain = gain(1));
    duck.connect(trim);
    const engineBus = gain(1);
    const windBus = gain(1);
    const ambBus = (this.ambBus = gain(1));
    engineBus.connect(duck);
    windBus.connect(duck);
    ambBus.connect(duck);
    const gunBus = gain(1);
    gunBus.connect(trim);
    const fxBus = (this.fxBus = gain(1));
    fxBus.connect(trim);
    const uiBus = (this.uiBus = gain(1));
    uiBus.connect(limiter);

    const verbIn = (this.verbIn = gain(1));
    const conv = (this.convolver = c.createConvolver());
    conv.normalize = false;
    const verbOut = gain(0.6);
    verbIn.connect(conv);
    conv.connect(verbOut);
    verbOut.connect(trim);

    let hrtf = true;
    try {
      const p = c.createPanner();
      p.panningModel = 'HRTF';
      hrtf = p.panningModel === 'HRTF';
    } catch {
      hrtf = false;
    }

    const clips = (this.clips = new ClipCache(c));
    let propWave: PeriodicWave | null = null;
    let whineWave: PeriodicWave | null = null;
    try {
      // Blade-pass: a pulse per blade, harmonics falling a little slower than a saw.
      const n = 18;
      const re = new Float32Array(n);
      const im = new Float32Array(n);
      for (let k = 1; k < n; k++) im[k] = Math.pow(k, -1.15) * (k % 2 ? 1 : 0.75);
      propWave = c.createPeriodicWave(re, im);
      const wr = new Float32Array(9);
      const wi = new Float32Array([0, 1, 0.5, 0.6, 0.25, 0.3, 0.12, 0.1, 0.05]);
      whineWave = c.createPeriodicWave(wr, wi);
    } catch {
      /* oscillators fall back to built-in shapes */
    }

    this.mix = {
      ctx: c, clips, listener: this.listener, hrtf,
      engineBus, gunBus, windBus, verb: verbIn, propWave, whineWave,
    };
  }

  private attachIr(): void {
    const conv = this.convolver;
    if (!conv || conv.buffer || !this.clips) return;
    // The reverb waits until its impulse is rendered in idle time.
    if (!this.clips.has('ir')) return;
    try {
      conv.buffer = this.clips.get('ir');
    } catch {
      /* stays dry */
    }
  }

  private warm(): void {
    const clips = this.clips;
    if (!clips || clips.complete || this.warmPending) return;
    const g = globalThis as unknown as {
      requestIdleCallback?: (cb: (d: { timeRemaining(): number; didTimeout?: boolean }) => void, o?: { timeout: number }) => number;
      setTimeout: (cb: () => void, ms: number) => unknown;
    };
    // One variant costs up to ~30 ms, so a step only starts with real idle time
    // in hand — or when the timeout says the page has had none for a second.
    const run = (deadline?: { timeRemaining(): number; didTimeout?: boolean }): void => {
      this.warmPending = false;
      if (!this.clips) return;
      try {
        if (!deadline || deadline.didTimeout || deadline.timeRemaining() > 8) {
          do {
            if (!this.clips.step()) return;
          } while (deadline && deadline.timeRemaining() > 12);
          this.attachIr();
        }
      } catch {
        return;
      }
      this.warm();
    };
    this.warmPending = true;
    if (g.requestIdleCallback) g.requestIdleCallback(run, { timeout: 1000 });
    else g.setTimeout(() => run(), 50);
  }

  private applyMaster(): void {
    const m = this.master;
    const c = this.ctx;
    if (!m || !c) return;
    try {
      m.gain.setTargetAtTime(this._muted ? 0 : this._volume, c.currentTime, 0.03);
    } catch {
      /* ignore */
    }
  }

  private realtime(): AudioContext | null {
    const c = this.ctx as AudioContext | null;
    return c && typeof (c as { close?: unknown }).close === 'function' ? c : null;
  }

  private teardown(): void {
    this.mix = null;
    this.clips = null;
    this.ctx = null;
    this.master = null;
    this.duckGain = null;
    this.fxBus = null;
    this.ambBus = null;
    this.uiBus = null;
    this.verbIn = null;
    this.convolver = null;
    this.meterTap = null;
    this.windVoice = null;
  }

  private fault(e: unknown): void {
    if (this.faults++ < 3) console.warn('[sfx]', e);
  }
}

function blankReq(): EngineReq {
  return {
    id: 0, kind: 'inline', x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    rpm: 0, throttle: 0, isPlayer: false, damaged: 0, score: 0,
  };
}

function byScore(a: EngineReq, b: EngineReq): number {
  return b.score - a.score;
}
