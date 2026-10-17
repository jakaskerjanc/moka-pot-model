// Procedural wooden tabletop for the demo: planks with grain, pores and seams, generated once on a
// canvas (colour, roughness and bump maps share one pass). The top fades out radially through an
// alpha map so the table melts into whatever background colour the viewer uses, with no horizon line.

import * as THREE from 'three';

const TEXTURE_SIZE = 2048;
const PLANKS = 8;
const TILE_METRES = 1.12; // one texture tile = 8 planks of 14 cm
const TABLE_METRES = 3;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise, periodic in x (so planks tile along the grain); y is unbounded. */
function noise(x: number, y: number, periodX: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const ix0 = ((x0 % periodX) + periodX) % periodX;
  const ix1 = (ix0 + 1) % periodX;
  const a = hash(ix0, y0, seed);
  const b = hash(ix1, y0, seed);
  const c = hash(ix0, y0 + 1, seed);
  const d = hash(ix1, y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(u: number, v: number, freqU: number, freqV: number, seed: number): number {
  let sum = 0;
  let amplitude = 0.5;
  let total = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    const scale = 2 ** octave;
    sum += amplitude * noise(u * freqU * scale, v * freqV * scale, freqU * scale, seed + octave);
    total += amplitude;
    amplitude *= 0.5;
  }
  return sum / total;
}

function makeCanvas(): [HTMLCanvasElement, ImageData] {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  return [canvas, canvas.getContext('2d')!.createImageData(TEXTURE_SIZE, TEXTURE_SIZE)];
}

function woodTextures(): { color: THREE.CanvasTexture; roughness: THREE.CanvasTexture; height: THREE.CanvasTexture } {
  const [colorCanvas, colorData] = makeCanvas();
  const [roughCanvas, roughData] = makeCanvas();
  const [heightCanvas, heightData] = makeCanvas();
  const plankHeight = TEXTURE_SIZE / PLANKS;

  for (let plank = 0; plank < PLANKS; plank += 1) {
    const seed = plank * 7919 + 11;
    // Each plank has its own tint, grain spacing and a butt joint somewhere along its length.
    const tint = 0.86 + hash(plank, 1, seed) * 0.28;
    const ringFreq = 5 + hash(plank, 2, seed) * 5;
    const jointU = hash(plank, 3, seed);
    const stagger = hash(plank, 4, seed) * 40;

    for (let row = 0; row < plankHeight; row += 1) {
      const y = plank * plankHeight + row;
      const v = row / plankHeight; // 0..1 across the plank
      for (let x = 0; x < TEXTURE_SIZE; x += 1) {
        const u = x / TEXTURE_SIZE;
        // The two boards either side of the joint are different pieces of timber.
        const board = u < jointU ? 0 : 1;
        const boardSeed = seed + board * 101;
        const boardTint = tint * (0.94 + hash(board, plank, 5) * 0.12);

        // Long, wandering growth rings plus fine fibres along the grain.
        const warp = fbm(u, v + stagger, 2, 3, boardSeed);
        const rings = 0.5 + 0.5 * Math.sin((v * ringFreq + warp * 5 + stagger) * Math.PI * 2);
        const ringShape = rings * rings;
        const fibre = noise(u * 8, (v + stagger) * 240, 8, boardSeed + 30);
        const mottle = fbm(u, v + stagger, 3, 2, boardSeed + 60);
        const pore = noise(u * 96, (v + stagger) * 420, 96, boardSeed + 90) > 0.8 ? 1 : 0;

        let shade = boardTint * (0.82 + 0.3 * mottle) * (1 - 0.34 * ringShape) * (0.92 + 0.16 * fibre);
        shade *= 1 - 0.28 * pore;

        // Seams: a dark groove along the plank edges and across the butt joint.
        const edge = Math.min(v, 1 - v) * plankHeight; // px to the plank edge
        const jointDistance = Math.min(Math.abs(u - jointU), 1 - Math.abs(u - jointU)) * TEXTURE_SIZE;
        const groove = Math.max(1 - edge / 2.5, 0) + Math.max(1 - jointDistance / 2, 0) * 0.8;
        const grooveAmount = Math.min(groove, 1);
        shade *= 1 - 0.75 * grooveAmount;

        const i = (y * TEXTURE_SIZE + x) * 4;
        colorData.data[i] = Math.min(255, 118 * shade);
        colorData.data[i + 1] = Math.min(255, 76 * shade);
        colorData.data[i + 2] = Math.min(255, 44 * shade);
        colorData.data[i + 3] = 255;

        // Open-pored oiled wood: satiny, a little shinier on the ring-free late wood, matt in grooves.
        const roughness = Math.min(1, 0.52 + 0.18 * ringShape + 0.12 * (1 - fibre) + 0.3 * grooveAmount);
        roughData.data[i] = 0;
        roughData.data[i + 1] = roughness * 255;
        roughData.data[i + 2] = 0;
        roughData.data[i + 3] = 255;

        const height = Math.max(0, 0.7 - 0.25 * ringShape - 0.3 * pore + 0.1 * fibre - 0.8 * grooveAmount);
        heightData.data[i] = heightData.data[i + 1] = heightData.data[i + 2] = height * 255;
        heightData.data[i + 3] = 255;
      }
    }
  }

  const texture = (canvas: HTMLCanvasElement, data: ImageData, srgb: boolean) => {
    canvas.getContext('2d')!.putImageData(data, 0, 0);
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(TABLE_METRES / TILE_METRES, TABLE_METRES / TILE_METRES);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    color: texture(colorCanvas, colorData, true),
    roughness: texture(roughCanvas, roughData, false),
    height: texture(heightCanvas, heightData, false),
  };
}

function edgeFade(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, '#fff');
  gradient.addColorStop(0.35, '#fff');
  gradient.addColorStop(1, '#000');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** A wooden tabletop at y = 0 that receives the key light's shadow and fades out toward its edges. */
export function createTable(renderer: THREE.WebGLRenderer): THREE.Mesh {
  const { color, roughness, height } = woodTextures();
  for (const t of [color, roughness, height]) t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const material = new THREE.MeshStandardMaterial({
    map: color,
    roughnessMap: roughness,
    roughness: 1,
    bumpMap: height,
    bumpScale: 1.5,
    metalness: 0,
    alphaMap: edgeFade(),
    transparent: true,
  });
  const table = new THREE.Mesh(new THREE.PlaneGeometry(TABLE_METRES, TABLE_METRES), material);
  table.name = 'table';
  table.rotation.x = -Math.PI / 2;
  table.receiveShadow = true;
  table.renderOrder = -2;
  return table;
}
