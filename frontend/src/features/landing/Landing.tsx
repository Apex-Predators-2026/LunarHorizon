// Landing page for the whole project: the first screen of the app (route "/"), with "Open the navigator"
// leading into the Mission Planner (#app). The page opens on a photograph of the Moon, followed by the app pictures,
// the NASA data credits and a close. Same tokens as the app (Opaline / charcoal / coral, Inter, Helvetica display), the
// team's frosted GlassSurface, and M3 easing for every move.
import { useEffect, useRef, useState } from 'react'

import { goToView } from '../../appRoute'
import { GlassDefs, GlassSurface } from '../../ui/GlassSurface'
import { InteractiveGrainGradient } from '../../ui/InteractiveGrainGradient'
import { LunarHorizonLogo } from '../../ui/LunarHorizonLogo'
import { RoverMascot } from '../../ui/RoverMascot'
import { ChevronRightIcon, ExternalIcon } from '../../ui/icons'
import { useAssistant } from '../compare/assistant/useAssistant'
import { LiveNow } from './LiveNow'
import { DATA_SOURCES, HERO, PICTURES, REPO_URL } from './content'
import './landing.css'

const toBeat = (id: string) => (e: React.MouseEvent) => {
  e.preventDefault()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' })
}

function OpenNavigatorButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="lnd-btn lnd-btn-filled" onClick={onOpen}>
      <InteractiveGrainGradient className="lnd-btn-mesh" fill />
      <span className="lnd-btn-label">Open the navigator</span>
    </button>
  )
}

function Nav({ onOpen }: { onOpen: () => void }) {
  const [scrolled, setScrolled] = useState(false)
  const [tone, setTone] = useState<'dark' | 'light'>('dark')
  useEffect(() => {
    const on = () => {
      setScrolled(window.scrollY > 24)
      // Light glass while the bar sits over a light section.
      const under = document.elementsFromPoint(window.innerWidth / 2, 72).find((el) => el.closest('.lnd-light, .lnd-hero-photo, .lnd-preview, .lnd-close'))
      setTone(under?.closest('.lnd-light') ? 'light' : 'dark')
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  return (
    <header className="lnd-nav" data-tone={tone}>
      <GlassSurface radius="0px" interactive={false} enabled={scrolled} className="lnd-nav-bar lnd-glass-dark">
        <a className="lnd-wordmark" href="#" onClick={toBeat('top')}>
          <LunarHorizonLogo variant="wordmark" />
        </a>
        <nav aria-label="Mission" className="lnd-nav-links">
          <a href="#preview" onClick={toBeat('preview')}>The app</a>
          <a href="#data" onClick={toBeat('data')}>NASA data</a>
        </nav>
        <button type="button" className="lnd-btn lnd-btn-nav" onClick={onOpen}>
          Open the navigator
        </button>
      </GlassSurface>
    </header>
  )
}

function FeatureCarousel() {
  const track = useRef<HTMLUListElement>(null)
  const [active, setActive] = useState(0)
  const last = PICTURES.length - 1

  function goTo(index: number) {
    const list = track.current
    const slide = list?.children.item(Math.max(0, Math.min(last, index)))
    if (!(slide instanceof HTMLElement) || !list) return
    list.scrollTo({ left: slide.offsetLeft })
  }

  function syncActive(list: HTMLUListElement) {
    let nearest = 0
    let distance = Infinity
    Array.from(list.children).forEach((slide, index) => {
      const offset = Math.abs((slide as HTMLElement).offsetLeft - list.scrollLeft)
      if (offset < distance) {
        nearest = index
        distance = offset
      }
    })
    setActive(nearest)
  }

  return (
    <section id="preview" className="lnd-preview" aria-labelledby="preview-h" aria-roledescription="carousel">
      <div className="lnd-wrap">
        <div className="lnd-preview-header">
          <h2 id="preview-h">Inside the navigator</h2>
          <div className="lnd-preview-controls">
            <button type="button" aria-label="Previous feature" aria-controls="feature-slides" disabled={active === 0} onClick={() => goTo(active - 1)}>
              <ChevronRightIcon size={22} />
            </button>
            <button type="button" aria-label="Next feature" aria-controls="feature-slides" disabled={active === last} onClick={() => goTo(active + 1)}>
              <ChevronRightIcon size={22} />
            </button>
          </div>
        </div>
        <ul
          id="feature-slides"
          ref={track}
          className="lnd-preview-track"
          role="list"
          aria-label="App features"
          tabIndex={0}
          onScroll={(event) => syncActive(event.currentTarget)}
          onKeyDown={(event) => {
            const target = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: last }[event.key]
            if (target === undefined) return
            event.preventDefault()
            goTo(target)
          }}
        >
          {PICTURES.map((picture) => (
            <li key={picture.id}>
              <figure>
                <img src={picture.src} alt={picture.alt} loading="lazy" />
                <figcaption>
                  <h3>{picture.title}</h3>
                  <p>{picture.caption}</p>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function MeetRover() {
  const stage = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    if (!stage.current) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting))
    observer.observe(stage.current)
    return () => observer.disconnect()
  }, [])

  function openAssistant() {
    useAssistant.getState().setOpen(true)
    goToView('compare')
    window.scrollTo(0, 0)
  }

  return (
    <section className="lnd-section lnd-light lnd-rover" aria-labelledby="rover-h">
      <div className="lnd-wrap lnd-rover-grid">
        <div className="lnd-rover-stage" ref={stage}>
          <div className="lnd-rover-pop" data-visible={inView}>
            <RoverMascot facing="right" size={312} />
          </div>
        </div>
        <div className="lnd-rover-copy">
          <h2 id="rover-h">Meet Rover</h2>
          <p className="lnd-rover-lead"><strong>Your AI-powered mission companion.</strong></p>
          <p>Rover helps you make sense of your mission data. From summarizing key events to highlighting important insights, Rover turns complex mission information into clear, useful answers. Have a question? Just ask Rover.</p>
          <button type="button" className="lnd-btn lnd-rover-link" onClick={openAssistant}>
            Meet your assistant <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </section>
  )
}

function Data() {
  return (
    <section id="data" className="lnd-section lnd-light lnd-data" aria-labelledby="data-h">
      <div className="lnd-wrap lnd-data-grid">
        <div data-reveal>
          <h2 id="data-h">Built on NASA data</h2>
          <p>
            The scientific engine turns raw ephemerides and elevation models into hourly sunlight, Earth visibility and
            horizon masks for each site, stored with the app so it works offline.
          </p>
        </div>
        <ul className="lnd-sources">
          {DATA_SOURCES.map((s, i) => (
            <li key={s.name} data-reveal style={{ '--i': i } as React.CSSProperties}>
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                <span className="lnd-source-name">
                  {s.name} <ExternalIcon size={14} />
                </span>
                <span className="lnd-source-use">{s.use}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function Close({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="lnd-close" aria-labelledby="close-h">
      <div className="lnd-wrap">
        <div className="lnd-close-cta" data-reveal>
          <h2 id="close-h">Plan a landing that survives the night</h2>
          <OpenNavigatorButton onOpen={onOpen} />
        </div>
        <p className="lnd-close-credit">
          Image source{' '}
          <a href="https://www.nasa.gov/reference/artemis-i-mission-timeline/" target="_blank" rel="noopener noreferrer">
            NASA’s Artemis I Mission Timeline
          </a>
        </p>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="lnd-footer">
      <div className="lnd-wrap">
        <LunarHorizonLogo variant="wordmark" className="lnd-footer-logo" />
        <div className="lnd-close-meta">
          <span>Built by Team B.A.J.A.N for NASA Space Apps Challenge 2026</span>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Source on GitHub <ExternalIcon size={14} />
          </a>
          <span>Data: NASA JPL Horizons, NASA Moon Trek LOLA, NASA LROC</span>
        </div>
      </div>
    </footer>
  )
}

/** The opening picture: the Moon with Earth rising behind it, with the project's headline over it. */
function Hero({ onOpen }: { onOpen: () => void }) {
  // The Moon settles into place once its pixels exist, so the move never plays over an empty frame.
  const moon = useRef<HTMLImageElement>(null)
  const [moonReady, setMoonReady] = useState(false)
  useEffect(() => {
    if (moon.current?.complete) setMoonReady(true)
  }, [])
  return (
    <section className="lnd-hero-photo" aria-labelledby="lnd-title">
      <img
        className={moonReady ? 'lnd-hero-moon is-ready' : 'lnd-hero-moon'}
        ref={moon}
        src="/landing/moon.jpg"
        alt="A crescent Moon, its craters lit along the terminator, with a small crescent Earth rising behind its edge."
        fetchPriority="high"
        onLoad={() => setMoonReady(true)}
      />
      <div className="lnd-scrim" aria-hidden="true" />
      <div className="lnd-hero-photo-copy">
        <div className="lnd-hero-copy">
          <LunarHorizonLogo className="lnd-hero-logo" />
          <h1 id="lnd-title">
            {HERO.headlineLines.map((line) => (
              <span key={line} className="lnd-line">
                <span>{line}</span>
              </span>
            ))}
          </h1>
          <p className="lnd-hero-lead">{HERO.lead}</p>
          <div className="lnd-hero-actions">
            <OpenNavigatorButton onOpen={onOpen} />
          </div>
          <div className="lnd-live-inline">
            <LiveNow idPrefix="lnd-live-inline" />
          </div>
        </div>
      </div>
      <div className="lnd-hero-credits">
        <p>Built by Team B.A.J.A.N for NASA Space Apps 2026</p>
        <p>
          Image: <a href="https://science.nasa.gov/moon/" target="_blank" rel="noopener noreferrer">NASA</a>
        </p>
      </div>
    </section>
  )
}

export default function Landing({ onOpen }: { onOpen: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  return (
    <div ref={root} id="top" className="lnd md-host">
      <GlassDefs />
      <Nav onOpen={onOpen} />
      <main>
        <Hero onOpen={onOpen} />
        <FeatureCarousel />
        <MeetRover />
        <Data />
        <Close onOpen={onOpen} />
      </main>
      <Footer />
    </div>
  )
}
