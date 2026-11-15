// Panel above the map toolbar while a mission plays (state: useMissionPlayback.ts).
import { resolveHeadroom } from '../lib/headroom'
import { usePlanVerdict } from '../lib/planVerdict'
import { useAppStore } from '../store'
import { verdictOf, type Eligibility } from '../types'
import { PassHeadroom, PassHeadroomBadge } from '../ui/PassHeadroom'
import { fmtHours, missionAt } from './mission'
import { parseUtc } from './timeline'
import type { MissionPlayback } from './useMissionPlayback'

const fmtH = fmtHours

/** Panel above the map toolbar while a mission plays: day, power and contact counters, failures. */
export function MissionPanel({ mission }: { mission: MissionPlayback }) {
  const timeUtc = useAppStore((s) => s.timeUtc)
  const playing = useAppStore((s) => s.playing)
  const setPlaying = useAppStore((s) => s.setPlaying)
  const run = mission.run
  // The engine's verdict for this exact plan (Rescue's result, else the canonical assessment). Hooks run before the
  // early returns below.
  const assessed = usePlanVerdict(run?.plan, !mission.verdict)
  if (!run) return null
  const { plan, track } = run
  const req = plan.requirements
  const t = parseUtc(timeUtc)

  const box = 'recede-behind-menu md-reveal lp-light pointer-events-auto w-[30rem] max-w-full rounded-xl bg-opal-50 p-2.5 text-xs text-slate-300 shadow-lg shadow-black/30'
  const button = 'rounded-lg border border-opal-300 bg-panel-fill px-2 py-0.5 transition-colors hover:bg-calcite-peach/40'
  const header = (
    <div className="mb-1 flex items-center justify-between gap-2">
      <span className="font-medium text-calcite-ink">
        Mission: {plan.site.name} · {plan.duration_days} days from {plan.landing_utc.slice(0, 16).replace('T', ' ')} UTC
      </span>
      <button type="button" className="text-slate-400 hover:text-slate-100" onClick={mission.stop} aria-label="Stop mission playback">
        ✕
      </button>
    </div>
  )
  if (run.error) {
    return (
      <div className={box} role="status">
        {header}
        <p className="text-red-300">Couldn't load the mission's data: {run.error}</p>
      </div>
    )
  }
  if (!track) {
    return (
      <div className={box} role="status">
        {header}
        <p>Loading the mission's hourly data…</p>
      </div>
    )
  }

  const m = missionAt(track, t)
  // A requirement crossed in the observed timeline is only called a mission failure when the engine says FAIL.
  const verdict = mission.verdict
  const canonical = assessed?.status === 'done' ? assessed : null
  const elig: Eligibility | null = verdict ? verdictOf(verdict) : (canonical?.eligibility ?? null)
  const pending = elig === 'fail' ? track.failures.find((f, i) => i >= run.acknowledged && f.t <= t && f.t < track.end) : undefined
  const ended = t >= track.end
  const darkLevel = m.darkStreak / req.battery_hours
  const gapLevel = m.gapStreak / req.max_comms_gap_hours
  const tone = (x: number) => (x > 1 ? 'text-red-400' : x > 0.75 ? 'text-amber-300' : 'text-emerald-300')
  // Headroom comes with Rescue's canonical result only; it is never derived from the track.
  const headroom = verdict ? resolveHeadroom(verdict) : null
  const notAssessed = assessed?.status === 'error' ? `Not assessed: ${assessed.message}` : 'Not assessed by the viability engine yet'

  return (
    <div className={box} role="status" aria-live="polite">
      {header}
      <div className="mb-1.5 flex items-center gap-2">
        <span className="shrink-0 tabular-nums">
          Day {m.day} of {m.totalDays}
        </span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-opal-300" aria-hidden>
          <div className="h-full rounded-full bg-coral" style={{ width: `${m.progress * 100}%` }} />
        </div>
        {!ended && !pending && (
          <button type="button" className={button} onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Resume'}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
        <span>
          Panels: {m.hour?.dark === null ? 'unknown' : m.hour?.dark ? 'dark' : 'in sunlight'}
          {m.darkStreak > 0 && (
            <span className={tone(darkLevel)}>
              {' '}
              for {fmtH(m.darkStreak)} (battery lasts {fmtH(req.battery_hours)})
            </span>
          )}
        </span>
        <span>
          Earth: {m.hour?.blackout === null ? 'unknown' : m.hour?.blackout ? 'out of view' : 'in contact'}
          {m.gapStreak > 0 && (
            <span className={tone(gapLevel)}>
              {' '}
              for {fmtH(m.gapStreak)} (limit {fmtH(req.max_comms_gap_hours)})
            </span>
          )}
        </span>
      </div>

      {pending && (
        <div className="mt-2 rounded-lg border border-red-400/60 bg-red-950/40 p-2 text-red-200">
          <p className="font-medium">Mission fails here: {pending.message}</p>
          <p className="mt-0.5 text-[11px] text-red-200/80">The red/blue lines in the 3D view run to the terrain blocking the Sun / Earth.</p>
          <div className="mt-1.5 flex gap-2">
            <button type="button" className={button} onClick={mission.next}>
              Continue
            </button>
            <button type="button" className={button} onClick={mission.stop}>
              Stop
            </button>
          </div>
        </div>
      )}

      {ended && (
        <div className="mt-2 rounded-lg border border-opal-300 p-2" data-testid="mission-ended-summary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-calcite-ink">
              {elig === 'fail'
                ? 'Mission over: the viability engine finds the requirements broken'
                : elig === 'unknown'
                  ? 'Mission over: the viability engine cannot decide (missing data)'
                  : elig === 'pass'
                    ? 'Mission over: the viability engine finds the requirements met'
                    : `Mission over: ${notAssessed.toLowerCase()}`}
            </p>
            {elig && headroom && <PassHeadroomBadge headroom={headroom} eligibility={elig} surface="planner" />}
          </div>
          <ul className="mt-0.5 list-disc pl-4">
            {elig === 'fail' && canonical?.failed.map((m) => (
              <li key={m} className="text-red-300">
                {m}
              </li>
            ))}
            {track.failures.length > 0 && (
              <li>Observed in the timeline (descriptive, not the engine's verdict): {track.failures.map((f) => f.message).join(' · ')}</li>
            )}
            <li>
              Longest darkness {track.longestDark ? fmtH(track.longestDark.hours) : 'none'}, longest without Earth{' '}
              {track.longestBlackout ? fmtH(track.longestBlackout.hours) : 'none'}
              {track.unknownHours ? `, ${track.unknownHours} h unknown (missing terrain data)` : ''}.
            </li>
          </ul>
          <button type="button" className={`${button} mt-1.5`} onClick={mission.start}>
            Play again
          </button>
        </div>
      )}

      {!verdict && (
        <p className="mt-2 text-[11px] text-slate-400" data-testid="mission-engine-verdict">
          Viability engine: {canonical ? (elig === 'pass' ? 'requirements met' : elig === 'fail' ? 'requirements broken' : 'cannot decide (missing data)') : notAssessed}
        </p>
      )}
      {verdict && headroom && elig && (
        <div className="mt-2 space-y-1.5" data-testid="mission-verdict-headroom">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
            <span>Viability engine:</span>
            <PassHeadroomBadge headroom={headroom} eligibility={elig} surface="planner" />
            {verdict.violations.length > 0 && (
              <span>· {verdict.violations.map((v) => v.message).join(' · ')}</span>
            )}
          </div>
          <PassHeadroom headroom={headroom} surface="planner" compact />
        </div>
      )}
    </div>
  )
}
