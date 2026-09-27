import * as THREE from 'three';
import { rng } from './util';

/**
 * One painted texture atlas and one material for every ground model.
 *
 * Why an atlas: forty to eighty ground objects sit on the map, each made of
 * canvas, timber, sandbags, corrugated iron, brick… With a material per
 * surface that is five to ten draw calls per object before shadows. Instead
 * every surface is a 240 px tile of one 2048×1024 atlas (albedo + normal), each
 * vertex carries (tile, roughness, metalness, ember) in `aMat`, and the
 * fragment shader wraps the metre-scaled UV inside its tile with fract().
 * `textureGrad` with the derivatives of the *unwrapped* UV keeps mip selection
 * continuous across the wrap, so tiling is seamless and there are no seams of
 * blurred pixels where fract() jumps.
 *
 * Tiles are painted at runtime on 2D canvases, made periodic by drawing every
 * primitive wrapped around the tile, then a height layer is turned into a
 * tangent-space normal map. Tiles are mostly neutral grey: the vertex colour
 * supplies the paint (khaki, field-grey, hessian, creosote), so the same
 * sandbag tile serves both sides.
 */

export const TILE = {
  PAINT: 0, CANVAS: 1, BOARDS: 2, CLAP: 3, SANDBAG: 4, CORRUGATED: 5, EARTH: 6, TURF: 7,
  CONCRETE: 8, BRICK: 9, PLASTER: 10, ROOFTILE: 11, WINDOW: 12, DOOR: 13, WHEEL: 14, WICKER: 15,
  CRATE: 16, RIVET: 17, TARP: 18, NET: 19, ROUNDEL: 20, CROSS: 21, CROSSFIELD: 22, RADIATOR: 23,
  SCORCH: 24, FELT: 25, GRILLE: 26, SHELLCASE: 27,
} as const;

const COLS = 8;
const ROWS = 4;
const TS = 256;
const PAD = 8;
const P = TS - PAD * 2; // 240: the periodic interior of every tile
const AW = COLS * TS;
const AH = ROWS * TS;

type Ctx = CanvasRenderingContext2D;
interface TC {
  a: Ctx;
  h: Ctx;
  r: () => number;
  /** Draw `fn` at the nine wrapped offsets so the tile is periodic. */
  W(ctx: Ctx, fn: () => void): void;
}
interface TileDef {
  paint(t: TC): void;
  /** Low-frequency albedo variation. */
  mottle?: number;
  mottleFreq?: number;
  /** Per-pixel albedo grain. */
  grain?: number;
  /** Height noise amplitude and frequency. */
  hn?: number;
  hFreq?: number;
  /** Normal-map strength. */
  bump?: number;
  /** Tile has a meaningful alpha channel (cutout). */
  alpha?: boolean;
}

const g = (v: number, a = 1): string => {
  const c = Math.round(Math.max(0, Math.min(1, v)) * 255);
  return `rgba(${c},${c},${c},${a})`;
};
const rgb = (r: number, gg: number, b: number, a = 1): string =>
  `rgba(${Math.round(r)},${Math.round(gg)},${Math.round(b)},${a})`;

function blob(ctx: Ctx, x: number, y: number, rad: number, inner: string, outer: string): void {
  const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
  gr.addColorStop(0, inner);
  gr.addColorStop(1, outer);
  ctx.fillStyle = gr;
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fill();
}

function line(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, s: string): void {
  ctx.strokeStyle = s;
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Cross pattée (the Iron Cross outline), centred, arm reach `s`. */
function crossPath(ctx: Ctx, cx: number, cy: number, s: number): void {
  const n = 0.2 * s; // half-width at the centre
  const w = 0.52 * s; // half-width at the arm end
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    const c = Math.cos(a), sn = Math.sin(a);
    const pt = (u: number, v: number): [number, number] => [cx + u * c - v * sn, cy + u * sn + v * c];
    const p0 = pt(n, -n), p1 = pt(s, -w), p2 = pt(s, w), p3 = pt(n, n);
    // Flared arms with slightly concave sides.
    const q1 = pt(s * 0.62, -n * 1.05), q2 = pt(s * 0.62, n * 1.05);
    if (k === 0) ctx.moveTo(p0[0], p0[1]); else ctx.lineTo(p0[0], p0[1]);
    ctx.quadraticCurveTo(q1[0], q1[1], p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.quadraticCurveTo(q2[0], q2[1], p3[0], p3[1]);
  }
  ctx.closePath();
}
export { crossPath };

/* ------------------------------------------------------------------ tiles */

const DEFS: Record<number, TileDef> = {};

DEFS[TILE.PAINT] = {
  mottle: 0.1, grain: 0.035, hn: 0.05, bump: 1.4,
  paint({ a, h, r, W }) {
    a.fillStyle = g(0.8); a.fillRect(0, 0, P, P);
    for (let i = 0; i < 16; i++) {
      const x = r() * P, y = r() * P, rad = 8 + r() * 40;
      W(a, () => blob(a, x, y, rad, rgb(40, 32, 24, 0.12), rgb(40, 32, 24, 0)));
    }
    for (let i = 0; i < 10; i++) {
      const x = r() * P, y = r() * P, len = 30 + r() * 90;
      W(a, () => {
        const gr = a.createLinearGradient(x, y, x, y + len);
        gr.addColorStop(0, rgb(30, 25, 20, 0.12)); gr.addColorStop(1, rgb(30, 25, 20, 0));
        a.fillStyle = gr; a.fillRect(x, y, 2 + r() * 3, len);
      });
    }
    for (let i = 0; i < 30; i++) {
      const x = r() * P, y = r() * P, ang = r() * Math.PI, len = 4 + r() * 16;
      const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len;
      W(a, () => line(a, x, y, x1, y1, 1, g(1, 0.25)));
      W(h, () => line(h, x, y, x1, y1, 1, g(0.3, 0.6)));
    }
  },
};

DEFS[TILE.CANVAS] = {
  mottle: 0.07, mottleFreq: 3, grain: 0.06, hn: 0.08, bump: 2.2,
  paint({ a, h, r, W }) {
    a.fillStyle = g(0.84); a.fillRect(0, 0, P, P);
    // Two sewn strips per tile, each a slightly different dye lot.
    a.fillStyle = g(0.8, 0.35); a.fillRect(P / 2, 0, P / 2, P);
    for (let i = 0; i < 9; i++) {
      const x = r() * P, y = r() * P, rad = 10 + r() * 45;
      const dark = r() < 0.7;
      W(a, () => blob(a, x, y, rad, dark ? rgb(70, 55, 35, 0.08) : g(1, 0.06), dark ? rgb(70, 55, 35, 0) : g(1, 0)));
    }
    // Wrinkles: long soft diagonal ridges in the height layer.
    for (let i = 0; i < 9; i++) {
      const x = r() * P, y = r() * P, ang = -0.4 + r() * 0.8, len = 60 + r() * 140;
      const dx = Math.sin(ang) * len, dy = Math.cos(ang) * len;
      const w = 4 + r() * 10;
      W(h, () => line(h, x, y, x + dx, y + dy, w, g(r() < 0.5 ? 0.62 : 0.38, 0.35)));
    }
    for (const x of [0, P / 2]) {
      W(a, () => { line(a, x, 0, x, P, 3, g(0.55, 0.7)); });
      W(h, () => { line(h, x, 0, x, P, 4, g(0.72, 1)); line(h, x + 3, 0, x + 3, P, 1, g(0.4, 1)); });
      for (let y = 0; y < P; y += 6) W(a, () => line(a, x + 4, y, x + 4, y + 3, 1, g(0.45, 0.5)));
    }
  },
};

DEFS[TILE.BOARDS] = {
  mottle: 0.05, grain: 0.04, hn: 0.04, bump: 2.6,
  paint({ a, h, r, W }) {
    const n = 6, w = P / n;
    for (let i = 0; i < n; i++) {
      const x0 = i * w, lum = 0.6 + r() * 0.32;
      a.fillStyle = g(lum); a.fillRect(x0, 0, w, P);
      h.fillStyle = g(0.62); h.fillRect(x0, 0, w, P);
      const gr = h.createLinearGradient(x0, 0, x0 + w, 0);
      gr.addColorStop(0, g(0.4)); gr.addColorStop(0.12, g(0.62)); gr.addColorStop(0.88, g(0.62)); gr.addColorStop(1, g(0.42));
      h.fillStyle = gr; h.fillRect(x0, 0, w, P);
      for (let k = 0; k < 16; k++) {
        const gx = x0 + 2 + r() * (w - 4), amp = 1 + r() * 2.5, ph = r() * 6, fr = 0.01 + r() * 0.03;
        a.strokeStyle = g(r() < 0.5 ? 0.25 : 0.95, 0.12); a.lineWidth = 1;
        a.beginPath();
        for (let y = 0; y <= P; y += 6) {
          const xx = gx + Math.sin(y * fr * 6.28 + ph) * amp;
          if (y === 0) a.moveTo(xx, y); else a.lineTo(xx, y);
        }
        a.stroke();
      }
      if (r() < 0.6) {
        const kx = x0 + w * (0.3 + r() * 0.4), ky = r() * P;
        W(a, () => blob(a, kx, ky, 4 + r() * 3, g(0.15, 0.8), g(0.3, 0)));
        W(h, () => blob(h, kx, ky, 5, g(0.45, 1), g(0.62, 0)));
      }
      for (const ny of [P * 0.12, P * 0.62]) {
        for (const nx of [x0 + w * 0.3, x0 + w * 0.7]) {
          a.fillStyle = g(0.12, 0.8); a.fillRect(nx - 1, ny - 1, 2.5, 2.5);
        }
      }
      a.fillStyle = g(0.1); a.fillRect(x0, 0, 2, P);
      h.fillStyle = g(0.08); h.fillRect(x0, 0, 2, P);
    }
  },
};

DEFS[TILE.CLAP] = {
  mottle: 0.05, grain: 0.04, hn: 0.03, bump: 3,
  paint({ a, h, r }) {
    const n = 5, bh = P / n;
    for (let i = 0; i < n; i++) {
      const y0 = i * bh, lum = 0.64 + r() * 0.28;
      a.fillStyle = g(lum); a.fillRect(0, y0, P, bh);
      for (let k = 0; k < 12; k++) {
        const gy = y0 + 2 + r() * (bh - 5), ph = r() * 6;
        a.strokeStyle = g(r() < 0.5 ? 0.3 : 0.95, 0.1); a.lineWidth = 1;
        a.beginPath();
        for (let x = 0; x <= P; x += 6) {
          const yy = gy + Math.sin(x * 0.02 + ph) * 1.5;
          if (x === 0) a.moveTo(x, yy); else a.lineTo(x, yy);
        }
        a.stroke();
      }
      const gs = a.createLinearGradient(0, y0 + bh - 6, 0, y0 + bh);
      gs.addColorStop(0, g(0, 0)); gs.addColorStop(1, g(0, 0.55));
      a.fillStyle = gs; a.fillRect(0, y0 + bh - 6, P, 6);
      const gh = h.createLinearGradient(0, y0, 0, y0 + bh);
      gh.addColorStop(0, g(0.3)); gh.addColorStop(0.97, g(0.75)); gh.addColorStop(1, g(0.3));
      h.fillStyle = gh; h.fillRect(0, y0, P, bh);
    }
  },
};

/** Stable per-cell value so wrapped copies of a bag get the same colour. */
const cellVal = (seed: number, i: number, j: number): number => {
  const s = Math.sin(seed * 91.7 + i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

DEFS[TILE.SANDBAG] = {
  mottle: 0.08, grain: 0.14, hn: 0.06, bump: 3.2,
  paint({ a, h, r }) {
    const rows = 4, per = 2, bh = P / rows, bw = P / per;
    a.fillStyle = g(0.2); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.1); h.fillRect(0, 0, P, P);
    for (let row = 0; row < rows; row++) {
      const off = (row % 2) * bw * 0.5 + (cellVal(3, row, 0) - 0.5) * 10;
      for (let k = -1; k <= per; k++) {
        const kk = ((k % per) + per) % per;
        const v = cellVal(1, row, kk);
        const x = k * bw + off + 2, y = row * bh + 2, w = bw - 4, hh = bh - 4;
        const lum = 0.6 + v * 0.32;
        rrect(a, x, y, w, hh, 16); a.fillStyle = g(lum); a.fill();
        const gv = a.createLinearGradient(0, y, 0, y + hh);
        gv.addColorStop(0, g(1, 0.1)); gv.addColorStop(0.5, g(1, 0)); gv.addColorStop(1, g(0, 0.3));
        rrect(a, x, y, w, hh, 16); a.fillStyle = gv; a.fill();
        // Pillow: brightest in the middle of each bag.
        h.save(); h.translate(x + w / 2, y + hh / 2); h.scale(w / hh, 1);
        const gp = h.createRadialGradient(0, 0, 0, 0, 0, hh * 0.62);
        gp.addColorStop(0, g(0.95)); gp.addColorStop(0.7, g(0.62)); gp.addColorStop(1, g(0.3));
        h.fillStyle = gp; h.beginPath(); h.arc(0, 0, hh * 0.62, 0, Math.PI * 2); h.fill();
        h.restore();
        // Tied end: a pucker of creases.
        const tie = cellVal(2, row, kk) < 0.5 ? x + 8 : x + w - 8;
        for (let c = 0; c < 5; c++) {
          const ang = -0.9 + c * 0.45;
          const dir = tie < x + w / 2 ? 1 : -1;
          line(a, tie, y + hh / 2, tie + dir * Math.cos(ang) * 14, y + hh / 2 + Math.sin(ang) * 12, 1.2, g(0.2, 0.45));
          line(h, tie, y + hh / 2, tie + dir * Math.cos(ang) * 14, y + hh / 2 + Math.sin(ang) * 12, 1.5, g(0.35, 0.6));
        }
        line(a, x + 14, y + 7, x + w - 14, y + 7, 1, g(0.3, 0.3));
        if (v > 0.75) blob(a, x + w * r(), y + hh * r(), 10 + r() * 10, rgb(50, 40, 25, 0.25), rgb(50, 40, 25, 0));
      }
    }
  },
};

DEFS[TILE.CORRUGATED] = {
  mottle: 0.12, mottleFreq: 3, grain: 0.03, hn: 0.02, bump: 3.2,
  paint({ a, h, r, W }) {
    const ribs = 12;
    for (let x = 0; x < P; x++) {
      const s = Math.sin((x / P) * ribs * Math.PI * 2);
      h.fillStyle = g(0.5 + 0.42 * s); h.fillRect(x, 0, 1, P);
      a.fillStyle = g(0.72 + 0.05 * s); a.fillRect(x, 0, 1, P);
    }
    for (let i = 0; i < 14; i++) {
      const x = r() * P, y = r() * P, len = 20 + r() * 110, w = 2 + r() * 7;
      W(a, () => {
        const gr = a.createLinearGradient(x, y, x, y + len);
        gr.addColorStop(0, rgb(120, 62, 25, 0.35)); gr.addColorStop(1, rgb(120, 62, 25, 0));
        a.fillStyle = gr; a.fillRect(x, y, w, len);
      });
    }
    for (let i = 0; i < 30; i++) {
      const x = r() * P, y = r() * P;
      W(a, () => blob(a, x, y, 2 + r() * 6, rgb(110, 55, 22, 0.4), rgb(110, 55, 22, 0)));
    }
    // Sheet overlap and the nails along a purlin.
    a.fillStyle = g(0.35, 0.8); a.fillRect(0, 0, 2, P);
    for (let k = 0; k < ribs; k++) {
      const x = ((k + 0.25) / ribs) * P;
      a.fillStyle = g(0.95); a.fillRect(x - 1, P * 0.1 - 1, 3, 3);
      h.fillStyle = g(1); h.fillRect(x - 1, P * 0.1 - 1, 3, 3);
    }
  },
};

DEFS[TILE.EARTH] = {
  mottle: 0.2, mottleFreq: 3, grain: 0.1, hn: 0.3, hFreq: 6, bump: 2,
  paint({ a, h, r, W }) {
    a.fillStyle = g(0.82); a.fillRect(0, 0, P, P);
    for (let i = 0; i < 70; i++) {
      const x = r() * P, y = r() * P, rad = 3 + r() * 13, lum = 0.6 + r() * 0.4;
      W(a, () => blob(a, x, y, rad, g(lum, 0.45), g(lum, 0)));
      W(h, () => blob(h, x, y, rad, g(0.75, 0.6), g(0.5, 0)));
    }
    for (let i = 0; i < 90; i++) {
      const x = r() * P, y = r() * P, rad = 1 + r() * 2.2;
      W(a, () => {
        a.fillStyle = g(0.2, 0.5); a.beginPath(); a.arc(x + 1, y + 1, rad, 0, 7); a.fill();
        a.fillStyle = g(0.85 + r() * 0.15); a.beginPath(); a.arc(x, y, rad, 0, 7); a.fill();
      });
      W(h, () => { h.fillStyle = g(0.95); h.beginPath(); h.arc(x, y, rad, 0, 7); h.fill(); });
    }
  },
};

DEFS[TILE.TURF] = {
  mottle: 0.16, mottleFreq: 3, grain: 0.08, hn: 0.15, bump: 1.6,
  paint({ a, h, r, W }) {
    a.fillStyle = g(0.72); a.fillRect(0, 0, P, P);
    for (let i = 0; i < 1800; i++) {
      const x = r() * P, y = r() * P, ang = -Math.PI / 2 + (r() - 0.5) * 1.2, len = 3 + r() * 8;
      const x1 = x + Math.cos(ang) * len, y1 = y + Math.sin(ang) * len, lum = 0.55 + r() * 0.45;
      W(a, () => line(a, x, y, x1, y1, 1.1, g(lum, 0.8)));
      if (i % 3 === 0) W(h, () => line(h, x, y, x1, y1, 1.2, g(0.8, 0.5)));
    }
  },
};

DEFS[TILE.CONCRETE] = {
  mottle: 0.1, grain: 0.07, hn: 0.08, bump: 1.6,
  paint({ a, h, r, W }) {
    a.fillStyle = g(0.78); a.fillRect(0, 0, P, P);
    const n = 4, bh = P / n;
    for (let i = 0; i < n; i++) {
      a.fillStyle = g(0.5 + r(), 0.05); a.fillRect(0, i * bh, P, bh);
      line(a, 0, i * bh, P, i * bh, 1.5, g(0.35, 0.5));
      line(h, 0, i * bh, P, i * bh, 2, g(0.7, 0.8));
      for (let k = 0; k < 8; k++) {
        const y = i * bh + r() * bh;
        line(a, 0, y, P, y + (r() - 0.5) * 3, 1, g(r() < 0.5 ? 0.3 : 1, 0.06));
      }
    }
    for (let i = 0; i < 500; i++) {
      const x = r() * P, y = r() * P, lum = r();
      a.fillStyle = g(lum, 0.35); a.fillRect(x, y, 1 + r() * 1.5, 1 + r() * 1.5);
    }
    for (let i = 0; i < 50; i++) {
      const x = r() * P, y = r() * P, rad = 0.8 + r() * 1.8;
      a.fillStyle = g(0.25, 0.7); a.beginPath(); a.arc(x, y, rad, 0, 7); a.fill();
      h.fillStyle = g(0.2); h.beginPath(); h.arc(x, y, rad, 0, 7); h.fill();
    }
    for (let i = 0; i < 10; i++) {
      const x = r() * P, y = r() * P, len = 30 + r() * 80;
      W(a, () => {
        const gr = a.createLinearGradient(x, y, x, y + len);
        gr.addColorStop(0, rgb(40, 38, 30, 0.14)); gr.addColorStop(1, rgb(40, 38, 30, 0));
        a.fillStyle = gr; a.fillRect(x, y, 3 + r() * 8, len);
      });
    }
  },
};

DEFS[TILE.BRICK] = {
  mottle: 0.08, grain: 0.08, hn: 0.05, bump: 2.6,
  paint({ a, h, r }) {
    a.fillStyle = rgb(168, 160, 146); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.25); h.fillRect(0, 0, P, P);
    const rows = 8, per = 4, bh = P / rows, bw = P / per;
    for (let row = 0; row < rows; row++) {
      const off = (row % 2) * bw * 0.5;
      for (let k = -1; k <= per; k++) {
        const kk = ((k % per) + per) % per;
        const v = cellVal(7, row, kk), burnt = cellVal(8, row, kk) < 0.12;
        const x = k * bw + off + 1.5, y = row * bh + 1.5;
        a.fillStyle = burnt ? rgb(92 + v * 20, 50, 40) : rgb(140 + v * 40, 62 + v * 30, 45 + v * 22);
        a.fillRect(x, y, bw - 3, bh - 3);
        h.fillStyle = g(0.7 + v * 0.1); h.fillRect(x, y, bw - 3, bh - 3);
        if (r() < 0.3) blob(a, x + r() * bw, y + r() * bh, 5 + r() * 8, g(0.9, 0.12), g(0.9, 0));
      }
    }
  },
};

DEFS[TILE.PLASTER] = {
  mottle: 0.1, mottleFreq: 3, grain: 0.06, hn: 0.08, bump: 2,
  paint({ a, h, r, W }) {
    a.fillStyle = rgb(206, 197, 176); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.7); h.fillRect(0, 0, P, P);
    for (let i = 0; i < 12; i++) {
      const x = r() * P, y = r() * P, rad = 12 + r() * 40;
      W(a, () => blob(a, x, y, rad, rgb(120, 110, 85, 0.12), rgb(120, 110, 85, 0)));
    }
    // Patches where the render has fallen away, exposing rubble stone.
    for (let i = 0; i < 3; i++) {
      const cx = r() * P, cy = r() * P, rad = 16 + r() * 22;
      const pts: [number, number][] = [];
      for (let k = 0; k < 9; k++) {
        const ang = (k / 9) * Math.PI * 2, rr = rad * (0.6 + r() * 0.5);
        pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr * 0.75]);
      }
      const stones: [number, number, number, number, number][] = [];
      for (let k = 0; k < 14; k++) stones.push([(r() - 0.5) * rad * 2, (r() - 0.5) * rad * 1.5, 6 + r() * 9, 4 + r() * 6, 0.45 + r() * 0.35]);
      W(a, () => {
        a.save(); a.translate(cx, cy);
        a.beginPath(); pts.forEach((p, k) => (k ? a.lineTo(p[0], p[1]) : a.moveTo(p[0], p[1]))); a.closePath();
        a.fillStyle = rgb(120, 112, 98); a.fill(); a.save(); a.clip();
        for (const s of stones) { rrect(a, s[0], s[1], s[2], s[3], 2); a.fillStyle = g(s[4]); a.fill(); }
        a.restore();
        a.strokeStyle = rgb(90, 80, 60, 0.6); a.lineWidth = 1.5; a.stroke();
        a.restore();
      });
      W(h, () => {
        h.save(); h.translate(cx, cy);
        h.beginPath(); pts.forEach((p, k) => (k ? h.lineTo(p[0], p[1]) : h.moveTo(p[0], p[1]))); h.closePath();
        h.fillStyle = g(0.35); h.fill(); h.save(); h.clip();
        for (const s of stones) { rrect(h, s[0], s[1], s[2], s[3], 2); h.fillStyle = g(0.55); h.fill(); }
        h.restore(); h.restore();
      });
    }
  },
};

DEFS[TILE.ROOFTILE] = {
  mottle: 0.1, grain: 0.06, hn: 0.03, bump: 3,
  paint({ a, h, r }) {
    const rows = 6, cols = 8, th = P / rows, tw = P / cols;
    for (let row = 0; row < rows; row++) {
      for (let c = 0; c < cols; c++) {
        const v = cellVal(11, row, c), x = c * tw, y = row * th;
        const base = v < 0.1 ? [120, 70, 55] : [158 + v * 30, 72 + v * 22, 48 + v * 14];
        const gr = a.createLinearGradient(x, 0, x + tw, 0);
        gr.addColorStop(0, rgb(base[0] * 0.8, base[1] * 0.8, base[2] * 0.8));
        gr.addColorStop(0.4, rgb(base[0] * 1.08, base[1] * 1.08, base[2] * 1.08));
        gr.addColorStop(1, rgb(base[0] * 0.62, base[1] * 0.62, base[2] * 0.62));
        a.fillStyle = gr; a.fillRect(x, y, tw, th);
        const gh = h.createLinearGradient(x, 0, x + tw, 0);
        gh.addColorStop(0, g(0.3)); gh.addColorStop(0.45, g(0.85)); gh.addColorStop(1, g(0.3));
        h.fillStyle = gh; h.fillRect(x, y, tw, th);
        if (r() < 0.4) blob(a, x + r() * tw, y + r() * th, 3 + r() * 5, rgb(170, 165, 110, 0.5), rgb(170, 165, 110, 0));
      }
      const gs = a.createLinearGradient(0, row * th + th - 7, 0, row * th + th);
      gs.addColorStop(0, g(0, 0)); gs.addColorStop(1, g(0, 0.6));
      a.fillStyle = gs; a.fillRect(0, row * th + th - 7, P, 7);
      const hs = h.createLinearGradient(0, row * th, 0, row * th + th);
      hs.addColorStop(0, g(0, 0.3)); hs.addColorStop(1, g(1, 0.25));
      h.fillStyle = hs; h.fillRect(0, row * th, P, th);
    }
  },
};

DEFS[TILE.WINDOW] = {
  grain: 0.02, bump: 2.5,
  paint({ a, h, r }) {
    a.fillStyle = g(0.86); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.8); h.fillRect(0, 0, P, P);
    const fr = P * 0.1, cols = 2, rows = 3, mw = P * 0.05;
    const iw = P - fr * 2, ih = P - fr * 2;
    const pw = (iw - mw * (cols - 1)) / cols, ph = (ih - mw * (rows - 1)) / rows;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const x = fr + i * (pw + mw), y = fr + j * (ph + mw);
        const gr = a.createLinearGradient(x, y, x + pw, y + ph);
        const k = r() * 0.2;
        gr.addColorStop(0, rgb(70 + k * 60, 82 + k * 60, 95 + k * 60));
        gr.addColorStop(0.45, rgb(28, 34, 40));
        gr.addColorStop(1, rgb(18, 20, 24));
        a.fillStyle = gr; a.fillRect(x, y, pw, ph);
        line(a, x + pw * 0.15, y + ph * 0.9, x + pw * 0.8, y + ph * 0.15, 3, g(1, 0.12));
        h.fillStyle = g(0.4); h.fillRect(x, y, pw, ph);
      }
    }
    a.strokeStyle = g(0.3, 0.7); a.lineWidth = 3; a.strokeRect(1.5, 1.5, P - 3, P - 3);
  },
};

DEFS[TILE.DOOR] = {
  mottle: 0.06, grain: 0.05, bump: 2.8,
  paint({ a, h, r }) {
    const n = 5, w = P / n;
    for (let i = 0; i < n; i++) {
      a.fillStyle = g(0.66 + r() * 0.22); a.fillRect(i * w, 0, w, P);
      a.fillStyle = g(0.12); a.fillRect(i * w, 0, 2, P);
      h.fillStyle = g(0.6); h.fillRect(i * w, 0, w, P);
      h.fillStyle = g(0.1); h.fillRect(i * w, 0, 2, P);
    }
    for (const y of [P * 0.12, P * 0.5, P * 0.86]) {
      a.fillStyle = g(0.72); a.fillRect(0, y - 9, P, 18);
      a.fillStyle = g(0, 0.4); a.fillRect(0, y + 8, P, 3);
      h.fillStyle = g(0.9); h.fillRect(0, y - 9, P, 18);
    }
    a.save(); a.beginPath(); a.moveTo(P * 0.06, P * 0.5); a.lineTo(P * 0.94, P * 0.12); a.lineTo(P * 0.94, P * 0.2); a.lineTo(P * 0.06, P * 0.58); a.closePath();
    a.fillStyle = g(0.7); a.fill(); a.restore();
    h.beginPath(); h.moveTo(P * 0.06, P * 0.5); h.lineTo(P * 0.94, P * 0.12); h.lineTo(P * 0.94, P * 0.2); h.lineTo(P * 0.06, P * 0.58); h.closePath();
    h.fillStyle = g(0.9); h.fill();
    blob(a, P * 0.85, P * 0.55, 7, g(0.08), g(0.08, 0));
    a.strokeStyle = g(0.15); a.lineWidth = 6; a.strokeRect(0, 0, P, P);
  },
};

DEFS[TILE.WHEEL] = {
  grain: 0.04, bump: 3,
  paint({ a, h }) {
    const c = P / 2;
    a.fillStyle = g(0.05); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.2); h.fillRect(0, 0, P, P);
    // Solid rubber tyre.
    a.fillStyle = g(0.1); a.beginPath(); a.arc(c, c, c, 0, 7); a.fill();
    h.fillStyle = g(0.8); h.beginPath(); h.arc(c, c, c, 0, 7); h.fill();
    // Felloe.
    a.fillStyle = g(0.8); a.beginPath(); a.arc(c, c, c * 0.8, 0, 7); a.fill();
    h.fillStyle = g(0.7); h.beginPath(); h.arc(c, c, c * 0.8, 0, 7); h.fill();
    a.fillStyle = g(0.05); a.beginPath(); a.arc(c, c, c * 0.68, 0, 7); a.fill();
    h.fillStyle = g(0.15); h.beginPath(); h.arc(c, c, c * 0.68, 0, 7); h.fill();
    // Spokes.
    for (let k = 0; k < 12; k++) {
      const ang = (k / 12) * Math.PI * 2;
      const x0 = c + Math.cos(ang) * c * 0.2, y0 = c + Math.sin(ang) * c * 0.2;
      const x1 = c + Math.cos(ang) * c * 0.72, y1 = c + Math.sin(ang) * c * 0.72;
      line(a, x0, y0, x1, y1, 11, g(0.82));
      line(h, x0, y0, x1, y1, 11, g(0.75));
      line(a, x0, y0, x1, y1, 3, g(1, 0.15));
    }
    a.fillStyle = g(0.62); a.beginPath(); a.arc(c, c, c * 0.24, 0, 7); a.fill();
    h.fillStyle = g(0.9); h.beginPath(); h.arc(c, c, c * 0.24, 0, 7); h.fill();
    a.fillStyle = g(0.3); a.beginPath(); a.arc(c, c, c * 0.1, 0, 7); a.fill();
    for (let k = 0; k < 6; k++) {
      const ang = (k / 6) * Math.PI * 2;
      a.fillStyle = g(0.2); a.beginPath(); a.arc(c + Math.cos(ang) * c * 0.17, c + Math.sin(ang) * c * 0.17, 3, 0, 7); a.fill();
    }
  },
};

DEFS[TILE.WICKER] = {
  grain: 0.08, mottle: 0.08, bump: 3.2,
  paint({ a, h, r }) {
    a.fillStyle = g(0.18); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.15); h.fillRect(0, 0, P, P);
    const rows = 16, cols = 10, rh = P / rows, cw = P / cols;
    for (let row = 0; row < rows; row++) {
      for (let c = -1; c <= cols; c++) {
        const off = (row % 2) * cw * 0.5;
        const x = c * cw + off + cw / 2, y = row * rh + rh / 2;
        const lum = 0.7 + cellVal(15, row, ((c % cols) + cols) % cols) * 0.28;
        a.save(); a.translate(x, y); a.scale(cw * 0.55, rh * 0.52);
        const gr = a.createRadialGradient(0, -0.3, 0, 0, 0, 1);
        gr.addColorStop(0, g(lum)); gr.addColorStop(1, g(lum * 0.55));
        a.fillStyle = gr; a.beginPath(); a.arc(0, 0, 1, 0, 7); a.fill(); a.restore();
        h.save(); h.translate(x, y); h.scale(cw * 0.55, rh * 0.52);
        const gh = h.createRadialGradient(0, 0, 0, 0, 0, 1);
        gh.addColorStop(0, g(0.95)); gh.addColorStop(1, g(0.35));
        h.fillStyle = gh; h.beginPath(); h.arc(0, 0, 1, 0, 7); h.fill(); h.restore();
      }
    }
    void r;
  },
};

DEFS[TILE.CRATE] = {
  mottle: 0.08, grain: 0.05, bump: 2.4,
  paint({ a, h, r }) {
    a.fillStyle = rgb(176, 146, 104); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    const n = 3, bh = P / n;
    for (let i = 0; i < n; i++) {
      a.fillStyle = rgb(150 + r() * 40, 120 + r() * 30, 82 + r() * 20); a.fillRect(0, i * bh, P, bh);
      a.fillStyle = g(0.1, 0.8); a.fillRect(0, i * bh, P, 2);
      h.fillStyle = g(0.1); h.fillRect(0, i * bh, P, 2);
      for (let k = 0; k < 10; k++) {
        const y = i * bh + r() * bh;
        line(a, 0, y, P, y + (r() - 0.5) * 4, 1, g(r() < 0.5 ? 0.2 : 1, 0.08));
      }
    }
    // Frame battens.
    a.strokeStyle = rgb(120, 92, 60); a.lineWidth = 22; a.strokeRect(11, 11, P - 22, P - 22);
    h.strokeStyle = g(0.85); h.lineWidth = 22; h.strokeRect(11, 11, P - 22, P - 22);
    a.strokeStyle = g(0, 0.35); a.lineWidth = 2; a.strokeRect(22, 22, P - 44, P - 44);
    // Stencils.
    a.fillStyle = rgb(35, 30, 25, 0.78);
    a.font = 'bold 34px sans-serif';
    a.textAlign = 'center';
    a.fillText('S.A.A.', P / 2, P * 0.46);
    a.font = 'bold 22px sans-serif';
    a.fillText('Mk VII  1000', P / 2, P * 0.64);
    // Broad arrow.
    a.lineWidth = 5; a.strokeStyle = rgb(35, 30, 25, 0.78);
    a.beginPath(); a.moveTo(P / 2, P * 0.72); a.lineTo(P / 2, P * 0.84);
    a.moveTo(P / 2 - 10, P * 0.8); a.lineTo(P / 2, P * 0.72); a.lineTo(P / 2 + 10, P * 0.8); a.stroke();
  },
};

DEFS[TILE.RIVET] = {
  mottle: 0.08, grain: 0.03, bump: 2.4,
  paint({ a, h }) {
    a.fillStyle = g(0.78); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    for (const x of [0, P / 2]) {
      line(a, x, 0, x, P, 1.5, g(0.3, 0.6)); line(h, x, 0, x, P, 2, g(0.3));
      line(a, 0, x, P, x, 1.5, g(0.3, 0.6)); line(h, 0, x, P, x, 2, g(0.3));
      for (let t = 5; t < P; t += 12) {
        for (const [px, py] of [[x + 6, t], [t, x + 6]]) {
          a.fillStyle = g(0.92); a.beginPath(); a.arc(px, py, 1.8, 0, 7); a.fill();
          h.fillStyle = g(0.9); h.beginPath(); h.arc(px, py, 2, 0, 7); h.fill();
        }
      }
    }
  },
};

DEFS[TILE.TARP] = {
  mottle: 0.1, grain: 0.05, hn: 0.12, bump: 2.8,
  paint({ a, h, r, W }) {
    a.fillStyle = g(0.62); a.fillRect(0, 0, P, P);
    for (let i = 0; i < 12; i++) {
      const x = r() * P, y = r() * P, ang = r() * Math.PI, len = 80 + r() * 160, w = 6 + r() * 18;
      const dx = Math.cos(ang) * len, dy = Math.sin(ang) * len, lum = r() < 0.5 ? 0.75 : 0.25;
      W(h, () => line(h, x - dx / 2, y - dy / 2, x + dx / 2, y + dy / 2, w, g(lum, 0.35)));
      W(a, () => line(a, x - dx / 2, y - dy / 2, x + dx / 2, y + dy / 2, w * 0.6, g(lum > 0.5 ? 1 : 0, 0.06)));
    }
    for (let i = 0; i < 8; i++) {
      const x = r() * P, y = r() * P;
      W(a, () => blob(a, x, y, 14 + r() * 30, rgb(40, 35, 25, 0.15), rgb(40, 35, 25, 0)));
    }
  },
};

DEFS[TILE.NET] = {
  alpha: true, grain: 0.05, bump: 2,
  paint({ a, h, r, W }) {
    a.clearRect(0, 0, P, P);
    h.fillStyle = g(0.3); h.fillRect(0, 0, P, P);
    const step = 20;
    for (let k = -P; k <= P * 2; k += step) {
      W(a, () => { line(a, k, 0, k + P, P, 1.8, rgb(62, 56, 40)); line(a, k, 0, k - P, P, 1.8, rgb(62, 56, 40)); });
    }
    const pal = [[96, 106, 60], [118, 124, 72], [128, 106, 66], [160, 140, 88], [70, 78, 50], [104, 92, 58]];
    for (let i = 0; i < 125; i++) {
      const x = r() * P, y = r() * P, ang = r() * Math.PI, lw = 5 + r() * 11, lh = 2 + r() * 4;
      const c = pal[Math.floor(r() * pal.length)];
      W(a, () => {
        a.save(); a.translate(x, y); a.rotate(ang); a.fillStyle = rgb(c[0], c[1], c[2]);
        a.beginPath(); a.ellipse(0, 0, lw, lh, 0, 0, 7); a.fill(); a.restore();
      });
      W(h, () => {
        h.save(); h.translate(x, y); h.rotate(ang); h.fillStyle = g(0.5 + r() * 0.4);
        h.beginPath(); h.ellipse(0, 0, lw, lh, 0, 0, 7); h.fill(); h.restore();
      });
    }
  },
};

DEFS[TILE.ROUNDEL] = {
  alpha: true, bump: 0.5,
  paint({ a, h }) {
    const c = P / 2;
    a.clearRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    a.fillStyle = rgb(30, 50, 110); a.beginPath(); a.arc(c, c, c * 0.97, 0, 7); a.fill();
    a.fillStyle = rgb(232, 230, 222); a.beginPath(); a.arc(c, c, c * 0.66, 0, 7); a.fill();
    a.fillStyle = rgb(176, 34, 38); a.beginPath(); a.arc(c, c, c * 0.33, 0, 7); a.fill();
  },
};

DEFS[TILE.CROSS] = {
  alpha: true, bump: 0.5,
  paint({ a, h }) {
    const c = P / 2;
    a.clearRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    crossPath(a, c, c, c * 0.97); a.fillStyle = rgb(236, 234, 228); a.fill();
    crossPath(a, c, c, c * 0.84); a.fillStyle = rgb(16, 16, 16); a.fill();
  },
};

DEFS[TILE.CROSSFIELD] = {
  grain: 0.03, mottle: 0.04, bump: 0.8,
  paint({ a, h }) {
    const c = P / 2;
    a.fillStyle = rgb(226, 224, 216); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    crossPath(a, c, c, c * 0.8); a.fillStyle = rgb(16, 16, 16); a.fill();
  },
};

DEFS[TILE.RADIATOR] = {
  grain: 0.04, bump: 3,
  paint({ a, h }) {
    a.fillStyle = g(0.55); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.8); h.fillRect(0, 0, P, P);
    const m = P * 0.12;
    a.fillStyle = g(0.1); a.fillRect(m, m, P - 2 * m, P - 2 * m);
    h.fillStyle = g(0.2); h.fillRect(m, m, P - 2 * m, P - 2 * m);
    for (let y = m; y < P - m; y += 5) {
      for (let x = m + ((y / 5) % 2) * 2.5; x < P - m; x += 5) {
        a.fillStyle = g(0.32); a.fillRect(x, y, 3.2, 3.2);
        h.fillStyle = g(0.6); h.fillRect(x, y, 3, 3);
      }
    }
    a.strokeStyle = g(0.85); a.lineWidth = 4; a.strokeRect(m - 2, m - 2, P - 2 * m + 4, P - 2 * m + 4);
  },
};

DEFS[TILE.SCORCH] = {
  alpha: true, mottle: 0.2, grain: 0.1, hn: 0.2, bump: 1.5,
  paint({ a, h, r }) {
    const c = P / 2;
    a.clearRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    // Ragged outline: radius wobbles with angle.
    const lobes: number[] = [];
    for (let k = 0; k < 24; k++) lobes.push(0.72 + r() * 0.26);
    a.beginPath();
    for (let k = 0; k <= 96; k++) {
      const t = (k / 96) * 24, i0 = Math.floor(t) % 24, i1 = (i0 + 1) % 24, f = t - Math.floor(t);
      const rr = c * (lobes[i0] * (1 - f) + lobes[i1] * f);
      const ang = (k / 96) * Math.PI * 2;
      const x = c + Math.cos(ang) * rr, y = c + Math.sin(ang) * rr;
      if (k === 0) a.moveTo(x, y); else a.lineTo(x, y);
    }
    a.closePath();
    const gr = a.createRadialGradient(c, c, 0, c, c, c);
    gr.addColorStop(0, rgb(14, 12, 11)); gr.addColorStop(0.55, rgb(26, 22, 18)); gr.addColorStop(1, rgb(58, 46, 34));
    a.fillStyle = gr; a.fill();
    a.save(); a.clip();
    for (let i = 0; i < 40; i++) {
      const x = c + (r() - 0.5) * c * 1.4, y = c + (r() - 0.5) * c * 1.4;
      blob(a, x, y, 4 + r() * 16, r() < 0.5 ? rgb(92, 88, 82, 0.35) : rgb(8, 7, 6, 0.5), rgb(0, 0, 0, 0));
    }
    a.restore();
  },
};

DEFS[TILE.FELT] = {
  mottle: 0.12, grain: 0.07, hn: 0.05, bump: 1.8,
  paint({ a, h, r, W }) {
    // Tarred roofing felt in overlapping strips.
    a.fillStyle = g(0.5); a.fillRect(0, 0, P, P);
    for (let i = 0; i < 4; i++) {
      const y = (i * P) / 4;
      line(a, 0, y, P, y, 2, g(0.2, 0.8)); line(h, 0, y, P, y, 3, g(0.8));
    }
    for (let i = 0; i < 20; i++) {
      const x = r() * P, y = r() * P;
      W(a, () => blob(a, x, y, 6 + r() * 20, g(0.9, 0.12), g(0.9, 0)));
    }
  },
};

DEFS[TILE.GRILLE] = {
  grain: 0.03, bump: 2,
  paint({ a, h }) {
    // Louvres / vents (engine bonnets, searchlight hoods).
    a.fillStyle = g(0.75); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    for (let y = 10; y < P; y += 20) {
      a.fillStyle = g(0.12); a.fillRect(12, y, P - 24, 6);
      a.fillStyle = g(0.95, 0.5); a.fillRect(12, y + 6, P - 24, 2);
      h.fillStyle = g(0.15); h.fillRect(12, y, P - 24, 6);
      h.fillStyle = g(0.85); h.fillRect(12, y + 6, P - 24, 3);
    }
  },
};

DEFS[TILE.SHELLCASE] = {
  mottle: 0.1, grain: 0.03, bump: 1.4,
  paint({ a, h, r }) {
    // Shell bodies: painted with a driving band and fuze; u around, v along.
    a.fillStyle = g(0.8); a.fillRect(0, 0, P, P);
    h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    a.fillStyle = rgb(160, 95, 50); a.fillRect(0, P * 0.78, P, P * 0.06);
    h.fillStyle = g(0.8); h.fillRect(0, P * 0.78, P, P * 0.06);
    a.fillStyle = g(0.25, 0.8); a.fillRect(0, P * 0.3, P, P * 0.025);
    for (let i = 0; i < 20; i++) blob(a, r() * P, r() * P, 4 + r() * 8, g(0, 0.08), g(0, 0));
  },
};

/* --------------------------------------------------------------- painting */

function periodicNoise(f: number, r: () => number): Float32Array {
  const lat = new Float32Array(f * f);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const out = new Float32Array(P * P);
  for (let y = 0; y < P; y++) {
    const fy = (y / P) * f, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
    const y0 = iy % f, y1 = (iy + 1) % f;
    for (let x = 0; x < P; x++) {
      const fx = (x / P) * f, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
      const x0 = ix % f, x1 = (ix + 1) % f;
      const a = lat[y0 * f + x0] + (lat[y0 * f + x1] - lat[y0 * f + x0]) * sx;
      const b = lat[y1 * f + x0] + (lat[y1 * f + x1] - lat[y1 * f + x0]) * sx;
      out[y * P + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbm(f0: number, oct: number, r: () => number): Float32Array {
  const out = new Float32Array(P * P);
  let amp = 1, sum = 0;
  for (let o = 0; o < oct; o++) {
    const n = periodicNoise(f0 << o, r);
    for (let i = 0; i < out.length; i++) out[i] += (n[i] - 0.5) * 2 * amp;
    sum += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum;
  return out;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let _atlas: { map: THREE.DataTexture; normalMap: THREE.DataTexture } | null = null;

/** Paint (once) and return the shared ground atlas. */
export function groundAtlas(): { map: THREE.DataTexture; normalMap: THREE.DataTexture } {
  if (_atlas) return _atlas;
  const alb = new Uint8Array(AW * AH * 4);
  const nrm = new Uint8Array(AW * AH * 4);
  // Unused tiles: mid grey, flat.
  for (let i = 0; i < AW * AH; i++) {
    alb[i * 4] = alb[i * 4 + 1] = alb[i * 4 + 2] = 200; alb[i * 4 + 3] = 255;
    nrm[i * 4] = 128; nrm[i * 4 + 1] = 128; nrm[i * 4 + 2] = 255; nrm[i * 4 + 3] = 255;
  }
  const ca = canvas(P, P), ch = canvas(P, P);
  const a = ca.getContext('2d', { willReadFrequently: true })!;
  const h = ch.getContext('2d', { willReadFrequently: true })!;
  for (const key of Object.keys(DEFS)) {
    const id = Number(key);
    const def = DEFS[id];
    const r = rng(1000 + id * 77);
    a.setTransform(1, 0, 0, 1, 0, 0); a.globalAlpha = 1; a.clearRect(0, 0, P, P);
    h.setTransform(1, 0, 0, 1, 0, 0); h.globalAlpha = 1; h.fillStyle = g(0.5); h.fillRect(0, 0, P, P);
    const W = (ctx: Ctx, fn: () => void): void => {
      for (const ox of [-P, 0, P]) {
        for (const oy of [-P, 0, P]) {
          ctx.save(); ctx.translate(ox, oy); fn(); ctx.restore();
        }
      }
    };
    def.paint({ a, h, r, W });
    const ad = a.getImageData(0, 0, P, P).data;
    const hd = h.getImageData(0, 0, P, P).data;
    const mot = def.mottle ? fbm(def.mottleFreq ?? 4, 4, r) : null;
    const hno = def.hn ? fbm(def.hFreq ?? 8, 4, r) : null;
    const grain = def.grain ?? 0;
    const hf = new Float32Array(P * P);
    for (let i = 0; i < P * P; i++) {
      let k = 1;
      if (mot) k += mot[i] * (def.mottle ?? 0);
      if (grain) k += (r() - 0.5) * 2 * grain;
      ad[i * 4] = Math.min(255, ad[i * 4] * k);
      ad[i * 4 + 1] = Math.min(255, ad[i * 4 + 1] * k);
      ad[i * 4 + 2] = Math.min(255, ad[i * 4 + 2] * k);
      if (def.alpha) ad[i * 4 + 3] = ad[i * 4 + 3] > 110 ? 255 : 0;
      else ad[i * 4 + 3] = 255;
      hf[i] = hd[i * 4] / 255 + (hno ? hno[i] * (def.hn ?? 0) : 0);
    }
    // Height → tangent-space normal (+v runs down the canvas, see util.ts).
    const bump = def.bump ?? 1.5;
    const nx = new Float32Array(P * P), ny = new Float32Array(P * P), nz = new Float32Array(P * P);
    for (let y = 0; y < P; y++) {
      for (let x = 0; x < P; x++) {
        const l = hf[y * P + ((x + P - 1) % P)], rr = hf[y * P + ((x + 1) % P)];
        const u = hf[((y + P - 1) % P) * P + x], d = hf[((y + 1) % P) * P + x];
        let vx = -(rr - l) * bump, vy = -(d - u) * bump;
        const len = Math.hypot(vx, vy, 1);
        vx /= len; vy /= len;
        const i = y * P + x;
        nx[i] = vx; ny[i] = vy; nz[i] = 1 / len;
      }
    }
    const col = id % COLS, row = Math.floor(id / COLS);
    for (let ty = 0; ty < TS; ty++) {
      const sy = (((ty - PAD) % P) + P) % P;
      for (let tx = 0; tx < TS; tx++) {
        const sx = (((tx - PAD) % P) + P) % P;
        const si = sy * P + sx;
        const di = ((row * TS + ty) * AW + col * TS + tx) * 4;
        alb[di] = ad[si * 4]; alb[di + 1] = ad[si * 4 + 1]; alb[di + 2] = ad[si * 4 + 2]; alb[di + 3] = ad[si * 4 + 3];
        nrm[di] = Math.round((nx[si] * 0.5 + 0.5) * 255);
        nrm[di + 1] = Math.round((ny[si] * 0.5 + 0.5) * 255);
        nrm[di + 2] = Math.round((nz[si] * 0.5 + 0.5) * 255);
        nrm[di + 3] = 255;
      }
    }
  }
  const mk = (data: Uint8Array<ArrayBuffer>, srgb: boolean): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, AW, AH, THREE.RGBAFormat);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  _atlas = { map: mk(alb, true), normalMap: mk(nrm, false) };
  return _atlas;
}

/* --------------------------------------------------------------- material */

const ATLAS_GLSL = /* glsl */ `
varying vec4 vMat;
varying vec3 vObj;
const vec2 GM_TEX = vec2(${AW}.0, ${AH}.0);
vec2 gmAtlas(vec2 uv, float tile) {
  float t = floor(tile + 0.5);
  float col = mod(t, ${COLS}.0);
  float row = floor(t / ${COLS}.0);
  return (vec2(col, row) * ${TS}.0 + ${PAD}.0 + fract(uv) * ${P}.0) / GM_TEX;
}
`;

export const NOISE_GLSL = /* glsl */ `
float gmHash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float gmNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = mix(gmHash(i), gmHash(i + vec3(1,0,0)), f.x);
  float b = mix(gmHash(i + vec3(0,1,0)), gmHash(i + vec3(1,1,0)), f.x);
  float c = mix(gmHash(i + vec3(0,0,1)), gmHash(i + vec3(1,0,1)), f.x);
  float d = mix(gmHash(i + vec3(0,1,1)), gmHash(i + vec3(1,1,1)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}
`;

/**
 * The environment map is the sky alone, so a face pointing at the ground
 * reflects bright horizon haze and a black-doped belly reads pale grey from
 * below. Real undersides see dark ground: fade image-based light on
 * downward-facing normals.
 */
export const ENV_OCCLUSION = /* glsl */ `
#include <lights_fragment_maps>
{
  vec3 gmWN = inverseTransformDirection(normal, viewMatrix);
  float gmOcc = mix(0.26, 1.0, smoothstep(-0.8, 0.3, gmWN.y));
  iblIrradiance *= gmOcc;
  radiance *= gmOcc;
}
`;

const MAP_FRAG = /* glsl */ `
vec2 gmUv = gmAtlas(vMapUv, vMat.x);
// Gradients widened a little: fine periodic detail (corrugations, weave)
// otherwise sits right at Nyquist at gameplay distances and crawls.
vec2 gmDx = dFdx(vMapUv) * (${P}.0 * 1.5 / GM_TEX);
vec2 gmDy = dFdy(vMapUv) * (${P}.0 * 1.5 / GM_TEX);
vec4 sampledDiffuseColor = textureGrad(map, gmUv, gmDx, gmDy);
diffuseColor *= sampledDiffuseColor;
`;

const NORMAL_FRAG = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = textureGrad(normalMap, gmUv, gmDx, gmDy).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize(tbn * mapN);
#endif
`;

const EMBER_FRAG = /* glsl */ `
{
  // Smouldering wreck: patches glow orange, flicker, and cool over a minute.
  float heat = smoothstep(0.0, 0.5, uEmberT) * (0.1 + 0.9 * exp(-uEmberT / 12.0));
  float n = gmNoise(vObj * 1.4 + uSeed) * 0.6 + gmNoise(vObj * 4.1 - uSeed) * 0.4;
  float flick = 0.7 + 0.3 * sin(uEmberT * 6.0 + n * 25.0);
  float e = smoothstep(0.64, 0.8, n) * vMat.w * heat * flick;
  totalEmissiveRadiance += vec3(1.0, 0.24, 0.035) * e * 3.4;
  diffuseColor.rgb *= 1.0 - 0.6 * e;
}
`;

export type UberVariant = 'opaque' | 'cutout' | 'wreck';

function patchUber(mat: THREE.MeshStandardMaterial, wreck: boolean): void {
  mat.onBeforeCompile = (sh) => {
    if (wreck) {
      sh.uniforms.uEmberT = mat.userData.uEmberT;
      sh.uniforms.uSeed = mat.userData.uSeed;
    }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nvarying vec4 vMat;\nvarying vec3 vObj;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMat = aMat;\nvObj = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + ATLAS_GLSL + (wreck ? 'uniform float uEmberT;\nuniform float uSeed;\n' + NOISE_GLSL : ''))
      .replace('#include <map_fragment>', MAP_FRAG)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vMat.y;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vMat.z;')
      .replace('#include <normal_fragment_maps>', NORMAL_FRAG)
      .replace('#include <lights_fragment_maps>', ENV_OCCLUSION);
    if (wreck) sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + EMBER_FRAG);
  };
  mat.customProgramCacheKey = () => (wreck ? 'gm-uber-wreck' : 'gm-uber');
}

function makeUber(variant: UberVariant): THREE.MeshStandardMaterial {
  const { map, normalMap } = groundAtlas();
  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    vertexColors: true,
    roughness: 1,
    metalness: 1,
  });
  mat.normalScale.set(1, 1);
  if (variant === 'cutout') {
    mat.alphaTest = 0.5;
    mat.side = THREE.DoubleSide;
  }
  if (variant === 'wreck') {
    mat.userData.uEmberT = { value: 0 };
    mat.userData.uSeed = { value: Math.random() * 100 };
  }
  patchUber(mat, variant === 'wreck');
  mat.name = `gm-${variant}`;
  return mat;
}

const _shared: Partial<Record<'opaque' | 'cutout', THREE.MeshStandardMaterial>> = {};

/** The shared ground material (one per variant; wrecks get their own instance). */
export function uberMaterial(variant: 'opaque' | 'cutout'): THREE.MeshStandardMaterial {
  return (_shared[variant] ??= makeUber(variant));
}

/** A fresh smoulder-capable material for one wreck (its own ember clock). */
export function wreckMaterial(): THREE.MeshStandardMaterial {
  return makeUber('wreck');
}

/* ------------------------------------------------------------ ground blobs */

let _ao: THREE.MeshBasicMaterial | null = null;
let _scorch: THREE.MeshBasicMaterial | null = null;

/** Soft contact shadow under every ground object (sits it into the terrain). */
export function aoBlobMaterial(): THREE.MeshBasicMaterial {
  if (_ao) return _ao;
  const c = canvas(128, 128);
  const x = c.getContext('2d')!;
  const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.62)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.42)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _ao = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, color: 0xffffff });
  _ao.name = 'gm-ao';
  return _ao;
}

/** Burnt ground under a wreck: black core, ash, ragged rim. */
export function scorchMaterial(): THREE.MeshBasicMaterial {
  if (_scorch) return _scorch;
  const S = 256;
  const c = canvas(S, S);
  const x = c.getContext('2d')!;
  const r = rng(99);
  const lobes: number[] = [];
  for (let k = 0; k < 20; k++) lobes.push(0.62 + r() * 0.34);
  const img = x.createImageData(S, S);
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const dx = (px - S / 2) / (S / 2), dy = (py - S / 2) / (S / 2);
      const d = Math.hypot(dx, dy);
      const ang = (Math.atan2(dy, dx) / (Math.PI * 2) + 1) % 1;
      const t = ang * 20, i0 = Math.floor(t) % 20, f = t - Math.floor(t);
      const edge = lobes[i0] * (1 - f) + lobes[(i0 + 1) % 20] * f;
      const k = 1 - Math.min(1, Math.max(0, (d - edge * 0.55) / (edge * 0.45)));
      const i = (py * S + px) * 4;
      const ash = r() < 0.1 ? 40 : 0;
      img.data[i] = 12 + ash; img.data[i + 1] = 10 + ash; img.data[i + 2] = 9 + ash;
      img.data[i + 3] = Math.round(255 * Math.min(0.92, k * k * (0.8 + r() * 0.25)));
    }
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  _scorch = new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false });
  _scorch.name = 'gm-scorch';
  return _scorch;
}
