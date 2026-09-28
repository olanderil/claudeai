import * as THREE from 'three';
import { clamp } from '../util/math';
import { aerodromes, frontZ } from '../world/Front';
import type { Battle } from '../combat/Battle';
import type { Plane } from '../combat/Plane';
import type { Target } from '../combat/Targets';
import { BULLET_GRAVITY, BULLET_SPEED, type Team } from '../combat/Types';
import type { Objective } from '../game/Mode';

/**
 * The combat HUD. Deliberately sparse: a gunsight where the guns converge,
 * markers on the machines worth knowing about, a lead pip on the one you're
 * fighting, and the handful of numbers a 1917 pilot actually watched — speed,
 * height, gun heat, rounds left. Everything else stays off the glass.
 *
 * Same visual language as the rest of the interface: thin lines, spaced
 * small caps, one warm accent. The enemy is signal cyan and shaped by what
 * it is — a diamond in the air, a circle for a balloon, a square on the
 * ground — so friend, foe and objective read apart at a glance. What's off
 * screen is pointed to from a ring around the sight, and a machine sitting
 * on your tail lights an amber arc on that ring.
 */

const INK = 'rgba(246, 239, 224, 0.94)';
const DIM = 'rgba(246, 239, 224, 0.52)';
const FAINT = 'rgba(246, 239, 224, 0.22)';
const ACCENT = '#f2c46d';
/** Signal cyan: everything of the enemy's, and nothing else. */
const ENEMY = '#5fd4ff';
const ENEMY_SOFT = 'rgba(95, 212, 255, 0.5)';
const FRIEND = 'rgba(246, 239, 224, 0.8)';
/** Someone on your tail. */
const THREAT = '#ffa938';
const WARN = '#ff5f4f';
const SHADOW = 'rgba(8, 10, 12, 0.55)';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** A line for the notice under the top of the screen. */
export interface HudMessage {
  text: string;
  sub?: string;
  tone?: 'warn' | 'info';
}

export interface HudFrame {
  battle: Battle;
  player: Plane | null;
  camera: THREE.PerspectiveCamera;
  target: Plane | null;
  targetLocked: boolean;
  title: string;
  score: number;
  lives: number;
  objectives: Objective[];
  mouseStick: { active: boolean; x: number; y: number } | null;
  cockpit: boolean;
  showMap: boolean;
  time: number;
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _rel = new THREE.Vector3();

interface Proj {
  x: number;
  y: number;
  on: boolean;
  behind: boolean;
  vx: number;
  vy: number;
}

export class CombatHUD {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private scale = 1;
  /** Red at the edges when hit, fading. */
  private hurt = 0;
  /** Hit confirmation on the sight. */
  private hitMark = 0;
  private readonly p1: Proj = { x: 0, y: 0, on: false, behind: false, vx: 0, vy: 0 };
  private readonly p2: Proj = { x: 0, y: 0, on: false, behind: false, vx: 0, vy: 0 };
  /** Where the sight is this frame: the centre of the pointer ring. */
  private sx = 0;
  private sy = 0;
  /** Enemies marked last frame, to catch the moment one goes down. */
  private marked = new Set<Plane>();
  private markedNext = new Set<Plane>();
  private readonly kills: { p: Plane; t: number; r: number }[] = [];
  /** Wingmen's letters, handed out in the order they're first seen. */
  private letters = new WeakMap<Plane, string>();
  private lettered = 0;
  private lastTime = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('HUD requires a 2D canvas context');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  private resize = (): void => {
    this.dpr = Math.min(window.devicePixelRatio, 2);
    this.width = Math.max(1, window.innerWidth);
    this.height = Math.max(1, window.innerHeight);
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.scale = clamp(Math.min(this.width, this.height) / 820, 0.7, 1.25);
  };

  onHurt(amount = 0.35): void {
    this.hurt = Math.min(1, this.hurt + amount);
  }

  onHit(): void {
    this.hitMark = 0.18;
  }

  clear(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.width, this.height);
  }

  draw(f: HudFrame, dt: number): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    this.hurt = Math.max(0, this.hurt - dt * 1.4);
    this.hitMark = Math.max(0, this.hitMark - dt);
    const p = f.player;
    if (f.battle.time < this.lastTime - 0.5) {
      // A new sortie.
      this.letters = new WeakMap();
      this.lettered = 0;
      this.marked.clear();
      this.kills.length = 0;
    }
    this.lastTime = f.battle.time;
    if (this.hurt > 0) this.drawHurt();
    this.drawStatus(f);
    if (!p || !p.alive) {
      this.marked.clear();
      return;
    }
    p.axes();
    _v.copy(p.position).addScaledVector(p.fwd, p.type.converge);
    const sp = this.project(_v, f.camera, this.p1);
    this.sx = sp.behind ? this.width / 2 : clamp(sp.x, this.width * 0.2, this.width * 0.8);
    this.sy = sp.behind ? this.height / 2 : clamp(sp.y, this.height * 0.2, this.height * 0.8);
    this.drawMarkers(f, p, dt);
    this.drawSight(f, p);
    this.drawHeading(p);
    this.drawFlight(p);
    this.drawWeapons(p);
    this.drawWarnings(f, p);
    if (f.showMap) this.drawMap(f, p);
    if (f.mouseStick?.active) this.drawStick(f.mouseStick);
  }

  /* ------------------------------------------------------------ helpers */

  private project(v: THREE.Vector3, cam: THREE.PerspectiveCamera, out: Proj): Proj {
    _w.copy(v).applyMatrix4(cam.matrixWorldInverse);
    out.behind = _w.z > -0.5;
    out.vx = _w.x;
    out.vy = _w.y;
    _w.applyMatrix4(cam.projectionMatrix);
    out.x = (_w.x * 0.5 + 0.5) * this.width;
    out.y = (-_w.y * 0.5 + 0.5) * this.height;
    out.on = !out.behind && out.x > 0 && out.x < this.width && out.y > 0 && out.y < this.height;
    return out;
  }

  private text(str: string, x: number, y: number, color: string, size = 11, align: CanvasTextAlign = 'left', weight = 500): void {
    const ctx = this.ctx;
    ctx.font = `${weight} ${Math.round(size * this.scale)}px ${MONO}`;
    ctx.textAlign = align;
    ctx.fillStyle = SHADOW;
    ctx.fillText(str, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  /** Letter-spaced small caps label. */
  private label(str: string, x: number, y: number, color = DIM, align: CanvasTextAlign = 'left'): void {
    const ctx = this.ctx;
    ctx.save();
    (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${(1.6 * this.scale).toFixed(1)}px`;
    this.text(str.toUpperCase(), x, y, color, 9, align, 600);
    ctx.restore();
  }

  private stroke(color: string, width = 1.3): void {
    const ctx = this.ctx;
    ctx.lineWidth = width + 2;
    ctx.strokeStyle = SHADOW;
    ctx.stroke();
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  /* ------------------------------------------------------------- pieces */

  private drawHurt(): void {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.32, w / 2, h / 2, Math.max(w, h) * 0.72);
    g.addColorStop(0, 'rgba(120, 0, 0, 0)');
    g.addColorStop(1, `rgba(150, 18, 8, ${0.5 * this.hurt})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  private drawSight(f: HudFrame, p: Plane): void {
    const ctx = this.ctx;
    const s = this.scale;
    _v.copy(p.position).addScaledVector(p.fwd, p.type.converge);
    const sp = this.project(_v, f.camera, this.p1);
    if (sp.behind) return;
    const x = sp.x;
    const y = sp.y;
    const R = 15 * s;
    const g = p.gun;
    const jammed = g.jam > 0;
    const col = jammed ? WARN : g.heat > 0.78 ? ACCENT : INK;
    // In the cockpit the aircraft's own ring sight does this job; only the
    // heat arc, the hit mark and the lead pip are drawn over it.
    const own = !f.cockpit;
    ctx.beginPath();
    if (jammed) ctx.setLineDash([3, 4]);
    if (own || jammed) {
      ctx.arc(x, y, R, 0, Math.PI * 2);
      this.stroke(col, 1.2);
    }
    ctx.setLineDash([]);
    if (own) {
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1]] as const) {
        ctx.moveTo(x + dx * R * 1.35, y + dy * R * 1.35);
        ctx.lineTo(x + dx * R * 1.95, y + dy * R * 1.95);
      }
      this.stroke(col, 1.2);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Gun heat as an arc sweeping the ring.
    if (g.heat > 0.05 && !jammed) {
      ctx.beginPath();
      ctx.arc(x, y, R + 4 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * g.heat);
      this.stroke(g.heat > 0.78 ? ACCENT : FAINT, 1.6);
    }
    if (this.hitMark > 0) {
      ctx.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        ctx.moveTo(x + dx * R * 0.5, y + dy * R * 0.5);
        ctx.lineTo(x + dx * R * 0.9, y + dy * R * 0.9);
      }
      this.stroke(ACCENT, 1.8);
    }
    // Lead pip on the target within gun range.
    const t = f.target;
    if (t && t.alive) {
      const d = t.position.distanceTo(p.position);
      if (d < 900) {
        const tof = d / BULLET_SPEED;
        _v.copy(t.position).addScaledVector(_rel.subVectors(t.velocity, p.velocity), tof);
        _v.y += 0.5 * BULLET_GRAVITY * tof * tof;
        const lp = this.project(_v, f.camera, this.p2);
        if (lp.on) {
          const gap = Math.hypot(lp.x - x, lp.y - y);
          const onIt = gap < R * 0.9;
          // A hairline from the sight to the pip: which way to pull, and how far.
          if (gap > R + 8 * s) {
            const ux = (lp.x - x) / gap;
            const uy = (lp.y - y) / gap;
            ctx.save();
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.moveTo(x + ux * (R + 3 * s), y + uy * (R + 3 * s));
            ctx.lineTo(lp.x - ux * 7 * s, lp.y - uy * 7 * s);
            ctx.lineWidth = 1;
            ctx.strokeStyle = ENEMY;
            ctx.stroke();
            ctx.restore();
          }
          ctx.beginPath();
          ctx.arc(lp.x, lp.y, 4.5 * s, 0, Math.PI * 2);
          this.stroke(ENEMY, 1.4);
          if (onIt) {
            ctx.fillStyle = ENEMY;
            ctx.beginPath();
            ctx.arc(lp.x, lp.y, 2.4 * s, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  /**
   * A diamond drawn as four strokes that stop short of the corners: light
   * enough to sit over a distant speck without hiding it.
   */
  private diamond(x: number, y: number, r: number, color: string, lw: number, spin = 0): void {
    const ctx = this.ctx;
    const k0 = 0.2;
    const k1 = 0.8;
    const pts: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      const a = spin + (i * Math.PI) / 2 - Math.PI / 2;
      pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r]);
    }
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % 4];
      ctx.moveTo(ax + (bx - ax) * k0, ay + (by - ay) * k0);
      ctx.lineTo(ax + (bx - ax) * k1, ay + (by - ay) * k1);
    }
    this.stroke(color, lw);
  }

  /** Square for things on the ground, same broken-corner stroke. */
  private square(x: number, y: number, r: number, color: string, lw: number): void {
    const ctx = this.ctx;
    const g = r * 0.34;
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      // Each side, broken at its ends.
      if (sy === -1 || sy === 1) {
        ctx.moveTo(x - r + g, y + sy * r);
        ctx.lineTo(x + r - g, y + sy * r);
      }
      if (sx === -1 || sx === 1) {
        ctx.moveTo(x + sx * r, y - r + g);
        ctx.lineTo(x + sx * r, y + r - g);
      }
    }
    this.stroke(color, lw);
  }

  /** Circle for balloons and the airship. */
  private ring(x: number, y: number, r: number, color: string, lw: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 + Math.PI / 4;
      ctx.moveTo(x + Math.cos(a - 0.62) * r, y + Math.sin(a - 0.62) * r);
      ctx.arc(x, y, r, a - 0.62, a + 0.62);
    }
    this.stroke(color, lw);
  }

  /**
   * The lock: four small arrowheads outside the marker that close in as the
   * target comes into gun range, and sit snug and pulse gently when it's
   * there. Returns how far out they are, for placing the labels.
   */
  private lockTicks(x: number, y: number, r: number, d: number, converge: number, time: number): number {
    const ctx = this.ctx;
    const s = this.scale;
    const near = clamp(1 - (d - converge) / 700, 0, 1);
    const inRange = d < converge * 1.8;
    const off = r + (3 + 20 * (1 - near) + (inRange ? (1 + Math.sin(time * 9)) * 0.8 : 0)) * s;
    const k = (inRange ? 4.6 : 3.8) * s;
    ctx.save();
    ctx.fillStyle = ENEMY;
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 3;
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2 - Math.PI / 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      // Tip toward the target, base outside.
      const tx = x + c * off;
      const ty = y + sn * off;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + c * k * 1.3 - sn * k * 0.8, ty + sn * k * 1.3 + c * k * 0.8);
      ctx.lineTo(tx + c * k * 1.3 + sn * k * 0.8, ty + sn * k * 1.3 - c * k * 0.8);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return off + k * 1.3;
  }

  /** Where the pointer ring sits, and its radius. */
  private ringRadius(): number {
    return Math.min(this.height * 0.3, this.width * 0.4);
  }

  /** Direction on screen (radians, y down) to something projected. */
  private screenAngle(pr: Proj): number {
    let ax = pr.vx;
    let ay = -pr.vy;
    if (pr.behind && Math.abs(ax) + Math.abs(ay) < 1e-3) ay = 1;
    if (!pr.behind && pr.x >= 0 && pr.x <= this.width && pr.y >= 0 && pr.y <= this.height) {
      ax = pr.x - this.sx;
      ay = pr.y - this.sy;
    }
    return Math.atan2(ay, ax);
  }

  /** A pointer on the ring toward something off screen. Returns where it sits. */
  private pointer(pr: Proj, color: string, size: number, alpha: number, solid: boolean): { x: number; y: number; a: number } {
    const ctx = this.ctx;
    const ang = this.screenAngle(pr);
    const R = this.ringRadius();
    const px = this.sx + Math.cos(ang) * R;
    const py = this.sy + Math.sin(ang) * R;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(-size * 0.55, -size * 0.75);
    ctx.lineTo(size * 0.45, 0);
    ctx.lineTo(-size * 0.55, size * 0.75);
    if (solid) {
      ctx.lineTo(-size * 0.2, 0);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      this.stroke(color, 1.6);
    }
    ctx.restore();
    return { x: px, y: py, a: ang };
  }

  /** Text just outside the ring, beside a pointer. */
  private ringLabel(at: { x: number; y: number; a: number }, str: string, color: string): void {
    const o = 20 * this.scale;
    this.text(str, at.x + Math.cos(at.a) * o, at.y + Math.sin(at.a) * o + 4 * this.scale, color, 10, 'center');
  }

  private drawMarkers(f: HudFrame, p: Plane, dt: number): void {
    const s = this.scale;
    const ctx = this.ctx;
    const cam = f.camera;
    const focal = this.height / 2 / Math.tan((cam.fov * Math.PI) / 360);
    const yd = p.team === 'allied';
    const objectiveAt = new Set<THREE.Vector3>();
    for (const o of f.objectives) if (o.marker && !o.done && !o.failed) objectiveAt.add(o.marker);

    // Balloons, the airship and things on the ground.
    for (const t of f.battle.targets) {
      if (!t.alive || t.team === p.team || t.kind === 'winch') continue;
      const d = t.position.distanceTo(p.position);
      const air = t.kind === 'balloon' || t.kind === 'zeppelin';
      const objective = objectiveAt.has(t.position);
      if (!objective && d > (air ? 4500 : 900)) continue;
      const pr = this.project(t.position, cam, this.p2);
      if (!pr.on) continue;
      const r = Math.max((air ? 7 : 5.5) * s, (t.reach / Math.max(d, 1)) * focal * (air ? 0.8 : 1));
      const col = objective || air ? ENEMY : ENEMY_SOFT;
      if (air) this.ring(pr.x, pr.y, r, col, objective ? 1.5 : 1.1);
      else this.square(pr.x, pr.y, r, col, objective ? 1.5 : 1);
      if (objective || d < 1500) this.text(distance(d, yd), pr.x, pr.y + r + 13 * s, col, 10, 'center');
    }

    // Aircraft.
    const next = this.markedNext;
    next.clear();
    for (const o of f.battle.planes) {
      if (o === p || !o.alive) continue;
      const enemy = o.team !== p.team;
      const d = o.position.distanceTo(p.position);
      if (d > 5000 || (!enemy && d > 2500)) continue;
      const parked = o.role === 'parked';
      if (parked && d > 1500) continue;
      const isT = o === f.target;
      const pr = this.project(o.position, cam, this.p2);
      if (enemy) next.add(o);
      if (pr.on) {
        const r = Math.max(8 * s, ((o.radius * 1.1) / d) * focal);
        if (!enemy) {
          // An ivory chevron over a wingman, with his letter.
          let letter = this.letters.get(o);
          if (!letter) {
            letter = 'ABCDEFGHJK'[this.lettered++ % 10];
            this.letters.set(o, letter);
          }
          const cy = pr.y - Math.max(10 * s, r) - 2 * s;
          ctx.beginPath();
          ctx.moveTo(pr.x - 5 * s, cy - 5 * s);
          ctx.lineTo(pr.x, cy);
          ctx.lineTo(pr.x + 5 * s, cy - 5 * s);
          this.stroke(FRIEND, 1.3);
          this.text(letter, pr.x, cy - 9 * s, FRIEND, 9, 'center', 700);
          continue;
        }
        if (parked) {
          this.square(pr.x, pr.y, r, ENEMY_SOFT, 1);
          continue;
        }
        const rr = r * 1.15;
        this.diamond(pr.x, pr.y, rr, ENEMY, isT ? 1.6 : 1.1);
        let ext = rr;
        if (isT) {
          ext = this.lockTicks(pr.x, pr.y, rr, d, p.type.converge, f.time);
          this.label(o.name, pr.x, pr.y - ext - 7 * s, ENEMY, 'center');
        }
        if (isT || d < 1000) this.text(distance(d, yd), pr.x, pr.y + ext + 14 * s, ENEMY, 10, 'center');
      } else if (enemy && !parked && (isT || d < 2500)) {
        const at = this.pointer(pr, ENEMY, (isT ? 11 : 7.5) * s, isT ? 1 : 0.75, isT);
        if (isT) this.ringLabel(at, distance(d, yd), ENEMY);
      }
    }
    // The moment one goes down: its diamond folds in on itself.
    for (const o of this.marked) {
      if (!next.has(o) && !o.alive && o.state !== 'ground') {
        const d = o.position.distanceTo(p.position);
        this.kills.push({ p: o, t: 0, r: Math.max(8 * s, ((o.radius * 1.1) / Math.max(d, 1)) * focal) * 1.15 });
      }
    }
    this.markedNext = this.marked;
    this.marked = next;
    for (let i = this.kills.length - 1; i >= 0; i--) {
      const k = this.kills[i];
      k.t += dt;
      const u = k.t / 0.7;
      if (u >= 1) {
        this.kills.splice(i, 1);
        continue;
      }
      const pr = this.project(k.p.position, cam, this.p2);
      if (!pr.on) continue;
      ctx.save();
      ctx.globalAlpha = 1 - u * u;
      this.diamond(pr.x, pr.y, k.r * (1 - u) ** 2 + 1, ENEMY, 1.8, u * Math.PI * 0.5);
      ctx.beginPath();
      for (let j = 0; j < 4; j++) {
        const a = (j * Math.PI) / 2 + Math.PI / 4;
        const r0 = k.r * (0.4 + u * 1.2);
        const r1 = r0 + k.r * 0.5 * (1 - u);
        ctx.moveTo(pr.x + Math.cos(a) * r0, pr.y + Math.sin(a) * r0);
        ctx.lineTo(pr.x + Math.cos(a) * r1, pr.y + Math.sin(a) * r1);
      }
      this.stroke(INK, 1.4);
      ctx.restore();
    }

    // Objectives: a brass caret over the target, or a pointer on the ring.
    for (const o of f.objectives) {
      if (!o.marker || o.done || o.failed) continue;
      const d = o.marker.distanceTo(p.position);
      const pr = this.project(o.marker, cam, this.p2);
      const target = f.battle.targets.find((t) => t.position === o.marker) ?? null;
      if (pr.on) {
        const lift = target ? Math.max(9 * s, (target.reach / Math.max(d, 1)) * focal) + 8 * s : 0;
        const cy = pr.y - lift;
        const r = 6 * s;
        ctx.beginPath();
        ctx.moveTo(pr.x - r, cy - r * 1.1);
        ctx.lineTo(pr.x, cy);
        ctx.lineTo(pr.x + r, cy - r * 1.1);
        if (!target) {
          ctx.moveTo(pr.x - r, cy + r * 1.1);
          ctx.lineTo(pr.x, cy);
          ctx.lineTo(pr.x + r, cy + r * 1.1);
        }
        this.stroke(ACCENT, 1.6);
        if (!isEnemyTarget(target, p)) this.text(distance(d, yd), pr.x, cy + (target ? 0 : r * 1.1) + 16 * s, ACCENT, 10, 'center');
      } else {
        const at = this.pointer(pr, ACCENT, 10 * s, 0.95, true);
        this.ringLabel(at, distance(d, yd), ACCENT);
      }
    }

    this.drawThreat(f, p);
  }

  /** An amber arc on the ring toward a machine on your tail; it pulses when he fires. */
  private drawThreat(f: HudFrame, p: Plane): void {
    let best: Plane | null = null;
    let bd = 650;
    for (const o of f.battle.planes) {
      if (!o.alive || o.team === p.team || o.type.guns === 0 || o.role === 'parked') continue;
      _rel.subVectors(p.position, o.position);
      const d = _rel.length();
      if (d > bd || d < 1) continue;
      o.axes();
      if (o.fwd.dot(_rel.divideScalar(d)) > 0.85) {
        bd = d;
        best = o;
      }
    }
    if (!best) return;
    const pr = this.project(best.position, f.camera, this.p2);
    const ang = this.screenAngle(pr);
    const R = this.ringRadius();
    const firing = (f.battle.visualOf(best)?.firingT ?? 0) > 0;
    const close = clamp(1 - bd / 650, 0, 1);
    const ctx = this.ctx;
    const span = 0.16 + close * 0.14;
    ctx.save();
    ctx.globalAlpha = firing ? 0.75 + 0.25 * Math.sin(f.time * 30) : 0.45 + close * 0.35;
    ctx.beginPath();
    ctx.arc(this.sx, this.sy, R, ang - span, ang + span);
    ctx.lineCap = 'round';
    this.stroke(THREAT, firing ? 3.2 : 2.2);
    ctx.beginPath();
    ctx.arc(this.sx, this.sy, R - 6 * this.scale, ang - span * 0.6, ang + span * 0.6);
    this.stroke(THREAT, 1);
    ctx.restore();
  }

  private drawHeading(p: Plane): void {
    const ctx = this.ctx;
    const s = this.scale;
    const hdg = ((Math.atan2(p.fwd.x, -p.fwd.z) * 180) / Math.PI + 360) % 360;
    const w = 300 * s;
    const cx = this.width / 2;
    const y = 30 * s;
    const ppd = w / 90;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - w / 2, y - 14 * s, w, 34 * s);
    ctx.clip();
    const NAMES: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    const start = Math.floor((hdg - 50) / 5) * 5;
    ctx.beginPath();
    for (let dg = start; dg <= hdg + 50; dg += 5) {
      const a = ((dg % 360) + 360) % 360;
      const x = cx + (dg - hdg) * ppd;
      const fade = 1 - Math.abs(dg - hdg) / 50;
      if (fade <= 0) continue;
      const big = a % 30 === 0;
      ctx.moveTo(x, y + 12 * s);
      ctx.lineTo(x, y + (big ? 5 : 8.5) * s);
      if (big) {
        ctx.globalAlpha = Math.min(1, fade * 1.6);
        this.text(NAMES[a] ?? String(a / 10).padStart(2, '0'), x, y, NAMES[a] ? INK : DIM, 10, 'center', NAMES[a] ? 700 : 500);
        ctx.globalAlpha = 1;
      }
    }
    this.stroke(DIM, 1);
    ctx.restore();
    ctx.beginPath();
    ctx.moveTo(cx, y + 14 * s);
    ctx.lineTo(cx - 4 * s, y + 20 * s);
    ctx.lineTo(cx + 4 * s, y + 20 * s);
    ctx.closePath();
    ctx.fillStyle = ACCENT;
    ctx.fill();
  }

  private drawFlight(p: Plane): void {
    const s = this.scale;
    const imperial = p.team === 'allied';
    const speed = imperial ? p.speed * 2.23694 : p.speed * 3.6;
    const alt = imperial ? p.position.y * 3.28084 : p.position.y;
    const x = 34 * s;
    const y = this.height - 40 * s;
    this.label('Speed', x, y - 44 * s);
    this.text(`${Math.round(speed)}`, x, y - 22 * s, INK, 22, 'left', 300);
    this.label(imperial ? 'mph' : 'km/h', x + 62 * s, y - 22 * s, DIM);
    this.label('Height', x + 118 * s, y - 44 * s);
    this.text(`${Math.round(alt / (imperial ? 10 : 5)) * (imperial ? 10 : 5)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), x + 118 * s, y - 22 * s, INK, 22, 'left', 300);
    this.label(imperial ? 'ft' : 'm', x + 196 * s, y - 22 * s, DIM);
    // Throttle as a thin rail with the engine speed as a tick.
    const w = 214 * s;
    const ctx = this.ctx;
    ctx.fillStyle = FAINT;
    ctx.fillRect(x, y - 4 * s, w, 2 * s);
    ctx.fillStyle = INK;
    ctx.fillRect(x, y - 4 * s, w * p.throttle, 2 * s);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(x + w * clamp(p.rpm, 0, 1) - 1, y - 8 * s, 2, 10 * s);
    this.label(`Throttle ${Math.round(p.throttle * 100)}%`, x, y + 12 * s);
    this.label(`${Math.round(p.rpm * p.type.rpmMax * (0.97 + 0.03 * Math.sin(performance.now() / 70)))} rpm`, x + w, y + 12 * s, DIM, 'right');
  }

  private drawWeapons(p: Plane): void {
    const s = this.scale;
    const ctx = this.ctx;
    const w = 214 * s;
    const x = this.width - 34 * s - w;
    // Two bars deep, so it sits higher than the flight block and their last
    // labels share a baseline.
    const y = this.height - 66 * s;
    const g = p.gun;
    const jammed = g.jam > 0;
    this.label(jammed ? 'Guns jammed' : 'Rounds', x, y - 44 * s, jammed ? WARN : DIM);
    this.text(`${Math.max(0, Math.floor(g.ammo))}`, x, y - 22 * s, g.ammo < 150 ? ACCENT : INK, 22, 'left', 300);
    if (p.type.bombs > 0) {
      this.label('Bombs', x + w, y - 44 * s, DIM, 'right');
      for (let i = 0; i < p.type.bombs; i++) {
        ctx.beginPath();
        const bx = x + w - i * 11 * s - 4 * s;
        ctx.arc(bx, y - 27 * s, 3.2 * s, 0, Math.PI * 2);
        if (i < p.bombs) {
          ctx.fillStyle = INK;
          ctx.fill();
        } else this.stroke(FAINT, 1);
      }
    }
    const hf = clamp(p.hp / p.maxHp, 0, 1);
    const bar = (yy: number, frac: number, col: string): void => {
      ctx.fillStyle = FAINT;
      ctx.fillRect(x, yy, w, 2 * s);
      ctx.fillStyle = col;
      ctx.fillRect(x, yy, w * frac, 2 * s);
    };
    bar(y - 4 * s, jammed ? 1 : g.heat, jammed ? WARN : g.heat > 0.78 ? ACCENT : INK);
    this.label('Gun heat', x, y + 12 * s);
    bar(y + 22 * s, hf, hf > 0.5 ? INK : hf > 0.25 ? ACCENT : WARN);
    this.label('Airframe', x, y + 38 * s);
    if (p.engine < 0.95) this.label('Engine damaged', x + w, y + 38 * s, ACCENT, 'right');
  }

  private drawStatus(f: HudFrame): void {
    const s = this.scale;
    const x = 34 * s;
    let y = 40 * s;
    this.label(f.title, x, y, INK);
    y += 20 * s;
    this.text(`${f.score}`, x, y, INK, 15, 'left', 300);
    // Lives as small marks after the score.
    const ctx = this.ctx;
    const team: Team = f.player?.team ?? 'allied';
    for (let i = 0; i < f.lives; i++) {
      const cx = x + 84 * s + i * 14 * s;
      const cy = y - 5 * s;
      if (team === 'allied') {
        ctx.fillStyle = 'rgba(40,64,120,0.95)';
        ctx.beginPath(); ctx.arc(cx, cy, 5 * s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(240,236,226,0.95)';
        ctx.beginPath(); ctx.arc(cx, cy, 3.3 * s, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(190,40,32,0.95)';
        ctx.beginPath(); ctx.arc(cx, cy, 1.7 * s, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(240,236,226,0.9)';
        ctx.fillRect(cx - 5 * s, cy - 5 * s, 10 * s, 10 * s);
        ctx.fillStyle = 'rgba(20,20,18,0.95)';
        ctx.fillRect(cx - 1.4 * s, cy - 4.2 * s, 2.8 * s, 8.4 * s);
        ctx.fillRect(cx - 4.2 * s, cy - 1.4 * s, 8.4 * s, 2.8 * s);
      }
    }
    y += 14 * s;
    for (const o of f.objectives) {
      y += 17 * s;
      const col = o.failed ? WARN : o.done ? DIM : INK;
      ctx.beginPath();
      ctx.arc(x + 4 * s, y - 4 * s, 3.4 * s, 0, Math.PI * 2);
      if (o.done) {
        ctx.fillStyle = ACCENT;
        ctx.fill();
      } else this.stroke(o.failed ? WARN : o.optional ? FAINT : DIM, 1);
      this.text(`${o.text}${o.progress ? `  ${o.progress}` : ''}`, x + 14 * s, y, col, 11);
    }
  }

  private drawWarnings(f: HudFrame, p: Plane): void {
    const warn: [string, string][] = [];
    if (p.state === 'flying' && (p.stalled || p.speed < p.stallSpeed * 1.05)) warn.push(['Stall', ACCENT]);
    if (p.state === 'flying' && p.velocity.y < -3) {
      for (const t of [1, 2, 3]) {
        const gx = p.position.x + p.velocity.x * t;
        const gz = p.position.z + p.velocity.z * t;
        if (p.position.y + p.velocity.y * t - f.battle.ground(gx, gz) < 10) {
          warn.push(['Pull up', WARN]);
          break;
        }
      }
    }
    if (p.gun.ammo <= 0) warn.push(['Out of ammunition — land to rearm', ACCENT]);
    if (!warn.length) return;
    if (Math.sin(f.time * 9) < -0.4) return;
    warn.forEach(([t, c], i) => {
      const ctx = this.ctx;
      ctx.save();
      (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${(3 * this.scale).toFixed(1)}px`;
      this.text(t.toUpperCase(), this.width / 2, this.height * 0.68 + i * 22 * this.scale, c, 12, 'center', 700);
      ctx.restore();
    });
  }

  /** Heading-up tactical map: the front, the fields, and who is where. */
  private drawMap(f: HudFrame, p: Plane): void {
    const ctx = this.ctx;
    const s = this.scale;
    const R = 62 * s;
    const cx = this.width - 34 * s - R;
    const cy = 124 * s + R;
    const range = 4000;
    const k = R / range;
    const hdg = Math.atan2(p.fwd.x, -p.fwd.z);
    const cos = Math.cos(-hdg);
    const sin = Math.sin(-hdg);
    const toMap = (x: number, z: number): [number, number] => {
      const dx = x - p.position.x;
      const dz = z - p.position.z;
      return [cx + (dx * cos - dz * sin) * k, cy + (dx * sin + dz * cos) * k];
    };
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8, 12, 14, 0.34)';
    ctx.fill();
    ctx.clip();
    // The front line.
    ctx.beginPath();
    for (let i = -24; i <= 24; i++) {
      const x = p.position.x + i * 250;
      const [mx, my] = toMap(x, frontZ(x));
      if (i === -24) ctx.moveTo(mx, my);
      else ctx.lineTo(mx, my);
    }
    ctx.setLineDash([5 * s, 3 * s]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(214, 120, 90, 0.8)';
    ctx.stroke();
    ctx.setLineDash([]);
    for (const a of aerodromes()) {
      if (!a.main) continue;
      const [mx, my] = toMap(a.x, a.z);
      ctx.strokeStyle = (a.side === 1) === (f.battle.homeTeam === p.team) ? FRIEND : ENEMY;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(mx - 3.5 * s, my - 3.5 * s, 7 * s, 7 * s);
    }
    for (const t of f.battle.targets) {
      if (!t.alive || (t.kind !== 'balloon' && t.kind !== 'zeppelin')) continue;
      const [mx, my] = toMap(t.position.x, t.position.z);
      ctx.fillStyle = t.team === p.team ? FRIEND : ENEMY;
      ctx.beginPath();
      ctx.arc(mx, my, (t.kind === 'zeppelin' ? 3.6 : 2.4) * s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const o of f.battle.planes) {
      if (o === p || !o.alive || o.role === 'parked') continue;
      const [mx, my] = toMap(o.position.x, o.position.z);
      ctx.fillStyle = o.team === p.team ? FRIEND : ENEMY;
      ctx.beginPath();
      ctx.arc(mx, my, (o === f.target ? 3.2 : 2.2) * s, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const o of f.objectives) {
      if (!o.marker || o.done) continue;
      const [mx, my] = toMap(o.marker.x, o.marker.z);
      ctx.fillStyle = ACCENT;
      ctx.beginPath();
      ctx.moveTo(mx, my - 4 * s);
      ctx.lineTo(mx + 4 * s, my);
      ctx.lineTo(mx, my + 4 * s);
      ctx.lineTo(mx - 4 * s, my);
      ctx.fill();
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = FAINT;
    ctx.stroke();
    // Own aircraft.
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6 * s);
    ctx.lineTo(cx + 4 * s, cy + 4 * s);
    ctx.lineTo(cx, cy + 2 * s);
    ctx.lineTo(cx - 4 * s, cy + 4 * s);
    ctx.closePath();
    ctx.fillStyle = INK;
    ctx.fill();
    // North tick on the rim.
    const nx = cx + Math.sin(-hdg) * (R - 7 * s);
    const ny = cy - Math.cos(-hdg) * (R - 7 * s);
    this.text('N', nx, ny + 4 * s, DIM, 9, 'center', 700);
  }

  private drawStick(m: { x: number; y: number }): void {
    const ctx = this.ctx;
    const s = this.scale;
    const R = Math.min(this.width, this.height) * 0.12;
    const cx = this.width / 2;
    const cy = this.height / 2 + R * 1.6;
    ctx.beginPath();
    ctx.setLineDash([3, 5]);
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    this.stroke(FAINT, 1);
    ctx.setLineDash([]);
    const x = cx + clamp(m.x, -1, 1) * R;
    const y = cy - clamp(m.y, -1, 1) * R;
    ctx.beginPath();
    ctx.moveTo(x - 6 * s, y);
    ctx.lineTo(x + 6 * s, y);
    ctx.moveTo(x, y - 6 * s);
    ctx.lineTo(x, y + 6 * s);
    this.stroke(INK, 1.3);
  }
}

function isEnemyTarget(t: Target | null, p: Plane): boolean {
  return t !== null && t.team !== p.team;
}

function distance(m: number, imperial: boolean): string {
  if (imperial) {
    const yd = m * 1.09361;
    return yd < 1760 ? `${Math.round(yd / 10) * 10} yd` : `${(yd / 1760).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
