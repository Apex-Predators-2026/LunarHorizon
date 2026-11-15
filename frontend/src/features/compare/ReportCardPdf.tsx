// The Mission Report as a formal PDF document (@react-pdf/renderer): an A4 title page with contents, then numbered
// sections with vector figures and three-rule tables, a running header and a footer with page numbers. Same
// sections, figures and content as the preview (ReportCardDocument.tsx). Loaded only on download (reportPdf.ts).
//
// Renderer rules learned the hard way: lineHeight only on Text styles that also set fontSize (on the page it hides
// the pinned page number; on a View it is computed against an 18 pt default and doubles the spacing), and a pinned
// Text needs a child to be drawn.
import { Document, Font, G, Line, Page, Rect, StyleSheet, Svg, Text, View } from '@react-pdf/renderer'
import type { ReactNode } from 'react'

import { fmtWhen } from './missionTime'
import type { CardValue, MetricRow, ReportCard, Status } from './reportCard'
import {
  COLORS, ELIGIBILITY_SHORT, FIG, SECTIONS, barGeometry, figurePlanKey, outcomeGeometry, pdfText, reportFigures, sectionNumber,
  type BarFigure, type OutcomeFigure, type SectionId,
} from './reportLayout'

const t = pdfText
// Whole words only: no automatic hyphenation (it split words such as "re-quirement").
Font.registerHyphenationCallback((word) => [word])

const SERIF = 'Times-Roman'
const BOLD = 'Times-Bold'
const ITALIC = 'Times-Italic'
const M = 56 // page side margin (about 20 mm)

const s = StyleSheet.create({
  page: { paddingTop: 58, paddingBottom: 56, paddingHorizontal: M, fontFamily: SERIF, fontSize: 10.5, color: COLORS.ink },
  titlePage: { paddingTop: 110, paddingBottom: 56, paddingHorizontal: M, fontFamily: SERIF, fontSize: 10.5, color: COLORS.ink },
  headLeft: { position: 'absolute', top: 30, left: M, fontFamily: ITALIC, fontSize: 8.5, color: COLORS.ink3 },
  headRight: { position: 'absolute', top: 30, right: M, width: 260, textAlign: 'right', fontFamily: ITALIC, fontSize: 8.5, color: COLORS.ink3 },
  headRule: { position: 'absolute', top: 44, left: M, right: M, height: 0.5, backgroundColor: COLORS.rule },
  footRule: { position: 'absolute', bottom: 38, left: M, right: M, height: 0.5, backgroundColor: COLORS.rule },
  footLeft: { position: 'absolute', bottom: 24, left: M, fontSize: 8.5, color: COLORS.ink3 },
  footRight: { position: 'absolute', bottom: 24, right: M, width: 120, textAlign: 'right', fontSize: 8.5, color: COLORS.ink3 },
  titleBlock: { borderTopWidth: 1.5, borderTopColor: COLORS.rule, borderBottomWidth: 0.5, borderBottomColor: COLORS.rule, paddingTop: 26, paddingBottom: 22, marginBottom: 30 },
  kicker: { fontSize: 10, letterSpacing: 1.6, textAlign: 'center' },
  title: { fontFamily: BOLD, fontSize: 25, textAlign: 'center', marginTop: 16, lineHeight: 1.2 },
  sub: { fontFamily: ITALIC, fontSize: 12.5, textAlign: 'center', marginTop: 8 },
  detailRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: COLORS.hair, paddingVertical: 3.5 },
  detailKey: { width: '32%', fontFamily: BOLD, fontSize: 10 },
  detailVal: { width: '68%', fontSize: 10, lineHeight: 1.3 },
  h2: { fontFamily: BOLD, fontSize: 14, marginTop: 14, marginBottom: 7 },
  h3: { fontFamily: BOLD, fontSize: 11, marginTop: 9, marginBottom: 3 },
  p: { fontSize: 10.5, lineHeight: 1.4, marginBottom: 6, textAlign: 'justify' },
  note: { fontSize: 8.5, color: COLORS.ink3 },
  missing: { fontFamily: ITALIC, color: COLORS.ink3 },
  status: { fontFamily: BOLD },
  statusMuted: { color: COLORS.ink3 },
  li: { flexDirection: 'row', marginBottom: 2 },
  bullet: { width: 11, fontSize: 10.5 },
  liText: { flex: 1, fontSize: 10.5, lineHeight: 1.35 },
  liSmall: { flex: 1, fontSize: 9.5, lineHeight: 1.3 },
  caption: { fontFamily: BOLD, fontSize: 9.5, marginTop: 8, marginBottom: 3 },
  table: { borderTopWidth: 1.2, borderTopColor: COLORS.rule, borderBottomWidth: 1.2, borderBottomColor: COLORS.rule, marginBottom: 10 },
  tr: { flexDirection: 'row', borderTopWidth: 0.4, borderTopColor: '#e0e0e0' },
  thead: { flexDirection: 'row', borderBottomWidth: 0.6, borderBottomColor: COLORS.rule },
  cell: { paddingVertical: 3, paddingHorizontal: 4 },
  cellText: { fontSize: 9, lineHeight: 1.3 },
  headText: { fontFamily: BOLD, fontSize: 9, lineHeight: 1.3 },
  kvRow: { flexDirection: 'row', marginBottom: 1.5 },
  kvKey: { width: '26%', fontFamily: BOLD, fontSize: 9.5, lineHeight: 1.3 },
  kvVal: { width: '74%', fontSize: 9.5, lineHeight: 1.3 },
  figure: { marginBottom: 8 },
  figCaption: { fontSize: 9, lineHeight: 1.3, color: COLORS.ink2, marginTop: 2 },
  conclusion: { borderWidth: 0.75, borderColor: COLORS.rule, padding: 7, marginVertical: 6 },
  contentsRow: { flexDirection: 'row', paddingVertical: 1.5 },
})

const Para = ({ children }: { children: ReactNode }) => <Text style={s.p}>{children}</Text>

function List({ items, empty }: { items: string[]; empty?: string }) {
  if (!items.length) return empty ? <Text style={[s.liText, s.missing]}>{t(empty)}</Text> : null
  return <View>{items.map((x, i) => <View key={i} style={s.li} wrap={false}><Text style={s.bullet}>•</Text><Text style={s.liText}>{t(x)}</Text></View>)}</View>
}

/** Smaller lists for the reference material in section 8. */
function SmallList({ items }: { items: string[] }) {
  return <View>{items.map((x, i) => <View key={i} style={s.li} wrap={false}><Text style={[s.bullet, { fontSize: 9.5 }]}>•</Text><Text style={s.liSmall}>{t(x)}</Text></View>)}</View>
}

function StatusWord({ status }: { status: Status | 'NOT CONFIGURED' }) {
  return <Text style={status === 'NOT CONFIGURED' || status === 'NOT ASSESSED' ? s.statusMuted : s.status}>{status}</Text>
}

function H2({ id, breakBefore = false }: { id: SectionId; breakBefore?: boolean }) {
  const sec = SECTIONS.find((x) => x.id === id)!
  return <Text style={s.h2} break={breakBefore} minPresenceAhead={70}>{sectionNumber(id)}. {sec.title}</Text>
}

const valueStyle = (v: CardValue) => (v.kind === 'known' ? {} : s.missing)

/**
 * A three-rule table: a wide first column and one column per plan. A table is never split across pages (each is
 * well under a page), so its caption always stays with it.
 */
function Grid({ caption, head, rows, labels }: { caption: string; head: string; rows: { key: string; first: ReactNode; cells: Record<string, ReactNode> }[]; labels: string[] }) {
  const w = `${(66 / Math.max(labels.length, 1)).toFixed(2)}%`
  return (
    <View wrap={false}>
      <Text style={s.caption}>{t(caption)}</Text>
      <View style={s.table}>
        <View style={s.thead}>
          <View style={[s.cell, { width: '34%' }]}><Text style={s.headText}>{t(head)}</Text></View>
          {labels.map((l) => <View key={l} style={[s.cell, { width: w }]}><Text style={s.headText}>Plan {l}</Text></View>)}
        </View>
        {rows.map((r, i) => (
          <View key={r.key} style={i ? s.tr : { flexDirection: 'row' }} wrap={false}>
            <View style={[s.cell, { width: '34%' }]}>{r.first}</View>
            {labels.map((l) => <View key={l} style={[s.cell, { width: w }]}>{r.cells[l]}</View>)}
          </View>
        ))}
      </View>
    </View>
  )
}

function MetricGrid({ caption, rows, labels }: { caption: string; rows: MetricRow[]; labels: string[] }) {
  return (
    <Grid caption={caption} head="Measure" labels={labels} rows={rows.map((r) => ({
      key: r.id,
      first: <View><Text style={s.cellText}>{t(r.metric)}</Text>{r.better || r.note ? <Text style={s.note}>{t([r.better && `${r.better} is better`, r.note].filter(Boolean).join('. '))}</Text> : null}</View>,
      cells: Object.fromEntries(labels.map((l) => {
        const v = r.values[l]
        const best = r.best.includes(l)
        return [l, r.id === 'verdict'
          ? <Text key={l} style={s.cellText}><StatusWord status={v.text as Status} /></Text>
          : <Text key={l} style={[s.cellText, valueStyle(v), best ? { fontFamily: BOLD } : {}]}>{t(v.text)}{best ? ' (best)' : ''}</Text>]
      })),
    }))} />
  )
}

// ---------------------------------------------------------------- figures (vector, same geometry as the preview)

const svgText = { fontFamily: SERIF, fontSize: 8 }
const PLOT_WIDTH = 483 // the text column (A4 width minus the two margins)

function BarChartPdf({ f }: { f: BarFigure }) {
  const g = barGeometry(f)
  return (
    <Svg width={PLOT_WIDTH} height={(g.height * PLOT_WIDTH) / g.width} viewBox={`0 0 ${g.width} ${g.height}`}>
      {g.ticks.map((tk) => (
        <G key={tk.text}>
          <Line x1={tk.x} x2={tk.x} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.grid} strokeWidth={0.6} />
          <Text x={tk.x} y={g.plot.y1 + 12} textAnchor="middle" style={svgText}>{t(tk.text)}</Text>
        </G>
      ))}
      <Line x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      <Line x1={g.plot.x0} x2={g.plot.x0} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      {g.rows.map((r) => (
        <G key={r.label}>
          <Text x={g.plot.x0 - 6} y={r.y + FIG.bar - 2} textAnchor="end" style={{ fontFamily: SERIF, fontSize: 9 }}>{r.label}</Text>
          {r.w !== null ? <Rect x={r.x} y={r.y} width={r.w} height={FIG.bar} fill={COLORS.bar} /> : null}
          <Text x={r.missing ? g.plot.x0 + 4 : g.plot.x1 + 6} y={r.y + FIG.bar - 2} style={{ fontFamily: r.missing ? ITALIC : SERIF, fontSize: 9 }}>{t(r.valueText)}</Text>
        </G>
      ))}
      {g.limit ? (
        <G>
          <Line x1={g.limit.x} x2={g.limit.x} y1={g.plot.y0 - 2} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={1} strokeDasharray="4 3" />
          <Text x={g.limit.x} y={g.plot.y1 + 22} textAnchor="middle" style={{ fontFamily: ITALIC, fontSize: 8 }}>{t(g.limit.text)}</Text>
        </G>
      ) : null}
    </Svg>
  )
}

const OUTCOME_COLOR = { pass: COLORS.pass, fail: COLORS.fail, unknown: COLORS.unknown }

function OutcomeChartPdf({ f }: { f: OutcomeFigure }) {
  const g = outcomeGeometry(f)
  const h = g.height + 14
  return (
    <Svg width={PLOT_WIDTH} height={(h * PLOT_WIDTH) / g.width} viewBox={`0 0 ${g.width} ${h}`}>
      {g.ticks.map((tk) => (
        <G key={tk.text}>
          <Line x1={tk.x} x2={tk.x} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.grid} strokeWidth={0.6} />
          <Text x={tk.x} y={g.plot.y1 + 12} textAnchor="middle" style={svgText}>{tk.text}</Text>
        </G>
      ))}
      <Line x1={g.plot.x0} x2={g.plot.x1} y1={g.plot.y1} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      <Line x1={g.plot.x0} x2={g.plot.x0} y1={g.plot.y0} y2={g.plot.y1} stroke={COLORS.ink} strokeWidth={0.8} />
      {g.rows.map((r) => (
        <G key={r.label}>
          <Text x={g.plot.x0 - 6} y={r.y + FIG.bar - 2} textAnchor="end" style={{ fontFamily: SERIF, fontSize: 9 }}>{r.label}</Text>
          {r.segments.map((sg) => (
            <G key={sg.kind}>
              <Rect x={sg.x} y={r.y} width={sg.w} height={FIG.bar} fill={OUTCOME_COLOR[sg.kind]} stroke="#ffffff" strokeWidth={0.6} />
              {sg.w >= 12 ? <Text x={sg.x + sg.w / 2} y={r.y + FIG.bar - 2.5} textAnchor="middle" fill="#ffffff" style={{ fontFamily: BOLD, fontSize: 8 }}>{String(sg.n)}</Text> : null}
            </G>
          ))}
          <Text x={g.plot.x1 + 6} y={r.y + FIG.bar - 2} style={{ fontFamily: r.segments.length ? SERIF : ITALIC, fontSize: 9 }}>{r.note}</Text>
        </G>
      ))}
      {(['pass', 'fail', 'unknown'] as const).map((k, i) => (
        <G key={k}>
          <Rect x={g.plot.x0 + i * 90} y={g.height + 4} width={9} height={9} fill={OUTCOME_COLOR[k]} />
          <Text x={g.plot.x0 + i * 90 + 13} y={g.height + 12} style={svgText}>{k.toUpperCase()}</Text>
        </G>
      ))}
    </Svg>
  )
}

function Figures({ card }: { card: ReportCard }) {
  return (
    <View>
      <Text style={s.figCaption}>{t(figurePlanKey(card))}</Text>
      {reportFigures(card).map((f) => (
        <View key={f.number} style={s.figure} wrap={false}>
          {f.kind === 'bars' ? <BarChartPdf f={f} /> : <OutcomeChartPdf f={f} />}
          <Text style={s.figCaption}><Text style={{ fontFamily: BOLD }}>Figure {f.number}.</Text> {t(`${f.title}. ${f.caption}`)}</Text>
        </View>
      ))}
    </View>
  )
}

function KV({ k, children }: { k: string; children: ReactNode }) {
  return <View style={s.kvRow}><Text style={s.kvKey}>{t(k)}</Text><Text style={s.kvVal}>{children}</Text></View>
}

function Chrome({ card, title = false }: { card: ReportCard; title?: boolean }) {
  return (
    <>
      {!title && <Text style={s.headLeft} fixed>{t(card.title)}{' '}</Text>}
      {!title && <Text style={s.headRight} fixed>{t(`Snapshot ${card.snapshot_id}`)}{' '}</Text>}
      {!title && <View style={s.headRule} fixed />}
      <View style={s.footRule} fixed />
      <Text style={s.footLeft} fixed>{t(`${card.product} · generated ${fmtWhen(card.generated_at)}`)}</Text>
      <Text style={s.footRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}>{' '}</Text>
    </>
  )
}

export function ReportCardPdf({ card }: { card: ReportCard }) {
  const labels = card.labels
  const plan = Object.fromEntries(card.plans.map((p) => [p.label, p]))
  const f = card.final
  return (
    <Document title={card.title} author={card.product} subject={`Plans ${labels.join(', ')} · snapshot ${card.snapshot_id}`} creator={card.product} producer={card.product}>
      {/* ---------------- title page and contents ---------------- */}
      <Page size="A4" style={s.titlePage}>
        <Chrome card={card} title />
        <View style={s.titleBlock}>
          <Text style={s.kicker}>{t(card.product.toUpperCase())}</Text>
          <Text style={s.title}>{t(card.title)}</Text>
          <Text style={s.sub}>{t(card.mission_title ?? `Comparison of ${labels.length} lunar south-pole landing plan${labels.length === 1 ? '' : 's'}`)}</Text>
        </View>
        {([
          ['Date generated', fmtWhen(card.generated_at)],
          ['Report snapshot', card.snapshot_id],
          ['Plans compared', card.plans.map((p) => `Plan ${p.label}: ${p.name}`).join('; ')],
          ['Data', 'NASA JPL Horizons ephemerides; NASA LRO LOLA terrain models'],
          ['Prepared with', card.product],
          ['Status of this document', 'Planning aid. Not an official NASA mission approval.'],
        ] as const).map(([k, v]) => (
          <View key={k} style={s.detailRow}><Text style={s.detailKey}>{k}</Text><Text style={s.detailVal}>{t(v)}</Text></View>
        ))}
        <Text style={[s.h2, { marginTop: 30 }]}>Contents</Text>
        {SECTIONS.map((sec, i) => (
          <View key={sec.id} style={s.contentsRow}><Text style={{ width: 22, fontSize: 10.5 }}>{i + 1}.</Text><Text style={{ fontSize: 10.5 }}>{sec.title}</Text></View>
        ))}
      </Page>

      {/* ---------------- the numbered sections ---------------- */}
      <Page size="A4" style={s.page}>
        <Chrome card={card} />

        <H2 id="rc-summary" />
        <Para>{t(card.executive_summary)}</Para>
        {card.change.length > 0 && <Para><Text style={{ fontFamily: BOLD }}>What changed. </Text>{t(card.change.join('; '))}</Para>}
        <Text style={s.caption}>Table 1. Plans compared</Text>
        <View style={s.table}>
          <View style={s.thead}>
            {['Plan', 'Landing site', 'Landing (UTC)', 'Duration', 'Assessment'].map((h, i) => <View key={h} style={[s.cell, { width: ['24%', '18%', '22%', '12%', '24%'][i] }]}><Text style={s.headText}>{h}</Text></View>)}
          </View>
          {card.plans.map((p, i) => (
            <View key={p.label} style={i ? s.tr : { flexDirection: 'row' }} wrap={false}>
              <View style={[s.cell, { width: '24%' }]}><Text style={s.cellText}><Text style={{ fontFamily: BOLD }}>{p.label}</Text> {t(p.name)}</Text>{p.role ? <Text style={s.note}>{t(p.role)}</Text> : null}</View>
              <View style={[s.cell, { width: '18%' }]}><Text style={s.cellText}>{t(p.site)}</Text></View>
              <View style={[s.cell, { width: '22%' }]}><Text style={s.cellText}>{t(p.landing)}</Text></View>
              <View style={[s.cell, { width: '12%' }]}><Text style={s.cellText}>{t(p.duration)}</Text></View>
              <View style={[s.cell, { width: '24%' }]}><Text style={s.cellText}><StatusWord status={p.status} /></Text><Text style={s.note}>{t(`${ELIGIBILITY_SHORT(p.eligibility)} · ${p.rank}`)}</Text></View>
            </View>
          ))}
        </View>
        <Text style={s.h3}>Key findings</Text>
        <List items={card.key_findings} />

        <H2 id="rc-overview" breakBefore />
        {card.overview.map((o, i) => {
          const p = plan[o.label]
          return (
            <View key={o.label} wrap={false} style={{ marginBottom: 6 }}>
              <Text style={s.h3}>{t(`2.${i + 1} Plan ${o.label}: ${p.name}`)}</Text>
              <KV k="Assessment"><StatusWord status={p.status} />{t(` · ${p.eligibility} · ${p.rank}`)}</KV>
              <KV k="Landing site">{t(`${p.site}${p.coordinates ? ` (${p.coordinates})` : ''}`)}</KV>
              <KV k="Landing (UTC)">{t(p.landing)}</KV>
              <KV k="Mission duration">{t(p.duration)}</KV>
              <KV k="Spacecraft">{t(o.spacecraft)}</KV>
              <KV k="Requirements">{t(o.requirements.length ? o.requirements.map((r) => `${r.requirement} ${r.limit}`).join('; ') : 'Not assessed')}</KV>
              <KV k="Data">{t(p.data)}</KV>
              {o.notes ? <KV k="Notes">{t(o.notes)}</KV> : null}
            </View>
          )
        })}

        <H2 id="rc-performance" breakBefore />
        <Figures card={card} />
        <MetricGrid caption="Table 2. Solar performance" rows={card.performance.solar} labels={labels} />
        <MetricGrid caption="Table 3. Communication performance (geometric line of sight, not a radio link budget)" rows={card.performance.communication} labels={labels} />
        <MetricGrid caption="Table 4. Mission viability" rows={card.performance.viability} labels={labels} />

        <H2 id="rc-analysis" breakBefore />
        {card.analysis.findings.map((x) => (
          <View key={x.topic} style={[s.kvRow, { marginBottom: 4 }]} wrap={false}>
            <Text style={[s.kvKey, { width: '24%' }]}>{t(x.topic)}</Text>
            <Text style={[s.kvVal, { width: '76%' }]}>{t(x.text)}</Text>
          </View>
        ))}
        {card.analysis.tradeoffs.length > 0 && <><Text style={s.h3}>Measured trade-offs</Text><List items={card.analysis.tradeoffs} /></>}
        <H2 id="rc-requirements" />
        <Grid caption="Table 5. Requirement-by-requirement assessment" head="Requirement" labels={labels} rows={card.requirements.rows.map((r) => ({
          key: r.id,
          first: <View><Text style={s.cellText}>{t(r.requirement)}</Text>{r.limit ? <Text style={s.note}>{t(`Limit: ${r.limit}`)}</Text> : null}</View>,
          cells: Object.fromEntries(labels.map((l) => {
            const c = r.cells[l]
            return [l, (
              <View key={l}>
                <Text style={s.cellText}><StatusWord status={c.status} /></Text>
                {c.status !== 'NOT CONFIGURED' && c.status !== 'NOT ASSESSED'
                  ? <Text style={s.note}>{t(`${c.measured}${!r.limit && c.limit ? ` (limit ${c.limit})` : ''}${c.margin ? `; margin ${c.margin}` : ''}`)}</Text> : null}
              </View>
            )]
          })),
        }))} />
        <Text style={s.note}>PASS: met. FAIL: violated. UNKNOWN: the data cannot decide it (not a failure). NOT ASSESSED: no data. NOT CONFIGURED: not a requirement of that plan.</Text>
        {card.requirements.unknown_notes.length > 0 && <><Text style={s.h3}>Requirements that cannot be decided</Text><List items={card.requirements.unknown_notes} /></>}

        <H2 id="rc-strengths" breakBefore />
        {card.strengths.map((x, i) => (
          <View key={x.label} wrap={false} style={{ marginBottom: 6 }}>
            <Text style={s.h3}>{`6.${i + 1} Plan ${x.label} (`}<StatusWord status={plan[x.label].status} />)</Text>
            <Text style={[s.cellText, { fontFamily: 'Times-BoldItalic', marginTop: 2 }]}>Strengths</Text>
            <List items={x.strengths} empty="None established by the evidence" />
            <Text style={[s.cellText, { fontFamily: 'Times-BoldItalic', marginTop: 2 }]}>Weaknesses</Text>
            <List items={x.weaknesses} empty="None found by the evidence" />
          </View>
        ))}
        <H2 id="rc-final" />
        <Text style={s.caption}>Table 6. Plans by assessment outcome</Text>
        <View style={s.table} wrap={false}>
          <View style={s.thead}>{['Eligible PASS', 'FAIL', 'UNKNOWN', 'Not assessed'].map((h) => <View key={h} style={[s.cell, { width: '25%' }]}><Text style={s.headText}>{h}</Text></View>)}</View>
          <View style={{ flexDirection: 'row' }}>
            {[f.categories.eligible_pass, f.categories.fail, f.categories.unknown, f.categories.not_assessed].map((ls, i) => (
              <View key={i} style={[s.cell, { width: '25%' }]}><Text style={s.cellText}>{ls.length ? ls.map((l) => `Plan ${l}`).join(', ') : 'None'}</Text></View>
            ))}
          </View>
        </View>
        {f.groups.map((g) => (
          <View key={g.id}>
            <Para>{t(g.statement)}</Para>
            <List items={g.evidence} />
            {g.uncertainty.length > 0 ? <Text style={s.note}>{t(`Uncertainty: ${g.uncertainty.join(' ')}`)}</Text> : null}
          </View>
        ))}
        {f.separate_groups_note ? <Text style={s.note}>{t(f.separate_groups_note)}</Text> : null}
        <View style={s.conclusion} wrap={false}><Text style={s.p}><Text style={{ fontFamily: BOLD }}>Conclusion. </Text>{t(f.conclusion)}</Text></View>

        <H2 id="rc-sources" breakBefore />
        <Text style={s.h3}>8.1 NASA data</Text>
        <SmallList items={card.sources.nasa} />
        {card.sources.datasets.length > 0 && <><Text style={s.h3}>8.2 Datasets</Text><SmallList items={card.sources.datasets} /></>}
        <Text style={s.h3}>8.3 Data coverage</Text>
        <SmallList items={card.sources.coverage.map((c) => `Plan ${c.label}: ${c.text}`)} />
        <Text style={s.h3}>8.4 Methodology</Text>
        <SmallList items={card.sources.methodology} />
        <Text style={s.h3}>8.5 Main uncertainty</Text>
        <Para>{t(card.sources.main_uncertainty)}</Para>
        {card.sources.limitations.length > 0 && <><Text style={s.h3}>8.6 Assumptions and limitations</Text><SmallList items={card.sources.limitations} /></>}
        <Text style={[s.note, { marginTop: 4 }]}>{t(`Versions: ${card.sources.versions.join('; ')}`)}</Text>
        <H2 id="rc-disclaimer" />
        <Text style={[s.p, { fontFamily: ITALIC, fontSize: 9.5 }]}>{t(card.disclaimer)}</Text>
      </Page>
    </Document>
  )
}
