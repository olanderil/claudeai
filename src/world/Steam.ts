import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { coolingTowers } from './Structures';

/**
 * The plume off a cooling tower.
 *
 * A power station is the largest thing built in these worlds and it is still
 * easy to fly straight past, because from above it is two pale circles on pale
 * ground. The steam is what makes it carry: a white column two hundred metres
 * tall, leaning downwind, is visible at ranges where the towers themselves are
 * a smudge — and it is the only thing in the landscape that *moves* without
 * being an aeroplane.
 *
 * Two crossed quads per tower, shaped entirely in the shader from their own
 * UVs: no texture, no particles, no per-frame CPU work. The whole effect is
 * one uniform.
 */

/** Advanced by the world clock. */
export const steamDrift = { value: 0 };
/** How lit the plume is — white steam at midnight is a ghost. */
export const steamLight = { value: 1 };

/**
 * Plume size relative to the tower it sits on.
 *
 * Twelve tower-radii tall is around eight hundred metres, which is what these
 * actually do on a still day — the first version at 3.4 was a tidy little
 * puff sitting on the rim, and a plume that stops just above the thing making
 * it reads as decoration rather than as weather.
 */
const PLUME_HEIGHT = 12;
const PLUME_WIDTH = 2.6;

function plumeMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSteam = steamDrift;
    shader.uniforms.uSteamLight = steamLight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         attribute float aPhase;
         uniform float uSteam;
         varying vec2 vPlume;
         varying float aPhaseF;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
         vPlume = uv;
         aPhaseF = aPhase;
         // Spreads as it rises, leans downwind, and wanders. The lean is
         // superlinear in height because the column is still being pushed
         // upward near the rim and has lost that momentum by the top.
         float rise = uv.y;
         // Opens out as it cools, but not without limit. Spread to six times
         // its base width the two crossed quads stop overlapping and each one
         // reads as its own soft-edged sheet — four of them per station, which
         // looked like searchlights rather than steam.
         float open = 0.44 + rise * 2.7;
         transformed.x *= open;
         transformed.z *= open;
         //
         // In units of the plume's own width, not metres. The geometry is a
         // unit quad and the instance carries the scale, so anything added
         // here is multiplied by a hundred and fifty — a lean of 26 put the
         // top of the column four kilometres downwind, which drew as a faint
         // horizontal streak across the whole sky and read as nothing at all.
         float lean = pow(rise, 1.6);
         transformed.x += lean * 1.35;
         transformed.x += sin(uSteam * 0.55 + aPhase + rise * 2.4) * rise * 0.9;
         transformed.z += cos(uSteam * 0.41 + aPhase * 1.3 + rise * 2.0) * rise * 0.8;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying vec2 vPlume;
         varying float aPhaseF;
         uniform float uSteamLight;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
         // Dense at the rim, thinning to nothing at the top, soft at the
         // edges. Without the fade at the top the column ends in a straight
         // line across the sky, which is the one thing steam never does.
         //
         // The edge softening widens with height for the same reason the
         // geometry does: near the rim it is a defined column and by the top
         // it is a haze with no edge at all. Raising the falloff to a power
         // spends the gradient where it shows, so the boundary never reads as
         // the edge of a sheet.
         // The dense part of the column wanders instead of running straight up
         // the middle of the quad. A bright core on the centre line is what
         // makes a flat sheet read as a beam; moving it with height reads as
         // billowing, and costs one sine.
         float core = vPlume.x - 0.5 + 0.17 * sin(vPlume.y * 2.3 + aPhaseF);
         float across = 1.0 - abs(core) * 2.0;
         across = pow(smoothstep(0.0, 0.62 + vPlume.y * 0.4, across), 0.5);
         // Thins fast. Held dense too long the column reads as a solid ribbon
         // however soft its edges are — what says "vapour" is that you can
         // see the sky through most of it.
         float up = smoothstep(0.0, 0.04, vPlume.y);
         up *= pow(1.0 - smoothstep(0.02, 0.86, vPlume.y), 1.5);
         // Broken up, so the silhouette is not a clean shape — but gently.
         //
         // The first attempt used frequencies of 17 and 41 along the plume and
         // 9 across it, which put several cycles inside the quad and drew a
         // fan of hard diagonal bands: it read as shafts of light coming out
         // of the tower rather than as steam. Under one cycle in each
         // direction gives an uneven column instead of a striped one.
         float wisp = sin(vPlume.y * 3.4 + aPhaseF) * cos(vPlume.x * 2.6 + aPhaseF * 0.7);
         gl_FragColor.a *= across * up * (0.78 + 0.22 * wisp) * 0.5 * uSteamLight;`);
  };
  return material;
}

/** Two quads at right angles: a column with no preferred side to be seen from. */
function plumeGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const turn of [0, Math.PI / 2]) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    geo.rotateY(turn);
    parts.push(geo.toNonIndexed());
    geo.dispose();
  }
  return mergeGeometries(parts, false);
}

export function buildSteam(): THREE.Group {
  const group = new THREE.Group();
  const towers = coolingTowers();
  if (towers.length === 0) return group;

  const geo = plumeGeometry();
  const mesh = new THREE.InstancedMesh(geo, plumeMaterial(), towers.length);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  const phase = new Float32Array(towers.length);
  const dummy = new THREE.Object3D();
  towers.forEach((t, i) => {
    dummy.position.set(t.x, t.y, t.z);
    dummy.rotation.set(0, 0, 0);
    // Non-uniform: a plume is much taller than it is wide, and the shader's
    // spread is written as a fraction of that width.
    dummy.scale.set(t.radius * PLUME_WIDTH, t.radius * PLUME_HEIGHT, t.radius * PLUME_WIDTH);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    phase[i] = (i * 2.399) % 6.283;
  });
  geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
  group.add(mesh);
  return group;
}

export function disposeSteam(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });
  group.clear();
}
