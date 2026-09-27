/**
 * The continuous voices: engines, guns and the player's wind.
 *
 * Each is a small persistent Web Audio graph that `Sfx` steers once a frame.
 * Anything rhythmic — blip-switch cuts, misfires, exhaust pops, gun rounds —
 * is placed on the audio clock a little ahead of time (LOOKAHEAD) rather than
 * triggered from the frame loop, so it stays sample-accurate however uneven
 * the frame rate is.
 */

import { ENGINE_SPECS, type ClipName, type GunKind } from './bank';
import type { ClipCache } from './cache';
import { Spatial, airCutoff, clamp, clamp01, distGain, fin, glide, type Listener, type Vec3 } from './space';

export type EngineKind = 'rotary' | 'inline' | 'heavy';

/** What voices need from the mixer. */
export interface Mix {
  ctx: BaseAudioContext;
  clips: ClipCache;
  listener: Listener;
  hrtf: boolean;
  engineBus: AudioNode;
  gunBus: AudioNode;
  windBus: AudioNode;
  verb: AudioNode;
  propWave: PeriodicWave | null;
  whineWave: PeriodicWave | null;
}

/** How far ahead (s) rhythmic events are committed to the audio clock. Longer than any sane frame. */
export const LOOKAHEAD = 0.12;

const rnd = Math.random;
const gauss = (): number => (rnd() + rnd() + rnd() + rnd() - 2) * 1.732;
const expRand = (mean: number): number => -Math.log(1 - rnd() * 0.999) * mean;

function stopAndDisconnect(sources: AudioScheduledSourceNode[], nodes: AudioNode[]): void {
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      /* never started or already stopped */
    }
  }
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

interface KindSpec {
  rpmMax: number;
  hi: ClipName;
  lo: ClipName;
  refHi: number;
  refLo: number;
  blades: number;
  /** Voice level at `ref` metres. */
  level: number;
  ref: number;
  propTone: number;
  propNoise: number;
  whine: number;
  /** Whine frequency as a multiple of crank rev rate. */
  whineMul: number;
  twin: boolean;
  /** Exhaust-crackle propensity on a closed throttle. */
  crackle: number;
}

export const KINDS: Record<EngineKind, KindSpec> = {
  rotary: {
    rpmMax: 1250, hi: 'eng.rotary.hi', lo: 'eng.rotary.lo',
    refHi: ENGINE_SPECS.rotary.hi.refRpm, refLo: ENGINE_SPECS.rotary.lo.refRpm,
    blades: 2, level: 0.5, ref: 12, propTone: 0.2, propNoise: 0.28, whine: 0.05, whineMul: 18, twin: false, crackle: 0,
  },
  inline: {
    rpmMax: 1700, hi: 'eng.inline.hi', lo: 'eng.inline.lo',
    refHi: ENGINE_SPECS.inline.hi.refRpm, refLo: ENGINE_SPECS.inline.lo.refRpm,
    blades: 2, level: 0.5, ref: 12, propTone: 0.22, propNoise: 0.26, whine: 0.025, whineMul: 12, twin: false, crackle: 1,
  },
  heavy: {
    rpmMax: 1450, hi: 'eng.heavy.hi', lo: 'eng.heavy.lo',
    refHi: ENGINE_SPECS.heavy.hi.refRpm, refLo: ENGINE_SPECS.heavy.lo.refRpm,
    blades: 2, level: 0.5, ref: 22, propTone: 0.26, propNoise: 0.22, whine: 0, whineMul: 0, twin: true, crackle: 0.5,
  },
};

/** One frame's engine() call, pooled. */
export interface EngineReq {
  id: number;
  kind: EngineKind;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rpm: number;
  throttle: number;
  isPlayer: boolean;
  damaged: number;
  score: number;
}

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
  mod: GainNode | null;
  ref: number;
  hi: boolean;
  engine: number;
}

/**
 * One aircraft's engine.
 *
 *   exhaust loops (hi/lo rpm, ×2 for twins) → blip gate → misfire gate ┐
 *   prop: blade-pass oscillator → lowpass (thrum)                       ├→ sum → cockpit shelf → Spatial
 *         pink noise → bandpass → AM at blade-pass (whup)               │
 *   whine: rev-locked oscillator → bandpass                             ┘
 *
 * A ConstantSource ("rateMod") feeds every rpm-locked parameter at once,
 * scaled per destination, so a blip-switch cut sags the whole engine — loops,
 * prop and whine — together.
 */
export class EngineVoice {
  readonly id: number;
  readonly kind: EngineKind;
  stamp = -1;
  dead = false;
  endAt = 0;
  lastDist = 0;

  private readonly mix: Mix;
  private readonly K: KindSpec;
  private readonly sp: Spatial;
  private readonly tone: BiquadFilterNode;
  private readonly sum: GainNode;
  private readonly sputter: GainNode;
  private readonly fire: GainNode;
  private readonly rateMod: ConstantSourceNode | null;
  private readonly loops: Loop[] = [];
  private readonly propOsc: OscillatorNode;
  private readonly propMod: GainNode | null;
  private readonly propTone: GainNode;
  private readonly propBp: BiquadFilterNode;
  private readonly propNoise: GainNode;
  private readonly whineOsc: OscillatorNode | null = null;
  private readonly whineMod: GainNode | null = null;
  private readonly whineGain: GainNode | null = null;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];

  private wander = 0;
  private twinDetune = 0.008;
  private twinTarget = 0.008;
  private blipOn = true;
  private blipNext = 0;
  private sputNext = 0;
  private popNext = 0;
  private thrSlow = 1;
  private chopUntil = 0;

  constructor(mix: Mix, id: number, kind: EngineKind, now: number) {
    this.mix = mix;
    this.id = id;
    this.kind = kind;
    const K = (this.K = KINDS[kind]);
    const c = mix.ctx;
    this.sp = new Spatial(c, mix.engineBus, mix.verb, mix.hrtf, 0);
    this.tone = this.node(c.createBiquadFilter());
    this.tone.type = 'lowshelf';
    this.tone.frequency.value = 160;
    this.tone.gain.value = 0;
    this.sum = this.node(c.createGain());
    this.sputter = this.node(c.createGain());
    this.fire = this.node(c.createGain());
    this.fire.connect(this.sputter);
    this.sputter.connect(this.sum);
    this.sum.connect(this.tone);
    this.tone.connect(this.sp.input);

    let rm: ConstantSourceNode | null = null;
    try {
      rm = c.createConstantSource();
      rm.offset.value = 0;
      rm.start(now);
      this.sources.push(rm);
      this.nodes.push(rm);
    } catch {
      rm = null;
    }
    this.rateMod = rm;

    const offset = rnd();
    const engines = K.twin ? 2 : 1;
    for (let e = 0; e < engines; e++) {
      for (const hi of [true, false]) {
        const buf = mix.clips.get(hi ? K.hi : K.lo);
        if (!buf) continue;
        const src = c.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const gain = this.node(c.createGain());
        gain.gain.value = 0;
        src.connect(gain);
        gain.connect(this.fire);
        let mod: GainNode | null = null;
        if (rm) {
          mod = this.node(c.createGain());
          mod.gain.value = 0;
          rm.connect(mod);
          mod.connect(src.playbackRate);
        }
        src.start(now, ((offset + e * 0.37 + (hi ? 0 : 0.5)) % 1) * buf.duration);
        this.nodes.push(src);
        this.sources.push(src);
        this.loops.push({ src, gain, mod, ref: hi ? K.refHi : K.refLo, hi, engine: e });
      }
    }

    this.propOsc = c.createOscillator();
    if (mix.propWave) this.propOsc.setPeriodicWave(mix.propWave);
    else this.propOsc.type = 'sawtooth';
    this.propOsc.frequency.value = 20;
    this.nodes.push(this.propOsc);
    this.sources.push(this.propOsc);
    this.propMod = null;
    if (rm) {
      this.propMod = this.node(c.createGain());
      this.propMod.gain.value = 0;
      rm.connect(this.propMod);
      this.propMod.connect(this.propOsc.frequency);
    }
    const propLp = this.node(c.createBiquadFilter());
    propLp.type = 'lowpass';
    propLp.frequency.value = 380;
    propLp.Q.value = -3;
    this.propTone = this.node(c.createGain());
    this.propTone.gain.value = 0;
    this.propOsc.connect(propLp);
    propLp.connect(this.propTone);
    this.propTone.connect(this.sum);

    this.propBp = this.node(c.createBiquadFilter());
    this.propBp.type = 'bandpass';
    this.propBp.Q.value = 0.9;
    this.propBp.frequency.value = 600;
    const propAm = this.node(c.createGain());
    propAm.gain.value = 0.55;
    const lfoDepth = this.node(c.createGain());
    lfoDepth.gain.value = 0.45;
    this.propOsc.connect(lfoDepth);
    lfoDepth.connect(propAm.gain);
    this.propNoise = this.node(c.createGain());
    this.propNoise.gain.value = 0;
    const noise = mix.clips.get('noise.pink');
    if (noise) {
      const ns = c.createBufferSource();
      ns.buffer = noise;
      ns.loop = true;
      ns.connect(this.propBp);
      ns.start(now, rnd() * noise.duration);
      this.nodes.push(ns);
      this.sources.push(ns);
    }
    this.propBp.connect(propAm);
    propAm.connect(this.propNoise);
    this.propNoise.connect(this.sum);
    this.propOsc.start(now);

    if (K.whine > 0) {
      const w = (this.whineOsc = c.createOscillator());
      if (mix.whineWave) w.setPeriodicWave(mix.whineWave);
      else w.type = 'triangle';
      w.frequency.value = 200;
      this.nodes.push(w);
      this.sources.push(w);
      if (rm) {
        this.whineMod = this.node(c.createGain());
        this.whineMod.gain.value = 0;
        rm.connect(this.whineMod);
        this.whineMod.connect(w.frequency);
      }
      const bp = this.node(c.createBiquadFilter());
      bp.type = 'bandpass';
      bp.Q.value = 2.5;
      bp.frequency.value = 900;
      this.whineGain = this.node(c.createGain());
      this.whineGain.gain.value = 0;
      w.connect(bp);
      bp.connect(this.whineGain);
      this.whineGain.connect(this.sum);
      w.start(now);
      // The whine band follows the whine's own pitch.
      if (rm) {
        const bpMod = this.node(c.createGain());
        bpMod.gain.value = 0;
        this.whineBpMod = bpMod;
        rm.connect(bpMod);
        bpMod.connect(bp.frequency);
      }
      this.whineBp = bp;
    }
  }

  private whineBp: BiquadFilterNode | null = null;
  private whineBpMod: GainNode | null = null;

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  update(now: number, dt: number, r: EngineReq, L: Listener): void {
    const K = this.K;
    const rpm = clamp01(fin(r.rpm));
    const thr = clamp01(fin(r.throttle));
    const dmg = clamp01(fin(r.damaged));
    const running = rpm > 0.05;
    const rpmAbs = Math.max(rpm, 0.03) * K.rpmMax;
    const cockpit = r.isPlayer && L.cockpit;
    const rel = L.rel;
    let d: number;
    let dop: number;
    if (cockpit) {
      rel.x = 0;
      rel.y = -0.3;
      rel.z = -1.6;
      d = 1.6;
      dop = 1;
    } else {
      d = L.local(r.x, r.y, r.z);
      dop = L.doppler(r.x, r.y, r.z, r.vx, r.vy, r.vz);
    }
    this.lastDist = d;

    // A living engine never holds a perfectly steady rpm.
    const k = Math.min(1, dt * 2.5);
    this.wander += ((rnd() * 2 - 1) * 0.012 - this.wander) * k;
    const base = rpmAbs * dop * (1 + this.wander);
    if (K.twin) {
      // Two unsynchronised engines: the beat between them wanders.
      if (rnd() < dt * 0.25) this.twinTarget = 0.004 + rnd() * 0.012;
      this.twinDetune += (this.twinTarget - this.twinDetune) * Math.min(1, dt * 0.4);
    }

    const x = clamp01(clamp01((rpmAbs - K.refLo) / (K.refHi - K.refLo)) * 0.75 + thr * 0.25);
    const load = running ? (0.35 + 0.65 * thr) * (0.55 + 0.45 * rpm) : 0;
    const gHi = Math.sin((x * Math.PI) / 2) * load * (K.twin ? 0.75 : 1);
    const gLo = Math.cos((x * Math.PI) / 2) * load * (K.twin ? 0.75 : 1);
    for (const l of this.loops) {
      const rate = (base * (l.engine ? 1 + this.twinDetune : 1)) / l.ref;
      glide(l.src.playbackRate, rate, now, 0.05);
      if (l.mod) glide(l.mod.gain, rate, now, 0.05);
      glide(l.gain.gain, l.hi ? gHi : gLo, now, 0.06);
    }

    const bpf = ((K.blades * rpmAbs) / 60) * dop * (1 + this.wander);
    glide(this.propOsc.frequency, bpf, now, 0.05);
    if (this.propMod) glide(this.propMod.gain, bpf, now, 0.05);
    const spin = rpm * rpm;
    glide(this.propTone.gain, K.propTone * spin, now, 0.08);
    glide(this.propNoise.gain, K.propNoise * spin, now, 0.08);
    glide(this.propBp.frequency, (350 + 900 * rpm) * dop, now, 0.1);
    if (this.whineOsc && this.whineGain) {
      const wf = (rpmAbs / 60) * K.whineMul * dop * (1 + this.wander);
      glide(this.whineOsc.frequency, wf, now, 0.05);
      if (this.whineMod) glide(this.whineMod.gain, wf, now, 0.05);
      if (this.whineBp) glide(this.whineBp.frequency, wf * 2.2, now, 0.05);
      if (this.whineBpMod) glide(this.whineBpMod.gain, wf * 2.2, now, 0.05);
      glide(this.whineGain.gain, K.whine * rpm * (cockpit ? 0.6 : 1), now, 0.1);
    }

    glide(this.tone.gain, cockpit ? 5 : 0, now, 0.2);
    const view = r.isPlayer ? (L.cockpit ? 1 : 0.7) : 1;
    const level = this.dead ? 0 : K.level * view * distGain(d, K.ref);
    const verb = cockpit ? 0 : 0.5 * clamp01(0.05 + d / 1500);
    this.sp.steer(now, rel, level, verb, cockpit ? 20000 : airCutoff(d), cockpit ? 0.1 : 0.04);

    this.blip(now, running, thr, d);
    this.misfire(now, running, dmg, d);
    this.crackle(now, dt, running, thr, d);
  }

  /**
   * Rotaries had no real throttle worth the name: below about a third, the
   * pilot held the engine down with the blip switch, cutting the ignition in
   * rhythm. Off: the exhaust goes silent and the rpm sags while the prop
   * windmills on. On: a "brrap" with an overshoot and often a pop.
   */
  private blip(now: number, running: boolean, thr: number, d: number): void {
    const want = running && this.kind === 'rotary' && thr < 0.35;
    if (!want) {
      if (this.blipNext !== 0) {
        this.blipNext = 0;
        this.blipOn = true;
        this.fire.gain.cancelScheduledValues(now);
        this.fire.gain.setTargetAtTime(1, now, 0.01);
        if (this.rateMod) {
          this.rateMod.offset.cancelScheduledValues(now);
          this.rateMod.offset.setTargetAtTime(0, now, 0.1);
        }
      }
      return;
    }
    if (this.blipNext === 0) this.blipNext = now + 0.06 + rnd() * 0.15;
    while (this.blipNext < now + LOOKAHEAD) {
      const t = this.blipNext;
      this.blipOn = !this.blipOn;
      const period = 0.7 + 0.45 * rnd();
      const duty = 0.3 + 0.5 * (thr / 0.35);
      if (this.blipOn) {
        this.fire.gain.setTargetAtTime(1.25, t, 0.004);
        this.fire.gain.setTargetAtTime(1, t + 0.06, 0.08);
        this.rateMod?.offset.setTargetAtTime(0, t, 0.12);
        if (d < 500 && rnd() < 0.55) this.pop(t + 0.004 + rnd() * 0.03, 0.35 + 0.3 * rnd());
        this.blipNext = t + period * duty;
      } else {
        this.fire.gain.setTargetAtTime(0, t, 0.007);
        this.rateMod?.offset.setTargetAtTime(-0.3, t, 0.35);
        this.blipNext = t + period * (1 - duty);
      }
    }
  }

  /** Damage: the engine cuts out in stutters and coughs back with a bang. */
  private misfire(now: number, running: boolean, dmg: number, d: number): void {
    if (!running || dmg <= 0.03) {
      if (this.sputNext !== 0) {
        this.sputNext = 0;
        this.sputter.gain.cancelScheduledValues(now);
        this.sputter.gain.setTargetAtTime(1, now, 0.02);
      }
      return;
    }
    if (this.sputNext === 0) this.sputNext = now + expRand(0.5 / dmg);
    while (this.sputNext < now + LOOKAHEAD) {
      const t = this.sputNext;
      const dur = 0.04 + rnd() * 0.22 * dmg;
      this.sputter.gain.setTargetAtTime(0.06 + 0.3 * (1 - dmg), t, 0.006);
      this.sputter.gain.setTargetAtTime(1, t + dur, 0.02);
      if (d < 500 && rnd() < 0.25 + 0.5 * dmg) this.pop(t + dur + 0.005, 0.5 + 0.4 * rnd());
      this.sputNext = t + dur + expRand(0.25 + 0.6 * (1 - dmg));
    }
  }

  /** Inline and heavy exhausts crackle on a closed or suddenly chopped throttle. */
  private crackle(now: number, dt: number, running: boolean, thr: number, d: number): void {
    this.thrSlow += (thr - this.thrSlow) * Math.min(1, dt * 1.5);
    if (this.K.crackle <= 0 || !running || d > 400) return;
    if (this.thrSlow - thr > 0.25) this.chopUntil = now + 1.2;
    const rate = this.K.crackle * ((thr < 0.3 ? (3 * (0.3 - thr)) / 0.3 : 0) + (now < this.chopUntil ? 9 : 0));
    if (rate < 0.05) return;
    if (this.popNext < now) this.popNext = now + expRand(1 / rate);
    while (this.popNext < now + LOOKAHEAD) {
      this.pop(this.popNext, 0.2 + 0.35 * rnd());
      this.popNext += expRand(1 / rate);
    }
  }

  private pop(t: number, g: number): void {
    const buf = this.mix.clips.pick('crackle');
    if (!buf) return;
    const c = this.mix.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.8 + 0.4 * rnd();
    const gn = c.createGain();
    gn.gain.value = g;
    src.connect(gn);
    gn.connect(this.sum);
    src.onended = () => {
      src.disconnect();
      gn.disconnect();
    };
    src.start(t);
  }

  release(now: number): void {
    if (this.dead) return;
    this.dead = true;
    this.sp.input.gain.cancelScheduledValues(now);
    this.sp.input.gain.setTargetAtTime(0, now, 0.08);
    this.endAt = now + 0.6;
  }

  dispose(): void {
    stopAndDisconnect(this.sources, this.nodes);
    this.sp.dispose();
  }
}

// ---------------------------------------------------------------------------
// Guns
// ---------------------------------------------------------------------------

const GUNS: Record<GunKind, { clip: ClipName; interval: number }> = {
  vickers: { clip: 'gun.vickers', interval: 60 / 455 },
  spandau: { clip: 'gun.spandau', interval: 60 / 485 },
  lewis: { clip: 'gun.lewis', interval: 60 / 560 },
};

export const gunInterval = (k: GunKind): number => GUNS[k].interval;

interface Pending {
  src: AudioBufferSourceNode;
  t: number;
  end: number;
}

/**
 * One aircraft's guns. Rounds are individual buffer sources started on the
 * audio clock at the gun's cyclic rate, each gun free-running with a little
 * mechanical jitter and the second loosely held half a cycle behind the first.
 * Releasing the trigger cancels any round not yet started, so bursts stop dead.
 */
export class GunVoice {
  readonly id: number;
  kind: GunKind;
  guns: number;
  isPlayer: boolean;
  firing = false;
  stamp = -1;
  lastFiring = 0;
  lastDist = 0;

  private readonly mix: Mix;
  private readonly sp: Spatial;
  private readonly thin: BiquadFilterNode;
  private readonly input: GainNode;
  private readonly ins: (StereoPannerNode | null)[] = [];
  private readonly nodes: AudioNode[] = [];
  private readonly next = [0, 0];
  private readonly pend: Pending[] = [];
  private x = 0;
  private y = 0;
  private z = 0;
  private vx = 0;
  private vy = 0;
  private vz = 0;
  private hasPos = false;
  private dop = 1;

  constructor(mix: Mix, id: number, kind: GunKind, guns: number, isPlayer: boolean) {
    this.mix = mix;
    this.id = id;
    this.kind = kind;
    this.guns = guns;
    this.isPlayer = isPlayer;
    const c = mix.ctx;
    this.sp = new Spatial(c, mix.gunBus, mix.verb, mix.hrtf, 0);
    this.thin = c.createBiquadFilter();
    this.thin.type = 'highpass';
    this.thin.Q.value = -3;
    this.thin.frequency.value = 30;
    this.input = c.createGain();
    this.input.connect(this.thin);
    this.thin.connect(this.sp.input);
    this.nodes.push(this.thin, this.input);
    for (let g = 0; g < 2; g++) {
      let p: StereoPannerNode | null = null;
      try {
        p = c.createStereoPanner();
        p.connect(this.input);
        this.nodes.push(p);
      } catch {
        p = null;
      }
      this.ins.push(p);
    }
  }

  /** From gunfire(): where it is and whether the trigger is held. */
  target(x: number, y: number, z: number, firing: boolean, dt: number, now: number): void {
    x = fin(x, this.x);
    y = fin(y, this.y);
    z = fin(z, this.z);
    if (this.hasPos && dt > 1e-3) {
      let vx = (x - this.x) / dt, vy = (y - this.y) / dt, vz = (z - this.z) / dt;
      if (vx * vx + vy * vy + vz * vz > 400 * 400) vx = vy = vz = 0; // a teleport, not a velocity
      this.vx += (vx - this.vx) * 0.3;
      this.vy += (vy - this.vy) * 0.3;
      this.vz += (vz - this.vz) * 0.3;
    }
    this.x = x;
    this.y = y;
    this.z = z;
    this.hasPos = true;
    this.firing = firing;
    if (firing) this.lastFiring = now;
  }

  update(now: number, L: Listener): void {
    const cockpit = this.isPlayer && L.cockpit;
    const rel = L.rel;
    let d: number;
    if (cockpit) {
      rel.x = 0;
      rel.y = -0.25;
      rel.z = -1.3;
      d = 1.3;
      this.dop = 1;
    } else {
      d = L.local(this.x, this.y, this.z);
      this.dop = this.isPlayer ? 1 : L.doppler(this.x, this.y, this.z, this.vx, this.vy, this.vz);
    }
    this.lastDist = d;
    const level = this.isPlayer ? (L.cockpit ? 0.9 : 0.6 * distGain(d, 10)) : 0.75 * distGain(d, 8, 0.92);
    const verb = cockpit ? 0.05 : clamp(0.08 + d / 800, 0, 0.6);
    this.sp.steer(now, rel, level, verb, cockpit ? 20000 : airCutoff(d));
    // Other people's guns: the body is near-field and aimed away, so at range what arrives is the crack.
    glide(this.thin.frequency, cockpit ? 25 : 40 + 650 * clamp01((d - 15) / 300), now, 0.05);
    const spread = cockpit ? 0.25 : 0;
    for (let g = 0; g < 2; g++) {
      const p = this.ins[g];
      if (p) glide(p.pan, this.guns > 1 ? (g ? spread : -spread) : 0, now, 0.05);
    }

    if (this.firing) {
      const iv = GUNS[this.kind].interval;
      for (let g = 0; g < this.guns; g++) {
        if (this.next[g] === 0) this.next[g] = now + 0.008 + (g ? iv * (0.42 + 0.16 * rnd()) : 0);
        // A long frame: resume the rhythm from now rather than machine-gunning the backlog.
        if (this.next[g] < now - 0.03) this.next[g] = now + 0.004;
        while (this.next[g] < now + LOOKAHEAD) {
          this.shot(g, this.next[g]);
          this.next[g] += iv * (1 + 0.012 * gauss());
          if (g === 1) {
            let off = ((this.next[1] - this.next[0]) / iv) % 1;
            if (off < 0) off += 1;
            this.next[1] -= (off - 0.5) * iv * 0.03;
          }
        }
      }
    } else if (this.next[0] !== 0 || this.next[1] !== 0) {
      this.next[0] = 0;
      this.next[1] = 0;
      this.cancel(now);
    }
    this.sweep(now);
  }

  private shot(g: number, t: number): void {
    const buf = this.mix.clips.pick(GUNS[this.kind].clip);
    if (!buf) return;
    const src = this.mix.ctx.createBufferSource();
    src.buffer = buf;
    const rate = this.dop * (1 + 0.015 * gauss());
    src.playbackRate.value = rate;
    src.connect(this.ins[g] ?? this.input);
    src.onended = () => src.disconnect();
    src.start(t);
    this.pend.push({ src, t, end: t + buf.duration / rate });
  }

  /** Rounds scheduled but not yet begun never play. */
  private cancel(now: number): void {
    for (const p of this.pend) {
      if (p.t > now + 0.004) {
        try {
          p.src.stop(0);
        } catch {
          /* ignore */
        }
        p.src.disconnect();
        p.end = 0;
      }
    }
  }

  private sweep(now: number): void {
    let w = 0;
    for (let i = 0; i < this.pend.length; i++) {
      const p = this.pend[i];
      if (p.end > now) this.pend[w++] = p;
    }
    this.pend.length = w;
  }

  dispose(now: number): void {
    this.cancel(now);
    for (const p of this.pend) p.src.disconnect();
    this.pend.length = 0;
    stopAndDisconnect([], this.nodes);
    this.sp.dispose();
  }
}

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

/**
 * The open cockpit: slipstream roar, the flying wires singing (Aeolian tones
 * at f = 0.2·v/d for 3–6.5 mm wire, wobbling as vortex shedding does), and at
 * the stall a shaking low buffet with airframe rattle.
 */
export class WindVoice {
  requested = false;
  airspeed = 0;
  gload = 1;
  stall = false;

  private readonly roarLp: BiquadFilterNode;
  private readonly roar: GainNode;
  private readonly wires: { bp: BiquadFilterNode; g: GainNode; d: number; w: number }[] = [];
  private readonly buffet: GainNode;
  private readonly rattle: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];

  constructor(mix: Mix, now: number) {
    const c = mix.ctx;
    const out = mix.windBus;
    const loopSrc = (name: ClipName): AudioBufferSourceNode | null => {
      const b = mix.clips.get(name);
      if (!b) return null;
      const s = c.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.start(now, rnd() * b.duration);
      this.sources.push(s);
      this.nodes.push(s);
      return s;
    };
    const gain = (v: number): GainNode => {
      const g = c.createGain();
      g.gain.value = v;
      this.nodes.push(g);
      return g;
    };
    const filt = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      this.nodes.push(b);
      return b;
    };

    const pink = loopSrc('noise.pink');
    this.roarLp = filt('lowpass', 800, -3);
    const roarHp = filt('highpass', 60, -3);
    this.roar = gain(0);
    pink?.connect(this.roarLp);
    this.roarLp.connect(roarHp);
    roarHp.connect(this.roar);
    this.roar.connect(out);

    const white = loopSrc('noise.white');
    const wob = c.createOscillator();
    wob.type = 'triangle';
    wob.frequency.value = 3.3;
    const wobDepth = gain(25);
    wob.connect(wobDepth);
    wob.start(now);
    this.sources.push(wob);
    this.nodes.push(wob);
    const dia: [number, number][] = [[0.0032, 1], [0.0046, 0.8], [0.0065, 0.6]];
    for (const [d, w] of dia) {
      const bp = filt('bandpass', 2000, 32);
      const g = gain(0);
      white?.connect(bp);
      wobDepth.connect(bp.detune);
      bp.connect(g);
      g.connect(out);
      this.wires.push({ bp, g, d, w });
    }

    const brown = loopSrc('noise.brown');
    const bLp = filt('lowpass', 75, -3);
    const bBp = filt('bandpass', 190, 1.5);
    const am = gain(0.5);
    const l1 = c.createOscillator();
    l1.type = 'triangle';
    l1.frequency.value = 7.1;
    const l2 = c.createOscillator();
    l2.type = 'sawtooth';
    l2.frequency.value = 12.7;
    const d1 = gain(0.3);
    const d2 = gain(0.2);
    l1.connect(d1);
    l2.connect(d2);
    d1.connect(am.gain);
    d2.connect(am.gain);
    l1.start(now);
    l2.start(now);
    this.sources.push(l1, l2);
    this.nodes.push(l1, l2);
    this.buffet = gain(0);
    this.rattle = gain(0);
    brown?.connect(bLp);
    brown?.connect(bBp);
    bLp.connect(this.buffet);
    bBp.connect(this.rattle);
    this.buffet.connect(am);
    this.rattle.connect(am);
    am.connect(out);
  }

  update(now: number, L: Listener): void {
    const on = this.requested;
    const v = on ? clamp(fin(this.airspeed), 0, 150) : 0;
    const view = L.cockpit ? 1 : 0.45;
    const q = clamp((v / 55) * (v / 55), 0, 2.5);
    glide(this.roar.gain, 0.16 * Math.pow(q, 0.8) * view, now, 0.12);
    glide(this.roarLp.frequency, 250 + 30 * v, now, 0.15);
    const sing = clamp01((v - 28) / 45);
    for (const w of this.wires) {
      glide(w.bp.frequency, Math.max(200, (0.2 * Math.max(v, 10)) / w.d), now, 0.1);
      glide(w.g.gain, 0.9 * sing * sing * w.w * view, now, 0.15);
    }
    const g = fin(this.gload, 1);
    const amt = on ? (this.stall ? 1 : 0.35 * clamp01((Math.abs(g) - 4) / 3)) : 0;
    const sb = L.cockpit ? 1 : 0.5;
    glide(this.buffet.gain, 1.1 * amt * sb, now, 0.08);
    glide(this.rattle.gain, 0.7 * amt * sb * clamp01(v / 30), now, 0.08);
  }

  dispose(): void {
    stopAndDisconnect(this.sources, this.nodes);
  }
}

export type { Vec3 };
