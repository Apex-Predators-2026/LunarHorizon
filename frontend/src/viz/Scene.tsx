import { Canvas } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'

// Placeholder scene: flat ground + low Sun. Terrain will come from the Moon Trek
// elevation grid served by the backend (Phase 4).
export function Scene() {
  return (
    <Canvas camera={{ position: [0, 20, 40], fov: 50 }}>
      <ambientLight intensity={0.05} />
      {/* Low sun angle, like the lunar south pole */}
      <directionalLight position={[50, 5, 0]} intensity={2} />
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[60, 60, 64, 64]} />
        <meshStandardMaterial color="#888888" />
      </mesh>
      <OrbitControls />
    </Canvas>
  )
}
