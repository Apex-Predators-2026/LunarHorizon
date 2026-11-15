// The Mission Report as a real PDF document (@react-pdf/renderer): A4 pages, running header and footer with page
// numbers, tables that wrap instead of overflowing, and charts drawn as shapes. Same sections and content as the
// preview (ReportCardDocument.tsx). Loaded only when the user downloads (see reportPdf.ts).
import { Document, Font, Page, StyleSheet, Text, View } from '@react-pdf/renderer'
import type { ReactNode } from 'react'

import { fmtWhen } from './missionTime'
import type { CardValue, MetricRow, ReportCard, Status } from './reportCard'
import { COLORS, ELIGIBILITY_SHORT, SECTIONS, STATUS_STYLE, headlineCharts, pdfText, sectionNumber, type SectionId } from './reportLayout'

const t = pdfText
// Whole words only: no automatic hyphenation (it split words such as "re-quirement").
Font.registerHyphenationCallback((word) => [word])
const s = StyleSheet.create({
  // Line spacing: only on Text styles that also set fontSize. On the page it hides the pinned page number, and on a
  // View it is computed against the renderer's 18 pt default font size (double spacing).
  page: { paddingTop: 40, paddingBottom: 44, paddingHorizontal: 36, fontFamily: 'Helvetica', fontSize: 9, color: COLORS.ink },
  header: { position: 'absolute', top: 0, left: 0, right: 0, height: 24, backgroundColor: COLORS.navy, color: '#cbd5e1', fontSize: 7.5, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 36 },
  // The footer is three separately pinned elements (a View row pinned to the bottom was dropped by the renderer).
  footRule: { position: 'absolute', bottom: 30, left: 36, right: 36, height: 0.5, backgroundColor: COLORS.line },
  footLeft: { position: 'absolute', bottom: 17, left: 36, fontSize: 7.5, color: COLORS.ink3 },
  footRight: { position: 'absolute', bottom: 17, right: 36, width: 120, textAlign: 'right', fontSize: 7.5, color: COLORS.ink3 },
  cover: { backgroundColor: COLORS.navy, color: '#ffffff', marginHorizontal: -36, marginTop: -16, paddingHorizontal: 36, paddingTop: 22, paddingBottom: 18, borderBottomWidth: 3, borderBottomColor: COLORS.cyan, marginBottom: 14 },
  kicker: { fontSize: 8, color: '#67e8f9', letterSpacing: 1.5 },
  title: { fontSize: 22, fontFamily: 'Helvetica-Bold', marginTop: 4, lineHeight: 1.2 },
  sub: { fontSize: 11, color: '#e2e8f0', marginTop: 4 },
  meta: { fontSize: 8, color: '#cbd5e1', marginTop: 10 },
  h2: { flexDirection: 'row', alignItems: 'center', marginTop: 12, marginBottom: 6, paddingBottom: 3, borderBottomWidth: 1.5, borderBottomColor: COLORS.navy },
  h2num: { backgroundColor: COLORS.cyan, color: '#ffffff', fontSize: 8, fontFamily: 'Helvetica-Bold', paddingHorizontal: 4, paddingVertical: 1, marginRight: 6, borderRadius: 2 },
  h2text: { fontSize: 12.5, fontFamily: 'Helvetica-Bold', color: COLORS.navy },
  h3: { fontSize: 10, fontFamily: 'Helvetica-Bold', color: COLORS.navy2, marginTop: 8, marginBottom: 3 },
  p: { marginBottom: 5, fontSize: 9, lineHeight: 1.35 },
  note: { fontSize: 7.5, color: COLORS.ink3 },
  missing: { color: COLORS.ink3, fontFamily: 'Helvetica-Oblique' },
  li: { flexDirection: 'row', marginBottom: 2 },
  bullet: { width: 9, color: COLORS.cyan },
  liText: { flex: 1, fontSize: 9, lineHeight: 1.35 },
  table: { marginVertical: 5, borderTopWidth: 0.75, borderTopColor: '#b8c2cf' },
  caption: { fontSize: 9.5, fontFamily: 'Helvetica-Bold', color: COLORS.navy2, marginTop: 6 },
  tr: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: COLORS.line },
  th: { backgroundColor: COLORS.wash, fontFamily: 'Helvetica-Bold', color: COLORS.ink2 },
  cell: { paddingVertical: 3, paddingHorizontal: 4 },
  best: { backgroundColor: COLORS.cyanSoft, fontFamily: 'Helvetica-Bold' },
  chip: { borderWidth: 0.75, borderRadius: 2, paddingHorizontal: 3, paddingVertical: 0.5, fontSize: 7, fontFamily: 'Helvetica-Bold', alignSelf: 'flex-start' },
  callout: { borderLeftWidth: 2.5, borderLeftColor: COLORS.cyan, backgroundColor: COLORS.cyanSoft, padding: 6, marginVertical: 5 },
  conclusion: { borderLeftWidth: 2.5, borderLeftColor: COLORS.navy, backgroundColor: COLORS.wash, padding: 7, marginVertical: 6, fontSize: 10 },
  disclaimer: { borderWidth: 0.75, borderColor: COLORS.line, backgroundColor: COLORS.wash, padding: 7, fontSize: 8.5, color: COLORS.ink2 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  half: { width: '48.5%', marginBottom: 8 },
  plan: { borderTopWidth: 1.5, borderTopColor: COLORS.line, paddingTop: 3 },
  kv: { flexDirection: 'row', marginBottom: 1.5 },
  kvKey: { width: '33%', color: COLORS.ink3, fontSize: 8 },
  kvVal: { width: '67%', fontSize: 8, lineHeight: 1.3 },
  chart: { width: '48.5%', borderWidth: 0.75, borderColor: COLORS.line, padding: 6, marginBottom: 6 },
  barRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 1.5 },
  barLabel: { width: 10, fontFamily: 'Helvetica-Bold', fontSize: 8, color: COLORS.ink2 },
  barTrack: { flex: 1, height: 7, backgroundColor: COLORS.wash, marginRight: 5 },
  barValue: { width: '42%', fontSize: 7.5 },
  category: { width: '23.5%', borderWidth: 0.75, borderTopWidth: 2.5, padding: 5 },
})

const Para = ({ children, style }: { children: ReactNode; style?: { fontSize?: number; marginTop?: number } }) => <Text style={style ? [s.p, style] : s.p}>{children}</Text>

function List({ items, empty }: { items: string[]; empty?: string }) {
  if (!items.length) return empty ? <Text style={[s.p, s.missing]}>{t(empty)}</Text> : null
  return <View>{items.map((x, i) => <View key={i} style={s.li} wrap={false}><Text style={s.bullet}>•</Text><Text style={s.liText}>{t(x)}</Text></View>)}</View>
}

function Chip({ status }: { status: Status | 'NOT CONFIGURED' }) {
  const c = STATUS_STYLE[status]
  return <Text style={[s.chip, { color: c.fg, backgroundColor: c.bg, borderColor: c.border }]}>{status}</Text>
}

function H2({ id, breakBefore = false }: { id: SectionId; breakBefore?: boolean }) {
  const sec = SECTIONS.find((x) => x.id === id)!
  return (
    <View style={s.h2} break={breakBefore} minPresenceAhead={60}>
      <Text style={s.h2num}>{sectionNumber(id)}</Text>
      <Text style={s.h2text}>{sec.title}</Text>
    </View>
  )
}

const valueStyle = (v: CardValue) => (v.kind === 'known' ? {} : s.missing)

/** A table with a wide first column and one column per plan. */
function Grid({ head, rows, labels }: { head: string; rows: { key: string; first: ReactNode; cells: Record<string, { node: ReactNode; best?: boolean }> }[]; labels: string[] }) {
  const w = `${(66 / Math.max(labels.length, 1)).toFixed(2)}%`
  return (
    <View style={s.table}>
      <View style={[s.tr, s.th]} fixed>
        <Text style={[s.cell, { width: '34%' }]}>{t(head)}</Text>
        {labels.map((l) => <Text key={l} style={[s.cell, { width: w }]}>Scenario {l}</Text>)}
      </View>
      {rows.map((r) => (
        <View key={r.key} style={s.tr} wrap={false}>
          <View style={[s.cell, { width: '34%' }]}>{r.first}</View>
          {labels.map((l) => <View key={l} style={[s.cell, { width: w }, r.cells[l]?.best ? s.best : {}]}>{r.cells[l]?.node}</View>)}
        </View>
      ))}
    </View>
  )
}

function MetricGrid({ caption, rows, labels }: { caption: string; rows: MetricRow[]; labels: string[] }) {
  return (
    <View>
      <Text style={s.caption} minPresenceAhead={40}>{t(caption)}</Text>
      <Grid head="Measure" labels={labels} rows={rows.map((r) => ({
        key: r.id,
        first: <View><Text style={{ fontFamily: 'Helvetica-Bold' }}>{t(r.metric)}</Text>{r.better ? <Text style={[s.note, { color: COLORS.cyan }]}>{r.better} is better</Text> : null}{r.note ? <Text style={s.note}>{t(r.note)}</Text> : null}</View>,
        cells: Object.fromEntries(labels.map((l) => {
          const v = r.values[l]
          const node = r.id === 'verdict' ? <Chip status={v.text as Status} /> : <Text style={valueStyle(v)}>{t(v.text)}{r.best.includes(l) ? '  (best)' : ''}</Text>
          return [l, { node, best: r.best.includes(l) }]
        })),
      }))} />
    </View>
  )
}

function Charts({ card }: { card: ReportCard }) {
  return (
    <View style={s.grid2}>
      {headlineCharts(card).map((c) => (
        <View key={c.title} style={s.chart} wrap={false}>
          <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 8.5, color: COLORS.navy2, marginBottom: 3 }}>{t(c.title)} <Text style={{ fontFamily: 'Helvetica', color: COLORS.ink3 }}>({c.better} is better)</Text></Text>
          {c.bars.map((b) => (
            <View key={b.label} style={s.barRow}>
              <Text style={s.barLabel}>{b.label}</Text>
              <View style={s.barTrack}>{b.share !== null ? <View style={{ width: `${Math.max(b.share * 100, 0.8)}%`, height: '100%', backgroundColor: b.best ? COLORS.cyan : COLORS.bar }} /> : null}</View>
              <Text style={[s.barValue, valueStyle(b.value)]}>{t(b.value.text)}{b.best ? ' (best)' : ''}</Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}

function KV({ k, v }: { k: string; v: string }) {
  return <View style={s.kv}><Text style={s.kvKey}>{t(k)}</Text><Text style={s.kvVal}>{t(v)}</Text></View>
}

export function ReportCardPdf({ card }: { card: ReportCard }) {
  const labels = card.labels
  const plan = Object.fromEntries(card.plans.map((p) => [p.label, p]))
  const f = card.final
  return (
    <Document title={card.title} author={card.product} subject={`Scenarios ${labels.join(', ')} · snapshot ${card.snapshot_id}`} creator={card.product} producer={card.product}>
      <Page size="A4" style={s.page}>
        <View style={s.header} fixed>
          <Text>{t(`${card.product} · ${card.title}`)}</Text>
          <Text>Snapshot {t(card.snapshot_id)}</Text>
        </View>
        <View style={s.footRule} fixed />
        <Text style={s.footLeft} fixed>{t(`Generated ${fmtWhen(card.generated_at)} · modelled results, not an official NASA approval`)}</Text>
        {/* A pinned Text with no children has no size and is never drawn: the placeholder child gives it one. */}
        <Text style={s.footRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`}>{' '}</Text>

        {/* 1 · cover and executive summary */}
        <View style={s.cover}>
          <Text style={s.kicker}>{t(card.product.toUpperCase())}</Text>
          <Text style={s.title}>{t(card.title)}</Text>
          {card.mission_title ? <Text style={s.sub}>{t(card.mission_title)}</Text> : null}
          <Text style={s.meta}>{t(`Generated ${fmtWhen(card.generated_at)} · Scenarios ${labels.join(', ')} · Snapshot ${card.snapshot_id}`)}</Text>
        </View>
        <H2 id="rc-summary" />
        <View style={s.table}>
          <View style={[s.tr, s.th]}>
            {['Plan', 'Landing site', 'Landing (UTC)', 'Duration', 'Assessment'].map((h, i) => <Text key={h} style={[s.cell, { width: ['24%', '18%', '22%', '12%', '24%'][i] }]}>{h}</Text>)}
          </View>
          {card.plans.map((p) => (
            <View key={p.label} style={s.tr} wrap={false}>
              <View style={[s.cell, { width: '24%' }]}><Text><Text style={{ fontFamily: 'Helvetica-Bold' }}>{p.label}</Text> {t(p.name)}</Text>{p.role ? <Text style={s.note}>{t(p.role)}</Text> : null}</View>
              <Text style={[s.cell, { width: '18%' }]}>{t(p.site)}</Text>
              <Text style={[s.cell, { width: '22%' }]}>{t(p.landing)}</Text>
              <Text style={[s.cell, { width: '12%' }]}>{t(p.duration)}</Text>
              <View style={[s.cell, { width: '24%' }]}><Chip status={p.status} /><Text style={s.note}>{t(`${ELIGIBILITY_SHORT(p.eligibility)} · ${p.rank}`)}</Text></View>
            </View>
          ))}
        </View>
        {card.change.length > 0 && <View style={s.callout}><Text><Text style={{ fontFamily: 'Helvetica-Bold' }}>What changed. </Text>{t(card.change.join('; '))}</Text></View>}
        <Para style={{ fontSize: 9.5, marginTop: 4 }}>{t(card.executive_summary)}</Para>
        <Text style={s.h3}>Key findings</Text>
        <List items={card.key_findings} />

        {/* 2 · overview */}
        <H2 id="rc-overview" breakBefore />
        <View style={s.grid2}>
          {card.overview.map((o) => {
            const p = plan[o.label]
            return (
              <View key={o.label} style={[s.half, s.plan]} wrap={false}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
                  <Text style={[s.h3, { marginTop: 0, marginBottom: 0, marginRight: 5, flex: 1 }]}>{t(`Scenario ${o.label} · ${p.name}`)}</Text>
                  <Chip status={p.status} />
                </View>
                <KV k="Landing site" v={`${p.site}${p.coordinates ? ` · ${p.coordinates}` : ''}`} />
                <KV k="Landing (UTC)" v={p.landing} />
                <KV k="Mission duration" v={p.duration} />
                <KV k="Spacecraft" v={o.spacecraft} />
                <KV k="Requirements" v={o.requirements.length ? o.requirements.map((r) => `${r.requirement} ${r.limit}`).join(' · ') : 'Not assessed'} />
                <KV k="Eligibility" v={p.eligibility} />
                <KV k="Canonical rank" v={p.rank} />
                <KV k="Data" v={p.data} />
                {o.notes ? <KV k="Notes" v={o.notes} /> : null}
              </View>
            )
          })}
        </View>

        {/* 3 · performance */}
        <H2 id="rc-performance" breakBefore />
        <Charts card={card} />
        <MetricGrid caption="Solar performance" rows={card.performance.solar} labels={labels} />
        <MetricGrid caption="Communication performance (geometric line of sight, not a radio link budget)" rows={card.performance.communication} labels={labels} />
        <MetricGrid caption="Mission viability" rows={card.performance.viability} labels={labels} />

        {/* 4 · analysis and requirements */}
        <H2 id="rc-analysis" breakBefore />
        {card.analysis.findings.map((x) => (
          <View key={x.topic} style={[s.tr, { paddingVertical: 3 }]} wrap={false}>
            <Text style={{ width: '24%', fontFamily: 'Helvetica-Bold', color: COLORS.navy2 }}>{t(x.topic)}</Text>
            <Text style={{ width: '76%' }}>{t(x.text)}</Text>
          </View>
        ))}
        {card.analysis.tradeoffs.length > 0 && <><Text style={s.h3}>Measured trade-offs</Text><List items={card.analysis.tradeoffs} /></>}
        <H2 id="rc-requirements" />
        <Grid head="Requirement" labels={labels} rows={card.requirements.rows.map((r) => ({
          key: r.id,
          first: <View><Text style={{ fontFamily: 'Helvetica-Bold' }}>{t(r.requirement)}</Text>{r.limit ? <Text style={s.note}>{t(`Limit: ${r.limit}`)}</Text> : null}</View>,
          cells: Object.fromEntries(labels.map((l) => {
            const c = r.cells[l]
            return [l, { node: (
              <View>
                <Chip status={c.status} />
                {c.status !== 'NOT CONFIGURED' && c.status !== 'NOT ASSESSED'
                  ? <Text style={s.note}>{t(`${c.measured}${!r.limit && c.limit ? ` (limit ${c.limit})` : ''}${c.margin ? ` · margin ${c.margin}` : ''}`)}</Text> : null}
              </View>
            ) }]
          })),
        }))} />
        <Text style={s.note}>PASS: met · FAIL: violated · UNKNOWN: the data cannot decide it (not a failure) · NOT ASSESSED: no data · NOT CONFIGURED: not a requirement of that plan.</Text>
        {card.requirements.unknown_notes.length > 0 && <><Text style={s.h3}>Why some requirements are UNKNOWN</Text><List items={card.requirements.unknown_notes} /></>}

        {/* 5 · strengths, weaknesses, final */}
        <H2 id="rc-strengths" breakBefore />
        <View style={s.grid2}>
          {card.strengths.map((x) => (
            <View key={x.label} style={[s.half, s.plan]} wrap={false}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                <Text style={[s.h3, { marginTop: 0, marginBottom: 0, marginRight: 5 }]}>Scenario {x.label}</Text>
                <Chip status={plan[x.label].status} />
              </View>
              <Text style={[s.note, { fontFamily: 'Helvetica-Bold', marginTop: 3 }]}>STRENGTHS</Text>
              <List items={x.strengths} empty="None established by the evidence" />
              <Text style={[s.note, { fontFamily: 'Helvetica-Bold', marginTop: 3 }]}>WEAKNESSES</Text>
              <List items={x.weaknesses} empty="None found by the evidence" />
            </View>
          ))}
        </View>
        <H2 id="rc-final" />
        <View style={[s.grid2, { marginBottom: 6 }]} wrap={false}>
          {([['Eligible PASS', f.categories.eligible_pass, 'PASS'], ['FAIL', f.categories.fail, 'FAIL'], ['UNKNOWN', f.categories.unknown, 'UNKNOWN'], ['Not assessed', f.categories.not_assessed, 'NOT ASSESSED']] as const).map(([name, ls, st]) => (
            <View key={name} style={[s.category, { borderColor: STATUS_STYLE[st].border }]}>
              <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: COLORS.ink2 }}>{name.toUpperCase()}</Text>
              <Text style={{ fontSize: 9 }}>{ls.length ? ls.map((l) => `Scenario ${l}`).join(', ') : 'None'}</Text>
            </View>
          ))}
        </View>
        {f.groups.map((g) => (
          <View key={g.id} style={{ marginBottom: 4 }}>
            <Para>{t(g.statement)}</Para>
            <List items={g.evidence} />
            {g.uncertainty.length > 0 ? <Text style={s.note}>{t(`Uncertainty: ${g.uncertainty.join(' ')}`)}</Text> : null}
          </View>
        ))}
        {f.separate_groups_note ? <Text style={s.note}>{t(f.separate_groups_note)}</Text> : null}
        <View style={s.conclusion} wrap={false}><Text><Text style={{ fontFamily: 'Helvetica-Bold' }}>Conclusion. </Text>{t(f.conclusion)}</Text></View>

        {/* 6 · sources and disclaimer */}
        <H2 id="rc-sources" breakBefore />
        <Text style={s.h3}>NASA data</Text>
        <List items={card.sources.nasa} />
        {card.sources.datasets.length > 0 && <><Text style={s.h3}>Datasets</Text><List items={card.sources.datasets} /></>}
        <Text style={s.h3}>Data coverage</Text>
        <List items={card.sources.coverage.map((c) => `Scenario ${c.label}: ${c.text}`)} />
        <Text style={s.h3}>Methodology</Text>
        <List items={card.sources.methodology} />
        <Text style={s.h3}>Main uncertainty</Text>
        <Para>{t(card.sources.main_uncertainty)}</Para>
        {card.sources.limitations.length > 0 && <><Text style={s.h3}>Assumptions and limitations</Text><List items={card.sources.limitations} /></>}
        <Text style={[s.note, { marginTop: 4 }]}>{t(`Versions: ${card.sources.versions.join(' · ')}`)}</Text>
        <H2 id="rc-disclaimer" />
        <View style={s.disclaimer} wrap={false}><Text>{t(card.disclaimer)}</Text></View>
      </Page>
    </Document>
  )
}
