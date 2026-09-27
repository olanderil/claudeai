import * as THREE from 'three';

/**
 * Traffic, eight miles up.
 *
 * The higher you climb the emptier this world gets. Down low there are boats,
 * villages, landmarks and now balloons; at thirty thousand feet the ground is
 * a texture and the sky is a gradient, and the aeroplane could be sitting
 * still. A few thin white lines across the blue fix that for almost nothing —
 * they are the one cue that says the airspace is occupied, and they only read
 * when you are high, which is exactly where everything else has stopped
 * helping.
 *
 * Half a dozen flat ribbons, positioned once. No animation, no per-frame work,
 * and the alpha is shaped in the fragment shader from the ribbon's own UVs so
 * there is no texture to load either.
 *
 * Built once for the whole session and never torn down, which is why there is
 * no dispose here to pair with the build: changing world changes the ground,
 * and the traffic at forty thousand feet is the same traffic either way.
 */

/** How bright they are, driven by the sun — a contrail is lit, not luminous. */
export const contrailLight = { value: 1 };
/** Seconds, for the life cycle. Advanced by the world clock. */
export const contrailTime = { value: 0 };

const HOW_MANY = 4;
/** Cruising levels, metres. */
const BAND: [number, number] = [9800, 12_600];
/** Long enough to cross the whole visible sky. */
const LENGTH = 78_000;
const WIDTH = 340;

function trailRandom(i: number, salt: number): number {
  const n = Math.sin(i * 91.7 + salt * 47.3) * 43758.5453;
  return n - Math.floor(n);
}

function contrailMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTrailLight = contrailLight;
    shader.uniforms.uTrailTime = contrailTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
         attribute float aPhase;
         attribute float aRate;
         varying vec2 vTrail;
         varying float vPhase;
         varying float vRate;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
         vTrail = uv;
         vPhase = aPhase;
         vRate = aRate;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
         varying vec2 vTrail;
         varying float vPhase;
         varying float vRate;
         uniform float uTrailLight;
         uniform float uTrailTime;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
         // A life, rather than a decal.
         //
         // A contrail is drawn by an aeroplane that is *there*, and then it
         // spreads and goes. Sitting permanently across the sky, seven of them
         // fixed at the same angles for ever, they read as a texture on the
         // dome. So each one lays itself down from one end, holds, and erodes
         // from the far end — the oldest air goes first, which is why the
         // tail is the end that dissolves.
         float age = fract(uTrailTime * vRate + vPhase);
         // Both sweep past 1.0, so the trail is fully drawn for a while
         // before the tail starts catching up with it.
         float head = smoothstep(0.0, 0.52, age) * 1.3;
         float tail = smoothstep(0.42, 1.0, age) * 1.3;
         float body = smoothstep(tail, tail + 0.16, vTrail.y)
                    * (1.0 - smoothstep(head - 0.05, head, vTrail.y));

         // How long this stretch of it has been hanging there: fresh at the
         // head, spread thin at the tail.
         float old = clamp((head - vTrail.y) / 0.55, 0.0, 1.0);
         float across = 1.0 - abs(vTrail.x - 0.5) * 2.0;
         across = smoothstep(0.0, 0.22 + old * 0.72, across);
         gl_FragColor.a *= body * across * (1.0 - old * 0.55) * uTrailLight;`);
  };
  return material;
}

export function buildContrails(): THREE.Group {
  const group = new THREE.Group();
  const material = contrailMaterial();
  for (let i = 0; i < HOW_MANY; i++) {
    const geo = new THREE.PlaneGeometry(WIDTH, LENGTH);
    // Constant across the ribbon, so one shared material can still give every
    // trail its own life: a uniform would make all four breathe together.
    const n = geo.attributes.position.count;
    const phase = new Float32Array(n).fill(trailRandom(i, 31));
    // Two to four minutes each. Long enough that you rarely watch a whole
    // cycle, short enough that the sky is not the same sky twice.
    const rate = new Float32Array(n).fill(1 / (130 + trailRandom(i, 37) * 110));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('aRate', new THREE.BufferAttribute(rate, 1));
    // Laid flat. Seen from underneath — which is the only way these are ever
    // seen — a horizontal ribbon is a line across the sky, and it costs two
    // triangles rather than the six a tube would.
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(trailRandom(i, 3) * Math.PI * 2);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(
      (trailRandom(i, 11) - 0.5) * 60_000,
      BAND[0] + trailRandom(i, 17) * (BAND[1] - BAND[0]),
      (trailRandom(i, 23) - 0.5) * 60_000,
    );
    // Behind everything else that is transparent, and never writing depth, so
    // cloud and haze still compose over them correctly.
    mesh.renderOrder = -2;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  return group;
}


