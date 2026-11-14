// LRO WAC imagery on the terrain tiles when zoomed out (/api/imagery/tile, Moon Trek mosaics,
// ~100 m/px), Google Earth style: close up the terrain is plain grey with the live sunlight and
// shadows; zooming out it cross-fades into the photo mosaic (imageryMix), and back when zooming in.
//
// Images exist for levels 0..IMAGERY_MAX_ZOOM; a deeper tile shows the matching part of its
// level-7 ancestor's image, and a tile whose own image is still loading borrows the nearest loaded
// ancestor's (so zooming never flashes grey). Levels 0-2 come from a static pack (imageryPack.ts).
// Each drawn tile with an image gets its own material: the terrain material plus the image and a
// shader tweak that mixes the two by `imageryMix` (one uniform per material).
//
// The mosaics are photographs, so their shadows are from when they were taken, not from the time
// selected in the app; the live sunlight still shades them. Nothing is calculated from them.
import * as THREE from 'three'
import { API_URL } from '../api'
import { imageryPack } from './imageryPack'

export const IMAGERY_MAX_ZOOM = 7 // must match backend/app/engine/imagery.py
/** Below this camera altitude: plain terrain only (the Site and Region views, ~3 and ~420 km up). */
export const IMAGERY_FADE_START_M = 1_000_000
/** Above this altitude: the photo mosaic only, near the furthest zoom-out (Scene's MAX_CAMERA_DISTANCE_M,
 * 8,000 km, which the zoom eases towards without quite reaching). A wide band (7.5x in altitude): the fade
 * takes a good stretch of scrolling, like Google Earth's. The Globe view (~4,260 km up) is ~80% photo. */
export const IMAGERY_FADE_END_M = 7_500_000
/** Images are requested from this altitude, a little below the fade, so they're ready as it starts. */
export const IMAGERY_PREFETCH_M = 0.6 * IMAGERY_FADE_START_M
/** Levels in the static pack (imageryPack.ts): every tile can show its ancestor's image at once. */
const STANDIN_ZOOM = 2
const TILE_FADE_MS = 300 // a tile's first image fades in instead of popping
const MAX_IN_FLIGHT = 4
const MAX_TEXTURES = 200
// Mosaic bytes are display brightness (mean ~40/255 at the pole and on the maria). Read as
// linear values and scaled so the average looks like the plain grey terrain.
const GAIN = 2.2

/** How much of the photo mosaic shows at a camera altitude (m): 0 = plain terrain, 1 = imagery. */
export function imageryMix(altitudeM: number): number {
  if (altitudeM <= IMAGERY_FADE_START_M) return 0
  if (altitudeM >= IMAGERY_FADE_END_M) return 1
  // Even in log altitude (zooming is exponential), eased at both ends.
  const t = Math.log(altitudeM / IMAGERY_FADE_START_M) / Math.log(IMAGERY_FADE_END_M / IMAGERY_FADE_START_M)
  return t * t * (3 - 2 * t)
}

/** Whether images should be loaded and applied at this altitude. */
export const imageryWanted = (altitudeM: number) => altitudeM > IMAGERY_PREFETCH_M

// Replaces three's map_fragment (diffuseColor *= texel) with a mix between the material's own
// colour and the photo, so the same shader serves every point of the fade.
const MIX_GLSL = /* glsl */ `
#ifdef USE_MAP
  vec3 imageryAlbedo = texture2D( map, vMapUv ).rgb * IMAGERY_GAIN;
  diffuseColor.rgb = mix( diffuseColor.rgb, imageryAlbedo, imageryMix );
#endif
`

/** The shader tweak for one material (its own uniform). Kept in userData too: SunLight's far
 * shadows replace onBeforeCompile with their own and chain this one back in (see SunLight.tsx). */
function mixHook(uniform: { value: number }): THREE.Material['onBeforeCompile'] {
  return (shader) => {
    shader.uniforms.imageryMix = uniform
    shader.fragmentShader = 'uniform float imageryMix;\n' + shader.fragmentShader.replace('#include <map_fragment>', MIX_GLSL)
  }
}

export interface ImageryTile {
  key: string // the tile's own key
  face: number
  z: number
  x: number
  y: number
  mesh: THREE.Mesh
}

interface TextureEntry {
  state: 'idle' | 'loading' | 'ready' | 'error' // idle: wanted, waiting for a download slot
  texture: THREE.Texture | null
  lastUsed: number
  readyAt: number // when it arrived (a tile's first image fades in from then)
}

interface TileMaterial {
  material: THREE.Material
  map: THREE.Texture
  owned: boolean // a cropped clone of an ancestor's texture (disposed with the material)
  texKey: string // whose image it shows
  mix: { value: number }
  fadeFrom: number // when its image started fading in (-Infinity: shown at once)
}

const texKeyOf = (face: number, z: number, x: number, y: number) => `${face}/${z}/${x}/${y}`

export class TileImagery {
  private readonly textures = new Map<string, TextureEntry>()
  private readonly materials = new Map<string, TileMaterial>()
  private queue: string[] = [] // backend downloads waiting for a slot: rebuilt at every selection
  private readonly loader = new THREE.TextureLoader()
  private readonly onChange: () => void
  private readonly anisotropy: number
  private inFlight = 0
  private disposed = false

  constructor(onChange: () => void, anisotropy: number) {
    this.onChange = onChange
    this.anisotropy = anisotropy
  }

  /** Give every drawn tile its imagery material (the best image loaded so far), and ask for missing images. */
  apply(tiles: ImageryTile[], base: THREE.Material, now: number) {
    const wanted = new Set<string>()
    for (const t of tiles) {
      // The image this tile should show, then its ancestors' as stand-ins while it loads.
      const top = Math.min(t.z, IMAGERY_MAX_ZOOM)
      let use: { texKey: string; d: number; texture: THREE.Texture; readyAt: number } | null = null
      for (let az = top; az >= 0; az--) {
        const d = t.z - az
        const texKey = texKeyOf(t.face, az, t.x >> d, t.y >> d)
        let entry = this.textures.get(texKey)
        // Ask for the tile's own image, and for its level-STANDIN_ZOOM ancestor (from the static pack,
        // quick) to show meanwhile; anything in between is used if it happens to be loaded.
        if (!entry && (az === top || az === Math.min(top, STANDIN_ZOOM))) {
          entry = { state: 'idle', texture: null, lastUsed: now, readyAt: 0 }
          this.textures.set(texKey, entry)
        }
        if (!entry) continue
        if (entry.state === 'idle') wanted.add(texKey)
        entry.lastUsed = now
        if (entry.state === 'ready' && entry.texture) {
          use = { texKey, d, texture: entry.texture, readyAt: entry.readyAt }
          break
        }
      }
      if (!use) {
        if (t.mesh.material !== base) t.mesh.material = base
        continue
      }
      let m = this.materials.get(t.key)
      if (!m || m.texKey !== use.texKey) {
        // A tile's first photo fades in if it has only just arrived (a tile newly split off a parent
        // that already showed it doesn't); a sharper one replacing a stand-in swaps at once.
        const fadeFrom = m ? -Infinity : use.readyAt
        if (m) this.forget(t.key)
        m = this.makeMaterial(t, use, base, fadeFrom)
        this.materials.set(t.key, m)
      }
      if (t.mesh.material !== m.material) t.mesh.material = m.material
    }
    // Pack images (the stand-ins) load at once: they're already in memory. Backend downloads queue for
    // the tiles on screen now, coarse first (those cover the most screen); ones no longer needed drop out.
    const zOf = (k: string) => Number(k.split('/')[1])
    for (const k of wanted) if (zOf(k) <= STANDIN_ZOOM) this.load(k, false)
    this.queue = [...wanted].filter((k) => zOf(k) > STANDIN_ZOOM).sort((a, b) => zOf(a) - zOf(b))
    this.pump()
    this.evict(now)
  }

  /**
   * Update every imagery material for the zoom-dependent mix. Returns true while a tile is still
   * fading in (the caller keeps rendering frames until it's done).
   */
  tick(now: number, mix: number): boolean {
    let fading = false
    for (const m of this.materials.values()) {
      const f = Math.min(1, (now - m.fadeFrom) / TILE_FADE_MS)
      if (f < 1 && mix > 0) fading = true
      m.mix.value = mix * f
    }
    return fading
  }

  /** Zoomed in below the imagery altitudes: plain terrain on these meshes (materials kept for later). */
  release(meshes: Iterable<THREE.Mesh>, base: THREE.Material) {
    for (const mesh of meshes) if (mesh.material !== base) mesh.material = base
  }

  /** A tile's mesh is gone: free its material. */
  forget(tileKey: string) {
    const m = this.materials.get(tileKey)
    if (!m) return
    m.material.dispose()
    if (m.owned) m.map.dispose()
    this.materials.delete(tileKey)
  }

  /** Put the plain material back on these meshes and free everything. */
  dispose(meshes: Iterable<THREE.Mesh>, base: THREE.Material) {
    this.disposed = true
    for (const mesh of meshes) mesh.material = base
    for (const key of [...this.materials.keys()]) this.forget(key)
    for (const e of this.textures.values()) e.texture?.dispose()
    this.textures.clear()
    this.queue.length = 0
  }

  private makeMaterial(
    t: ImageryTile,
    use: { texKey: string; d: number; texture: THREE.Texture },
    base: THREE.Material,
    fadeFrom: number,
  ): TileMaterial {
    let map = use.texture
    let owned = false
    if (use.d > 0) {
      // This tile's part of the ancestor's image (same pixels on the GPU, own uv transform).
      map = use.texture.clone()
      const s = 1 / 2 ** use.d
      map.repeat.set(s, s)
      map.offset.set((t.x - ((t.x >> use.d) << use.d)) * s, (t.y - ((t.y >> use.d) << use.d)) * s)
      owned = true
    }
    const material = base.clone() as THREE.MeshStandardMaterial
    material.map = map
    material.defines = { ...material.defines, IMAGERY_MIX: '', IMAGERY_GAIN: GAIN.toFixed(2) }
    const mix = { value: 0 }
    const hook = mixHook(mix)
    material.userData.beforeCompile = hook
    material.onBeforeCompile = hook
    return { material, map, owned, texKey: use.texKey, mix, fadeFrom }
  }

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length) this.load(this.queue.shift()!, true)
  }

  /** Fetch one image (from the pack if it's there); `slot`: counts against MAX_IN_FLIGHT. */
  private load(texKey: string, slot: boolean) {
    const entry = this.textures.get(texKey)
    if (!entry || entry.state !== 'idle') return
    entry.state = 'loading'
    if (slot) this.inFlight++
    imageryPack()
      .then((pack) => this.loader.loadAsync(pack?.get(texKey) ?? `${API_URL}/api/imagery/tile/${texKey}`))
      .then((texture) => {
        if (this.disposed || this.textures.get(texKey) !== entry) return texture.dispose()
        texture.colorSpace = THREE.NoColorSpace // see GAIN
        texture.anisotropy = this.anisotropy // sharp at the grazing angles of the site view
        texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
        entry.texture = texture
        entry.state = 'ready'
        entry.readyAt = performance.now()
      })
      .catch(() => {
        entry.state = 'error' // that tile keeps its ancestor's image (or stays plain)
      })
      .finally(() => {
        if (slot) this.inFlight--
        if (this.disposed) return
        this.pump()
        this.onChange()
      })
  }

  /** Drop images nobody has drawn for a while once there are many. */
  private evict(now: number) {
    if (this.textures.size <= MAX_TEXTURES) return
    const old = [...this.textures.entries()]
      .filter(([, e]) => e.state !== 'loading' && now - e.lastUsed > 15_000)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
      .slice(0, this.textures.size - MAX_TEXTURES)
    for (const [texKey, e] of old) {
      // Free materials still pointing at this image (their tiles were not drawn either).
      for (const [tileKey, m] of this.materials) if (m.texKey === texKey) this.forget(tileKey)
      e.texture?.dispose()
      this.textures.delete(texKey)
    }
  }
}
