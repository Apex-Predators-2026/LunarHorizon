import type { Vector3 } from 'three'

export type Vec3Tuple = [number, number, number]

export interface CameraPose {
  position: Vec3Tuple
  quaternion: [number, number, number, number]
  up: Vec3Tuple
  target: Vec3Tuple
}

export function captureCameraPose(
  camera: { position: Vector3; quaternion: { toArray: () => number[] }; up: Vector3 },
  controls: { target: Vector3 } | null,
): CameraPose {
  const q = camera.quaternion.toArray()
  return {
    position: [camera.position.x, camera.position.y, camera.position.z],
    quaternion: [q[0], q[1], q[2], q[3]],
    up: [camera.up.x, camera.up.y, camera.up.z],
    target: controls ? [controls.target.x, controls.target.y, controls.target.z] : [0, 0, 0],
  }
}

export function applyCameraPose(
  camera: {
    position: Vector3
    quaternion: { set: (x: number, y: number, z: number, w: number) => void }
    up: Vector3
    updateMatrixWorld: () => void
  },
  controls: { target: Vector3; dispatchEvent?: (event: { type: 'change' }) => void },
  pose: CameraPose,
) {
  camera.position.set(...pose.position)
  camera.quaternion.set(...pose.quaternion)
  camera.up.set(...pose.up)
  camera.updateMatrixWorld()
  controls.target.set(...pose.target)
  controls.dispatchEvent?.({ type: 'change' })
}
