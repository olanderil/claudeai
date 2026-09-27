import * as THREE from 'three';
import { canvas, canvasTexture, fbm, hash2, heightToNormal, rng, vnoise } from './atlas';
import type { UVRect } from './geo';

/**
 * One texture set shared by every aircraft for everything that is not
 * painted skin: steel, brass, rubber, leather, varnished wood, laminated
 * propeller wood, perforated gun jackets, radiator matrix, instrument dials.
 *
 * The colour of a part comes from its vertex colour; the atlas supplies the
 * detail (grain, holes, creases) as a near-white albedo multiplier, plus
 * roughness (G) and metalness (B) in a packed map and a normal map. So a
 * brass fitting, a blued gun barrel and a black crankcase are all one
 * material, one draw call, differing only in which rectangle they sample and
 * what colour their vertices carry.
 */

const SIZE = 1024;

interface RegionDef {
  x: number; y: number; w: number; h: number;
  rough: number; metal: number;
}

// Pixel rectangles (canvas coordinates, y down).
const DEF = {
  dials: { x: 0, y: 0, w: 512, h: 256, rough: 0.5, metal: 0 },
  wood: { x: 512, y: 0, w: 256, h: 256, rough: 0.36, metal: 0 },
  lam: { x: 768, y: 0, w: 256, h: 256, rough: 0.28, metal: 0 },
  perf: { x: 0, y: 256, w: 256, h: 256, rough: 0.42, metal: 0.8 },
  leather: { x: 256, y: 256, w: 256, h: 256, rough: 0.58, metal: 0 },
  radiator: { x: 512, y: 256, w: 256, h: 256, rough: 0.45, metal: 0.75 },
  fins: { x: 768, y: 256, w: 256, h: 256, rough: 0.5, metal: 0.8 },
  plain: { x: 0, y: 512, w: 128, h: 128, rough: 0.62, metal: 0 },
  steel: { x: 128, y: 512, w: 128, h: 128, rough: 0.32, metal: 1 },
  rubber: { x: 256, y: 512, w: 128, h: 128, rough: 0.88, metal: 0 },
  cloth: { x: 384, y: 512, w: 128, h: 128, rough: 0.95, metal: 0 },
  face: { x: 512, y: 512, w: 128, h: 128, rough: 0.62, metal: 0 },
  silk: { x: 640, y: 512, w: 128, h: 128, rough: 0.55, metal: 0 },
  gloss: { x: 768, y: 512, w: 128, h: 128, rough: 0.12, metal: 0 },
  alu: { x: 896, y: 512, w: 128, h: 128, rough: 0.28, metal: 1 },
  louvre: { x: 0, y: 640, w: 256, h: 128, rough: 0.45, metal: 0 },
  brass: { x: 256, y: 640, w: 128, h: 128, rough: 0.28, metal: 1 },
  gun: { x: 384, y: 640, w: 128, h: 128, rough: 0.4, metal: 0.85 },
  paint: { x: 512, y: 640, w: 128, h: 128, rough: 0.42, metal: 0 },
  fur: { x: 640, y: 640, w: 128, h: 128, rough: 0.9, metal: 0 },
  lens: { x: 768, y: 640, w: 128, h: 128, rough: 0.08, metal: 0.3 },
  ply: { x: 0, y: 768, w: 256, h: 256, rough: 0.4, metal: 0 },
  interior: { x: 256, y: 768, w: 256, h: 256, rough: 0.8, metal: 0 },
  cast: { x: 512, y: 768, w: 128, h: 128, rough: 0.55, metal: 0.7 },
} satisfies Record<string, RegionDef>;

export type PropRegion = keyof typeof DEF;

function rect(d: RegionDef, inset = 3): UVRect {
  return {
    u0: (d.x + inset) / SIZE,
    u1: (d.x + d.w - inset) / SIZE,
    v0: 1 - (d.y + d.h - inset) / SIZE,
    v1: 1 - (d.y + inset) / SIZE,
  };
}

export const PR = Object.fromEntries(Object.entries(DEF).map(([k, d]) => [k, rect(d)])) as Record<PropRegion, UVRect>;

/** Sub-rectangle of the dials region: dial i of 8 (4 × 2). */
export function dialRect(i: number): UVRect {
  const d = DEF.dials;
  const x = d.x + (i % 4) * 128, y = d.y + Math.floor(i / 4) * 128;
  return rect({ x, y, w: 128, h: 128, rough: 0, metal: 0 }, 1);
}

export const DIAL = { rpm: 0, alt: 1, asi: 2, compass: 3, oil: 4, clock: 5, air: 6, level: 7 } as const;

export interface PropTextures {
  map: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
}

let cached: PropTextures | null = null;

export function propTextures(): PropTextures {
  if (cached) return cached;
  const { c: albedo, ctx } = canvas(SIZE);
  const { c: ormC, ctx: octx } = canvas(SIZE);
  const height = new Float32Array(SIZE * SIZE);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  octx.fillStyle = 'rgb(255,160,0)';
  octx.fillRect(0, 0, SIZE, SIZE);
  for (const d of Object.values(DEF)) {
    octx.fillStyle = `rgb(255,${Math.round(d.rough * 255)},${Math.round(d.metal * 255)})`;
    octx.fillRect(d.x, d.y, d.w, d.h);
  }
  const R = rng(1917);
  const px = (d: RegionDef, fn: (x: number, y: number, u: number, v: number) => number | void, alb?: (x: number, y: number, u: number, v: number) => number): void => {
    const img = ctx.getImageData(d.x, d.y, d.w, d.h);
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
      const u = x / d.w, v = y / d.h;
      const h = fn(x, y, u, v);
      if (typeof h === 'number') height[(d.y + y) * SIZE + d.x + x] = h;
      if (alb) {
        const a = Math.max(0, Math.min(1, alb(x, y, u, v)));
        const o = (y * d.w + x) * 4;
        img.data[o] *= a; img.data[o + 1] *= a; img.data[o + 2] *= a;
      }
    }
    ctx.putImageData(img, d.x, d.y);
  };

  // Varnished spruce/ash: long grain along v (canvas y), streaks and a few knots.
  px(DEF.wood, (x, y) => (vnoise(x * 0.6, y * 0.02, 3) - 0.5) * 0.0004,
    (x, y) => 0.78 + 0.22 * (0.55 * Math.sin(x * 0.55 + fbm(x * 0.05, y * 0.01, 3, 5) * 9) * 0.5 + 0.5) * fbm(x * 0.2, y * 0.006, 2, 9));

  // Propeller laminations: stripes by u (the axial coordinate), walnut and mahogany alternating.
  {
    const d = DEF.lam;
    const n = 9;
    for (let k = 0; k < n; k++) {
      const x0 = d.x + (k * d.w) / n;
      ctx.fillStyle = k % 2 === 0 ? '#b98258' : '#7b4629';
      ctx.fillRect(x0, d.y, d.w / n + 1, d.h);
      ctx.fillStyle = 'rgba(40,20,10,0.55)';
      ctx.fillRect(x0, d.y, 1.2, d.h);
    }
    px(d, (x, y) => (vnoise(x * 0.4, y * 0.03, 11) - 0.5) * 0.0003,
      (x, y) => 0.86 + 0.14 * fbm(x * 0.3 + Math.sin(y * 0.02) * 3, y * 0.012, 3, 21));
  }

  // Perforated cooling jacket: staggered holes, 10 round × 26 along.
  px(DEF.perf, (x, y) => {
    const cu = 10, cv = 26;
    const gx = (x / DEF.perf.w) * cu, gy = (y / DEF.perf.h) * cv;
    const row = Math.floor(gy);
    const ox = row % 2 ? 0.5 : 0;
    const fx = ((gx + ox) % 1) - 0.5, fy = (gy % 1) - 0.5;
    const r = Math.hypot(fx * 1.0, fy * 1.6);
    return r < 0.3 ? -0.004 : 0;
  }, (x, y) => {
    const cu = 10, cv = 26;
    const gx = (x / DEF.perf.w) * cu, gy = (y / DEF.perf.h) * cv;
    const row = Math.floor(gy);
    const ox = row % 2 ? 0.5 : 0;
    const fx = ((gx + ox) % 1) - 0.5, fy = (gy % 1) - 0.5;
    const r = Math.hypot(fx, fy * 1.6);
    return r < 0.3 ? 0.08 : 0.9 + 0.1 * vnoise(x * 0.2, y * 0.2, 4);
  });
  {
    // Holes are not metal.
    const d = DEF.perf;
    const img = octx.getImageData(d.x, d.y, d.w, d.h);
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) {
      const gx = (x / d.w) * 10, gy = (y / d.h) * 26;
      const ox = Math.floor(gy) % 2 ? 0.5 : 0;
      const fx = ((gx + ox) % 1) - 0.5, fy = (gy % 1) - 0.5;
      if (Math.hypot(fx, fy * 1.6) < 0.3) { const o = (y * d.w + x) * 4; img.data[o + 1] = 240; img.data[o + 2] = 0; }
    }
    octx.putImageData(img, d.x, d.y);
  }

  // Leather: pebbled grain and soft creases.
  px(DEF.leather, (x, y) => (fbm(x * 0.35, y * 0.35, 3, 31) - 0.5) * 0.0006 + Math.abs(Math.sin(y * 0.07 + fbm(x * 0.02, y * 0.02, 2, 3) * 6)) * -0.0005,
    (x, y) => 0.72 + 0.28 * fbm(x * 0.05, y * 0.05, 4, 33));

  // Radiator matrix: honeycomb cells.
  px(DEF.radiator, (x, y) => {
    const s = 7;
    const gy = y / (s * 0.866);
    const row = Math.floor(gy);
    const gx = x / s + (row % 2) * 0.5;
    const fx = (gx % 1) - 0.5, fy = (gy % 1) - 0.5;
    const e = Math.max(Math.abs(fx), Math.abs(fy) * 1.15);
    return e > 0.4 ? 0.001 : -0.0015;
  }, (x, y) => {
    const s = 7;
    const gy = y / (s * 0.866);
    const row = Math.floor(gy);
    const gx = x / s + (row % 2) * 0.5;
    const fx = (gx % 1) - 0.5, fy = (gy % 1) - 0.5;
    const e = Math.max(Math.abs(fx), Math.abs(fy) * 1.15);
    return e > 0.4 ? 0.95 : 0.18 + 0.1 * vnoise(x * 0.3, y * 0.3, 7);
  });

  // Cooling fins: ridges along v.
  px(DEF.fins, (_x, y) => Math.abs(Math.sin((y / DEF.fins.h) * Math.PI * 14)) * 0.004,
    (x, y) => 0.55 + 0.45 * Math.abs(Math.sin((y / DEF.fins.h) * Math.PI * 14)) * (0.8 + 0.2 * vnoise(x * 0.1, y * 0.1, 8)));

  px(DEF.steel, (x, y) => (vnoise(x * 0.8, y * 0.05, 41) - 0.5) * 0.00015, (x, y) => 0.86 + 0.14 * vnoise(x * 0.7, y * 0.04, 42));
  px(DEF.gun, (x, y) => (vnoise(x * 0.3, y * 0.3, 43) - 0.5) * 0.0002, (x, y) => 0.8 + 0.2 * fbm(x * 0.06, y * 0.06, 3, 44));
  px(DEF.cast, (x, y) => (fbm(x * 0.5, y * 0.5, 2, 45) - 0.5) * 0.0004, (x, y) => 0.75 + 0.25 * fbm(x * 0.1, y * 0.1, 3, 46));
  px(DEF.rubber, () => 0, (x, y) => 0.85 + 0.15 * vnoise(x * 0.1, y * 0.1, 51));
  px(DEF.cloth, (x, y) => ((x % 3) < 1.5 !== (y % 3) < 1.5 ? 0.0002 : 0) + (fbm(x * 0.1, y * 0.1, 2, 52) - 0.5) * 0.0005,
    (x, y) => 0.82 + 0.18 * fbm(x * 0.08, y * 0.08, 3, 53));
  px(DEF.face, () => 0, (x, y) => 0.9 + 0.1 * fbm(x * 0.1, y * 0.1, 3, 54));
  px(DEF.silk, (x, y) => Math.sin(x * 0.3 + y * 0.05) * 0.0002, (x, y) => 0.92 + 0.08 * Math.sin(x * 0.2 + fbm(x * 0.02, y * 0.02, 2, 55) * 8));
  px(DEF.fur, (x, y) => (vnoise(x * 1.5, y * 0.4, 56) - 0.5) * 0.001, (x, y) => 0.6 + 0.4 * vnoise(x * 1.5, y * 0.4, 56));
  px(DEF.paint, () => 0, (x, y) => 0.94 + 0.06 * fbm(x * 0.05, y * 0.05, 3, 57));
  px(DEF.alu, (x, y) => {
    // Engine-turned swirls: overlapping circles of brushed grain.
    const cs = 16, cx = Math.floor(x / cs), cy = Math.floor(y / cs);
    const dx = x - (cx + 0.5) * cs, dy = y - (cy + 0.5) * cs;
    return Math.sin(Math.hypot(dx, dy) * 1.7) * 0.00008;
  }, (x, y) => {
    const cs = 16, cx = Math.floor(x / cs), cy = Math.floor(y / cs);
    const dx = x - (cx + 0.5) * cs, dy = y - (cy + 0.5) * cs;
    return 0.8 + 0.2 * Math.abs(Math.sin(Math.atan2(dy, dx) * 2 + hash2(cx, cy, 3) * 6));
  });
  px(DEF.louvre, (_x, y) => {
    const f = (y / DEF.louvre.h) * 8;
    const t = f % 1;
    return t < 0.25 ? -0.003 : t < 0.5 ? (0.5 - t) * 0.01 : 0;
  }, (_x, y) => {
    const t = ((y / DEF.louvre.h) * 8) % 1;
    return t < 0.25 ? 0.15 : 1;
  });
  px(DEF.ply, (x, y) => (vnoise(x * 0.5, y * 0.03, 61) - 0.5) * 0.0002,
    (x, y) => 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(y * 0.2 + fbm(x * 0.01, y * 0.03, 3, 62) * 14)));
  px(DEF.interior, (x, y) => {
    // Fabric inside a frame: vertical longeron shadows every so often.
    const u = x / DEF.interior.w;
    return Math.abs(u - 0.5) > 0.47 ? 0.002 : (fbm(x * 0.05, y * 0.05, 2, 63) - 0.5) * 0.0005;
  }, (x, y) => {
    const v = y / DEF.interior.h;
    return 0.55 + 0.35 * fbm(x * 0.03, y * 0.03, 3, 64) - (Math.abs(((v * 6) % 1) - 0.5) < 0.04 ? 0.25 : 0);
  });

  paintDials(ctx);
  void R;

  const normal = heightToNormal(height, SIZE, SIZE, 1500, 1);
  cached = {
    map: canvasTexture(albedo, true),
    normal: canvasTexture(normal, false),
    orm: canvasTexture(ormC, false),
  };
  return cached;
}

/** Period instrument faces: black enamel, white figures. */
function paintDials(ctx: CanvasRenderingContext2D): void {
  const faces = ['rpm', 'alt', 'asi', 'compass', 'oil', 'clock', 'air', 'level'];
  faces.forEach((kind, i) => {
    const cx = DEF.dials.x + (i % 4) * 128 + 64, cy = DEF.dials.y + Math.floor(i / 4) * 128 + 64;
    ctx.save();
    ctx.translate(cx, cy);
    // Bezel and face.
    ctx.fillStyle = '#3a2e1c';
    ctx.fillRect(-64, -64, 128, 128);
    const g = ctx.createRadialGradient(0, -10, 10, 0, 0, 62);
    g.addColorStop(0, kind === 'compass' ? '#d9ccaa' : '#1d1b18');
    g.addColorStop(1, kind === 'compass' ? '#a89a72' : '#0c0b0a');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c9a44f';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(0, 0, 60, 0, Math.PI * 2); ctx.stroke();
    const ink = kind === 'compass' ? '#1a1510' : '#efe8d4';
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ticks = (from: number, to: number, n: number, labels: string[] | null, long = 5): void => {
      for (let k = 0; k <= n; k++) {
        const a = from + ((to - from) * k) / n;
        const major = k % long === 0;
        ctx.lineWidth = major ? 2.2 : 1.1;
        ctx.beginPath();
        ctx.moveTo(Math.sin(a) * 52, -Math.cos(a) * 52);
        ctx.lineTo(Math.sin(a) * (major ? 42 : 47), -Math.cos(a) * (major ? 42 : 47));
        ctx.stroke();
        if (labels && major) {
          const lab = labels[k / long];
          if (lab) { ctx.font = 'bold 12px sans-serif'; ctx.fillText(lab, Math.sin(a) * 32, -Math.cos(a) * 32); }
        }
      }
    };
    const needle = (a: number, len = 44, w = 3): void => {
      ctx.save();
      ctx.rotate(a);
      ctx.fillStyle = '#f2ead2';
      ctx.beginPath();
      ctx.moveTo(-w, 6); ctx.lineTo(0, -len); ctx.lineTo(w, 6); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#6b5a3a';
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    };
    ctx.font = 'bold 9px sans-serif';
    switch (kind) {
      case 'rpm':
        ticks(-2.4, 2.4, 20, ['0', '4', '8', '12', '16'], 5);
        ctx.fillText('R.P.M.', 0, 22); ctx.fillText('x100', 0, 33);
        needle(1.3);
        break;
      case 'alt':
        ticks(0, Math.PI * 2 - 0.3, 20, ['0', '5', '10', '15', ''], 5);
        ctx.fillText('FEET', 0, 20); ctx.fillText('x1000', 0, 31);
        needle(0.9);
        break;
      case 'asi':
        ticks(-2.3, 2.3, 24, ['40', '', '80', '', '120'], 6);
        ctx.fillText('M.P.H.', 0, 24);
        needle(0.4);
        break;
      case 'compass': {
        ticks(0, Math.PI * 2, 36, null, 9);
        ctx.font = 'bold 15px serif';
        ['N', 'E', 'S', 'W'].forEach((l, k) => ctx.fillText(l, Math.sin((k * Math.PI) / 2) * 30, -Math.cos((k * Math.PI) / 2) * 30));
        ctx.strokeStyle = '#1a1510'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(0, 20); ctx.stroke();
        break;
      }
      case 'oil':
        ticks(-2, 2, 10, ['0', '', '50'], 5);
        ctx.fillText('OIL', 0, 22);
        needle(-0.6);
        break;
      case 'clock':
        ticks(0, Math.PI * 2 - Math.PI / 6, 11, ['12', '', '', '', '', '', '', '', '', '', '', ''], 1);
        needle(1.1, 30, 3);
        needle(-0.4, 44, 2);
        break;
      case 'air':
        ticks(-2, 2, 8, ['0', '', '4', '', '8'], 2);
        ctx.fillText('AIR', 0, 22); ctx.fillText('lbs', 0, 32);
        needle(-0.2);
        break;
      case 'level': {
        ctx.fillStyle = '#20301e';
        ctx.fillRect(-50, -12, 100, 24);
        ctx.fillStyle = '#d8e0c0';
        ctx.beginPath(); ctx.ellipse(6, 0, 12, 8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#efe8d4'; ctx.lineWidth = 1.5;
        for (const x of [-10, 10]) { ctx.beginPath(); ctx.moveTo(x, -12); ctx.lineTo(x, 12); ctx.stroke(); }
        break;
      }
    }
    // Glass glint.
    const gl = ctx.createLinearGradient(-40, -50, 20, 10);
    gl.addColorStop(0, 'rgba(255,255,255,0.18)');
    gl.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(0, 0, 57, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  });
}

// ---------------------------------------------------------------- effects

let blurTex: THREE.Texture | null = null;

/**
 * The spinning propeller as the eye (and a camera) sees it: an almost clear
 * disc, darker where the wide part of the blades sweeps, a bright brass ring
 * at the tips, and thin radial streaks that are rotated each frame so the disc
 * visibly spins rather than sitting there like a pane of smoked glass.
 */
export function propBlurTexture(): THREE.Texture {
  if (blurTex) return blurTex;
  const S = 512;
  const { c, ctx } = canvas(S);
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
    const r = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx);
    const o = (y * S + x) * 4;
    if (r > 1) { img.data[o + 3] = 0; continue; }
    // Blade width profile: narrow at the root, widest ~70 %, rounded tip.
    const width = r < 0.12 ? 0 : Math.sin(Math.min(1, (r - 0.12) / 0.8) * Math.PI * 0.62) * (r > 0.9 ? Math.sqrt(Math.max(0, (1 - r) / 0.1)) : 1);
    const streak = 0.75 + 0.25 * Math.sin(a * 2 + Math.sin(r * 9) * 0.4) ** 8 + 0.12 * (vnoise(a * 30, r * 6, 7) - 0.5);
    let alpha = 0.2 * width * streak;
    let cr = 0.36, cg = 0.22, cb = 0.14;
    if (r > 0.86) {
      // Brass tipping reads as a ring.
      const tip = Math.min(1, (r - 0.86) / 0.03) * Math.min(1, (1 - r) / 0.03);
      alpha = Math.max(alpha, 0.24 * tip * streak);
      cr = 0.75; cg = 0.58; cb = 0.3;
    }
    img.data[o] = cr * 255;
    img.data[o + 1] = cg * 255;
    img.data[o + 2] = cb * 255;
    img.data[o + 3] = Math.max(0, Math.min(1, alpha)) * 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c, true, 4);
  t.center.set(0.5, 0.5);
  blurTex = t;
  return t;
}

let flashTex: THREE.Texture | null = null;

/** Muzzle flash: a hot core and uneven spikes, white-yellow into orange. */
export function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  const S = 128;
  const { c, ctx } = canvas(S);
  const img = ctx.createImageData(S, S);
  const R = rng(77);
  const spikes = Array.from({ length: 7 }, () => ({ a: R() * Math.PI * 2, w: 0.08 + R() * 0.1, l: 0.6 + R() * 0.4 }));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
    const r = Math.hypot(dx, dy), a = Math.atan2(dy, dx);
    let v = Math.exp(-r * r * 18) + 0.35 * Math.exp(-r * r * 4);
    for (const s of spikes) {
      const da = Math.abs(Math.atan2(Math.sin(a - s.a), Math.cos(a - s.a)));
      v += Math.exp(-(da * da) / (s.w * s.w)) * Math.max(0, 1 - r / s.l) * 0.7;
    }
    v = Math.min(1, v);
    const o = (y * S + x) * 4;
    img.data[o] = 255;
    img.data[o + 1] = Math.min(255, 150 + 105 * v);
    img.data[o + 2] = Math.min(255, 60 + 170 * v * v);
    img.data[o + 3] = v * 255;
  }
  ctx.putImageData(img, 0, 0);
  flashTex = canvasTexture(c, true, 1);
  return flashTex;
}
