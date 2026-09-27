import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface PostFXOptions {
  bloom: boolean;
  bloomStrength: number;
  /**
   * Linear-HDR luminance above which pixels bloom. Must sit above the level of
   * ordinary sunlit surfaces — a lit landscape at noon is already well past 1.0
   * in this scene, so a threshold near 1 blooms the entire image white instead
   * of picking out the sun, snow and the afterburner.
   */
  bloomThreshold: number;
  /** MSAA samples on the HDR target. 0 disables. */
  samples: number;
  grain: number;
  vignette: number;
  /** Whether the cinematic camera may defocus the background. */
  depthOfField: boolean;
}

/**
 * HDR post-processing chain.
 *
 * The scene is rendered *linear* into a half-float target — three disables
 * material tone mapping automatically when drawing into a render target — so
 * bloom operates on true high-dynamic-range values and only genuinely bright
 * things (the sun, the afterburner) bleed. Tone mapping and the sRGB conversion
 * happen once at the very end in OutputPass. Doing it the other way round, on
 * already-tone-mapped colour, makes bloom wash out the whole image instead of
 * picking out highlights.
 *
 * Anti-aliasing is MSAA on the HDR target rather than a post-process filter:
 * geometry edges here are long thin terrain silhouettes and aircraft edges,
 * which multisampling resolves far more cleanly than an image-space filter.
 */
export class PostFX {
  readonly composer: EffectComposer;
  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly dofPass: ShaderPass;
  private readonly gradePass: ShaderPass;
  private readonly outputPass: OutputPass;
  private target: THREE.WebGLRenderTarget;
  private options: PostFXOptions;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    options: PostFXOptions,
  ) {
    this.options = { ...options };

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = createTarget(size.x, size.y, this.options.samples);
    // Depth of field needs to know how far away each pixel is, and the only
    // place that exists is the depth attachment.
    this.target.depthTexture = new THREE.DepthTexture(
      Math.max(1, size.x),
      Math.max(1, size.y),
      THREE.UnsignedIntType,
    );

    this.composer = new EffectComposer(renderer, this.target);
    this.composer.setPixelRatio(renderer.getPixelRatio());

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Defocus first, bloom second: the lens blurs, then the highlights spill.
    // The other order smears an already-bloomed image and the glow goes with it.
    this.dofPass = new ShaderPass(dofShader());
    this.dofPass.enabled = false;
    this.composer.addPass(this.dofPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      this.options.bloomStrength,
      0.6, // radius
      this.options.bloomThreshold,
    );
    this.bloomPass.enabled = this.options.bloom;
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(gradeShader());
    this.gradePass.uniforms.uGrain.value = this.options.grain;
    this.gradePass.uniforms.uVignette.value = this.options.vignette;
    this.composer.addPass(this.gradePass);

    // Tone map + colour space, last.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  setCamera(camera: THREE.Camera): void {
    this.renderPass.camera = camera;
  }

  configure(options: Partial<PostFXOptions>): void {
    Object.assign(this.options, options);
    this.bloomPass.enabled = this.options.bloom;
    this.bloomPass.strength = this.options.bloomStrength;
    this.bloomPass.threshold = this.options.bloomThreshold;
    this.gradePass.uniforms.uGrain.value = this.options.grain;
    this.gradePass.uniforms.uVignette.value = this.options.vignette;

    // Sample count is baked into the render target, so changing it needs a new one.
    if (this.target.samples !== this.options.samples) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const next = createTarget(size.x, size.y, this.options.samples);
      this.target.dispose();
      this.target = next;
      this.composer.reset(next);
    }
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.bloomPass.setSize(size.x, size.y);
    this.target.depthTexture?.dispose();
    this.target.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType);
    this.dofPass.uniforms.tDepth.value = this.target.depthTexture;
    this.dofPass.uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    // Snowflakes are drawn in a cell grid over UV space, which is not square.
    this.gradePass.uniforms.uAspect.value = w / h;
  }

  /**
   * Shallow depth of field, as a cinema lens rather than a physical one.
   *
   * `focus` is the distance the lens is sharp at, in metres, and `aperture` is
   * how fast the world falls away either side of it — 0 turns the pass off
   * entirely, which is how a shot opts out.
   *
   * The focus distance is *given*, not searched for: the director always knows
   * exactly where the subject is, so there is no autofocus to hunt, and a rack
   * focus is just this number moving.
   */
  setFocus(focus: number, aperture: number, far: number): void {
    const on = aperture > 0.001 && this.options.depthOfField;
    this.dofPass.enabled = on;
    if (!on) return;
    this.dofPass.uniforms.uFocus.value = focus;
    this.dofPass.uniforms.uAperture.value = aperture;
    // The inverse of three's logarithmic depth: it writes
    // log2(1 + w) * logDepthBufFC * 0.5, so w comes back as
    // 2^(2 * depth / logDepthBufFC) - 1. Reading this buffer as though it were
    // an ordinary depth buffer gives a plausible-looking and completely wrong
    // blur, which is the trap worth naming.
    this.dofPass.uniforms.uLogFC.value = 2 / (Math.log(far + 1) / Math.LN2);
  }

  /** Show the reconstructed distance instead of the image, to prove it is real. */
  setDepthDebug(on: boolean): void {
    this.dofPass.uniforms.uDebug.value = on ? 1 : 0;
  }

  /**
   * Weather effects, all 0..1: rain streak density, a lightning flash, and
   * snowfall. Rain and snow are the same falling water in different seasons, so
   * the caller sends one or the other, never both.
   */
  /**
   * How much of the frame the fog you are standing in has swallowed.
   *
   * The ground fog is drawn by the materials that opt into the haze — terrain
   * and ocean — which is right for looking *at* fog and useless for being
   * inside it: the sky takes no part in it, so from within a bank you would
   * see white ground under a blue dome. Real fog is white in every direction
   * including up, and the only place that can be said about every pixel at
   * once is here.
   */
  setFogWash(amount: number, colour: THREE.Color): void {
    this.gradePass.uniforms.uFogWash.value = amount;
    this.gradePass.uniforms.uFogWashColour.value.copy(colour);
  }

  setWeatherFX(rain: number, flash: number, snow = 0): void {
    this.gradePass.uniforms.uRain.value = rain;
    this.gradePass.uniforms.uFlash.value = flash;
    this.gradePass.uniforms.uSnow.value = snow;
  }

  render(dt: number): void {
    this.gradePass.uniforms.uTime.value += dt;
    this.composer.render(dt);
  }

  dispose(): void {
    this.composer.dispose();
    this.target.dispose();
  }
}

/**
 * Depth of field.
 *
 * One pass, a poisson disk whose radius comes from the pixel's distance from
 * the focus plane. Deliberately not a full near/far separated implementation:
 * the background falling away behind a subject is the whole look, and that is
 * the half a single pass does well.
 */
function dofShader(): THREE.ShaderMaterialParameters {
  return {
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uFocus: { value: 40 },
      uAperture: { value: 0 },
      // Metres either side of the focus plane that stay sharp: enough to hold
      // the whole airframe from any angle, with margin.
      uSharpBand: { value: 24 },
      uLogFC: { value: 0.1 },
      uDebug: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform vec2 uTexel;
      uniform float uFocus;
      uniform float uAperture;
      uniform float uSharpBand;
      uniform float uLogFC;
      uniform float uDebug;
      varying vec2 vUv;

      // Twelve points on a disk, spiralled so they do not line up into spokes.
      const int TAPS = 12;
      vec2 tap(int i) {
        float f = (float(i) + 0.5) / float(TAPS);
        float a = f * 6.2831853 * 3.0;      // three turns
        return vec2(cos(a), sin(a)) * sqrt(f);
      }

      float viewDepth(vec2 uv) {
        float d = texture2D(tDepth, uv).x;
        return exp2(2.0 * d / uLogFC) - 1.0;
      }

      void main() {
        float w = viewDepth(vUv);
        if (uDebug > 0.5) {
          float g = clamp(log2(w + 1.0) / 14.0, 0.0, 1.0);
          gl_FragColor = vec4(vec3(g), 1.0);
          return;
        }

        // Circle of confusion.
        //
        // The subject is *not* a point. An aircraft seventeen metres long, shot
        // from ten, spans nearly its own length in depth — and a CoC divided by
        // distance turns that into a heavy blur, so the thing the lens is
        // focused on came out soft. So there is a band either side of the focus
        // plane that stays perfectly sharp, sized to the subject rather than to
        // the distance, and the falloff starts beyond it.
        float delta = abs(w - uFocus);
        float ramp = max(uFocus * 4.0, 260.0);
        float coc = clamp((delta - uSharpBand) / ramp, 0.0, 1.0) * uAperture;
        coc = clamp(coc, 0.0, 1.0);

        // Softer, not blurrier. The point is that the eye settles on the
        // aircraft, not that the landscape is unrecognisable.
        float radius = coc * 16.0;
        if (radius < 0.7) {
          gl_FragColor = texture2D(tDiffuse, vUv);
          return;
        }

        vec4 sum = texture2D(tDiffuse, vUv);
        float weight = 1.0;
        for (int i = 0; i < TAPS; i++) {
          vec2 offset = tap(i) * radius * uTexel;
          vec2 uv = vUv + offset;
          // Skip anything markedly *nearer* than this pixel: without it a sharp
          // foreground smears its neighbours' colour over itself and the
          // subject grows a halo.
          float tw = viewDepth(uv);
          float ok = step(w * 0.85, tw);
          sum += texture2D(tDiffuse, uv) * ok;
          weight += ok;
        }
        gl_FragColor = sum / weight;
      }
    `,
  };
}

function createTarget(width: number, height: number, samples: number): THREE.WebGLRenderTarget {
  // `samples` must be passed at construction — three builds the (multisampled)
  // framebuffer from the options, and assigning it afterwards can leave the
  // attachment and the sample count disagreeing.
  return new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    type: THREE.HalfFloatType, // headroom for HDR highlights
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    samples,
  });
}

/**
 * Final grade, applied in linear space before tone mapping: a soft vignette and
 * a little animated grain. Both are deliberately subtle — they exist to stop the
 * image looking digitally clean, not to be noticed.
 */
function gradeShader(): THREE.ShaderMaterialParameters & { uniforms: Record<string, THREE.IUniform> } {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uGrain: { value: 0.03 },
      uVignette: { value: 0.35 },
      uRain: { value: 0 },
      uFlash: { value: 0 },
      uSnow: { value: 0 },
      uAspect: { value: 16 / 9 },
      uFogWash: { value: 0 },
      uFogWashColour: { value: new THREE.Color(0.88, 0.90, 0.93) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uGrain;
      uniform float uVignette;
      uniform float uRain;
      uniform float uFlash;
      uniform float uSnow;
      uniform float uAspect;
      uniform float uFogWash;
      uniform vec3 uFogWashColour;
      varying vec2 vUv;

      float hash(vec2 p) {
        p = fract(p * vec2(443.897, 441.423));
        p += dot(p, p + 19.19);
        return fract(p.x * p.y);
      }

      /** Two independent randoms per cell: one to place a flake, one to shape it. */
      vec2 hash2(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * vec3(443.897, 441.423, 437.195));
        q += dot(q, q.yzx + 19.19);
        return fract(vec2((q.x + q.y) * q.z, (q.x + q.z) * q.y));
      }

      /**
       * One depth of snowfall.
       *
       * A grid of cells, at most one flake in each, but nothing about it should
       * look like a grid: the flake is placed at a random point inside its cell,
       * given its own size, and wanders sideways on its own frequency and phase.
       * A single global sway over the top would move the whole field in lockstep,
       * which reads as a curtain rather than as separate flakes.
       *
       * The radius is a fraction of screen height, not of a cell, so a flake is
       * the same size on screen whichever layer it belongs to and whatever the
       * window. Cells are squared up by aspect so flakes stay round.
       */
      float snowLayer(vec2 uv, float cells, float speed, float radius,
                      float density, float seed) {
        vec2 sp = vec2(uv.x * uAspect, uv.y) * cells;
        sp.y += uTime * speed * cells;
        vec2 cell = floor(sp);
        vec2 f = fract(sp);

        vec2 r = hash2(cell + seed);
        float present = step(r.x, density);

        // Somewhere inside its own cell, not at the centre of it.
        vec2 at = vec2(r.y, fract(r.x * 41.3 + 0.37));
        at.x += sin(uTime * (0.45 + r.y * 0.9) + r.x * 31.0) * 0.20;

        float size = radius * cells * (0.6 + fract(r.y * 17.7) * 0.85);
        return present * smoothstep(size, 0.0, length(f - at));
      }

      /**
       * One depth of rainfall.
       *
       * Built the way the snow is, and for the same reason: a single sheet of
       * identical streaks on a regular lattice is what reads as a lens defect
       * rather than as weather. Everything here varies drop to drop — where in
       * its cell it sits, how long it is, how wide, how bright — and every
       * layer varies again against the others.
       *
       * The streak is not symmetric. A raindrop crossing the frame in one
       * exposure is a bright point smeared behind itself, so it is brightest
       * at its leading end and trails off above; a dash with the same weight
       * at both ends has no direction in it and looks painted on.
       */
      float rainLayer(vec2 uv, vec2 cells, float speed, float shear,
                      float len, float wide, float density, float seed) {
        vec2 rp = vec2(uv.x * uAspect, uv.y);
        rp.x += rp.y * shear;
        rp *= cells;
        // Speed in screens per second, not cells per second.
        //
        // Multiplying by the cell count is what keeps the layers comparable:
        // without it a "slow" far layer with two hundred cells across the
        // frame advances a fiftieth as far per second as a near one with
        // twenty-six, which is not slower, it is stopped.
        rp.y += uTime * speed * cells.y;
        // Carried sideways as well: rain past a cockpit is going backwards
        // nearly as fast as it is going down.
        rp.x += uTime * speed * cells.y * 0.26;

        vec2 cell = floor(rp);
        vec2 f = fract(rp);
        vec2 r = hash2(cell + seed);

        // Placed inside its own cell rather than on the middle of it. Centring
        // every streak is the whole of what made the old rain a visible grid.
        float px = 0.15 + r.y * 0.7;
        float py = fract(r.x * 37.7 + 0.19);

        float dl = len * (0.5 + fract(r.y * 23.3) * 1.0);
        float dw = wide * (0.7 + r.x * 0.7);

        float across = smoothstep(dw, 0.0, abs(f.x - px));
        float dy = f.y - py;
        float along = smoothstep(dl, 0.0, abs(dy));
        // The trailing half is the dim one, and which half that is depends on
        // which way the drop is travelling through the cell.
        along *= 0.5 + 0.5 * smoothstep(dl * 0.7, -dl * 0.2, dy);

        return step(r.x, density) * across * along * (0.55 + r.y * 0.8);
      }

      void main() {
        vec4 color = texture2D(tDiffuse, vUv);

        // Lightning: a full-frame lift, applied before the vignette so the
        // corners still fall off and it reads as light rather than a white card.
        color.rgb += uFlash;

        // Inside a fog bank. Ahead of the precipitation, so rain and snow are
        // still visible through it — close enough to the canopy to be seen is
        // exactly what they are.
        if (uFogWash > 0.001) {
          color.rgb = mix(color.rgb, uFogWashColour, uFogWash);
        }

        // Rain, in screen space. Real geometry would be wasted here — at flight
        // speed the streaks are a windscreen effect, not objects in the world.
        //
        // Four depths, near to far, with size, speed, spacing and brightness
        // all moving together. That is what the eye reads as depth: near rain
        // is long, fast, sparse and bright; far rain is short, slow, dense and
        // faint. Getting only some of those right gives two flat sheets
        // sliding over each other. The shear differs slightly per layer too,
        // so the layers never march in step.
        if (uRain > 0.001) {
          float rain = 0.0;
          // The near layer's cells are tall and its streaks fill most of one,
          // so a close drop draws a tenth of the screen. Short dashes at every
          // depth was the other half of why the old rain read as a texture
          // over the picture rather than as water going past the canopy.
          rain += rainLayer(vUv, vec2(22.0, 7.0), 2.0, 0.36, 0.70, 0.10, 0.16 * uRain, 3.0) * 1.00;
          rain += rainLayer(vUv, vec2(48.0, 17.0), 1.6, 0.32, 0.52, 0.085, 0.21 * uRain, 17.0) * 0.72;
          rain += rainLayer(vUv, vec2(104.0, 40.0), 1.25, 0.29, 0.34, 0.07, 0.26 * uRain, 41.0) * 0.5;
          rain += rainLayer(vUv, vec2(196.0, 78.0), 0.95, 0.27, 0.24, 0.065, 0.30 * uRain, 73.0) * 0.32;

          // Faintly cool rather than a plain white lift: falling water carries
          // the colour of the sky it fell out of, and white streaks over a
          // grey day read as scratches on the lens.
          color.rgb += rain * vec3(0.24, 0.255, 0.29);
        }

        // Snow, in screen space like the rain, but behaving nothing like it.
        // Rain is a streak because a drop crosses many pixels in one frame;
        // a flake is a soft round speck that drifts. Two things sell it: the
        // cells are near-square rather than tall, and the whole field slides
        // sideways on a slow sine so the fall is never a straight vertical
        // march. Two layers at different depths give it some parallax.
        if (uSnow > 0.001) {
          // Four layers, near to far. Depth comes from all of size, speed,
          // density and brightness moving together: nearer flakes are larger,
          // fall faster, are sparser and brighter; far ones are small, slow,
          // dense and dim. Getting only some of those right reads as two flat
          // sheets rather than as air with snow in it.
          float snow = 0.0;
          snow += snowLayer(vUv,  30.0, 0.105, 0.0030, 0.20,  3.0) * 1.00;
          snow += snowLayer(vUv,  52.0, 0.078, 0.0022, 0.26, 17.0) * 0.72;
          snow += snowLayer(vUv,  86.0, 0.055, 0.0016, 0.33, 41.0) * 0.52;
          snow += snowLayer(vUv, 140.0, 0.037, 0.0012, 0.40, 73.0) * 0.34;
          color.rgb += snow * uSnow * 0.62;
        }

        vec2 d = vUv - 0.5;
        float vig = 1.0 - uVignette * dot(d, d) * 2.2;
        color.rgb *= clamp(vig, 0.0, 1.0);

        // Grain scaled by luminance so shadows don't turn to static.
        float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
        float n = hash(vUv * 1024.0 + fract(uTime) * 91.7) - 0.5;
        color.rgb += n * uGrain * smoothstep(0.0, 0.35, lum);

        gl_FragColor = color;
      }
    `,
  };
}
