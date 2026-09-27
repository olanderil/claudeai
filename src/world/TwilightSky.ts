import * as THREE from 'three';

/**
 * What the sky does after the sun has gone: stars, and the blue cast.
 *
 * Points rather than a textured dome: with `sizeAttenuation` off a point is a
 * fixed number of pixels however far away it is, which is exactly how a star
 * behaves — it has no angular size worth resolving, only a brightness. A dome
 * texture would instead be minified into a grey smear at the horizon.
 *
 * The sphere sits inside the camera's far plane. The sky itself is drawn at
 * 450 000 with a shader that pins its depth, but ordinary geometry beyond the
 * far plane is simply clipped away.
 */
const RADIUS = 90000;
const COUNT = 1100;
/** Outside the stars, inside the camera's far plane. */
const DOME_RADIUS = 105000;

export class TwilightSky {
  readonly group = new THREE.Group();
  private readonly material: THREE.PointsMaterial;
  private readonly tint: THREE.ShaderMaterial;

  constructor() {
    const position = new Float32Array(COUNT * 3);
    const colour = new Float32Array(COUNT * 3);

    let seed = 20240813;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < COUNT; i++) {
      // Uniform on the sphere: taking the polar angle from acos of a uniform
      // variable, rather than uniformly in the angle, which would crowd them
      // at the zenith.
      const theta = rand() * Math.PI * 2;
      const y = rand();
      const r = Math.sqrt(1 - y * y);
      position[i * 3] = Math.cos(theta) * r * RADIUS;
      position[i * 3 + 1] = y * RADIUS;
      position[i * 3 + 2] = Math.sin(theta) * r * RADIUS;

      // A spread of magnitudes, with most stars faint — an evenly bright field
      // reads as noise rather than as a sky.
      const mag = Math.pow(rand(), 2.2);
      const warm = 0.86 + rand() * 0.14;
      colour[i * 3] = mag * warm;
      colour[i * 3 + 1] = mag * (0.9 + rand() * 0.1);
      colour[i * 3 + 2] = mag;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colour, 3));

    this.material = new THREE.PointsMaterial({
      size: 2.0,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false, // stars are beyond the atmosphere; haze must not tint them
    });

    const points = new THREE.Points(geometry, this.material);
    points.frustumCulled = false;
    points.renderOrder = -1;

    this.tint = makeTintMaterial();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 24, 16), this.tint);
    dome.frustumCulled = false;
    dome.renderOrder = -2; // before the stars, so they sit on top of the cast

    this.group.add(dome);
    this.group.add(points);
    this.group.visible = false;
  }

  /**
   * `amount` is how far into twilight we are, 0..1. Cloud hides them: there is
   * no point in stars shining through an overcast.
   */
  setVisibility(amount: number, cloudCover: number): void {
    this.material.opacity = amount * (1 - cloudCover * 0.92);
    // The cast survives cloud — an overcast blue hour is still blue — where
    // individual stars do not.
    this.tint.uniforms.uAmount.value = amount * (1 - cloudCover * 0.35);
    this.group.visible = amount > 0.01;
  }

  /** Keep both domes centred on the viewer, so neither ever gets any closer. */
  follow(focus: THREE.Vector3): void {
    this.group.position.copy(focus);
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Points || o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.material.dispose();
    this.tint.dispose();
  }
}

/**
 * The blue cast of the blue hour.
 *
 * Preetham — the sky model everything else here uses — is extrapolating once
 * the sun is under the horizon, and returns a muddy brown whatever you do to
 * its turbidity and scattering terms. Rather than fit a second sky model, a
 * wide translucent dome sits between the sky and everything else: terrain is
 * nearer and has already written depth, so the cast lands only on sky.
 *
 * It is strongest overhead and fades out by the horizon, which is both what the
 * hour actually looks like and what keeps the last warm band above the sunset
 * from being painted over.
 */
/*
 * The dome depth-tests against the rest of the scene, so it has to speak the
 * same depth language: the renderer runs a logarithmic depth buffer, and a
 * raw ShaderMaterial that omits these chunks writes ordinary perspective depth
 * into it. Nothing errors — the geometry is simply occluded, or fails to be,
 * by things at the wrong distance.
 */
function makeTintMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAmount: { value: 0 },
      uColour: { value: new THREE.Color(0.055, 0.135, 0.30) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying float vUp;
      void main() {
        vUp = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uAmount;
      uniform vec3 uColour;
      varying float vUp;
      void main() {
        #include <logdepthbuf_fragment>
        float a = uAmount * smoothstep(-0.12, 0.55, vUp);
        gl_FragColor = vec4(uColour, a * 0.82);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    fog: false,
  });
}
