// The ready-made zoomed-out look: LRO imagery of the coarsest tiles (levels 0-2, 128 px) in one
// static file (public/imagery/base.bin, built by backend/scripts/build_base_pack.py). TileImagery
// loads these from memory instead of the backend, so the whole-Moon view shows the photo mosaic
// straight away; deeper levels stream as usual. Format: see the script.

/** Parse the pack into PNG bytes keyed "face/z/x/y" (TileTree's keys). */
export function parseImageryPack(buf: ArrayBuffer): Map<string, Uint8Array<ArrayBuffer>> {
  const v = new DataView(buf)
  const magic = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))
  if (magic !== 'LIP1') throw new Error('not an imagery base pack')
  const count = v.getUint16(4, true)
  const tiles = new Map<string, Uint8Array<ArrayBuffer>>()
  let o = 8
  for (let t = 0; t < count; t++) {
    const face = v.getUint8(o)
    const z = v.getUint8(o + 1)
    const x = v.getUint16(o + 2, true)
    const y = v.getUint16(o + 4, true)
    const n = v.getUint32(o + 8, true)
    o += 12
    if (o + n > buf.byteLength) throw new Error('imagery base pack is truncated')
    tiles.set(`${face}/${z}/${x}/${y}`, new Uint8Array(buf, o, n))
    o += n
  }
  return tiles
}

let pack: Promise<Map<string, string> | null> | null = null

/** Object URLs of the packed images, downloaded once (null if missing or broken: the backend serves them). */
export function imageryPack(): Promise<Map<string, string> | null> {
  pack ??= fetch(`${import.meta.env.BASE_URL}imagery/base.bin`)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((buf) => {
      const urls = new Map<string, string>()
      for (const [key, png] of parseImageryPack(buf)) urls.set(key, URL.createObjectURL(new Blob([png], { type: 'image/png' })))
      return urls
    })
    .catch((e: unknown) => {
      console.warn('Imagery base pack unavailable; loading the zoomed-out imagery from the backend instead.', e)
      return null
    })
  return pack
}

let faces: Promise<{ faces: Uint8ClampedArray[]; size: number } | null> | null = null

/**
 * The pack's level-2 imagery joined into one greyscale image per cube face (512 px, row 0 = the face's
 * top, v = 1), for the minimap. Decoded once; null if the pack is missing.
 */
export function packFaceImages(): Promise<{ faces: Uint8ClampedArray[]; size: number } | null> {
  faces ??= imageryPack().then(async (urls) => {
    if (!urls) return null
    const z = 2
    const n = 2 ** z
    const tile = 128
    const size = n * tile
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    const out: Uint8ClampedArray[] = []
    for (let f = 0; f < 6; f++) {
      ctx.clearRect(0, 0, size, size)
      await Promise.all(
        Array.from({ length: n * n }, async (_, k) => {
          const x = k % n
          const y = Math.floor(k / n)
          const url = urls.get(`${f}/${z}/${x}/${y}`)
          if (!url) return
          const img = new Image()
          img.src = url
          await img.decode()
          ctx.drawImage(img, x * tile, (n - 1 - y) * tile, tile, tile) // tile y grows with v: upwards
        }),
      )
      const rgba = ctx.getImageData(0, 0, size, size).data
      const grey = new Uint8ClampedArray(size * size)
      for (let i = 0; i < grey.length; i++) grey[i] = rgba[i * 4]
      out.push(grey)
    }
    return { faces: out, size }
  })
  return faces
}
