import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { M, Parts, V, rng, type HitSphere, type Vec3 } from './util';
import { NOISE_GLSL, TILE, crossPath, uberMaterial } from './atlas';
import { soldier, type Side } from './figures';
import { ROPE, COL, PAINT } from './blocks';
import type { ModelRig } from '../GroundModels';

/**
 * Observation kite balloons.
 *
 * Allied: the French Caquot type M — a streamlined teardrop, 28 m long and
 * 8.8 m across, with three inflated tail lobes set 120° apart (one hanging
 * below, two canted up in a Y). Central: the Parseval-Siegsfeld "Drachen",
 * the German sausage, flown nose-high with its curled rudder bag under the
 * tail and a tail line of drogue cups. The two silhouettes are the most
 * recognisable shapes of the front line, and telling friend from foe at
 * 2 km is exactly what the player needs.
 *
 * The envelope carries its own 2048×1024 painted texture (gores, panel
 * seams, the suspension band with its toggles, weathering, national marking)
 * and a burn shader: on destruction a front of char runs out from the
 * ignition point, glowing at its edge, while the vertex shader shrinks and
 * crumples the fabric towards the axis and lets it droop; burnt-through
 * fabric is discarded so the envelope comes apart into tatters.
 */

const TEX_W = 2048;
const TEX_H = 1024;
/** Envelope occupies u ∈ [0, U_ENV]; the rest of the texture is fin/bag fabric. */
const U_ENV = 0.86;

interface BalloonShape {
  /** Radius at s ∈ [0,1] from nose to tail. */
  r(s: number): number;
  length: number;
  /** z of the nose (−Z forward). */
  z0: number;
  gores: number;
  /** Envelope pitch (rad, nose up) — the Drachen flies inclined. */
  pitch: number;
  fabric: string;
  seam: string;
}

const CAQUOT: BalloonShape = {
  r(s) {
    const R = 4.4, s0 = 0.3;
    if (s < s0) { const t = (s0 - s) / s0; return R * Math.sqrt(Math.max(0, 1 - t * t)) ** 0.92; }
    const t = (s - s0) / (1 - s0);
    const body = R * (1 - 0.86 * Math.pow(t, 1.7));
    // Round off the very tail.
    const cap = t > 0.97 ? Math.sqrt(Math.max(0, 1 - ((t - 0.97) / 0.03) ** 2)) : 1;
    return body * cap;
  },
  length: 28,
  z0: -13,
  gores: 16,
  pitch: 0.03,
  fabric: '#b9a57c',
  seam: 'rgba(70,58,38,0.55)',
};

const DRACHEN_R = 3.8;
const DRACHEN: BalloonShape = {
  r(s) {
    const L = 24, z = s * L, R = DRACHEN_R;
    if (z < R) return Math.sqrt(Math.max(0, R * R - (R - z) ** 2));
    if (z > L - R) return Math.sqrt(Math.max(0, R * R - (z - (L - R)) ** 2));
    return R;
  },
  length: 24,
  z0: -12,
  gores: 12,
  pitch: 0.5,
  fabric: '#b0aa8c',
  seam: 'rgba(60,58,44,0.5)',
};

/* ---------------------------------------------------------------- texture */

function paintEnvelope(side: Side, shape: BalloonShape): { map: THREE.CanvasTexture; normalMap: THREE.DataTexture } {
  const r = rng(side === 'allied' ? 501 : 502);
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const a = c.getContext('2d', { willReadFrequently: true })!;
  const hc = document.createElement('canvas');
  hc.width = TEX_W; hc.height = TEX_H;
  const h = hc.getContext('2d', { willReadFrequently: true })!;
  const envW = TEX_W * U_ENV;
  const pxPerM = envW / shape.length;

  a.fillStyle = shape.fabric; a.fillRect(0, 0, TEX_W, TEX_H);
  h.fillStyle = '#808080'; h.fillRect(0, 0, TEX_W, TEX_H);

  // Panels: the fabric was cut in strips; each has its own shade of dope.
  const stripW = pxPerM * 1.15;
  const goreH = TEX_H / shape.gores;
  for (let x = 0; x < TEX_W; x += stripW) {
    for (let g = 0; g < shape.gores; g++) {
      const k = (r() - 0.5) * 0.09;
      a.fillStyle = k > 0 ? `rgba(255,250,235,${k})` : `rgba(40,32,20,${-k})`;
      a.fillRect(x, g * goreH, stripW + 1, goreH + 1);
    }
  }
  // Large-scale weathering: darker belly, rain streaks from the top.
  const belly = a.createLinearGradient(0, 0, 0, TEX_H);
  belly.addColorStop(0, 'rgba(255,250,235,0.06)');
  belly.addColorStop(0.35, 'rgba(0,0,0,0)');
  belly.addColorStop(0.5, 'rgba(40,32,22,0.22)');
  belly.addColorStop(0.65, 'rgba(0,0,0,0)');
  belly.addColorStop(1, 'rgba(255,250,235,0.06)');
  a.fillStyle = belly; a.fillRect(0, 0, TEX_W, TEX_H);
  for (let i = 0; i < 160; i++) {
    const x = r() * envW, y = r() * TEX_H, len = 40 + r() * 200;
    const gr = a.createLinearGradient(x, y, x, y + len);
    gr.addColorStop(0, 'rgba(50,40,25,0.10)'); gr.addColorStop(1, 'rgba(50,40,25,0)');
    a.fillStyle = gr; a.fillRect(x, y, 3 + r() * 10, len);
  }
  for (let i = 0; i < 70; i++) {
    const x = r() * envW, y = r() * TEX_H, rad = 20 + r() * 90;
    const gr = a.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, `rgba(${r() < 0.5 ? '60,48,30' : '255,250,230'},0.08)`); gr.addColorStop(1, 'rgba(0,0,0,0)');
    a.fillStyle = gr; a.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Gore seams (lengthwise) and panel seams (around), raised in the height map.
  a.strokeStyle = shape.seam; a.lineWidth = 2;
  h.strokeStyle = '#b8b8b8'; h.lineWidth = 3;
  for (let g = 0; g <= shape.gores; g++) {
    const y = g * goreH;
    a.beginPath(); a.moveTo(0, y); a.lineTo(TEX_W, y); a.stroke();
    h.beginPath(); h.moveTo(0, y); h.lineTo(TEX_W, y); h.stroke();
  }
  a.lineWidth = 1.5; h.lineWidth = 2;
  for (let x = 0; x < TEX_W; x += stripW) {
    a.beginPath(); a.moveTo(x, 0); a.lineTo(x, TEX_H); a.stroke();
    h.beginPath(); h.moveTo(x, 0); h.lineTo(x, TEX_H); h.stroke();
  }
  // Nose cap: reinforcing patches and the valve ring.
  a.fillStyle = 'rgba(60,50,35,0.35)'; a.fillRect(0, 0, pxPerM * 1.1, TEX_H);
  for (let k = 0; k < 3; k++) {
    a.strokeStyle = 'rgba(50,40,28,0.5)'; a.lineWidth = 3;
    a.beginPath(); a.moveTo(pxPerM * (0.4 + k * 0.35), 0); a.lineTo(pxPerM * (0.4 + k * 0.35), TEX_H); a.stroke();
  }
  // Suspension bands along both lower flanks, with toggles for the rigging.
  for (const th of [180 - 58, 180 + 58]) {
    const y = (th / 360) * TEX_H;
    const x0 = (shape === CAQUOT ? 3.5 : 2.5) * pxPerM, x1 = (shape === CAQUOT ? 19 : 15) * pxPerM;
    a.fillStyle = 'rgba(75,62,42,0.8)'; a.fillRect(x0, y - 5, x1 - x0, 10);
    h.fillStyle = '#d0d0d0'; h.fillRect(x0, y - 5, x1 - x0, 10);
    for (let x = x0; x < x1; x += pxPerM * 0.7) {
      a.fillStyle = 'rgba(40,32,22,0.9)'; a.fillRect(x - 3, y - 12, 6, 24);
      h.fillStyle = '#ffffff'; h.fillRect(x - 3, y - 12, 6, 24);
      // Load-spreading patch fans up from each toggle.
      a.strokeStyle = 'rgba(70,58,40,0.35)'; a.lineWidth = 1.5;
      for (const d of [-1, 0, 1]) {
        a.beginPath(); a.moveTo(x, y); a.lineTo(x + d * 16, y + (th < 180 ? -46 : 46)); a.stroke();
      }
    }
  }
  // Wrinkles: fabric crowding at the tail and round the fin roots.
  for (let i = 0; i < 220; i++) {
    const x = envW * (0.6 + r() * 0.4) - 10, y = r() * TEX_H, len = 20 + r() * 60, ang = (r() - 0.5) * 0.6;
    h.strokeStyle = r() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    h.lineWidth = 2 + r() * 3;
    h.beginPath(); h.moveTo(x, y); h.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); h.stroke();
  }

  // National marking on both flanks near the nose. The texture is stretched
  // around the circumference, so each marking is drawn as the ellipse that
  // maps back to a circle on the envelope.
  const zMark = shape === CAQUOT ? 7.5 : 6.5;
  const sMark = zMark / shape.length;
  const rad = shape.r(sMark);
  const pxPerMv = TEX_H / (2 * Math.PI * rad);
  const dia = shape === CAQUOT ? 3.4 : 3.6;
  for (const th of [90 - 12, 270 + 12]) {
    const cx = sMark * envW, cy = (th / 360) * TEX_H;
    a.save();
    a.translate(cx, cy);
    a.scale((dia / 2) * pxPerM, (dia / 2) * pxPerMv);
    if (side === 'allied') {
      for (const [rr, col] of [[1, '#233f7a'], [0.66, '#e8e4d8'], [0.33, '#b02226']] as const) {
        a.fillStyle = col; a.beginPath(); a.arc(0, 0, rr, 0, Math.PI * 2); a.fill();
      }
    } else {
      a.fillStyle = '#ece8dc'; a.fillRect(-1, -1, 2, 2);
      crossPath(a, 0, 0, 0.86); a.fillStyle = '#141414'; a.fill();
    }
    a.restore();
  }

  // Fin / rudder-bag fabric (u > U_ENV): plain panels with seams.
  a.fillStyle = shape.fabric; a.globalAlpha = 0.6; a.fillRect(envW + 8, 0, TEX_W - envW - 8, TEX_H); a.globalAlpha = 1;
  for (let y = 0; y < TEX_H; y += 48) {
    a.fillStyle = shape.seam; a.fillRect(envW + 8, y, TEX_W - envW - 8, 2);
    h.fillStyle = '#b0b0b0'; h.fillRect(envW + 8, y, TEX_W - envW - 8, 3);
  }

  // Fine fabric grain.
  const img = a.getImageData(0, 0, TEX_W, TEX_H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = 1 + (r() - 0.5) * 0.05;
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
  }
  a.putImageData(img, 0, 0);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.flipY = false;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  return { map, normalMap: heightToNormal(h, TEX_W, TEX_H, 2.2) };
}

export function heightToNormal(h: CanvasRenderingContext2D, W: number, H: number, strength: number): THREE.DataTexture {
  const src = h.getImageData(0, 0, W, H).data;
  const out = new Uint8Array(W * H * 4);
  const at = (x: number, y: number): number => src[(((y + H) % H) * W + Math.min(W - 1, Math.max(0, x))) * 4] / 255;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let nx = -(at(x + 1, y) - at(x - 1, y)) * strength;
      let ny = -(at(x, y + 1) - at(x, y - 1)) * strength;
      const l = Math.hypot(nx, ny, 1);
      nx /= l; ny /= l;
      const i = (y * W + x) * 4;
      out[i] = (nx * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * 0.5 + 0.5) * 255;
      out[i + 2] = (0.5 / l + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/* --------------------------------------------------------------- geometry */

function envelopeGeometry(shape: BalloonShape, nLen: number, nAround: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const w = nAround + 1;
  for (let i = 0; i <= nLen; i++) {
    const t = i / nLen;
    const s = 0.5 - 0.5 * Math.cos(Math.PI * t);
    const z = shape.z0 + s * shape.length;
    const rr = shape.r(s);
    for (let j = 0; j <= nAround; j++) {
      const th = (j / nAround) * Math.PI * 2;
      // Each gore bulges a little between its seams.
      const f = (th / (Math.PI * 2)) * shape.gores;
      const bulge = 1 + 0.014 * Math.sin(Math.PI * (f - Math.floor(f)));
      pos.push(Math.sin(th) * rr * bulge, Math.cos(th) * rr * bulge, z);
      uv.push(s * U_ENV, j / nAround);
    }
  }
  for (let i = 0; i < nLen; i++) {
    for (let j = 0; j < nAround; j++) {
      const a = i * w + j, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Weld the normals across the texture seam so the top line is not visible.
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i <= nLen; i++) {
    const a = i * w, b = i * w + nAround;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Inflated lobe from a deformed sphere: (along, radial, thickness) shaping. */
function lobe(
  seg: number, phi: number, zc: number, halfLen: number,
  radial: (t: number) => [number, number], thick: (t: number, u: number) => number,
): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7));
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dir = V(Math.sin(phi), Math.cos(phi), 0);
  // Chosen so (perp, Z, dir) keeps the sphere's handedness (outward normals).
  const perp = V(-Math.cos(phi), Math.sin(phi), 0);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // Sphere pole axis is Y: use it as the lobe's length axis.
    const t = (y + 1) / 2;
    const [c, a] = radial(t);
    const rad = c + z * a;
    const th = x * thick(t, (z + 1) / 2);
    const p = dir.clone().multiplyScalar(rad).addScaledVector(perp, th);
    pos.setXYZ(i, p.x, p.y, zc + (y * halfLen));
    uv.setXY(i, U_ENV + 0.012 + uv.getX(i) * (1 - U_ENV - 0.02), uv.getY(i));
  }
  g.computeVertexNormals();
  return g;
}

function caquotFins(seg: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const phi of [Math.PI, Math.PI / 3, -Math.PI / 3]) {
    out.push(lobe(seg, phi, 10.3, 5.6,
      (t) => [2.9 + 0.8 * t, 1.9 + 1.2 * Math.pow(t, 0.8)],
      (t, u) => (0.95 - 0.45 * u) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.15)))));
  }
  return out;
}

function drachenBag(seg: number): THREE.BufferGeometry[] {
  // Rudder bag: a fat tube curling under and round the tail end.
  const L = 24, zTail = DRACHEN.z0 + L;
  const cy = 0.4, cz = zTail - 3.2, Rt = 4.6;
  const b0 = -0.9, b1 = 2.35;
  const nb = seg * 2, nr = seg;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let i = 0; i <= nb; i++) {
    const t = i / nb, b = b0 + (b1 - b0) * t;
    const cyl = V(0, cy - Rt * Math.cos(b), cz + Rt * Math.sin(b));
    const radial = V(0, -Math.cos(b), Math.sin(b));
    const tube = 1.55 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.6);
    for (let j = 0; j <= nr; j++) {
      const a = (j / nr) * Math.PI * 2;
      const p = cyl.clone().addScaledVector(radial, Math.cos(a) * tube).add(V(Math.sin(a) * tube * 0.85, 0, 0));
      pos.push(p.x, p.y, p.z);
      uv.push(U_ENV + 0.012 + t * (1 - U_ENV - 0.02), j / nr);
    }
  }
  const w = nr + 1;
  for (let i = 0; i < nb; i++) for (let j = 0; j < nr; j++) {
    const a = i * w + j, bb = a + 1, c = a + w, d = c + 1;
    idx.push(a, bb, c, bb, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Two small stabilising "ears" on the upper flanks.
  const ears = [Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5].map((phi) => lobe(Math.max(8, seg - 4), phi, zTail - 5.5, 2.6,
    (t) => [2.6 + 0.6 * t, 1.4 + 0.4 * t], (_t, u) => 0.5 - 0.25 * u));
  return [g, ...ears];
}

/* --------------------------------------------------------------- material */

const BURN_VERT = /* glsl */ `
#include <begin_vertex>
{
  float bd = distance(position, uIgn);
  float bn = gmNoise(position * 0.3);
  float b = clamp(uBurn * 46.0 - bd - bn * 7.0, 0.0, 10.0) / 10.0;
  vBurn = b;
  if (b > 0.0) {
    vec3 ax = vec3(0.0, 0.0, position.z);
    float cr = gmNoise(position * 0.8 + 3.0);
    transformed = mix(transformed, ax + (transformed - ax) * (0.2 + 0.4 * cr), b * b);
    transformed.y -= b * b * 3.5;
    transformed += normal * (cr - 0.5) * 1.8 * b;
  }
}
`;

const BURN_FRAG = /* glsl */ `
#include <map_fragment>
float bThr = 0.5 + 0.55 * gmNoise(vBPos * 1.1 + 7.0);
if (vBurn > bThr) discard;
float bChar = smoothstep(0.0, 0.32, vBurn);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.02, 0.016), bChar);
float bRim = vBurn > 0.001 ? smoothstep(bThr - 0.16, bThr, vBurn) : 0.0;
`;

const BURN_EMIT = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += vec3(1.0, 0.38, 0.08) * (bRim * 7.0 + bChar * (1.0 - bChar) * 2.5) * uGlow;
`;

function envelopeMaterial(map: THREE.Texture, normalMap: THREE.Texture, burning: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map, normalMap, roughness: 0.62, metalness: 0.0, side: burning ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.normalScale.set(0.9, 0.9);
  if (burning) {
    mat.userData.uBurn = { value: 0 };
    mat.userData.uIgn = { value: new THREE.Vector3() };
    mat.userData.uGlow = { value: 1 };
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uBurn = mat.userData.uBurn;
      sh.uniforms.uIgn = mat.userData.uIgn;
      sh.uniforms.uGlow = mat.userData.uGlow;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\nuniform float uBurn;\nuniform vec3 uIgn;\nvarying float vBurn;\nvarying vec3 vBPos;\n${NOISE_GLSL}`)
        .replace('#include <begin_vertex>', BURN_VERT + '\nvBPos = position;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\nuniform float uGlow;\nvarying float vBurn;\nvarying vec3 vBPos;\n${NOISE_GLSL}`)
        .replace('#include <map_fragment>', BURN_FRAG)
        .replace('#include <emissivemap_fragment>', BURN_EMIT);
    };
    mat.customProgramCacheKey = () => 'gm-balloon-burn';
  }
  return mat;
}

/* ------------------------------------------------------------------- rig */

interface BalloonTemplate {
  shape: BalloonShape;
  env: THREE.BufferGeometry;
  envFar: THREE.BufferGeometry;
  lines: THREE.BufferGeometry;
  basket: THREE.BufferGeometry;
  basketFar: THREE.BufferGeometry;
  map: THREE.Texture;
  normalMap: THREE.Texture;
  intact: THREE.MeshStandardMaterial;
  cableTop: Vec3;
  ring: Vec3;
  basketPos: Vec3;
  hit: HitSphere[];
}

const templates: Partial<Record<Side, BalloonTemplate>> = {};

/** Suspension-band attachment points (envelope frame, before pitch). */
function bandPoints(shape: BalloonShape, z0: number, z1: number, n: number): Vec3[] {
  const out: Vec3[] = [];
  for (const th of [Math.PI - 1.01, Math.PI + 1.01]) {
    for (let k = 0; k < n; k++) {
      const z = z0 + ((z1 - z0) * k) / (n - 1);
      const rr = shape.r((z - shape.z0) / shape.length) * 1.01;
      out.push(V(Math.sin(th) * rr, Math.cos(th) * rr, z));
    }
  }
  return out;
}

function balloonTemplate(side: Side): BalloonTemplate {
  const cached = templates[side];
  if (cached) return cached;
  const shape = side === 'allied' ? CAQUOT : DRACHEN;
  const { map, normalMap } = paintEnvelope(side, shape);
  const extra = (seg: number) => (side === 'allied' ? caquotFins(seg) : drachenBag(seg));
  const env = mergeGeometries([envelopeGeometry(shape, 90, 72), ...extra(22)], false)!;
  const envFar = mergeGeometries([envelopeGeometry(shape, 28, 20), ...extra(8)], false)!;
  const pitchM = new THREE.Matrix4().makeRotationX(shape.pitch);

  // Rigging: band → crow's foot (cable) and band → load ring → basket.
  const lines = new Parts(side === 'allied' ? 601 : 602);
  const basket = new Parts(603);
  const basketFar = new Parts(604);
  const allied = side === 'allied';
  const cableTop = allied ? V(0, -12.5, -5.5) : V(0, -12.0, -3.5);
  const ring = allied ? V(0, -10.6, 1.2) : V(0, -10.2, 0.8);
  const basketTop = ring.clone().add(V(0, -3.2, 0));
  const rope = { ...ROPE, color: 0x8d7d5c };
  const band = bandPoints(shape, allied ? -9.5 : -8.5, allied ? 5.5 : 2.5, allied ? 11 : 9).map((p) => p.applyMatrix4(pitchM));
  const half = band.length / 2;
  for (let k = 0; k < band.length; k++) {
    const p = band[k];
    const idx = k % half;
    const front = idx < half * 0.55;
    lines.rope(p, front ? cableTop : ring, 0.03, rope, 0, 1);
    // Handling-line fringe hanging from the band.
    const len = 2.2 + ((k * 37) % 7) * 0.25;
    lines.rope(p, p.clone().add(V(0, -len, 0.15)), 0.025, rope, 0, 1);
    const mid = band[k].clone().lerp(band[Math.min(band.length - 1, k + 1)], 0.5);
    if (idx < half - 1) lines.rope(mid, mid.clone().add(V(0, -len * 0.8, -0.1)), 0.02, rope, 0, 1);
  }
  // Nose rigging patch to the crow's foot (keeps the nose into the wind).
  const nose = V(0, -shape.r(0.08) * 0.9, shape.z0 + shape.length * 0.08).applyMatrix4(pitchM);
  lines.rope(nose, cableTop, 0.035, rope, 0, 1);
  lines.rope(nose.clone().add(V(1.2, 0.4, 0.6)), cableTop, 0.03, rope, 0, 1);
  lines.rope(nose.clone().add(V(-1.2, 0.4, 0.6)), cableTop, 0.03, rope, 0, 1);
  // Crow's foot toggle and the ring.
  lines.sphere(0.12, M(cableTop.x, cableTop.y, cableTop.z), PAINT(COL.steel, 0.5, 0.6), 6, 4);
  lines.add(new THREE.TorusGeometry(0.28, 0.04, 4, 12), M(ring.x, ring.y, ring.z, Math.PI / 2), PAINT(COL.steel, 0.5, 0.6));
  // Telephone line from the basket down to the crow's foot.
  lines.rope(basketTop.clone().add(V(0.5, -0.5, -0.4)), cableTop, 0.015, { ...ROPE, color: 0x2a2a28 }, 0.3, 3);

  // Basket: wicker, padded rim, two observers, parachute containers.
  const bw = 1.3, bd = 1.1, bh = 1.15;
  const bc = basketTop.clone().add(V(0, -bh / 2, 0));
  const wick = { color: 0xa88a58, tile: TILE.WICKER, scale: 0.55, rough: 0.9, ember: 1 };
  for (const B of [basket, basketFar]) {
    B.add(new THREE.CylinderGeometry(0.78, 0.72, bh, B === basket ? 12 : 6, 1, false), M(bc.x, bc.y, bc.z, 0, Math.PI / 4, 0, bw / 1.1, 1, bd / 1.1), wick);
  }
  basket.add(new THREE.TorusGeometry(0.76, 0.06, 5, 12), M(bc.x, basketTop.y, bc.z, Math.PI / 2, Math.PI / 4, 0, bw / 1.1, bd / 1.1, 1), PAINT(0x3a2a1c, 0.5, 0));
  const ropeB = { ...rope };
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const corner = V(bc.x + cx * bw * 0.42, basketTop.y, bc.z + cz * bd * 0.42);
    basket.rope(corner, ring, 0.03, ropeB, 0, 1);
  }
  basket.box(0.9, 0.05, 0.05, M(ring.x, ring.y - 1.1, ring.z), PAINT(COL.timberDark, 0.7));
  soldier(basket, M(bc.x - 0.3, basketTop.y - 1.6, bc.z + 0.1, 0, 0.3), side, 'binoc', true);
  soldier(basket, M(bc.x + 0.32, basketTop.y - 1.6, bc.z - 0.05, 0, -0.5), side, 'point', true);
  // Parachute containers hung outside the basket (Guardian Angel / Heinecke).
  for (const sx of [-1, 1]) {
    const pc = V(bc.x + sx * (bw * 0.5 + 0.22), bc.y + 0.25, bc.z + 0.1);
    basket.cyl(0.2, 0.2, 0.7, 8, M(pc.x, pc.y, pc.z), { color: allied ? 0x6b6448 : 0x5d6152, tile: TILE.CANVAS, scale: 0.5, rough: 0.9 });
    basket.add(new THREE.ConeGeometry(0.2, 0.35, 8), M(pc.x, pc.y - 0.52, pc.z, Math.PI), { color: allied ? 0x6b6448 : 0x5d6152, tile: TILE.CANVAS, scale: 0.5, rough: 0.9 });
    basket.rope(pc.clone().add(V(0, 0.35, 0)), V(pc.x * 0.5, basketTop.y + 0.2, pc.z), 0.02, ropeB, 0, 1);
  }
  // Ballast sandbag hanging below.
  basket.rope(V(bc.x, bc.y - bh / 2, bc.z), V(bc.x, bc.y - bh / 2 - 0.9, bc.z), 0.02, ropeB, 0, 1);
  basket.box(0.4, 0.3, 0.3, M(bc.x, bc.y - bh / 2 - 1.05, bc.z), { color: 0xa7926a, tile: TILE.SANDBAG, scale: 0.6, rough: 1 });

  if (side === 'central') {
    // Tail line with drogue cups streaming behind the rudder bag.
    const zTail = DRACHEN.z0 + DRACHEN.length;
    const start = V(0, 3.0, zTail + 0.8).applyMatrix4(pitchM);
    let prev = start;
    for (let k = 1; k <= 5; k++) {
      const p = start.clone().add(V(0, -k * 1.9, k * 1.6));
      lines.rope(prev, p, 0.025, rope, 0, 1);
      lines.add(new THREE.ConeGeometry(0.42 - k * 0.03, 0.55, 10, 1, true), M(p.x, p.y, p.z, -0.75), { color: 0x9c9678, tile: TILE.CANVAS, scale: 0.6, rough: 0.9 });
      prev = p;
    }
  }

  // Hit spheres along the envelope axis, the fins/bag and the basket.
  const hit: HitSphere[] = [];
  for (let k = 0; k < 6; k++) {
    const s = 0.08 + (k / 5) * 0.8;
    const z = shape.z0 + s * shape.length;
    const c = V(0, 0, z).applyMatrix4(pitchM);
    hit.push({ o: c, r: Math.max(2.4, shape.r(s) * 1.1 + 0.4) });
  }
  hit.push({ o: V(0, allied ? 0 : -2, (allied ? 11 : 10)).applyMatrix4(allied ? new THREE.Matrix4() : pitchM), r: allied ? 5.2 : 4.4 });
  hit.push({ o: bc.clone(), r: 1.4 });

  const t: BalloonTemplate = {
    shape, env, envFar,
    lines: lines.merge(), basket: basket.merge(), basketFar: basketFar.merge(),
    map, normalMap,
    intact: envelopeMaterial(map, normalMap, false),
    cableTop, ring, basketPos: bc, hit,
  };
  templates[side] = t;
  return t;
}

export function buildKiteBalloonRig(side: Side): ModelRig & { basket: THREE.Vector3; cableTop: THREE.Vector3 } {
  const t = balloonTemplate(side);
  const opaque = uberMaterial('opaque');
  const root = new THREE.Group();
  root.name = `balloon-${side}`;
  // Sway pivots at the crow's foot so the cable stays attached.
  const sway = new THREE.Group();
  sway.position.copy(t.cableTop);
  root.add(sway);
  const body = new THREE.Group();
  body.position.copy(t.cableTop).negate();
  sway.add(body);

  const lod = new THREE.LOD();
  body.add(lod);
  const near = new THREE.Group();
  const far = new THREE.Group();
  const envPivot = new THREE.Group();
  envPivot.rotation.x = t.shape.pitch;
  const env = new THREE.Mesh(t.env, t.intact);
  env.castShadow = true; env.receiveShadow = true;
  envPivot.add(env);
  near.add(envPivot);
  const lines = new THREE.Mesh(t.lines, opaque);
  near.add(lines);
  const basketMesh = new THREE.Mesh(t.basket, opaque);
  basketMesh.castShadow = true;
  near.add(basketMesh);
  const envPivotFar = new THREE.Group();
  envPivotFar.rotation.x = t.shape.pitch;
  const envFar = new THREE.Mesh(t.envFar, t.intact);
  envPivotFar.add(envFar);
  far.add(envPivotFar);
  far.add(new THREE.Mesh(t.basketFar, opaque));
  lod.addLevel(near, 0);
  lod.addLevel(far, 700, 0.1);

  let burnMat: THREE.MeshStandardMaterial | null = null;
  const phase = Math.random() * 100;
  const basketNow = t.basketPos.clone();
  const cableTop = t.cableTop.clone();

  return {
    root,
    hitSpheres: t.hit.map((h) => ({ o: h.o.clone(), r: h.r })),
    height: 30,
    radius: 18,
    basket: basketNow,
    cableTop,
    setDestroyed(tt: number): void {
      if (tt <= 0) {
        if (burnMat) {
          env.material = t.intact; envFar.material = t.intact;
          env.visible = envFar.visible = true; lines.visible = true;
          env.castShadow = true;
        }
        return;
      }
      if (!burnMat) {
        burnMat = envelopeMaterial(t.map, t.normalMap, true);
        // Ignite high on the envelope, toward the tail (incendiary rounds from astern).
        const s = t.shape;
        burnMat.userData.uIgn.value.set((Math.random() - 0.5) * 3, s.r(0.55) * 0.8, s.z0 + s.length * (0.5 + Math.random() * 0.25));
      }
      env.material = burnMat; envFar.material = burnMat;
      env.castShadow = false;
      burnMat.userData.uBurn.value = Math.min(1, tt / 3.6);
      burnMat.userData.uGlow.value = 1 - THREE.MathUtils.smoothstep(tt, 3.5, 5.2);
      env.visible = envFar.visible = tt < 5.5;
      lines.visible = tt < 2.4;
    },
    animate(_dt: number, time: number): void {
      // A kite balloon never hangs still: it yaws and nods on its cable.
      sway.rotation.set(Math.sin(time * 0.43 + phase) * 0.035, Math.sin(time * 0.21 + phase * 1.3) * 0.05, Math.sin(time * 0.37 + phase * 0.7) * 0.04);
      basketNow.copy(t.basketPos).sub(t.cableTop).applyEuler(sway.rotation).add(t.cableTop);
    },
    dispose(): void {
      burnMat?.dispose();
      root.removeFromParent();
    },
  };
}
