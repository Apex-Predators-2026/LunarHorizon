import type {
  CanonicalMarginItem,
  ClosestRequirementInfo,
  Eligibility,
  HeadroomStatus,
  InitialWindowSummary,
  MarginMetricValue,
  MarginStatus,
  MissionRequirements,
  OperationalHeadroom,
  RequirementKey,
  ViabilityResult,
} from '../types'
import { verdictOf } from '../types'
import type { Status } from '../ui/primitives'
import type { MissionTrack } from '../viz/mission'

export const NARROW_MARGIN_FRACTION = 0.1
export const SAMPLE_RESOLUTION_H = 1.0

export const SCREENING_NOTE =
  'Model screening result based on solar illumination and geometric Earth line-of-sight only; not a guarantee of spacecraft survival.'

const FIELD_META: Record<
  RequirementKey,
  { id: string; name: string; shortLabel: string; comparison: 'at_least' | 'at_most'; unit: string }
> = {
  battery_hours: {
    id: 'max_continuous_darkness',
    name: 'Max continuous darkness',
    shortLabel: 'darkness',
    comparison: 'at_most',
    unit: 'h',
  },
  max_comms_gap_hours: {
    id: 'max_communication_blackout',
    name: 'Max communication blackout',
    shortLabel: 'communication blackout',
    comparison: 'at_most',
    unit: 'h',
  },
  min_sunlight_fraction: {
    id: 'min_mean_solar_disk_fraction',
    name: 'Min solar disk fraction',
    shortLabel: 'solar disk fraction',
    comparison: 'at_least',
    unit: 'fraction',
  },
  min_earth_visibility_fraction: {
    id: 'min_earth_visibility_percent',
    name: 'Min Earth visibility',
    shortLabel: 'Earth visibility',
    comparison: 'at_least',
    unit: '%',
  },
  min_initial_sun_hours: {
    id: 'min_initial_sunlight',
    name: 'Min initial sunlight',
    shortLabel: 'initial sunlight',
    comparison: 'at_least',
    unit: 'h',
  },
  min_initial_comms_hours: {
    id: 'min_initial_earth_visibility',
    name: 'Min initial Earth contact',
    shortLabel: 'initial Earth contact',
    comparison: 'at_least',
    unit: 'h',
  },
  panel_threshold: {
    id: 'panel_threshold',
    name: 'Panel power threshold',
    shortLabel: 'panel threshold',
    comparison: 'at_least',
    unit: 'fraction',
  },
}

const SEVERITY_RANK: Record<MarginStatus, number> = {
  negative: 0,
  at_threshold: 1,
  uncertain: 2,
  narrow: 3,
  comfortable: 4,
  unsupported: 5,
  not_applicable: 6,
}

function fmtNum(val: number, unit: string): string {
  if (unit === 'fraction') return `${(val * 100).toFixed(1)}%`
  if (unit === '%') return `${val.toFixed(1)}%`
  if (Math.abs(val - Math.round(val)) < 0.05) return `${Math.round(val)} ${unit}`.trim()
  return `${val.toFixed(1)} ${unit}`.trim()
}

function fmtSignNum(val: number, unit: string, signed: boolean): string {
  const prefix = signed && val > 0 ? '+' : ''
  return `${prefix}${fmtNum(val, unit)}`
}

export function formatMarginMetric(m: MarginMetricValue | null | undefined, signed = true): string {
  if (!m) return '-'
  if (m.status === 'known' && m.value !== null && m.value !== undefined) {
    return fmtSignNum(m.value, m.unit, signed)
  }
  if (
    m.status === 'bounded' &&
    m.lower !== null &&
    m.lower !== undefined &&
    m.upper !== null &&
    m.upper !== undefined
  ) {
    return `between ${fmtSignNum(m.lower, m.unit, signed)} and ${fmtSignNum(m.upper, m.unit, signed)}`
  }
  if (m.status === 'not_applicable') return 'not applicable'
  return 'uncertain'
}

export function joinWords(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function classifyFallbackMargin(marginVal: number, threshold: number, unit: string): {
  marginClass: MarginStatus
  narrowReason: string | null
} {
  if (marginVal < 0) return { marginClass: 'negative', narrowReason: null }
  if (marginVal === 0) {
    return { marginClass: 'at_threshold', narrowReason: 'Zero margin remaining at the requirement boundary.' }
  }
  const rel = threshold > 0 ? marginVal / threshold : null
  const reasons: string[] = []
  if (rel !== null && rel <= NARROW_MARGIN_FRACTION) {
    reasons.push(`Headroom is ${(rel * 100).toFixed(1)}% of the limit (<= 10%).`)
  }
  if (unit === 'h' && marginVal < SAMPLE_RESOLUTION_H) {
    reasons.push(`Remaining margin is smaller than the ${SAMPLE_RESOLUTION_H} h sampling interval.`)
  }
  if (reasons.length > 0) {
    return { marginClass: 'narrow', narrowReason: reasons.join(' ') }
  }
  return { marginClass: 'comfortable', narrowReason: null }
}

function makeItem(
  field: RequirementKey,
  measuredVal: number,
  thresholdVal: number,
  active: boolean,
): CanonicalMarginItem {
  const meta = FIELD_META[field]
  const unit = meta.unit
  const measuredScaled = unit === '%' && measuredVal <= 1 && thresholdVal <= 1 ? measuredVal * 100 : measuredVal
  const thresholdScaled = unit === '%' && thresholdVal <= 1 ? thresholdVal * 100 : thresholdVal

  if (!active || (meta.comparison === 'at_least' && thresholdScaled <= 0)) {
    return {
      id: meta.id,
      requirement_field: field,
      name: meta.name,
      short_label: meta.shortLabel,
      comparison: meta.comparison,
      unit,
      threshold: null,
      measured: { status: 'known', unit, value: Number(measuredScaled.toFixed(4)) },
      margin: { status: 'not_applicable', unit },
      relative_margin: null,
      margin_class: 'not_applicable',
      narrow_reason: null,
      description: `${meta.name} not active`,
    }
  }

  const rawMargin =
    meta.comparison === 'at_most' ? thresholdScaled - measuredScaled : measuredScaled - thresholdScaled
  const marginVal = Number(rawMargin.toFixed(4))
  const relVal = thresholdScaled > 0 ? Number((marginVal / thresholdScaled).toFixed(4)) : null
  const { marginClass, narrowReason } = classifyFallbackMargin(marginVal, thresholdScaled, unit)

  return {
    id: meta.id,
    requirement_field: field,
    name: meta.name,
    short_label: meta.shortLabel,
    comparison: meta.comparison,
    unit,
    threshold: Number(thresholdScaled.toFixed(4)),
    measured: { status: 'known', unit, value: Number(measuredScaled.toFixed(4)) },
    margin: { status: 'known', unit, value: marginVal },
    relative_margin:
      relVal !== null ? { status: 'known', unit: 'fraction', value: relVal } : null,
    margin_class: marginClass,
    narrow_reason: narrowReason,
    description: `${meta.name} headroom`,
  }
}

function buildInitialSummary(
  kind: 'sunlight' | 'earth',
  initialHours: number,
  firstEndHours: number | null,
  reqHours: number,
  marginItem: CanonicalMarginItem | null,
): InitialWindowSummary {
  const dur: MarginMetricValue = { status: 'known', unit: 'h', value: Number(initialHours.toFixed(2)) }
  const firstEnd: MarginMetricValue =
    firstEndHours === null
      ? { status: 'not_applicable', unit: 'h' }
      : { status: 'known', unit: 'h', value: Number(firstEndHours.toFixed(2)) }

  const noun = kind === 'sunlight' ? 'sunlight' : 'Earth contact'
  const event = kind === 'sunlight' ? 'first sunset' : 'first Earthset'
  const stays = kind === 'sunlight' ? 'stays lit all mission' : 'stays in contact all mission'

  let summary: string
  if (initialHours <= 0) {
    summary = `Starts without ${noun} (0 h at landing)`
  } else if (firstEndHours === null) {
    summary = `${fmtNum(initialHours, 'h')} from landing (${stays})`
  } else {
    summary = `${fmtNum(initialHours, 'h')} continuous from landing (${event} T+${fmtNum(firstEndHours, 'h')})`
  }
  const activeItem = marginItem && marginItem.margin_class !== 'not_applicable' ? marginItem : null
  if (activeItem && reqHours > 0) {
    summary = `${summary} (headroom ${formatMarginMetric(activeItem.margin)} vs ${fmtNum(reqHours, 'h')} min)`
  }

  return {
    kind,
    duration: dur,
    first_end_hours: firstEnd,
    requirement_hours: reqHours > 0 ? reqHours : null,
    headroom: activeItem,
    summary_text: summary,
  }
}

function pickClosest(items: CanonicalMarginItem[]): ClosestRequirementInfo | null {
  const active = items.filter((i) => i.margin_class !== 'not_applicable' && i.margin_class !== 'unsupported')
  if (active.length === 0) return null
  const sorted = [...active].sort((a, b) => {
    const r = SEVERITY_RANK[a.margin_class] - SEVERITY_RANK[b.margin_class]
    if (r !== 0) return r
    const relA = a.relative_margin?.value ?? a.relative_margin?.lower ?? 999
    const relB = b.relative_margin?.value ?? b.relative_margin?.lower ?? 999
    if (relA !== relB) return relA - relB
    const absA = a.margin.value ?? a.margin.lower ?? 999999
    const absB = b.margin.value ?? b.margin.lower ?? 999999
    return absA - absB
  })
  const c = sorted[0]
  const headroomText = formatMarginMetric(c.margin)
  const relRaw = c.relative_margin?.value ?? c.relative_margin?.lower ?? null
  const relPct = relRaw !== null ? Number((relRaw * 100).toFixed(1)) : null
  const limitStr = c.threshold !== null && c.threshold !== undefined ? fmtNum(c.threshold, c.unit) : null
  const pctStr = relPct !== null ? ` (${relPct.toFixed(1)}%)` : ''
  const summary =
    limitStr !== null
      ? `${c.name}: ${headroomText} ${c.comparison === 'at_most' ? 'remaining of' : 'vs'} ${limitStr} ${
          c.comparison === 'at_most' ? 'limit' : 'minimum'
        }${pctStr}`
      : `${c.name}: ${headroomText}`

  return {
    constraint_id: c.id,
    requirement_field: c.requirement_field,
    label: c.name,
    margin_class: c.margin_class,
    unit: c.unit,
    headroom_text: headroomText,
    relative_pct: relPct,
    summary_text: summary,
  }
}

function assembleHeadroom(
  elig: Eligibility,
  items: CanonicalMarginItem[],
  initialSunlight: InitialWindowSummary,
  initialEarth: InitialWindowSummary,
): OperationalHeadroom {
  const darkness = items.find((i) => i.id === 'max_continuous_darkness') ?? null
  const communicationBlackout = items.find((i) => i.id === 'max_communication_blackout') ?? null
  const closest = pickClosest(items)
  const narrowItems = items.filter((i) => i.margin_class === 'narrow' || i.margin_class === 'at_threshold')
  const limitedConstraints = narrowItems.map((i) => i.requirement_field ?? i.id)

  let status: HeadroomStatus
  let qualifiedVerdict: string

  if (elig === 'fail') {
    status = 'failed'
    const badLabels = items.filter((i) => i.margin_class === 'negative').map((i) => i.short_label)
    qualifiedVerdict = badLabels.length
      ? `Fails requirements on ${joinWords(badLabels)}`
      : 'Fails declared mission requirements'
  } else if (elig === 'unknown') {
    status = 'uncertain'
    qualifiedVerdict = 'Unknown eligibility: data coverage gaps leave headroom unresolved'
  } else if (items.some((i) => i.margin_class === 'at_threshold')) {
    status = 'at_threshold'
    const lead = narrowItems[0]
    qualifiedVerdict = lead?.threshold
      ? `Passes at the ${joinWords(narrowItems.map((i) => i.short_label))} boundary (${formatMarginMetric(lead.margin)} of ${fmtNum(lead.threshold, lead.unit)} limit)`
      : `Passes with zero margin on ${joinWords(narrowItems.map((i) => i.short_label))}`
  } else if (narrowItems.length > 0) {
    status = 'limited'
    const lead = narrowItems[0]
    const detail = lead.threshold
      ? ` (${formatMarginMetric(lead.margin)} of ${fmtNum(lead.threshold, lead.unit)} limit)`
      : ` (${formatMarginMetric(lead.margin)})`
    qualifiedVerdict = `Passes with limited ${joinWords(narrowItems.map((i) => i.short_label))} margin${detail}`
  } else if (items.some((i) => i.margin_class === 'uncertain')) {
    status = 'uncertain'
    qualifiedVerdict = closest
      ? `Passes with uncertain margin bounds (${closest.summary_text})`
      : 'Passes with bounded headroom uncertainty'
  } else if (items.some((i) => i.margin_class === 'comfortable')) {
    status = 'comfortable'
    const parts: string[] = []
    if (darkness && darkness.margin_class === 'comfortable') {
      parts.push(`${formatMarginMetric(darkness.margin)} darkness`)
    }
    if (communicationBlackout && communicationBlackout.margin_class === 'comfortable') {
      parts.push(`${formatMarginMetric(communicationBlackout.margin)} comms blackout`)
    }
    if (parts.length === 0 && closest) parts.push(closest.summary_text)
    qualifiedVerdict = `Passes with comfortable headroom (${parts.join(', ')})`
  } else {
    status = 'vacuous'
    qualifiedVerdict = 'Passes (no active numerical limits configured)'
  }

  return {
    status,
    qualified_verdict: qualifiedVerdict,
    limited_constraints: limitedConstraints,
    darkness,
    communication_blackout: communicationBlackout,
    initial_sunlight: initialSunlight,
    initial_earth: initialEarth,
    closest_constraint: closest,
    constraints: items,
    screening_note: SCREENING_NOTE,
  }
}

/** Pure client fallback when an offline or custom mock ViabilityResult omits `.headroom`. */
export function deriveHeadroom(result: ViabilityResult): OperationalHeadroom {
  const r = result.scenario.requirements
  const m = result.metrics
  const items: CanonicalMarginItem[] = [
    makeItem('battery_hours', m.longest_dark_gap_hours, r.battery_hours, true),
    makeItem('max_comms_gap_hours', m.longest_comms_gap_hours, r.max_comms_gap_hours, true),
    makeItem('min_sunlight_fraction', m.sunlight_fraction, r.min_sunlight_fraction, r.min_sunlight_fraction > 0),
    makeItem(
      'min_earth_visibility_fraction',
      m.earth_visibility_fraction * 100,
      r.min_earth_visibility_fraction * 100,
      r.min_earth_visibility_fraction > 0,
    ),
    makeItem('min_initial_sun_hours', m.initial_sun_hours, r.min_initial_sun_hours, r.min_initial_sun_hours > 0),
    makeItem('min_initial_comms_hours', m.initial_comms_hours, r.min_initial_comms_hours, r.min_initial_comms_hours > 0),
  ]

  const initSun = buildInitialSummary(
    'sunlight',
    m.initial_sun_hours,
    m.hours_to_first_sunset,
    r.min_initial_sun_hours,
    items[4],
  )
  const initEarth = buildInitialSummary(
    'earth',
    m.initial_comms_hours,
    m.hours_to_first_earthset,
    r.min_initial_comms_hours,
    items[5],
  )
  return assembleHeadroom(verdictOf(result), items, initSun, initEarth)
}

/** Resolve canonical backend headroom first; fall back cleanly to client derivation only when absent. */
export function resolveHeadroom(result: ViabilityResult): OperationalHeadroom {
  return result.headroom ?? deriveHeadroom(result)
}

/** Client-side MissionTrack headroom builder for offline 3D playback when no backend verdict is loaded. */
export function deriveHeadroomFromTrack(track: MissionTrack, req: MissionRequirements): OperationalHeadroom {
  const longestDark = track.longestDark?.hours ?? 0
  const longestBlackout = track.longestBlackout?.hours ?? 0
  const sunFrac = track.sunlightFraction ?? 0
  const earthFrac = track.earthFraction ?? 0

  const firstSunsetIdx = track.hours.findIndex((h) => h.dark === true)
  const firstSunsetHours =
    track.hours.length > 0 && track.hours[0].dark === false && firstSunsetIdx > 0
      ? firstSunsetIdx
      : null
  const firstEarthsetIdx = track.hours.findIndex((h) => h.blackout === true)
  const firstEarthsetHours =
    track.hours.length > 0 && track.hours[0].blackout === false && firstEarthsetIdx > 0
      ? firstEarthsetIdx
      : null

  const items: CanonicalMarginItem[] = [
    makeItem('battery_hours', longestDark, req.battery_hours, true),
    makeItem('max_comms_gap_hours', longestBlackout, req.max_comms_gap_hours, true),
    makeItem('min_sunlight_fraction', sunFrac, req.min_sunlight_fraction, req.min_sunlight_fraction > 0),
    makeItem(
      'min_earth_visibility_fraction',
      earthFrac * 100,
      req.min_earth_visibility_fraction * 100,
      req.min_earth_visibility_fraction > 0,
    ),
    makeItem('min_initial_sun_hours', track.initialSunHours, req.min_initial_sun_hours, req.min_initial_sun_hours > 0),
    makeItem('min_initial_comms_hours', track.initialCommsHours, req.min_initial_comms_hours, req.min_initial_comms_hours > 0),
  ]

  const elig: Eligibility = track.failures.length > 0 ? 'fail' : track.unknownHours > 0 ? 'unknown' : 'pass'
  const initSun = buildInitialSummary('sunlight', track.initialSunHours, firstSunsetHours, req.min_initial_sun_hours, items[4])
  const initEarth = buildInitialSummary('earth', track.initialCommsHours, firstEarthsetHours, req.min_initial_comms_hours, items[5])
  return assembleHeadroom(elig, items, initSun, initEarth)
}

export function headroomTone(hr: OperationalHeadroom | null | undefined, elig?: Eligibility | null): Status {
  if (elig === 'fail' || hr?.status === 'failed') return 'crit'
  if (elig === 'unknown' || hr?.status === 'uncertain') return 'unknown'
  if (hr?.status === 'limited' || hr?.status === 'at_threshold') return 'warn'
  return 'ok'
}

export function passBadgeText(hr: OperationalHeadroom | null | undefined, elig: Eligibility = 'pass'): string {
  if (elig === 'fail') return 'Fail'
  if (elig === 'unknown') return 'Unknown'
  if (!hr) return 'Pass'
  if (hr.status === 'at_threshold') return 'Pass · at threshold'
  if (hr.status === 'limited') {
    const first = hr.constraints.find((c) => c.margin_class === 'narrow' || c.margin_class === 'at_threshold')
    return first ? `Pass · limited ${first.short_label}` : 'Pass · limited margin'
  }
  if (hr.status === 'uncertain') return 'Pass · bounded margin'
  if (hr.status === 'comfortable') return 'Pass · comfortable'
  return 'Pass'
}

export function marginStatusClassLabel(cls: MarginStatus): string {
  switch (cls) {
    case 'comfortable':
      return 'Comfortable'
    case 'narrow':
      return 'Limited'
    case 'at_threshold':
      return 'At limit'
    case 'negative':
      return 'Failed'
    case 'uncertain':
      return 'Uncertain'
    case 'unsupported':
      return 'Unsupported'
    case 'not_applicable':
      return 'Not configured'
  }
}
