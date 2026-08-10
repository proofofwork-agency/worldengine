import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface ArtifactGlbViewer {
  dispose(): void;
}

/** Mounts a deliberately small, isolated GLB inspector for compile artifacts. */
export function mountArtifactGlbViewer(canvas: HTMLCanvasElement, uri: string, onError?: (error: Error) => void): ArtifactGlbViewer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.16;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101411);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 10_000);
  camera.position.set(2.5, 1.8, 3.5);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x2a2118, 2.1));
  const sun = new THREE.DirectionalLight(0xffe7c2, 3.2);
  sun.position.set(4, 7, 5);
  sun.castShadow = true;
  scene.add(sun);
  const grid = new THREE.GridHelper(8, 16, 0x526159, 0x29322d);
  scene.add(grid);

  let disposed = false;
  let frame = 0;
  let root: THREE.Object3D | undefined;
  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  new GLTFLoader().load(uri, (gltf) => {
    if (disposed) return;
    root = gltf.scene;
    root.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = object.receiveShadow = true; });
    scene.add(root);
    const box = new THREE.Box3().setFromObject(root);
    if (!box.isEmpty()) {
      const center = box.getCenter(new THREE.Vector3());
      const size = Math.max(0.01, box.getSize(new THREE.Vector3()).length());
      root.position.sub(center);
      camera.near = Math.max(0.001, size / 1_000);
      camera.far = Math.max(100, size * 100);
      camera.position.set(size * 0.65, size * 0.42, size * 0.8);
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();
    }
  }, undefined, (error) => onError?.(error instanceof Error ? error : new Error(String(error))));

  const render = () => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
    frame = requestAnimationFrame(render);
  };
  render();

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      root?.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      renderer.dispose();
    },
  };
}
