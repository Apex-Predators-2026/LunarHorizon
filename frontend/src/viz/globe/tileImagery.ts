// Optional LRO WAC imagery on the terrain tiles (/api/imagery/tile, Moon Trek mosaics, ~100 m/px).
// Images exist for levels 0..IMAGERY_MAX_ZOOM; a deeper tile shows the matching part of its
// level-7 ancestor's image. Each drawn tile gets its own material (the terrain material plus its
// image); while an image loads, the tile keeps the plain terrain material.
//
// The mosaics are photographs, so their shadows are from when they were taken, not from the time
// selected in the app. The layer is for recognising places; nothing is calculated from it.
import * as THREE from 'three'
import { API_URL } from '../api'

export const IMAGERY_MAX_ZOOM = 7 // must match backend/app/engine/imagery.py
const MAX_IN_FLIGHT = 4
const MAX_TEXTURES = 200
// Mosaic bytes are display brightness (mean ~40/255 at the pole and on the maria). Read as
// linear values and scaled so the average looks like the plain grey terrain.
const GAIN = 2.2

export interface ImageryTile {
  key: string // the tile's own key
  face: number
  z: number
  x: number
  y: number
  mesh: THREE.Mesh
}

interface TextureEntry {
  state: 'loading' | 'ready' | 'error'
  texture: THREE.Texture | null
  lastUsed: number
}

export class TileImagery {
  private readonly textures = new Map<string, TextureEntry>()
  private readonly materials = new Map<string, { material: THREE.Material; map: THREE.Texture; owned: boolean }>()
  private readonly queue: string[] = []
  private readonly loader = new THREE.TextureLoader()
  private readonly onChange: () => void
  private readonly anisotropy: number
  private inFlight = 0
  private disposed = false

  constructor(onChange: () => void, anisotropy: number) {
    this.onChange = onChange
    this.anisotropy = anisotropy
  }

  /** Give every drawn tile its imagery material (or the plain one while its image loads). */
  apply(tiles: ImageryTile[], base: THREE.Material, now: number) {
    const wanted: string[] = []
    for (const t of tiles) {
      const d = Math.max(0, t.z - IMAGERY_MAX_ZOOM)
      const az = t.z - d
      const ax = t.x >> d
      const ay = t.y >> d
      const texKey = `${t.face}/${az}/${ax}/${ay}`
      let entry = this.textures.get(texKey)
      if (!entry) {
        entry = { state: 'loading', texture: null, lastUsed: now }
        this.textures.set(texKey, entry)
        wanted.push(texKey)
      }
      entry.lastUsed = now
      if (entry.state !== 'ready' || !entry.texture) {
        if (t.mesh.material !== base) t.mesh.material = base
        continue
      }
      const have = this.materials.get(t.key)
      if (!have) {
        let map = entry.texture
        let owned = false
        if (d > 0) {
          // This tile's part of the ancestor's image (same pixels on the GPU, own uv transform).
          map = entry.texture.clone()
          const s = 1 / 2 ** d
          map.repeat.set(s, s)
          map.offset.set((t.x - (ax << d)) * s, (t.y - (ay << d)) * s)
          owned = true
        }
        const material = base.clone() as THREE.MeshStandardMaterial
        material.map = map
        material.color.setScalar(GAIN)
        this.materials.set(t.key, { material, map, owned })
        t.mesh.material = material
      } else if (t.mesh.material !== have.material) {
        t.mesh.material = have.material
      }
    }
    // Coarse first: those cover the most screen.
    wanted.sort((a, b) => Number(a.split('/')[1]) - Number(b.split('/')[1]))
    this.queue.push(...wanted)
    this.pump()
    this.evict(now)
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

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.queue.length) {
      const texKey = this.queue.shift()!
      const entry = this.textures.get(texKey)
      if (!entry || entry.state !== 'loading' || entry.texture) continue
      this.inFlight++
      this.loader
        .loadAsync(`${API_URL}/api/imagery/tile/${texKey}`)
        .then((texture) => {
          if (this.disposed || this.textures.get(texKey) !== entry) return texture.dispose()
          texture.colorSpace = THREE.NoColorSpace // see GAIN
          texture.anisotropy = this.anisotropy // sharp at the grazing angles of the site view
          texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping
          entry.texture = texture
          entry.state = 'ready'
        })
        .catch(() => {
          entry.state = 'error' // that tile stays plain
        })
        .finally(() => {
          this.inFlight--
          if (this.disposed) return
          this.pump()
          this.onChange()
        })
    }
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
      for (const [tileKey, m] of this.materials) if (m.map === e.texture || m.map.source === e.texture?.source) this.forget(tileKey)
      e.texture?.dispose()
      this.textures.delete(texKey)
    }
  }
}
