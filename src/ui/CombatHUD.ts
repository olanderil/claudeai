import * as THREE from 'three';
import { clamp } from '../util/math';
import { aerodromes, frontZ } from '../world/Front';
import type { Battle } from '../combat/Battle';
import type { Plane } from '../combat/Plane';
import { BULLET_GRAVITY, BULLET_SPEED, type Team } from '../combat/Types';
import type { Objective } from '../game/Mode';

/**
 * The combat HUD. Deliberately sparse: a gunsight where the guns converge,
 * brackets on the machines worth knowing about, a lead pip on the one you're
 * fighting, and the handful of numbers a 1917 pilot actually watched — speed,
 * height, gun heat, rounds left. Everything else stays off the glass.
 *
 * Same visual language as the rest of the interface: thin lines, spaced
 * small caps, one warm accent.
 */

const INK = 'rgba(246, 239, 224, 0.94)';
const DIM = 'rgba(246, 239, 224, 0.52)';
const FAINT = 'rgba(246, 239, 224, 0.22)';
const ACCENT = '#f2c46d';
const ENEMY = '#ff6a55';
const FRIEND = '#8fc8ff';
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
    if (this.hurt > 0) this.drawHurt();
    this.drawStatus(f);
    if (!p || !p.alive) return;
    p.axes();
    this.drawMarkers(f, p);
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
    ctx.beginPath();
    if (jammed) ctx.setLineDash([3, 4]);
    ctx.arc(x, y, R, 0, Math.PI * 2);
    this.stroke(col, 1.2);
    ctx.setLineDash([]);
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
          const onIt = Math.hypot(lp.x - x, lp.y - y) < R * 0.9;
          ctx.beginPath();
          ctx.arc(lp.x, lp.y, 5 * s, 0, Math.PI * 2);
          this.stroke(ENEMY, 1.4);
          if (onIt) {
            ctx.fillStyle = ENEMY;
            ctx.beginPath();
            ctx.arc(lp.x, lp.y, 2.6 * s, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  private brackets(x: number, y: number, r: number, color: string, lw: number): void {
    const ctx = this.ctx;
    const l = Math.max(4, r * 0.42);
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      ctx.moveTo(x + sx * r, y + sy * (r - l));
      ctx.lineTo(x + sx * r, y + sy * r);
      ctx.lineTo(x + sx * (r - l), y + sy * r);
    }
    this.stroke(color, lw);
  }

  private edgeArrow(pr: Proj, color: string, size: number, alpha: number): { x: number; y: number } {
    const ctx = this.ctx;
    let ax = pr.vx;
    let ay = -pr.vy;
    if (pr.behind && Math.abs(ax) + Math.abs(ay) < 1e-3) ay = 1;
    const ang = Math.atan2(ay, ax);
    const rx = this.width / 2 - 56 * this.scale;
    const ry = this.height / 2 - 56 * this.scale;
    const px = this.width / 2 + Math.cos(ang) * rx;
    const py = this.height / 2 + Math.sin(ang) * ry;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, size * 0.62);
    ctx.lineTo(-size * 0.25, 0);
    ctx.lineTo(-size * 0.6, -size * 0.62);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    return { x: px, y: py };
  }

  private drawMarkers(f: HudFrame, p: Plane): void {
    const s = this.scale;
    const cam = f.camera;
    const focal = this.height / 2 / Math.tan((cam.fov * Math.PI) / 360);
    const yd = p.team === 'allied';
    for (const o of f.battle.planes) {
      if (o === p || !o.alive) continue;
      const enemy = o.team !== p.team;
      const d = o.position.distanceTo(p.position);
      if (d > 5000 || (!enemy && d > 2500)) continue;
      if (o.role === 'parked' && d > 1500) continue;
      const isT = o === f.target;
      const col = enemy ? ENEMY : FRIEND;
      const pr = this.project(o.position, cam, this.p2);
      if (pr.on) {
        const r = Math.max(8 * s, ((o.radius * 1.1) / d) * focal);
        if (enemy) {
          this.brackets(pr.x, pr.y, r, col, isT ? 1.8 : 1);
          if (isT || d < 1100) this.text(distance(d, yd), pr.x, pr.y + r + 13 * s, col, 10, 'center');
          if (isT) this.label(o.name, pr.x, pr.y - r - 7 * s, col, 'center');
        } else {
          // A small chevron above friends; no box.
          const ctx = this.ctx;
          const cy = pr.y - Math.max(10 * s, r);
          ctx.beginPath();
          ctx.moveTo(pr.x - 5 * s, cy - 5 * s);
          ctx.lineTo(pr.x, cy);
          ctx.lineTo(pr.x + 5 * s, cy - 5 * s);
          this.stroke(col, 1.3);
        }
      } else if (enemy && (isT || d < 2500)) {
        const at = this.edgeArrow(pr, col, (isT ? 10 : 7) * s, isT ? 1 : 0.7);
        if (isT) this.text(distance(d, yd), at.x, at.y + 18 * s, col, 10, 'center');
      }
    }
    // Objective markers.
    for (const o of f.objectives) {
      if (!o.marker || o.done || o.failed) continue;
      const d = o.marker.distanceTo(p.position);
      const pr = this.project(o.marker, cam, this.p2);
      if (pr.on) {
        const ctx = this.ctx;
        const r = 7 * s;
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y - r);
        ctx.lineTo(pr.x + r, pr.y);
        ctx.lineTo(pr.x, pr.y + r);
        ctx.lineTo(pr.x - r, pr.y);
        ctx.closePath();
        this.stroke(ACCENT, 1.3);
        this.text(distance(d, yd), pr.x, pr.y + r + 14 * s, ACCENT, 10, 'center');
      } else {
        const at = this.edgeArrow(pr, ACCENT, 9 * s, 0.95);
        this.text(distance(d, yd), at.x, at.y + 18 * s, ACCENT, 10, 'center');
      }
    }
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
      ctx.fillStyle = t.team === p.team ? FRIEND : ACCENT;
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

function distance(m: number, imperial: boolean): string {
  if (imperial) {
    const yd = m * 1.09361;
    return yd < 1760 ? `${Math.round(yd / 10) * 10} yd` : `${(yd / 1760).toFixed(1)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}
