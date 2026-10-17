// Procedural Three.js model of a 3-cup Bialetti Moka Express.
//
// Hand-refined from the img2threejs blockout (.img2threejs/generated/createMokaPotBlockout.ts).
// Every dimension comes from MOKA_POT_SPEC, which mirrors the sculpt spec in .img2threejs/.
// Approximation notes: single front reference, so the back is assumed radially symmetric,
// handle depth is inferred, and the interior (funnel, filter plate, gasket, chimney) is hidden in
// the reference: shapes follow exploded-parts photos, sizes are fitted to the neck and collar.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MOKA_POT_SPEC as S, type ProfilePoint } from './mokaPotSpec';
import { applySurfaceFinish, type SurfaceFinish } from './surfaceDetail';

const MM = 0.001;
const TAU = Math.PI * 2;

export type ColliderProxy =
  | { type: 'octagonal-frustum'; bottomApothem: number; topApothem: number; bottom: number; top: number }
  | { type: 'cylinder'; radius: number; bottom: number; top: number }
  | { type: 'box'; min: [number, number, number]; max: [number, number, number] }
  | { type: 'capsule-chain'; points: [number, number, number][]; radius: number };

export type MokaPotRuntime = {
  /** Pivot node per semantic part — animate these, not the meshes. */
  nodes: Record<string, THREE.Object3D>;
  /** Every mesh, keyed by `partId/meshName`. Each mesh has `userData.partId` for picking. */
  meshes: Record<string, THREE.Mesh>;
  /** Named attachment points (e.g. `stove-contact`, `grip`, `knob-seat`). */
  sockets: Record<string, THREE.Object3D>;
  /** Simplified collision proxies in the part's local frame (metres). */
  colliders: Record<string, ColliderProxy>;
  /** 0 = closed, 1 = fully open (88° about the hinge pin, resting against the handle). */
  setLidOpen(amount: number): void;
  /** 0 = assembled, 1 = loose internals (funnel, filter plate, gasket) pulled apart; the upper assembly lifts off as one unit. */
  setExplode(amount: number): void;
};

export type MokaPotModelOptions = {
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** Show the hidden funnel, gasket and chimney (they are only visible when disassembled). */
  internals?: boolean;
};

// ------------------------------------------------------------------ deterministic noise

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ geometry helpers

/** Interpolated radius of a profile at height `y` (profile must be monotonic in y there). */
function radiusAt(profile: readonly ProfilePoint[], y: number): number {
  for (let i = 0; i < profile.length - 1; i += 1) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    if ((y >= y0 && y <= y1) || (y <= y0 && y >= y1)) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return r0 + (r1 - r0) * t;
    }
  }
  return profile[profile.length - 1][0];
}

/** Chamfer width at each facet corner, as a fraction of the apothem (≈0.5 mm on the pot). */
const FACET_CHAMFER = 0.012;

type PolygonFace = { a: [number, number]; b: [number, number]; normalAngle: number; u0: number; u1: number };

/**
 * Cross-section of a regular polygon with unit apothem and one face centred on +Z, as (x, z)
 * faces. Each corner is cut by a narrow chamfer face so edges catch a thin highlight.
 */
function polygonFaces(segments: number, chamfer: number): PolygonFace[] {
  const step = TAU / segments;
  const cornerRadius = 1 / Math.cos(Math.PI / segments);
  const corner = (k: number): [number, number] => {
    const angle = -step / 2 + k * step;
    return [cornerRadius * Math.sin(angle), cornerRadius * Math.cos(angle)];
  };
  const faces: PolygonFace[] = [];
  const along = (from: [number, number], to: [number, number], distance: number): [number, number] => {
    const dx = to[0] - from[0];
    const dz = to[1] - from[1];
    const length = Math.hypot(dx, dz);
    return [from[0] + (dx / length) * distance, from[1] + (dz / length) * distance];
  };
  for (let j = 0; j < segments; j += 1) {
    const c0 = corner(j);
    const c1 = corner(j + 1);
    const c2 = corner(j + 2);
    const start = along(c0, c1, chamfer);
    const end = along(c1, c0, chamfer);
    const nextStart = along(c1, c2, chamfer);
    const u = j / segments;
    const du = 1 / segments;
    faces.push({ a: start, b: end, normalAngle: j * step, u0: u, u1: u + du * 0.97 });
    faces.push({ a: end, b: nextStart, normalAngle: -step / 2 + (j + 1) * step, u0: u + du * 0.97, u1: u + du });
  }
  return faces;
}

/**
 * Revolve a (radius, height) profile in millimetres around +Y.
 *
 * `faceted`: radii are apothems and the result is a regular `segments`-gon with one facet
 * centred on +Z, flat normals across each facet and sharp edges between facets. Otherwise the
 * surface is smooth around. Normals are always flat along the profile (each profile segment is
 * its own strip), so profile corners stay crisp. Profiles run so that the outside is on the
 * left when walking the profile (bottom → out → up the outside → over the rim → down inside).
 * `skip(face, y0, y1)` leaves out one faceted face over a profile segment (to cut openings);
 * face `2j` is facet `j` (normal at azimuth j·step from +Z), face `2j + 1` the chamfer after it.
 */
function revolve(
  profile: readonly ProfilePoint[],
  segments: number,
  faceted: boolean,
  skip?: (face: number, y0: number, y1: number) => boolean,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const step = TAU / segments;
  const phiStart = faceted ? -step / 2 : 0;
  const faces = faceted ? polygonFaces(segments, FACET_CHAMFER) : [];

  const cumulative = [0];
  for (let i = 1; i < profile.length; i += 1) {
    const [r0, y0] = profile[i - 1];
    const [r1, y1] = profile[i];
    cumulative.push(cumulative[i - 1] + Math.hypot(r1 - r0, y1 - y0));
  }
  const total = cumulative[cumulative.length - 1] || 1;

  for (let i = 0; i < profile.length - 1; i += 1) {
    const [r0, y0] = profile[i];
    const [r1, y1] = profile[i + 1];
    const length = Math.hypot(r1 - r0, y1 - y0);
    if (length < 1e-9) continue;
    const nr = (y1 - y0) / length;
    const ny = -(r1 - r0) / length;
    const v0 = cumulative[i] / total;
    const v1 = cumulative[i + 1] / total;
    const R0 = r0 * MM;
    const R1 = r1 * MM;

    if (faceted) {
      for (const [f, face] of faces.entries()) {
        if (skip?.(f, y0, y1)) continue;
        const base = positions.length / 3;
        const corners: [[number, number], number, number, number][] = [
          [face.a, r0, y0, face.u0],
          [face.b, r0, y0, face.u1],
          [face.a, r1, y1, face.u0],
          [face.b, r1, y1, face.u1],
        ];
        for (const [[px, pz], radius, height, u] of corners) {
          positions.push(px * radius * MM, height * MM, pz * radius * MM);
          normals.push(nr * Math.sin(face.normalAngle), ny, nr * Math.cos(face.normalAngle));
          uvs.push(u, height === y0 ? v0 : v1);
        }
        indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
      }
    } else {
      const base = positions.length / 3;
      for (let j = 0; j <= segments; j += 1) {
        const angle = phiStart + j * step;
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        positions.push(R0 * s, y0 * MM, R0 * c, R1 * s, y1 * MM, R1 * c);
        normals.push(nr * s, ny, nr * c, nr * s, ny, nr * c);
        uvs.push(j / segments, v0, j / segments, v1);
      }
      for (let j = 0; j < segments; j += 1) {
        const a = base + j * 2;
        indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/** Offset every apothem of a profile inward by `wall` (for inner shell surfaces). */
function inset(profile: readonly ProfilePoint[], wall: number): ProfilePoint[] {
  return profile.map(([r, y]) => [Math.max(0, r - wall), y] as const);
}

function buildLowerChamber(): THREE.BufferGeometry {
  const outer = S.lowerOuter;
  const top = outer[outer.length - 1];
  const inner = inset(outer.slice(1), S.wall).reverse();
  const profile: ProfilePoint[] = [[0, 0], ...outer, [top[0] - S.wall, top[1]], ...inner.slice(1), [0, S.wall]];
  return revolve(profile, S.facets, true);
}

function buildNeckRing(): THREE.BufferGeometry {
  const { radius: r, bottom, top, grooves } = S.neck;
  const inner = r - S.wall;
  const profile: ProfilePoint[] = [[inner, bottom], [r, bottom]];
  for (const g of grooves) profile.push([r, g - 0.25], [r - 0.3, g], [r, g + 0.25]);
  // Male thread (hidden inside the collar when assembled), as rounded rings.
  const { from, to, pitch, depth } = S.neck.thread;
  for (let g = from; g + pitch / 2 <= to; g += pitch) {
    profile.push([r, g - pitch * 0.35], [r - depth * 0.7, g - pitch * 0.15], [r - depth, g], [r - depth * 0.7, g + pitch * 0.15], [r, g + pitch * 0.35]);
  }
  profile.push([r, top - 0.4], [r - 0.4, top], [inner, top], [inner, bottom]);
  return revolve(profile, 72, false);
}

function buildCollar(): THREE.BufferGeometry {
  const { radius: r, innerRadius, bottom, top } = S.collar;
  return revolve(
    [
      [innerRadius, bottom],
      [r - 0.6, bottom],
      [r, bottom + 0.6],
      [r, top],
      [innerRadius, top],
      [innerRadius, bottom],
    ],
    72,
    false,
  );
}

/** The spout sits on the −X facet (normal azimuth 270° from +Z). */
const SPOUT_FACET = (S.facets * 3) / 4;

/**
 * The V notch the spout opens through, on the unit-apothem facet: `apex` is the facet centre
 * (at `rootHeight`), `corners` the facet's two (chamfered) top corners (at `rimHeight`), −Z first.
 */
function spoutNotch(): { apex: [number, number]; corners: [number, number][] } {
  const { a, b } = polygonFaces(S.facets, FACET_CHAMFER)[SPOUT_FACET * 2];
  const corners = [a, b].sort((p, q) => p[1] - q[1]);
  return { apex: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], corners };
}

/**
 * Collector shell with the V notch cut through the −X facet: the facet is left out above the
 * spout root and rebuilt as the two side triangles either side of the V, outer and inner skins
 * joined by the cut face, so the chamber opens straight into the spout.
 */
function buildUpperChamber(): THREE.BufferGeometry {
  const outer = S.upperOuter;
  const rim = outer[outer.length - 1];
  const bodyTop = outer[outer.length - 2];
  const innerTop = rim[1] - 0.8;
  const innerBottom = S.upperFloor;
  const { rootHeight, rimHeight } = S.spout;
  const outerAt = (y: number) => radiusAt(outer, y);
  const innerAt = (y: number) => Math.min(outerAt(y), bodyTop[0]) - S.wall;
  // Split both walls at the spout root so the notched facet can be dropped above it.
  const profile: ProfilePoint[] = [
    [0, outer[0][1]],
    ...outer.slice(0, 2),
    [outerAt(rootHeight), rootHeight],
    ...outer.slice(2),
    [rim[0] - S.wall, rim[1]],
    [radiusAt(outer, innerTop) - S.wall, innerTop],
    [innerAt(rootHeight), rootHeight],
    [innerAt(innerBottom), innerBottom],
    [0, innerBottom],
  ];
  const shell = revolve(profile, S.facets, true, (face, y0, y1) => face === SPOUT_FACET * 2 && Math.min(y0, y1) >= rootHeight - 1e-6);

  const { apex, corners } = spoutNotch();
  const positions: number[] = [];
  const normals: number[] = [];
  const at = ([x, z]: [number, number], r: number, y: number) => new THREE.Vector3(x * r * MM, y * MM, z * r * MM);
  // Flat triangle wound so its face points along `facing`.
  const triangle = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, facing: THREE.Vector3) => {
    const n = q.clone().sub(p).cross(r.clone().sub(p)).normalize();
    const tri = n.dot(facing) < 0 ? [p, r, q] : [p, q, r];
    if (n.dot(facing) < 0) n.negate();
    for (const v of tri) positions.push(...v.toArray()), normals.push(...n.toArray());
  };
  const outward = new THREE.Vector3(-1, 0, 0);
  const inward = new THREE.Vector3(1, 0, 0);
  for (const [side, corner] of corners.entries()) {
    const sign = side === 0 ? -1 : 1;
    const oApex = at(apex, outerAt(rootHeight), rootHeight);
    const oRoot = at(corner, outerAt(rootHeight), rootHeight);
    const oTop = at(corner, outerAt(rimHeight), rimHeight);
    const iApex = at(apex, innerAt(rootHeight), rootHeight);
    const iRoot = at(corner, innerAt(rootHeight), rootHeight);
    const iTop = at(corner, innerAt(innerTop), innerTop);
    triangle(oApex, oRoot, oTop, outward);
    triangle(iApex, iRoot, iTop, inward);
    // Cut face along the V edge, facing into the notch (up and toward the centre line).
    const intoNotch = new THREE.Vector3(0, 0.3, -sign);
    triangle(oApex, oTop, iTop, intoNotch);
    triangle(oApex, iTop, iApex, intoNotch);
  }
  const panels = new THREE.BufferGeometry();
  panels.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  panels.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  panels.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
  return mergeGeometries([shell.toNonIndexed(), panels])!;
}

function buildLid(): THREE.BufferGeometry {
  const { rimRadius, rimBottom, rimTop, apexRadius, apexHeight, thickness } = S.lid;
  return revolve(
    [
      [0, apexHeight - thickness],
      [rimRadius - S.wall, rimBottom],
      [rimRadius, rimBottom],
      [rimRadius, rimTop],
      [apexRadius, apexHeight],
      [0, apexHeight],
    ],
    S.facets,
    true,
  );
}

function buildKnob(): THREE.BufferGeometry {
  const { profile, flutes, fluteDepth, fluteRange } = S.knob;
  const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4) * MM, y * MM));
  // Seam at the back (−Z) so it never faces the viewer.
  const geometry = new THREE.LatheGeometry(points, 96, Math.PI, TAU);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i);
    const h = v.y / MM;
    if (h < fluteRange[0] || h > fluteRange[1]) continue;
    const r = Math.hypot(v.x, v.z);
    if (r < 1e-6) continue;
    const angle = Math.atan2(v.x, v.z);
    // Fade the flute in/out at the ends of the fluted band.
    const fade = Math.min(1, (h - fluteRange[0]) / 1.2, (fluteRange[1] - h) / 1.2);
    const groove = Math.pow(0.5 + 0.5 * Math.cos(flutes * angle), 6);
    const scale = (r - groove * fluteDepth * MM * fade) / r;
    position.setXYZ(i, v.x * scale, v.y, v.z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Handle: the traced side outline, smoothed by a closed centripetal spline and extruded into a
 * closed slab with rounded edges. The bevel is inset (negative offset) so the silhouette matches
 * the outline exactly.
 */
function buildHandle(): THREE.BufferGeometry {
  const { outline, halfDepth, bevel } = S.handle;
  const spline = new THREE.CatmullRomCurve3(
    outline.map(([x, y]) => new THREE.Vector3(x * MM, y * MM, 0)),
    true,
    'centripetal',
  );
  const shape = new THREE.Shape(spline.getSpacedPoints(320).slice(0, -1).map((p) => new THREE.Vector2(p.x, p.y)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: (halfDepth - bevel) * 2 * MM,
    bevelEnabled: true,
    bevelThickness: bevel * MM,
    bevelSize: bevel * MM,
    bevelOffset: -bevel * MM,
    bevelSegments: 6,
  });
  geometry.translate(0, 0, -(halfDepth - bevel) * MM);
  // Smooth along the outline and across the bevel; the geometry has no hard edges to keep.
  const smooth = toCreasedNormals(geometry, THREE.MathUtils.degToRad(60));
  // The bevel meets the side faces tangentially, so every vertex on a side-face plane gets the
  // plane's normal. Without this the long cap triangles interpolate tilted edge normals and smear.
  const position = smooth.getAttribute('position');
  const normal = smooth.getAttribute('normal');
  const face = halfDepth * MM;
  for (let i = 0; i < position.count; i += 1) {
    const z = position.getZ(i);
    if (Math.abs(Math.abs(z) - face) < 1e-7) normal.setXYZ(i, 0, 0, Math.sign(z));
  }
  return smooth;
}

/** Points on a circular arc in the (radius, height) plane, for rounded profile corners. */
function arc(cr: number, cy: number, radius: number, fromDeg: number, toDeg: number, steps = 5): ProfilePoint[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = THREE.MathUtils.degToRad(fromDeg + ((toDeg - fromDeg) * i) / steps);
    return [cr + radius * Math.cos(a), cy + radius * Math.sin(a)] as const;
  });
}

/**
 * Flat perforated disc lying in the XZ plane at height `y` (mm): a circle of `radius` with
 * hexagonal-grid holes of `holeRadius` inside `maxRadius`, skipping the optional `keepOut` ring
 * [inner, outer] (e.g. where a stem joins). Holes are octagons —
 * at sub-millimetre size they read as round. Single sheet; render with a double-sided material.
 */
function buildPerforatedDisc(
  radius: number,
  y: number,
  holes: { radius: number; pitch: number; maxRadius: number; keepOut?: readonly [number, number] },
): THREE.BufferGeometry {
  const outline = 96;
  const shape = new THREE.Shape();
  for (let i = 0; i <= outline; i += 1) {
    const a = (i / outline) * TAU;
    const point: [number, number] = [radius * MM * Math.cos(a), radius * MM * Math.sin(a)];
    if (i === 0) shape.moveTo(...point);
    else shape.lineTo(...point);
  }
  const rowStep = (holes.pitch * Math.sqrt(3)) / 2;
  const rows = Math.ceil(holes.maxRadius / rowStep);
  for (let row = -rows; row <= rows; row += 1) {
    const offset = row % 2 === 0 ? 0 : holes.pitch / 2;
    const columns = Math.ceil(holes.maxRadius / holes.pitch) + 1;
    for (let column = -columns; column <= columns; column += 1) {
      const hx = column * holes.pitch + offset;
      const hz = row * rowStep;
      const distance = Math.hypot(hx, hz);
      if (distance + holes.radius > holes.maxRadius) continue;
      const keepOut = holes.keepOut;
      if (keepOut && distance + holes.radius > keepOut[0] && distance - holes.radius < keepOut[1]) continue;
      const hole = new THREE.Path();
      // Holes wind opposite to the outline (clockwise) so the triangulator cuts them out.
      for (let k = 0; k <= 8; k += 1) {
        const a = -(k / 8) * TAU;
        const point: [number, number] = [(hx + holes.radius * Math.cos(a)) * MM, (hz + holes.radius * Math.sin(a)) * MM];
        if (k === 0) hole.moveTo(...point);
        else hole.lineTo(...point);
      }
      shape.holes.push(hole);
    }
  }
  const geometry = new THREE.ShapeGeometry(shape, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, y * MM, 0);
  return geometry;
}

/** Offset an open profile polyline by `d` along its left-hand normal (toward the axis / up for a path climbing outward). */
function offsetProfile(points: readonly ProfilePoint[], d: number): ProfilePoint[] {
  return points.map(([r, y], i) => {
    const [r0, y0] = points[Math.max(i - 1, 0)];
    const [r1, y1] = points[Math.min(i + 1, points.length - 1)];
    const length = Math.hypot(r1 - r0, y1 - y0) || 1;
    return [r - (d * (y1 - y0)) / length, y + (d * (r1 - r0)) / length] as const;
  });
}

/** Cone surface height at radius `r` (mm), from the stem apex up to the shoulder. */
function funnelConeHeight(r: number): number {
  const { basket, stem } = S.funnel;
  const t = (r - stem.outerRadius) / (basket.stepRadius - stem.outerRadius);
  return basket.apex + t * (basket.shoulder - basket.apex);
}

/**
 * Funnel cup as one pressed sheet: shallow cone from the stem apex, rounded shoulder, straight
 * wall with a small outward step (the inner ledge the plate sits on), rolled lip at the mouth.
 */
function buildFunnelCup(): THREE.BufferGeometry {
  const { rim, basket, stem } = S.funnel;
  const { topRadius, stepRadius, step, shoulder, shoulderRadius: f, sheet } = basket;
  const coneLength = Math.hypot(stepRadius - stem.outerRadius, shoulder - basket.apex);
  const coneDir = [(stepRadius - stem.outerRadius) / coneLength, (shoulder - basket.apex) / coneLength];
  // Rounded shoulder: quadratic blend from the cone into the vertical wall.
  const shoulderPoints = Array.from({ length: 5 }, (_, i) => {
    const t = i / 4;
    const a = [stepRadius - coneDir[0] * f, shoulder - coneDir[1] * f];
    const b = [stepRadius, shoulder + f];
    const r = (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * stepRadius + t ** 2 * b[0];
    const y = (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * shoulder + t ** 2 * b[1];
    return [r, y] as const;
  });
  const outer: ProfilePoint[] = [
    [stem.outerRadius, basket.apex],
    ...shoulderPoints,
    [stepRadius, step - 0.9],
    [(stepRadius + topRadius) / 2, step - 0.45],
    [topRadius, step],
    [topRadius, rim.bottom - 0.4],
  ];
  const inner = offsetProfile(outer, sheet);
  inner[0] = [stem.innerRadius, basket.apex + sheet];
  const lip = (rim.top - rim.bottom) / 2;
  return revolve(
    [
      ...outer,
      [rim.lipRadius - lip, rim.bottom],
      ...arc(rim.lipRadius - lip, rim.bottom + lip, lip, -90, 90, 6).slice(1),
      [topRadius - sheet, rim.top],
      ...inner.reverse(),
      outer[0],
    ],
    96,
    false,
  );
}

/** Funnel stem: slim open tube with a rounded mouth, and a crimped collar ring meeting the cone apex. */
function buildFunnelStem(): THREE.BufferGeometry {
  const { stem, basket } = S.funnel;
  const { outerRadius, innerRadius, bottom, collarRadius, collarHeight } = stem;
  const edge = (outerRadius - innerRadius) / 2;
  const mid = (outerRadius + innerRadius) / 2;
  const collarBottom = basket.apex - collarHeight;
  const round = 0.4;
  return revolve(
    [
      [innerRadius, basket.apex + basket.sheet],
      [innerRadius, bottom + edge],
      ...arc(mid, bottom + edge, edge, 180, 360, 6).slice(1),
      [outerRadius, collarBottom],
      ...arc(collarRadius - round, collarBottom + round, round, -90, 0, 3),
      [collarRadius, funnelConeHeight(collarRadius) - 0.1],
    ],
    48,
    false,
  );
}

/** Filter plate rim: conical wall from the dish up to a flat flange with a rolled outer edge. */
/** Outer radius of the chimney's tapered wall at height `y` (between the fillet and the cap). */
function chimneyRadiusAt(y: number): number {
  const { bottom, top, baseRadius, topRadius, fillet, cap } = S.chimney;
  const wallBottom = bottom + fillet;
  return baseRadius + ((topRadius - baseRadius) * (y - wallBottom)) / (top - cap.shoulder - wallBottom);
}

/**
 * Closed coffee column: a tapered double-skinned tube on a floor fillet, capped at the top, with
 * two slot ports under the cap facing ±Z. The tube is one quad per column between the bottom,
 * the port's lower edge, the port's upper edge and the top, so the slot outline is exact at
 * every column boundary; outside the ports the two middle rows coincide.
 */
function buildChimney(): THREE.BufferGeometry {
  const { bottom, top, baseRadius, topRadius, wall, fillet, cap, ports } = S.chimney;
  const wallBottom = bottom + fillet;
  const wallTop = top - cap.shoulder;
  const radiusAtY = chimneyRadiusAt;
  const slope = Math.atan2(baseRadius - topRadius, wallTop - wallBottom);
  const portRadius = radiusAtY(ports.height);
  const halfAngle = ports.halfWidth / portRadius;
  // Port half-height at azimuth `phi` (0 outside the slots). Ports are centred on ±Z (phi = 0, π).
  const portHalfHeight = (phi: number) => {
    const d = Math.abs(Math.atan2(Math.sin(phi), Math.abs(Math.cos(phi)))) / halfAngle;
    if (d >= 1) return 0;
    return ports.halfHeight * (1 - d ** ports.squareness) ** (1 / ports.squareness);
  };

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const segments = 128;
  const vertex = (p: THREE.Vector3, n: THREE.Vector3) => {
    positions.push(...p.toArray());
    normals.push(...n.toArray());
    return positions.length / 3 - 1;
  };
  const skins = [
    { offset: 0, sign: 1 },
    { offset: -wall, sign: -1 },
  ];
  const columns: { outer: number[]; inner: number[]; p: THREE.Vector3[][] }[] = [];
  for (let j = 0; j <= segments; j += 1) {
    const phi = (j / segments) * TAU;
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const h = portHalfHeight(phi);
    const rows = [wallBottom, ports.height - h, ports.height + h, wallTop];
    const column = { outer: [] as number[], inner: [] as number[], p: [] as THREE.Vector3[][] };
    for (const { offset, sign } of skins) {
      const n = new THREE.Vector3(Math.cos(slope) * s, Math.sin(slope), Math.cos(slope) * c).multiplyScalar(sign);
      const points = rows.map((y) => new THREE.Vector3((radiusAtY(y) + offset) * s * MM, y * MM, (radiusAtY(y) + offset) * c * MM));
      (sign > 0 ? column.outer : column.inner).push(...points.map((point) => vertex(point, n)));
      column.p.push(points);
    }
    columns.push(column);
  }
  for (let j = 0; j < segments; j += 1) {
    const [a, b] = [columns[j], columns[j + 1]];
    for (const [r0, r1] of [[0, 1], [2, 3]]) {
      indices.push(a.outer[r0], b.outer[r0], b.outer[r1], a.outer[r0], b.outer[r1], a.outer[r1]);
      indices.push(a.inner[r0], a.inner[r1], b.inner[r1], a.inner[r0], b.inner[r1], b.inner[r0]);
    }
  }

  // Port reveals: the wall thickness around each slot, flat-shaded per quad.
  for (let j = 0; j < segments; j += 1) {
    const [a, b] = [columns[j], columns[j + 1]];
    for (const [row, facing] of [[1, 1], [2, -1]] as const) {
      const quad = [a.p[0][row], b.p[0][row], b.p[1][row], a.p[1][row]];
      if (quad[0].distanceTo(a.p[0][3 - row]) < 1e-7 && quad[1].distanceTo(b.p[0][3 - row]) < 1e-7) continue;
      const n = quad[1].clone().sub(quad[0]).cross(quad[3].clone().sub(quad[0])).normalize();
      // Lower sill faces up into the slot, upper lintel faces down.
      if (Math.sign(n.y || 1) !== facing) n.negate();
      const ids = quad.map((point) => vertex(point, n));
      const flip = quad[1].clone().sub(quad[0]).cross(quad[3].clone().sub(quad[0])).dot(n) < 0;
      if (flip) indices.push(ids[0], ids[3], ids[2], ids[0], ids[2], ids[1]);
      else indices.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  }

  const tube = new THREE.BufferGeometry();
  tube.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  tube.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  tube.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
  tube.setIndex(indices);

  // Floor fillet (outside only) and the cap: rounded shoulder, flat crown, centre boss; the
  // underside closes the bore.
  const base = revolve([[baseRadius + fillet, bottom + 0.01], ...arc(baseRadius + fillet, bottom + fillet, fillet, 270, 180, 6)], 64, false);
  const capProfile: ProfilePoint[] = [
    [0, wallTop + cap.shoulder * 0.3],
    [topRadius - wall, wallTop],
    [topRadius, wallTop],
    ...arc(topRadius - cap.shoulder, wallTop, cap.shoulder, 0, 90, 6).slice(1),
    [cap.bossRadius + 0.3, top],
    [cap.bossRadius, top + cap.bossHeight * 0.7],
    [cap.bossRadius * 0.6, top + cap.bossHeight],
    [0, top + cap.bossHeight],
  ];
  const capGeometry = revolve(capProfile, 64, false);
  return mergeGeometries([tube.toNonIndexed(), base.toNonIndexed(), capGeometry.toNonIndexed()])!;
}

function buildFilterPlateRim(): THREE.BufferGeometry {
  const { flangeOuter, flangeInner, top, sheet, dishRadius, dishDepth } = S.filterPlate;
  const dish = top - dishDepth;
  const edge = sheet / 2;
  return revolve(
    [
      [dishRadius, dish - edge],
      [flangeInner, top - sheet],
      [flangeOuter - edge, top - sheet],
      ...arc(flangeOuter - edge, top - edge, edge, -90, 90, 4).slice(1),
      [flangeInner - sheet * 0.6, top],
      [dishRadius - sheet * 0.6, dish + edge],
      [dishRadius - 0.8, dish + edge],
    ],
    96,
    false,
  );
}

/** Flat washer gasket with softened edges and a recess on its upper inner edge for the plate flange. */
function buildGasket(): THREE.BufferGeometry {
  const { outerRadius, innerRadius, bottom, top, recessRadius, recessDepth, edge } = S.gasket;
  const inner = arc(innerRadius + edge, bottom + edge, edge, 180, 270, 3);
  return revolve(
    [
      ...inner,
      ...arc(outerRadius - edge, bottom + edge, edge, -90, 0, 3),
      ...arc(outerRadius - edge, top - edge, edge, 0, 90, 3),
      [recessRadius, top],
      [recessRadius, top - recessDepth],
      ...arc(innerRadius + edge, top - recessDepth - edge, edge, 90, 180, 3),
      inner[0],
    ],
    96,
    false,
  );
}

/** Resample a polyline to `steps + 1` points evenly spaced by arc length. */
function resample(points: THREE.Vector3[], steps: number): THREE.Vector3[] {
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < points.length - 1; i += 1) path.add(new THREE.LineCurve3(points[i], points[i + 1]));
  return Array.from({ length: steps + 1 }, (_, i) => path.getPointAt(i / steps));
}

/**
 * The V lip on the −X facet, opening through the chamber's V notch. Each side wall spans from
 * the notch edge (facet centre at the root → facet corner at the rim) out to the centre keel
 * (root → knee → tip); its top edge climbs from the tip back over the rim to the corner.
 * Plan view narrows linearly from the facet width to a point at the tip.
 */
function buildSpout(): { walls: THREE.BufferGeometry; lip: THREE.BufferGeometry } {
  const { rootHeight, knee, tip, lipTop, rimHeight, lip } = S.spout;
  const { corners } = spoutNotch();
  // Seat the sheet a little inside the wall's outer skin so the joint is hidden in the cut face.
  const apothemRoot = radiusAt(S.upperOuter, rootHeight) - 0.4;
  const apothemTop = radiusAt(S.upperOuter, rimHeight) - 0.4;
  const cornerHalfWidth = Math.abs(corners[0][1]) * apothemTop;
  // Half-width of the V at a given x: full facet half-width at the corner, zero at the tip.
  const halfWidthAt = (x: number) => (cornerHalfWidth * (Math.abs(tip[0]) - Math.abs(x))) / (Math.abs(tip[0]) - apothemTop);
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x * MM, y * MM, z * MM);
  const keelRoot = v(-apothemRoot, rootHeight, 0);
  const tipPoint = v(tip[0], tip[1], 0);
  const keel = [keelRoot, v(knee[0], knee[1], 0), tipPoint];
  const steps = 32;
  // Indexed grid per side so normals are smooth across the ruled surface (no triangle banding).
  const positions: number[] = [];
  const indices: number[] = [];
  const rim: THREE.Vector3[][] = [];
  for (const side of [-1, 1]) {
    const cornerTop = v(-apothemTop, rimHeight, side * cornerHalfWidth);
    const tops = lipTop.map(([x, y]) => v(x, y, side * halfWidthAt(x)));
    // Ruled surface between the keel and the notch edge + lip, both running root → tip and
    // resampled by arc length so the wall never pokes past either edge.
    const lower = resample(keel, steps);
    const upperEdge = resample([keelRoot, cornerTop, ...[...tops].reverse(), tipPoint], steps);
    const base = positions.length / 3;
    for (let i = 0; i <= steps; i += 1) positions.push(...lower[i].toArray(), ...upperEdge[i].toArray());
    for (let i = 0; i < steps; i += 1) {
      const a = base + i * 2;
      if (side < 0) indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
      else indices.push(a, a + 3, a + 2, a, a + 1, a + 3);
    }
    rim.push([cornerTop, ...[...tops].reverse()]);
  }
  const walls = new THREE.BufferGeometry();
  walls.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  walls.setIndex(indices);
  walls.computeVertexNormals();
  const lipCurve = new THREE.CatmullRomCurve3([...rim[0], tipPoint, ...[...rim[1]].reverse()], false, 'centripetal');
  const lipGeometry = new THREE.TubeGeometry(lipCurve, 48, lip * MM, 8, false);
  return { walls, lip: lipGeometry };
}

// ------------------------------------------------------------------ textures & materials

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas unavailable');
  return [canvas, context];
}

/** Independent roughness field: fine cast grain plus faint turning lines along `v`. */
function makeRoughnessTexture(seed: number, base: number, grain: number, turning: number): THREE.CanvasTexture {
  const size = 512;
  const [canvas, context] = makeCanvas(size, size);
  const image = context.createImageData(size, size);
  const random = mulberry32(seed);
  const rows = Array.from({ length: size }, () => random());
  for (let y = 0; y < size; y += 1) {
    const line = Math.sin((y / size) * TAU * 90) * 0.5 + (rows[y] - 0.5);
    for (let x = 0; x < size; x += 1) {
      const value = base + (random() - 0.5) * grain + line * turning;
      const byte = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
      const offset = (y * size + x) * 4;
      image.data[offset] = byte;
      image.data[offset + 1] = byte;
      image.data[offset + 2] = byte;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

type MokaMaterials = {
  aluminiumCast: THREE.MeshPhysicalMaterial;
  aluminiumPolished: THREE.MeshPhysicalMaterial;
  aluminiumSheet: THREE.MeshPhysicalMaterial;
  blackPlastic: THREE.MeshPhysicalMaterial;
  valveSteel: THREE.MeshPhysicalMaterial;
  filterSteel: THREE.MeshPhysicalMaterial;
  rubber: THREE.MeshStandardMaterial;
  gasketRubber: THREE.MeshPhysicalMaterial;
};

function createMaterials(): MokaMaterials {
  const polishedRoughness = makeRoughnessTexture(23, 0.2, 0.03, 0.03);
  // Cast body: sanded satin, not a mirror. Highlights spread wide and soft, broken up by fine
  // vertical sanding grain and faint hand-finishing patches, as on the reference facets.
  const castFinish: SurfaceFinish = {
    grainSize: 0.1,
    streak: 7,
    grainRoughness: 0.14,
    bumpDepth: 0.004,
    mottleSize: 2.5,
    mottleStreak: 12,
    mottleRoughness: 0.08,
    mottleColor: 0.045,
  };
  const aluminiumCast = applySurfaceFinish(
    new THREE.MeshPhysicalMaterial({ name: 'aluminium-cast', color: 0xcdd0d3, metalness: 1, roughness: 0.36 }),
    castFinish,
  );
  const aluminiumSheet = applySurfaceFinish(
    new THREE.MeshPhysicalMaterial({ name: 'aluminium-sheet', color: 0xcdd0d3, metalness: 1, roughness: 0.36, side: THREE.DoubleSide }),
    castFinish,
  );
  // Turned collar and neck ring: brighter lathe finish, anisotropic along the turning lines.
  const aluminiumPolished = applySurfaceFinish(
    new THREE.MeshPhysicalMaterial({
      name: 'aluminium-polished',
      color: 0xdfe1e3,
      metalness: 1,
      roughness: 1,
      roughnessMap: polishedRoughness,
      anisotropy: 0.4,
      anisotropyRotation: Math.PI / 2,
    }),
    { grainSize: 0.08, streak: 1, grainRoughness: 0.06, bumpDepth: 0.0015, mottleSize: 7, mottleStreak: 1, mottleRoughness: 0.04, mottleColor: 0.03 },
  );
  // Knob and handle: black matte thermoset with a fine stipple, so the sheen is a broad, dull glow.
  const blackPlastic = applySurfaceFinish(
    new THREE.MeshPhysicalMaterial({
      name: 'black-plastic',
      color: 0x181818,
      metalness: 0,
      roughness: 0.58,
      specularIntensity: 0.5,
    }),
    { grainSize: 0.07, streak: 1, grainRoughness: 0.16, bumpDepth: 0.007, mottleSize: 6, mottleStreak: 1, mottleRoughness: 0.06, mottleColor: 0.12 },
  );
  const valveSteel = applySurfaceFinish(
    new THREE.MeshPhysicalMaterial({ name: 'valve-steel', color: 0xb9bdc2, metalness: 1, roughness: 0.28 }),
    { grainSize: 0.06, streak: 1, grainRoughness: 0.08, bumpDepth: 0.0015, mottleSize: 3, mottleStreak: 1, mottleRoughness: 0.06, mottleColor: 0.05 },
  );
  // Stamped stainless sheet (filter plate): brushed satin, visible from both faces.
  const filterSteel = applySurfaceFinish(
    new THREE.MeshPhysicalMaterial({ name: 'filter-steel', color: 0xc4c7ca, metalness: 1, roughness: 0.34, side: THREE.DoubleSide }),
    { grainSize: 0.06, streak: 1, grainRoughness: 0.1, bumpDepth: 0.002, mottleSize: 5, mottleStreak: 1, mottleRoughness: 0.06, mottleColor: 0.05 },
  );
  const rubber = new THREE.MeshStandardMaterial({ name: 'rubber', color: 0x1a1a1a, roughness: 0.8 });
  // Food-grade gasket: off-white matte elastomer with a soft sheen.
  const gasketRubber = new THREE.MeshPhysicalMaterial({
    name: 'gasket-rubber',
    color: 0xe3dac6,
    metalness: 0,
    roughness: 0.72,
    sheen: 0.3,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0xfff6e6),
  });
  return { aluminiumCast, aluminiumPolished, aluminiumSheet, blackPlastic, valveSteel, filterSteel, rubber, gasketRubber };
}

// ------------------------------------------------------------------ assembly

export function createMokaPotModel(options: MokaPotModelOptions = {}): THREE.Group {
  const { castShadow = true, receiveShadow = true, internals = true } = options;
  const materials = createMaterials();
  const nodes: Record<string, THREE.Object3D> = {};
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, ColliderProxy> = {};

  const node = (id: string, parent: THREE.Object3D, position?: THREE.Vector3): THREE.Object3D => {
    const object = new THREE.Group();
    object.name = id;
    object.userData.partId = id;
    if (position) object.position.copy(position);
    parent.add(object);
    nodes[id] = object;
    return object;
  };
  const mesh = (partId: string, name: string, geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D): THREE.Mesh => {
    const m = new THREE.Mesh(geometry, material);
    m.name = `${partId}/${name}`;
    m.userData.partId = partId;
    m.castShadow = castShadow && !(material as THREE.MeshStandardMaterial).transparent;
    m.receiveShadow = receiveShadow;
    parent.add(m);
    meshes[m.name] = m;
    return m;
  };
  const socket = (id: string, parent: THREE.Object3D, position: THREE.Vector3, axis = new THREE.Vector3(0, 1, 0)): void => {
    const s = new THREE.Object3D();
    s.name = `socket:${id}`;
    s.position.copy(position);
    s.userData.axis = axis.toArray();
    parent.add(s);
    sockets[id] = s;
  };
  const mm = (x: number, y: number, z: number) => new THREE.Vector3(x * MM, y * MM, z * MM);

  const root = new THREE.Group();
  root.name = 'moka-pot';

  // --- lower assembly (the boiler is the kinematic root: everything sits on it)
  const lower = node('lower-chamber', root);
  mesh('lower-chamber', 'shell', buildLowerChamber(), materials.aluminiumCast, lower);
  socket('stove-contact', lower, mm(0, 0, 0), new THREE.Vector3(0, -1, 0));
  socket('neck-thread', lower, mm(0, S.neck.bottom, 0));
  colliders['lower-chamber'] = {
    type: 'octagonal-frustum',
    bottomApothem: S.lowerOuter[1][0] * MM,
    topApothem: S.lowerOuter[2][0] * MM,
    bottom: 0,
    top: S.lowerOuter[4][1] * MM,
  };

  const neck = node('lower-neck-ring', lower);
  mesh('lower-neck-ring', 'ring', buildNeckRing(), materials.aluminiumPolished, neck);
  colliders['lower-neck-ring'] = { type: 'cylinder', radius: S.neck.radius * MM, bottom: S.neck.bottom * MM, top: S.neck.top * MM };

  // Safety valve, permanently fixed to the lower chamber, seated on the front-left facet and aligned with that (tilted) facet's normal.
  const valveAzimuth = THREE.MathUtils.degToRad(S.valve.azimuthDeg);
  const valveHorizontal = new THREE.Vector3(Math.cos(valveAzimuth), 0, Math.sin(valveAzimuth));
  const slope = (S.lowerOuter[2][0] - S.lowerOuter[1][0]) / (S.lowerOuter[2][1] - S.lowerOuter[1][1]);
  const valveNormal = valveHorizontal.clone().multiplyScalar(1).setY(-slope).normalize();
  const valveApothem = radiusAt(S.lowerOuter, S.valve.height);
  const valveSeat = valveHorizontal.clone().multiplyScalar(valveApothem * MM).setY(S.valve.height * MM);
  const valve = node('safety-valve', lower, valveSeat);
  valve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), valveNormal);
  socket('valve-port', lower, valveSeat.clone(), valveNormal.clone());
  {
    const { nutAcrossFlats, nutDepth, flangeRadius, pinRadius, pinLength } = S.valve;
    const flange = new THREE.CylinderGeometry(flangeRadius * MM, flangeRadius * MM, 0.8 * MM, 32);
    flange.translate(0, 0.2 * MM, 0);
    mesh('safety-valve', 'flange', flange, materials.valveSteel, valve);
    const nutRadius = nutAcrossFlats / 2 / Math.cos(Math.PI / 6);
    const nut = new THREE.CylinderGeometry(nutRadius * MM, nutRadius * MM, nutDepth * MM, 6).toNonIndexed();
    nut.computeVertexNormals();
    nut.rotateY(Math.PI / 6);
    nut.translate(0, (0.6 + nutDepth / 2) * MM, 0);
    mesh('safety-valve', 'nut', nut, materials.valveSteel, valve);
    const pin = new THREE.CylinderGeometry(pinRadius * MM, pinRadius * MM, pinLength * MM, 24);
    pin.translate(0, (0.6 + nutDepth + pinLength / 2) * MM, 0);
    mesh('safety-valve', 'pin', pin, materials.valveSteel, valve);
    const cap = new THREE.SphereGeometry(pinRadius * MM, 24, 12, 0, TAU, 0, Math.PI / 2);
    cap.scale(1, 0.55, 1);
    cap.translate(0, (0.6 + nutDepth + pinLength) * MM, 0);
    mesh('safety-valve', 'pin-cap', cap, materials.valveSteel, valve);
  }

  const funnel = node('funnel-basket', lower);
  if (internals) {
    const { basket, holes } = S.funnel;
    mesh('funnel-basket', 'cup', buildFunnelCup(), materials.aluminiumSheet, funnel);
    // The perforated plate rests on the wall's inner ledge.
    const plateRadius = basket.topRadius - basket.sheet;
    mesh('funnel-basket', 'floor', buildPerforatedDisc(plateRadius, basket.step + 0.3, holes), materials.aluminiumSheet, funnel);
    mesh('funnel-basket', 'stem', buildFunnelStem(), materials.aluminiumSheet, funnel);
  }
  colliders['funnel-basket'] = {
    type: 'cylinder',
    radius: S.funnel.rim.lipRadius * MM,
    bottom: S.funnel.stem.bottom * MM,
    top: S.funnel.rim.top * MM,
  };

  // --- upper assembly (unscrews from the boiler as one unit)
  const upper = node('upper-chamber', lower);
  mesh('upper-chamber', 'shell', buildUpperChamber(), materials.aluminiumCast, upper);
  colliders['upper-chamber'] = {
    type: 'octagonal-frustum',
    bottomApothem: S.upperOuter[1][0] * MM,
    topApothem: S.upperOuter[3][0] * MM,
    bottom: S.collar.bottom * MM,
    top: S.upperOuter[3][1] * MM,
  };

  const collar = node('upper-collar', upper);
  mesh('upper-collar', 'band', buildCollar(), materials.aluminiumPolished, collar);

  if (internals) {
    mesh('upper-chamber', 'chimney', buildChimney(), materials.aluminiumCast, upper);
  }
  // Coffee outlets: the two slot ports under the chimney cap, streams leave sideways (±Z).
  for (const side of [1, -1]) {
    const { height } = S.chimney.ports;
    socket(`chimney-port-${side > 0 ? 'front' : 'back'}`, upper, mm(0, height, side * chimneyRadiusAt(height)), new THREE.Vector3(0, 0, side));
  }
  // Filter plate and gasket stay clamped in the upper chamber when it is unscrewed.
  const gasketNode = node('gasket', upper);
  const filterPlate = node('filter-plate', upper);
  if (internals) {
    mesh('gasket', 'ring', buildGasket(), materials.gasketRubber, gasketNode);
    const { top, dishDepth, dishRadius, holes } = S.filterPlate;
    mesh('filter-plate', 'rim', buildFilterPlateRim(), materials.filterSteel, filterPlate);
    mesh('filter-plate', 'screen', buildPerforatedDisc(dishRadius + 0.05, top - dishDepth, holes), materials.filterSteel, filterPlate);
  }
  colliders.gasket = { type: 'cylinder', radius: S.gasket.outerRadius * MM, bottom: S.gasket.bottom * MM, top: S.gasket.top * MM };
  colliders['filter-plate'] = {
    type: 'cylinder',
    radius: S.filterPlate.flangeOuter * MM,
    bottom: (S.filterPlate.top - S.filterPlate.dishDepth) * MM,
    top: S.filterPlate.top * MM,
  };

  const spout = node('pour-spout', upper);
  {
    const { walls, lip } = buildSpout();
    mesh('pour-spout', 'walls', walls, materials.aluminiumSheet, spout);
    mesh('pour-spout', 'lip', lip, materials.aluminiumCast, spout);
  }
  socket('spout-tip', spout, mm(S.spout.tip[0], S.spout.tip[1], 0), new THREE.Vector3(-1, 0, 0));

  // Hinge pin at +X; the lid pivots about it (axis +Z). The handle's top arm wraps it.
  const hinge = node('hinge-bracket', upper);
  {
    const { pinRadius, pinHalfLength, pivot, bracket } = S.hinge;
    const plate = new RoundedBoxGeometry(
      (bracket.max[0] - bracket.min[0]) * MM,
      (bracket.max[1] - bracket.min[1]) * MM,
      bracket.halfDepth * 2 * MM,
      2,
      0.8 * MM,
    );
    plate.translate(((bracket.min[0] + bracket.max[0]) / 2) * MM, ((bracket.min[1] + bracket.max[1]) / 2) * MM, 0);
    mesh('hinge-bracket', 'plate', plate, materials.aluminiumPolished, hinge);
    const pin = new THREE.CylinderGeometry(pinRadius * MM, pinRadius * MM, pinHalfLength * 2 * MM, 16);
    pin.rotateX(Math.PI / 2);
    pin.translate(pivot[0] * MM, pivot[1] * MM, 0);
    mesh('hinge-bracket', 'pin', pin, materials.valveSteel, hinge);
    const pinHeads = new THREE.CylinderGeometry(pinRadius * 1.5 * MM, pinRadius * 1.5 * MM, 0.6 * MM, 16);
    pinHeads.rotateX(Math.PI / 2);
    for (const z of [-pinHalfLength, pinHalfLength]) {
      const head = pinHeads.clone();
      head.translate(pivot[0] * MM, pivot[1] * MM, z * MM);
      mesh('hinge-bracket', `pin-head-${z < 0 ? 'back' : 'front'}`, head, materials.valveSteel, hinge);
    }
  }
  socket('lid-hinge', upper, mm(S.hinge.pivot[0], S.hinge.pivot[1], 0), new THREE.Vector3(0, 0, 1));

  const lidPivot = node('lid', upper, mm(S.hinge.pivot[0], S.hinge.pivot[1], 0));
  const lidBody = new THREE.Group();
  lidBody.name = 'lid-body';
  lidBody.position.set(-S.hinge.pivot[0] * MM, -S.hinge.pivot[1] * MM, 0);
  lidPivot.add(lidBody);
  mesh('lid', 'shell', buildLid(), materials.aluminiumCast, lidBody);
  {
    const { min, max, halfDepth } = S.lidEar;
    const ear = new RoundedBoxGeometry((max[0] - min[0]) * MM, (max[1] - min[1]) * MM, halfDepth * 2 * MM, 3, 1.2 * MM);
    ear.translate(((min[0] + max[0]) / 2) * MM, ((min[1] + max[1]) / 2) * MM, 0);
    mesh('lid', 'hinge-ear', ear, materials.aluminiumPolished, lidBody);
  }
  socket('knob-seat', lidBody, mm(0, S.lid.apexHeight, 0));
  colliders.lid = { type: 'box', min: [-S.lid.rimRadius * MM, S.lid.rimBottom * MM, -S.lid.rimRadius * MM], max: [S.lid.rimRadius * MM, S.lid.apexHeight * MM, S.lid.rimRadius * MM] };

  const knob = node('knob', lidBody, mm(0, S.lid.apexHeight - 0.3, 0));
  mesh('knob', 'finial', buildKnob(), materials.blackPlastic, knob);
  colliders.knob = { type: 'cylinder', radius: 10.5 * MM, bottom: S.lid.apexHeight * MM, top: (S.lid.apexHeight + 23.4) * MM };

  const handle = node('handle', upper);
  mesh('handle', 'body', buildHandle(), materials.blackPlastic, handle);
  socket('grip', handle, mm(S.handle.grip[0], S.handle.grip[1], 0));
  colliders.handle = {
    type: 'capsule-chain',
    points: S.handle.centerline.map(([x, y]) => [x * MM, y * MM, 0] as [number, number, number]),
    radius: S.handle.colliderRadius * MM,
  };

  // --- runtime controls
  const lidMaxAngle = THREE.MathUtils.degToRad(88);
  // The upper chamber lifts off the boiler carrying the lid, hinge, knob and handle rigidly with it; the safety valve
  // stays on the boiler. The loose internals separate from both.
  const explodeOffsets: [THREE.Object3D, THREE.Vector3][] = [
    [upper, new THREE.Vector3(0, 0.13, 0)],
    // Lifts clear of the neck so the whole stem shows.
    [funnel, new THREE.Vector3(0, 0.065, 0)],
    // Relative to the upper chamber: drop out below the collar in assembly order.
    [filterPlate, new THREE.Vector3(0, -0.03, 0)],
    [gasketNode, new THREE.Vector3(0, -0.05, 0)],
  ];
  const restPositions = new Map(explodeOffsets.map(([object]) => [object, object.position.clone()]));

  const runtime: MokaPotRuntime = {
    nodes,
    meshes,
    sockets,
    colliders,
    setLidOpen(amount) {
      lidPivot.rotation.z = -THREE.MathUtils.clamp(amount, 0, 1) * lidMaxAngle;
    },
    setExplode(amount) {
      const t = THREE.MathUtils.clamp(amount, 0, 1);
      for (const [object, offset] of explodeOffsets) {
        object.position.copy(restPositions.get(object)!).addScaledVector(offset, t);
      }
    },
  };
  root.userData.runtime = runtime;
  root.userData.sculptRuntime = runtime; // img2threejs action-ready contract name
  root.userData.approximationNotes = [
    'single front reference: back assumed radially symmetric',
    'handle side profile traced from a replacement-handle photo (straighter grip with finger scallops than the product shot); depth (Z) inferred',
    'funnel, filter plate, gasket and chimney are hidden in the reference; shapes follow exploded-parts photos, sizes fitted to the neck and collar',
  ];
  return root;
}

export function getMokaPotRuntime(model: THREE.Object3D): MokaPotRuntime {
  return model.userData.runtime as MokaPotRuntime;
}
