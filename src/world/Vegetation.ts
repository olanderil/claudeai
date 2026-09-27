import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { forestPattern, forestStyle, shatterAt } from './Forest';
import { aerodromeClearing, behindLines, frontSalt, hash01 } from './Front';
import { roadSegments } from './Roads';
import { settlements } from './Settlements';
import { activeWorld, forestAt, terrainHeight, type TreePalette } from './Worlds';
import { SEA_LEVEL } from './Sea';

/**
 * Trees: real ones, streamed in tiles round the aircraft.
 *
 * A biplane spends its life a few hundred metres up, where painted woodland
 * reads as a green carpet and nothing else in the frame gives a sense of
 * height or speed. So within a few kilometres every wood is stood up in 3D —
 * on exactly the cover the terrain paints, because both ask `forestAt` — along
 * with poplar rows down the roads, orchards round the villages, scrub on the
 * dry worlds and, near the lines, the shattered trunks of what used to be
 * woods.
 *
 * Budget: a few InstancedMeshes, a few dozen triangles a tree, no alpha. Two
 * rings: everything within `NEAR` (with shadows), and a thinned third of it
 * out to `FAR`. The vertex shader shrinks trees to nothing at the edge of
 * their ring, so tiles arriving and leaving never pop.
 */

type Kind = 'broadleaf' | 'conifer' | 'poplar' | 'palm' | 'shrub' | 'dead';
const KINDS: Kind[] = ['broadleaf', 'conifer', 'poplar', 'palm', 'shrub', 'dead'];

const TILE = 200;
const NEAR = 1500;
const FAR = 3600;
/** Share of trees that survive into the far ring. */
const FAR_SHARE = 0.3;
/** Candidate spacing inside woods, metres. */
const WOOD_STEP = 9.5;
/** Spacing of the lattice the forest cover is evaluated on, metres. */
const COVER_STEP = 20;
/** Per-frame generation budget, milliseconds. */
const BUDGET_MS = 2.5;

const CAPACITY: Record<Kind, [number, number]> = {
  // [near-only, both rings]
  broadleaf: [60000, 30000],
  conifer: [40000, 20000],
  poplar: [12000, 8000],
  palm: [6000, 3000],
  shrub: [30000, 4000],
  dead: [20000, 10000],
};

/** A growable pair of typed arrays: instance matrices and colours. */
class InstanceList {
  m = new Float32Array(16 * 8);
  c = new Float32Array(3 * 8);
  n = 0;
  /**
   * Shuffle the instances, deterministically, so that drawing the first N of
   * them is an even thinning of the whole tile rather than its first rows.
   */
  shuffle(seed: number): void {
    const m = new Float32Array(16);
    const c = new Float32Array(3);
    for (let i = this.n - 1; i > 0; i--) {
      const j = Math.floor(hash01(i, seed, 977) * (i + 1));
      if (j === i) continue;
      m.set(this.m.subarray(i * 16, i * 16 + 16));
      this.m.copyWithin(i * 16, j * 16, j * 16 + 16);
      this.m.set(m, j * 16);
      c.set(this.c.subarray(i * 3, i * 3 + 3));
      this.c.copyWithin(i * 3, j * 3, j * 3 + 3);
      this.c.set(c, j * 3);
    }
  }

  add(e: ArrayLike<number>, r: number, g: number, b: number): void {
    if ((this.n + 1) * 16 > this.m.length) {
      const m = new Float32Array(this.m.length * 2);
      m.set(this.m);
      this.m = m;
      const c = new Float32Array(this.c.length * 2);
      c.set(this.c);
      this.c = c;
    }
    this.m.set(e as Float32Array, this.n * 16);
    this.c[this.n * 3] = r;
    this.c[this.n * 3 + 1] = g;
    this.c[this.n * 3 + 2] = b;
    this.n++;
  }
}

interface TileData {
  /** Per kind: matrices and colours, near-only and both-rings. */
  near: Record<Kind, InstanceList>;
  far: Record<Kind, InstanceList>;
}

function emptyLists(): Record<Kind, InstanceList> {
  const out = {} as Record<Kind, InstanceList>;
  for (const k of KINDS) out[k] = new InstanceList();
  return out;
}

// ------------------------------------------------------------------- geometry

function coloured(geo: THREE.BufferGeometry, fn: (y: number, x: number, z: number) => [number, number, number], leaf: number): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  flat.deleteAttribute('uv');
  const pos = flat.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const lf = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const c = fn(pos.getY(i), pos.getX(i), pos.getZ(i));
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
    lf[i] = leaf;
  }
  flat.setAttribute('color', new THREE.BufferAttribute(col, 3));
  flat.setAttribute('aLeaf', new THREE.BufferAttribute(lf, 1));
  flat.computeVertexNormals();
  return flat;
}

const BARK: [number, number, number] = [0.16, 0.13, 0.10];

function trunk(r0: number, r1: number, h: number, sides = 5): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, h, sides, 1, true);
  g.translate(0, h / 2, 0);
  return coloured(g, () => BARK, 0);
}

/** A lump of canopy: an icosahedron nudged out of round, shaded darker underneath. */
function lump(r: number, x: number, y: number, z: number, seed: number, squash = 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.82 + 0.36 * hash01(i, seed, 17);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * squash, p.getZ(i) * k);
  }
  g.translate(x, y, z);
  const lo = y - r;
  const hi = y + r;
  return coloured(g, (vy) => {
    const t = Math.max(0, Math.min(1, (vy - lo) / (hi - lo)));
    const v = 0.5 + 0.5 * t;
    return [v, v, v];
  }, 1);
}

function broadleafGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    trunk(0.28, 0.16, 3.6),
    lump(2.7, 0, 5.4, 0, 1),
    lump(2.0, 1.4, 4.5, 0.6, 2),
    lump(2.1, -1.2, 4.7, -0.8, 3),
    lump(1.7, 0.2, 6.9, -0.3, 4),
  ], false);
}

function coniferGeometry(): THREE.BufferGeometry {
  const tiers: THREE.BufferGeometry[] = [trunk(0.26, 0.12, 3.0)];
  const spec: [number, number, number][] = [[2.6, 5.0, 2.0], [2.0, 4.4, 4.6], [1.35, 4.0, 7.0], [0.75, 3.2, 9.4]];
  spec.forEach(([r, h, y], i) => {
    const g = new THREE.ConeGeometry(r, h, 7, 1, false);
    g.translate(0, y + h / 2, 0);
    const lo = y;
    const hi = y + h;
    tiers.push(coloured(g, (vy) => {
      const t = (vy - lo) / (hi - lo);
      const v = 0.45 + 0.4 * t + i * 0.04;
      return [v, v, v];
    }, 1));
  });
  return mergeGeometries(tiers, false);
}

/** Lombardy poplar: a tall narrow spindle, the tree of every French road. */
function poplarGeometry(): THREE.BufferGeometry {
  const pts: THREE.Vector2[] = [];
  const H = 17;
  for (let i = 0; i <= 8; i++) {
    const t = i / 8;
    const r = Math.sin(Math.pow(t, 0.8) * Math.PI) * 1.9 * (1 - t * 0.35) + 0.05;
    pts.push(new THREE.Vector2(r, 2.2 + t * H));
  }
  const g = new THREE.LatheGeometry(pts, 7);
  return mergeGeometries([
    trunk(0.25, 0.14, 3.0),
    coloured(g, (vy) => {
      const v = 0.5 + 0.5 * ((vy - 2.2) / H);
      return [v, v, v];
    }, 1),
  ], false);
}

function palmGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // A gently curved trunk in three pieces.
  let x = 0;
  let y = 0;
  for (let i = 0; i < 3; i++) {
    const g = new THREE.CylinderGeometry(0.2, 0.26, 3.2, 5, 1, true);
    g.rotateZ(-0.06 * (i + 1));
    g.translate(x + 0.1 * (i + 1), y + 1.6, 0);
    parts.push(coloured(g, () => [0.30, 0.24, 0.17], 0));
    x += 0.2 * (i + 1);
    y += 3.15;
  }
  // Fronds: thin drooping blades radiating from the crown.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.3;
    const g = new THREE.BoxGeometry(0.9, 0.08, 4.2);
    g.translate(0, 0, 2.0);
    g.rotateX(0.45 + 0.25 * hash01(k, 1, 9));
    g.rotateY(a);
    g.translate(x, y + 0.2, 0);
    parts.push(coloured(g, () => [0.85, 0.85, 0.85], 1));
  }
  return mergeGeometries(parts, false);
}

function shrubGeometry(): THREE.BufferGeometry {
  return mergeGeometries([
    lump(1.3, 0, 0.7, 0, 5, 0.7),
    lump(0.9, 1.0, 0.5, 0.4, 6, 0.7),
  ], false);
}

/** A shell-shattered trunk: splintered top, a stub of branch, no leaves. */
function deadGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(0.12, 0.3, 6, 6, 3, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > 2.9) p.setY(i, y - hash01(i, 3, 41) * 2.4);
  }
  g.translate(0, 3, 0);
  const stub = new THREE.BoxGeometry(0.14, 1.8, 0.14);
  stub.translate(0, 0.9, 0);
  stub.rotateZ(0.9);
  stub.translate(0.1, 3.2, 0);
  const grey: [number, number, number] = [0.13, 0.12, 0.105];
  return mergeGeometries([coloured(g, () => grey, 0), coloured(stub, () => grey, 0)], false);
}

const GEOMETRY: Record<Kind, () => THREE.BufferGeometry> = {
  broadleaf: broadleafGeometry,
  conifer: coniferGeometry,
  poplar: poplarGeometry,
  palm: palmGeometry,
  shrub: shrubGeometry,
  dead: deadGeometry,
};

// ------------------------------------------------------------------- material

interface TreeUniforms {
  uFocus: { value: THREE.Vector3 };
  uFade: { value: THREE.Vector2 };
  uFoliage: { value: THREE.Color };
  uTime: { value: number };
}

function treeMaterial(u: TreeUniforms, depth = false): THREE.Material {
  const mat = depth
    ? new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.5 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aLeaf;
        uniform vec3 uFocus;
        uniform vec2 uFade;
        uniform vec3 uFoliage;
        uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 origin = vec3(instanceMatrix[3]);
          float dist = distance(origin.xz, uFocus.xz);
          float grow = 1.0 - smoothstep(uFade.x, uFade.y, dist);
          // A breath of wind in the crowns, out of step from tree to tree.
          float sway = aLeaf * sin(uTime * 1.3 + origin.x * 0.07 + origin.z * 0.05) * 0.04 * transformed.y;
          transformed.x += sway;
          transformed *= grow;
        }`);
    if (!depth) {
      shader.vertexShader = shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
        vColor.rgb *= mix(vec3(1.0), uFoliage, aLeaf);`);
    }
  };
  mat.customProgramCacheKey = () => (depth ? 'tree-depth-v1' : 'tree-v1');
  return mat;
}

// --------------------------------------------------------------------- system

interface Ring {
  mesh: THREE.InstancedMesh;
  uniforms: TreeUniforms;
}

/** Leaf colours per kind, linear, before the season. */
const LEAF: Record<Kind, [number, number, number]> = {
  broadleaf: [0.085, 0.15, 0.05],
  conifer: [0.045, 0.085, 0.05],
  poplar: [0.10, 0.17, 0.055],
  palm: [0.12, 0.17, 0.06],
  shrub: [0.16, 0.17, 0.08],
  dead: [1, 1, 1],
};

export class Vegetation {
  readonly group = new THREE.Group();
  private readonly rings: Record<Kind, { near: Ring; far: Ring }>;
  private readonly tiles = new Map<string, TileData>();
  private readonly pending: { tx: number; tz: number; d: number }[] = [];
  private readonly wantedNear = new Set<string>();
  private readonly wantedFar = new Set<string>();
  private readonly lastFocus = new THREE.Vector3(Infinity, 0, Infinity);
  private dirty = false;
  private season = 1;
  private time = 0;
  private palette: TreePalette = { broadleaf: 1, conifer: 0, poplar: 1, palm: 0, shrub: 0 };
  /** Share of instances drawn, from the quality preset. */
  private density = 1;

  constructor() {
    this.rings = {} as Record<Kind, { near: Ring; far: Ring }>;
    for (const kind of KINDS) {
      const geo = GEOMETRY[kind]();
      const make = (count: number, fade: [number, number], shadows: boolean): Ring => {
        const uniforms: TreeUniforms = {
          uFocus: { value: new THREE.Vector3() },
          uFade: { value: new THREE.Vector2(fade[0], fade[1]) },
          uFoliage: { value: new THREE.Color(...LEAF[kind]) },
          uTime: { value: 0 },
        };
        const mesh = new THREE.InstancedMesh(geo, treeMaterial(uniforms), count);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
        mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = shadows;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = treeMaterial(uniforms, true);
        this.group.add(mesh);
        return { mesh, uniforms };
      };
      const shrub = kind === 'shrub';
      this.rings[kind] = {
        near: make(CAPACITY[kind][0], [NEAR - 350, NEAR], !shrub),
        far: make(CAPACITY[kind][1], [FAR - 700, FAR], !shrub),
      };
    }
    this.applySeason();
  }

  /** Forget every tile: the world or its seed changed. */
  regenerate(): void {
    this.tiles.clear();
    this.pending.length = 0;
    this.lastFocus.set(Infinity, 0, Infinity);
    const p = activeWorld().trees;
    this.palette = p ?? { broadleaf: 1, conifer: 0.1, poplar: 1, palm: 0, shrub: 0.1 };
    for (const kind of KINDS) {
      this.rings[kind].near.mesh.count = 0;
      this.rings[kind].far.mesh.count = 0;
    }
    this.applySeason();
  }

  /**
   * Thin the forest for slower machines: a fixed fraction of every tile's
   * instances is drawn (the tiles are shuffled once, so the fraction is an even
   * thinning, not a missing corner).
   */
  setDensity(d: number): void {
    const next = Math.max(0.1, Math.min(1, d));
    if (next === this.density) return;
    this.density = next;
    this.dirty = true;
  }

  /** 0 spring, 1 summer, 2 autumn, 3 winter. */
  setSeason(index: number): void {
    this.season = index;
    this.applySeason();
  }

  private applySeason(): void {
    const s = this.season;
    for (const kind of KINDS) {
      let [r, g, b] = LEAF[kind];
      if (kind === 'broadleaf' || kind === 'poplar') {
        if (s === 0) { r *= 1.15; g *= 1.25; b *= 1.1; }
        if (s === 2) { r = r * 2.6 + 0.02; g *= 0.95; b *= 0.5; }
        if (s === 3) { r = 0.11; g = 0.095; b = 0.08; }
      }
      if (kind === 'shrub' && s === 3) { r *= 0.9; g *= 0.8; }
      for (const ring of [this.rings[kind].near, this.rings[kind].far]) ring.uniforms.uFoliage.value.setRGB(r, g, b);
    }
  }

  /** Build every tile the opening view needs, synchronously. */
  prime(focus: THREE.Vector3): void {
    this.refresh(focus);
    this.build(Infinity);
    this.upload();
  }

  update(focus: THREE.Vector3, dt: number): void {
    this.time += dt;
    for (const kind of KINDS) {
      for (const ring of [this.rings[kind].near, this.rings[kind].far]) {
        ring.uniforms.uFocus.value.copy(focus);
        ring.uniforms.uTime.value = this.time;
      }
    }
    if (Math.hypot(focus.x - this.lastFocus.x, focus.z - this.lastFocus.z) > TILE) this.refresh(focus);
    // Building and uploading never share a frame: each is a few milliseconds
    // at worst, and together they would be a visible hitch.
    if (this.pending.length > 0) this.build(BUDGET_MS);
    else if (this.dirty) this.upload();
  }

  private refresh(focus: THREE.Vector3): void {
    this.lastFocus.copy(focus);
    this.wantedNear.clear();
    this.wantedFar.clear();
    this.pending.length = 0;
    const r = Math.ceil(FAR / TILE) + 1;
    const cx = Math.floor(focus.x / TILE);
    const cz = Math.floor(focus.z / TILE);
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const tx = cx + i;
        const tz = cz + j;
        // Nearest point of the tile to the focus.
        const nx = Math.max(tx * TILE, Math.min(focus.x, (tx + 1) * TILE));
        const nz = Math.max(tz * TILE, Math.min(focus.z, (tz + 1) * TILE));
        const d = Math.hypot(nx - focus.x, nz - focus.z);
        if (d > FAR) continue;
        const key = `${tx}:${tz}`;
        this.wantedFar.add(key);
        if (d < NEAR) this.wantedNear.add(key);
        if (!this.tiles.has(key)) this.pending.push({ tx, tz, d });
      }
    }
    this.pending.sort((a, b) => b.d - a.d);
    // Forget tiles well out of range.
    for (const key of this.tiles.keys()) {
      if (this.wantedFar.has(key)) continue;
      const [tx, tz] = key.split(':').map(Number);
      const d = Math.hypot((tx + 0.5) * TILE - focus.x, (tz + 0.5) * TILE - focus.z);
      if (d > FAR + 2 * TILE) this.tiles.delete(key);
    }
    this.dirty = true;
  }

  private build(budgetMs: number): void {
    const started = performance.now();
    while (this.pending.length > 0) {
      const t = this.pending.pop();
      if (!t) break;
      const key = `${t.tx}:${t.tz}`;
      if (this.tiles.has(key)) continue;
      this.tiles.set(key, generateTile(t.tx, t.tz, this.palette));
      this.dirty = true;
      if (performance.now() - started > budgetMs) break;
    }
  }

  /** Copy the wanted tiles into the instance buffers. */
  private upload(): void {
    this.dirty = false;
    for (const kind of KINDS) {
      const near = this.rings[kind].near.mesh;
      const far = this.rings[kind].far.mesh;
      let n = 0;
      let f = 0;
      const nm = near.instanceMatrix.array as Float32Array;
      const nc = near.instanceColor!.array as Float32Array;
      const fm = far.instanceMatrix.array as Float32Array;
      const fc = far.instanceColor!.array as Float32Array;
      for (const key of this.wantedFar) {
        const tile = this.tiles.get(key);
        if (!tile) continue;
        const a = tile.far[kind];
        const count = Math.ceil(a.n * this.density);
        if (count > 0 && f + count <= CAPACITY[kind][1]) {
          fm.set(a.m.subarray(0, count * 16), f * 16);
          fc.set(a.c.subarray(0, count * 3), f * 3);
          f += count;
        }
        if (!this.wantedNear.has(key)) continue;
        const b = tile.near[kind];
        const nb = Math.ceil(b.n * this.density);
        if (nb > 0 && n + nb <= CAPACITY[kind][0]) {
          nm.set(b.m.subarray(0, nb * 16), n * 16);
          nc.set(b.c.subarray(0, nb * 3), n * 3);
          n += nb;
        }
      }
      near.count = n;
      far.count = f;
      // Upload only what is in use, not the whole capacity.
      for (const [mesh, count] of [[near, n], [far, f]] as [THREE.InstancedMesh, number][]) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, Math.max(1, count) * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        mesh.instanceColor!.addUpdateRange(0, Math.max(1, count) * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    }
  }

  /** How many trees are standing, for diagnostics. */
  get count(): number {
    let n = 0;
    for (const kind of KINDS) n += this.rings[kind].near.mesh.count + this.rings[kind].far.mesh.count;
    return n;
  }
}

// ------------------------------------------------------------------ scatter

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function push(
  tile: TileData, kind: Kind, x: number, y: number, z: number,
  width: number, height: number, yaw: number, tint: [number, number, number], far: boolean,
): void {
  _p.set(x, y, z);
  _q.setFromAxisAngle(_up, yaw);
  _s.set(width, height, width);
  _m.compose(_p, _q, _s);
  const list = far ? tile.far[kind] : tile.near[kind];
  list.add(_m.elements, tint[0], tint[1], tint[2]);
}

function tint(x: number, z: number, salt: number, spread: number): [number, number, number] {
  const a = 1 - spread / 2 + hash01(Math.round(x * 3), Math.round(z * 3), salt) * spread;
  const w = (hash01(Math.round(x * 3), Math.round(z * 3), salt + 1) - 0.5) * spread * 0.6;
  return [a * (1 + w), a, a * (1 - w)];
}

/**
 * Everything that grows in one tile. Deterministic from the tile's position,
 * so a tile regenerated after it was dropped comes back tree for tree.
 */
function generateTile(tx: number, tz: number, palette: TreePalette): TileData {
  const tile: TileData = { near: emptyLists(), far: emptyLists() };
  const x0 = tx * TILE;
  const z0 = tz * TILE;
  const style = forestStyle();
  const high = style.treeLine;

  // ---------------------------------------------------------------- woods
  if (style.wooded > 0.001 && (palette.broadleaf + palette.conifer) > 0) {
    // Cheap rejection first: the stand pattern alone, on a coarse lattice.
    const threshold = 0.36 - style.wooded * 0.30;
    const n = Math.round(TILE / COVER_STEP) + 1;
    const cover = new Float32Array(n * n);
    let any = false;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + i * COVER_STEP;
        const z = z0 + j * COVER_STEP;
        if (forestPattern(x, z) < threshold - 0.02) continue;
        const c = forestAt(x, z);
        cover[j * n + i] = c;
        if (c > 0.02) any = true;
      }
    }
    if (any) {
      const coverAt = (x: number, z: number): number => {
        const fx = (x - x0) / COVER_STEP;
        const fz = (z - z0) / COVER_STEP;
        const i = Math.min(n - 2, Math.floor(fx));
        const j = Math.min(n - 2, Math.floor(fz));
        const u = fx - i;
        const v = fz - j;
        return (cover[j * n + i] * (1 - u) + cover[j * n + i + 1] * u) * (1 - v)
          + (cover[(j + 1) * n + i] * (1 - u) + cover[(j + 1) * n + i + 1] * u) * v;
      };
      const steps = Math.floor(TILE / WOOD_STEP);
      for (let j = 0; j < steps; j++) {
        for (let i = 0; i < steps; i++) {
          const gi = tx * steps + i;
          const gj = tz * steps + j;
          const x = x0 + (i + 0.15 + 0.7 * hash01(gi, gj, 11)) * WOOD_STEP;
          const z = z0 + (j + 0.15 + 0.7 * hash01(gi, gj, 12)) * WOOD_STEP;
          const c = coverAt(x, z);
          if (c < 0.05 || hash01(gi, gj, 13) > c * 0.95) continue;
          const y = terrainHeight(x, z);
          if (y < SEA_LEVEL + 1) continue;
          const u = behindLines(x, z);
          const shatter = shatterAt(u);
          const far = hash01(gi, gj, 14) < FAR_SHARE;
          const yaw = hash01(gi, gj, 15) * Math.PI * 2;
          if (shatter > 0.02 && hash01(gi, gj, 16) < shatter) {
            // What is left of the wood: a thinner stand of splintered trunks,
            // and in no-man's-land barely that.
            if (hash01(gi, gj, 17) > (u < 0 ? 0.25 : 0.55)) continue;
            const hgt = 0.35 + hash01(gi, gj, 18) * 0.9;
            push(tile, 'dead', x, y - 0.2, z, 0.8 + hash01(gi, gj, 19) * 0.6, hgt, yaw, tint(x, z, 3, 0.3), far);
            continue;
          }
          // Conifers take over with altitude and where the palette wants them.
          const alt = Math.max(0, Math.min(1, (y - (high - 700)) / 600));
          const coniferShare = Math.min(1, palette.conifer / Math.max(0.01, palette.broadleaf + palette.conifer) + alt);
          const kind: Kind = hash01(gi, gj, 20) < coniferShare ? 'conifer' : 'broadleaf';
          const size = 0.85 + hash01(gi, gj, 21) * 0.75;
          const w = size * (0.85 + hash01(gi, gj, 22) * 0.35);
          push(tile, kind, x, y - 0.3, z, w, size, yaw, tint(x, z, 5, 0.34), far);
        }
      }
    }
  }

  // ------------------------------------------------------------- hedgerows
  hedgerows(tile, x0, z0);

  // ---------------------------------------------------------- road poplars
  if (palette.poplar > 0) {
    for (const s of roadSegments()) {
      if (!s.lined) continue;
      // Only the part of the segment inside this tile.
      const minX = Math.min(s.ax, s.bx) - 12;
      const maxX = Math.max(s.ax, s.bx) + 12;
      const minZ = Math.min(s.az, s.bz) - 12;
      const maxZ = Math.max(s.az, s.bz) + 12;
      if (maxX < x0 || minX > x0 + TILE || maxZ < z0 || minZ > z0 + TILE) continue;
      const spacing = 13;
      const nx = -s.dz;
      const nz = s.dx;
      const start = Math.floor(0 / spacing);
      for (let k = start; k * spacing < s.len; k++) {
        const t = k * spacing + 6;
        if (t > s.len - 4) break;
        for (const side of [-1, 1]) {
          const off = s.half + 4.5;
          const x = s.ax + s.dx * t + nx * off * side;
          const z = s.az + s.dz * t + nz * off * side;
          if (x < x0 || x >= x0 + TILE || z < z0 || z >= z0 + TILE) continue;
          const id = Math.round(x * 0.37) * 7 + Math.round(z * 0.41);
          if (hash01(id, s.road, 31) < 0.12) continue; // gaps where one has come down
          const y = terrainHeight(x, z);
          if (y < SEA_LEVEL + 1) continue;
          const u = behindLines(x, z);
          const shatter = shatterAt(u - 250);
          const far = hash01(id, s.road, 32) < 0.5;
          if (shatter > 0.02 && hash01(id, s.road, 33) < shatter) {
            if (u < 0 || hash01(id, s.road, 34) > 0.6) continue;
            push(tile, 'dead', x, y - 0.2, z, 0.9, 0.7 + hash01(id, s.road, 35) * 0.9, hash01(id, 1, 36) * 6.28,
              tint(x, z, 7, 0.25), far);
            continue;
          }
          const size = 0.78 + hash01(id, s.road, 37) * 0.5;
          const kind: Kind = palette.poplar >= palette.broadleaf * 0.5 || hash01(id, 2, 38) < 0.5 ? 'poplar' : 'broadleaf';
          push(tile, kind, x, y - 0.3, z, size * (kind === 'poplar' ? 1 : 1.1), size, hash01(id, 3, 39) * 6.28,
            tint(x, z, 9, 0.2), far);
        }
      }
    }
  }

  // ---------------------------------------------- orchards, palms, village trees
  for (const v of settlements()) {
    if (Math.abs(v.x - (x0 + TILE / 2)) > TILE / 2 + 260 || Math.abs(v.z - (z0 + TILE / 2)) > TILE / 2 + 260) continue;
    const u = behindLines(v.x, v.z);
    const shatter = shatterAt(u - 350);
    const palms = palette.palm > 0;
    const step = palms ? 11 : 15;
    for (let j = Math.floor((z0 - v.z) / step); (v.z + j * step) < z0 + TILE; j++) {
      for (let i = Math.floor((x0 - v.x) / step); (v.x + i * step) < x0 + TILE; i++) {
        const gx = Math.round(v.x / step) + i;
        const gz = Math.round(v.z / step) + j;
        const x = v.x + (i + hash01(gx, gz, 51)) * step;
        const z = v.z + (j + hash01(gx, gz, 52)) * step;
        if (x < x0 || x >= x0 + TILE || z < z0 || z >= z0 + TILE) continue;
        const r = Math.hypot(x - v.x, z - v.z);
        if (r < 25 || r > (palms ? 240 : 210)) continue;
        const chance = (palms ? 0.55 : 0.2) * (1 - r / 260);
        if (hash01(gx, gz, 53) > chance) continue;
        // Keep out of the houses.
        if (v.houses.some((h) => Math.abs(h.x - x) < h.width * 0.8 + 3 && Math.abs(h.z - z) < h.depth * 0.8 + 3)) continue;
        const y = terrainHeight(x, z);
        const far = hash01(gx, gz, 54) < 0.4;
        if (shatter > 0.05 && hash01(gx, gz, 55) < shatter) {
          if (hash01(gx, gz, 56) < 0.5) {
            push(tile, 'dead', x, y - 0.2, z, 0.8, 0.4 + hash01(gx, gz, 57) * 0.6, hash01(gx, gz, 58) * 6.28, tint(x, z, 11, 0.3), far);
          }
          continue;
        }
        const size = 0.7 + hash01(gx, gz, 59) * 0.5;
        push(tile, palms ? 'palm' : 'broadleaf', x, y - 0.2, z, size * (palms ? 1 : 0.9), size, hash01(gx, gz, 60) * 6.28,
          tint(x, z, 13, 0.3), far);
      }
    }
  }

  // -------------------------------------------------------------- scrub
  if (palette.shrub > 0) {
    const step = 16;
    const steps = TILE / step;
    for (let j = 0; j < steps; j++) {
      for (let i = 0; i < steps; i++) {
        const gi = tx * steps + i;
        const gj = tz * steps + j;
        const x = x0 + (i + hash01(gi, gj, 71)) * step;
        const z = z0 + (j + hash01(gi, gj, 72)) * step;
        // Scrub grows in drifts, not as an even sprinkle.
        const drift = 0.5 + 0.5 * Math.sin(x * 0.013 + Math.sin(z * 0.009) * 2.0) * Math.cos(z * 0.011);
        if (hash01(gi, gj, 73) > palette.shrub * 0.32 * drift) continue;
        const y = terrainHeight(x, z);
        if (y < SEA_LEVEL + 2) continue;
        if (y > high + 200) continue;
        const u = behindLines(x, z);
        if (u < 150) continue;
        const size = 0.7 + hash01(gi, gj, 74) * 1.0;
        push(tile, 'shrub', x, y - 0.3, z, size, size * 0.9, hash01(gi, gj, 75) * 6.28, tint(x, z, 15, 0.4),
          hash01(gi, gj, 76) < 0.08);
      }
    }
  }

  for (const kind of KINDS) {
    tile.near[kind].shuffle(tx * 7919 + tz);
    tile.far[kind].shuffle(tx * 104729 + tz);
  }
  return tile;
}

// ------------------------------------------------------------------ hedgerows

/**
 * Trees along the field boundaries the terrain paints.
 *
 * The CPU twin of the shader's patchwork: the same warped districts, the same
 * rotation and field size per district, the same integer hash for which fields
 * are farmed. A hedge is laid along a boundary only between two farmed fields,
 * and only on the share of boundaries the world asks for; it grows as a line
 * of broadleaf trees with gaps, and near the lines it is a row of stumps.
 */
function hedgerows(tile: TileData, x0: number, z0: number): void {
  const world = activeWorld();
  const farm = world.farmland ?? 0.8;
  const share = world.hedges ?? 0;
  if (farm <= 0 || share <= 0) return;
  const fs = frontSalt();
  const district = (x: number, z: number): [number, number] => {
    const dx = x + Math.sin(z * 0.0011 + 0.4) * 520;
    const dz = z + Math.sin(x * 0.0013 + 1.9) * 520;
    return [Math.floor(dx / 2600), Math.floor(dz / 2600)];
  };
  // Districts touching this tile.
  const seen = new Set<string>();
  const regions: [number, number][] = [];
  for (let i = 0; i <= 4; i++) {
    for (let j = 0; j <= 4; j++) {
      const r = district(x0 + (i / 4) * TILE, z0 + (j / 4) * TILE);
      const k = `${r[0]}:${r[1]}`;
      if (!seen.has(k)) { seen.add(k); regions.push(r); }
    }
  }
  const kept = (cx: number, cz: number, rx: number, rz: number): boolean =>
    hash01(cx + rx * 977, cz + rz * 977, 906 + fs) < farm * 1.15;
  for (const [rx, rz] of regions) {
    const ang = hash01(rx, rz, 901 + fs) * 3.14159;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const scale = 0.75 + 0.6 * hash01(rx, rz, 902 + fs);
    const size = [150 * scale, 230 * scale];
    // The tile's extent in the district's rotated frame, with room for the warp.
    let lo0 = Infinity; let hi0 = -Infinity; let lo1 = Infinity; let hi1 = -Infinity;
    for (const [cx, cz] of [[x0, z0], [x0 + TILE, z0], [x0, z0 + TILE], [x0 + TILE, z0 + TILE]]) {
      const a = ca * cx + sa * cz;
      const b = -sa * cx + ca * cz;
      lo0 = Math.min(lo0, a); hi0 = Math.max(hi0, a); lo1 = Math.min(lo1, b); hi1 = Math.max(hi1, b);
    }
    lo0 -= 30; hi0 += 30; lo1 -= 30; hi1 += 30;
    for (const axis of [0, 1]) {
      const across = size[axis];
      const along = size[1 - axis];
      const aLo = axis === 0 ? lo0 : lo1;
      const aHi = axis === 0 ? hi0 : hi1;
      const bLo = axis === 0 ? lo1 : lo0;
      const bHi = axis === 0 ? hi1 : hi0;
      for (let k = Math.ceil(aLo / across); k * across <= aHi; k++) {
        for (let seg = Math.floor(bLo / along); seg * along <= bHi; seg++) {
          // The two fields either side of this stretch of boundary.
          const c0: [number, number] = axis === 0 ? [k - 1, seg] : [seg, k - 1];
          const c1: [number, number] = axis === 0 ? [k, seg] : [seg, k];
          if (!kept(c0[0], c0[1], rx, rz) || !kept(c1[0], c1[1], rx, rz)) continue;
          const hk = hash01(c0[0] * 31 + c1[0] + axis * 7 + rx * 977, c0[1] * 17 + c1[1] + rz * 977, 931 + fs);
          if (hk > share) continue;
          const spacing = 9 + hash01(k, seg, 932 + axis) * 6;
          for (let t = seg * along + 4; t < (seg + 1) * along - 4; t += spacing) {
            const id = Math.round(t * 7.3) + k * 1013 + axis * 7919;
            if (hash01(id, rx * 31 + rz, 933) > 0.72) continue;
            // In the warped frame the boundary is a straight line; undo the
            // warp by fixed-point iteration, then the rotation.
            const w0 = axis === 0 ? k * across : t;
            const w1 = axis === 0 ? t : k * across;
            let l0 = w0;
            let l1 = w1;
            for (let it = 0; it < 3; it++) {
              const n0 = w0 - Math.sin(l1 * 0.0041) * 22;
              const n1 = w1 - Math.sin(l0 * 0.0033) * 22;
              l0 = n0;
              l1 = n1;
            }
            const jitter = (hash01(id, 5, 934) - 0.5) * 3;
            const x = ca * l0 - sa * l1 + (axis === 0 ? ca : -sa) * jitter;
            const z = sa * l0 + ca * l1 + (axis === 0 ? sa : ca) * jitter;
            if (x < x0 || x >= x0 + TILE || z < z0 || z >= z0 + TILE) continue;
            const r = district(x, z);
            if (r[0] !== rx || r[1] !== rz) continue;
            if (aerodromeClearing(x, z) > 0.05) continue;
            const y = terrainHeight(x, z);
            if (y < SEA_LEVEL + 1.5) continue;
            const e = 8;
            const slope = Math.max(Math.abs(terrainHeight(x + e, z) - y), Math.abs(terrainHeight(x, z + e) - y)) / e;
            if (slope > 0.16) continue;
            const u = behindLines(x, z);
            if (u < 60) continue;
            const shatter = shatterAt(u - 150);
            const far = hash01(id, 6, 935) < 0.35;
            if (shatter > 0.02 && hash01(id, 7, 936) < shatter) {
              if (hash01(id, 8, 937) < 0.5) {
                push(tile, 'dead', x, y - 0.2, z, 0.75, 0.35 + hash01(id, 9, 938) * 0.6, hash01(id, 10, 939) * 6.28, tint(x, z, 17, 0.3), far);
              }
              continue;
            }
            const size2 = 0.62 + hash01(id, 11, 940) * 0.7;
            push(tile, 'broadleaf', x, y - 0.3, z, size2 * (0.9 + hash01(id, 12, 941) * 0.3), size2, hash01(id, 13, 942) * 6.28,
              tint(x, z, 19, 0.36), far);
          }
        }
      }
    }
  }
}
