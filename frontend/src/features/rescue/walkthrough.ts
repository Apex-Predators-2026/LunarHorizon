// Educator "Explain" mode: a five-step story of what rescue did, built only from values in the
// RescueResponse (no invented numbers), plus plain-language definitions of the terms it uses.
import { resolveHeadroom } from '../../lib/headroom'
import type { MissionRequirements, RequirementKey, Violation } from '../../types'
import { fmtUtc, fmtValue } from './format'
import type { MetricDelta, RescueResponse } from './types'

export interface WalkthroughStep {
  title: string
  text: string
}

export const GLOSSARY: { term: string; definition: string }[] = [
  { term: 'Sunlit fraction', definition: 'The average share of the Sun’s disk visible over the mission, so a Sun half hidden behind a ridge counts as half (not just time above the horizon). It describes sunlight geometry, not power produced.' },
  { term: 'Longest power gap (battery limit)', definition: 'The longest stretch when less of the Sun’s disk is visible than the panel threshold, so the panels count as dark. The battery limit is the longest such stretch the plan tolerates; no battery charge is simulated.' },
  { term: 'Earth contact (comms blackout)', definition: 'Earth is above the local terrain, a clear line of sight for direct-to-Earth radio (the radio link itself is not modelled). A comms blackout is the longest stretch without that line of sight.' },
  { term: 'Robustness', definition: 'Whether a plan still passes at the tested date slips, and at landing-position errors when terrain data exists. It covers only the offsets actually tested, not a guarantee in between.' },
  { term: 'Unknown (no real data)', definition: 'Rescue says unknown instead of guessing when the mission runs outside the dates the real data covers, or when that data is incomplete for a requirement. Unknown is never counted as a pass or a fail.' },
]

const LABEL: Record<RequirementKey | 'data_coverage', string> = {
  min_sunlight_fraction: 'sunlit fraction (average visible Sun disk)',
  battery_hours: 'longest power gap (battery limit)',
  panel_threshold: 'panel threshold',
  min_earth_visibility_fraction: 'time with Earth in line of sight',
  max_comms_gap_hours: 'longest comms blackout',
  min_initial_sun_hours: 'sunlight right after landing',
  min_initial_comms_hours: 'Earth contact right after landing',
  data_coverage: 'real data coverage',
}
const UNIT: Partial<Record<RequirementKey, 'fraction' | 'h'>> = {
  min_sunlight_fraction: 'fraction', panel_threshold: 'fraction', min_earth_visibility_fraction: 'fraction',
  battery_hours: 'h', max_comms_gap_hours: 'h', min_initial_sun_hours: 'h', min_initial_comms_hours: 'h',
}
const label = (k: string) => LABEL[k as keyof typeof LABEL] ?? k.replace(/_/g, ' ')
/** Plain-language name of a requirement (or 'real data coverage'). */
export const requirementLabel = label
const days = (n: number) => `${Math.round(n * 10) / 10} ${Math.abs(n - 1) < 1e-9 ? 'day' : 'days'}`
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

function stepChange(res: RescueResponse): string {
  const a = res.original.scenario
  const b = res.changed.scenario
  const parts: string[] = []
  const delay = (Date.parse(b.landing_utc) - Date.parse(a.landing_utc)) / 86_400_000
  if (Math.abs(delay) > 1e-6) {
    parts.push(`The landing moved ${days(Math.abs(delay))} ${delay > 0 ? 'later' : 'earlier'}, from ${fmtUtc(a.landing_utc)} to ${fmtUtc(b.landing_utc)}.`)
  }
  if (a.duration_days !== b.duration_days) parts.push(`The mission length changed from ${days(a.duration_days)} to ${days(b.duration_days)}.`)
  for (const k of Object.keys(b.requirements) as (keyof MissionRequirements)[]) {
    if (a.requirements[k] === b.requirements[k]) continue
    const u = UNIT[k] ?? 'h'
    parts.push(`The ${label(k)} requirement changed from ${fmtValue(a.requirements[k], u)} to ${fmtValue(b.requirements[k], u)}.`)
  }
  return parts.length ? parts.join(' ') : 'Nothing about the plan changed: no delay and no new requirements.'
}

const need = (k: string, v: Violation) => {
  const word = k === 'max_comms_gap_hours' || k === 'battery_hours' ? 'at most' : 'at least'
  // Format in the violation's own unit; anything other than a fraction or hours is printed as-is.
  const f = (x: number | null) =>
    v.unit === 'fraction' || v.unit === 'h' ? fmtValue(x, v.unit) : x === null ? 'n/a' : `${Math.round(x * 100) / 100} ${v.unit}`
  return `${label(k)} is ${f(v.actual)}, but the plan needs ${word} ${f(v.required)}`
}

function stepPlan(res: RescueResponse): string {
  const c = res.changed
  if (c.eligibility === 'unknown') {
    const unknowns = c.violations.filter((v) => v.is_unknown)
    const cov = unknowns.find((v) => v.constraint === 'data_coverage')
    if (cov) {
      const covered = cov.actual ?? 0
      return covered <= 0
        ? 'The changed plan could not be judged: real data does not cover any of its dates at this site, so the verdict is unknown (not a fail).'
        : `The changed plan could not be judged: real data covers ${fmtValue(covered, 'h')} of the ${fmtValue(cov.required, 'h')} mission and the rest is outside the data range, so the verdict is unknown (not a fail).`
    }
    const which = unknowns.map((v) => label(v.constraint))
    return `The changed plan could not be judged: real data inside the range is incomplete for ${which.length ? list(which) : 'at least one requirement'}, so the verdict is unknown (not a fail).`
  }
  const broken = c.violations.filter((v) => !v.is_unknown)
  if (c.passes && !broken.length) {
    const hr = resolveHeadroom(c)
    const qual = hr.qualified_verdict
      ? hr.qualified_verdict.charAt(0).toLowerCase() + hr.qualified_verdict.slice(1)
      : 'passes declared model requirements'
    const closest = hr.closest_constraint ? ` Closest limit: ${hr.closest_constraint.summary_text}.` : ''
    return `The changed plan ${qual}${c.score === null ? '' : ` (score ${Math.round(c.score)})`}.${closest} Model screening result only - not a guarantee of spacecraft survival.`
  }
  if (!broken.length) return 'The changed plan fails, but no single broken rule was reported.'
  const main = broken.reduce((m, v) => (v.relative_shortfall > m.relative_shortfall ? v : m))
  const more = broken.length - 1
  return `The changed plan fails ${broken.length === 1 ? '1 requirement' : `${broken.length} requirements`}. Main broken rule: ${need(main.constraint, main)}.${more ? ` ${more} other ${more === 1 ? 'rule is' : 'rules are'} also broken.` : ''}`
}

/** True only when no option at all could be judged with real data (not when some failed and some were unknown). */
const noneJudged = (s: RescueResponse['stats']) => s.passing === 0 && s.undecided > 0 && s.undecided >= s.candidates_evaluated

function stepSearch(res: RescueResponse): string {
  const s = res.stats
  const checked = Math.max(0, s.candidates_evaluated - s.undecided)
  const sim = res.data_source.includes('synthetic')
  const verified = sim
    ? `${checked} could be checked (simulation mode: some results use synthetic placeholder data)`
    : `${checked} of them could be checked with real data`
  let t = `Rescue tried ${s.candidates_evaluated} site and date combinations at ${s.locations_considered} ${s.locations_considered === 1 ? 'location' : 'locations'}, with landing dates from ${s.date_range_start.slice(0, 10)} to ${s.date_range_end.slice(0, 10)}. ${verified}${s.undecided ? `; ${s.undecided} could not (missing data)` : ''}, and ${s.passing} pass.`
  if (s.synthetic_candidates_excluded > 0) t += ` ${s.synthetic_candidates_excluded} more were skipped because there is no real data there.`
  return t
}

const gain = (m: MetricDelta) => (m.delta === null ? 0 : m.unit === 'fraction' ? Math.abs(m.delta) * 100 : Math.abs(m.delta))

function stepWinner(res: RescueResponse): string {
  const top = res.alternatives[0]
  if (!top && noneJudged(res.stats)) return 'None of the options could be judged with real data, so there is no winner to explain.'
  if (!top) {
    return res.status === 'still_viable'
      ? 'No alternative is needed, because the changed plan stays within declared model limits (screening result only; not a guarantee of spacecraft survival).'
      : 'No alternative passes, so there is no winner to explain.'
  }
  const sc = top.scenario
  const still = new Set(top.viability.violations.map((v) => v.constraint))
  const fixed = res.changed.violations.filter((v) => !v.is_unknown && !still.has(v.constraint)).map((v) => label(v.constraint))
  const best = top.improvements
    .filter((m) => m.better === true && m.metric !== 'score' && m.delta !== null)
    .reduce<MetricDelta | null>((m, x) => (m && gain(m) >= gain(x) ? m : x), null)
  const hr = resolveHeadroom(top.viability)
  let t = `Top pick: ${sc.site.name} on ${fmtUtc(sc.landing_utc)}.`
  t += fixed.length ? ` It fixes ${list(fixed)}.` : ' It keeps the plan within declared model limits.'
  if (best) t += ` Main gain: ${best.label.toLowerCase()} goes from ${fmtValue(best.before, best.unit)} to ${fmtValue(best.after, best.unit)}.`
  if (hr.qualified_verdict) t += ` ${hr.qualified_verdict} (model screening only; not a guarantee).`
  else t += ' Model screening only; not a guarantee.'
  return t
}

function stepRobust(res: RescueResponse): string {
  const top = res.alternatives[0]
  if (!top && noneJudged(res.stats)) return 'Nothing to check: none of the options could be judged with real data.'
  if (!top) return 'There is nothing to check, because no alternative was found.'
  const r = top.robustness
  if (!r || r.verdict === 'unchecked') return 'Robustness was not checked for this pick.'
  const word = {
    robust: 'robust across tested offsets: it keeps passing at those checked slips',
    sensitive: 'sensitive: it passes, but some tested slips make it fail',
    fragile: 'fragile: most tested slips make it fail',
  }[r.verdict]
  const datePart = r.date_note ? ` ${r.date_note}` : ''
  return `The top pick is ${word}. ${r.passing_points} of ${r.checked_points} nearby checks pass.${datePart} ${r.note} (Covers tested offsets only; not a guarantee in between.)`
}

/** Five plain-English steps for a rescue result. Never throws on a result with no winner or unknown data. */
export function buildWalkthrough(res: RescueResponse): WalkthroughStep[] {
  return [
    { title: 'What changed', text: stepChange(res) },
    { title: 'What that did to the plan', text: stepPlan(res) },
    { title: 'What rescue searched', text: stepSearch(res) },
    { title: 'Why the top alternative wins', text: stepWinner(res) },
    { title: 'How robust it is', text: stepRobust(res) },
  ]
}
