// Reconstruction data for the 3-cup Moka Express, kept separate from the renderer.
// Source of truth: .img2threejs/object-sculpt-spec.json (`reconstructionGeometry`), measured
// from the reference silhouette at 1 px = 0.14423 mm. All values are millimetres; the
// factory converts to metres.
//
// Octagon radii are APOTHEMS (centre → middle of a facet). A face-on octagon's silhouette
// width is its across-flats width, so that is what the reference measures directly.
//
// Frame: +Y up, origin at the base centre, +Z toward the viewer (logo facet),
// handle on +X, spout on −X.

export type ProfilePoint = readonly [radius: number, height: number];

export const MOKA_POT_SPEC = {
  facets: 8,
  wall: 1.6,

  // Boiler: octagonal frustum widening downward, short shoulder chamfer into the round neck.
  lowerOuter: [
    [41.6, 0.0],
    [43.8, 1.4],
    [36.49, 54.23],
    [34.04, 55.38],
    [32.02, 55.67],
  ] as ProfilePoint[],

  // Round threaded neck of the boiler; its top hides inside the collar, where its rim carries
  // the funnel flange (see the internal stack below).
  neck: { radius: 32.02, bottom: 55.38, top: 73.0, grooves: [57.6, 59.3], thread: { from: 62.2, to: 72.4, pitch: 1.4, depth: 0.45 } },

  // Round threaded skirt of the upper chamber ("Moka Express" band).
  collar: { radius: 35.77, innerRadius: 32.1, bottom: 61.15, top: 76.73 },

  // Collector: octagonal frustum widening upward, with a thin lip at the rim.
  upperOuter: [
    [35.77, 76.73],
    [36.88, 77.8],
    [45.9, 129.23],
    [46.6, 129.81],
  ] as ProfilePoint[],
  upperFloor: 81.8,

  lid: { rimRadius: 47.1, rimBottom: 129.81, rimTop: 131.6, apexRadius: 9.5, apexHeight: 142.6, thickness: 1.2 },
  // Raised hinge ear on the lid's +X side (bright plate between lid and handle in the reference).
  lidEar: { min: [31.0, 128.0], max: [57.0, 138.5], halfDepth: 4.6 },

  // Knob profile, heights relative to the lid apex. Flutes cut the flared body and cap.
  knob: {
    profile: [
      [6.0, 0.0],
      [6.3, 0.6],
      [6.6, 1.4],
      [6.9, 1.9],
      [7.2, 3.9],
      [8.1, 9.7],
      [9.5, 15.5],
      [10.3, 18.4],
      [10.5, 20.0],
      [9.6, 20.9],
      [6.0, 21.5],
      [0.0, 21.7],
    ] as ProfilePoint[],
    flutes: 12,
    fluteDepth: 0.7,
    fluteRange: [2.2, 20.4] as const,
  },

  // V pour spout on the −X facet. Side view (x, height): the keel runs from the facet at
  // `rootHeight` up to `knee`, the lip rolls out to `tip`, and the top edge climbs back over
  // the rim through `lipTop` to the facet corners. Plan view is a V narrowing to the tip.
  spout: {
    rootHeight: 89.5,
    knee: [-55.96, 120.58] as const,
    tip: [-61.5, 123.4] as const,
    lipTop: [
      [-59.8, 126.3],
      [-54.0, 131.0],
    ] as ProfilePoint[],
    rimHeight: 129.23,
    lip: 0.55,
  },

  // Handle side profile (x, height), traced from the user's handle photo (ref/handle-side.png)
  // and scaled uniformly (0.2 mm/px) into the product shot's handle bounding box. Clockwise from
  // the top of the pot end: flat top arm, chamfered outer corner, straight outer edge, rounded
  // heel, a toe hooking back toward the pot, two shallow finger scallops on the inner edge, and a
  // mounting tongue under the hinge bracket (the bracket itself stays visible, as in the photo).
  handle: {
    outline: [
      [56.8, 137.4], [59.9, 138.7], [67.5, 138.7], [70.7, 136.5], [75.5, 132.5], [81.9, 127.7],
      [84.1, 124.9], [83.9, 121.7], [82.7, 117.7], [82.3, 109.7], [82.3, 97.7], [81.5, 83.3],
      [82.3, 74.9], [81.1, 72.5], [79.9, 70.1], [77.1, 67.7], [73.5, 66.3], [70.7, 65.1],
      [67.1, 64.5], [64.3, 65.3], [62.7, 67.3], [61.7, 70.1], [62.1, 72.5], [65.1, 73.3],
      [69.5, 73.5], [70.7, 74.5], [71.7, 78.1], [70.5, 85.7], [71.5, 93.7], [72.1, 98.9],
      [70.5, 103.7], [70.3, 111.7], [70.3, 118.1], [69.5, 120.9], [65.5, 122.1], [61.5, 120.9],
      // Mounting tongue under the bracket: a wedge thickening toward the +X facet it butts against.
      [56.0, 117.0], [50.0, 114.6], [45.0, 113.2], [44.0, 114.2], [44.0, 119.8], [45.0, 120.7], [56.8, 120.7],
    ] as ProfilePoint[],
    // Moulded slab: flat side faces, every edge rounded by the bevel.
    halfDepth: 5.4,
    bevel: 1.3,
    // Centre-line for the collision capsule chain and the grip socket.
    centerline: [
      [60.0, 129.8], [65.5, 130.1], [79.5, 125.7], [76.5, 111.7], [76.7, 91.7], [76.7, 75.7], [71.5, 68.9], [64.5, 69.3],
    ] as ProfilePoint[],
    grip: [76.7, 91.7] as const,
    colliderRadius: 5.5,
  },
  // Bright bracket on the upper chamber below the lid ear; carries the hinge pin.
  hinge: {
    pivot: [51.5, 131.4] as const,
    pinRadius: 1.3,
    pinHalfLength: 5.4,
    bracket: { min: [43.8, 121.0], max: [56.5, 131.0], halfDepth: 3.9 },
  },

  // Safety valve on the front-left lower facet (facet normal azimuth 135° from +X).
  valve: { height: 45.58, azimuthDeg: 135, nutAcrossFlats: 12.0, nutDepth: 3.2, flangeRadius: 5.4, pinRadius: 2.1, pinLength: 3.4 },

  // Hidden internals. Not visible in the reference; shapes follow exploded-parts photos, sizes
  // are fitted to the boiler neck and collar. Stack at the boiler rim, bottom → top: funnel
  // flange on the rim → gasket → filter plate flange, clamped by the upper chamber's underside.
  // The plate's dish reaches down through the gasket into the funnel basket.
  funnel: {
    // Pressed sheet cup, no flange: a thickened rolled lip, just proud of the wall, rests on the
    // neck rim. Proportions from ref/funnel-inverted.png: wall depth ≈ 0.43 × diameter.
    rim: { lipRadius: 30.9, bottom: 73.0, top: 73.6 },
    // Straight wall stepping in slightly at `step` (the inner ledge the perforated plate rests
    // on), down to a rounded shoulder where a shallow cone (~19°) funnels into the stem.
    basket: { topRadius: 29.9, stepRadius: 29.3, step: 54.7, shoulder: 47.0, shoulderRadius: 1.6, apex: 38.7, sheet: 0.6 },
    // Slim open tube (≈ 0.165 × cup diameter, ≈ 0.48 × diameter below the cone apex) with a
    // rounded open end and a crimped collar ring where it joins the cone apex.
    stem: { outerRadius: 5.1, innerRadius: 4.5, bottom: 9.0, collarRadius: 6.4, collarHeight: 1.3 },
    // Separate flat perforated plate seated on the ledge: dense small holes, plain outer ring.
    holes: { radius: 0.45, pitch: 2.6, maxRadius: 26.6 },
  },
  // Stamped steel filter plate: perforated flat dish pressing down on the coffee bed,
  // a conical wall, and a flat flange that sits in the gasket's top recess.
  filterPlate: {
    flangeOuter: 27.6,
    flangeInner: 24.2,
    top: 76.7,
    sheet: 0.4,
    dishRadius: 22.6,
    dishDepth: 4.2,
    holes: { radius: 0.42, pitch: 1.95, maxRadius: 21.2 },
  },
  // Flat washer gasket, rectangular section with softened edges; the step on its upper inner
  // edge captures the filter plate flange.
  gasket: { outerRadius: 31.9, innerRadius: 24.8, bottom: 73.6, top: 76.7, recessRadius: 27.9, recessDepth: 0.45, edge: 0.5 },
  // Coffee column: tapered tube rising from the collector floor on a fillet, closed by a rounded
  // cap with a small centre boss. Coffee leaves through two slot ports just under the cap, facing
  // ±Z (sideways to the spout axis), so the streams run down the column.
  chimney: {
    bottom: 81.8,
    top: 118.0,
    baseRadius: 5.9,
    topRadius: 4.6,
    wall: 0.8,
    fillet: 1.8,
    cap: { shoulder: 1.3, bossRadius: 1.8, bossHeight: 0.7 },
    // Superelliptic slot: half-width along the surface, half-height, and edge squareness.
    ports: { height: 114.3, halfWidth: 2.7, halfHeight: 1.3, squareness: 3 },
  },
} as const;
