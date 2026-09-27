import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Hot air balloons, drifting over the low country at either end of the day.
 *
 * Everything else this world contains is bolted to the ground. That is fine
 * while you are low, and at cruise it leaves the middle distance completely
 * empty — the terrain slides by underneath and nothing crosses the frame at
 * your own height, which is exactly where the eye reads speed. One balloon at
 * three thousand feet does more for the sense of motion than a hundred more
 * buildings would.
 *
 * Two decisions that are not obvious:
 *
 * They are solitary. A dozen balloons together is a festival, which is a
 * spectacle rather than a landscape, and at this scale a cluster reads as one
 * blob anyway. One large envelope over a valley is the picture.
 *
 * They keep hours. Balloons fly in still air, which means shortly after dawn
 * and shortly before dusk — so they are simply not there in the middle of the
 * day. A thing that is always present stops being noticed; a thing that is
 * only there at golden hour is a reason to fly at golden hour.
 */

export interface Balloon {
  x: number;
  z: number;
  /** Metres above sea level — these hang in the air, not on the ground. */
  y: number;
  size: number;
  /** Phase, so a sky full of them does not sway as one object. */
  phase: number;
}

export interface BalloonOptions {
  /** Somewhere with people in it to launch them. */
  enabled: boolean;
  seed: number;
  exclusion: number;
  /** Ground level for this world, as everything else here measures from it. */
  field: number;
  city: { x: number; z: number; radius: number } | null;
}

/**
 * Drawn larger than life, like everything else out here.
 *
 * A real envelope is twenty metres across, which from a mile up is a speck. At
 * 3.6 it is a seventy-metre object — still much smaller than a wind turbine,
 * and big enough to be a shape rather than a dot, including on the ones that
 * have climbed a long way up.
 */
const EXAGGERATION = 3.6;
const REACH = 46_000;
const CELL = 13_000;
const CHANCE = 0.5;

/** As high as one goes, metres above the ground it launched from. */
const CEILING = 12_000;

/** The hours they are up: after dawn, and before dusk. */
const MORNING: [number, number] = [4.9, 8.9];
const EVENING: [number, number] = [17.4, 20.3];

/**
 * The wind, as an amplitude in metres on each axis.
 *
 * The drift is a slow Lissajous rather than a straight line, and that is a
 * deliberate choice about *discontinuity* rather than about realism. Drifting
 * in a straight line means eventually wrapping, and a wrap is a balloon
 * teleporting three kilometres sideways. Two sines of different period wander
 * convincingly and never jump. Peak speed works out around 4 m/s, which is
 * what a balloon does.
 */
const WIND = new THREE.Vector2(300, 240);

/** Advanced by the world clock; the only per-frame cost the whole flock has. */
export const balloonDrift = { value: 0 };

let flock: Balloon[] = [];

export function balloons(): Balloon[] {
  return flock;
}

/** Deterministic value in [0, 1) for a cell, matching the other scatterers. */
function cellRandom(x: number, y: number, salt: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

export function planBalloons(
  sample: (x: number, z: number) => number,
  opts: BalloonOptions,
): void {
  flock = [];
  if (!opts.enabled) return;
  const salt = (opts.seed | 0) * 48;
  const span = Math.ceil(REACH / CELL);

  for (let gx = -span; gx <= span; gx++) {
    for (let gz = -span; gz <= span; gz++) {
      if (cellRandom(gx, gz, salt + 1) > CHANCE) continue;
      const x = (gx + (cellRandom(gx, gz, salt + 2) - 0.5) * 0.8) * CELL;
      const z = (gz + (cellRandom(gx, gz, salt + 3) - 0.5) * 0.8) * CELL;
      if (Math.hypot(x, z) < opts.exclusion || Math.hypot(x, z) > REACH) continue;

      const ground = sample(x, z);
      // Over land, and over the low country. Balloons launch from fields, and
      // one hanging over a glacier is a different sort of picture.
      if (ground < 8 || ground > opts.field + 900) continue;
      if (opts.city !== null
        && Math.hypot(x - opts.city.x, z - opts.city.z) < opts.city.radius * 1.4) continue;

      // Anywhere from just off the ground to the flight levels, and heavily
      // weighted to the bottom of that.
      //
      // A steep power on the random puts most of them where a balloon usually
      // is —
      // a few hundred feet over the fields — while leaving the rare one that
      // has gone all the way up. Those are the ones worth meeting: an
      // envelope at thirty thousand feet, level with the aeroplane and
      // apparently motionless, is a much stranger sight than one over a
      // hedge, and a linear spread would have put half of them at 6 km where
      // neither reading works.
      const climb = cellRandom(gx, gz, salt + 4);
      flock.push({
        x,
        z,
        y: ground + Math.min(190 + climb ** 3.8 * 11_900, CEILING),
        size: 0.85 + cellRandom(gx, gz, salt + 5) * 0.45,
        phase: cellRandom(gx, gz, salt + 6) * Math.PI * 2,
      });
    }
  }
}

/** Whether the flock should be in the sky at this hour. */
export function balloonsFlyAt(hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return (h >= MORNING[0] && h <= MORNING[1]) || (h >= EVENING[0] && h <= EVENING[1]);
}

/** The classic shape, as a lathe: a fat envelope pinched into its mouth. */
function envelopeGeometry(): THREE.BufferGeometry {
  const profile = [
    [0.35, 25.4], [3.4, 24.6], [6.6, 22.2], [9.0, 18.4], [10.0, 13.6],
    [9.6, 9.0], [7.6, 4.6], [4.6, 1.4], [2.6, -0.4], [2.3, -1.4],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const SEGMENTS = 16;
  const geo = new THREE.LatheGeometry(profile, SEGMENTS);

  // Gores: alternate panels a shade apart. The instance colour multiplies
  // through this, so one hue per balloon still arrives banded rather than as a
  // flat ball of paint.
  const n = geo.attributes.position.count;
  const perRing = profile.length;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const ring = Math.floor(i / perRing);
    const shade = ring % 2 === 0 ? 1.0 : 0.72;
    colours[i * 3] = shade;
    colours[i * 3 + 1] = shade;
    colours[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

/** A box, positioned and coloured, ready to be merged. */
function part(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  shade: number,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  const n = geo.attributes.position.count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = shade;
    colours[i * 3 + 1] = shade;
    colours[i * 3 + 2] = shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  const flat = geo.toNonIndexed();
  geo.dispose();
  return flat;
}

function balloonGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [envelopeGeometry()];
  // Basket and rigging, kept very dark. The instance colour multiplies the
  // whole balloon, and near-black stays near-black whatever hue it is given —
  // which is how one tint attribute paints the envelope without turning the
  // wicker scarlet.
  for (const [cx, cz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) {
    parts.push(part(0.28, 6.4, 0.28, cx, -4.6, cz, 0.10));
  }
  parts.push(part(4.0, 2.8, 4.0, 0, -9.2, 0, 0.13));
  parts.push(part(4.4, 0.5, 4.4, 0, -7.7, 0, 0.09));
  return mergeGeometries(parts, false);
}

/**
 * The drift, done entirely in the vertex shader.
 *
 * The instances carry no rotation — a balloon has no facing worth modelling —
 * so their matrices are a scale and a translation, and a world-space offset
 * divided by that scale can simply be added to the local position. That is the
 * whole trick, and it means a sky full of balloons costs one uniform per frame
 * rather than a matrix rebuild.
 */
function balloonMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDrift = balloonDrift;
    shader.uniforms.uWind = { value: WIND };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aPhase;
        attribute float aScale;
        uniform float uDrift;
        uniform vec2 uWind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float bt = uDrift;
        vec3 sway = vec3(
          uWind.x * sin(bt * 0.0143 + aPhase),
          7.0 * sin(bt * 0.037 + aPhase * 1.7),
          uWind.y * cos(bt * 0.0117 + aPhase * 0.63));
        transformed += sway / max(aScale, 0.001);`);
  };
  return material;
}

/**
 * One hue per balloon, walked by the golden angle.
 *
 * Hashing the hue would give two of the same red often enough to notice with
 * only a couple of dozen of them in a world. Stepping by 0.618 of the circle
 * is the standard trick for "as far from all the previous ones as possible",
 * and it means the colours stay distinct however many there turn out to be.
 */
function balloonColour(index: number, out: THREE.Color): THREE.Color {
  const hue = (index * 0.618_033_988_75) % 1;
  // Kept off full saturation: a pure primary reads as a UI element rather than
  // as fabric with the sun behind it.
  return out.setHSL(hue, 0.62, 0.55);
}

export function buildBalloonMeshes(): THREE.Group {
  const group = new THREE.Group();
  if (flock.length === 0) return group;

  const geo = balloonGeometry();
  const mesh = new THREE.InstancedMesh(geo, balloonMaterial(), flock.length);
  mesh.castShadow = false; // nothing under a balloon to catch its shadow usefully
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;

  const phase = new Float32Array(flock.length);
  const scale = new Float32Array(flock.length);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  flock.forEach((b, i) => {
    dummy.position.set(b.x, b.y, b.z);
    // No rotation, deliberately: see `balloonMaterial`.
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(b.size * EXAGGERATION);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    mesh.setColorAt(i, balloonColour(i, tint));
    phase[i] = b.phase;
    scale[i] = b.size * EXAGGERATION;
  });
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
  group.add(mesh);
  return group;
}

export function disposeBalloonMeshes(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mat = mesh.material;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat.dispose();
  });
  group.clear();
}
