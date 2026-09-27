import * as THREE from 'three';

/**
 * Billboard particles: smoke, fire, sparks, debris, dust and spray, one draw
 * call per system.
 *
 * The renderer runs a logarithmic depth buffer and a half-float HDR target
 * with ACES at a low exposure, so this is a raw shader that (a) opts into log
 * depth by hand, like the clouds do, (b) lights smoke with the scene's own sun
 * and sky colours rather than baking a brightness in, and (c) keeps additive
 * fire bright enough to reach the bloom threshold without running to Inf.
 */

/** Per-particle floats: pos3 vel3 age life s0 s1 c0(3) c1(3) a0 a1 drag grav rot spin. */
const STRIDE = 22;

export interface Lighting {
  sun: THREE.Color;
  sky: THREE.Color;
  sunDir: THREE.Vector3;
  fogColor: THREE.Color;
  fogDensity: number;
}

const VERT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 iOffset;
  attribute vec4 iColor;
  attribute vec3 iMisc; // size, rotation, heat
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFogDepth;
  varying float vHeat;
  varying float vFacing;
  uniform vec3 uSunDir;
  void main() {
    vUv = uv;
    vColor = iColor;
    vHeat = iMisc.z;
    vec4 mv = modelViewMatrix * vec4(iOffset, 1.0);
    float c = cos(iMisc.y), s = sin(iMisc.y);
    mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iMisc.x;
    // Fade anything that would fill the lens.
    vColor.a *= clamp((-mv.z - 0.4) / (iMisc.x * 0.8 + 0.01), 0.0, 1.0);
    // How much the camera looks toward the sun through this puff: back-lit smoke glows.
    vec3 viewDir = normalize((modelMatrix * vec4(iOffset, 1.0)).xyz - cameraPosition);
    vFacing = max(dot(viewDir, uSunDir), 0.0);
    vFogDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }
`;

const FRAG = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 uSun;
  uniform vec3 uSky;
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float uGain;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vFogDepth;
  varying float vHeat;
  varying float vFacing;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    float a = vColor.a * t.a;
    if (a < 0.004) discard;
    #ifdef ADDITIVE
      vec3 col = vColor.rgb * t.rgb * uGain;
      float fog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      gl_FragColor = vec4(col * a * (1.0 - fog), 1.0);
    #else
      // Lit smoke: sky fill from above, sun key, a little forward scatter, and
      // self-emission from the fire inside a fresh burst (vHeat).
      float shade = mix(0.55, 1.0, t.g);
      vec3 lit = vColor.rgb * (uSky * 0.9 + uSun * (0.35 * shade + 0.5 * pow(vFacing, 6.0)));
      lit += vec3(1.0, 0.45, 0.12) * vHeat * 2.5 * t.r;
      float fog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      lit = mix(lit, fogColor, fog);
      gl_FragColor = vec4(lit, a);
    #endif
  }
`;

export class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private readonly data: Float32Array;
  private readonly offsets: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly misc: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;
  private live = 0;

  constructor(readonly max: number, map: THREE.Texture, readonly additive: boolean, renderOrder: number, gain = 1) {
    this.data = new Float32Array(max * STRIDE);
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.offsets = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.misc = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.offsets, this.colors, this.misc]) a.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('iOffset', this.offsets);
    this.geometry.setAttribute('iColor', this.colors);
    this.geometry.setAttribute('iMisc', this.misc);
    this.geometry.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: map },
        uSun: { value: new THREE.Color(3, 2.8, 2.5) },
        uSky: { value: new THREE.Color(0.9, 1, 1.2) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        fogColor: { value: new THREE.Color(0xa8c2d8) },
        fogDensity: { value: 1.85e-5 },
        uGain: { value: gain },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: additive ? { ADDITIVE: '' } : {},
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  setLighting(l: Lighting): void {
    const u = this.material.uniforms;
    (u.uSun.value as THREE.Color).copy(l.sun);
    (u.uSky.value as THREE.Color).copy(l.sky);
    (u.uSunDir.value as THREE.Vector3).copy(l.sunDir);
    (u.fogColor.value as THREE.Color).copy(l.fogColor);
    u.fogDensity.value = l.fogDensity;
  }

  /**
   * Emit one particle. Sizes s0→s1 and colours c0→c1 (linear RGB arrays)
   * interpolate over the life; `heat` makes smoke glow from within while young.
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number,
    c0: readonly number[], c1: readonly number[],
    a0: number, a1: number, drag: number, grav: number, heat = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o = i * STRIDE;
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z;
    d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    d[o + 6] = 0; d[o + 7] = life;
    d[o + 8] = s0; d[o + 9] = s1;
    d[o + 10] = c0[0]; d[o + 11] = c0[1]; d[o + 12] = c0[2];
    d[o + 13] = c1[0]; d[o + 14] = c1[1]; d[o + 15] = c1[2];
    d[o + 16] = a0; d[o + 17] = a1;
    d[o + 18] = drag; d[o + 19] = grav;
    d[o + 20] = Math.random() * Math.PI * 2;
    d[o + 21] = heat;
  }

  clear(): void {
    for (let i = 0; i < this.max; i++) this.data[i * STRIDE + 7] = 0;
    this.geometry.instanceCount = 0;
  }

  get count(): number {
    return this.live;
  }

  update(dt: number, wind: THREE.Vector3): void {
    const d = this.data;
    const off = this.offsets.array as Float32Array;
    const col = this.colors.array as Float32Array;
    const misc = this.misc.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      const o = i * STRIDE;
      const life = d[o + 7];
      if (life <= 0) continue;
      const age = d[o + 6] + dt;
      if (age >= life) {
        d[o + 7] = 0;
        continue;
      }
      d[o + 6] = age;
      const t = age / life;
      const k = Math.exp(-d[o + 18] * dt);
      // Drag relaxes the velocity toward the wind, not toward zero.
      d[o + 3] = wind.x + (d[o + 3] - wind.x) * k;
      d[o + 4] = (d[o + 4] + d[o + 19] * dt) * k;
      d[o + 5] = wind.z + (d[o + 5] - wind.z) * k;
      d[o] += d[o + 3] * dt;
      d[o + 1] += d[o + 4] * dt;
      d[o + 2] += d[o + 5] * dt;
      off[n * 3] = d[o];
      off[n * 3 + 1] = d[o + 1];
      off[n * 3 + 2] = d[o + 2];
      const e = t * (2 - t);
      col[n * 4] = d[o + 10] + (d[o + 13] - d[o + 10]) * t;
      col[n * 4 + 1] = d[o + 11] + (d[o + 14] - d[o + 11]) * t;
      col[n * 4 + 2] = d[o + 12] + (d[o + 15] - d[o + 12]) * t;
      // Fade in over the first 8% so nothing pops.
      col[n * 4 + 3] = (d[o + 16] + (d[o + 17] - d[o + 16]) * t) * Math.min(1, t * 12.5);
      misc[n * 3] = d[o + 8] + (d[o + 9] - d[o + 8]) * e;
      misc[n * 3 + 1] = d[o + 20] + age * 0.3;
      misc[n * 3 + 2] = d[o + 21] * Math.max(0, 1 - t * 4);
      n++;
    }
    this.live = n;
    this.geometry.instanceCount = n;
    this.offsets.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.misc.needsUpdate = true;
    this.offsets.clearUpdateRanges();
    this.colors.clearUpdateRanges();
    this.misc.clearUpdateRanges();
    if (n > 0) {
      this.offsets.addUpdateRange(0, n * 3);
      this.colors.addUpdateRange(0, n * 4);
      this.misc.addUpdateRange(0, n * 3);
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ---------------------------------------------------------------- textures */

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A billowing smoke puff: many soft lumps, with a self-shadow term in the
 * green channel (lit side up) the shader uses to shade it, and a hot core in
 * red for the self-lit fire glow.
 */
export function puffTexture(size: number, lumps: number, seed: number, soft: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const r = mulberry32(seed);
  const img = x.createImageData(size, size);
  const alpha = new Float32Array(size * size);
  const lit = new Float32Array(size * size);
  const blobs: [number, number, number][] = [];
  for (let i = 0; i < lumps; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.26;
    blobs.push([0.5 + Math.cos(a) * d, 0.5 + Math.sin(a) * d, 0.12 + r() * 0.16]);
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;
      let a = 0;
      let l = 0;
      for (const [bx, by, br] of blobs) {
        const dd = Math.hypot(u - bx, v - by) / br;
        if (dd < 1) {
          const f = Math.pow(1 - dd * dd, 1.5);
          a += f;
          // Lit from above: the top of each lump is brighter.
          l += f * (0.5 + 0.5 * (by - v) / br);
        }
      }
      const n = 0.75 + 0.25 * Math.sin(u * 37 + r() * 0.3) * Math.cos(v * 29);
      const k = py * size + px;
      alpha[k] = Math.min(1, a * soft) * n;
      lit[k] = a > 0 ? Math.min(1, 0.45 + (l / a) * 0.9) : 0;
    }
  }
  for (let k = 0; k < size * size; k++) {
    const u = (k % size) / size - 0.5;
    const v = Math.floor(k / size) / size - 0.5;
    const core = Math.max(0, 1 - Math.hypot(u, v) * 3.2);
    img.data[k * 4] = Math.round(core * 255);
    img.data[k * 4 + 1] = Math.round(lit[k] * 255);
    img.data[k * 4 + 2] = 255;
    img.data[k * 4 + 3] = Math.round(alpha[k] * 255);
  }
  x.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** A radial glow for fire and flashes: white-hot centre, soft falloff. */
export function glowTexture(size = 64, hardness = 1): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18 * hardness, 'rgba(255,240,215,0.85)');
  g.addColorStop(0.5, 'rgba(255,190,120,0.28)');
  g.addColorStop(1, 'rgba(255,160,90,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Tongues of flame: a flickery, uneven glow so fire isn't a row of circles. */
export function flameTexture(size = 128, seed = 3): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d') as CanvasRenderingContext2D;
  const r = mulberry32(seed);
  x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 26; i++) {
    const cx = size * (0.3 + r() * 0.4);
    const cy = size * (0.3 + r() * 0.45);
    const rad = size * (0.08 + r() * 0.16);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, 'rgba(255,230,170,0.55)');
    g.addColorStop(0.5, 'rgba(255,140,50,0.22)');
    g.addColorStop(1, 'rgba(200,60,10,0)');
    x.fillStyle = g;
    x.beginPath();
    x.ellipse(cx, cy, rad * 0.7, rad * 1.2, (r() - 0.5) * 0.6, 0, Math.PI * 2);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}
