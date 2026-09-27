import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M, Parts, V, rng, type HitSphere, type Vec3 } from './util';
import { NOISE_GLSL, TILE, crossPath, uberMaterial } from './atlas';
import { soldier } from './figures';
import { PAINT, COL } from './blocks';
import { heightToNormal } from './balloon';
import type { ModelRig } from '../GroundModels';

/**
 * The "super-Zeppelin": an R-class naval airship of the L 30 family, 196 m
 * long and 23.8 m across, drawn as the late-war L 59.
 *
 * The hull is an 18-sided polygon — each facet its own strip so light breaks
 * crisply along the longitudinals, with a slight concave sag across every
 * panel the way doped cotton sat between girders — painted with a silver
 * aluminium-dope back and the black night-camouflaged belly and flanks, ring
 * frames and seams in a normal map, and the ship's number on the bow.
 *
 * Destruction: a burn front runs from the stern to the bow over ~8 s. Behind
 * it the skin is discarded (a few charred tatters linger), revealing a
 * duralumin skeleton of ring trusses, longitudinals and keel that glows
 * white-orange at the front and cools to dull red and charcoal behind it.
 * Half-way through, the hull breaks its back: the fore and aft halves pivot
 * about the break into a V. The fire particles and the fall are the caller's.
 */

const LEN = 196;
const R = 11.9;
const Z0 = -98;
const SIDES = 18;
/** Hull occupies v ∈ [0, V_HULL] of the skin texture; fins below it. */
const TEX_W = 2048;
const TEX_H = 1024;
const HULL_ROWS = 800;
const V_HULL = HULL_ROWS / TEX_H;
const FIN_Y0 = 816;
const FIN_H = 200;
/** Where the burning hull breaks (an intermediate ring). */
const Z_BREAK = 7;
const BLACK_FROM = (80 / 360); // black dope below ±80° from the top
/** Fin texture slot: px per metre along the chord ÷ px per metre along the span. */
const FIN_ASPECT = ((TEX_W / 4) * 0.76 / 25.2) / (FIN_H / 7.6);

export function hullRadius(z: number): number {
  const s = (z - Z0) / LEN;
  if (s <= 0 || s >= 1) return 0.25;
  if (s < 0.14) {
    const t = (0.14 - s) / 0.14;
    return Math.max(0.25, R * Math.pow(Math.max(0, 1 - Math.pow(t, 2.1)), 1 / 2.1));
  }
  if (s <= 0.58) return R;
  const t = (s - 0.58) / 0.42;
  return Math.max(0.3, R * Math.pow(Math.max(0, 1 - Math.pow(t, 1.9)), 0.8));
}

const RINGS: number[] = [];
for (let z = -88; z <= 92; z += 10) RINGS.push(z);

/* ---------------------------------------------------------------- texture */

function paintHull(): { map: THREE.CanvasTexture; normalMap: THREE.DataTexture; orm: THREE.CanvasTexture } {
  const r = rng(907);
  const W = TEX_W, H = TEX_H;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const a = c.getContext('2d', { willReadFrequently: true })!;
  const hc = document.createElement('canvas'); hc.width = W; hc.height = H;
  const h = hc.getContext('2d', { willReadFrequently: true })!;
  const oc = document.createElement('canvas'); oc.width = W / 2; oc.height = H / 2;
  const o = oc.getContext('2d')!;
  const pxU = W / LEN;
  const panelH = HULL_ROWS / SIDES;
  const yBlack0 = BLACK_FROM * HULL_ROWS, yBlack1 = (1 - BLACK_FROM) * HULL_ROWS;
  const silver = [186, 189, 188];
  const black = [20, 21, 22];

  h.fillStyle = '#808080'; h.fillRect(0, 0, W, H);
  // Panels between ring frames and longitudinals, each its own dope shade.
  const zs = [Z0, ...RINGS.flatMap((z) => [z - 5, z]).filter((z) => z > Z0), 98];
  for (let i = 0; i < zs.length - 1; i++) {
    const x0 = (zs[i] - Z0) * pxU, x1 = (zs[i + 1] - Z0) * pxU;
    for (let k = 0; k < SIDES; k++) {
      const y0 = k * panelH, y1 = (k + 1) * panelH;
      const isBlack = (y0 + y1) / 2 > yBlack0 && (y0 + y1) / 2 < yBlack1;
      const base = isBlack ? black : silver;
      const j = 1 + (r() - 0.5) * (isBlack ? 0.3 : 0.07);
      a.fillStyle = `rgb(${base[0] * j},${base[1] * j},${base[2] * j})`;
      a.fillRect(x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    }
  }
  // Across each panel the fabric sags inward between the longitudinals.
  for (let y = 0; y < HULL_ROWS; y++) {
    const f = (y % panelH) / panelH;
    const v = 128 - 26 * Math.sin(Math.PI * f);
    h.fillStyle = `rgb(${v},${v},${v})`; h.fillRect(0, y, W, 1);
  }
  // Longitudinal seams.
  for (let k = 0; k <= SIDES; k++) {
    const y = k * panelH;
    const isBlack = y > yBlack0 + 1 && y < yBlack1 - 1;
    a.fillStyle = isBlack ? 'rgba(90,92,96,0.35)' : 'rgba(70,72,72,0.45)';
    a.fillRect(0, y - 1, W, 2);
    h.fillStyle = '#d0d0d0'; h.fillRect(0, y - 1.5, W, 3);
  }
  // Ring frames (main: ridges; intermediate: fainter).
  for (const zr of RINGS) {
    for (const [z, main] of [[zr, true], [zr + 5, false]] as const) {
      if (z >= 97) continue;
      const x = (z - Z0) * pxU;
      a.fillStyle = main ? 'rgba(60,62,62,0.45)' : 'rgba(60,62,62,0.25)';
      a.fillRect(x - 1, 0, main ? 3 : 2, HULL_ROWS);
      h.fillStyle = main ? '#e8e8e8' : '#b8b8b8'; h.fillRect(x - (main ? 2 : 1), 0, main ? 4 : 2, HULL_ROWS);
      h.fillStyle = main ? '#606060' : '#707070'; h.fillRect(x - (main ? 4 : 2), 0, 2, HULL_ROWS); h.fillRect(x + (main ? 2 : 1), 0, 2, HULL_ROWS);
    }
  }
  // Streaks of grime and exhaust along the airflow; lighter dope wear on the black.
  for (let i = 0; i < 90; i++) {
    const y = r() * HULL_ROWS, x = r() * W, len = 60 + r() * 400;
    const isBlack = y > yBlack0 && y < yBlack1;
    const gr = a.createLinearGradient(x, 0, x + len, 0);
    const col = isBlack ? '120,122,126' : '60,58,52';
    gr.addColorStop(0, `rgba(${col},0)`); gr.addColorStop(0.2, `rgba(${col},${isBlack ? 0.08 : 0.07})`); gr.addColorStop(1, `rgba(${col},0)`);
    a.fillStyle = gr; a.fillRect(x, y, len, 2 + r() * 5);
  }
  // Soot behind the engine cars, on the belly.
  for (const [z, th] of [[-45, 180], [6, 180 - 50], [6, 180 + 50], [44, 180]] as const) {
    const x = (z - Z0) * pxU, y = (th / 360) * HULL_ROWS;
    const gr = a.createLinearGradient(x, 0, x + 380, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = gr; a.fillRect(x, y - 14, 380, 28);
  }
  // The number on the bow, both flanks (see the reading-direction note).
  const label = 'L 59';
  const tx = ((-70) - Z0) * pxU;
  for (const [th, sx, sy] of [[103, -1, 1], [257, 1, -1]] as const) {
    const y = (th / 360) * HULL_ROWS;
    a.save();
    a.translate(tx, y);
    // Starboard reads bow-ward (−u) so it is mirrored in u; port runs
    // against v so it is flipped in v.
    a.scale(sx, sy * 1.02);
    a.font = 'bold 84px Arial, Helvetica, sans-serif';
    a.textAlign = 'center';
    a.textBaseline = 'middle';
    a.fillStyle = 'rgba(214,212,204,0.94)';
    a.fillText(label, 0, 0);
    a.restore();
  }
  // Fins region: four slots (upper, lower, horizontal top faces, bottom faces).
  const slotW = W / 4;
  for (let s = 0; s < 4; s++) {
    const x0 = s * slotW;
    const dark = s === 1 || s === 3;
    const base = dark ? black : silver;
    a.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    a.fillRect(x0, FIN_Y0 - 8, slotW, FIN_H + 16);
    // Rib tapes across the chord.
    for (let k = 1; k < 12; k++) {
      const x = x0 + (k / 12) * slotW * 0.78;
      a.fillStyle = dark ? 'rgba(90,92,96,0.35)' : 'rgba(60,62,62,0.4)';
      a.fillRect(x - 1, FIN_Y0, 2, FIN_H);
      h.fillStyle = '#d8d8d8'; h.fillRect(x - 1.5, FIN_Y0, 3, FIN_H);
    }
    // Control-surface hinge line and its own panelling.
    a.fillStyle = 'rgba(0,0,0,0.5)'; a.fillRect(x0 + slotW * 0.8 - 2, FIN_Y0, 3, FIN_H);
    for (let k = 1; k < 4; k++) a.fillRect(x0 + slotW * (0.8 + k * 0.05), FIN_Y0, 1.5, FIN_H);
    // Iron cross on a white square.
    // The slot is stretched ~1.6× along the chord, so draw the square narrower.
    const cx = x0 + slotW * 0.56, cy = FIN_Y0 + FIN_H * 0.52, sz = FIN_H * 0.36;
    a.save(); a.translate(cx, cy); a.scale(FIN_ASPECT, 1);
    a.fillStyle = '#e4e2da'; a.fillRect(-sz * 1.12, -sz * 1.12, sz * 2.24, sz * 2.24);
    crossPath(a, 0, 0, sz); a.fillStyle = '#111111'; a.fill();
    a.restore();
  }
  // Roughness (G) / metalness (B): aluminium dope is half-metallic, black dope is not.
  const ox = (px: number) => px / 2;
  o.fillStyle = 'rgb(255,107,140)'; o.fillRect(0, 0, W / 2, H / 2);
  o.fillStyle = 'rgb(255,184,20)'; o.fillRect(0, ox(yBlack0), W / 2, ox(yBlack1 - yBlack0));
  for (let s = 0; s < 4; s++) {
    if (s === 1 || s === 3) { o.fillStyle = 'rgb(255,184,20)'; o.fillRect(ox(s * slotW), ox(FIN_Y0 - 8), ox(slotW), ox(FIN_H + 16)); }
    const cx = s * slotW + slotW * 0.56, cy = FIN_Y0 + FIN_H * 0.52, sz = FIN_H * 0.36;
    o.fillStyle = 'rgb(255,150,0)'; o.fillRect(ox(cx - sz * 1.12 * FIN_ASPECT), ox(cy - sz * 1.12), ox(sz * 2.24 * FIN_ASPECT), ox(sz * 2.24));
  }

  // Fine grain.
  const img = a.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const k = 1 + (r() - 0.5) * 0.035;
    img.data[i] *= k; img.data[i + 1] *= k; img.data[i + 2] *= k;
  }
  a.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace; map.flipY = false; map.anisotropy = 8;
  const orm = new THREE.CanvasTexture(oc);
  orm.flipY = false;
  return { map, normalMap: heightToNormal(h, W, H, 2.6), orm };
}

/* --------------------------------------------------------------- geometry */

function zSamples(): number[] {
  const out: number[] = [];
  for (let z = Z0; z < -83; z += 0.9) out.push(z);
  for (let z = -83; z <= 17; z += 5) out.push(z);
  for (let z = 19.5; z < 97.5; z += 2.5) out.push(z);
  out.push(97.4, 98);
  return out;
}

/** Hull skin: one strip per facet, 2 subdivisions across for the panel sag. */
function hullStrips(zs: number[]): THREE.BufferGeometry {
  const strips: THREE.BufferGeometry[] = [];
  for (let k = 0; k < SIDES; k++) {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const th0 = (k / SIDES) * Math.PI * 2, th1 = ((k + 1) / SIDES) * Math.PI * 2;
    for (let i = 0; i < zs.length; i++) {
      const z = zs[i], rr = hullRadius(z);
      for (let j = 0; j <= 2; j++) {
        const f = j / 2;
        const th = th0 + (th1 - th0) * f;
        // Chord between the two longitudinals, pulled in a touch at mid-panel.
        const ax = Math.sin(th0) * rr, ay = Math.cos(th0) * rr;
        const bx = Math.sin(th1) * rr, by = Math.cos(th1) * rr;
        let x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
        if (j === 1) { const s = 1 - Math.min(0.012, 0.06 / Math.max(rr, 1)); x *= s; y *= s; }
        pos.push(x, y, z);
        uv.push((z - Z0) / LEN, (th / (Math.PI * 2)) * V_HULL);
      }
    }
    for (let i = 0; i < zs.length - 1; i++) {
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j, b = a + 1, c = a + 3, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    strips.push(g);
  }
  return mergeGeometries(strips, false)!;
}

interface FinDef { phi: number; slot: number; slot2: number }

/** Cruciform fins (thick, cambered planform) plus rudders / elevators. */
function finGeometry(): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const fins: FinDef[] = [
    { phi: 0, slot: 0, slot2: 0 },
    { phi: Math.PI, slot: 1, slot2: 1 },
    { phi: Math.PI / 2, slot: 2, slot2: 3 },
    { phi: -Math.PI / 2, slot: 2, slot2: 3 },
  ];
  const zA = 66, zB = 91.2, span = 7.2;
  const mk = (
    f: FinDef, z0: number, z1: number, hIn: (z: number) => number, hOut: (z: number) => number,
    thick: (t: number) => number, u0: number, u1: number,
  ): THREE.BufferGeometry => {
    // Build a closed slab: grid over (chord, span) for both faces, then edges.
    const nz = 10, nh = 4;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    const dir = V(Math.sin(f.phi), Math.cos(f.phi), 0);
    const perp = V(-Math.cos(f.phi), Math.sin(f.phi), 0);
    const verts = (side: number) => {
      const base = pos.length / 3;
      for (let i = 0; i <= nz; i++) {
        const z = z0 + ((z1 - z0) * i) / nz;
        const a = hIn(z), b = hOut(z);
        for (let j = 0; j <= nh; j++) {
          const t = j / nh;
          const hh = a + (b - a) * t;
          // Airfoil-ish thickness: fat at the root, thin at tip and edges.
          const ct = (z - z0) / (z1 - z0);
          const th = thick(t) * Math.sin(Math.PI * Math.min(1, Math.max(0, 0.05 + ct * 0.9))) ** 0.5;
          const p = dir.clone().multiplyScalar(hh).addScaledVector(perp, side * th);
          pos.push(p.x, p.y, z);
          const slot = side > 0 || f.slot2 === f.slot ? f.slot : f.slot2;
          uv.push((slot + u0 + (u1 - u0) * ct) / 4, (FIN_Y0 + FIN_H * (1 - t)) / TEX_H);
        }
      }
      for (let i = 0; i < nz; i++) for (let j = 0; j < nh; j++) {
        const a = base + i * (nh + 1) + j, b = a + 1, c = a + nh + 1, d = c + 1;
        if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
      }
      return base;
    };
    const s0 = verts(1), s1 = verts(-1);
    // Close the outer (tip) edge and the trailing / leading edges.
    for (let i = 0; i < nz; i++) {
      const a = s0 + i * (nh + 1) + nh, b = s0 + (i + 1) * (nh + 1) + nh;
      const c = s1 + i * (nh + 1) + nh, d = s1 + (i + 1) * (nh + 1) + nh;
      idx.push(a, b, c, c, b, d);
    }
    for (const i of [0, nz]) for (let j = 0; j < nh; j++) {
      const a = s0 + i * (nh + 1) + j, b = a + 1, c = s1 + i * (nh + 1) + j, d = c + 1;
      if (i === 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  for (const f of fins) {
    // Fixed fin: swept leading edge, straight trailing edge at the hinge.
    out.push(mk(f, zA, zB, (z) => hullRadius(z) * 0.92, (z) => {
      const t = (z - zA) / (zB - zA);
      return hullRadius(z) + span * Math.min(1, 0.25 + 1.2 * t);
    }, (t) => 0.55 - 0.35 * t, 0.02, 0.78));
    // Rudder / elevator behind it, hinged on the fin's trailing edge.
    out.push(mk(f, zB + 0.25, 96.8, (z) => hullRadius(z) + 0.4, (z) => hullRadius(zB) + span - (z - zB) * 0.4, (t) => 0.22 - 0.1 * t, 0.8, 0.99));
  }
  return out;
}

/* --------------------------------------------------------------- material */

const SKIN_FRAG = /* glsl */ `
#include <map_fragment>
float zn = gmNoise(vBPos * 0.07) * 0.7 + gmNoise(vBPos * 0.3) * 0.3;
float ze = vBPos.z - uFront + (zn - 0.5) * 18.0;
if (ze > 0.0) {
  // Burnt through; a few charred tatters hang on just behind the front.
  if (ze > 7.0 || gmNoise(vBPos * 0.45 + 11.0) < 0.64) discard;
}
float zChar = smoothstep(-16.0, 0.0, ze);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.025, 0.02), zChar);
if (!gl_FrontFacing) diffuseColor.rgb *= 0.3;
float zRim = smoothstep(-5.0, 0.0, ze) * (1.0 - smoothstep(0.0, 7.0, ze) * 0.6);
`;

const SKIN_EMIT = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.0, 0.36, 0.07) * zRim * 8.0 * (0.75 + 0.25 * gmNoise(vBPos * 0.6 + uFront)) * uGlow;
`;

function skinMaterial(tex: ReturnType<typeof paintHull>, burning: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map, normalMap: tex.normalMap, roughnessMap: tex.orm, metalnessMap: tex.orm,
    roughness: 1, metalness: 1, side: burning ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (burning) {
    mat.userData.uFront = { value: 200 };
    mat.userData.uGlow = { value: 1 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFront = mat.userData.uFront;
      sh.uniforms.uGlow = mat.userData.uGlow;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uFront;\nuniform float uGlow;\nvarying vec3 vBPos;\n${NOISE_GLSL}`)
        .replace('#include <map_fragment>', SKIN_FRAG)
        .replace('#include <emissivemap_fragment>', SKIN_EMIT);
    };
    mat.customProgramCacheKey = () => 'gm-zep-skin-burn';
  }
  return mat;
}

function skeletonMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a3430, roughness: 0.6, metalness: 0.55 });
  mat.userData.uFront = { value: 200 };
  mat.userData.uHeat = { value: 1 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFront = mat.userData.uFront;
    sh.uniforms.uHeat = mat.userData.uHeat;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uFront;\nuniform float uHeat;\nvarying vec3 vBPos;\n${NOISE_GLSL}`)
      .replace('#include <emissivemap_fragment>', /* glsl */ `
#include <emissivemap_fragment>
{
  // Girders glow white-hot at the front and cool to dull red behind it.
  float d = vBPos.z - uFront;
  float n = gmNoise(vBPos * 0.5);
  float g = d > -2.0 ? exp(-max(d, 0.0) / 22.0) * smoothstep(-2.0, 1.0, d) : 0.0;
  vec3 hot = mix(vec3(0.9, 0.16, 0.03), vec3(1.0, 0.62, 0.3), exp(-max(d, 0.0) / 6.0));
  totalEmissiveRadiance += hot * g * (3.0 + 5.0 * n) * uHeat;
  diffuseColor.rgb *= 1.0 - 0.55 * smoothstep(0.0, 30.0, d);
}`);
  };
  mat.customProgramCacheKey = () => 'gm-zep-skel';
  return mat;
}

/* ------------------------------------------------------------- structures */

function skeleton(front: boolean): THREE.BufferGeometry {
  const p = new Parts(front ? 931 : 932);
  const o = { color: 0xffffff, tile: TILE.PAINT, rough: 0.6 };
  const keep = (z: number): boolean => (front ? z <= Z_BREAK : z >= Z_BREAK);
  const poly = (z: number, rr: number): Vec3[] => {
    const pts: Vec3[] = [];
    for (let k = 0; k < SIDES; k++) {
      const th = (k / SIDES) * Math.PI * 2;
      pts.push(V(Math.sin(th) * rr, Math.cos(th) * rr, z));
    }
    return pts;
  };
  for (const z of RINGS) {
    if (!keep(z)) continue;
    const rr = hullRadius(z);
    const outer = poly(z, rr * 0.975), inner = poly(z, rr * 0.9);
    for (let k = 0; k < SIDES; k++) {
      const k1 = (k + 1) % SIDES;
      p.beam(outer[k], outer[k1], 0.5, o, 0.4);
      p.beam(inner[k], inner[k1], 0.35, o, 0.3);
      const mid = inner[k].clone().lerp(inner[k1], 0.5);
      p.beam(outer[k], mid, 0.18, o);
      p.beam(mid, outer[k1], 0.18, o);
    }
    // Radial bracing wires, a spider web to the axis.
    for (let k = 0; k < SIDES; k += 3) p.beam(inner[k], V(0, 0, z), 0.07, o);
  }
  for (const zr of RINGS) {
    const z = zr + 5;
    if (!keep(z) || z > 95) continue;
    const pts = poly(z, hullRadius(z) * 0.975);
    for (let k = 0; k < SIDES; k++) p.beam(pts[k], pts[(k + 1) % SIDES], 0.3, o, 0.25);
  }
  // Longitudinals between successive ring stations.
  const st = [-94, ...RINGS.flatMap((z) => [z, z + 5]).filter((z) => z < 96), 96].filter(keep);
  for (let i = 0; i < st.length - 1; i++) {
    const a = poly(st[i], hullRadius(st[i]) * 0.975), b = poly(st[i + 1], hullRadius(st[i + 1]) * 0.975);
    for (let k = 0; k < SIDES; k++) p.beam(a[k], b[k], 0.36, o);
    // Diagonal wire bracing on alternate panels.
    for (let k = 0; k < SIDES; k += 2) p.beam(a[k], b[(k + 1) % SIDES], 0.06, o);
  }
  // Triangular keel corridor along the belly.
  for (let i = 0; i < st.length - 1; i++) {
    const z0 = st[i], z1 = st[i + 1];
    if (z0 < -86 || z1 > 76) continue;
    const y0 = -hullRadius(z0) * 0.975 + 2.6, y1 = -hullRadius(z1) * 0.975 + 2.6;
    for (const sx of [-1.5, 1.5]) p.beam(V(sx, y0, z0), V(sx, y1, z1), 0.3, o);
    p.beam(V(-1.5, y0, z0), V(1.5, y0, z0), 0.2, o);
    p.beam(V(-1.5, y0, z0), V(0, -hullRadius(z0) * 0.975, z0), 0.2, o);
    p.beam(V(1.5, y0, z0), V(0, -hullRadius(z0) * 0.975, z0), 0.2, o);
  }
  if (!front) {
    // Fin spars.
    for (const phi of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
      const dir = V(Math.sin(phi), Math.cos(phi), 0);
      for (const z of [70, 78, 86, 91]) {
        const a = dir.clone().multiplyScalar(hullRadius(z)).setZ(z);
        const b = dir.clone().multiplyScalar(hullRadius(z) + 7.0 * Math.min(1, 0.25 + 1.2 * (z - 66) / 25.2)).setZ(z);
        p.beam(a, b, 0.25, o);
      }
      const tip0 = dir.clone().multiplyScalar(hullRadius(72) + 7.0 * 0.53).setZ(72);
      const tip1 = dir.clone().multiplyScalar(hullRadius(91) + 7.0).setZ(91);
      p.beam(tip0, tip1, 0.25, o);
    }
  }
  return p.merge();
}

const podTaper = (z: number): number => (z > 0 ? 1 - 0.55 * z * z : 1 - 0.1 * z * z);

/** Half-width of a pod's skin at local (z, y), so fittings sit on the surface. */
function podX(zl: number, yl: number, len: number, w: number, hgt: number): number {
  const zn = (2 * zl) / len;
  const tp = podTaper(zn);
  const yn = Math.pow(Math.min(0.99, Math.abs(yl) / (tp * hgt * 0.5)), 1 / 0.8);
  const rho = Math.sqrt(Math.max(0, 1 - zn * zn - yn * yn));
  return Math.pow(rho, 0.75) * tp * w * 0.5;
}

/** A streamlined gondola body. Length along Z, centred on (0,0,0). */
function podGeometry(len: number, w: number, hgt: number, seg: number): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.6));
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i);
    const z = pos.getZ(i);
    // Blunt nose, long tapering tail, flat roof where it hangs from the struts.
    const taper = podTaper(z);
    x = Math.sign(x) * Math.pow(Math.abs(x), 0.75) * taper;
    y = Math.sign(y) * Math.pow(Math.abs(y), 0.8) * taper;
    pos.setXYZ(i, x * w * 0.5, Math.min(y, 0.82) * hgt * 0.5, z * len * 0.5);
  }
  g.computeVertexNormals();
  return g;
}

function propGeometry(): THREE.BufferGeometry {
  const p = new Parts(951);
  const wood = { color: 0x3a2818, tile: TILE.BOARDS, scale: 1.2, rough: 0.45 };
  for (const s of [-1, 1]) {
    // Two-bladed wooden propeller, pitched and tapering to rounded tips.
    const blade = new THREE.BoxGeometry(0.42, 2.5, 0.12, 1, 6, 1);
    const pos = blade.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 2.5 + 0.5;
      pos.setX(i, pos.getX(i) * (1.0 - 0.5 * y) * (0.7 + 1.2 * y * (1 - y)));
    }
    blade.computeVertexNormals();
    p.add(blade, M(0, s * 1.4, 0, 0, s * 0.35, 0), wood);
    p.box(0.3, 0.2, 0.13, M(0, s * 2.62, 0, 0, s * 0.35, 0), PAINT(COL.brass, 0.35, 0.8));
  }
  p.cyl(0.2, 0.2, 0.5, 10, M(0, 0, 0, Math.PI / 2), PAINT(COL.steel, 0.5, 0.6));
  return p.merge();
}

interface ZepTemplate {
  tex: ReturnType<typeof paintHull>;
  skinF: THREE.BufferGeometry;
  skinR: THREE.BufferGeometry;
  skelF: THREE.BufferGeometry;
  skelR: THREE.BufferGeometry;
  detF: THREE.BufferGeometry;
  detR: THREE.BufferGeometry;
  prop: THREE.BufferGeometry;
  props: Vec3[];
  gondolas: Vec3[];
  guns: Vec3[];
  hit: HitSphere[];
}

let tpl: ZepTemplate | null = null;

/** Split an indexed geometry by triangle centroid z. */
function splitZ(g: THREE.BufferGeometry, zb: number): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const idx = g.index!;
  const f: number[] = [], r: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    (z < zb ? f : r).push(a, b, c);
  }
  const gf = g.clone(); gf.setIndex(f);
  const gr = g.clone(); gr.setIndex(r);
  return [gf, gr];
}

function zeppelinTemplate(): ZepTemplate {
  if (tpl) return tpl;
  const tex = paintHull();
  const hull = mergeGeometries([hullStrips(zSamples()), ...finGeometry()], false)!;
  const [skinF, skinR] = splitZ(hull, Z_BREAK);

  const dF = new Parts(961), dR = new Parts(962);
  const car = { color: 0x232426, tile: TILE.RIVET, scale: 1.6, rough: 0.55, metal: 0.35 };
  const carTop = { color: 0x8a8d8c, tile: TILE.RIVET, scale: 1.6, rough: 0.45, metal: 0.6 };
  const strut = PAINT(0x2a2b2c, 0.5, 0.5);
  const glass = { color: 0xb8bdb8, tile: TILE.WINDOW, uv: 'decal' as const, rough: 0.2, metal: 0.3 };
  const props: Vec3[] = [];
  const hang = (P: Parts, roofY: number, z0: number, z1: number, spread: number): void => {
    // Struts and bracing cables from the car roof up to the keel.
    for (const z of [z0, z1]) {
      for (const sx of [-1, 1]) {
        const bx = sx * spread * 1.1;
        const a = V(sx * spread * 0.5, roofY, z);
        const b = V(bx, -Math.sqrt(Math.max(0, hullRadius(z) ** 2 - bx * bx)) * 0.985, z + (z === z0 ? -1.5 : 1.5));
        P.rod(a, b, 0.09, strut, 5);
      }
    }
    const zm = (z0 + z1) / 2;
    P.rod(V(0, roofY, zm), V(0, -hullRadius(zm) * 0.985, zm - 3), 0.03, strut, 3);
  };

  // Forward control car: control room with its window band, engine aft, pusher.
  {
    const zc = -56, len = 20, y = -hullRadius(zc) - 2.9;
    dF.add(podGeometry(len, 2.8, 3.1, 20), M(0, y, zc), car);
    dF.box(2.0, 0.08, len * 0.7, M(0, y + 1.28, zc - 1), carTop);
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 6; k++) {
        const zl = -8.0 + k * 1.3;
        const x0 = podX(zl - 0.6, 0.35, len, 2.8, 3.1), x1 = podX(zl + 0.6, 0.35, len, 2.8, 3.1);
        const yaw = sx * (Math.PI / 2 - Math.atan2(x1 - x0, 1.2));
        dF.add(new THREE.PlaneGeometry(1.15, 0.9), M(sx * ((x0 + x1) / 2 + 0.03), y + 0.35, zc + zl, 0, yaw), glass);
      }
      dF.add(new THREE.PlaneGeometry(1.4, 0.9), M(sx * (podX(4.2, -0.2, len, 2.8, 3.1) + 0.03), y - 0.2, zc + 4.2, 0, sx * Math.PI / 2), { color: 0xa09878, tile: TILE.RADIATOR, uv: 'decal', rough: 0.5, metal: 0.5 });
    }
    hang(dF, y + 1.27, zc - 6, zc + 5, 1.6);
    props.push(V(0, y - 0.1, zc + len / 2 + 0.35));
    soldier(dF, M(0.4, y - 0.85, zc - 8.0, 0, 0.3), 'central', 'upper', true);
  }
  // Two wing cars amidships.
  for (const sx of [-1, 1]) {
    const zc = 2, len = 8, th = Math.PI - 0.88;
    const hx = Math.sin(th) * R, hy = Math.cos(th) * R;
    const cx = sx * (hx + 1.3), cy = hy - 3.4;
    const P = zc < Z_BREAK ? dF : dR;
    P.add(podGeometry(len, 2.2, 2.4, 16), M(cx, cy, zc), car);
    P.add(new THREE.PlaneGeometry(1.1, 0.7), M(cx + sx * (podX(-1.2, 0.1, len, 2.2, 2.4) + 0.03), cy + 0.1, zc - 1.2, 0, sx * Math.PI / 2), { color: 0xa09878, tile: TILE.RADIATOR, uv: 'decal', rough: 0.5, metal: 0.5 });
    P.rod(V(cx, cy + 1.0, zc - 2.5), V(sx * hx * 0.95, hy * 0.95, zc - 3.5), 0.09, strut, 5);
    P.rod(V(cx, cy + 1.0, zc + 2.2), V(sx * hx * 0.95, hy * 0.95, zc + 3.2), 0.09, strut, 5);
    P.rod(V(cx - sx * 0.8, cy + 0.8, zc), V(sx * (hx - 3.5), -Math.sqrt(R * R - (hx - 3.5) ** 2) * 0.98, zc), 0.08, strut, 5);
    props.push(V(cx, cy - 0.05, zc + len / 2 + 0.3));
  }
  // Aft engine car: three engines, a pusher and two outrigger propellers.
  {
    const zc = 37, len = 14, y = -hullRadius(zc) - 2.7;
    dR.add(podGeometry(len, 2.7, 2.9, 18), M(0, y, zc), car);
    dR.box(1.9, 0.08, len * 0.7, M(0, y + 1.18, zc), carTop);
    for (const sx of [-1, 1]) {
      dR.add(new THREE.PlaneGeometry(1.6, 0.8), M(sx * (podX(-3, 0.05, len, 2.7, 2.9) + 0.03), y + 0.05, zc - 3, 0, sx * Math.PI / 2), { color: 0xa09878, tile: TILE.RADIATOR, uv: 'decal', rough: 0.5, metal: 0.5 });
      // Outrigger shafts and brackets for the side propellers.
      const pz = zc + 2.2, px = sx * 4.6;
      dR.rod(V(sx * 1.1, y - 0.1, pz), V(px, y - 0.1, pz), 0.07, strut, 5);
      dR.rod(V(sx * 1.2, y + 1.0, pz - 1.5), V(px, y - 0.1, pz - 0.2), 0.05, strut, 4);
      dR.rod(V(sx * 1.2, y - 0.9, pz - 1.0), V(px, y - 0.1, pz - 0.2), 0.05, strut, 4);
      dR.cyl(0.18, 0.18, 0.7, 8, M(px, y - 0.1, pz - 0.1, Math.PI / 2), strut);
      props.push(V(px, y - 0.1, pz + 0.35));
    }
    hang(dR, y + 1.18, zc - 4, zc + 4, 1.5);
    props.push(V(0, y - 0.05, zc + len / 2 + 0.35));
  }
  // Gun platform on the back, near the bow: rail, two MGs, gunners.
  const guns: Vec3[] = [];
  {
    const z = -78, top = hullRadius(z) + 0.15;
    dF.box(3.0, 0.1, 3.4, M(0, top, z), PAINT(0x55575a, 0.6, 0.4));
    for (const sx of [-1, 1]) dF.box(0.05, 0.05, 3.4, M(sx * 1.45, top + 0.8, z), strut);
    for (const sx of [-1, 1]) for (const dz of [-1.6, 0, 1.6]) dF.rod(V(sx * 1.45, top, z + dz), V(sx * 1.45, top + 0.8, z + dz), 0.03, strut, 4);
    for (const sx of [-0.8, 0.8]) {
      dF.rod(V(sx, top, z - 0.8), V(sx, top + 1.1, z - 0.8), 0.05, strut, 5);
      dF.rod(V(sx, top + 1.15, z - 0.4), V(sx, top + 1.25, z - 1.9), 0.055, PAINT(COL.gunmetal, 0.4, 0.6), 6);
      soldier(dF, M(sx, top - 0.85, z + 0.2), 'central', 'upper', true);
    }
    soldier(dF, M(0, top + 0.05, z + 1.2, 0, Math.PI), 'central', 'binoc', true);
    guns.push(V(0, top + 1.2, z));
  }
  {
    const z = 89.5, top = hullRadius(z) + 0.1;
    dR.box(1.6, 0.08, 2.0, M(0, top, z), PAINT(0x55575a, 0.6, 0.4));
    dR.rod(V(0, top + 1.1, z + 0.3), V(0, top + 1.2, z + 1.8), 0.05, PAINT(COL.gunmetal, 0.4, 0.6), 6);
    dR.rod(V(0, top, z + 0.3), V(0, top + 1.1, z + 0.3), 0.05, strut, 5);
    soldier(dR, M(0, top - 0.85, z - 0.5, 0, Math.PI), 'central', 'upper', true);
    guns.push(V(0, top + 1.2, z));
  }
  guns.push(V(0, -hullRadius(-56) - 1.8, -60), V(0, -hullRadius(37) - 1.6, 33));
  // Mooring lines coiled under the bow and the radio aerial trailing aft.
  dF.rod(V(0, -hullRadius(-90) * 0.95, -90), V(0, -hullRadius(-90) - 3.2, -88.5), 0.04, strut, 3);

  const gondolas = [
    V(0, -hullRadius(-56) - 2.9, -49),
    V(-(Math.sin(Math.PI - 0.88) * R + 1.3), Math.cos(Math.PI - 0.88) * R - 3.4, 3),
    V(Math.sin(Math.PI - 0.88) * R + 1.3, Math.cos(Math.PI - 0.88) * R - 3.4, 3),
    V(0, -hullRadius(37) - 2.7, 39),
  ];

  const hit: HitSphere[] = [];
  for (let z = -92; z <= 92; z += 11.5) hit.push({ o: V(0, 0, z), r: Math.max(3.5, hullRadius(z) + 1.2) });
  for (const phi of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
    hit.push({ o: V(Math.sin(phi) * 8, Math.cos(phi) * 8, 84), r: 6 });
  }
  for (const g of gondolas) hit.push({ o: g.clone(), r: 4.5 });

  tpl = {
    tex, skinF, skinR,
    skelF: skeleton(true), skelR: skeleton(false),
    detF: dF.merge(), detR: dR.merge(),
    prop: propGeometry(), props, gondolas, guns, hit,
  };
  return tpl;
}

/* ------------------------------------------------------------------- rig */

export function buildZeppelinRig(): ModelRig & { gondolas: THREE.Vector3[]; gunPositions: THREE.Vector3[]; length: number } {
  const t = zeppelinTemplate();
  const opaque = uberMaterial('opaque');
  const intact = skinMaterial(t.tex, false);
  let burn: THREE.MeshStandardMaterial | null = null;
  const skelMat = skeletonMaterial();

  const root = new THREE.Group();
  root.name = 'zeppelin';
  const halves = [new THREE.Group(), new THREE.Group()];
  const inner = [new THREE.Group(), new THREE.Group()];
  const skins: THREE.Mesh[] = [];
  const skels: THREE.Mesh[] = [];
  const propMeshes: THREE.Mesh[] = [];
  for (let i = 0; i < 2; i++) {
    halves[i].position.z = Z_BREAK;
    inner[i].position.z = -Z_BREAK;
    halves[i].add(inner[i]);
    root.add(halves[i]);
    const skin = new THREE.Mesh(i === 0 ? t.skinF : t.skinR, intact);
    skin.castShadow = true; skin.receiveShadow = true;
    skins.push(skin);
    const skel = new THREE.Mesh(i === 0 ? t.skelF : t.skelR, skelMat);
    skel.visible = false;
    skels.push(skel);
    const det = new THREE.Mesh(i === 0 ? t.detF : t.detR, opaque);
    det.castShadow = true; det.receiveShadow = true;
    inner[i].add(skin, skel, det);
  }
  for (const p of t.props) {
    const m = new THREE.Mesh(t.prop, opaque);
    m.position.copy(p);
    m.rotation.z = Math.random() * Math.PI;
    m.castShadow = true;
    inner[p.z < Z_BREAK ? 0 : 1].add(m);
    propMeshes.push(m);
  }

  let dead = false;
  return {
    root,
    hitSpheres: t.hit.map((h) => ({ o: h.o.clone(), r: h.r })),
    height: 30,
    radius: LEN / 2 + 2,
    length: LEN,
    gondolas: t.gondolas.map((g) => g.clone()),
    gunPositions: t.guns.map((g) => g.clone()),
    setDestroyed(tt: number): void {
      if (tt <= 0) {
        if (dead) {
          dead = false;
          for (const s of skins) { s.material = intact; s.visible = true; s.castShadow = true; }
          for (const s of skels) s.visible = false;
          halves[0].rotation.x = halves[1].rotation.x = 0;
        }
        return;
      }
      dead = true;
      burn ??= skinMaterial(t.tex, true);
      const p = Math.min(1, tt / 8.5);
      const front = 104 - 214 * Math.pow(p, 0.85);
      burn.userData.uFront.value = front;
      burn.userData.uGlow.value = 1 - THREE.MathUtils.smoothstep(tt, 8, 10);
      skelMat.userData.uFront.value = front;
      skelMat.userData.uHeat.value = tt < 8 ? 1 : Math.exp(-(tt - 8) / 9);
      for (const s of skins) { s.material = burn; s.castShadow = false; s.visible = tt < 10; }
      for (const s of skels) s.visible = true;
      // The back breaks once the fire has eaten into the middle.
      const a = 0.42 * THREE.MathUtils.smoothstep(tt, 2.6, 9.5);
      halves[0].rotation.x = a;
      halves[1].rotation.x = -a;
    },
    animate(dt: number): void {
      const spin = dead ? 3 : 24;
      for (const m of propMeshes) m.rotation.z += dt * spin;
    },
    dispose(): void {
      intact.dispose();
      burn?.dispose();
      skelMat.dispose();
      root.removeFromParent();
    },
  };
}
