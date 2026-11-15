// The Mission Report as a document in the preview: six pages with a running header and footer, laid out from the
// Report Card (reportCard.ts). The PDF (ReportCardPdf.tsx) has the same pages and sections (reportLayout.ts).
import type { ReactNode } from 'react'

import type { CardValue, MetricRow, ReportCard, Status } from './reportCard'
import { ELIGIBILITY_SHORT, PAGE_COUNT, SECTIONS, STATUS_STYLE, headlineCharts, sectionNumber, type SectionId } from './reportLayout'
import { fmtWhen } from './missionTime'
import './reportCard.css'

export function StatusChip({ status }: { status: Status | 'NOT CONFIGURED' }) {
  const s = STATUS_STYLE[status]
  return <span className="rc-chip" style={{ color: s.fg, background: s.bg, borderColor: s.border }}>{status}</span>
}

function Page({ n, card, children }: { n: number; card: ReportCard; children: ReactNode }) {
  return (
    <section className="rc-page" aria-label={`Page ${n} of ${PAGE_COUNT}`} data-page={n}>
      <header className="rc-running">
        <span>{card.product} · {card.title}</span>
        <span>Snapshot {card.snapshot_id}</span>
      </header>
      <div className="rc-body">{children}</div>
      <footer className="rc-running rc-foot">
        <span>Generated {fmtWhen(card.generated_at)} · modelled results, not an official NASA approval</span>
        <span>Page {n} of {PAGE_COUNT}</span>
      </footer>
    </section>
  )
}

function H2({ id }: { id: SectionId }) {
  const s = SECTIONS.find((x) => x.id === id)!
  return <h2 id={id} className="rc-h2"><span className="rc-num">{sectionNumber(id)}</span>{s.title}</h2>
}

const cellClass = (v: CardValue) => (v.kind === 'known' ? '' : v.kind === 'bounded' ? 'rc-range' : 'rc-missing')

function MetricTable({ caption, rows, labels }: { caption: string; rows: MetricRow[]; labels: string[] }) {
  return (
    <table className="rc-table">
      <caption>{caption}</caption>
      <thead>
        <tr><th scope="col" className="rc-metric">Measure</th>{labels.map((l) => <th key={l} scope="col">Scenario {l}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row" className="rc-metric">
              {r.metric}
              {r.better && <span className="rc-dir">{r.better === 'higher' ? 'higher is better' : 'lower is better'}</span>}
              {r.note && <span className="rc-note">{r.note}</span>}
            </th>
            {labels.map((l) => {
              const v = r.values[l]
              const best = r.best.includes(l)
              return (
                <td key={l} className={`${cellClass(v)} ${best ? 'rc-best' : ''}`}>
                  {r.id === 'verdict' ? <StatusChip status={v.text as Status} /> : v.text}
                  {best && <span className="rc-best-tag">Best</span>}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Charts({ card }: { card: ReportCard }) {
  return (
    <div className="rc-charts" role="group" aria-label="Headline measures by plan">
      {headlineCharts(card).map((c) => (
        <figure key={c.title} className="rc-chart">
          <figcaption>{c.title} <span>({c.better === 'higher' ? 'higher' : 'lower'} is better)</span></figcaption>
          {c.bars.map((b) => (
            <div key={b.label} className="rc-bar-row">
              <span className="rc-bar-label">{b.label}</span>
              <span className="rc-bar-track">
                {b.share !== null && <span className={`rc-bar ${b.best ? 'rc-bar-best' : ''}`} style={{ width: `${Math.max(b.share * 100, 0.8)}%` }} />}
              </span>
              <span className={`rc-bar-value ${cellClass(b.value)}`}>{b.value.text}{b.best ? ' · best' : ''}</span>
            </div>
          ))}
        </figure>
      ))}
    </div>
  )
}

export function ReportCardDocument({ card }: { card: ReportCard }) {
  const labels = card.labels
  const plan = Object.fromEntries(card.plans.map((p) => [p.label, p]))
  const f = card.final
  return (
    <article className="rc-doc" aria-labelledby="rc-title">
      {/* ---------------- 1 · cover and executive summary ---------------- */}
      <Page n={1} card={card}>
        <div className="rc-cover">
          <p className="rc-kicker">{card.product}</p>
          <h1 id="rc-title">{card.title}</h1>
          {card.mission_title && <p className="rc-sub">{card.mission_title}</p>}
          <p className="rc-meta">Generated {fmtWhen(card.generated_at)} · Scenarios {labels.join(', ')} · Snapshot {card.snapshot_id}</p>
        </div>
        <H2 id="rc-summary" />
        <table className="rc-table rc-plans">
          <thead><tr><th scope="col">Plan</th><th scope="col">Landing site</th><th scope="col">Landing (UTC)</th><th scope="col">Duration</th><th scope="col">Assessment</th></tr></thead>
          <tbody>
            {card.plans.map((p) => (
              <tr key={p.label}>
                <td><b>{p.label}</b> <span className="rc-wrap">{p.name}</span>{p.role && <span className="rc-note">{p.role}</span>}</td>
                <td className="rc-wrap">{p.site}</td>
                <td>{p.landing}</td>
                <td>{p.duration}</td>
                <td><StatusChip status={p.status} /> <span className="rc-note">{ELIGIBILITY_SHORT(p.eligibility)} · {p.rank}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        {card.change.length > 0 && <p className="rc-callout"><b>What changed. </b>{card.change.join('; ')}</p>}
        <p className="rc-lead">{card.executive_summary}</p>
        <h3 className="rc-h3">Key findings</h3>
        <ul className="rc-list">{card.key_findings.map((k) => <li key={k}>{k}</li>)}</ul>
      </Page>

      {/* ---------------- 2 · mission overview ---------------- */}
      <Page n={2} card={card}>
        <H2 id="rc-overview" />
        <div className="rc-overview">
          {card.overview.map((o) => {
            const p = plan[o.label]
            return (
              <div key={o.label} className="rc-plan">
                <h3 className="rc-h3">Scenario {o.label} · <span className="rc-wrap">{p.name}</span> <StatusChip status={p.status} /></h3>
                <dl className="rc-kv">
                  <dt>Landing site</dt><dd>{p.site}{p.coordinates ? ` · ${p.coordinates}` : ''}{p.coordinate_source && <span className="rc-note">Coordinates: {p.coordinate_source}</span>}</dd>
                  <dt>Landing (UTC)</dt><dd>{p.landing}{p.time_note && <span className="rc-note">{p.time_note}</span>}</dd>
                  <dt>Mission duration</dt><dd>{p.duration}</dd>
                  <dt>Spacecraft</dt><dd>{o.spacecraft}</dd>
                  <dt>Requirements</dt><dd>{o.requirements.length ? o.requirements.map((r) => `${r.requirement} ${r.limit}`).join(' · ') : 'Not assessed'}</dd>
                  <dt>Eligibility</dt><dd>{p.eligibility}</dd>
                  <dt>Canonical rank</dt><dd>{p.rank}</dd>
                  <dt>Data</dt><dd>{p.data}</dd>
                  {o.notes && <><dt>Notes</dt><dd className="rc-wrap">{o.notes}</dd></>}
                </dl>
              </div>
            )
          })}
        </div>
      </Page>

      {/* ---------------- 3 · performance ---------------- */}
      <Page n={3} card={card}>
        <H2 id="rc-performance" />
        <Charts card={card} />
        <MetricTable caption="Solar performance" rows={card.performance.solar} labels={labels} />
        <MetricTable caption="Communication performance (geometric line of sight, not a radio link budget)" rows={card.performance.communication} labels={labels} />
        <MetricTable caption="Mission viability" rows={card.performance.viability} labels={labels} />
      </Page>

      {/* ---------------- 4 · analysis and requirements ---------------- */}
      <Page n={4} card={card}>
        <H2 id="rc-analysis" />
        <dl className="rc-findings">
          {card.analysis.findings.map((x) => <div key={x.topic}><dt>{x.topic}</dt><dd>{x.text}</dd></div>)}
        </dl>
        {card.analysis.tradeoffs.length > 0 && (
          <>
            <h3 className="rc-h3">Measured trade-offs</h3>
            <ul className="rc-list">{card.analysis.tradeoffs.map((t) => <li key={t}>{t}</li>)}</ul>
          </>
        )}
        <H2 id="rc-requirements" />
        <table className="rc-table rc-reqs">
          <thead><tr><th scope="col" className="rc-metric">Requirement</th>{labels.map((l) => <th key={l} scope="col">Scenario {l}</th>)}</tr></thead>
          <tbody>
            {card.requirements.rows.map((r) => (
              <tr key={r.id}>
                <th scope="row" className="rc-metric">{r.requirement}{r.limit && <span className="rc-note">Limit: {r.limit}</span>}</th>
                {labels.map((l) => {
                  const c = r.cells[l]
                  return (
                    <td key={l}>
                      <StatusChip status={c.status} />
                      {c.status !== 'NOT CONFIGURED' && c.status !== 'NOT ASSESSED' && (
                        <span className="rc-note">{c.measured}{!r.limit && c.limit ? ` (limit ${c.limit})` : ''}{c.margin ? ` · margin ${c.margin}` : ''}</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="rc-note rc-legend">PASS: met · FAIL: violated · UNKNOWN: the data cannot decide it (not a failure) · NOT ASSESSED: no data · NOT CONFIGURED: not a requirement of that plan.</p>
        {card.requirements.unknown_notes.length > 0 && (
          <>
            <h3 className="rc-h3">Why some requirements are UNKNOWN</h3>
            <ul className="rc-list">{card.requirements.unknown_notes.map((u) => <li key={u}>{u}</li>)}</ul>
          </>
        )}
      </Page>

      {/* ---------------- 5 · strengths, weaknesses, final ---------------- */}
      <Page n={5} card={card}>
        <H2 id="rc-strengths" />
        <div className="rc-sw">
          {card.strengths.map((s) => (
            <div key={s.label} className="rc-plan">
              <h3 className="rc-h3">Scenario {s.label} <StatusChip status={plan[s.label].status} /></h3>
              <p className="rc-sw-head">Strengths</p>
              <ul className="rc-list">{s.strengths.length ? s.strengths.map((x) => <li key={x}>{x}</li>) : <li className="rc-missing">None established by the evidence</li>}</ul>
              <p className="rc-sw-head">Weaknesses</p>
              <ul className="rc-list">{s.weaknesses.length ? s.weaknesses.map((x) => <li key={x}>{x}</li>) : <li className="rc-missing">None found by the evidence</li>}</ul>
            </div>
          ))}
        </div>
        <H2 id="rc-final" />
        <div className="rc-categories">
          {([['Eligible PASS', f.categories.eligible_pass, 'PASS'], ['FAIL', f.categories.fail, 'FAIL'], ['UNKNOWN', f.categories.unknown, 'UNKNOWN'], ['Not assessed', f.categories.not_assessed, 'NOT ASSESSED']] as const).map(([name, ls, st]) => (
            <div key={name} className="rc-category" style={{ borderColor: STATUS_STYLE[st].border }}>
              <span className="rc-category-name">{name}</span>
              <span className="rc-category-list">{ls.length ? ls.map((l) => `Scenario ${l}`).join(', ') : 'None'}</span>
            </div>
          ))}
        </div>
        {f.groups.map((g) => (
          <div key={g.id} className="rc-decision">
            <p>{g.statement}</p>
            {g.evidence.length > 0 && <ul className="rc-list">{g.evidence.map((e) => <li key={e}>{e}</li>)}</ul>}
            {g.uncertainty.length > 0 && <p className="rc-note">Uncertainty: {g.uncertainty.join(' ')}</p>}
          </div>
        ))}
        {f.separate_groups_note && <p className="rc-note">{f.separate_groups_note}</p>}
        <p className="rc-conclusion"><b>Conclusion. </b>{f.conclusion}</p>
      </Page>

      {/* ---------------- 6 · sources, disclaimer ---------------- */}
      <Page n={6} card={card}>
        <H2 id="rc-sources" />
        <h3 className="rc-h3">NASA data</h3>
        <ul className="rc-list">{card.sources.nasa.map((x) => <li key={x}>{x}</li>)}</ul>
        {card.sources.datasets.length > 0 && <><h3 className="rc-h3">Datasets</h3><ul className="rc-list rc-wrap">{card.sources.datasets.map((x) => <li key={x}>{x}</li>)}</ul></>}
        <h3 className="rc-h3">Data coverage</h3>
        <ul className="rc-list">{card.sources.coverage.map((c) => <li key={c.label}>Scenario {c.label}: {c.text}</li>)}</ul>
        <h3 className="rc-h3">Methodology</h3>
        <ul className="rc-list">{card.sources.methodology.map((x) => <li key={x}>{x}</li>)}</ul>
        <h3 className="rc-h3">Main uncertainty</h3>
        <p>{card.sources.main_uncertainty}</p>
        {card.sources.limitations.length > 0 && <><h3 className="rc-h3">Assumptions and limitations</h3><ul className="rc-list">{card.sources.limitations.map((x) => <li key={x}>{x}</li>)}</ul></>}
        <p className="rc-note">Versions: {card.sources.versions.join(' · ')}</p>
        <H2 id="rc-disclaimer" />
        <p className="rc-disclaimer">{card.disclaimer}</p>
      </Page>
    </article>
  )
}
