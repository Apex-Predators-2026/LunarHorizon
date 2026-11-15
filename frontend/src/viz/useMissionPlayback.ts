// Mission playback state: plays the plan from the sidebar (site, landing, duration, requirements)
// in the 3D view from landing to the end of the mission, pausing at each moment a requirement
// breaks. Reads the rescue store (features/rescue) without changing it. UI: MissionPanel.
import { useEffect, useState } from 'react'
import { useRescueStore } from '../features/rescue'
import { useAppStore } from '../store'
import type { MissionRequirements, Scenario, SiteInfo, ViabilityResult } from '../types'
import { fetchTimeline } from './api'
import { missionTrack, missionWindow, type MissionTrack } from './mission'
import type { StripMission } from './TimeBar'
import { parseUtc, toIsoMinute } from './timeline'

export interface Run {
  plan: Scenario
  track: MissionTrack | null // null while loading
  error: string | null
  acknowledged: number // failures already shown (index into track.failures)
}

export const sameRequirements = (a: MissionRequirements, b: MissionRequirements): boolean =>
  a.min_sunlight_fraction === b.min_sunlight_fraction &&
  a.battery_hours === b.battery_hours &&
  a.panel_threshold === b.panel_threshold &&
  a.min_earth_visibility_fraction === b.min_earth_visibility_fraction &&
  a.max_comms_gap_hours === b.max_comms_gap_hours &&
  a.min_initial_sun_hours === b.min_initial_sun_hours &&
  a.min_initial_comms_hours === b.min_initial_comms_hours

export const samePlan = (a: Scenario, b: Scenario): boolean =>
  a.site.id === b.site.id &&
  parseUtc(a.landing_utc) === parseUtc(b.landing_utc) &&
  a.duration_days === b.duration_days &&
  sameRequirements(a.requirements, b.requirements)

/** The engine's evaluation of this exact plan, from whichever rescue / compromise result has it. */
export function verdictFor(
  plan: Scenario,
  rescue: ReturnType<typeof useRescueStore.getState>['rescue'],
  compromise: ReturnType<typeof useRescueStore.getState>['compromise'],
): ViabilityResult | null {
  const candidates: ViabilityResult[] = []
  if (rescue) {
    candidates.push(rescue.original, rescue.changed)
    for (const a of rescue.alternatives) candidates.push(a.viability)
    for (const n of rescue.near_misses) candidates.push(n.viability)
  }
  if (compromise) {
    for (const o of [compromise.best, compromise.best_for_engineering, compromise.best_for_science, ...compromise.pareto_front]) {
      if (o) candidates.push(o.viability)
    }
  }
  return candidates.find((v) => samePlan(v.scenario, plan)) ?? null
}

export interface MissionPlayback {
  available: boolean
  reason: string // why it isn't available (tooltip)
  run: Run | null
  start: () => void
  stop: () => void
  next: () => void // continue after a failure
  strip: StripMission | null // for the time strip
  verdict: ViabilityResult | null // the engine's result for this plan, if a rescue search ran
}

export function useMissionPlayback(sites: SiteInfo[] | null): MissionPlayback {
  const plan = useRescueStore((s) => s.selected ?? s.original)
  const rescue = useRescueStore((s) => s.rescue)
  const compromise = useRescueStore((s) => s.compromise)
  const siteId = useAppStore((s) => s.siteId)
  const timeUtc = useAppStore((s) => s.timeUtc)
  const playing = useAppStore((s) => s.playing)
  const [run, setRun] = useState<Run | null>(null)

  const site = plan ? sites?.find((s) => s.id === plan.site.id) ?? null : null
  const [ws, we] = plan ? missionWindow(plan) : [0, 0]
  const inData = !!site && ws >= parseUtc(site.data_start_utc) && we <= parseUtc(site.data_stop_utc)
  const reason = !plan
    ? 'Set a plan in the sidebar first (Plan, then "Set plan")'
    : !site
      ? `${plan.site.name} has no precomputed data to play`
      : !inData
        ? `This plan is outside the data range (${site.data_start_utc.slice(0, 10)} to ${site.data_stop_utc.slice(0, 10)})`
        : `Play the plan: ${plan.site.name}, ${plan.duration_days} days from ${plan.landing_utc.slice(0, 16).replace('T', ' ')} UTC`

  const start = () => {
    if (!plan || !site || !inData) return
    const { setSite, setTime, setPlaying } = useAppStore.getState()
    setPlaying(false)
    setSite(site.id)
    setTime(toIsoMinute(ws))
    const begun: Run = { plan, track: null, error: null, acknowledged: 0 }
    setRun(begun)
    fetchTimeline(site.id, toIsoMinute(ws), toIsoMinute(we), 1)
      .then((steps) => {
        setRun((r) => (r && r.plan === plan ? { ...r, track: missionTrack(steps, plan) } : r))
        useAppStore.getState().setPlaying(true)
      })
      .catch((e: unknown) => setRun((r) => (r && r.plan === plan ? { ...r, error: e instanceof Error ? e.message : String(e) } : r)))
  }
  const stop = () => {
    useAppStore.getState().setPlaying(false)
    setRun(null)
  }
  const next = () => {
    setRun((r) => (r ? { ...r, acknowledged: r.acknowledged + 1 } : r))
    useAppStore.getState().setPlaying(true)
  }

  // Pause exactly at the next unacknowledged failure, and at the end of the mission.
  const track = run?.track ?? null
  const t = parseUtc(timeUtc)
  const pending = track ? track.failures.find((f, i) => i >= run!.acknowledged && f.t <= t && f.t < track.end) : undefined
  const ended = !!track && t >= track.end
  useEffect(() => {
    if (!track || !playing) return
    if (pending || ended) {
      const { setPlaying, setTime } = useAppStore.getState()
      setPlaying(false)
      setTime(toIsoMinute(pending ? pending.t : track.end))
    }
  }, [track, playing, pending, ended])

  // Leaving the plan's site ends the playback (checked during render; no state change needed).
  const active = run && run.plan.site.id === siteId ? run : null

  return {
    available: !!plan && !!site && inData,
    reason,
    run: active,
    start,
    stop,
    next,
    strip: active?.track ? { start: active.track.start, end: active.track.end, failures: active.track.failures.map((f) => f.t) } : null,
    verdict: active ? verdictFor(active.plan, rescue, compromise) : null,
  }
}
