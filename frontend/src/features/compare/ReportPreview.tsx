// Summary report preview: renders ONLY the frozen snapshot (report.ts), never the live comparison. Print / Save as
// PDF uses the browser's own print dialog; the print stylesheet (report.css) prints only this document. Every name
// and note is rendered as React text (escaped), never as HTML.
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { downloadText, type ExportedMetric, type ExportedMissionTime, type ExportedRequirement, type ExportedScenario } from './export'
import { cannotGenerate, selectionKeyOf, useReportStore, type ReportSnapshot } from './report'
import { useCompareStore } from './useCompareStore'
import { useTutorialStore } from '../tutorial/useTutorialStore'
import { MissionReportBody, SnapshotPdfButton } from './MissionReportBody'
import './report.css'

const TEAM = 'Team B.A.J.A.N · NASA Space Apps 2026'
const PRODUCT = 'Lunar Landing Site Navigator'

const utc = (iso: string | null | undefined) => {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}

const VERDICT = { pass: '✓ PASS', fail: '✕ FAIL', unknown: '? UNKNOWN', not_applicable: '– n/a' } as const
const verdictText = (v: string | null) => (v ? VERDICT[v as keyof typeof VERDICT] ?? v.toUpperCase() : 'NOT ASSESSED')

/** Declared requirements in plain words (MissionRequirements fields). */
function requirementList(r: ExportedScenario['requirements']): string[] {
  return [
    `Power darkness at most ${r.battery_hours} h (less than ${Math.round(r.panel_threshold * 100)}% of the solar disk visible)`,
    `Communication blackout at most ${r.max_comms_gap_hours} h (Earth below the local terrain)`,
    `Earth in line of sight at least ${Math.round(r.min_earth_visibility_fraction * 100)}% of the mission`,
    `Mean visible solar disk at least ${Math.round(r.min_sunlight_fraction * 100)}%`,
    `At least ${r.min_initial_sun_hours} h power-lit and ${r.min_initial_comms_hours} h of Earth contact right after landing`,
  ]
}

/** The mission window in the plans table: the evaluated window when there is one, otherwise the request, named as such. */
function windowText(t: ExportedMissionTime): string {
  if (t.evaluated_landing_utc) {
    const base = `${utc(t.evaluated_landing_utc)} · ${Math.round((t.evaluated_duration_hours ?? 0) * 10) / 10} h evaluated`
    return t.time_adjusted ? `${base} (requested ${utc(t.requested_landing_utc)}, ${t.requested_duration_days} d)` : base
  }
  return `not evaluated · requested ${utc(t.requested_landing_utc)}, ${t.requested_duration_days} d`
}

function metricText(m: ExportedMetric): string {
  const pct = m.unit === 'fraction'
  const f = (v: number) => (pct ? `${(v * 100).toFixed(1)}%` : m.unit === '%' ? `${v.toFixed(1)}%` : m.unit === 'h' ? `${Math.round(v * 10) / 10} h` : m.unit === 'deg' ? `${v.toFixed(2)}°` : `${v}`)
  if (m.status === 'known' && m.value !== null) return f(m.value)
  if (m.status === 'bounded' && m.lower !== null && m.upper !== null) return `${f(m.lower)} – ${f(m.upper)} (bounds)`
  if (m.status === 'not_applicable') return 'not applicable'
  return 'unavailable'
}

function limitOf(r: ExportedRequirement): string {
  if (r.threshold === null) return '-'
  const u = r.measured.unit
  const v = u === 'fraction' ? `${(r.threshold * 100).toFixed(0)}%` : u === '%' ? `${r.threshold}%` : u === 'h' ? `${r.threshold} h` : `${r.threshold}`
  return `${r.comparison === 'at_most' ? '≤' : '≥'} ${v}`
}

function marginOf(r: ExportedRequirement): string {
  const m = r.measured
  if (r.threshold === null || m.status !== 'known' || m.value === null) return m.status === 'bounded' ? 'bounded' : '-'
  const k = m.unit === 'fraction' ? 100 : 1
  const d = (r.comparison === 'at_most' ? r.threshold - m.value : m.value - r.threshold) * k
  const unit = m.unit === 'h' ? ' h' : m.unit === 'fraction' || m.unit === '%' ? ' pp' : ''
  return `${d >= 0 ? '+' : '−'}${Math.abs(Math.round(d * 10) / 10)}${unit}`
}

export function ReportDocument({ s }: { s: ReportSnapshot }) {
  const x = s.export
  const byLabel = Object.fromEntries(x.scenarios.map((sc) => [sc.label, sc]))
  const labels = s.selection.labels
  const req0 = x.scenarios[0]?.requirements
  // The three or four decisive differences: failing rows first, then rows whose values differ.
  const decisive = [...s.decisive]
    .map((row) => {
      const cells = Object.values(row.cells)
      const fails = cells.some((c) => c.status === 'fail' || c.status === 'unknown')
      const differ = new Set(cells.map((c) => c.text)).size > 1
      return { row, score: (fails ? 2 : 0) + (differ ? 1 : 0) }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((r) => r.row)
  const role = (l: string) => byLabel[l]?.role
  return (
    <article className="rpt-doc" aria-labelledby="rpt-title">
      {/* ---------------- page 1: decision brief ---------------- */}
      <section className="rpt-page">
        <header className="rpt-head">
          <span>{PRODUCT} · {TEAM}</span>
          <span>Generated {utc(s.generated_at)}</span>
        </header>
        <h1 id="rpt-title">Mission decision summary</h1>
        {s.mission.title && <p className="rpt-sub">{s.mission.title}</p>}
        <p className="rpt-objective">
          <b>Objective. </b>
          {s.mission.objective ?? `Decide between ${labels.length} landing plan${labels.length === 1 ? '' : 's'} under their declared requirements, using the canonical viability engine on real ephemeris and terrain data.`}
        </p>
        {s.mission.change.length > 0 && <p className="rpt-objective"><b>What changed. </b>{s.mission.change.join('; ').replace(/\.?$/, '.')}</p>}
        <p className="rpt-meta">{labels.length} scenario{labels.length === 1 ? '' : 's'} evaluated · snapshot {s.snapshot_id}{s.mission.mission_id ? ` · mission definition ${s.mission.mission_id} v${s.mission.mission_version}` : ''}</p>

        <h2>Decision</h2>
        {s.decisions.length === 0 && <p className="rpt-box">No plan has a canonical assessment, so none can be judged and nothing is recommended.</p>}
        {s.decisions.map((d) => (
          <div key={d.id} className="rpt-box rpt-keep">
            <p className="rpt-verdict">{d.label}{s.decisions.length > 1 ? ` · group ${d.id}${d.primary ? ' (main comparison)' : ''}` : ''}{d.recommended ? ` · Scenario ${d.recommended}` : ''}</p>
            <p>{d.headline}</p>
            {d.evidence.slice(0, 2).map((e) => <p key={e} className="rpt-small">{e}</p>)}
            {d.separate_reason && <p className="rpt-small">Separate group: {d.separate_reason}. No preference is stated across groups.</p>}
          </div>
        ))}

        <h2>Plans evaluated</h2>
        <table className="rpt-table rpt-plans">
          <colgroup><col style={{ width: '14%' }} /><col style={{ width: '27%' }} /><col style={{ width: '10%' }} /><col style={{ width: '15%' }} /><col style={{ width: '34%' }} /></colgroup>
          <thead><tr><th>Plan</th><th>Site · mission window (UTC)</th><th>Verdict</th><th>Rank (within its group)</th><th>Deciding requirement</th></tr></thead>
          <tbody>
            {s.scenarios.map((r) => (
              <tr key={r.label}>
                <td><b>{r.label}</b>{r.role ? <span className="rpt-small"> · {r.role}</span> : null}</td>
                <td className="rpt-wrap">{r.site}<span className="rpt-small"> · {windowText(r.mission_time)}</span></td>
                <td className="rpt-nowrap"><b>{verdictText(r.verdict)}</b>{r.verdict === null && <><br /><span className="rpt-small">{r.status_text}</span></>}</td>
                <td>{r.rank}</td>
                <td className="rpt-wrap rpt-small">{r.key ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Declared requirements</h2>
        {s.same_requirements && req0
          ? <p className="rpt-small rpt-reqs">{requirementList(req0).join(' · ')}.</p>
          : <p>The plans have different requirements: they are listed per plan on the next page, and plans are only ranked against others with the same requirements.</p>}

        {decisive.length > 0 && (
          <>
            <h2>Decisive differences</h2>
            <table className="rpt-table">
              <thead><tr><th>Measure</th>{Object.keys(decisive[0].cells).map((l) => <th key={l}>{l}{role(l) ? ` · ${role(l)}` : ''}</th>)}</tr></thead>
              <tbody>
                {decisive.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {Object.entries(row.cells).map(([l, c]) => (
                      <td key={l} className="rpt-nowrap">{c.status ? `${VERDICT[c.status].split(' ')[0]} ` : ''}{c.text}{c.limit ? <span className="rpt-small"> (limit {c.limit})</span> : null}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h2>Main uncertainty</h2>
        <p>{s.main_uncertainty}</p>
        {s.comparability_note && <p className="rpt-small">{s.comparability_note}</p>}

        <footer className="rpt-attrib">
          Data: NASA JPL Horizons (topocentric Sun / Earth positions, CENTER=coord@301) · NASA Moon Trek LOLA elevation models (terrain horizons) ·
          illumination cross-checked against NASA LROC WAC_POLE_ILL_TWI_SOUTH. The desirability score is a relative index, not a probability of
          success; Earth line of sight is not a radio link; illumination is not electrical power.
        </footer>
      </section>

      {/* ---------------- supporting pages ---------------- */}
      <section className="rpt-page rpt-break">
        <h2>Scenario configuration and results</h2>
        {x.scenarios.map((sc) => (
          <div key={sc.label} className="rpt-scenario">
            <h3>Scenario {sc.label}{sc.role ? ` · ${sc.role}` : ''}: <span className="rpt-wrap">{sc.name}</span></h3>
            <table className="rpt-table rpt-kv">
              <tbody>
                <tr><th>Site</th><td className="rpt-wrap">{sc.site.name} ({sc.site.id}) · {Math.abs(sc.site.lat).toFixed(5)}° {sc.site.lat < 0 ? 'S' : 'N'}, {sc.site.lon.toFixed(5)}° E{sc.coordinate_source ? <><br /><span className="rpt-small">Coordinates: {sc.coordinate_source}</span></> : null}</td></tr>
                <tr><th>Requested</th><td>{utc(sc.mission_time.requested_landing_utc)} · {sc.mission_time.requested_duration_days} days (the request, as entered)</td></tr>
                <tr><th>Evaluated</th><td>{sc.mission_time.evaluated_landing_utc ? `${utc(sc.mission_time.evaluated_landing_utc)} → ${utc(sc.mission_time.evaluated_end_utc)} (${Math.round((sc.mission_time.evaluated_duration_hours ?? 0) * 10) / 10} h, hourly evaluation grid)` : `not evaluated (${sc.mission_time.evaluation_status.replace(/_/g, ' ')}): no evaluated window exists, none is substituted from the request`}{sc.mission_time.time_note ? <><br /><span className="rpt-small">{sc.mission_time.time_note}</span></> : null}</td></tr>
                <tr><th>Verdict</th><td><b>{verdictText(sc.eligibility)}</b>{sc.canonical_rank !== null ? ` · canonical rank ${sc.canonical_rank} in group ${sc.ranking_group}` : ''}{sc.recommended ? ' · recommended' : ''} · score {sc.score.status === 'known' && sc.score.exact !== null ? sc.score.exact.toFixed(1) : sc.score.status === 'bounded' ? `${sc.score.lower?.toFixed(1)} – ${sc.score.upper?.toFixed(1)} (bounds)` : `not scored${sc.score.status ? ` (${sc.score.status.replace(/_/g, ' ')})` : ''}`}{sc.overall_risk ? ` · screening risk ${sc.overall_risk}` : ''}</td></tr>
                <tr><th>Data</th><td className="rpt-wrap">{sc.data.kind ?? 'not loaded'}{sc.data.kind === 'demonstration' ? ' (synthetic: illustrative only)' : ''} · {sc.data.source ?? '-'} · coverage Sun {sc.data.sun_coverage_percent?.toFixed(1) ?? '-'}% / Earth {sc.data.earth_coverage_percent?.toFixed(1) ?? '-'}%{sc.data.dataset_id ? <><br /><span className="rpt-small">Dataset {sc.data.dataset_id}{sc.data.dataset_file ? ` · file ${sc.data.dataset_file}` : ''}{sc.data.dataset_sha256 ? ` · SHA-256 ${sc.data.dataset_sha256}` : ' · SHA-256 unavailable'}</span></> : null}</td></tr>
                <tr><th>Spacecraft (example)</th><td>{sc.spacecraft.panel_mode.replace(/_/g, ' ')} panel · {sc.spacecraft.panel_rated_power_w} W rated · {sc.spacecraft.average_load_w} W load · {sc.spacecraft.battery_capacity_wh} Wh battery</td></tr>
                {!s.same_requirements && <tr><th>Requirements</th><td>{requirementList(sc.requirements).join(' · ')}</td></tr>}
                {sc.notes && <tr><th>Notes</th><td className="rpt-wrap">{sc.notes}</td></tr>}
                {sc.message && <tr><th>Message</th><td className="rpt-wrap rpt-small">{sc.message}</td></tr>}
              </tbody>
            </table>
            {sc.requirement_verdicts.filter((r) => r.status !== 'not_applicable').length > 0 && (
              <table className="rpt-table">
                <thead><tr><th>Requirement</th><th>Limit</th><th>Measured</th><th>Margin</th><th>Verdict</th></tr></thead>
                <tbody>
                  {sc.requirement_verdicts.filter((r) => r.status !== 'not_applicable').map((r) => (
                    <tr key={r.id}>
                      <td className="rpt-wrap">{r.name}{(r.status === 'fail' || r.status === 'unknown') && r.evidence_windows[0] && (
                        <span className="rpt-small"><br />Evidence: {r.evidence_windows[0].kind.replace(/_/g, ' ')} {utc(r.evidence_windows[0].start_utc)} → {utc(r.evidence_windows[0].end_utc)}{r.evidence_windows[0].clipped_at_end ? ' (continues past the mission end)' : ''}</span>
                      )}</td>
                      <td className="rpt-nowrap">{limitOf(r)}</td>
                      <td className="rpt-nowrap">{metricText(r.measured)}</td>
                      <td className="rpt-nowrap">{marginOf(r)}</td>
                      <td className="rpt-nowrap"><b>{verdictText(r.status)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </section>

      <section className="rpt-page rpt-break">
        <h2>Changes against the baseline</h2>
        {s.baseline ? <p className="rpt-small">Baseline: Scenario {s.baseline}. Hours in h, shares of the mission in percentage points (pp). Exact values only; bounds are not differenced.</p> : <p className="rpt-small">No baseline was set, so no changes are listed.</p>}
        <table className="rpt-table">
          <thead><tr><th>Measure</th>{Object.keys(s.decisive[0]?.cells ?? {}).map((l) => <th key={l}>{l}{l === s.baseline ? ' (baseline)' : ''}</th>)}</tr></thead>
          <tbody>
            {s.decisive.map((row) => (
              <tr key={row.label}>
                <td>{row.label}<br /><span className="rpt-small">{row.hint}</span></td>
                {Object.entries(row.cells).map(([l, c]) => (
                  <td key={l}>{c.status ? `${VERDICT[c.status].split(' ')[0]} ` : ''}{c.text}{c.delta ? <><br /><span className="rpt-small">{c.delta.text}{c.delta.better === null ? '' : c.delta.better ? ' (better)' : ' (worse)'}</span></> : null}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <h2>Ranking method and comparability</h2>
        <p className="rpt-small">Only plans that pass every requirement are ranked, and only against plans with the same requirements, mission duration and data basis (one comparable group). Ranking method {x.ranking_method ?? '-'}; scoring {x.reproduction.versions.scoring_method.join(', ') || '-'}.</p>
        <table className="rpt-table">
          <thead><tr><th>Group</th><th>Members</th><th>Ranked (PASS, in order)</th><th>Note</th></tr></thead>
          <tbody>
            {x.ranking_groups.map((g) => (
              <tr key={g.id}><td>{g.id}{g.primary ? ' (main)' : ''}</td><td>{g.members.join(', ')}</td><td>{g.ranked.join(' > ') || 'none'}</td><td className="rpt-wrap rpt-small">{g.separate_reason ?? g.data_basis ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
        {s.unassessed.length > 0 && <p className="rpt-small">Not part of any group: {s.unassessed.map((u) => `${u.label} (${u.reason})`).join('; ')}.</p>}

        {s.decisions.some((d) => d.pairs.length > 0) && (
          <>
            <h2>Pairwise evidence behind the order</h2>
            {s.decisions.map((d) => d.pairs.map((p) => (
              <div key={`${d.id}-${p.a}-${p.b}`} className="rpt-keep rpt-pair">
                <p><b>{p.a} vs {p.b}</b> · deciding criterion: {p.deciding?.replace(/_/g, ' ') ?? '-'}{p.tie_break ? ' (policy tie-break, not a measured difference)' : ''} · score difference: {p.score_difference}</p>
                {p.components.length > 0 && <p className="rpt-small">Components: {p.components.map((c) => `${c.label} favours ${c.favours}`).join('; ')}.</p>}
                <p className="rpt-small">{p.statement}</p>
              </div>
            )))}
          </>
        )}
        {s.decisions.some((d) => d.tradeoffs.length > 0) && (
          <>
            <h2>Measured trade-offs</h2>
            <ul className="rpt-list">{s.decisions.flatMap((d) => d.tradeoffs).map((t) => <li key={t}>{t}</li>)}</ul>
          </>
        )}
        {s.decisions.some((d) => d.uncertainty.length > 0) && (
          <>
            <h2>Uncertainty</h2>
            <ul className="rpt-list">{[...new Set(s.decisions.flatMap((d) => d.uncertainty))].map((t) => <li key={t}>{t}</li>)}</ul>
          </>
        )}
      </section>

      <section className="rpt-page rpt-break">
        {x.preferences && (
          <>
            <h2>User preference weights</h2>
            <p className="rpt-small">{x.preferences.note}</p>
            <p>Relative weights: {(() => {
              const w = Object.entries(x.preferences.weights)
              const sum = w.reduce((a, [, v]) => a + Number(v), 0) || 1
              return w.map(([k, v]) => `${k.replace(/_/g, ' ')} ${Math.round((Number(v) / sum) * 100)}%`).join(' · ')
            })()} · science traverse {x.preferences.traverse_km} km</p>
          </>
        )}
        <h2>Sources and data coverage</h2>
        <ul className="rpt-list">
          <li>NASA JPL Horizons System: apparent Sun and Earth azimuth / elevation from each site (CENTER=coord@301, DE441), precomputed hourly.</li>
          <li>NASA Moon Trek / LRO LOLA digital elevation models: terrain horizons in 720 directions with lunar curvature (5 m to 200 m resolution, out to 300 km).</li>
          <li>NASA LROC Quickmap WAC_POLE_ILL_TWI_SOUTH: orbital illumination map the sunlight model is compared with, site by site (agreement and its limits: Validation &amp; methodology).</li>
          <li>Gracy &amp; Lee, LPSC 2024: source of the Connecting Ridge and Peak Near Shackleton coordinates. It locates those two sites; it is not a validation of this model.</li>
          {x.reproduction.datasets.map((d) => <li key={d.file ?? d.dataset_id ?? ''} className="rpt-wrap">Site file {d.file ? `data/sites/${d.file}` : d.dataset_id ?? '-'}{d.sha256 ? ` · SHA-256 ${d.sha256}` : ' · hash not reported by the backend'}</li>)}
        </ul>
        <h2>Assumptions and limitations</h2>
        <ul className="rpt-list">
          <li>Exact model outputs are not physical certainty: verdicts rest on hourly geometric samples, the elevation models' resolution and the stated observer height.</li>
          <li>Illumination is not electrical power (array orientation, efficiency, dust and temperature are not modelled); Earth line of sight is not a radio link budget.</li>
          <li>The desirability score is a relative index under the stated weights, not a probability of mission success.</li>
          {s.limitations.map((l) => <li key={l}>{l}</li>)}
        </ul>
        <h2>Reproducing this report</h2>
        <p className="rpt-small">{x.reproduction.limitation}</p>
        <table className="rpt-table rpt-kv">
          <tbody>
            <tr><th>Rerun</th><td className="rpt-wrap">{x.reproduction.endpoint}; the inputs are in the JSON export of this report (reproduction.inputs).</td></tr>
            <tr><th>Engine</th><td>{x.reproduction.versions.engine.join(', ') || '-'}</td></tr>
            <tr><th>Scoring / ranking</th><td>{x.reproduction.versions.scoring_method.join(', ') || '-'} / {x.reproduction.versions.ranking_method ?? '-'}</td></tr>
            <tr><th>Mission time</th><td className="rpt-wrap rpt-small">{x.reproduction.time_policy ?? 'not reported'}</td></tr>
            <tr><th>Format</th><td>{s.report_format} · {x.reproduction.versions.export_format} · snapshot {s.snapshot_id}</td></tr>
          </tbody>
        </table>
      </section>
    </article>
  )
}

export function ReportPreview() {
  const { snapshot, open, close, generate } = useReportStore()
  const live = useCompareStore((s) => selectionKeyOf(s))
  const blocker = useCompareStore((s) => cannotGenerate(s))
  // While the Guided Tour shows this report (step 14) its card must stay reachable to assistive technology.
  const tourOpen = useTutorialStore((s) => s.open)
  const headRef = useRef<HTMLHeadingElement>(null)
  const opener = useRef<Element | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    opener.current = document.activeElement
    headRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (opener.current instanceof HTMLElement) opener.current.focus()
    }
  }, [open, close])

  if (!open || !snapshot) return null
  const stale = live !== snapshot.selection.key
  const download = () => downloadText(`lunar-decision-${snapshot.snapshot_id}.json`, JSON.stringify(snapshot, null, 2) + '\n', 'application/json')
  return createPortal(
    <div className="report-portal lp-light" role="dialog" aria-modal={tourOpen ? 'false' : 'true'} aria-labelledby="rpt-dialog-title" data-testid="report-preview" data-snapshot={snapshot.snapshot_id}>
      <div className="report-toolbar">
        <div className="report-toolbar-text">
          <h2 id="rpt-dialog-title" ref={headRef} tabIndex={-1}>Mission Report preview</h2>
          <p>Scenarios {snapshot.selection.labels.join(', ')} as evaluated at {utc(snapshot.generated_at)} · snapshot {snapshot.snapshot_id}</p>
        </div>
        <div className="report-toolbar-actions">
          <SnapshotPdfButton snapshot={snapshot} />
          <button type="button" className="report-btn" onClick={() => window.print()}>Print</button>
          <button type="button" className="report-btn" onClick={download}>Download JSON</button>
          <button type="button" className="report-btn" onClick={close} aria-label="Close the report preview">Close</button>
        </div>
        {stale && (
          <div className="report-stale" role="status" data-testid="report-stale">
            <span>The live comparison has changed since this report was generated. This report still shows the snapshot above.</span>
            <button type="button" className="report-btn" onClick={() => generate()} disabled={!!blocker} title={blocker ?? undefined}>
              Regenerate from the current comparison
            </button>
            {blocker && <span className="report-stale-why">{blocker}</span>}
          </div>
        )}
      </div>
      <div className="report-scroll" ref={scrollRef}>
        <MissionReportBody snapshot={snapshot} scrollRef={scrollRef} />
      </div>
    </div>,
    document.body,
  )
}

/** Reopen the last generated report exactly as it was (it is flagged if the comparison changed since). */
export function LastReportButton({ className = 'cmp-btn' }: { className?: string }) {
  const snap = useReportStore((s) => s.snapshot)
  const reopen = useReportStore((s) => s.reopen)
  if (!snap) return null
  return (
    <button type="button" className={className} onClick={reopen} data-testid="reopen-report"
      title={`Reopen the report for Scenarios ${snap.selection.labels.join(', ')} generated ${utc(snap.generated_at)}`}>
      Reopen last report
    </button>
  )
}

/** The decision area's "Generate Mission Report" action (the page header has the same action). */
export function ReportButton({ className = 'cmp-btn-primary' }: { className?: string }) {
  const blocker = useCompareStore((s) => cannotGenerate(s))
  const generate = useReportStore((s) => s.generate)
  return (
    <button type="button" className={className} disabled={!!blocker} title={blocker ?? 'Freeze this evaluated selection into a Mission Report you can preview and download'}
      onClick={() => generate()} data-testid="generate-report">
      Generate Mission Report
    </button>
  )
}
