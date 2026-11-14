// Parsing typed lunar coordinates (the "Drop pin" tool's coordinate form).

/**
 * Typed coordinates -> [lat, lon east in 0..360), or an error message for the user.
 * Latitude: -90 (south pole) .. 90. Longitude: -180..180 or 0..360, degrees east.
 */
export function parseCoordinates(latText: string, lonText: string): [number, number] | string {
  const lat = Number(latText.trim())
  const lon = Number(lonText.trim())
  if (!latText.trim() || !lonText.trim() || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return 'Enter latitude and longitude as numbers.'
  }
  if (lat < -90 || lat > 90) return 'Latitude must be between -90 (south pole) and 90.'
  if (lon < -180 || lon > 360) return 'Longitude must be between -180 and 360 (degrees east).'
  return [lat, lon < 0 ? lon + 360 : lon === 360 ? 0 : lon] // in-range values pass through exactly
}
