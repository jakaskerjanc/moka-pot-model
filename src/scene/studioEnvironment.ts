// Product-studio environment for look-dev, matched to the reference photo: strip softboxes on
// the left, right and above, and a darker wall behind the camera. The strips are narrow and the
// room is dark, so highlights on the metal have crisp edges and the contrast stays high. Facets facing the viewer
// therefore reflect the dark side (mid grey) and the 45° facets reflect the side softboxes
// (near white), which is the value pattern the reference shows.

import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// Softbox diffusion falloff: bright core dimming slightly toward the edges, so flat facets
// reflecting a softbox pick up a gradient while the softbox border stays a hard edge.
function softboxFalloff(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.7);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.6, '#d8d8d8');
  gradient.addColorStop(1, '#8c8c8c');
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let falloff: THREE.Texture | null = null;

function panel(width: number, height: number, intensity: number, softbox = false): THREE.Mesh {
  if (softbox) falloff ??= softboxFalloff();
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color().setScalar(intensity),
    map: softbox ? falloff : null,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
}

export function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(4, 4, 4),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(0.2), side: THREE.BackSide }),
  );
  scene.add(room);

  const left = panel(1.1, 2.4, 5.5, true);
  left.position.set(-1.9, 0.3, -0.2);
  left.rotation.y = Math.PI / 2;
  scene.add(left);

  const right = panel(1.1, 2.4, 4.0, true);
  right.position.set(1.9, 0.3, -0.2);
  right.rotation.y = -Math.PI / 2;
  scene.add(right);

  const top = panel(1.0, 1.0, 3.5, true);
  top.position.set(0, 1.9, 0);
  top.rotation.x = Math.PI / 2;
  scene.add(top);

  const behindCamera = panel(3.6, 3.0, 0.35);
  behindCamera.position.set(0, 0.2, 1.95);
  scene.add(behindCamera);

  const floor = panel(4, 4, 0.45);
  floor.position.set(0, -1.9, 0);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(scene, 0.02).texture;
  pmrem.dispose();
  return texture;
}

/** Photographed studio (equirectangular .hdr), prefiltered for image-based lighting. */
export async function loadHdriEnvironment(renderer: THREE.WebGLRenderer, url: string): Promise<THREE.Texture> {
  const equirect = await new HDRLoader().loadAsync(url);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromEquirectangular(equirect).texture;
  pmrem.dispose();
  equirect.dispose();
  return texture;
}
