import * as THREE from 'three';

// Basic 3D scene: flat placeholder terrain + a sun light. Terrain will come from LOLA data later.
export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(0, 20, 40);
  camera.lookAt(0, 0, 0);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60, 64, 64),
    new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(50, 5, 0); // low sun angle, like the lunar south pole
  scene.add(sun, new THREE.AmbientLight(0xffffff, 0.05));

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop(() => renderer.render(scene, camera));
  return { scene, camera, renderer, sun };
}
