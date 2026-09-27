import * as THREE from 'three';
import type { Geo, RegionRef } from './geo';

/**
 * The per-type skin atlas.
 *
 * Every painted surface of an aircraft — wing tops and bottoms, both fuselage
 * sides, tail, cowl, wheel covers — owns a rectangle of one 2048² texture, so
 * the whole livery is one material and one draw call. Geometry is built with
 * uvs in *metres* inside its region; once every part has asked for space the
 * atlas finds the largest uniform pixels-per-metre that fits them all, packs
 * the rectangles and rewrites the uvs. A uniform scale means a 1.2 m roundel is
 * the same number of pixels wherever it is painted, and the painter can draw
 * in metres with a canvas transform instead of juggling pixel maths.
 *
 * Left and right wing halves share a region (their markings are symmetric),
 * which roughly halves the area and doubles the resolution. Fuselage sides do
 * not: serials and squadron letters must read the right way round on both.
 */

export type RegionKind = 'wing' | 'tail' | 'fus' | 'cowl' | 'disc' | 'plain' | 'swatch';

export interface SkinRegion extends RegionRef {
  kind: RegionKind;
  /** Bounds of the metre uvs that geometry actually used. */
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  /** Packed pixel origin of (u0, v0). */
  px: number;
  py: number;
  /** Anything the painters need: rib stations, fuselage section functions… */
  meta: Record<string, unknown>;
}

export const ATLAS_PAD = 8;

export class SkinAtlas {
  readonly regions = new Map<string, SkinRegion>();
  /** Pixels per metre, uniform over the atlas. */
  scale = 100;
  readonly size: number;
  private readonly geos: Geo[] = [];

  constructor(size = 2048) {
    this.size = size;
  }

  region(name: string, kind: RegionKind, meta: Record<string, unknown> = {}): SkinRegion {
    let r = this.regions.get(name);
    if (!r) {
      r = { name, kind, u0: Infinity, v0: Infinity, u1: -Infinity, v1: -Infinity, px: 0, py: 0, meta };
      this.regions.set(name, r);
    } else {
      Object.assign(r.meta, meta);
    }
    return r;
  }

  get(name: string): SkinRegion {
    const r = this.regions.get(name);
    if (!r) throw new Error(`airframes: no atlas region ${name}`);
    return r;
  }

  /** Remember a geometry whose ranges point into this atlas; widen region bounds. */
  track(g: Geo): void {
    this.geos.push(g);
    for (const rg of g.ranges) {
      const r = rg.region as SkinRegion;
      for (let k = rg.start; k < rg.end; k++) {
        const u = g.t[k * 2], v = g.t[k * 2 + 1];
        if (u < r.u0) r.u0 = u;
        if (u > r.u1) r.u1 = u;
        if (v < r.v0) r.v0 = v;
        if (v > r.v1) r.v1 = v;
      }
    }
  }

  /**
   * Shelf-pack at the largest scale that fits. Binary search on the scale is
   * crude but the packer is instant for a few dozen rectangles.
   */
  pack(): void {
    const list = [...this.regions.values()].filter((r) => r.u1 >= r.u0);
    for (const r of list) {
      // A region used only at a single point (a flat swatch) still needs pixels.
      if (r.u1 - r.u0 < 0.05) r.u1 = r.u0 + 0.05;
      if (r.v1 - r.v0 < 0.05) r.v1 = r.v0 + 0.05;
    }
    list.sort((a, b) => b.v1 - b.v0 - (a.v1 - a.v0));
    const fits = (s: number, commit: boolean): boolean => {
      let x = ATLAS_PAD, y = ATLAS_PAD, shelf = 0;
      for (const r of list) {
        const w = Math.ceil((r.u1 - r.u0) * s), h = Math.ceil((r.v1 - r.v0) * s);
        if (w + 2 * ATLAS_PAD > this.size) return false;
        if (x + w + ATLAS_PAD > this.size) { x = ATLAS_PAD; y += shelf + 2 * ATLAS_PAD; shelf = 0; }
        if (y + h + ATLAS_PAD > this.size) return false;
        if (commit) { r.px = x; r.py = y; }
        x += w + 2 * ATLAS_PAD;
        shelf = Math.max(shelf, h);
      }
      return true;
    };
    let lo = 10, hi = 600;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (fits(mid, false)) lo = mid; else hi = mid;
    }
    this.scale = Math.floor(lo * 100) / 100;
    fits(this.scale, true);
    for (const g of this.geos) this.remap(g);
  }

  private remap(g: Geo): void {
    const S = this.size, s = this.scale;
    for (const rg of g.ranges) {
      const r = rg.region as SkinRegion;
      for (let k = rg.start; k < rg.end; k++) {
        const u = g.t[k * 2], v = g.t[k * 2 + 1];
        g.t[k * 2] = (r.px + (u - r.u0) * s) / S;
        // Canvas rows run down; texture v runs up (flipY).
        g.t[k * 2 + 1] = 1 - (r.py + (v - r.v0) * s) / S;
      }
    }
    g.ranges = [];
  }

  /**
   * Run `fn` with the canvas set up so that (u, v) in the region's own metre
   * coordinates lands on the right pixels. Drawing is clipped to the region
   * plus its padding, so paint may overrun an edge freely — the bleed is what
   * keeps mipmaps from pulling in the neighbour's colour.
   */
  paint(ctx: CanvasRenderingContext2D, r: SkinRegion, fn: (ctx: CanvasRenderingContext2D, r: SkinRegion) => void, bleed = ATLAS_PAD): void {
    const s = this.scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.px - bleed, r.py - bleed, (r.u1 - r.u0) * s + 2 * bleed, (r.v1 - r.v0) * s + 2 * bleed);
    ctx.clip();
    ctx.setTransform(s, 0, 0, s, r.px - r.u0 * s, r.py - r.v0 * s);
    fn(ctx, r);
    ctx.restore();
  }

  /**
   * Iterate pixels of a region with their metre coordinates, on a map whose
   * resolution is `res` times the atlas's (0.5 for a half-size map).
   */
  forPixels(r: SkinRegion, fn: (px: number, py: number, u: number, v: number) => void, bleed = ATLAS_PAD, res = 1): void {
    const s = this.scale * res, size = Math.round(this.size * res);
    const ox = r.px * res, oy = r.py * res, b = bleed * res;
    const x0 = Math.max(0, Math.floor(ox - b)), y0 = Math.max(0, Math.floor(oy - b));
    const x1 = Math.min(size, Math.ceil(ox + (r.u1 - r.u0) * s + b));
    const y1 = Math.min(size, Math.ceil(oy + (r.v1 - r.v0) * s + b));
    for (let y = y0; y < y1; y++) {
      const v = r.v0 + (y + 0.5 - oy) / s;
      for (let x = x0; x < x1; x++) fn(x, y, r.u0 + (x + 0.5 - ox) / s, v);
    }
  }
}

// ---------------------------------------------------------------- canvases

export function canvas(w: number, h = w): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false })!;
  return { c, ctx };
}

export function canvasTexture(c: HTMLCanvasElement, srgb: boolean, anisotropy = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = anisotropy;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Tangent-space normal map from a height field (Sobel). Heights are in metres
 * of relief; `pxPerM` converts the slope into the same units.
 */
export function heightToNormal(h: Float32Array, w: number, ht: number, pxPerM: number, strength = 1): HTMLCanvasElement {
  const { c, ctx } = canvas(w, ht);
  const img = ctx.createImageData(w, ht);
  const d = img.data;
  const k = pxPerM * strength;
  for (let y = 0; y < ht; y++) {
    const ym = y > 0 ? y - 1 : y, yp = y < ht - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x < w - 1 ? x + 1 : x;
      const dx = (h[y * w + xp] - h[y * w + xm]) * 0.5 * k;
      // Canvas y runs down but texture v runs up; the tangent frame follows v.
      const dy = (h[ym * w + x] - h[yp * w + x]) * 0.5 * k;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * w + x) * 4;
      d[o] = ((-dx / l) * 0.5 + 0.5) * 255;
      d[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      d[o + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------------------------------------------------------------- noise

/** Deterministic PRNG (mulberry32) so every build of a livery is identical. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(x: number, y: number, s = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise, roughly in [0,1]. */
export function vnoise(x: number, y: number, s = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

export function fbm(x: number, y: number, oct: number, s = 0): number {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += vnoise(x * f, y * f, s + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** A tileable greyscale noise canvas, for cheap grime overlays via drawImage. */
export function noiseCanvas(size: number, cell: number, oct: number, seed: number): HTMLCanvasElement {
  const { c, ctx } = canvas(size);
  const img = ctx.createImageData(size, size);
  const n = size / cell;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Tile by blending the four wrapped samples.
      const u = x / cell, v = y / cell;
      const fx = x / size, fy = y / size;
      const a = fbm(u, v, oct, seed), b = fbm(u - n, v, oct, seed), cc = fbm(u, v - n, oct, seed), d = fbm(u - n, v - n, oct, seed);
      const val = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + cc * (1 - fx) * fy + d * fx * fy;
      const o = (y * size + x) * 4;
      const g = Math.max(0, Math.min(255, (val - 0.5) * 2.2 * 128 + 128));
      img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
