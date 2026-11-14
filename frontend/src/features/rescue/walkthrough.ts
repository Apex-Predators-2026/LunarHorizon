// Educator "Explain" mode: a five-step story of what rescue did, built only from values in the
// RescueResponse (no invented numbers), plus plain-language definitions of the terms it uses.
import type { MissionRequirements, RequirementKey, Violation } from '../../types'
import { fmtUtc, fmtValue } from './format'
import type { MetricDelta, RescueResponse } from './types'

export interface WalkthroughStep {
  title: string
  text: string
}

export const GLOSSARY: { term: string; definition: string }[] = [
  { term: 'Sunlit fraction', definition: 'The share of the mission time the Sun is above the horizon, so the solar panels can make power.' },
  { term: 'Longest darkness (battery limit)', definition: 'The longest stretch without sunlight. The battery has to keep the lander alive through it.' },
  { term: 'Earth contact (comms blackout)', definition: 'Earth contact is time when Earth is above the horizon, so the lander can talk to it directly. A comms blackout is a stretch without it.' },
  { term: 'Robustness', definition: 'Whether a plan still passes if the landing slips a little. Robust plans keep passing; fragile ones fail after a small change.' },
  { term: 'Unknown (no real data)', definition: 'The mission is not fully covered by real NASA data, so rescue says unknown instead of guessing.' },
]

const LABEL: Record<RequirementKey | 'data_coverage', string> = {
  min_sunlight_fraction: 'sunlit fraction',
  battery_hours: 'longest darkness (battery limit)',
  panel_threshold: 'panel threshold',
  min_earth_visibility_fraction: 'time with Earth contact',
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
  return `${label(k)} is ${fmtValue(v.actual, v.unit)}, but the plan needs ${word} ${fmtValue(v.required, v.unit)}`
}

function stepPlan(res: RescueResponse): string {
  const c = res.changed
  if (c.eligibility === 'unknown') {
    const gap = c.violations.find((v) => v.is_unknown)
    const cover = gap ? ` Real data covers ${fmtValue(gap.actual, 'h')} of the ${fmtValue(gap.required, 'h')} mission.` : ''
    return `The changed plan could not be judged: its dates are not fully covered by real data, so the verdict is unknown.${cover}`
  }
  const broken = c.violations.filter((v) => !v.is_unknown)
  if (c.passes && !broken.length) return `The changed plan still passes every requirement${c.score === null ? '' : ` (score ${Math.round(c.score)})`}.`
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
  if (!top) return res.status === 'still_viable' ? 'No alternative is needed, because the plan still works.' : 'No alternative passes, so there is no winner to explain.'
  const sc = top.scenario
  const still = new Set(top.viability.violations.map((v) => v.constraint))
  const fixed = res.changed.violations.filter((v) => !v.is_unknown && !still.has(v.constraint)).map((v) => label(v.constraint))
  const best = top.improvements
    .filter((m) => m.better === true && m.metric !== 'score' && m.delta !== null)
    .reduce<MetricDelta | null>((m, x) => (m && gain(m) >= gain(x) ? m : x), null)
  let t = `Top pick: ${sc.site.name} on ${fmtUtc(sc.landing_utc)}.`
  t += fixed.length ? ` It fixes ${list(fixed)}.` : ' It keeps the plan within every requirement.'
  if (best) t += ` Main gain: ${best.label.toLowerCase()} goes from ${fmtValue(best.before, best.unit)} to ${fmtValue(best.after, best.unit)}.`
  return t
}

function stepRobust(res: RescueResponse): string {
  const top = res.alternatives[0]
  if (!top && noneJudged(res.stats)) return 'Nothing to check: none of the options could be judged with real data.'
  if (!top) return 'There is nothing to check, because no alternative was found.'
  const r = top.robustness
  if (!r || r.verdict === 'unchecked') return 'Robustness was not checked for this pick.'
  const word = {
    robust: 'robust: it keeps passing when the date slips a little',
    sensitive: 'sensitive: it passes, but some small slips make it fail',
    fragile: 'fragile: most small slips make it fail',
  }[r.verdict]
  return `The top pick is ${word}. ${r.passing_points} of ${r.checked_points} nearby checks pass. ${r.note}`
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
