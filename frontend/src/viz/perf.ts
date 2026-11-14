// Developer performance stats for the 3D view, enabled with `?perf` in the URL (costs nothing otherwise).
// PerfProbe (inside the Canvas) fills `perf`; PerfOverlay shows it; test scripts read window.__perf.

export const PERF_ENABLED = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf')
/** `?perf=always` renders every frame (to measure frame cost); otherwise the canvas renders on demand. */
export const PERF_RENDER_ALWAYS = PERF_ENABLED && new URLSearchParams(window.location.search).get('perf') === 'always'

export interface PerfStats {
  frames: number
  frameMsP50: number
  frameMsP95: number
  fps: number
  drawCalls: number
  triangles: number
  geometries: number
  textures: number
  tileBuilds: number
  tileBuildMsAvg: number
  tileBuildMsMax: number
}

export const tileBuildTimes: number[] = []

/** TileTree calls this with the main-thread time spent turning one tile's heights into a mesh. */
export function recordTileBuild(ms: number) {
  if (PERF_ENABLED) tileBuildTimes.push(ms)
}

declare global {
  interface Window {
    __perf?: PerfStats & { reset: () => void }
  }
}

export const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0

export function formatPerf(s: PerfStats) {
  return (
    `${s.fps.toFixed(0)} fps  p50 ${s.frameMsP50.toFixed(1)} ms  p95 ${s.frameMsP95.toFixed(1)} ms\n` +
    `${s.drawCalls} calls  ${(s.triangles / 1e6).toFixed(2)} M tris  ${s.geometries} geoms\n` +
    `tiles built ${s.tileBuilds}  avg ${s.tileBuildMsAvg.toFixed(1)} ms  max ${s.tileBuildMsMax.toFixed(1)} ms`
  )
}

/** Camera height above the loaded ground below it, in metres (window.__cameraClearance), or null if unknown. */
export function recordCameraClearance(m: number | null) {
  if (PERF_ENABLED) (window as unknown as { __cameraClearance?: number | null }).__cameraClearance = m
}

/** Drawn tiles per level at the last selection (window.__tileLevels), for checking what the LOD picks. */
export function recordTileLevels(levels: Record<number, number>) {
  if (PERF_ENABLED) (window as unknown as { __tileLevels?: Record<number, number> }).__tileLevels = levels
}
