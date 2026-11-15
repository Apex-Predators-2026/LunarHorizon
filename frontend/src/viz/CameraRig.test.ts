import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { applyCameraPose, captureCameraPose } from './cameraPose'

describe('CameraRig pose preservation', () => {
  it('captures and restores exact camera position, quaternion, up, and controls target', () => {
    const camA = new THREE.PerspectiveCamera(50, 1.6, 0.5, 1e9)
    camA.position.set(12345.5, -6789.25, 42000.75)
    camA.quaternion.setFromEuler(new THREE.Euler(0.41, -0.73, 0.29, 'YXZ'))
    camA.up.set(0.18, 0.92, -0.35).normalize()
    camA.updateMatrixWorld()

    const controlsA = { target: new THREE.Vector3(950, -120, 3100) }
    const pose = captureCameraPose(camA, controlsA)

    const camB = new THREE.PerspectiveCamera(50, 1.6, 0.5, 1e9)
    const dispatchEvent = vi.fn()
    const controlsB = {
      target: new THREE.Vector3(),
      dispatchEvent,
    }

    applyCameraPose(camB, controlsB, pose)

    expect(camB.position.toArray()).toEqual(pose.position)
    expect(camB.quaternion.toArray()).toEqual(pose.quaternion)
    expect(camB.up.toArray()).toEqual(pose.up)
    expect(controlsB.target.toArray()).toEqual(pose.target)
    expect(dispatchEvent).toHaveBeenCalledWith({ type: 'change' })
  })
})
