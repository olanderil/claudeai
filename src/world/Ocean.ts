import * as THREE from 'three';
import { applyHaze } from './Haze';
import { SEA_LEVEL } from './Terrain';
import type { Shallows } from './Shallows';

const OCEAN_SIZE = 400000;
/** World size of one normal-map tile, metres. */
const WAVE_TILE = 900;
const TEXTURE_SIZE = 512;

/**
 * Where the wave normals stop being resolvable.
 *
 * Measured in *texel footprints* — how much of the normal map a single screen
 * pixel covers — rather than in metres. Distance alone is the wrong variable:
 * a pixel's footprint on a horizontal plane stretches as roughly d²·θ/h, so at
 * 600 m up the waves are still resolvable at 1.5 km while at 80 m up the same
 * 1.5 km is already thirteen texels per pixel. A distance threshold tuned for
 * one altitude is wrong at every other. The GPU knows the real footprint, so
 * ask it.
 *
 * Past a texel per pixel the shading is decided by normals the pixel cannot
 * resolve, and mipmapping does not save it: averaging normal *vectors* shortens
 * them but does not widen the specular lobe they imply, so a near-mirror
 * surface keeps returning full-strength highlights from whichever sub-pixel
 * wave happens to face the sun. The map scrolls, the winners change every
 * frame, and the sea scintillates — worst when the sun's specular path is in
 * view, which is why it showed up at morning, noon and golden hour.
 */
const WAVE_FADE_START = 1.2;
const WAVE_FADE_END = 9.0;
/** Roughness the sea reaches once its waves are no longer resolvable. */
const WAVE_FAR_ROUGHNESS = 0.34;

/**
 * The default shallow-water palette: a temperate coast.
 *
 * Green-grey rather than turquoise, because most of these worlds are cold or
 * temperate and their shallows are silt, not coral sand. The tropical world
 * overrides both through `setWaterStyle`.
 */
const SHALLOW_TINT = 0x2f6f74;
const SAND_TINT = 0x7e8f7a;

/**
 * How much light a shallow bottom throws back, before a world says otherwise.
 *
 * Restrained by default: a silty temperate shore should read as "you can tell
 * where the shallows are", not as a swimming pool. The tropical world turns it
 * up, because there the water is the subject rather than the setting.
 */
const DEFAULT_GLOW = 0.18;

/**
 * The sea.
 *
 * Deliberately not three's `Water`: that renders the scene a second time for
 * planar reflections, which would double the cost of the LOD terrain for
 * something barely visible from altitude. Instead this is an ordinary PBR
 * surface — low roughness so it picks up the sky through the environment map,
 * plus a scrolling normal map for waves and the sun's specular highlight.
 */
export class Ocean {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly normalMap: THREE.CanvasTexture;
  /**
   * The shader's state, held here rather than read back out of the uniforms.
   *
   * `onBeforeCompile` does not run until the sea is first drawn, so anything
   * that writes uniforms directly is a no-op if it happens before that — and
   * `applyStyle` runs when the world is selected, which is always earlier. The
   * lagoon opened in temperate grey-green for exactly that reason. These are
   * the objects the uniforms are given, so writing to them works whichever
   * order the two happen in.
   */
  private readonly shallowTint = new THREE.Color(SHALLOW_TINT);
  private readonly sandTint = new THREE.Color(SAND_TINT);
  private readonly shallowsOrigin = new THREE.Vector2();
  private shallowsMap: THREE.Texture | null = null;
  private shallowsSpan = 1;
  private shallowGlow = DEFAULT_GLOW;
  private uShallows: THREE.IUniform | null = null;
  private uShallowsSpan: THREE.IUniform | null = null;
  private uShallowGlow: THREE.IUniform | null = null;

  constructor() {
    this.normalMap = makeWaveNormalMap();
    this.normalMap.wrapS = THREE.RepeatWrapping;
    this.normalMap.wrapT = THREE.RepeatWrapping;
    this.normalMap.repeat.set(OCEAN_SIZE / WAVE_TILE, OCEAN_SIZE / WAVE_TILE);

    this.material = new THREE.MeshStandardMaterial({
      color: 0x0a2536,
      roughness: 0.075,
      metalness: 0.0,
      normalMap: this.normalMap,
      normalScale: new THREE.Vector2(0.55, 0.55),
      envMapIntensity: 1.5,
    });
    this.fadeDistantWaves(this.material);

    const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.position.y = SEA_LEVEL;
    // A single flat quad this large is always in view; skipping the frustum
    // test avoids it popping out when its centre leaves the frustum.
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = false;
  }

  /**
   * Trade unresolvable wave detail for roughness with distance.
   *
   * The cheap stand-in for Toksvig/LEAN mapping: where the waves can no longer
   * be resolved, flatten the normal back to the plane and widen the specular
   * lobe to stand in for the detail that was lost. Distant sea then reads as a
   * smooth sheet reflecting the sky — which is what it looks like from altitude
   * anyway — instead of a field of flashing pinpricks.
   */
  private fadeDistantWaves(material: THREE.MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      // The sea runs to the horizon, which is where haze does its clearest
      // work — a flat fog colour out there reads as a wall rather than as
      // distance.
      applyHaze(shader);
      const texel = WAVE_TILE / TEXTURE_SIZE;
      shader.uniforms.uFadeStart = { value: texel * WAVE_FADE_START };
      shader.uniforms.uFadeEnd = { value: texel * WAVE_FADE_END };
      shader.uniforms.uFarRoughness = { value: WAVE_FAR_ROUGHNESS };
      // Given the live objects, so whatever was set before this compiled is
      // already in them and anything set afterwards lands without a recompile.
      this.uShallows = shader.uniforms.uShallows = { value: this.shallowsMap };
      this.uShallowsSpan = shader.uniforms.uShallowsSpan = { value: this.shallowsSpan };
      shader.uniforms.uShallowsOrigin = { value: this.shallowsOrigin };
      shader.uniforms.uShallowTint = { value: this.shallowTint };
      shader.uniforms.uSandTint = { value: this.sandTint };
      this.uShallowGlow = shader.uniforms.uShallowGlow = { value: this.shallowGlow };

      // World position rather than a distance computed per vertex: the sea is
      // two triangles 400 km across, so anything non-linear interpolated across
      // it is badly wrong in between. Position is linear, so this is exact —
      // and its screen-space derivative is exactly the footprint we need.
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSeaWorld;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvSeaWorld = (modelMatrix * vec4(position, 1.0)).xyz;',
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vSeaWorld;\n'
          + 'uniform float uFadeStart;\nuniform float uFadeEnd;\nuniform float uFarRoughness;\n'
          + 'uniform sampler2D uShallows;\nuniform vec2 uShallowsOrigin;\n'
          + 'uniform float uShallowsSpan;\n'
          + 'uniform vec3 uShallowTint;\nuniform vec3 uSandTint;\n'
          + 'uniform float uShallowGlow;',
        )
        // Colour by what is underneath.
        //
        // The map holds depth 0..1 over `DEEP_WATER`, so the ramp is: sand
        // where the bottom is all but dry, the shallow tint over the lagoon
        // floor, and the material's own deep colour once the bottom stops
        // mattering. Both hops are smoothsteps rather than a single mix,
        // because a linear fade from white sand to navy passes through a grey
        // that no sea has ever been.
        //
        // Applied to `diffuseColor` before lighting, so the shallows still take
        // the sun's specular and the sky's reflection exactly as the deep sea
        // does — this changes the colour of the water, not the surface of it.
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n'
          + 'vec2 seaUv = (vSeaWorld.xz - uShallowsOrigin) / uShallowsSpan;\n'
          + 'float seaBed = texture2D(uShallows, clamp(seaUv, 0.0, 1.0)).r;\n'
          + 'if (seaUv.x < 0.0 || seaUv.x > 1.0 || seaUv.y < 0.0 || seaUv.y > 1.0) seaBed = 1.0;\n'
          + 'float seaShoal = 1.0 - smoothstep(0.10, 0.95, seaBed);\n'
          + 'vec3 seaShallow = mix(uSandTint, uShallowTint, smoothstep(0.0, 0.22, seaBed));\n'
          + 'diffuseColor.rgb = mix(seaShallow, diffuseColor.rgb,'
          + ' smoothstep(0.22, 0.92, seaBed));',
        )
        // Shallow water is not a mirror.
        //
        // Deep sea is polished because there is nothing under it to break the
        // reflection; a metre of water over coral sand is scattering light in
        // every direction. Without this the lagoon keeps the open sea's 0.075
        // roughness, reflects the sky like glass at any grazing angle, and
        // reads as the same grey as everything else — which is exactly how it
        // first came out.
        .replace(
          'roughnessFactor = mix(roughnessFactor, uFarRoughness, seaFade);',
          'roughnessFactor = mix(roughnessFactor, uFarRoughness, seaFade);\n'
          + 'roughnessFactor = mix(roughnessFactor, 0.42, seaShoal * 0.85);',
        )
        // Light coming back off the bottom.
        //
        // The colour of a lagoon is not its albedo — it is light that went into
        // the water, bounced off the sand and came back out, which is radiance
        // *added* to whatever the surface is reflecting. Tinting `diffuseColor`
        // alone put it under the Fresnel term, so it showed looking straight
        // down and vanished at every angle you actually fly at.
        .replace(
          '#include <opaque_fragment>',
          'outgoingLight += seaShallow * seaShoal * uShallowGlow;\n'
          + '#include <opaque_fragment>',
        )
        // Roughness first: its chunk runs before the normal chunks, so the fade
        // has to be in scope by then.
        .replace(
          '#include <roughnessmap_fragment>',
          // How much sea one pixel covers, straight from the rasteriser.
          'float seaStep = max(length(dFdx(vSeaWorld)), length(dFdy(vSeaWorld)));\n'
          + 'float seaFade = smoothstep(uFadeStart, uFadeEnd, seaStep);\n'
          + '#include <roughnessmap_fragment>\n'
          + 'roughnessFactor = mix(roughnessFactor, uFarRoughness, seaFade);',
        )
        .replace(
          '#include <normal_fragment_maps>',
          'vec3 seaFlat = normal;\n'
          + '#include <normal_fragment_maps>\n'
          + 'normal = normalize(mix(normal, seaFlat, seaFade));',
        );
    };
    // Without this the ocean and the terrain — both MeshStandardMaterial with an
    // onBeforeCompile — can be handed each other's compiled program.
    material.customProgramCacheKey = () => 'ocean-waves-v3-shallows';
  }

  /**
   * Point the surface at the depth map that follows the aircraft.
   *
   * Safe to call before the material has compiled — the uniforms are created in
   * `onBeforeCompile`, so this simply does nothing until the first frame that
   * draws the sea, and the values are pushed every frame after that.
   */
  setShallows(shallows: Shallows | null): void {
    this.shallowsMap = shallows === null ? null : shallows.texture;
    if (shallows !== null) {
      this.shallowsOrigin.copy(shallows.origin);
      this.shallowsSpan = shallows.span;
    }
    // The sampler and the span are plain values rather than objects, so unlike
    // the colours they do have to be pushed once the uniforms exist.
    if (this.uShallows !== null) this.uShallows.value = this.shallowsMap;
    if (this.uShallowsSpan !== null) this.uShallowsSpan.value = this.shallowsSpan;
  }

  /** How this world's shallow water and its wet sand are coloured. */
  setWaterStyle(deep: number, shallow: number, sand: number, glow = DEFAULT_GLOW): void {
    this.material.color.setHex(deep);
    this.shallowTint.setHex(shallow);
    this.sandTint.setHex(sand);
    this.shallowGlow = glow;
    if (this.uShallowGlow !== null) this.uShallowGlow.value = glow;
  }

  update(dt: number): void {
    // Scroll diagonally so the tiling doesn't read as a grid marching past.
    this.normalMap.offset.x += dt * 0.006;
    this.normalMap.offset.y += dt * 0.0042;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.normalMap.dispose();
  }
}

/**
 * A seamless wave normal map built from a sum of directional sine waves.
 *
 * Using integer wave numbers makes the result exactly periodic, so the texture
 * tiles without a seam — which matters here because a single tile covers ~900 m
 * of open water and any discontinuity would show as a hard line across the sea.
 */
function makeWaveNormalMap(): THREE.CanvasTexture {
  const size = TEXTURE_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Ocean: could not create a 2D context for the wave map');

  // A small directional spectrum: a few long swells plus shorter chop.
  const waves: { kx: number; ky: number; amp: number; phase: number }[] = [];
  let seed = 12345;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 14; i++) {
    const kx = Math.round(rand() * 8 - 4) || 1;
    const ky = Math.round(rand() * 8 - 4) || 1;
    const wavelength = Math.hypot(kx, ky);
    waves.push({
      kx,
      ky,
      amp: 1 / (wavelength * wavelength),
      phase: rand() * Math.PI * 2,
    });
  }

  const height = new Float32Array(size * size);
  let peak = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      for (const w of waves) {
        h += w.amp * Math.sin(2 * Math.PI * (w.kx * u + w.ky * v) + w.phase);
      }
      height[y * size + x] = h;
      peak = Math.max(peak, Math.abs(h));
    }
  }

  const image = ctx.createImageData(size, size);
  const strength = 2.2 / (peak || 1);
  const at = (x: number, y: number): number =>
    height[((y + size) % size) * size + ((x + size) % size)] * strength;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = at(x + 1, y) - at(x - 1, y);
      const dy = at(x, y + 1) - at(x, y - 1);
      // Tangent-space normal from the height gradient.
      const nx = -dx;
      const ny = -dy;
      const nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const o = (y * size + x) * 4;
      image.data[o] = (nx * inv * 0.5 + 0.5) * 255;
      image.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      image.data[o + 2] = (nz * inv * 0.5 + 0.5) * 255;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace; // normals are data, not colour
  // The sea is viewed at grazing angles for most of the screen, where a pixel's
  // footprint is stretched far along the view direction. Anisotropic sampling is
  // what keeps that from collapsing onto one over-sharp mip.
  texture.anisotropy = 16;
  return texture;
}
