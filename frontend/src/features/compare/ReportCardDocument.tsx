// The Mission Report as a formal document in the preview: a title page with contents, then numbered sections with
// figures and tables, a running header and a footer with page numbers. Laid out from the Report Card (reportCard.ts);
// the PDF (ReportCardPdf.tsx) has the same pages, sections and figures (reportLayout.ts).
import type { ReactNode } from 'react'

import { fmtWhen } from './missionTime'
import type { CardValue, MetricRow, ReportCard, Status } from './reportCard'
import {
  COLORS, ELIGIBILITY_SHORT, FIG, PAGE_COUNT, SECTIONS, barGeometry, figurePlanKey, outcomeGeometry, reportFigures, sectionNumber,
  type BarFigure, type OutcomeFigure, type SectionId,
} from './reportLayout'
import './reportCard.css'

/** A status as a plain word (formal style: no coloured badges). */
export function StatusWord({ status }: { status: Status | 'NOT CONFIGURED' }) {
  return <span className={`rc-status ${status === 'NOT CONFIGURED' || status === 'NOT ASSESSED' ? 'rc-status-muted' : ''}`}>{status}</span>
}

function Page({ n, card, children, title = false }: { n: number; card: ReportCard; children: ReactNode; title?: boolean }) {
  return (
    <section className={`rc-page ${title ? 'rc-page-title' : ''}`} aria-label={`Page ${n} of ${PAGE_COUNT}`} data-page={n}>
      {!title && (
        <header className="rc-running">
          <span>{card.title}</span>
          <span>Snapshot {card.snapshot_id}</span>
        </header>
      )}
      <div className="rc-body">{children}</div>
      <footer className="rc-running rc-foot">
        <span>{card.product} · generated {fmtWhen(card.generated_at)}</span>
        <span>Page {n} of {PAGE_COUNT}</span>
      </footer>
    </section>
  )
}

function H2({ id }: { id: SectionId }) {
  const s = SECTIONS.find((x) => x.id === id)!
  return <h2 id={id} className="rc-h2">{sectionNumber(id)}. {s.title}</h2>
}

const cellClass = (v: CardValue) => (v.kind === 'known' ? '' : v.kind === 'bounded' ? 'rc-range' : 'rc-missing')

function MetricTable({ caption, number, rows, labels }: { caption: string; number: number; rows: MetricRow[]; labels: string[] }) {
  return (
    <table className="rc-table">
      <caption>Table {number}. {caption}</caption>
      <thead>
        <tr><th scope="col" className="rc-metric">Measure</th>{labels.map((l) => <th key={l} scope="col">Plan {l}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row" className="rc-metric">
              {r.metric}
              {(r.better || r.note) && <span className="rc-note">{[r.better && `${r.better} is better`, r.note].filter(Boolean).join('. ')}</span>}
            </th>
            {labels.map((l) => {
              const v = r.values[l]
              const best = r.best.includes(l)
              return (
                <td key={l} className={`${cellClass(v)} ${best ? 'rc-best' : ''}`}>
                  {r.id === 'verdict' ? <StatusWord status={v.text as Status} /> : v.text}{best ? ' (best)' : ''}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------------------------------------------------------------- figures (inline SVG; same geometry as the PDF)

function BarChart({ f }: { f: BarFigure }) {
  const g = barGeometry(f)
  return (
    <svg viewBox={`0 0 ${g.width} ${g.height}`} className="rc-svg" role="img" aria-label={`${f.title}: ${f.bars.map((b) => `Plan ${b.label} ${b.value.text}`).join(', ')}`}>
      {g.ticks.map((t) => (
        <g key={t.text}>
          <line x1={t.x} x2={t.x} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.grid} strokeWidth={0.6} />
          <text x={t.x} y={g.plot.y1 + 12} textAnchor="middle" className="rc-svg-tick">{t.text}</text>
        </g>
      ))}
      <line x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      <line x1={g.plot.x0} x2={g.plot.x0} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      {g.rows.map((r) => (
        <g key={r.label}>
          <text x={g.plot.x0 - 6} y={r.y + FIG.bar - 2} textAnchor="end" className="rc-svg-label">{r.label}</text>
          {r.w !== null && <rect x={r.x} y={r.y} width={r.w} height={FIG.bar} fill={COLORS.bar} />}
          <text x={r.missing ? g.plot.x0 + 4 : g.plot.x1 + 6} y={r.y + FIG.bar - 2} className={r.missing ? 'rc-svg-missing' : 'rc-svg-value'}>{r.valueText}</text>
        </g>
      ))}
      {g.limit && (
        <g>
          <line x1={g.limit.x} x2={g.limit.x} y1={g.plot.y0 - 2} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={1} strokeDasharray="4 3" />
          <text x={g.limit.x} y={g.plot.y1 + 22} textAnchor="middle" className="rc-svg-limit">{g.limit.text}</text>
        </g>
      )}
    </svg>
  )
}

const OUTCOME_COLOR = { pass: COLORS.pass, fail: COLORS.fail, unknown: COLORS.unknown }

function OutcomeChart({ f }: { f: OutcomeFigure }) {
  const g = outcomeGeometry(f)
  return (
    <svg viewBox={`0 0 ${g.width} ${g.height + 14}`} className="rc-svg" role="img" aria-label={`${f.title}: ${f.rows.map((r) => `Plan ${r.label} ${r.pass} PASS, ${r.fail} FAIL, ${r.unknown} UNKNOWN`).join('; ')}`}>
      {g.ticks.map((t) => (
        <g key={t.text}>
          <line x1={t.x} x2={t.x} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.grid} strokeWidth={0.6} />
          <text x={t.x} y={g.plot.y1 + 12} textAnchor="middle" className="rc-svg-tick">{t.text}</text>
        </g>
      ))}
      <line x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      <line x1={g.plot.x0} x2={g.plot.x0} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      {g.rows.map((r) => (
        <g key={r.label}>
          <text x={g.plot.x0 - 6} y={r.y + FIG.bar - 2} textAnchor="end" className="rc-svg-label">{r.label}</text>
          {r.segments.map((s) => (
            <g key={s.kind}>
              <rect x={s.x} y={r.y} width={s.w} height={FIG.bar} fill={OUTCOME_COLOR[s.kind]} stroke="#ffffff" strokeWidth={0.6} />
              {s.w >= 12 && <text x={s.x + s.w / 2} y={r.y + FIG.bar - 2.5} textAnchor="middle" className="rc-svg-count">{s.n}</text>}
            </g>
          ))}
          <text x={g.plot.x1 + 6} y={r.y + FIG.bar - 2} className={r.segments.length ? 'rc-svg-value' : 'rc-svg-missing'}>{r.note}</text>
        </g>
      ))}
      {(['pass', 'fail', 'unknown'] as const).map((k, i) => (
        <g key={k} transform={`translate(${g.plot.x0 + i * 90}, ${g.height + 4})`}>
          <rect width={9} height={9} fill={OUTCOME_COLOR[k]} />
          <text x={13} y={8} className="rc-svg-tick" textAnchor="start">{k.toUpperCase()}</text>
        </g>
      ))}
    </svg>
  )
}

function Figures({ card }: { card: ReportCard }) {
  return (
    <div className="rc-figures">
      <p className="rc-note">{figurePlanKey(card)}</p>
      {reportFigures(card).map((f) => (
        <figure key={f.number} className="rc-figure">
          {f.kind === 'bars' ? <BarChart f={f} /> : <OutcomeChart f={f} />}
          <figcaption><b>Figure {f.number}.</b> {f.title}. {f.caption}</figcaption>
        </figure>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- the document

export function ReportCardDocument({ card }: { card: ReportCard }) {
  const labels = card.labels
  const plan = Object.fromEntries(card.plans.map((p) => [p.label, p]))
  const f = card.final
  return (
    <article className="rc-doc" aria-labelledby="rc-title">
      {/* ---------------- title page and contents ---------------- */}
      <Page n={1} card={card} title>
        <div className="rc-titleblock">
          <p className="rc-kicker">{card.product}</p>
          <h1 id="rc-title">{card.title}</h1>
          <p className="rc-sub">{card.mission_title ?? `Comparison of ${labels.length} lunar south-pole landing plan${labels.length === 1 ? '' : 's'}`}</p>
        </div>
        <table className="rc-details">
          <tbody>
            <tr><th scope="row">Date generated</th><td>{fmtWhen(card.generated_at)}</td></tr>
            <tr><th scope="row">Report snapshot</th><td>{card.snapshot_id}</td></tr>
            <tr><th scope="row">Plans compared</th><td>{card.plans.map((p) => `Plan ${p.label}: ${p.name}`).join('; ')}</td></tr>
            <tr><th scope="row">Data</th><td>NASA JPL Horizons ephemerides; NASA LRO LOLA terrain models</td></tr>
            <tr><th scope="row">Prepared with</th><td>{card.product}</td></tr>
            <tr><th scope="row">Status of this document</th><td>Planning aid. Not an official NASA mission approval.</td></tr>
          </tbody>
        </table>
        <h2 className="rc-contents-title">Contents</h2>
        <ol className="rc-contents">
          {SECTIONS.map((s) => <li key={s.id}><span>{s.title}</span><span className="rc-dots" aria-hidden="true" /><span>{s.page}</span></li>)}
        </ol>
      </Page>

      {/* ---------------- 1 · executive summary ---------------- */}
      <Page n={2} card={card}>
        <H2 id="rc-summary" />
        <p>{card.executive_summary}</p>
        {card.change.length > 0 && <p><b>What changed.</b> {card.change.join('; ')}</p>}
        <table className="rc-table rc-plans">
          <caption>Table 1. Plans compared</caption>
          <thead><tr><th scope="col">Plan</th><th scope="col">Landing site</th><th scope="col">Landing (UTC)</th><th scope="col">Duration</th><th scope="col">Assessment</th></tr></thead>
          <tbody>
            {card.plans.map((p) => (
              <tr key={p.label}>
                <td><b>{p.label}</b> <span className="rc-wrap">{p.name}</span>{p.role && <span className="rc-note">{p.role}</span>}</td>
                <td className="rc-wrap">{p.site}</td>
                <td>{p.landing}</td>
                <td>{p.duration}</td>
                <td><StatusWord status={p.status} /><span className="rc-note">{ELIGIBILITY_SHORT(p.eligibility)} · {p.rank}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3 className="rc-h3">Key findings</h3>
        <ul className="rc-list">{card.key_findings.map((k) => <li key={k}>{k}</li>)}</ul>
      </Page>

      {/* ---------------- 2 · mission overview ---------------- */}
      <Page n={3} card={card}>
        <H2 id="rc-overview" />
        {card.overview.map((o, i) => {
          const p = plan[o.label]
          return (
            <div key={o.label} className="rc-plan">
              <h3 className="rc-h3">2.{i + 1} Plan {o.label}: <span className="rc-wrap">{p.name}</span></h3>
              <table className="rc-kv">
                <tbody>
                  <tr><th scope="row">Assessment</th><td><StatusWord status={p.status} /> · {p.eligibility} · {p.rank}</td></tr>
                  <tr><th scope="row">Landing site</th><td>{p.site}{p.coordinates ? ` (${p.coordinates})` : ''}</td></tr>
                  <tr><th scope="row">Landing (UTC)</th><td>{p.landing}{p.time_note && <span className="rc-note">{p.time_note}</span>}</td></tr>
                  <tr><th scope="row">Mission duration</th><td>{p.duration}</td></tr>
                  <tr><th scope="row">Spacecraft</th><td>{o.spacecraft}</td></tr>
                  <tr><th scope="row">Requirements</th><td>{o.requirements.length ? o.requirements.map((r) => `${r.requirement} ${r.limit}`).join('; ') : 'Not assessed'}</td></tr>
                  <tr><th scope="row">Data</th><td>{p.data}</td></tr>
                  {o.notes && <tr><th scope="row">Notes</th><td className="rc-wrap">{o.notes}</td></tr>}
                </tbody>
              </table>
            </div>
          )
        })}
      </Page>

      {/* ---------------- 3 · performance ---------------- */}
      <Page n={4} card={card}>
        <H2 id="rc-performance" />
        <Figures card={card} />
        <MetricTable number={2} caption="Solar performance" rows={card.performance.solar} labels={labels} />
        <MetricTable number={3} caption="Communication performance (geometric line of sight, not a radio link budget)" rows={card.performance.communication} labels={labels} />
        <MetricTable number={4} caption="Mission viability" rows={card.performance.viability} labels={labels} />
      </Page>

      {/* ---------------- 4 · analysis, 5 · requirements ---------------- */}
      <Page n={5} card={card}>
        <H2 id="rc-analysis" />
        <table className="rc-kv rc-findings">
          <tbody>{card.analysis.findings.map((x) => <tr key={x.topic}><th scope="row">{x.topic}</th><td>{x.text}</td></tr>)}</tbody>
        </table>
        {card.analysis.tradeoffs.length > 0 && (
          <>
            <h3 className="rc-h3">Measured trade-offs</h3>
            <ul className="rc-list">{card.analysis.tradeoffs.map((t) => <li key={t}>{t}</li>)}</ul>
          </>
        )}
        <H2 id="rc-requirements" />
        <table className="rc-table rc-reqs">
          <caption>Table 5. Requirement-by-requirement assessment</caption>
          <thead><tr><th scope="col" className="rc-metric">Requirement</th>{labels.map((l) => <th key={l} scope="col">Plan {l}</th>)}</tr></thead>
          <tbody>
            {card.requirements.rows.map((r) => (
              <tr key={r.id}>
                <th scope="row" className="rc-metric">{r.requirement}{r.limit && <span className="rc-note">Limit: {r.limit}</span>}</th>
                {labels.map((l) => {
                  const c = r.cells[l]
                  return (
                    <td key={l}>
                      <StatusWord status={c.status} />
                      {c.status !== 'NOT CONFIGURED' && c.status !== 'NOT ASSESSED' && (
                        <span className="rc-note">{c.measured}{!r.limit && c.limit ? ` (limit ${c.limit})` : ''}{c.margin ? `; margin ${c.margin}` : ''}</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="rc-note">PASS: met. FAIL: violated. UNKNOWN: the data cannot decide it (not a failure). NOT ASSESSED: no data. NOT CONFIGURED: not a requirement of that plan.</p>
        {card.requirements.unknown_notes.length > 0 && (
          <>
            <h3 className="rc-h3">Requirements that cannot be decided</h3>
            <ul className="rc-list">{card.requirements.unknown_notes.map((u) => <li key={u}>{u}</li>)}</ul>
          </>
        )}
      </Page>

      {/* ---------------- 6 · strengths, 7 · final ---------------- */}
      <Page n={6} card={card}>
        <H2 id="rc-strengths" />
        {card.strengths.map((s, i) => (
          <div key={s.label} className="rc-plan">
            <h3 className="rc-h3">6.{i + 1} Plan {s.label} (<StatusWord status={plan[s.label].status} />)</h3>
            <p className="rc-sw-head">Strengths</p>
            <ul className="rc-list">{s.strengths.length ? s.strengths.map((x) => <li key={x}>{x}</li>) : <li className="rc-missing">None established by the evidence</li>}</ul>
            <p className="rc-sw-head">Weaknesses</p>
            <ul className="rc-list">{s.weaknesses.length ? s.weaknesses.map((x) => <li key={x}>{x}</li>) : <li className="rc-missing">None found by the evidence</li>}</ul>
          </div>
        ))}
        <H2 id="rc-final" />
        <table className="rc-table rc-categories">
          <caption>Table 6. Plans by assessment outcome</caption>
          <thead><tr><th scope="col">Eligible PASS</th><th scope="col">FAIL</th><th scope="col">UNKNOWN</th><th scope="col">Not assessed</th></tr></thead>
          <tbody>
            <tr>
              {[f.categories.eligible_pass, f.categories.fail, f.categories.unknown, f.categories.not_assessed].map((ls, i) => (
                <td key={i}>{ls.length ? ls.map((l) => `Plan ${l}`).join(', ') : 'None'}</td>
              ))}
            </tr>
          </tbody>
        </table>
        {f.groups.map((g) => (
          <div key={g.id}>
            <p>{g.statement}</p>
            {g.evidence.length > 0 && <ul className="rc-list">{g.evidence.map((e) => <li key={e}>{e}</li>)}</ul>}
            {g.uncertainty.length > 0 && <p className="rc-note">Uncertainty: {g.uncertainty.join(' ')}</p>}
          </div>
        ))}
        {f.separate_groups_note && <p className="rc-note">{f.separate_groups_note}</p>}
        <p className="rc-conclusion"><b>Conclusion.</b> {f.conclusion}</p>
      </Page>

      {/* ---------------- 8 · sources, 9 · disclaimer ---------------- */}
      <Page n={7} card={card}>
        <H2 id="rc-sources" />
        <h3 className="rc-h3">8.1 NASA data</h3>
        <ul className="rc-list">{card.sources.nasa.map((x) => <li key={x}>{x}</li>)}</ul>
        {card.sources.datasets.length > 0 && <><h3 className="rc-h3">8.2 Datasets</h3><ul className="rc-list rc-wrap">{card.sources.datasets.map((x) => <li key={x}>{x}</li>)}</ul></>}
        <h3 className="rc-h3">8.3 Data coverage</h3>
        <ul className="rc-list">{card.sources.coverage.map((c) => <li key={c.label}>Plan {c.label}: {c.text}</li>)}</ul>
        <h3 className="rc-h3">8.4 Methodology</h3>
        <ul className="rc-list">{card.sources.methodology.map((x) => <li key={x}>{x}</li>)}</ul>
        <h3 className="rc-h3">8.5 Main uncertainty</h3>
        <p>{card.sources.main_uncertainty}</p>
        {card.sources.limitations.length > 0 && <><h3 className="rc-h3">8.6 Assumptions and limitations</h3><ul className="rc-list">{card.sources.limitations.map((x) => <li key={x}>{x}</li>)}</ul></>}
        <p className="rc-note">Versions: {card.sources.versions.join('; ')}</p>
        <H2 id="rc-disclaimer" />
        <p className="rc-disclaimer">{card.disclaimer}</p>
      </Page>
    </article>
  )
}
