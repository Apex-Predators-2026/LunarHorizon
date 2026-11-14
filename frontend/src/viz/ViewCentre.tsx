import { useThree } from '@react-three/fiber'
import { useLayoutEffect } from 'react'
import type { PerspectiveCamera } from 'three'

/**
 * Moves the whole 3D picture left by `shiftLeftPx` with a lens shift (camera.setViewOffset): the
 * camera isn't rotated, so the orbit centre (the lander, or the Moon's centre in the globe view)
 * lands in the middle of the area the side panels leave free instead of behind them.
 * Everything that projects through the camera (labels, clicks/raycasts, tile culling) follows,
 * because they all use the same projection matrix.
 */
export function ViewCentre({ shiftLeftPx }: { shiftLeftPx: number }) {
  const get = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)

  useLayoutEffect(() => {
    const camera = get().camera as PerspectiveCamera
    if (!camera.isPerspectiveCamera) return
    if (shiftLeftPx > 0) camera.setViewOffset(width, height, shiftLeftPx, 0, width, height)
    else camera.clearViewOffset()
    invalidate()
    return () => camera.clearViewOffset()
  }, [shiftLeftPx, width, height, get, invalidate])

  return null
}
