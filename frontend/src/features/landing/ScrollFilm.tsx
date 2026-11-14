// The landing page's scroll film: one sticky stage, scrubbed by scroll through ten beats (content.ts BEATS).
// The canvas scene fills the stage, each beat's text rises in on a frosted card at the lower left, a step bar
// sits at the bottom, and a frosted rail on the right holds the live conditions and the app's real pictures
// (the one that goes with the current beat is highlighted). Under prefers-reduced-motion the scene steps from
// beat to beat instead of moving continuously.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { GlassSurface } from '../../ui/GlassSurface'
import { ExternalIcon } from '../../ui/icons'
import { BEATS, HERO, PICTURES, REPO_URL } from './content'
import { LiveNow } from './LiveNow'
import { beatAt, beatJumpT, clamp01, renderStory } from './storyRender'
import { usePrefersReducedMotion } from './useReducedMotion'

const FILM_SCREENS = 11 // runway height, in screens
const FADE = 0.022 // share of the film over which a beat's text fades in or out

function paint(canvas: HTMLCanvasElement | null, t: number) {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const r = canvas.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(r.width * dpr))
  const h = Math.max(1, Math.round(r.height * dpr))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  // Keep the scene clear of the side rail when it is shown.
  const rail = canvas.closest('.lnd-stage')?.querySelector<HTMLElement>('.lnd-rail')
  const inset = rail && rail.offsetParent !== null ? r.right - rail.getBoundingClientRect().left + 16 : 0
  renderStory(ctx, r.width, r.height, t, inset)
}

/** Opacity and rise for beat i's text at film position t. */
function beatStyle(t: number, i: number) {
  const b = BEATS[i]
  const first = i === 0
  const last = i === BEATS.length - 1
  const inK = first ? 1 : clamp01((t - b.start) / FADE)
  const outK = last ? 0 : clamp01((t - (b.end - FADE)) / FADE)
  const k = Math.min(inK, 1 - outK)
  const y = inK < 1 ? (1 - inK) * 28 : -outK * 22
  return { k, transform: `translate3d(0, ${y.toFixed(1)}px, 0)`, filter: k < 0.98 ? `blur(${((1 - k) * 6).toFixed(1)}px)` : 'none' }
}

function Facts({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl className="lnd-facts">
      {facts.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd>{f.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function OpenButton({ onOpen, small = false }: { onOpen: () => void; small?: boolean }) {
  return (
    <button type="button" className={`lnd-btn lnd-btn-filled ${small ? 'lnd-btn-sm' : ''}`} onClick={onOpen}>
      Open the navigator
    </button>
  )
}

function HeroBeat({ onOpen, onNext }: { onOpen: () => void; onNext: () => void }) {
  return (
    <div className="lnd-hero-copy">
      <p className="lnd-hero-team">{HERO.team}</p>
      <h1 id="lnd-title">{HERO.headline}</h1>
      <p className="lnd-hero-lead">{HERO.lead}</p>
      <div className="lnd-hero-actions">
        <OpenButton onOpen={onOpen} />
        <button type="button" className="lnd-btn lnd-btn-glass" onClick={onNext}>
          Scroll the mission
        </button>
      </div>
      <div className="lnd-live-inline">
        <LiveNow idPrefix="lnd-live-inline" />
      </div>
    </div>
  )
}

function BeatCard({ i, onOpen }: { i: number; onOpen: () => void }) {
  const b = BEATS[i]
  const last = i === BEATS.length - 1
  return (
    <GlassSurface radius="28px" className="lnd-glass-dark lnd-beat-card">
      <p className="lnd-beat-src">{b.source}</p>
      <h2>{b.title}</h2>
      <p className="lnd-beat-body">{b.body}</p>
      <Facts facts={b.facts} />
      {last && (
        <div className="lnd-beat-actions">
          <OpenButton onOpen={onOpen} small />
          <a className="lnd-btn lnd-btn-glass lnd-btn-sm" href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Source on GitHub <ExternalIcon size={14} />
          </a>
        </div>
      )}
    </GlassSurface>
  )
}

/** Large view of one picture, with previous / next. Native <dialog> gives focus trapping and Escape. */
function Lightbox({ index, onClose, onIndex }: { index: number | null; onClose: () => void; onIndex: (i: number) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d || typeof d.showModal !== 'function') return
    if (index !== null && !d.open) d.showModal()
    if (index === null && d.open) d.close()
  }, [index])
  const pic = index === null ? null : PICTURES[index]
  const step = (k: number) => index !== null && onIndex((index + k + PICTURES.length) % PICTURES.length)
  return (
    <dialog
      ref={ref}
      className="lnd-lightbox"
      aria-label={pic ? pic.title : 'Picture'}
      onClose={onClose}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') step(1)
        if (e.key === 'ArrowLeft') step(-1)
      }}
    >
      {pic && (
        <figure>
          <img src={pic.src} alt={pic.caption} />
          <figcaption>
            <span>
              <strong>{pic.title}</strong> {pic.caption}
            </span>
            <span className="lnd-lightbox-actions">
              <button type="button" className="lnd-btn lnd-btn-glass lnd-btn-sm" onClick={() => step(-1)}>Previous</button>
              <button type="button" className="lnd-btn lnd-btn-glass lnd-btn-sm" onClick={() => step(1)}>Next</button>
              <button type="button" className="lnd-btn lnd-btn-filled lnd-btn-sm" onClick={onClose}>Close</button>
            </span>
          </figcaption>
        </figure>
      )}
    </dialog>
  )
}

export function ScrollFilm({ onOpen, onActive }: { onOpen: () => void; onActive?: (i: number) => void }) {
  const reduce = usePrefersReducedMotion()
  const runway = useRef<HTMLElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const bar = useRef<HTMLDivElement>(null)
  const railList = useRef<HTMLUListElement>(null)
  const cur = useRef(0)
  const raf = useRef(0)
  const activeRef = useRef(0)
  const [active, setActive] = useState(0)
  const [lightbox, setLightbox] = useState<number | null>(null)
  const reduceRef = useRef(reduce)
  reduceRef.current = reduce
  const onActiveRef = useRef(onActive)
  onActiveRef.current = onActive

  const target = () => {
    const el = runway.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp01(-r.top / Math.max(1, r.height - window.innerHeight))
  }

  const apply = (t: number) => {
    const idx = beatAt(t)
    // Reduced motion: the scene holds each beat's key frame instead of moving with every pixel of scroll.
    const b = BEATS[idx]
    paint(canvas.current, reduceRef.current ? (idx === 0 ? 0 : b.start + (b.end - b.start) * 0.7) : t)
    cards.current.forEach((el, i) => {
      if (!el) return
      if (reduceRef.current) {
        el.style.opacity = i === idx ? '1' : '0'
        el.style.visibility = i === idx ? 'visible' : 'hidden'
        return
      }
      const s = beatStyle(t, i)
      el.style.opacity = s.k.toFixed(3)
      el.style.transform = s.transform
      el.style.filter = s.filter
      el.style.visibility = s.k < 0.01 ? 'hidden' : 'visible'
    })
    if (bar.current) bar.current.style.transform = `scaleX(${t.toFixed(4)})`
    if (idx !== activeRef.current) {
      activeRef.current = idx
      setActive(idx)
      onActiveRef.current?.(idx)
    }
  }

  useLayoutEffect(() => {
    cur.current = target()
    apply(cur.current)
    const tick = () => {
      const tg = target()
      const d = tg - cur.current
      // Ordinary scrolling eases the scene toward the scroll position (a light spring); big jumps land at once.
      cur.current = reduceRef.current || Math.abs(d) < 0.0003 || Math.abs(d) > 0.2 ? tg : cur.current + d * 0.15
      apply(cur.current)
      raf.current = cur.current === tg ? 0 : requestAnimationFrame(tick)
    }
    const kick = () => {
      if (!raf.current) raf.current = requestAnimationFrame(tick)
    }
    const resize = () => apply(cur.current)
    window.addEventListener('scroll', kick, { passive: true })
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('scroll', kick)
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(raf.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the highlighted picture in view inside the rail (the rail scrolls, the page does not).
  const picIndex = Math.max(0, PICTURES.findIndex((p) => p.id === BEATS[active].picture))
  useEffect(() => {
    const list = railList.current
    const item = list?.children[picIndex] as HTMLElement | undefined
    if (!list || !item) return
    list.scrollTo({ top: item.offsetTop - list.offsetTop - 8, behavior: reduce ? 'auto' : 'smooth' })
  }, [picIndex, reduce])

  const jump = (i: number) => {
    const el = runway.current
    if (!el) return
    const top = el.getBoundingClientRect().top + window.scrollY
    window.scrollTo({ top: top + (el.offsetHeight - window.innerHeight) * beatJumpT(i), behavior: reduce ? 'auto' : 'smooth' })
  }

  return (
    <section ref={runway} className="lnd-film" style={{ height: `${FILM_SCREENS * 100}svh` }} aria-labelledby="lnd-title">
      {/* Anchors so the header and other links can land on a beat. */}
      {BEATS.map((b, i) => (
        <span key={b.id} id={`beat-${b.id}`} className="lnd-anchor" style={{ top: `${beatJumpT(i) * (FILM_SCREENS - 1) * 100}svh` }} />
      ))}
      <div className="lnd-stage">
        <div className="lnd-stage-main">
          <canvas ref={canvas} className="lnd-canvas" aria-hidden="true" />
          <div className="lnd-scrim" aria-hidden="true" />
          <div className="lnd-beats">
            {BEATS.map((b, i) => (
              <div
                key={b.id}
                ref={(el) => {
                  cards.current[i] = el
                }}
                className={i === 0 ? 'lnd-beat lnd-beat-hero' : 'lnd-beat'}
                aria-hidden={active !== i}
              >
                {i === 0 ? <HeroBeat onOpen={onOpen} onNext={() => jump(1)} /> : <BeatCard i={i} onOpen={onOpen} />}
              </div>
            ))}
          </div>
          <div className="lnd-stepbar-slot">
            <GlassSurface radius="28px" className="lnd-glass-dark lnd-stepbar" interactive={false}>
              <div role="tablist" aria-label="Mission beats" className="lnd-steps">
                {BEATS.map((b, i) => (
                  <button
                    key={b.id}
                    type="button"
                    role="tab"
                    aria-selected={active === i}
                    aria-label={b.short}
                    title={b.short}
                    onClick={() => jump(i)}
                  >
                    <span aria-hidden="true" />
                  </button>
                ))}
              </div>
              <span className="lnd-step-name" aria-live="polite">{BEATS[active].short}</span>
              <div className="lnd-step-track" aria-hidden="true">
                <div ref={bar} className="lnd-step-fill" />
              </div>
              <button type="button" className="lnd-step-pics" onClick={() => setLightbox(picIndex)}>
                Pictures
              </button>
            </GlassSurface>
          </div>
        </div>
        <aside className="lnd-rail" aria-label="Live conditions and pictures of the app">
          <LiveNow />
          <GlassSurface radius="24px" className="lnd-glass-dark lnd-pics" interactive={false}>
            <h2 className="lnd-pics-h">Inside the navigator</h2>
            <ul ref={railList} className="lnd-pics-list">
              {PICTURES.map((p, i) => (
                <li key={p.id}>
                  <button type="button" className={i === picIndex ? 'is-active' : ''} aria-current={i === picIndex ? 'true' : undefined} onClick={() => setLightbox(i)}>
                    <img src={p.src} alt="" />
                    <span className="lnd-pic-title">{p.title}</span>
                    <span className="lnd-pic-caption">{p.caption}</span>
                  </button>
                </li>
              ))}
            </ul>
          </GlassSurface>
        </aside>
      </div>
      <Lightbox index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} />
    </section>
  )
}
