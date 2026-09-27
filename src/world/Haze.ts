import * as THREE from 'three';
import { FOG_GLSL } from './GroundFog';

/**
 * Aerial perspective: haze that knows where the sun is and how high you are.
 *
 * The scene already had distance fog, and distance fog is only the first third
 * of what makes far things look far. Two things were missing.
 *
 * The first is direction. Real haze is not one colour: looking towards the sun
 * it is bright and warm, because that is forward-scattered light coming back at
 * you, and looking away from it it is blue, because that is the sky. A single
 * fog colour makes a ridge to the east and a ridge to the west the same shade,
 * and the eye reads that as paint rather than as air.
 *
 * The second is height. Air thins as you climb, so a mountain seen from 6000 m
 * has far less of it in the way than the same mountain seen from the valley
 * floor. Flat fog hazes both identically, which flattens exactly the moment —
 * climbing out and watching the range sharpen — that altitude is for.
 *
 * Both are a handful of instructions in the fog chunk, and nothing per frame
 * beyond four uniforms that only change when the sun does.
 */

/** Blue of a clear sky, for the away-from-sun end of the haze. */
const SKY_BLUE = new THREE.Color(0.34, 0.46, 0.72);

/**
 * Shared by every material that opts in, so one update reaches all of them.
 *
 * The same trick the terrain's style uniforms use: one object, handed to each
 * compiled shader, mutated in place.
 */
export const hazeUniforms = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uHazeSun: { value: new THREE.Color(0.75, 0.75, 0.78) },
  uHazeSky: { value: new THREE.Color(0.55, 0.62, 0.78) },
  /**
   * Scale height of the atmosphere, metres — the height at which haze is down
   * to a third of its sea-level thickness.
   *
   * Earth's is about 8400 m for density, but what matters here is the murk
   * near the ground rather than the whole column, and the sim's worlds top out
   * around 7000 m. Lower makes climbing out of the haze happen at the
   * altitudes this aircraft actually flies at.
   */
  uHazeScale: { value: 2300 },
  /**
   * Fog lying on the ground, as opposed to haze hanging in the air.
   *
   * An inversion is not a thicker version of the haze above it, and it cannot
   * be drawn as one: haze is integrated along the ray, so it whitens whatever
   * is far away, while fog in a valley whitens whatever is *low* however near
   * it is. Drawn only as a horizontal sheet it has another problem — a plane
   * of zero thickness meeting a hillside gives a razor-sharp contour where the
   * two intersect, which is the one thing fog never has.
   *
   * So the ground fades into it too. Terrain below the fog top goes to the fog
   * colour over a band a couple of hundred metres deep, which puts a soft edge
   * on the hillside exactly where the sheet cuts it — and with white on both
   * sides of the join, the join stops existing.
   */
  uGroundFog: { value: 0 },
  uFogTop: { value: 0 },
  uFogBand: { value: 240 },
  uFogTint: { value: new THREE.Color(0.86, 0.89, 0.93) },
  /** How large the banks are, and how much of the country they leave clear. */
  uFogScale: { value: 0.000032 },
  uFogPatch: { value: 0.4 },
  uFogSoft: { value: 0.2 },
};

/**
 * Give a material aerial perspective instead of flat fog.
 *
 * Anchored on the two fog chunks rather than on `begin_vertex` or
 * `color_fragment`. Those are the places everything else in this project
 * injects, and two replacements racing for the same anchor is how the terrain's
 * splat shading once ended up reading heights that had not been written yet.
 * Nothing else touches the fog.
 */
export function applyHaze(shader: {
  uniforms: Record<string, unknown>;
  vertexShader: string;
  fragmentShader: string;
}): void {
  Object.assign(shader.uniforms, hazeUniforms);

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
       varying vec3 vHazePos;`)
    // `transformed` is still in scope here, and this runs after any
    // displacement a material does to it — so the haze is measured from where
    // the vertex ended up rather than from where it started.
    .replace('#include <fog_vertex>', `#include <fog_vertex>
       vHazePos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
       varying vec3 vHazePos;
       uniform vec3 uSunDir;
       uniform vec3 uHazeSun;
       uniform vec3 uHazeSky;
       uniform float uHazeScale;
       uniform float uGroundFog;
       uniform float uFogTop;
       uniform float uFogBand;
       uniform vec3 uFogTint;

       uniform float uFogScale;
       uniform float uFogPatch;
       uniform float uFogSoft;
       ${FOG_GLSL}`)
    .replace('#include <fog_fragment>', `
       #ifdef USE_FOG
       #ifdef FOG_EXP2
       {
         vec3 hazeView = normalize(vHazePos - cameraPosition);

         // Height. The air between two points thins as both of them rise, so
         // the optical depth is scaled by the average thinness of the two ends
         // rather than by the distance alone. Cheap, and enough to make a
         // ridge seen from altitude read as nearer than the same ridge seen
         // from the valley.
         float lowEye = exp(-max(cameraPosition.y, 0.0) / uHazeScale);
         float lowHere = exp(-max(vHazePos.y, 0.0) / uHazeScale);
         float depth = vFogDepth * 0.5 * (lowEye + lowHere);
         float fogFactor = 1.0 - exp(-fogDensity * fogDensity * depth * depth);

         // Direction. A tight forward lobe towards the sun, a broad blue wash
         // away from it — Mie and Rayleigh, approximated rather than
         // integrated, which is the same bargain the sky model already makes.
         float toSun = dot(hazeView, uSunDir);
         float glow = pow(max(toSun, 0.0), 6.0);
         float away = pow(max(-toSun, 0.0), 1.5);
         vec3 haze = mix(fogColor, uHazeSun, glow * 0.62);
         haze = mix(haze, uHazeSky, away * 0.34);

         gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, fogFactor);

         // Drowned. Anything under the fog top goes to its colour, over a
         // band rather than at a line, so the boundary follows the shape of
         // the ground instead of cutting across it.
         if (uGroundFog > 0.0) {
           float sunk = 1.0 - smoothstep(uFogTop - uFogBand, uFogTop, vHazePos.y);
           // Not everywhere. Flooding everything under the fog top gave one
           // uniform white plain from altitude — correct for a single valley
           // and wrong for a country, where the fog settles in some hollows
           // and leaves the next one clear. The scale says how big the banks
           // are: tens of kilometres for a layer filling the valleys, a few
           // for banks you fly in and out of.
           float lie = fogCover(vHazePos.xz, uFogScale, uFogPatch, uFogSoft);
           gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogTint, sunk * lie * uGroundFog);
         }
       }
       #else
         #include <fog_fragment>
       #endif
       #endif`);
}

/**
 * Recolour the haze for the sun as it is now.
 *
 * `twilight` fades the blue shift out: once the sun is under the horizon the
 * whole sky is already that colour, and shifting it further just turns the
 * landscape purple.
 */
/**
 * The ground fog for one weather: how much, how high it reaches, what colour.
 *
 * `top` is an absolute altitude, matching the cloud deck's, because they are
 * two halves of the same layer — the sheet is its top surface and this is
 * everything underneath.
 */
export function setGroundFog(
  amount: number, top: number, band: number, tint: THREE.Color,
  scale: number, patch: number, soft: number,
): void {
  hazeUniforms.uGroundFog.value = amount;
  hazeUniforms.uFogTop.value = top;
  hazeUniforms.uFogBand.value = band;
  hazeUniforms.uFogTint.value.copy(tint);
  hazeUniforms.uFogScale.value = scale;
  hazeUniforms.uFogPatch.value = patch;
  hazeUniforms.uFogSoft.value = soft;
}

export function setHaze(
  sun: THREE.Vector3,
  fogColour: THREE.Color,
  sunColour: THREE.Color,
  twilight: number,
): void {
  hazeUniforms.uSunDir.value.copy(sun).normalize();
  hazeUniforms.uHazeSun.value.copy(fogColour).lerp(sunColour, 0.5).multiplyScalar(1.16);
  hazeUniforms.uHazeSky.value.copy(fogColour).lerp(SKY_BLUE, 0.42 * (1 - twilight));
}
