// Formatting for the live conditions card (LiveNow.tsx).

export interface Status {
  time_utc: string
  sun: { elevation_deg: number; horizon_deg: number; visible: boolean; visible_fraction: number }
  earth: { elevation_deg: number; visible: boolean; margin_deg: number }
  next_sunset_utc: string | null
  next_sunrise_utc: string | null
  next_earthset_utc: string | null
  next_earthrise_utc: string | null
}

/** The current UTC hour as the API expects it. */
export function currentHourIso(now = new Date()) {
  const d = new Date(now)
  d.setUTCMinutes(0, 0, 0)
  return d.toISOString().replace('.000Z', 'Z')
}

/** "in 13 days", "in 5 h", from now to an ISO time. */
export function untilText(iso: string | null, now = new Date()) {
  if (!iso) return 'not in the data'
  const h = Math.round((Date.parse(iso) - now.getTime()) / 3.6e6)
  if (h <= 1) return 'within the hour'
  return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`
}

export const deg = (v: number) => `${Math.abs(v).toFixed(1)}°`

export function describeSun(s: Status['sun']) {
  if (!s.visible) return s.elevation_deg < 0 ? `Below the horizon by ${deg(s.elevation_deg)}` : 'Hidden behind terrain'
  const part = s.visible_fraction < 0.999 ? ` · ${Math.round(s.visible_fraction * 100)}% of the disk` : ''
  return `${deg(s.elevation_deg)} above the horizon${part}`
}

export function describeEarth(e: Status['earth']) {
  return e.visible ? `In view, ${deg(e.margin_deg)} above the terrain` : `Out of view, ${deg(e.margin_deg)} below the terrain`
}

