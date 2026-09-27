import * as THREE from 'three';
import { PostFX } from '../render/PostFX';
import { QUALITY_PRESETS, DEFAULT_QUALITY, type QualityPreset } from '../render/Quality';

/**
 * Renderer, scene and camera setup shared by everything else.
 *
 * HDR pipeline: the scene is drawn linear into a floating-point target, bloom
 * runs on those true HDR values, and ACES tone mapping is applied once at the
 * end (see PostFX). A logarithmic depth buffer keeps both the cockpit (0.5 m)
 * and distant terrain (100 km) free of z-fighting in the same pass.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly pmrem: THREE.PMREMGenerator;
  readonly postFX: PostFX;

  private envRT: THREE.WebGLRenderTarget | null = null;
  private quality: QualityPreset = QUALITY_PRESETS[DEFAULT_QUALITY];

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Anti-aliasing is MSAA on the HDR target instead — the default
      // framebuffer is only ever shown a full-screen quad.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      logarithmicDepthBuffer: true,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.58;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    // Far enough to contain the ocean.
    //
    // The sea is a single 400 km quad, so at a 120 km far plane two thirds of
    // it lay *beyond* the frustum — and with a logarithmic depth buffer every
    // fragment past `far` clamps to depth 1.0, the same depth the sky is drawn
    // at. Log depth is precisely the thing that makes a far plane this distant
    // cost nothing, which is why it was already switched on.
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.5, 300000);
    this.camera.position.set(0, 12, 40);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.pmrem.compileEquirectangularShader();

    this.renderer.setPixelRatio(this.pixelRatio());
    this.postFX = new PostFX(this.renderer, this.scene, this.camera, {
      bloom: this.quality.bloom,
      bloomStrength: this.quality.bloomStrength,
      bloomThreshold: this.quality.bloomThreshold,
      samples: this.quality.samples,
      depthOfField: this.quality.depthOfField,
      grain: this.quality.grain,
      vignette: this.quality.vignette,
    });

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio, this.quality.pixelRatio);
  }

  applyQuality(preset: QualityPreset): void {
    this.quality = preset;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.postFX.configure({
      bloom: preset.bloom,
      bloomStrength: preset.bloomStrength,
      bloomThreshold: preset.bloomThreshold,
      samples: preset.samples,
      depthOfField: preset.depthOfField,
      grain: preset.grain,
      vignette: preset.vignette,
    });
    this.resize();
  }

  /**
   * Bake `source` (typically the sky dome alone) into the scene's environment map
   * so reflections and ambient light come from the actual sky being rendered.
   */
  updateEnvironmentFrom(source: THREE.Scene): void {
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(source);
    this.scene.environment = this.envRT.texture;
  }

  resize = (): void => {
    // A hidden or not-yet-laid-out window reports zero, which would produce
    // 0x0 render targets and an incomplete-framebuffer error every frame.
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postFX.setSize(w, h);
  };

  /** Change post-processing options without rebuilding the chain. */
  configurePostFX(options: Parameters<PostFX['configure']>[0]): void {
    this.postFX.configure(options);
  }

  /** Focus distance in metres and how shallow the lens is; 0 aperture is off. */
  setFocus(focus: number, aperture: number): void {
    this.postFX.setFocus(focus, aperture, this.camera.far);
  }

  /** Debug: draw the reconstructed distance instead of the image. */
  setDepthDebug(on: boolean): void {
    this.postFX.setDepthDebug(on);
  }

  render(dt: number): void {
    this.postFX.render(dt);
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize);
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.postFX.dispose();
    this.renderer.dispose();
  }
}
