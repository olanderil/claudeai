/**
 * Graphics quality presets.
 *
 * Every field is something that costs real frame time, gathered in one place so
 * the panel can move the whole pipeline with a single control rather than
 * exposing a dozen unrelated switches.
 */
export interface QualityPreset {
  name: string;
  /** Upper bound on device pixel ratio — the single biggest cost lever. */
  pixelRatio: number;
  /** MSAA samples on the HDR target; 0 disables. */
  samples: number;
  bloom: boolean;
  bloomStrength: number;
  bloomThreshold: number;
  shadowMapSize: number;
  /** Whether terrain casts shadows, which costs a second pass over the chunks. */
  terrainShadows: boolean;
  /** Half-extent of the sun's shadow frustum at low level, metres. */
  shadowRange: number;
  cloudPuffs: number;
  /** Whether the cinematic camera may use shallow depth of field. */
  depthOfField: boolean;
  grain: number;
  vignette: number;
  /** Density of the 3D trees, 0..1 of the full scatter (optional: 1). */
  trees?: number;
}

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    name: 'LOW',
    pixelRatio: 1,
    samples: 0,
    bloom: false,
    bloomStrength: 0,
    bloomThreshold: 4,
    shadowMapSize: 1024,
    terrainShadows: false,
    shadowRange: 400,
    cloudPuffs: 200,
    depthOfField: false,
    grain: 0,
    vignette: 0.2,
    trees: 0.35,
  },
  {
    name: 'MEDIUM',
    pixelRatio: 1.25,
    samples: 0,
    bloom: true,
    bloomStrength: 0.5,
    bloomThreshold: 4,
    shadowMapSize: 2048,
    terrainShadows: false,
    shadowRange: 700,
    cloudPuffs: 420,
    depthOfField: true,
    grain: 0.02,
    vignette: 0.3,
    trees: 0.65,
  },
  {
    name: 'HIGH',
    pixelRatio: 1.5,
    samples: 4,
    bloom: true,
    bloomStrength: 0.62,
    bloomThreshold: 4,
    shadowMapSize: 3072,
    terrainShadows: true,
    shadowRange: 1400,
    cloudPuffs: 700,
    depthOfField: true,
    grain: 0.03,
    vignette: 0.34,
  },
  {
    name: 'ULTRA',
    pixelRatio: 2,
    samples: 4,
    bloom: true,
    bloomStrength: 0.72,
    bloomThreshold: 4,
    shadowMapSize: 4096,
    terrainShadows: true,
    shadowRange: 2200,
    cloudPuffs: 1000,
    depthOfField: true,
    grain: 0.035,
    vignette: 0.36,
  },
];

export const DEFAULT_QUALITY = 2; // HIGH
