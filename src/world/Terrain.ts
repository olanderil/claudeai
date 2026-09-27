import * as THREE from 'three';
import { applyHaze } from './Haze';
import { terrainHeight, riverStrength, clearingAt } from './Worlds';
import { farmland, farmlandPlot, farmlandHome } from './Settlements';
import { forestCover } from './Forest';
import { FRONT_CONSTS, FRONT_GLSL, fieldLocal, frontUniforms } from './Front';
import { roadHalfWidth, roadSignedDistance, roadValidity, waterSignedDistance } from './Roads';
import type { TerrainStyle } from './Worlds';

export {
  terrainHeight,
  setTerrainSeed,
  getTerrainSeed,
  fieldElevation,
  setWorld,
  activeWorld,
  WORLD_PRESETS,
  groundHeight,
  spawnPoint,
} from './Worlds';
export type { TerrainStyle, WorldPreset } from './Worlds';

// Declared in its own leaf module so that things `Worlds` imports can read it
// without closing an import cycle back through here. Re-exported so every
// existing caller is unaffected.
export { SEA_LEVEL } from './Sea';

// --------------------------------------------------------------------- quadtree

interface QuadNode {
  x: number;
  z: number;
  size: number;
  depth: number;
}

/** Half-width of the world, metres. Beyond this there is no terrain. */
const ROOT_SIZE = 262144;
const MAX_DEPTH = 10;
const CHUNK_SEGMENTS = 24;
/** Subdivide while the camera is within this many chunk-widths of the chunk. */
const LOD_FACTOR = 2.0;
/**
 * Re-evaluate the tree once the focus has moved this far, metres. Smaller means
 * more frequent but individually cheaper rebuilds, which spreads the work more
 * evenly instead of concentrating it into occasional larger hitches.
 */
const REFRESH_DISTANCE = 64;
/**
 * Build budgets, in milliseconds. Kept well inside a 60 Hz frame: leftovers are
 * finished on later frames, and `settle` holds the superseded chunks on screen
 * in the meantime, so spilling over costs a little overdraw rather than a hole.
 */
const REFRESH_BUILD_MS = 5;
const PER_FRAME_BUILD_MS = 3.5;
const MAX_CACHED_CHUNKS = 420;

/**
 * Quadtree level-of-detail terrain.
 *
 * Chunks are cached by node key and built against a per-frame time budget, so
 * flying never stalls the frame: only chunks that newly come into view are
 * generated, a few at a time. Vertex normals are evaluated analytically from the
 * height field rather than from the mesh, which keeps shading continuous across
 * chunk and LOD boundaries instead of showing a seam at every join.
 */
export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;

  /**
   * Shared with the compiled shader, so changing season is a uniform update
   * rather than a material rebuild (which would drop every cached chunk).
   */
  private readonly styleUniforms = {
    uGrass: { value: new THREE.Vector3(0.16, 0.28, 0.10) },
    uDry: { value: new THREE.Vector3(0.44, 0.39, 0.21) },
    uRock: { value: new THREE.Vector3(0.37, 0.35, 0.33) },
    uSnowLine: { value: 1380 },
    uTreeLine: { value: 710 },
    uStrata: { value: 0 },
    /** Height below which the ground is beach sand; far below the sea where there is none. */
    uBeach: { value: 16 },
    /** Canopy colour for the season: green in summer, rust in autumn, bare twigs in winter. */
    uTimber: { value: new THREE.Vector3(0.05, 0.09, 0.05) },
    /** How much of the open country is laid out in fields, 0..1. */
    uFarm: { value: 0.8 },
    /** Bare limestone breaking through thin soil, 0..1 (karst, scrub coasts). */
    uStony: { value: 0 },
  };

  private readonly cache = new Map<string, THREE.Mesh>();
  /** Node geometry for each cached chunk, for the coverage test in `settle`. */
  private readonly nodes = new Map<string, QuadNode>();
  private readonly wanted = new Set<string>();
  private pending: QuadNode[] = [];
  private readonly lastFocus = new THREE.Vector3(Infinity, 0, Infinity);

  private castShadows = false;

  constructor() {
    this.material = createTerrainMaterial(this.styleUniforms);
    this.group.matrixAutoUpdate = false;
  }

  /**
   * Whether ridges shadow the ground. Costs a second pass over every visible
   * chunk, so it is a quality setting rather than always-on.
   */
  setCastShadows(on: boolean): void {
    if (this.castShadows === on) return;
    this.castShadows = on;
    for (const mesh of this.cache.values()) mesh.castShadow = on;
  }

  setStyle(
    style: TerrainStyle,
    extra: { beach: number; timber: [number, number, number]; farm: number; stony: number },
  ): void {
    this.styleUniforms.uGrass.value.set(...style.grass);
    this.styleUniforms.uDry.value.set(...style.dry);
    this.styleUniforms.uRock.value.set(...style.rock);
    this.styleUniforms.uSnowLine.value = style.snowLine;
    this.styleUniforms.uTreeLine.value = style.treeLine;
    this.styleUniforms.uStrata.value = style.strata;
    this.styleUniforms.uBeach.value = extra.beach;
    this.styleUniforms.uTimber.value.set(...extra.timber);
    this.styleUniforms.uFarm.value = extra.farm;
    this.styleUniforms.uStony.value = extra.stony;
  }

  /**
   * Drop every chunk so the next update rebuilds against a changed height
   * field. Callers are expected to re-prime before the next frame.
   */
  regenerate(): void {
    for (const mesh of this.cache.values()) {
      mesh.geometry.dispose();
      this.group.remove(mesh);
    }
    this.cache.clear();
    this.nodes.clear();
    this.wanted.clear();
    this.pending.length = 0;
    this.lastFocus.set(Infinity, 0, Infinity);
  }

  /**
   * Refresh the visible set for a viewer position and build queued chunks.
   * `budgetMs` of Infinity builds everything synchronously — used once at boot
   * so the first frame is already complete.
   */
  update(focus: THREE.Vector3, budgetMs = PER_FRAME_BUILD_MS): void {
    if (this.lastFocus.distanceTo(focus) > REFRESH_DISTANCE) {
      this.lastFocus.copy(focus);
      this.refresh(focus, Math.max(budgetMs, REFRESH_BUILD_MS));
    } else if (this.pending.length > 0) {
      this.build(budgetMs);
      this.settle();
    }
  }

  private refresh(focus: THREE.Vector3, budgetMs: number): void {
    this.wanted.clear();
    this.pending.length = 0;

    const leaves: QuadNode[] = [];
    collectLeaves({ x: 0, z: 0, size: ROOT_SIZE, depth: 0 }, focus, leaves);

    for (const node of leaves) {
      const key = keyOf(node);
      this.wanted.add(key);
      if (!this.cache.has(key)) this.pending.push(node);
    }

    // Sorted farthest-first because the build loop pops from the end, so the
    // nearest chunks — the ones the player would notice missing — go first.
    this.pending.sort(
      (a, b) => distanceToNode(b, focus) - distanceToNode(a, focus),
    );

    // Build the entire new view here rather than dribbling it out across
    // frames. A chunk that is being replaced must not be hidden before its
    // replacements exist: the gap shows through as a bright flash of sky, which
    // is far more objectionable than the sub-millisecond cost of building now.
    this.build(budgetMs);
    this.settle();
  }

  /**
   * Decide what is on screen this frame.
   *
   * Wanted chunks that exist are shown. A superseded chunk is retained only
   * where it is still the sole cover for an area whose replacements haven't
   * been built yet — hiding it earlier is what punched holes in the terrain and
   * showed as bright flashes of sky. Retained chunks are sunk slightly so the
   * finer geometry replacing them always wins the depth test rather than
   * z-fighting against it during the handover.
   */
  private settle(): void {
    for (const [key, mesh] of this.cache) {
      const node = this.nodes.get(key);
      let offsetY = 0;
      let visible: boolean;

      if (this.wanted.has(key)) {
        visible = true;
      } else if (node) {
        visible = this.pending.some((missing) => overlaps(missing, node));
        // Just enough to lose the depth test to the finer chunks, and capped:
        // scaling this with chunk size would drop a large understudy tens of
        // metres, which reads as a dip in whatever part isn't covered yet.
        if (visible) offsetY = -Math.min((node.size / CHUNK_SEGMENTS) * 0.5, 5);
      } else {
        visible = false;
      }

      mesh.visible = visible;
      if (mesh.position.y !== offsetY) {
        mesh.position.y = offsetY;
        mesh.updateMatrix();
      }
    }
    if (this.pending.length === 0) this.evict();
  }

  private build(budgetMs: number): void {
    if (this.pending.length === 0) return;
    const started = performance.now();

    while (this.pending.length > 0) {
      const node = this.pending.pop();
      if (!node) break;
      const key = keyOf(node);
      if (!this.wanted.has(key)) continue; // moved on before we got to it

      const mesh = new THREE.Mesh(buildChunkGeometry(node), this.material);
      mesh.position.set(node.x, 0, node.z);
      mesh.receiveShadow = true;
      mesh.castShadow = this.castShadows;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();

      this.cache.set(key, mesh);
      this.nodes.set(key, node);
      this.group.add(mesh);

      if (performance.now() - started > budgetMs) break;
    }
  }

  /** Drop the least useful cached chunks once the cache grows too large. */
  private evict(): void {
    if (this.cache.size <= MAX_CACHED_CHUNKS) return;
    for (const [key, mesh] of this.cache) {
      if (this.cache.size <= MAX_CACHED_CHUNKS) break;
      if (this.wanted.has(key)) continue;
      mesh.geometry.dispose();
      this.group.remove(mesh);
      this.cache.delete(key);
      this.nodes.delete(key);
    }
  }

  dispose(): void {
    for (const mesh of this.cache.values()) mesh.geometry.dispose();
    this.cache.clear();
    this.material.dispose();
  }
}

function keyOf(n: QuadNode): string {
  return `${n.depth}:${n.x}:${n.z}`;
}

/** Horizontal distance from a point to a node's centre. */
function distanceToNode(n: QuadNode, focus: THREE.Vector3): number {
  return Math.hypot(n.x - focus.x, n.z - focus.z);
}

/** Whether two quadtree squares cover any common ground. Touching edges don't. */
function overlaps(a: QuadNode, b: QuadNode): boolean {
  const reach = (a.size + b.size) / 2 - 1e-3;
  return Math.abs(a.x - b.x) < reach && Math.abs(a.z - b.z) < reach;
}

function collectLeaves(node: QuadNode, focus: THREE.Vector3, out: QuadNode[]): void {
  const shouldSplit =
    node.depth < MAX_DEPTH && distanceToNode(node, focus) < node.size * LOD_FACTOR;

  if (!shouldSplit) {
    out.push(node);
    return;
  }

  const half = node.size / 2;
  const quarter = half / 2;
  for (const [sx, sz] of QUADRANTS) {
    collectLeaves(
      { x: node.x + sx * quarter, z: node.z + sz * quarter, size: half, depth: node.depth + 1 },
      focus,
      out,
    );
  }
}

const QUADRANTS: [number, number][] = [
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

/**
 * A chunk's mesh: a displaced grid plus a downward skirt around the border.
 *
 * The skirt is what hides LOD cracks — where a fine chunk meets a coarse one the
 * surfaces don't line up exactly, and without a skirt you see slivers of sky
 * through the seam.
 */
function buildChunkGeometry(node: QuadNode): THREE.BufferGeometry {
  const N = CHUNK_SEGMENTS;
  const cols = N + 1;
  const step = node.size / N;
  const half = node.size / 2;

  const gridCount = cols * cols;
  const skirtCount = cols * 4;
  const total = gridCount + skirtCount;

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  /**
   * Farmland: how cultivated a vertex is, and where it sits in its village's
   * own grid — (field strength, plot u, plot v, ordinary-village strength).
   */
  const settled = new Float32Array(total * 4);
  /** River strength per vertex, so water is part of the surface at every LOD. */
  const river = new Float32Array(total);
  /**
   * Forest cover per vertex. The same CPU function the tree scatter asks, so
   * the painted canopy and the 3D trees are one wood.
   */
  const forest = new Float32Array(total);
  /** Signed distance to the nearest road, how far to trust it, and its half-width. */
  const road = new Float32Array(total * 3);
  /** Aerodrome frame: along, right, half-length, half-width (zero clear of any field). */
  const field = new Float32Array(total * 4);
  /** Signed distance to the nearest canal and how far to trust it. */
  const canal = new Float32Array(total * 2);

  // Sample the height field once into a grid with a one-vertex border, so the
  // central-difference normals use real neighbours at the chunk edges.
  const pad = cols + 2;
  const heights = new Float32Array(pad * pad);
  const wet = new Float32Array(pad * pad);
  for (let j = -1; j <= N + 1; j++) {
    for (let i = -1; i <= N + 1; i++) {
      const k = (j + 1) * pad + (i + 1);
      heights[k] = terrainHeight(node.x - half + i * step, node.z - half + j * step);
      // Read straight after the height: a stash on the last call, not a
      // second evaluation of the field.
      wet[k] = riverStrength();
    }
  }
  const heightAt = (i: number, j: number): number => heights[(j + 1) * pad + (i + 1)];

  let minH = Infinity;
  let maxH = -Infinity;

  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      const wx = node.x - half + i * step;
      const wz = node.z - half + j * step;

      const y = heightAt(i, j);
      if (y < minH) minH = y;
      if (y > maxH) maxH = y;

      positions[idx * 3] = -half + i * step;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = -half + j * step;
      settled[idx * 4] = farmland(wx, wz);
      const plot = farmlandPlot();
      settled[idx * 4 + 1] = plot[0];
      settled[idx * 4 + 2] = plot[1];
      settled[idx * 4 + 3] = farmlandHome();
      const wetHere = wet[(j + 1) * pad + (i + 1)];
      river[idx] = wetHere;

      const nx = heightAt(i - 1, j) - heightAt(i + 1, j);
      const ny = 2 * step;
      const nz = heightAt(i, j - 1) - heightAt(i, j + 1);
      const inv = 1 / Math.hypot(nx, ny, nz);
      normals[idx * 3] = nx * inv;
      normals[idx * 3 + 1] = ny * inv;
      normals[idx * 3 + 2] = nz * inv;

      const rd = roadSignedDistance(wx, wz);
      const rv = roadValidity();
      road[idx * 3] = rd;
      road[idx * 3 + 1] = rv;
      road[idx * 3 + 2] = roadHalfWidth();

      canal[idx * 2] = waterSignedDistance(wx, wz);
      canal[idx * 2 + 1] = roadValidity();

      const f = fieldLocal(wx, wz);
      if (f !== null) field.set(f, idx * 4);

      const cleared = Math.max(
        clearingAt(wx, wz, Math.max(settled[idx * 4], settled[idx * 4 + 3]), wetHere),
        rv > 0 ? 1 - Math.min(1, Math.max(0, (Math.abs(rd) - 6) / 10)) : 0,
      );
      forest[idx] = forestCover(wx, wz, y, 1 - ny * inv, cleared);
    }
  }

  const indices: number[] = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * cols + i;
      const b = (j + 1) * cols + i;
      const c = (j + 1) * cols + (i + 1);
      const d = j * cols + (i + 1);
      indices.push(a, b, d, b, c, d);
    }
  }

  // Skirt: duplicate each border vertex, dropped straight down, and bridge the two.
  const skirtDepth = step * 3 + 12;
  let next = gridCount;

  const addSkirt = (border: number[], flip: boolean): void => {
    const base = next;
    for (const src of border) {
      positions[next * 3] = positions[src * 3];
      positions[next * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
      positions[next * 3 + 2] = positions[src * 3 + 2];
      normals[next * 3] = normals[src * 3];
      normals[next * 3 + 1] = normals[src * 3 + 1];
      normals[next * 3 + 2] = normals[src * 3 + 2];
      for (let k = 0; k < 4; k++) settled[next * 4 + k] = settled[src * 4 + k];
      for (let k = 0; k < 4; k++) field[next * 4 + k] = field[src * 4 + k];
      for (let k = 0; k < 3; k++) road[next * 3 + k] = road[src * 3 + k];
      canal[next * 2] = canal[src * 2];
      canal[next * 2 + 1] = canal[src * 2 + 1];
      river[next] = river[src];
      forest[next] = forest[src];
      next++;
    }
    for (let k = 0; k < border.length - 1; k++) {
      const g0 = border[k];
      const g1 = border[k + 1];
      const s0 = base + k;
      const s1 = base + k + 1;
      if (flip) indices.push(g0, g1, s0, g1, s1, s0);
      else indices.push(g0, s0, g1, g1, s0, s1);
    }
  };

  const south: number[] = [];
  const north: number[] = [];
  const west: number[] = [];
  const east: number[] = [];
  for (let k = 0; k < cols; k++) {
    south.push(k);
    north.push(N * cols + k);
    west.push(k * cols);
    east.push(k * cols + N);
  }
  // Winding differs per edge so every skirt faces outward.
  addSkirt(south, true);
  addSkirt(north, false);
  addSkirt(west, false);
  addSkirt(east, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('aSettled', new THREE.BufferAttribute(settled, 4));
  geo.setAttribute('aRiver', new THREE.BufferAttribute(river, 1));
  geo.setAttribute('aForest', new THREE.BufferAttribute(forest, 1));
  geo.setAttribute('aRoad', new THREE.BufferAttribute(road, 3));
  geo.setAttribute('aField', new THREE.BufferAttribute(field, 4));
  geo.setAttribute('aCanal', new THREE.BufferAttribute(canal, 2));
  geo.setIndex(indices);
  // Bound the geometry where it actually is, or a summit chunk falls outside
  // its own bounds and is culled while still on screen.
  const lowest = minH - skirtDepth;
  const midY = (maxH + lowest) / 2;
  const halfY = (maxH - lowest) / 2;
  const halfXZ = half * Math.SQRT2;
  geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, midY, 0),
    Math.hypot(halfXZ, halfY) + 8, // margin covers the understudy sink offset
  );
  return geo;
}

// --------------------------------------------------------------------- material

const C = FRONT_CONSTS;
const f1 = (n: number): string => n.toFixed(1);

/**
 * Helpers for the battlefield: anti-aliased bands, the trench plans and the
 * crater grids. All of it world-space and procedural, so it holds from a
 * hundred metres up to three kilometres without a texture in sight.
 */
const BATTLE_GLSL = /* glsl */ `
${FRONT_GLSL}

// Coverage of a band |dist| < halfW at a pixel footprint of fw metres. Sharp
// when the band is wider than a pixel, dimmed in proportion when it is not, so
// thin lines fade into the average tone of the ground instead of shimmering.
float bfLine(float dist, float halfW, float fw) {
  float f = max(fw, 1e-3);
  return clamp((halfW - dist) / f + 0.5, 0.0, 1.0) * min(1.0, 2.0 * halfW / f);
}

// Distance to a traversed fire trench centred on u = 0: bays at +amp for
// \`duty\` of each period, stepping back round a traverse to -amp — the
// crenellated plan that every aerial photograph of the front shows.
float bfCrenel(float s, float u, float period, float amp, float duty) {
  float f = fract(s / period);
  float lvl = f < duty ? amp : -amp;
  float du = abs(u - lvl);
  float ds = min(min(f, abs(f - duty)), 1.0 - f) * period;
  float over = max(abs(u) - amp, 0.0);
  return min(du, length(vec2(ds, over)));
}

// Distance to a zig-zag communication trench running along u, centred on s = 0.
float bfZigzag(float s, float u, float period, float amp) {
  float tri = abs(fract(u / period) * 2.0 - 1.0) * 2.0 - 1.0;
  float k = 4.0 * amp / period;
  return abs(s - amp * tri) / sqrt(1.0 + k * k);
}

// One grid of shell holes: the 2x2 cells nearest the point (centres are held
// in the middle half of each cell and reach at most 0.72 of one, so no other
// cell can reach). Keeps the crater that dominates, normalised by its radius,
// and accumulates the slope of every bowl for the lighting.
void bfCraters(vec2 p, float cell, float saltF, float share, float rMin, float rSpan,
               float dens, float flooded, float fw,
               inout float bestR, inout float bestWet, inout float bestSize, inout vec2 grad) {
  vec2 f = p / cell - 0.5;
  ivec2 g = ivec2(floor(f));
  uint salt = uint(saltF + uFrontSalt);
  for (int i = 0; i < 2; i++) {
    for (int j = 0; j < 2; j++) {
      ivec2 c = g + ivec2(i, j);
      if (bfHash(c, salt) > dens * share) continue;
      vec2 ctr = (vec2(c) + 0.25 + 0.5 * vec2(bfHash(c, salt + 1u), bfHash(c, salt + 2u))) * cell;
      float R = (rMin + rSpan * bfHash(c, salt + 3u)) * cell;
      vec2 dv = p - ctr;
      float dl = length(dv);
      float r = dl / R;
      if (r > 1.7) continue;
      float t = (r - 0.95) / 0.28;
      float dhdr = (r < 1.0 ? 0.56 * r : 0.0) - 0.06 * exp(-t * t) * 2.0 * t / 0.28;
      float vis = 1.0 - smoothstep(R * 0.2, R * 0.7, fw);
      grad += (dl > 1e-4 ? dv / dl : vec2(0.0)) * dhdr * vis;
      if (r < bestR) {
        bestR = r;
        bestSize = R;
        bestWet = bfHash(c, salt + 4u) < flooded ? 1.0 : 0.0;
      }
    }
  }
}
`;

/**
 * Standard PBR material with procedural splat shading injected.
 *
 * The countryside is blended from beach, grass, scree, rock and snow by
 * elevation and slope; farmland, woods, roads and aerodromes come in on
 * per-vertex attributes; and over all of it, keyed to the front's curve, the
 * battlefield: churned mud, trenches, wire and shell holes, fading out through
 * a belt of cratered fields into the intact country behind.
 */
function createTerrainMaterial(
  styleUniforms: Record<string, { value: unknown }>,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.42,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, styleUniforms, frontUniforms);
    applyHaze(shader);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainPos;
         varying vec3 vTerrainNormal;
         attribute vec4 aSettled;
         varying vec4 vSettled;
         attribute float aRiver;
         varying float vRiver;
         attribute float aForest;
         varying float vForest;
         attribute vec3 aRoad;
         varying vec3 vRoad;
         attribute vec4 aField;
         varying vec4 vField;
         attribute vec2 aCanal;
         varying vec2 vCanal;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
         vSettled = aSettled;
         vRiver = aRiver;
         vForest = aForest;
         vRoad = aRoad;
         vField = aField;
         vCanal = aCanal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTerrainPos;
         varying vec3 vTerrainNormal;
         varying vec4 vSettled;
         varying float vRiver;
         varying float vForest;
         varying vec3 vRoad;
         varying vec4 vField;
         varying vec2 vCanal;
         uniform vec3 uGrass;
         uniform vec3 uDry;
         uniform vec3 uRock;
         uniform float uSnowLine;
         uniform float uTreeLine;
         uniform float uStrata;
         uniform float uBeach;
         uniform vec3 uTimber;
         uniform float uFarm;
         uniform float uStony;

         float tHash(vec2 p) {
           p = fract(p * vec2(123.34, 456.21));
           p += dot(p, p + 45.32);
           return fract(p.x * p.y);
         }
         float tNoise(vec2 p) {
           vec2 i = floor(p), f = fract(p);
           vec2 u = f * f * (3.0 - 2.0 * f);
           float a = tHash(i);
           float b = tHash(i + vec2(1.0, 0.0));
           float c = tHash(i + vec2(0.0, 1.0));
           float d = tHash(i + vec2(1.0, 1.0));
           return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
         }
         float tFbm(vec2 p) {
           float s = 0.0, a = 0.5;
           for (int k = 0; k < 4; k++) { s += a * tNoise(p); p *= 2.03; a *= 0.5; }
           return s;
         }
         ${BATTLE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         // Shared with the roughness and normal chunks further down.
         float bfWater = 0.0;
         float bfMud = 0.0;
         float bfMown = 0.0;
         vec2 bfGrad = vec2(0.0);
         {
           vec2 wp = vTerrainPos.xz;
           float h = vTerrainPos.y;
           float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
           // Metres per pixel: what every band and grid below antialiases against.
           float fw = max(length(dFdx(wp)), length(dFdy(wp)));
           // Desert worlds carry sand in the grass slot.
           float sandy = smoothstep(0.35, 0.6, uGrass.r);

           // Where this point stands relative to the lines.
           float bfU = 1e5;
           float bfSide = 1.0;
           if (uFrontOn > 0.5) {
             float fsl = bfFrontSlope(wp.x);
             float dd = (wp.y - bfFrontZ(wp.x)) / sqrt(1.0 + fsl * fsl);
             bfSide = dd >= 0.0 ? 1.0 : -1.0;
             bfU = abs(dd) - (uFrontCfg.x + bfEdge(wp.x, bfSide));
           }
           float shatter = 1.0 - smoothstep(280.0, 1050.0, bfU);

           vec3 sand  = vec3(0.60, 0.53, 0.37);
           vec3 grass = uGrass;
           vec3 dry   = uDry;
           vec3 rock  = uRock;
           vec3 snow  = vec3(0.93, 0.95, 0.98);

           // NB: 'patch' is a reserved word in GLSL — don't name anything that.
           float broad  = tFbm(wp * 0.0009);
           float mottle = tFbm(wp * 0.004);
           float fine   = tFbm(wp * 0.021);

           vec3 col = grass;
           col = mix(sand, col, smoothstep(uBeach - 10.0, uBeach, h));
           col = mix(col, dry, smoothstep(uTreeLine - 290.0, uTreeLine + 290.0, h + broad * 260.0));
           col = mix(col, rock, smoothstep(0.32, 0.66, slope + broad * 0.12));
           float snowLine = smoothstep(uSnowLine, uSnowLine + 400.0, h + broad * 160.0)
                          * (1.0 - smoothstep(0.55, 0.85, slope));
           col = mix(col, snow, snowLine);

           // Limestone breaking through thin soil: grey pavement, scrub and
           // red earth in the hollows — the Carso, the Gallipoli scrub.
           if (uStony > 0.001) {
             float bare = smoothstep(0.5, 0.66, tFbm(wp * 0.0065 + 11.0) * 0.7 + fine * 0.3 + slope * 0.6);
             vec3 pavement = mix(rock, rock * vec3(1.05, 1.0, 0.92), fine) * 0.78;
             vec3 terra = uDry * vec3(1.15, 0.78, 0.55);
             col = mix(col, pavement, bare * uStony);
             col = mix(col, terra, smoothstep(0.62, 0.74, mottle) * (1.0 - bare) * uStony * 0.6);
             float scrubVis = 1.0 - smoothstep(0.4, 2.5, fw);
             col *= mix(1.0, 0.75 + 0.35 * tNoise(wp * 0.35), scrubVis * uStony * 0.7);
           }

           if (uStrata > 0.0) {
             float band = 0.5 + 0.5 * sin(h * 0.0555 + broad * 1.4);
             col = mix(col, col * vec3(1.22, 0.80, 0.62), uStrata * band * 0.5);
           }

           // The countryside's own patchwork: every lowland front was farmed
           // hedge to hedge. Fields on a grid turned per 2.6 km district, with
           // an exact integer hash so the tree scatter can find the hedges.
           float farmCover = 0.0;
           if (uFarm > 0.001) {
             // Districts with wandering borders, so from altitude the country
             // is not a quilt of squares. Mirrored on the CPU for the hedges.
             vec2 dw = wp + vec2(sin(wp.y * 0.0011 + 0.4), sin(wp.x * 0.0013 + 1.9)) * 520.0;
             ivec2 rg = ivec2(floor(dw / 2600.0));
             uint fs = uint(uFrontSalt);
             float ang = bfHash(rg, 901u + fs) * 3.14159;
             float ca = cos(ang);
             float sa = sin(ang);
             vec2 lp = vec2(ca * wp.x + sa * wp.y, -sa * wp.x + ca * wp.y);
             lp += vec2(sin(lp.y * 0.0041), sin(lp.x * 0.0033)) * 22.0;
             vec2 size = vec2(150.0, 230.0) * (0.75 + 0.6 * bfHash(rg, 902u + fs));
             vec2 gcell = floor(lp / size);
             vec2 within = fract(lp / size);
             ivec2 fc = ivec2(gcell) + rg * 977;
             float pick = bfHash(fc, 903u + fs);
             // Wheat and stubble, pasture, roots, ploughland, fallow.
             vec3 wheat = uDry * vec3(1.28, 1.18, 0.78);
             vec3 plough = uDry * vec3(0.62, 0.5, 0.4);
             vec3 tone = pick < 0.24 ? wheat
                       : pick < 0.56 ? uGrass * 1.05
                       : pick < 0.74 ? mix(uGrass, wheat, 0.35) * 1.02
                       : pick < 0.88 ? plough
                       : uGrass * 0.84;
             tone *= 0.88 + 0.22 * bfHash(fc, 904u);
             // Furrows, up close: the direction of ploughing per field.
             float furrowVis = 1.0 - smoothstep(0.3, 1.2, fw);
             float fdir = bfHash(fc, 905u) < 0.5 ? lp.x : lp.y;
             tone *= mix(1.0, 0.92 + 0.08 * sin(fdir * 2.4), furrowVis * step(0.78, pick) * step(pick, 0.9));
             vec2 bd = (0.5 - abs(within - 0.5)) * size;
             float edge = bfLine(min(bd.x, bd.y), 1.6, fw);
             tone = mix(tone, uGrass * 0.55, edge * 0.55);
             // Rough pasture and common between the fields in the thinner
             // farming worlds, decided per field so the edge is a hedge.
             float kept = step(bfHash(fc, 906u + fs), uFarm * 1.15);
             farmCover = kept * min(1.0, uFarm * 1.5) * (1.0 - smoothstep(0.07, 0.18, slope))
                       * (1.0 - snowLine)
                       * (1.0 - smoothstep(uTreeLine - 500.0, uTreeLine - 250.0, h));
             col = mix(col, tone, farmCover * 0.68);
           }

           // Round each village, its own closes and strips, in the village's
           // grid: the same crops as the open country, smaller and tighter.
           vec3 wheatV = uDry * vec3(1.28, 1.18, 0.78);
           vec3 ploughV = uDry * vec3(0.62, 0.5, 0.4);
           // Where the country is not farmed field to field — the desert —
           // a village is an oasis: irrigated gardens and palm groves.
           if (vSettled.w > 0.001 && uFarm < 0.5) {
             ivec2 gc = ivec2(floor(wp / vec2(38.0, 55.0)));
             float g = bfHash(gc, 907u);
             vec3 garden = g < 0.55 ? vec3(0.07, 0.12, 0.04) : g < 0.8 ? vec3(0.10, 0.14, 0.05) : uDry * 0.7;
             vec2 gb = (0.5 - abs(fract(wp / vec2(38.0, 55.0)) - 0.5)) * vec2(38.0, 55.0);
             garden = mix(garden, uDry * 0.8, bfLine(min(gb.x, gb.y), 1.0, fw) * 0.6);
             col = mix(col, garden, smoothstep(0.35, 0.8, vSettled.w) * (1.0 - uFarm * 2.0) * 0.85);
           }
           if (vSettled.x > 0.001) {
             float afield = clamp(length(vSettled.yz) / 1400.0, 0.0, 1.0);
             vec2 acre = vec2(60.0 + afield * 110.0, 95.0 + afield * 160.0);
             vec2 wander = vec2(tFbm(vSettled.yz * 0.0021 + 4.0),
                                tFbm(vSettled.yz * 0.0021 + 19.0)) - 0.5;
             vec2 grid = (vSettled.yz + wander * 150.0) / acre;
             vec2 plot = floor(grid);
             vec2 within = fract(grid);
             float pick = tHash(plot * 0.37 + 3.1);
             vec3 tone = pick < 0.3 ? wheatV
                       : pick < 0.6 ? uGrass * 1.08
                       : pick < 0.8 ? mix(uGrass, wheatV, 0.35)
                       : ploughV;
             tone *= 0.92 + 0.16 * tHash(plot * 1.7 + 8.3);
             vec2 bd = (0.5 - abs(within - 0.5)) * acre;
             float hedge = bfLine(min(bd.x, bd.y), 1.4, fw);
             tone = mix(tone, uGrass * 0.55, hedge * 0.55);
             float worked = smoothstep(0.26, 0.46, tHash(plot * 0.91 + 5.7));
             col = mix(col, tone, vSettled.x * worked * 0.78 * (1.0 - smoothstep(0.08, 0.22, slope)));
             farmCover = max(farmCover, vSettled.x * worked);
           }

           // Woods, from the same forest cover the 3D trees stand on. Near
           // the lines they are not woods any more.
           {
             float canopy = smoothstep(0.10, 0.48, vForest + (fine - 0.5) * 0.3);
             float crowns = mix(0.5, tNoise(wp * 0.22), 1.0 - smoothstep(0.8, 3.0, fw));
             float clump = (0.78 + 0.4 * fine + 0.2 * mottle) * (0.8 + 0.45 * crowns);
             col = mix(col, uTimber * clump, canopy * (1.0 - shatter) * 0.94);
           }

           // Patchiness at a scale that still reads from altitude, and turf up
           // close so the ground under the wheels is grass, not paint.
           col *= 1.0 + (0.2 * mottle + 0.12 * fine - 0.16) * (1.0 - farmCover * 0.65);
           {
             float turfVis = 1.0 - smoothstep(0.08, 0.5, fw);
             if (turfVis > 0.0) {
               float t1 = tNoise(wp * 3.1);
               float t2 = tNoise(wp * 11.0 + 7.0);
               col *= mix(1.0, 0.8 + 0.28 * t1 + 0.14 * t2, turfVis * (1.0 - bfMud) * 0.8);
             }
           }

           // Rivers: terrain shaded and polished until it reads as water.
           col = mix(col, vec3(0.030, 0.062, 0.072), smoothstep(0.05, 0.48, vRiver));
           // Canals: ruled straight, so drawn from their signed distance like
           // the roads — crisp at every level of detail, where the river mask
           // would break into dashes on the coarse chunks.
           float canalW = 0.0;
           if (vCanal.y > 0.985) {
             canalW = bfLine(abs(vCanal.x), 11.0, fw);
             float bank = max(0.0, bfLine(abs(vCanal.x), 13.5, fw) - canalW);
             col = mix(col, uDry * 0.7, bank * 0.7);
             col = mix(col, vec3(0.028, 0.05, 0.056), canalW);
           }

           // Roads: pale, dusty, a darker verge either side. Only where every
           // vertex of the triangle agreed there was a road near, or a sign
           // flip between two unrelated roads would draw a phantom one.
           if (vRoad.y > 0.985) {
             float rw = vRoad.z;
             float along = 1.0 - smoothstep(-20.0, 260.0, -bfU);
             float fade = smoothstep(-10.0, 240.0, bfU);
             float cov = bfLine(abs(vRoad.x), rw, fw) * fade;
             float verge = max(0.0, bfLine(abs(vRoad.x), rw + 2.6, fw) * fade - cov);
             vec3 roadCol = mix(uDry * 0.95 + 0.01, vec3(0.33, 0.315, 0.29), 0.45);
             roadCol = mix(roadCol, uGrass * 1.1, sandy * 0.5);
             col = mix(col, col * 0.78, verge * 0.6);
             col = mix(col, roadCol * (0.9 + 0.16 * fine), cov);
             // Wheel ruts, up close.
             float rut = bfLine(abs(abs(vRoad.x) - rw * 0.45), 0.25, fw) * cov;
             col = mix(col, col * 0.8, rut * 0.6);
             along = along;
           }

           // Aerodromes: a mown landing ground with its marks, in the field's
           // own frame so the lines are straight at any LOD.
           if (vField.z > 1.0) {
             float al = vField.x;
             float ri = vField.y;
             float L = vField.z;
             float W = vField.w;
             float inField = (1.0 - smoothstep(L - 30.0, L + 20.0, abs(al)))
                           * (1.0 - smoothstep(W - 25.0, W + 20.0, abs(ri)));
             vec3 mown = mix(uGrass * 1.3 + vec3(0.012, 0.02, 0.0), uDry * 1.08, sandy);
             float stripeVis = 1.0 - smoothstep(3.0, 9.0, fw);
             float stripe = smoothstep(0.35, 0.65, abs(fract(ri / 30.0) - 0.5) * 2.0);
             mown *= mix(1.0, 0.86 + 0.24 * stripe, stripeVis);
             bfMown = inField;
             // Wheel-worn lanes along the run, and a trodden apron by the hangars.
             float lanes = bfLine(abs(abs(ri) - W * 0.3), 7.0, fw) * 0.28;
             mown = mix(mown, uDry * 0.9, lanes);
             col = mix(col, mown, inField * 0.92);
             // The boundary: a line of marker flags and a mown edge.
             float bx = abs(abs(al) - L);
             float by = abs(abs(ri) - W);
             float boundary = max(bfLine(bx, 1.2, fw) * step(abs(ri), W), bfLine(by, 1.2, fw) * step(abs(al), L));
             col = mix(col, uGrass * 0.6, boundary * 0.5);
             float apron = (1.0 - smoothstep(20.0, 45.0, abs(ri + W + 20.0)))
                         * (1.0 - smoothstep(130.0, 190.0, abs(al + L * 0.55 - 60.0)));
             col = mix(col, uDry * (0.78 + 0.2 * fine), apron * 0.75);
             // The marks: a circle in the middle and a landing T at the downwind end.
             float ring = bfLine(abs(length(vec2(al, ri)) - 20.0), 1.2, fw);
             float tX = al + L * 0.6;
             float stem = bfLine(abs(ri), 1.7, fw) * step(-28.0, tX) * step(tX, 0.0);
             float bar = bfLine(abs(tX), 1.7, fw) * step(abs(ri), 14.0);
             float marks = max(ring, max(stem, bar));
             col = mix(col, vec3(0.80, 0.79, 0.74), marks * inField);
           }

           // ------------------------------------------------ the battlefield
           if (uFrontOn > 0.5 && bfU < 3200.0) {
             float craters = uFrontCfg.y;
             float chalk = uFrontCfg.z;
             float flooded = uFrontCfg.w;
             float u = bfU;
             float s = wp.x;
             float steep = smoothstep(0.42, 0.72, slope);
             float lowNoise = tFbm(wp * 0.011);

             // How churned: all of no-man's-land, ragged out across the trench belt.
             float churn = 1.0 - smoothstep(-40.0, 380.0, u + (lowNoise - 0.5) * 300.0);
             churn *= 1.0 - steep * 0.6;
             // Behind that, the fields gone to rank grass and thistle.
             float blight = 1.0 - smoothstep(250.0, 1900.0, u + (mottle - 0.5) * 600.0);

             vec3 soil = mix(vec3(0.13, 0.094, 0.06), uDry * 0.6, 0.25 + 0.65 * sandy);
             vec3 dark = soil * vec3(0.56, 0.5, 0.44);
             vec3 chalkC = vec3(0.56, 0.52, 0.43);
             vec3 spoil = mix(soil * 1.4, chalkC, chalk * 0.9);
             spoil = mix(spoil, uGrass * 1.08, sandy);
             dark = mix(dark, uGrass * 0.62, sandy * 0.6);

             float clodVis = 1.0 - smoothstep(0.25, 1.2, fw);
             float c1 = tFbm(wp * 0.075);
             float c2 = tFbm(wp * 0.6);
             // Disturbed ground: soil and subsoil turned over together. In
             // chalk country that is a grey-white porridge; in Flanders, mud.
             vec3 disturbed = mix(soil, spoil, 0.22 + 0.42 * chalk);
             vec3 churned = mix(dark * 1.1, disturbed, smoothstep(0.28, 0.68, c1));
             churned = mix(churned, spoil, smoothstep(0.62, 0.8, c2) * (0.18 + 0.3 * chalk) * clodVis);
             churned *= mix(1.0, 0.84 + 0.32 * tNoise(wp * 2.1), clodVis);
             // Wet patches where the water lies.
             churned = mix(churned, dark * 0.7, smoothstep(0.62, 0.8, lowNoise) * flooded * 0.6);

             vec3 weeds = mix(col, mix(uDry * 0.78, uGrass * 0.85, 0.45), 0.6);
             col = mix(col, weeds, blight * 0.75);
             col = mix(col, churned, churn);
             bfMud = churn;

             // The woods near the line: stumps standing in the mud.
             float woodF = smoothstep(0.08, 0.45, vForest) * shatter;
             if (woodF > 0.01) {
               col = mix(col, mix(churned, vec3(0.19, 0.18, 0.16), 0.35), woodF * 0.55);
               vec2 sc = floor(wp / 3.4);
               ivec2 ic = ivec2(sc);
               vec2 so = (sc + 0.5 + (vec2(bfHash(ic, 506u), bfHash(ic, 507u)) - 0.5) * 0.6) * 3.4;
               float stump = bfLine(length(wp - so), 0.4, fw) * step(bfHash(ic, 505u), 0.5);
               col = mix(col, vec3(0.045, 0.04, 0.035), stump * woodF);
             }

             // ---- shell holes: heavy, field-gun and small, densest on the
             // line and thinning out to the odd hole in a far field.
             // Shelling is not even: barrages walk, some ground is hit again and
             // again and some survives. A slow noise lumps the density.
             float dens = bfDensity(u) * craters * mix(0.55, 1.0, bfLump(wp));
             vec3 avgHole = mix(dark, disturbed, 0.5);
             float farFade = smoothstep(3.0, 14.0, fw);
             col = mix(col, avgHole, dens * 0.3 * farFade);
             if (dens > 0.004 && farFade < 0.999) {
               float bestR = 9.0;
               float bestWet = 0.0;
               float bestSize = 0.0;
               float wetShare = flooded * 0.45;
               bfCraters(wp, ${f1(C.C1)}, ${f1(C.SALT_C1)}, 0.9, 0.2, 0.25, dens, wetShare, fw,
                         bestR, bestWet, bestSize, bfGrad);
               bfCraters(wp, ${f1(C.C2)}, ${f1(C.SALT_C2)}, 0.62, 0.18, 0.26, dens, wetShare, fw,
                         bestR, bestWet, bestSize, bfGrad);
               if (fw < 1.0 && u < 700.0) {
                 bfCraters(wp, 5.5, 404.0, 0.55, 0.16, 0.26, dens * (1.0 - smoothstep(0.0, 700.0, u)),
                           wetShare * 0.4, fw, bestR, bestWet, bestSize, bfGrad);
               }
               if (bestR < 1.7) {
                 float vis = (1.0 - smoothstep(bestSize * 0.3, bestSize * 1.1, fw)) * (1.0 - steep * 0.7);
                 float bowl = 1.0 - smoothstep(0.8, 0.96, bestR);
                 float rim = smoothstep(0.74, 0.92, bestR) * (1.0 - smoothstep(1.02, 1.28, bestR));
                 float ejecta = smoothstep(1.0, 1.18, bestR) * (1.0 - smoothstep(1.25, 1.7, bestR));
                 // Fresh holes in a field show their spoil loud and clear; in
                 // no-man's-land every rim is just more of the same porridge.
                 vec3 bowlCol = mix(mix(dark * 0.75, soil * 0.95, bestR * bestR), disturbed * 0.8, chalk * 0.45);
                 bowlCol = mix(bowlCol, soil * 1.1, (1.0 - churn) * 0.35);
                 vec3 rimCol = mix(spoil, disturbed * 1.08, churn * 0.75);
                 vec3 cc = col;
                 cc = mix(cc, rimCol, ejecta * (0.22 + 0.35 * chalk) * smoothstep(0.35, 0.75, c2 + 0.25));
                 cc = mix(cc, rimCol, rim * (0.55 + 0.3 * chalk) * (0.6 + 0.5 * c2));
                 cc = mix(cc, bowlCol, bowl);
                 float pool = bestWet * (1.0 - smoothstep(0.5, 0.6, bestR));
                 cc = mix(cc, dark * 0.55, bestWet * (1.0 - smoothstep(0.58, 0.74, bestR)) * 0.8);
                 col = mix(col, cc, vis);
                 bfWater = max(bfWater, pool * vis);
               }
             }

             // ---- mine craters: the handful of enormous ones.
             if (u < 90.0 && craters > 0.0) {
               float mc = floor(wp.x / ${f1(C.MINE_CELL)});
               uint ms = uint(${f1(C.SALT_MINE)} + uFrontSalt);
               int im = int(mc);
               if (bfHash(ivec2(im, 0), ms) < 0.38 * craters) {
                 float mx = (mc + 0.2 + 0.6 * bfHash(ivec2(im, 1), ms)) * ${f1(C.MINE_CELL)};
                 float across = (bfHash(ivec2(im, 2), ms) - 0.5) * uFrontCfg.x;
                 float mr = 20.0 + 16.0 * bfHash(ivec2(im, 3), ms);
                 float msl = bfFrontSlope(mx);
                 vec2 mcen = vec2(mx, bfFrontZ(mx) + across * sqrt(1.0 + msl * msl));
                 vec2 dv = wp - mcen;
                 float r = length(dv) / mr;
                 if (r < 2.3) {
                   float t = (r - 0.95) / 0.28;
                   float dhdr = (r < 1.0 ? 0.68 * r : 0.0) - 0.12 * exp(-t * t) * 2.0 * t / 0.28;
                   bfGrad += normalize(dv + 1e-4) * dhdr;
                   float lip = smoothstep(0.7, 0.95, r) * (1.0 - smoothstep(1.1, 2.2, r + (c1 - 0.5) * 0.5));
                   col = mix(col, spoil * 1.08, lip * 0.9);
                   col = mix(col, mix(dark * 0.7, soil, r * r), 1.0 - smoothstep(0.8, 0.95, r));
                   bfWater = max(bfWater, (1.0 - smoothstep(0.42, 0.5, r)) * step(0.3, flooded));
                 }
               }
             }
             // ---- trenches: fire, support and reserve lines, the
             // communication trenches zig-zagging back, and saps out into
             // no-man's-land.
             vec3 q = bfSide > 0.0 ? uWobHome : uWobFar;
             float sP = s + q.x * 37.0;
             float uf = u - ${f1(C.FIRE_BACK)};
             float dFire = bfCrenel(sP, uf, 25.0, 3.4, 0.64);
             float us = u - (165.0 + 28.0 * sin(s * 0.0023 + q.y) + 12.0 * sin(s * 0.0071 + q.z));
             float dSup = bfCrenel(sP * 1.13 + 11.0, us, 21.0, 2.6, 0.6);
             float ur = u - (540.0 + 70.0 * sin(s * 0.0014 + q.z) + 25.0 * sin(s * 0.0053 + q.x));
             float dRes = bfCrenel(sP * 0.9 + 5.0, ur, 34.0, 4.0, 0.5);

             float dComm = 1e5;
             float ci = floor(s / 260.0);
             for (int k = -1; k <= 1; k++) {
               float cc = ci + float(k);
               ivec2 ic = ivec2(int(cc), bfSide > 0.0 ? 1 : 2);
               if (bfHash(ic, uint(707.0 + uFrontSalt)) > 0.6) continue;
               float s0 = (cc + 0.15 + 0.7 * bfHash(ic, uint(708.0 + uFrontSalt))) * 260.0;
               float uEnd = 220.0 + 1100.0 * pow(bfHash(ic, uint(709.0 + uFrontSalt)), 1.6);
               if (u < -2.0 || u > uEnd) continue;
               float bend = 55.0 * sin(u * 0.0031 + cc * 1.7) + 14.0 * sin(u * 0.011 + cc);
               dComm = min(dComm, bfZigzag(s - s0 - bend, u, 30.0, 6.0));
             }

             float dSap = 1e5;
             float dPost = 1e5;
             {
               float cs = floor(s / 150.0);
               ivec2 ic = ivec2(int(cs), bfSide > 0.0 ? 3 : 4);
               if (bfHash(ic, uint(711.0 + uFrontSalt)) < 0.6) {
                 float s0 = (cs + 0.3 + 0.4 * bfHash(ic, uint(712.0 + uFrontSalt))) * 150.0;
                 float len = 18.0 + 30.0 * bfHash(ic, uint(713.0 + uFrontSalt));
                 dSap = length(vec2(s - s0, uf - clamp(uf, -len, 0.0)));
                 dPost = length(vec2(s - s0, uf + len));
               }
             }

             float tv = (1.0 - steep) * (1.0 - smoothstep(1500.0, 1700.0, u)) * smoothstep(0.5, 2.5, h);
             if (tv > 0.001) {
               vec3 cut = mix(vec3(0.028, 0.024, 0.02), dark * 0.4, 0.3);
               vec3 spoilT = mix(spoil, soil, 0.35 * c1) * (0.92 + 0.12 * c2);
               float spoilW = 3.2 + 1.8 * chalk;
               // The spoil is thrown, not laid: its width wanders and it is
               // broken where shells have scattered it.
               spoilW *= 0.7 + 0.6 * tNoise(wp * 0.045 + 3.0);
               float sp = max(max(bfLine(dSup, 1.0 + spoilW * 0.85, fw), bfLine(dRes, 0.9 + spoilW * 0.7, fw)),
                              max(bfLine(dComm, 0.8 + spoilW * 0.6, fw), bfLine(dFire, 1.15 + spoilW, fw)));
               sp *= mix(1.0, smoothstep(0.25, 0.55, c1 * 0.6 + c2 * 0.4), clodVis * 0.8);
               sp = max(sp, max(bfLine(dSap, 0.7 + spoilW * 0.5, fw), bfLine(dPost, 2.4 + spoilW * 0.6, fw)));
               float ct = max(max(bfLine(dSup, 1.0, fw), bfLine(dRes, 0.9, fw)),
                              max(bfLine(dComm, 0.75, fw), bfLine(dFire, 1.15, fw)));
               ct = max(ct, max(bfLine(dSap, 0.65, fw), bfLine(dPost, 1.8, fw)));
               // Bold where it crosses fields — the white scars of every aerial
               // photograph — and only a smoother band amid the churn.
               col = mix(col, spoilT, sp * tv * mix(0.9, 0.45, churn) * (0.75 + 0.25 * smoothstep(0.3, 0.6, c1)));
               col = mix(col, cut, ct * tv);
               // Up close, the floor of the trench: a strip of duckboard.
               float floorVis = 1.0 - smoothstep(0.15, 0.6, fw);
               if (floorVis > 0.0) {
                 float fl = max(bfLine(dFire, 0.3, fw), max(bfLine(dSup, 0.25, fw), bfLine(dComm, 0.22, fw)));
                 col = mix(col, vec3(0.075, 0.058, 0.042), fl * floorVis * tv * (1.0 - smoothstep(0.5, 0.9, flooded)));
               }
               bfWater = max(bfWater, ct * tv * smoothstep(0.4, 0.9, flooded) * 0.85);
             }

             // ---- wire: two belts in front of the fire trench, a grey-brown
             // hatch of pickets and coils.
             float beltA = 1.0 - smoothstep(8.0, 11.0, abs(u + 24.0 + 5.0 * sin(s * 0.013 + q.x)));
             float beltB = 1.0 - smoothstep(4.0, 6.5, abs(u + 58.0 + 6.0 * sin(s * 0.009 + q.y)));
             float belt = max(beltA, beltB * 0.8) * (1.0 - steep) * smoothstep(0.5, 2.5, h);
             if (belt > 0.001) {
               // Coils and knife-rests: loops of wire along the belt, pickets
               // at irregular spacing, and a grey-brown stain where rust and
               // trampled ground meet.
               float wob = tNoise(wp * 0.7) * 1.4;
               float coilA = bfLine(abs(fract((s + wob) / 1.9) - 0.5) * 1.9, 0.09, fw);
               float coilB = bfLine(abs(fract((u + 0.6 * s + wob * 1.3) / 2.6) - 0.5) * 2.6, 0.08, fw);
               vec2 pc = floor(wp / 2.8);
               ivec2 pic = ivec2(pc);
               vec2 po = (pc + 0.5 + (vec2(bfHash(pic, 511u), bfHash(pic, 512u)) - 0.5) * 0.7) * 2.8;
               float pick = bfLine(length(wp - po), 0.16, fw) * step(bfHash(pic, 513u), 0.6);
               float tangle = max(coilA * 0.8, max(coilB * 0.6, pick));
               vec3 wireCol = vec3(0.12, 0.10, 0.085);
               col = mix(col, wireCol, belt * clamp(0.28 + 0.6 * tangle, 0.0, 1.0));
             }

           }

           // Craters and trenches break the canal banks: what is left of the
           // water there is pools, not a channel.
           bfWater = max(bfWater, canalW * smoothstep(-40.0, 120.0, bfU));
           // Standing water: shell holes, flooded trenches. Dark, and the
           // roughness chunk polishes it so it takes the sky.
           col = mix(col, vec3(0.02, 0.026, 0.028), bfWater);
           diffuseColor.rgb *= col;
         }`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         {
           // Crater bowls and rims, lit properly: the slope of each bowl added
           // to the world normal and taken back into view space.
           if (dot(bfGrad, bfGrad) > 1e-6) {
             vec3 nW = normalize(vTerrainNormal);
             nW = normalize(nW + vec3(-bfGrad.x, 0.0, -bfGrad.y) * (1.0 - bfWater));
             normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
           }
           // Fine surface relief the geometry is far too coarse to carry.
           float detailFade = (1.0 - smoothstep(600.0, 4000.0, length(vViewPosition)))
                            * (1.0 - smoothstep(0.05, 0.4, vRiver)) * (1.0 - bfWater);
           if (detailFade > 0.001) {
             vec2 p = vTerrainPos.xz * 0.06;
             float n0 = tFbm(p);
             float nx = tFbm(p + vec2(0.15, 0.0));
             float nz = tFbm(p + vec2(0.0, 0.15));
             vec3 bump = vec3(n0 - nx, 0.0, n0 - nz) * (5.0 + bfMud * 4.0) * (1.0 - bfMown * 0.75) * detailFade;
             normal = normalize(normal + bump);
           }
         }`,
      )
      .replace(
        '#include <lights_fragment_maps>',
        `#include <lights_fragment_maps>
         #if defined( RE_IndirectSpecular )
           // Muddy water under a bright sky: it takes the sky, but darkly.
           radiance *= mix(1.0, 0.42, max(bfWater, smoothstep(0.06, 0.5, vRiver)));
         #endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         {
           float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
           roughnessFactor = mix(0.96, 0.78, smoothstep(0.3, 0.7, slope));
           roughnessFactor = mix(roughnessFactor, 0.55,
             smoothstep(uSnowLine - 380.0, uSnowLine, vTerrainPos.y));
           // Wet mud has a sheen; water takes the sky.
           roughnessFactor = mix(roughnessFactor, 0.14, smoothstep(0.06, 0.5, vRiver));
           roughnessFactor = mix(roughnessFactor, 0.36, bfWater);
         }`,
      );
  };

  // Any change to the injected source needs a distinct key or three reuses a
  // stale compiled program.
  material.customProgramCacheKey = () => 'terrain-splat-v13-front';
  return material;
}
