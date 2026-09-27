import { canvas, canvasTexture, fbm, heightToNormal, noiseCanvas, rng, vnoise, type SkinAtlas, type SkinRegion } from './atlas';
import type { Fuselage } from './fuselage';
import type * as THREE from 'three';

/**
 * Painting liveries and fabric relief into a type's skin atlas.
 *
 * Painters draw in metres: the atlas sets the canvas transform per region, so
 * a 1.2 m roundel is `roundel(ctx, s, x, 0.6, …)` wherever it goes. The
 * helpers here are the period vocabulary — roundels, crosses pattée, serials,
 * French five-colour and German lozenge camouflage, Fokker's streaky olive —
 * plus the wear that makes a machine look flown: exhaust soot, castor-oil
 * streaks, chipped cowl edges, grubby hand-holds and mud off the wheels.
 */

export const C = {
  pc10: '#4b452e',
  pc10dark: '#3f3a27',
  cdl: '#c6b692',
  rfcBlue: '#24305a',
  rfcRed: '#a3282a',
  white: '#ebe8de',
  black: '#161412',
  frBlue: '#27408a',
  frRed: '#b3302b',
  usRed: '#a82b2b',
  usBlue: '#253a7a',
  red: '#a51d1b',
  yellow: '#d6a92a',
  paleBlue: '#a9c3d2',
  alu: '#b9b8b2',
  ply: '#b07a3e',
  grey: '#6f7466',
} as const;

// ---------------------------------------------------------------- painter

export class Painter {
  readonly albedo: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly ormC: HTMLCanvasElement;
  readonly orm: CanvasRenderingContext2D;
  private grimeTex: HTMLCanvasElement | null = null;

  constructor(readonly atlas: SkinAtlas, readonly seed: number) {
    const a = canvas(atlas.size);
    this.albedo = a.c;
    this.ctx = a.ctx;
    const o = canvas(atlas.size / 2);
    this.ormC = o.c;
    this.orm = o.ctx;
    this.ctx.fillStyle = '#808080';
    this.ctx.fillRect(0, 0, atlas.size, atlas.size);
    // Default: fabric, rough, not metal.
    this.orm.fillStyle = 'rgb(255,186,0)';
    this.orm.fillRect(0, 0, atlas.size / 2, atlas.size / 2);
  }

  region(name: string): SkinRegion | null {
    return this.atlas.regions.get(name) ?? null;
  }

  /** Draw in a region's metre coordinates. Missing regions are skipped (not every type has every part). */
  on(name: string | SkinRegion, fn: (ctx: CanvasRenderingContext2D, r: SkinRegion) => void): void {
    const r = typeof name === 'string' ? this.region(name) : name;
    if (!r) return;
    this.atlas.paint(this.ctx, r, fn);
  }

  /** Same, on the (half-resolution) roughness/metalness map. */
  onOrm(name: string | SkinRegion, fn: (ctx: CanvasRenderingContext2D, r: SkinRegion) => void): void {
    const r = typeof name === 'string' ? this.region(name) : name;
    if (!r) return;
    // The map is half the albedo's resolution: same layout, every pixel figure halved.
    const s = this.atlas.scale;
    this.orm.save();
    this.orm.beginPath();
    this.orm.rect((r.px - 8) / 2, (r.py - 8) / 2, ((r.u1 - r.u0) * s + 16) / 2, ((r.v1 - r.v0) * s + 16) / 2);
    this.orm.clip();
    this.orm.setTransform(s / 2, 0, 0, s / 2, (r.px - r.u0 * s) / 2, (r.py - r.v0 * s) / 2);
    fn(this.orm, r);
    this.orm.restore();
  }

  fill(name: string, color: string): void {
    this.on(name, (ctx, r) => { ctx.fillStyle = color; ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2); });
  }

  /** Roughness 0..1, metalness 0..1 for a rectangle (region metres); whole region if no rect. */
  surface(name: string, rough: number, metal: number, rect?: [number, number, number, number]): void {
    this.onOrm(name, (ctx, r) => {
      ctx.fillStyle = `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;
      if (rect) ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
      else ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2);
    });
  }

  /** Multiply a soft noise over a region: dope and paint are never quite even. */
  grime(name: string, amount: number, cell = 0.6): void {
    if (!this.grimeTex) this.grimeTex = noiseCanvas(256, 32, 4, this.seed + 3);
    const tex = this.grimeTex;
    this.on(name, (ctx, r) => {
      ctx.save();
      ctx.globalAlpha = amount;
      ctx.globalCompositeOperation = 'overlay';
      const pat = ctx.createPattern(tex, 'repeat')!;
      const k = cell / 32;
      pat.setTransform(new DOMMatrix().scale(k, k));
      ctx.fillStyle = pat;
      ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2);
      ctx.restore();
    });
  }

  toTextures(): { map: THREE.Texture; orm: THREE.Texture } {
    return { map: canvasTexture(this.albedo, true), orm: canvasTexture(this.ormC, false) };
  }
}

// ---------------------------------------------------------------- markings

export function roundel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rings: string[]): void {
  // rings outer → inner, equal widths
  rings.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r * (1 - i / rings.length), 0, Math.PI * 2);
    ctx.fill();
  });
}

/** RFC roundel: blue outer, white, red centre (radii 1 : 2/3 : 1/3). */
export const rfcRoundel = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, outline = true): void => {
  if (outline) roundel(ctx, x, y, r * 1.06, [C.white]);
  roundel(ctx, x, y, r, [C.rfcBlue, C.white, C.rfcRed]);
};
export const frRoundel = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void =>
  roundel(ctx, x, y, r, [C.frRed, C.white, C.frBlue]);
export const usRoundel = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void =>
  roundel(ctx, x, y, r, [C.usRed, C.usBlue, C.white]);

/**
 * Eisernes Kreuz as painted in 1917: a cross pattée, arms flaring on
 * concave curves, normally on a white square field or with a white border.
 */
export function crossPattee(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, o: { field?: 'square' | 'border' | 'none'; rot?: number; fieldColor?: string } = {}): void {
  const field = o.field ?? 'square';
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(o.rot ?? 0);
  const h = size / 2;
  const arm = (s: number, col: string): void => {
    ctx.fillStyle = col;
    ctx.beginPath();
    const w0 = s * 0.2, w1 = s * 0.5; // half width at the centre and at the tips
    for (let k = 0; k < 4; k++) {
      ctx.save();
      ctx.rotate((k * Math.PI) / 2);
      ctx.moveTo(-w0 * 0.98, -w0 * 0.98);
      ctx.quadraticCurveTo(-w0 * 1.05, -s * 0.75, -w1, -s);
      ctx.lineTo(w1, -s);
      ctx.quadraticCurveTo(w0 * 1.05, -s * 0.75, w0 * 0.98, -w0 * 0.98);
      ctx.closePath();
      ctx.restore();
    }
    ctx.fill();
    ctx.fillRect(-w0, -w0, w0 * 2, w0 * 2);
  };
  if (field === 'square') {
    ctx.fillStyle = o.fieldColor ?? C.white;
    ctx.fillRect(-h * 1.18, -h * 1.18, h * 2.36, h * 2.36);
  } else if (field === 'border') {
    arm(h * 1.12, o.fieldColor ?? C.white);
  }
  arm(h, C.black);
  ctx.restore();
}

/** Upright text with an arbitrary canvas basis (for regions whose axes are turned). */
export function text(
  ctx: CanvasRenderingContext2D, str: string, x: number, y: number, h: number, color: string,
  o: { right?: [number, number]; down?: [number, number]; align?: CanvasTextAlign; font?: string; stroke?: string } = {},
): void {
  const [rx, ry] = o.right ?? [1, 0];
  const [dx, dy] = o.down ?? [0, 1];
  ctx.save();
  ctx.transform(rx, ry, dx, dy, x, y);
  ctx.textAlign = o.align ?? 'center';
  ctx.textBaseline = 'middle';
  // Draw at a sane pixel size and scale down: tiny fonts at scale are unreliable.
  const px = 100;
  ctx.scale(h / px, h / px);
  ctx.font = o.font ?? `bold ${px}px "DejaVu Sans Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  if (o.stroke) { ctx.lineWidth = px * 0.12; ctx.strokeStyle = o.stroke; ctx.strokeText(str, 0, 0); }
  ctx.fillStyle = color;
  ctx.fillText(str, 0, 0);
  ctx.restore();
}

// ---------------------------------------------------------------- camouflage

/**
 * French five-colour: large, irregular, soft-edged patches. Each colour owns
 * a domain-warped noise field and a pixel takes the strongest — organic
 * shapes that never repeat and never look like polka dots. `weights` bias a
 * colour's share (black was used sparingly). Painted on a coarse grid and
 * scaled up with smoothing: the real edges were brushed and soft anyway.
 */
export function blobCamo(p: Painter, name: string, palette: string[], scale: number, seed: number, weights?: number[]): void {
  const r = p.region(name);
  if (!r) return;
  const res = 40; // px per metre for the coarse field
  const w = Math.ceil((r.u1 - r.u0 + 0.2) * res), h = Math.ceil((r.v1 - r.v0 + 0.2) * res);
  const { c, ctx } = canvas(w, h);
  const img = ctx.createImageData(w, h);
  const cols = palette.map(hexToRgb);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let u = (r.u0 - 0.1 + x / res) / scale, v = (r.v0 - 0.1 + y / res) / scale;
    // Domain warp: bends the patch outlines into ragged, elongated shapes.
    const wu = fbm(u * 0.7, v * 0.7, 2, seed + 500) - 0.5, wv = fbm(u * 0.7 + 9.2, v * 0.7, 2, seed + 600) - 0.5;
    u += wu * 1.4; v += wv * 1.4;
    let best = -1, bi = 0;
    for (let k = 0; k < cols.length; k++) {
      const n = fbm(u + k * 13.1, v - k * 7.3, 2, seed + k * 101) * (weights?.[k] ?? 1);
      if (n > best) { best = n; bi = k; }
    }
    const o = (y * w + x) * 4;
    img.data[o] = cols[bi][0]; img.data[o + 1] = cols[bi][1]; img.data[o + 2] = cols[bi][2]; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  p.on(r, (cx) => {
    cx.imageSmoothingEnabled = true;
    cx.drawImage(c, r.u0 - 0.1, r.v0 - 0.1, w / res, h / res);
  });
}

/**
 * Printed lozenge fabric: irregular hexagons, the dual cells of a jittered
 * triangular lattice, coloured so no two neighbours match. The lattice is
 * periodic (a printed bolt repeats) and can be laid at an angle, as the
 * fabric strips were on many types.
 */
export function lozenge(p: Painter, name: string, palette: string[], seed: number, o: { cell?: number; angle?: number } = {}): void {
  const r = p.region(name);
  if (!r) return;
  const cell = o.cell ?? 0.2;
  const R = rng(seed);
  const NX = 9, NY = 10; // tile size in lattice points (NY even keeps row parity periodic)
  const jit: [number, number][] = Array.from({ length: NX * NY }, () => [(R() - 0.5) * 0.42, (R() - 0.5) * 0.42]);
  const mod = (a: number, n: number): number => ((a % n) + n) % n;
  const pt = (i: number, j: number): [number, number] => {
    const q = jit[mod(j, NY) * NX + mod(i, NX)];
    return [(i + (mod(j, 2) ? 0.5 : 0) + q[0]) * cell, (j + q[1]) * cell * 0.866];
  };
  const nbrs = (i: number, j: number): [number, number][] => mod(j, 2)
    ? [[i + 1, j], [i + 1, j + 1], [i, j + 1], [i - 1, j], [i, j - 1], [i + 1, j - 1]]
    : [[i + 1, j], [i, j + 1], [i - 1, j + 1], [i - 1, j], [i - 1, j - 1], [i, j - 1]];
  // Colour the periodic tile so neighbours differ.
  const col = new Int32Array(NX * NY).fill(-1);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const used = new Set<number>();
    for (const [a, b] of nbrs(i, j)) { const c = col[mod(b, NY) * NX + mod(a, NX)]; if (c >= 0) used.add(c); }
    const opts = palette.map((_, k) => k).filter((k) => !used.has(k));
    col[j * NX + i] = opts.length ? opts[Math.floor(R() * opts.length)] : Math.floor(R() * palette.length);
  }
  p.on(r, (ctx) => {
    ctx.save();
    const cu = (r.u0 + r.u1) / 2, cv = (r.v0 + r.v1) / 2;
    ctx.translate(cu, cv);
    ctx.rotate(o.angle ?? 0);
    const span = Math.hypot(r.u1 - r.u0, r.v1 - r.v0) / 2 + cell * 2;
    const i0 = Math.floor(-span / cell) - 1, i1 = Math.ceil(span / cell) + 1;
    const j0 = Math.floor(-span / (cell * 0.866)) - 1, j1 = Math.ceil(span / (cell * 0.866)) + 1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const [px, py] = pt(i, j);
      const ns = nbrs(i, j).map(([a, b]) => pt(a, b));
      ctx.fillStyle = palette[col[mod(j, NY) * NX + mod(i, NX)]];
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = ns[k], b = ns[(k + 1) % 6];
        const x = (px + a[0] + b[0]) / 3, y = (py + a[1] + b[1]) / 3;
        if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      // Hairline overlap so no background shows between cells.
      ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.004; ctx.stroke();
    }
    ctx.restore();
  });
}

/**
 * Fokker's factory finish: olive-green brushed on in long diagonal strokes
 * over clear dope, so the colour is dark olive with lighter streaks where the
 * brush ran thin.
 */
export function streaky(p: Painter, name: string, base: string, streak: string, seed: number, angle: number): void {
  const r = p.region(name);
  if (!r) return;
  const R = rng(seed);
  p.on(r, (ctx) => {
    ctx.fillStyle = streak;
    ctx.fillRect(r.u0 - 1, r.v0 - 1, r.u1 - r.u0 + 2, r.v1 - r.v0 + 2);
    ctx.save();
    ctx.translate((r.u0 + r.u1) / 2, (r.v0 + r.v1) / 2);
    ctx.rotate(angle);
    const L = Math.hypot(r.u1 - r.u0, r.v1 - r.v0) / 2 + 0.6;
    const n = Math.floor(L * L * 90);
    for (let k = 0; k < n; k++) {
      const y = -L + R() * 2 * L, x = -L - 1 + R() * (2 * L + 1);
      const len = 0.6 + R() * 1.8, w = 0.012 + R() * 0.035;
      const light = R() < 0.55;
      ctx.globalAlpha = light ? 0.07 + R() * 0.16 : 0.08 + R() * 0.18;
      ctx.fillStyle = light ? base : '#262a16';
      ctx.fillRect(x, y + (R() - 0.5) * 0.01, len, w);
    }
    ctx.restore();
  });
}

// ---------------------------------------------------------------- weathering

/** Streaks of castor oil and exhaust soot flowing aft from (u, v) over a region. */
export function streaks(
  p: Painter, name: string, x0: number, x1: number, y0: number, y1: number, dir: 1 | -1, len: number,
  o: { color?: string; alpha?: number; count?: number; seed?: number } = {},
): void {
  const R = rng(o.seed ?? 5);
  p.on(name, (ctx) => {
    const n = o.count ?? 60;
    for (let k = 0; k < n; k++) {
      const y = y0 + R() * (y1 - y0);
      const x = x0 + R() * (x1 - x0);
      const l = len * (0.3 + R() * 0.7);
      const w = 0.004 + R() * 0.018;
      const g = ctx.createLinearGradient(x, y, x + dir * l, y);
      const col = o.color ?? '20,16,10';
      const a = (o.alpha ?? 0.35) * (0.4 + R() * 0.6);
      g.addColorStop(0, `rgba(${col},${a})`);
      g.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(x, x + dir * l), y - w / 2, l, w);
    }
  });
}

/** Soft sooty patch (radial, stretched aft). */
export function soot(p: Painter, name: string, x: number, y: number, rx: number, ry: number, alpha = 0.6, color = '18,15,12'): void {
  p.on(name, (ctx) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(0.6, `rgba(${color},${alpha * 0.35})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });
}

/** Paint chipped off an edge band [v0, v1] of a region, showing bare metal. */
export function chips(p: Painter, name: string, u0: number, u1: number, v0: number, v1: number, density: number, seed: number, metal = '#77756f'): void {
  const R = rng(seed);
  p.on(name, (ctx) => {
    const area = (u1 - u0) * (v1 - v0);
    const n = Math.floor(area * density);
    ctx.fillStyle = metal;
    for (let k = 0; k < n; k++) {
      const x = u0 + R() * (u1 - u0), y = v0 + R() * (v1 - v0);
      const s = 0.002 + R() ** 3 * 0.012;
      ctx.beginPath();
      for (let q = 0; q < 6; q++) {
        const a = (q / 6) * Math.PI * 2, rr = s * (0.5 + R());
        if (q === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.fill();
    }
  });
  p.onOrm(name, (ctx) => {
    const R2 = rng(seed);
    const area = (u1 - u0) * (v1 - v0);
    const n = Math.floor(area * density);
    ctx.fillStyle = 'rgb(255,90,230)';
    for (let k = 0; k < n; k++) {
      const x = u0 + R2() * (u1 - u0), y = v0 + R2() * (v1 - v0);
      const s = 0.002 + R2() ** 3 * 0.012;
      ctx.beginPath(); ctx.arc(x, y, s * 0.9, 0, Math.PI * 2); ctx.fill();
    }
  });
}

/** Mud and grass stains thrown up by the wheels. */
export function mud(p: Painter, name: string, x0: number, x1: number, y0: number, y1: number, density: number, seed: number): void {
  const R = rng(seed);
  p.on(name, (ctx) => {
    const n = Math.floor((x1 - x0) * (y1 - y0) * density);
    for (let k = 0; k < n; k++) {
      const x = x0 + R() * (x1 - x0), y = y0 + R() * (y1 - y0);
      ctx.fillStyle = `rgba(${60 + R() * 30},${45 + R() * 20},${25 + R() * 12},${0.15 + R() * 0.4})`;
      const s = 0.004 + R() ** 2 * 0.03;
      ctx.beginPath(); ctx.ellipse(x, y, s * (1 + R() * 2), s, R() * 3, 0, Math.PI * 2); ctx.fill();
    }
  });
}

/** Darken a patch (hand-holds, boots on the wing root). */
export function smudge(p: Painter, name: string, x: number, y: number, rx: number, ry: number, alpha = 0.25): void {
  soot(p, name, x, y, rx, ry, alpha, '35,28,20');
}

/** Region-metre rectangle [u, v, w, h] covering fuselage stations zA..zB on one side. */
export function fusRect(fus: Fuselage, side: 'R' | 'L', zA: number, zB: number): [number, number, number, number] {
  const u0 = side === 'R' ? fus.z1 - zB : zA - fus.z0;
  return [u0, -0.1, zB - zA, 4];
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// ---------------------------------------------------------------- relief

/** What the relief painter needs to know about a region, set by the builders. */
export interface WingMeta {
  ribs: number[];
  /** Chordwise end of the plywood/metal leading-edge sheet. */
  leSheet: (s: number) => number;
  le: (s: number) => number;
  te: (s: number) => number;
  hinge?: { x: (s: number) => number; s0: number; s1: number };
  tapeW?: number;
}

export interface FusMeta {
  fus: Fuselage;
  side: 'R' | 'L';
  /** Stations where fabric starts (aft of metal/ply panels). */
  fabricFrom: number;
  panelSeams: number[];
  formers: number[];
  /** Plywood monocoque (Albatros): seams and nail lines instead of stringers. */
  ply?: boolean;
  stringerArcs?: number[];
}

/**
 * Height field for the whole atlas, in metres of relief, then a normal map.
 * Rib tapes stand ~0.4 mm proud with pinked edges; the fabric sags ~1 mm
 * between them, most toward the trailing edge where nothing supports it;
 * fuselage fabric sags between stringers and is laced along the belly.
 */
export function reliefNormalMap(atlas: SkinAtlas, res = 0.5): THREE.Texture {
  // Half resolution: the relief is broad (sag, tapes, seams) and this map is
  // per type, resident for as long as the type is; it also builds 4× faster.
  const S = Math.round(atlas.size * res);
  const H = new Float32Array(S * S);
  for (const r of atlas.regions.values()) {
    const m = r.meta as Partial<WingMeta & FusMeta>;
    if ((r.kind === 'wing' || r.kind === 'tail') && m.ribs && m.ribs.length > 1) {
      const wm = m as WingMeta;
      const ribs = wm.ribs;
      const tape = (wm.tapeW ?? 0.035) / 2;
      atlas.forPixels(r, (px, py, s, x) => {
        const le = wm.le(s), te = wm.te(s);
        if (x < le - 0.01 || x > te + 0.01) return;
        const c = Math.max(te - le, 1e-3);
        const t = (x - le) / c;
        let h = 0;
        // Nearest rib.
        let k = 0;
        while (k < ribs.length - 1 && ribs[k + 1] < s) k++;
        const a = ribs[k], b = ribs[Math.min(ribs.length - 1, k + 1)];
        const bay = b - a;
        const f = bay > 0.01 ? Math.min(1, Math.max(0, (s - a) / bay)) : 0;
        const sheet = wm.leSheet(s);
        const env = smooth(sheet - 0.02, sheet + 0.12, x) * (1 - 0.6 * smooth(0.9, 1.0, t));
        h -= 0.0026 * Math.sin(Math.PI * f) ** 2 * env * (0.6 + 0.8 * t);
        const d = Math.min(Math.abs(s - a), Math.abs(s - b));
        const pink = 0.0015 * Math.sin(x * 900);
        if (d < tape + pink && x > sheet - 0.01) h += 0.0006 * (1 - smooth(tape * 0.75, tape, d));
        // Stitching under the tape.
        if (d < 0.005 && Math.sin(x * 140) > 0.55 && x > sheet) h += 0.0004;
        // Leading-edge sheet: a step where it ends.
        if (x < sheet) h += 0.0004;
        // Trailing-edge wire.
        if (te - x < 0.012) h += 0.0003;
        if (wm.hinge && s >= wm.hinge.s0 && s <= wm.hinge.s1 && Math.abs(x - wm.hinge.x(s)) < 0.006) h -= 0.0012;
        H[py * S + px] = h;
      }, undefined, res);
    } else if (r.kind === 'fus' && m.fus) {
      const fm = m as FusMeta;
      const fus = fm.fus;
      const zMax = fus.z1, zMin = fus.z0;
      const cache = new Map<number, { girth: number; sh: number }>();
      atlas.forPixels(r, (px, py, u, v) => {
        const z = fm.side === 'R' ? zMax - u : zMin + u;
        const zk = Math.round(z * 50);
        let info = cache.get(zk);
        if (!info) {
          info = { girth: fus.halfGirth(zk / 50), sh: fus.arcAt(zk / 50, fus.param('sh', zk / 50)) };
          cache.set(zk, info);
        }
        let h = 0;
        if (fm.ply) {
          // Plywood: seams along formers and nail rows along the stringers.
          for (const zs of fm.formers) if (Math.abs(z - zs) < 0.004) h -= 0.0005;
          for (const zs of fm.formers) if (Math.abs(z - zs - 0.018) < 0.003 && Math.sin(v * 160) > 0.7) h += 0.0002;
          if (Math.abs(v - info.sh) < 0.003) h -= 0.0003;
        } else if (z > fm.fabricFrom) {
          // Fabric over a braced box: sag between stringers on the decking, longerons as ridges.
          const arcs = fm.stringerArcs ?? [];
          if (arcs.length > 1 && v < arcs[arcs.length - 1]) {
            let k = 0;
            while (k < arcs.length - 1 && arcs[k + 1] < v) k++;
            const f = (v - arcs[k]) / (arcs[k + 1] - arcs[k]);
            h -= 0.0018 * Math.sin(Math.PI * f) ** 2;
          }
          if (Math.abs(v - info.sh) < 0.01) h += 0.0006;
          if (Math.abs(v - info.girth) < 0.02 && Math.sin(z * 80) > 0.2) h += 0.0005; // belly lacing
          for (const zs of fm.formers) if (Math.abs(z - zs) < 0.012) h += 0.0003 * (1 - Math.abs(z - zs) / 0.012);
        } else {
          for (const zs of fm.panelSeams) {
            if (Math.abs(z - zs) < 0.003) h -= 0.0006;
            if (Math.abs(z - zs - 0.012) < 0.0025 && Math.sin(v * 110) > 0.85) h += 0.0004; // screws
          }
          if (Math.abs(v - info.sh) < 0.003) h -= 0.0005;
        }
        H[py * S + px] = h;
      }, undefined, res);
    } else if (r.kind === 'cowl') {
      const lip = (r.meta.lip as number) ?? 0;
      atlas.forPixels(r, (px, py, u, v) => {
        let h = 0;
        if (Math.abs(v - lip) < 0.01) h += 0.0005;
        h += (vnoise(u * 30, v * 30, 9) - 0.5) * 0.00012; // hand-beaten sheet
        H[py * S + px] = h;
      }, undefined, res);
    } else if (r.kind === 'disc') {
      atlas.forPixels(r, (px, py, u, v) => {
        const rr = Math.hypot(u, v);
        const R = (r.meta.r as number) ?? 0.3;
        let h = -0.0015 * (1 - (rr / R) ** 2);
        if (Math.abs(rr - R * 0.93) < 0.008 && Math.sin(Math.atan2(v, u) * 60) > 0.3) h += 0.0006; // lacing
        H[py * S + px] = h;
      }, undefined, res);
    }
  }
  return canvasTexture(heightToNormal(H, S, S, atlas.scale * res, 3.2), false);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

