import * as THREE from 'three';
import { applyHaze } from './Haze';
import { terrainHeight, riverStrength } from './Worlds';
import { farmland, farmlandPlot, farmlandHome } from './Settlements';
import { cityDensity } from './City';
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
    /**
     * How wooded this world is, 0 to 1.
     *
     * Decided on the CPU from the world's *base* ground colour, not from the
     * one in `uGrass`. That one carries the season, and the season moves it
     * enough to change the answer: an autumn tint takes the Isles' green margin
     * from 0.12 down to 0.017, so a gate read live would have deleted every
     * forest in autumn and grown them back in winter. Whether a landscape has
     * trees is a property of the landscape.
     */
    uWooded: { value: 1 },
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

  setStyle(style: TerrainStyle, wooded = 1): void {
    this.styleUniforms.uWooded.value = wooded;
    this.styleUniforms.uGrass.value.set(...style.grass);
    this.styleUniforms.uDry.value.set(...style.dry);
    this.styleUniforms.uRock.value.set(...style.rock);
    this.styleUniforms.uSnowLine.value = style.snowLine;
    this.styleUniforms.uTreeLine.value = style.treeLine;
    this.styleUniforms.uStrata.value = style.strata;
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
  // How cultivated each vertex is. Carried on the mesh rather than drawn over
  // it, so village farmland is part of the terrain surface at every LOD.
  /**
   * Farmland: how cultivated a vertex is, and where it sits in its village's
   * own grid.
   *
   * Three numbers rather than one. The strength alone could only ever produce
   * a soft blob filled with noise, and what actually reads as farmland from
   * the air is straight boundaries meeting at corners — which needs a frame to
   * be straight *in*, and only the CPU knows which village won the point.
   */
  // (field strength, plot u, plot v, ordinary-village strength)
  const settled = new Float32Array(total * 4);
  /** River strength per vertex, so water is part of the surface at every LOD. */
  const river = new Float32Array(total);
  /**
   * How built-up each vertex is. Carried the same way, and for the same reason
   * the farmland is: at cruise a tower is a few pixels, and what actually makes
   * a city read from altitude is the ground between the towers going grey.
   */
  const built = new Float32Array(total);

  // Sample the height field once into a grid with a one-vertex border on each
  // side. The neighbours a central-difference normal needs are exactly the
  // adjacent grid vertices, so sampling them separately would evaluate the
  // (relatively expensive) height function five times per vertex instead of one.
  // The border ring is what lets edge vertices use real neighbours, keeping
  // shading continuous across chunk and LOD boundaries.
  const pad = cols + 2;
  const heights = new Float32Array(pad * pad);
  const wet = new Float32Array(pad * pad);
  for (let j = -1; j <= N + 1; j++) {
    for (let i = -1; i <= N + 1; i++) {
      const k = (j + 1) * pad + (i + 1);
      heights[k] = terrainHeight(node.x - half + i * step, node.z - half + j * step);
      // Read straight after the height: the river strength is a stash on the
      // last call, not a second evaluation of the field.
      wet[k] = riverStrength();
    }
  }
  const heightAt = (i: number, j: number): number => heights[(j + 1) * pad + (i + 1)];

  let minH = Infinity;
  let maxH = -Infinity;

  for (let j = 0; j < cols; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;

      const y = heightAt(i, j);
      if (y < minH) minH = y;
      if (y > maxH) maxH = y;

      positions[idx * 3] = -half + i * step;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = -half + j * step;
      settled[idx * 4] = farmland(node.x - half + i * step, node.z - half + j * step);
      // Both read straight off the back of that call, the way the river
      // strength is — one traversal answers for both kinds of village.
      const plot = farmlandPlot();
      settled[idx * 4 + 1] = plot[0];
      settled[idx * 4 + 2] = plot[1];
      settled[idx * 4 + 3] = farmlandHome();
      river[idx] = wet[(j + 1) * pad + (i + 1)];
      built[idx] = cityDensity(node.x - half + i * step, node.z - half + j * step);

      // Central difference at this chunk's own spacing, so the normals match the
      // resolution of the geometry rather than shimmering with detail it can't show.
      const nx = heightAt(i - 1, j) - heightAt(i + 1, j);
      const ny = 2 * step;
      const nz = heightAt(i, j - 1) - heightAt(i, j + 1);
      const inv = 1 / Math.hypot(nx, ny, nz);
      normals[idx * 3] = nx * inv;
      normals[idx * 3 + 1] = ny * inv;
      normals[idx * 3 + 2] = nz * inv;
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
      settled[next * 4] = settled[src * 4];
      settled[next * 4 + 1] = settled[src * 4 + 1];
      settled[next * 4 + 2] = settled[src * 4 + 2];
      settled[next * 4 + 3] = settled[src * 4 + 3];
      river[next] = river[src];
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
  geo.setAttribute('aCity', new THREE.BufferAttribute(built, 1));
  geo.setIndex(indices);
  // Bound the geometry where it actually is. A sphere centred on y = 0 with a
  // fixed radius only works while terrain stays near sea level: in a range whose
  // peaks are kilometres up, a summit chunk falls entirely outside its own
  // bounds and three culls it while it is still on screen — which reads as
  // near-field terrain going transparent or flickering as you turn.
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

/**
 * Standard PBR material with procedural splat shading injected.
 *
 * Colour is blended from beach/grass/scree/rock/snow by elevation and slope,
 * broken up with noise at two scales. Doing it in the shader rather than with
 * vertex colours means the detail survives at any LOD, and keeping it a
 * MeshStandardMaterial means it still receives shadows and image-based lighting.
 */
function createTerrainMaterial(
  styleUniforms: Record<string, { value: unknown }>,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    // A rough surface under a bright sky picks up a lot of ambient, which washes
    // the landscape toward sky colour. Damping it lets the sun define the form.
    envMapIntensity: 0.42,
  });

  material.onBeforeCompile = (shader) => {
    // Same uniform objects every compile, so updating them from TypeScript is
    // immediately visible without touching the material.
    Object.assign(shader.uniforms, styleUniforms);
    // Haze that knows where the sun is. The ground is most of what is far
    // away, so this is most of what aerial perspective is worth.
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
         attribute float aCity;
         varying float vCity;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         vTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);
         vSettled = aSettled;
         vRiver = aRiver;
         vCity = aCity;`,
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
         varying float vCity;
         varying float vRiver;
         uniform vec3 uGrass;
         uniform vec3 uDry;
         uniform vec3 uRock;
         uniform float uSnowLine;
         uniform float uTreeLine;
         uniform float uStrata;
         uniform float uWooded;

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
         }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
         {
           float h = vTerrainPos.y;
           float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);

           vec3 sand  = vec3(0.60, 0.53, 0.37);
           vec3 grass = uGrass;
           vec3 dry   = uDry;
           vec3 rock  = uRock;
           vec3 snow  = vec3(0.93, 0.95, 0.98);

           // NB: 'patch' is a reserved word in GLSL — don't name anything that.
           float broad  = tFbm(vTerrainPos.xz * 0.0009);
           float mottle = tFbm(vTerrainPos.xz * 0.004);
           float fine   = tFbm(vTerrainPos.xz * 0.021);

           vec3 col = grass;
           col = mix(sand, col, smoothstep(2.0, 34.0, h));
           // Vegetation thins with altitude, so green gives way to dry scree
           // high up rather than everything turning olive above the foothills.
           // The band is per-world: a fixed one is right for a coastline and
           // paints every high-altitude world uniformly grey.
           col = mix(col, dry, smoothstep(uTreeLine - 290.0, uTreeLine + 290.0, h + broad * 260.0));
           col = mix(col, rock, smoothstep(0.32, 0.66, slope + broad * 0.12));
           // Snow line comes from the season. Keeping it high in summer matters:
           // a low line turns every ridge white and flattens the scene out.
           float snowLine = smoothstep(uSnowLine, uSnowLine + 400.0, h + broad * 160.0)
                          * (1.0 - smoothstep(0.55, 0.85, slope));
           col = mix(col, snow, snowLine);

           // Woodland.
           //
           // The one thing this landscape had a treeline for and no trees
           // under: uTreeLine existed only to fade green to scree at
           // altitude. Forests are painted onto the ground the same way the
           // farmland already is — at cruise a tree is well under a pixel, and
           // what actually reads from the air is the colour and the shape of
           // the canopy, not the trunks.
           //
           // Free at runtime: no geometry, no vertex attribute, no CPU. The
           // region shape reuses the noise already computed for the ground,
           // plus one single-octave call — a quarter the cost of another fbm.
           if (uWooded > 0.001) {
             float stand = tNoise(vTerrainPos.xz * 0.0011 + 19.0);
             // Ragged edges. A smooth threshold gives a forest with a shoreline
             // drawn round it, which no forest has.
             float canopy = smoothstep(0.40, 0.62, stand * 0.72 + broad * 0.5
                                                  + mottle * 0.18 - 0.10);
             // Off the beach, under the treeline, and off anything steep — the
             // three rules that put woodland in valleys and on shoulders and
             // leave the crags bare.
             canopy *= smoothstep(4.0, 46.0, h);
             canopy *= 1.0 - smoothstep(uTreeLine - 170.0, uTreeLine + 70.0,
                                        h + broad * 200.0);
             canopy *= 1.0 - smoothstep(0.24, 0.50, slope);
             canopy *= 1.0 - snowLine;
             // Cleared ground: fields and streets are painted after this and
             // would cover it anyway, but fading it out first stops a
             // half-strength field reading as olive soup.
             canopy *= 1.0 - clamp(max(vSettled.x, vSettled.w), 0.0, 1.0) * 0.9;
             canopy *= 1.0 - clamp(vCity, 0.0, 1.0);
             canopy *= 1.0 - smoothstep(0.05, 0.40, vRiver);

             // Conifer dark, pulled a little towards the world's own green so
             // the same forest belongs on ten different palettes.
             vec3 timber = mix(uGrass * 0.52, vec3(0.050, 0.094, 0.054), 0.62);
             // Clumping, so the canopy has depth rather than being a flat wash.
             float clump = 0.74 + 0.44 * fine + 0.24 * mottle;
             col = mix(col, timber * clump, canopy * uWooded * 0.94);
           }

           // Horizontal rock banding for canyon country: alternating warm and
           // cool strata, keyed to absolute height so the bands stay level and
           // line up across the whole gorge the way real sedimentary layers do.
           if (uStrata > 0.0) {
             float band = 0.5 + 0.5 * sin(h * 0.0555 + broad * 1.4);
             col = mix(col, col * vec3(1.22, 0.80, 0.62), uStrata * band * 0.5);
           }

           // Farmland around villages. This — not the buildings — is what makes
           // a settlement visible from cruise: houses are 10 m across and two
           // pixels wide from up there, while cleared fields are hundreds of
           // metres of colour. Two tones split by a mid-scale noise read as a
           // patchwork of plots rather than one flat disc of paint.
           // The ordinary village's belt: the original, and still the right
           // thing for a small one. Soft plots split by a mid-scale noise,
           // close to the surrounding vegetation in brightness and different
           // in hue — a ring of cultivated colour that carries from cruise
           // without pretending to be a surveyed patchwork.
           if (vSettled.w > 0.001) {
             // A narrow band gives hard-edged plots. A soft gradient just reads
             // as a smudge and disappears into the haze at any useful range.
             float plots = smoothstep(0.45, 0.55, tFbm(vTerrainPos.xz * 0.011));
             // Ploughed earth and pasture, kept close to the surrounding
             // vegetation in *brightness* and different in *hue*. Lifting the
             // luminance instead reads as bleached ground, not as fields.
             vec3 stubble = uDry * 0.78;
             vec3 crop    = uGrass * 1.55;
             // Fields stop where the ground steepens. A generous slope limit
             // paints crops up the sides of hills, which stops reading as
             // farmland and starts reading as bleached rock.
             col = mix(col, mix(stubble, crop, plots),
                       vSettled.w * (1.0 - smoothstep(0.08, 0.22, slope)));
           }

           // The field village's patchwork, on top.
           if (vSettled.x > 0.001) {
             // Fields, laid out in the village's own grid.
             //
             // This was a noise threshold, and noise cannot make a corner —
             // it gave soft blobs of two colours, which reads as mottled grass
             // rather than as farmland. What says "cultivated" from the air is
             // straight boundaries meeting at right angles, so the plots are a
             // literal grid in the frame the village's street runs along. The
             // next village over has its own angle, so the country does not
             // come out as one continuous graph paper.
             //
             // Decided per fragment from interpolated local coordinates, never
             // per vertex: a ninety-metre field on a mesh whose vertices are
             // ten metres apart would otherwise break into dashes, which is
             // the same wall a thin feature always hits here.
             // Not \`out\`: that is a storage qualifier in GLSL, and naming a
             // float after it fails to compile — which takes the whole terrain
             // down, since the surface has no other material. The same trap as
             // \`half\` and \`patch\`, and this one was caught by the shader
             // watch in the offline check rather than by looking at a flat
             // white world.
             float afield = clamp(length(vSettled.yz) / 1400.0, 0.0, 1.0);
             // Small closes by the houses, big fields further out — infield and
             // outfield, which is how settlements actually grew.
             vec2 acre = vec2(74.0 + afield * 130.0, 108.0 + afield * 190.0);
             // Warped before it is gridded, so the boundaries bend.
             //
             // A grid in a rotated frame is still a perfect grid, and from the
             // air that reads as printed rather than as ploughed — real field
             // edges follow a stream, a contour or somebody's argument from
             // four centuries ago. Displacing the coordinates by a slow noise
             // first costs two lookups and bends every boundary in the belt
             // without moving any of them far.
             vec2 wander = vec2(tFbm(vSettled.yz * 0.0021 + 4.0),
                                tFbm(vSettled.yz * 0.0021 + 19.0)) - 0.5;
             vec2 grid = (vSettled.yz + wander * 150.0) / acre;
             vec2 plot = floor(grid);
             vec2 within = fract(grid);

             // A crop per plot, from a hash of which plot it is.
             float pick = tHash(plot * 0.37 + 3.1);
             // Closer together than they were. Three strongly separated tones
             // made a chessboard; farmland is mostly variations on one green
             // with the odd bare field among it.
             vec3 stubble  = uDry * 0.86;
             vec3 growing  = uGrass * 1.34;
             vec3 ploughed = uDry * 0.62;
             vec3 tone = pick < 0.36 ? stubble : (pick < 0.78 ? growing : ploughed);
             // Never two identical plots side by side, and never a flat swatch.
             tone *= 0.9 + 0.2 * tHash(plot * 1.7 + 8.3);
             tone = mix(tone, tone * 1.12, mottle);

             // Hedgerow. The margin is most of what makes a field a field: a
             // grid of colours with no boundaries reads as a quilt, and a grid
             // with dark edges reads as land somebody works.
             vec2 margin = abs(within - 0.5);
             float hedge = max(smoothstep(0.445, 0.5, margin.x),
                               smoothstep(0.455, 0.5, margin.y));
             tone = mix(tone, uGrass * 0.52, hedge * 0.55);

             // Not every plot is worked. Roughly a third is left as it was,
             // which is what breaks the belt up into farmland *among* country
             // rather than a solid sheet of it reaching to a hard circular
             // edge — and it is most of what makes there be fewer fields
             // without making the farmed ones smaller.
             float worked = smoothstep(0.26, 0.46, tHash(plot * 0.91 + 5.7));

             // Fields stop where the ground steepens. A generous slope limit
             // paints crops up the sides of hills, which stops reading as
             // farmland and starts reading as bleached rock.
             // Held short of full strength so the ground it is laid over still
             // shows through: at full mix a field is a flat swatch of paint.
             col = mix(col, tone,
                       vSettled.x * worked * 0.82
                       * (1.0 - smoothstep(0.08, 0.22, slope)));
           }

           // Patchiness at a scale that still reads from altitude.
           col *= 0.82 + 0.30 * mottle + 0.14 * fine;

           // Rivers. Applied after the patchiness, so the water is smooth rather
           // than carrying the ground's mottling through it. There is no second
           // water surface anywhere: the channel is terrain, shaded and polished
           // until it reads as water — which is the only way it can work in a
           // valley 1200 m above the sea, where the ocean plane cannot reach.
           col = mix(col, vec3(0.030, 0.062, 0.072), smoothstep(0.05, 0.48, vRiver));

           // The island's two surfaces, carried on one signed attribute: built
           // ground above zero, parkland below it.
           if (vCity > 0.001) {
             // Asphalt and concrete, with the avenue grid scored into it so the
             // streets read from the air even where the towers themselves have
             // become too small to resolve.
             vec2 blk = vTerrainPos.xz / vec2(276.0, 92.0);
             vec2 g = abs(fract(blk) - 0.5);
             float road = max(smoothstep(0.42, 0.5, g.x), smoothstep(0.40, 0.5, g.y));
             // Grey, not black. This was 0.05 — darker than wet tarmac at
             // night — and from a distance, before the buildings themselves
             // stream in, it read as a hole burnt in the landscape rather than
             // as a city. A city seen from miles away is a pale grey-brown
             // smudge, and it has haze over it like everything else that far
             // off, which near-black defeats.
             vec3 asphalt = mix(vec3(0.185, 0.183, 0.184), vec3(0.245, 0.238, 0.228), road);
             col = mix(col, asphalt, vCity * 0.78);
           } else if (vCity < -0.001) {
             vec3 park = mix(vec3(0.055, 0.115, 0.042), vec3(0.085, 0.150, 0.055), mottle);
             col = mix(col, park, -vCity * 0.95);
           }
           diffuseColor.rgb *= col;
         }`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         {
           // Fine surface relief the geometry is far too coarse to carry. Faded
           // out with distance, otherwise it aliases into shimmer on far slopes.
           // Water is smooth; the ground relief must not crawl across it.
           float detailFade = (1.0 - smoothstep(600.0, 4000.0, length(vViewPosition)))
                            * (1.0 - smoothstep(0.05, 0.4, vRiver));
           if (detailFade > 0.001) {
             vec2 p = vTerrainPos.xz * 0.06;
             float n0 = tFbm(p);
             float nx = tFbm(p + vec2(0.15, 0.0));
             float nz = tFbm(p + vec2(0.0, 0.15));
             vec3 bump = vec3(n0 - nx, 0.0, n0 - nz) * 5.0 * detailFade;
             normal = normalize(normal + bump);
           }
         }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         {
           float slope = 1.0 - clamp(vTerrainNormal.y, 0.0, 1.0);
           // Rock reads harder than vegetation; snow is smoother still.
           roughnessFactor = mix(0.96, 0.78, smoothstep(0.3, 0.7, slope));
           roughnessFactor = mix(roughnessFactor, 0.55,
             smoothstep(uSnowLine - 380.0, uSnowLine, vTerrainPos.y));
           // Low roughness is most of what sells a river: it lets the channel
           // pick up the sky through the environment map, the same way the sea
           // does, so it reads as water rather than as dark paint.
           roughnessFactor = mix(roughnessFactor, 0.09, smoothstep(0.06, 0.5, vRiver));
         }`,
      );
  };

  // Any change to the injected source needs a distinct key or three reuses a
  // stale compiled program.
  material.customProgramCacheKey = () => 'terrain-splat-v10';
  return material;
}
