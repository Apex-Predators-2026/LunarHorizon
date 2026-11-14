// Landing page for the whole project: the first screen of the app (route "/"), with "Open the navigator"
// leading into the Mission Planner (#app). The page is one scroll film (ScrollFilm) followed by the NASA data
// credits and a close. Same tokens as the app (Opaline / charcoal / coral, Inter, Helvetica display), the
// team's frosted GlassSurface, and M3 easing for every move.
import { useEffect, useRef, useState } from 'react'

import { GlassDefs, GlassSurface } from '../../ui/GlassSurface'
import { ExternalIcon } from '../../ui/icons'
import { BEATS, DATA_SOURCES, NAV_BEATS, PICTURES, REPO_URL } from './content'
import './landing.css'
import { ScrollFilm } from './ScrollFilm'

const toBeat = (id: string) => (e: React.MouseEvent) => {
  e.preventDefault()
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  document.getElementById(id)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' })
}

function Nav({ onOpen, active }: { onOpen: () => void; active: number }) {
  const [scrolled, setScrolled] = useState(false)
  const [tone, setTone] = useState<'dark' | 'light'>('dark')
  useEffect(() => {
    const on = () => {
      setScrolled(window.scrollY > 24)
      // Light glass while the bar sits over a light section, dark glass over the film.
      const under = document.elementsFromPoint(window.innerWidth / 2, 72).find((el) => el.closest('.lnd-light, .lnd-film, .lnd-close'))
      setTone(under?.closest('.lnd-light') ? 'light' : 'dark')
    }
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [])
  // The header link that covers the current beat: the last linked beat at or before it.
  const order = BEATS.map((b) => b.id)
  const current = [...NAV_BEATS].reverse().find((id) => order.indexOf(id) <= active)
  return (
    <header className="lnd-nav" data-tone={tone}>
      <GlassSurface radius="0px" interactive={false} enabled={scrolled} className="lnd-nav-bar lnd-glass-dark">
        <a className="lnd-wordmark" href="#" onClick={toBeat('top')}>
          Site Navigator
        </a>
        <nav aria-label="Mission" className="lnd-nav-links">
          {NAV_BEATS.map((id) => (
            <a key={id} href={`#beat-${id}`} aria-current={current === id ? 'step' : undefined} onClick={toBeat(`beat-${id}`)}>
              {BEATS[order.indexOf(id)].short}
            </a>
          ))}
          <a href="#inside" onClick={toBeat('inside')}>The app</a>
          <a href="#data" onClick={toBeat('data')}>NASA data</a>
        </nav>
        <button type="button" className="lnd-btn lnd-btn-filled lnd-btn-sm" onClick={onOpen}>
          Open the navigator
        </button>
      </GlassSurface>
    </header>
  )
}

/** The app's real screens, large, after the film. */
function Gallery() {
  return (
    <section id="inside" className="lnd-section lnd-light lnd-gallery" aria-labelledby="gallery-h">
      <div className="lnd-wrap">
        <div className="lnd-gallery-head" data-reveal>
          <h2 id="gallery-h">Inside the navigator</h2>
          <p>The real app, running on the same Horizons and LOLA data as the film above.</p>
        </div>
        <ul className="lnd-gallery-grid">
          {PICTURES.map((p, i) => (
            <li key={p.id} data-reveal style={{ '--i': i % 2 } as React.CSSProperties}>
              <figure>
                <img src={p.src} alt={`${p.title}: ${p.caption}`} />
                <figcaption>
                  <strong>{p.title}</strong>
                  <span>{p.caption}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
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
    <footer className="lnd-close" aria-labelledby="close-h">
      <div className="lnd-wrap">
        <div className="lnd-close-cta" data-reveal>
          <h2 id="close-h">Plan a landing that survives the night</h2>
          <button type="button" className="lnd-btn lnd-btn-filled" onClick={onOpen}>
            Open the navigator
          </button>
        </div>
        <p className="lnd-close-name" aria-hidden="true">Site Navigator</p>
        <div className="lnd-close-meta">
          <span>Team Apex Predators · NASA Space Apps Challenge 2026</span>
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Source on GitHub <ExternalIcon size={14} />
          </a>
          <span>Data: NASA JPL Horizons, NASA Moon Trek LOLA, NASA LROC</span>
        </div>
      </div>
    </footer>
  )
}

export default function Landing({ onOpen }: { onOpen: () => void }) {
  const root = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  return (
    <div ref={root} id="top" className="lnd md-host">
      <GlassDefs />
      <Nav onOpen={onOpen} active={active} />
      <main>
        <ScrollFilm onOpen={onOpen} onActive={setActive} />
        <Gallery />
        <Data />
      </main>
      <Close onOpen={onOpen} />
    </div>
  )
}
