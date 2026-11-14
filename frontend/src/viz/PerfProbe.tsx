// Mount only when PERF_ENABLED (see perf.ts).
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import { formatPerf, percentile, tileBuildTimes, type PerfStats } from './perf'

const WINDOW = 120 // frames kept for percentiles

/** Inside <Canvas>: records frame times and renderer counters into window.__perf. */
export function PerfProbe() {
  const last = useRef(0)
  const times = useRef<number[]>([])
  const frames = useRef(0)

  useFrame(({ gl }) => {
    const now = performance.now()
    if (last.current) {
      times.current.push(now - last.current)
      if (times.current.length > WINDOW) times.current.shift()
    }
    last.current = now
    frames.current++
    const sorted = [...times.current].sort((a, b) => a - b)
    const info = gl.info // counters of the previous frame (reset at the start of each render)
    const n = tileBuildTimes.length
    const stats: PerfStats = {
      frames: frames.current,
      frameMsP50: percentile(sorted, 0.5),
      frameMsP95: percentile(sorted, 0.95),
      fps: sorted.length ? 1000 / (sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      tileBuilds: n,
      tileBuildMsAvg: n ? tileBuildTimes.reduce((a, b) => a + b, 0) / n : 0,
      tileBuildMsMax: n ? Math.max(...tileBuildTimes) : 0,
    }
    window.__perf = {
      ...stats,
      // Clears the published numbers too: with frameloop="demand" an idle view draws no frame
      // that would overwrite them, and "0 frames" is then the right answer.
      reset: () => {
        times.current = []
        tileBuildTimes.length = 0
        frames.current = 0
        last.current = 0
        Object.assign(window.__perf!, { frames: 0, fps: 0, frameMsP50: 0, frameMsP95: 0, tileBuilds: 0 })
      },
    }
  })
  return null
}

/** Outside the Canvas: a small text readout of window.__perf, refreshed twice a second. */
export function PerfOverlay() {
  const [text, setText] = useState('')
  useEffect(() => {
    const id = setInterval(() => window.__perf && setText(formatPerf(window.__perf)), 500)
    return () => clearInterval(id)
  }, [])
  return (
    <pre className="pointer-events-none absolute left-2 top-2 z-50 rounded bg-black/70 px-2 py-1 font-mono text-[10px] leading-tight text-lime-300">
      {text}
    </pre>
  )
}
