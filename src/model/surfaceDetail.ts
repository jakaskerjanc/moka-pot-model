// Procedural surface finish for the moka pot materials, evaluated in the shader from the mesh's
// local position (millimetres) rather than from UVs: several of the hand-built geometries carry
// placeholder UVs, and a solid texture also keeps grain continuous across facet seams.
//
// Each finish layers three things on top of the material's own parameters:
//   grain  — fine sanding texture: breaks up roughness and tilts the normal (bump), optionally
//            stretched along the part's vertical axis so it reads as directional sanding marks;
//   mottle — broad, low-contrast patches of roughness and albedo (hand-finishing, oxide wear);
//   fade   — every octave fades to its mean once it drops below pixel size, so the grain softens
//            the highlights at a distance instead of sparkling.

import * as THREE from 'three';

export type SurfaceFinish = {
  /** Grain cell size (mm). */
  grainSize: number;
  /** Grain elongation along local Y (1 = isotropic, >1 = vertical sanding streaks). */
  streak: number;
  /** Roughness swing from the grain (± half this value). */
  grainRoughness: number;
  /** Bump depth of the grain (mm). */
  bumpDepth: number;
  /** Mottle patch size (mm). */
  mottleSize: number;
  /** Mottle elongation along local Y. */
  mottleStreak: number;
  /** Roughness swing from the mottle. */
  mottleRoughness: number;
  /** Relative albedo swing from the mottle (0.1 = ±5 %). */
  mottleColor: number;
};

const NOISE_GLSL = /* glsl */ `
varying vec3 vFinishPos;

float finishHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float finishNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(finishHash(i), finishHash(i + vec3(1, 0, 0)), f.x),
        mix(finishHash(i + vec3(0, 1, 0)), finishHash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(finishHash(i + vec3(0, 0, 1)), finishHash(i + vec3(1, 0, 1)), f.x),
        mix(finishHash(i + vec3(0, 1, 1)), finishHash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

// Noise octave faded to its mean (0.5) as its cells shrink below a pixel.
float finishOctave(vec3 p) {
  float footprint = length(fwidth(p));
  return mix(finishNoise(p), 0.5, smoothstep(0.3, 1.0, footprint));
}

// Bump mapping from screen-space derivatives (Mikkelsen 2010), heights in view-space units.
vec3 finishPerturbNormal(vec3 surfacePos, vec3 surfaceNormal, float height, float faceDir) {
  vec3 dpdx = dFdx(surfacePos);
  vec3 dpdy = dFdy(surfacePos);
  vec3 r1 = cross(dpdy, surfaceNormal);
  vec3 r2 = cross(surfaceNormal, dpdx);
  float det = dot(dpdx, r1) * faceDir;
  vec3 gradient = sign(det) * (dFdx(height) * r1 + dFdy(height) * r2);
  return normalize(abs(det) * surfaceNormal - gradient);
}
`;

const glslFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

/** Patches a standard/physical material with a procedural finish. Returns the same material. */
export function applySurfaceFinish<T extends THREE.MeshStandardMaterial>(material: T, finish: SurfaceFinish): T {
  const f = Object.fromEntries(Object.entries(finish).map(([key, value]) => [key, glslFloat(value)])) as Record<keyof SurfaceFinish, string>;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFinishPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFinishPos = position * 1000.0;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec3 grainPos = vFinishPos / ${f.grainSize} * vec3(1.0, 1.0 / ${f.streak}, 1.0);
        float grain = finishOctave(grainPos) * 0.65 + finishOctave(grainPos * 2.7 + 13.1) * 0.35;
        vec3 mottlePos = vFinishPos / ${f.mottleSize} * vec3(1.0, 1.0 / ${f.mottleStreak}, 1.0);
        float mottle = finishOctave(mottlePos) * 0.7 + finishOctave(mottlePos * 3.1 + 7.7) * 0.3;
        diffuseColor.rgb *= 1.0 + (mottle - 0.5) * ${f.mottleColor};`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (grain - 0.5) * ${f.grainRoughness} + (mottle - 0.5) * ${f.mottleRoughness}, 0.04, 1.0);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        normal = finishPerturbNormal(-vViewPosition, normal, grain * ${f.bumpDepth} * 0.001, faceDirection);`,
      );
  };
  const key = `surface-finish:${JSON.stringify(finish)}`;
  material.customProgramCacheKey = () => key;
  return material;
}
