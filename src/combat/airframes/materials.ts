import * as THREE from 'three';
import { flashTexture, propBlurTexture, propTextures } from './props';

/**
 * Materials. There are deliberately few of them:
 *
 *  - skin   — the painted livery atlas (fabric, dope, plywood, painted metal).
 *             One per (type, livery), cloned per aircraft only so each can
 *             carry its own damage uniform. The clones share one GL program:
 *             the damage hook is the same function for all of them, and
 *             three keys programs on the hook's source.
 *  - props  — every piece of hardware on every aircraft (see props.ts).
 *  - glass  — windscreens, instrument glasses, goggles.
 *  - disc   — the blurred propeller, per aircraft for its opacity.
 *  - flash  — additive muzzle flash, shared.
 */

/**
 * The game's environment map is the sky alone, so its lower half is bright
 * haze where the ground should be: undersides of wings would glow as if lit
 * from below and every downward reflection would be sky. Fade image-based
 * light for normals (and reflections) that face the ground; the hemisphere
 * light still supplies the warm bounce. Appended after three's IBL chunk.
 */
const GROUND_OCCLUSION = `#include <lights_fragment_maps>
{
  vec3 aoWorldN = inverseTransformDirection( geometryNormal, viewMatrix );
  iblIrradiance *= mix( 0.3, 1.0, smoothstep( -0.75, 0.35, aoWorldN.y ) );
  vec3 aoWorldR = inverseTransformDirection( reflect( -geometryViewDir, geometryNormal ), viewMatrix );
  radiance *= mix( 0.3, 1.0, smoothstep( -0.45, 0.12, aoWorldR.y ) );
}`;

/** Hook for the shared hardware material: ground occlusion only. */
function propsHook(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_maps>', GROUND_OCCLUSION);
}

export interface DamageUniforms {
  uDamage: { value: number };
  uSeed: { value: number };
  /** Metres per unit of uv: bullet holes are sized in metres wherever they land. */
  uMetres: { value: number };
}

/**
 * Bullet damage painted in the fragment shader, so a hit costs nothing but a
 * uniform. Holes live on a jittered grid in *atlas metres*; each cell has a
 * threshold and punches through once accumulated damage passes it, so holes
 * appear one by one and never move. Mirrored wing halves share uvs, so the
 * side of the aircraft is folded into the hash. Past ~60 % damage some holes
 * become ragged tears, and broad soot creeps over the skin.
 */
function damageHook(this: THREE.Material, shader: THREE.WebGLProgramParametersWithUniforms): void {
  const u = (this.userData as { dmg: DamageUniforms }).dmg;
  shader.uniforms.uDamage = u.uDamage;
  shader.uniforms.uSeed = u.uSeed;
  shader.uniforms.uMetres = u.uMetres;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vDmgPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDmgPos = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <lights_fragment_maps>', GROUND_OCCLUSION)
    .replace(
      '#include <common>',
      `#include <common>
varying vec3 vDmgPos;
uniform float uDamage;
uniform float uSeed;
uniform float uMetres;
float dmgHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float dmgNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float n = dot(i, vec3(1.0, 57.0, 113.0));
  vec4 a = fract(sin(vec4(n, n + 1.0, n + 57.0, n + 58.0)) * 43758.5453);
  vec4 b = fract(sin(vec4(n + 113.0, n + 114.0, n + 170.0, n + 171.0)) * 43758.5453);
  vec4 m = mix(a, b, f.z);
  vec2 q = mix(m.xy, m.zw, f.y);
  return mix(q.x, q.y, f.x);
}`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
#ifdef USE_MAP
if (uDamage > 0.002) {
  vec2 m = vMapUv * uMetres;
  float side = vDmgPos.x >= 0.0 ? 0.0 : 31.0;
  const float CELL = 0.36;
  vec2 cell = floor(m / CELL);
  float hole = 0.0, fray = 0.0, soot = 0.0;
  for (int dx = -1; dx <= 1; dx++) for (int dy = -1; dy <= 1; dy++) {
    vec2 c = cell + vec2(float(dx), float(dy)) + side + uSeed;
    float h = dmgHash(c);
    if (uDamage < 0.05 + h * 1.5) continue;
    vec2 centre = (cell + vec2(float(dx), float(dy)) + 0.15 + 0.7 * vec2(dmgHash(c + 3.1), dmgHash(c + 7.7))) * CELL;
    vec2 d = m - centre;
    // A few holes open into ragged tears once the machine is badly shot up.
    float tear = step(0.75, dmgHash(c + 9.2)) * smoothstep(0.5, 0.95, uDamage);
    float r = 0.009 + 0.012 * dmgHash(c + 1.3) + 0.045 * tear;
    float ang = atan(d.y, d.x);
    float jag = 1.0 + (0.1 + 0.28 * tear) * sin(ang * 7.0 + h * 40.0) + 0.09 * sin(ang * 13.0 + h * 17.0) + 0.07 * sin(ang * 23.0 + h * 5.0);
    float dist = length(d) / (r * jag);
    hole = max(hole, 1.0 - smoothstep(0.75, 1.0, dist));
    fray = max(fray, 1.0 - smoothstep(1.0, 1.7, dist));
    soot = max(soot, 1.0 - smoothstep(1.3, 4.0 + 3.0 * tear, dist));
  }
  float n = dmgNoise(vDmgPos * 1.6 + uSeed) * 0.65 + dmgNoise(vDmgPos * 4.1) * 0.35;
  float scorch = smoothstep(0.62, 0.9, n + uDamage * 0.45 - 0.2) * smoothstep(0.3, 1.0, uDamage);
  diffuseColor.rgb *= 1.0 - 0.35 * soot;
  // Frayed edges show raw, undoped linen.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.37, 0.28), fray * (1.0 - hole) * 0.6);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.028, 0.026), scorch * 0.85);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.006, 0.005, 0.004), hole);
}
#endif`,
    );
}

export function makeDamageUniforms(metres: number, seed = Math.random() * 100): DamageUniforms {
  return { uDamage: { value: 0 }, uSeed: { value: Math.floor(seed) }, uMetres: { value: metres } };
}

export interface SkinMaps {
  map: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
  metres: number;
}

export function skinMaterial(maps: SkinMaps): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    map: maps.map,
    normalMap: maps.normal,
    normalScale: new THREE.Vector2(1, 1),
    roughnessMap: maps.orm,
    metalnessMap: maps.orm,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
    // Doped linen is satin, not gloss: a clear coat (or the full dielectric
    // Fresnel) turns it to grey plastic against a bright sky at grazing
    // angles. A weaker specular layer keeps the sheen without the silver.
    specularIntensity: 0.5,
    // The sky-only environment lights undersides from below as if the ground
    // were sky; keep its share of the diffuse modest.
    envMapIntensity: 0.55,
  });
  armDamage(m, makeDamageUniforms(maps.metres, 0));
  return m;
}

export function armDamage(m: THREE.Material, u: DamageUniforms): void {
  m.userData.dmg = u;
  m.onBeforeCompile = damageHook;
}

/** Per-aircraft copy of a skin material with its own damage uniforms. */
export function instanceSkin(base: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
  const m = base.clone();
  const bu = base.userData.dmg as DamageUniforms;
  armDamage(m, makeDamageUniforms(bu.uMetres.value));
  return m;
}

let props: THREE.MeshStandardMaterial | null = null;
export function propsMaterial(): THREE.MeshStandardMaterial {
  if (props) return props;
  const t = propTextures();
  props = new THREE.MeshStandardMaterial({
    map: t.map,
    normalMap: t.normal,
    roughnessMap: t.orm,
    metalnessMap: t.orm,
    roughness: 1,
    metalness: 1,
    vertexColors: true,
  });
  props.onBeforeCompile = propsHook;
  return props;
}

let glass: THREE.MeshPhysicalMaterial | null = null;
export function glassMaterial(): THREE.MeshPhysicalMaterial {
  if (glass) return glass;
  glass = new THREE.MeshPhysicalMaterial({
    color: 0xd8e4e0,
    roughness: 0.05,
    metalness: 0,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    envMapIntensity: 1.4,
    // Old celluloid/glass has a faint yellow-green cast.
    specularColor: new THREE.Color(0xffffff),
  });
  return glass;
}

let discBase: THREE.MeshStandardMaterial | null = null;
export function discMaterial(): THREE.MeshStandardMaterial {
  if (!discBase) {
    discBase = new THREE.MeshStandardMaterial({
      map: propBlurTexture(),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      roughness: 0.55,
      metalness: 0,
      opacity: 1,
    });
  }
  return discBase.clone();
}

let flash: THREE.MeshBasicMaterial | null = null;
export function flashMaterial(): THREE.MeshBasicMaterial {
  if (flash) return flash;
  flash = new THREE.MeshBasicMaterial({
    map: flashTexture(),
    // HDR colour: over the bloom threshold, but a finite, sane number.
    color: new THREE.Color(6.0, 3.1, 1.1),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  return flash;
}
