// Progressive-disclosure primitives shared by the Atlas, Scenario Comparison and Validation pages:
//   <Tabs> + <TabPanel>   a small number of views; every panel keeps its state once opened
//   <Disclosure>          a labelled, expandable block (aria-expanded) for evidence, tables and methodology
//   useReveal             lets a deep link / tour / assistant open a collapsed block before scrolling to it
// Collapsed content stays in the DOM (hidden), so it is never lost: it is revealed by the user, by a deep link,
// or by print (see compare.css). Motion is a short opacity/position transition, disabled for reduced motion.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { create } from 'zustand'

// ------------------------------------------------------------------ reveal requests

interface RevealState {
  /** Per-id counters: a Disclosure opens whenever its counter changes (a counter, so asking twice still works). */
  requests: Record<string, number>
  reveal: (id: string) => void
}

export const useReveal = create<RevealState>((set) => ({
  requests: {},
  reveal: (id) => set((s) => ({ requests: { ...s.requests, [id]: (s.requests[id] ?? 0) + 1 } })),
}))

// ------------------------------------------------------------------ tabs

export interface TabDef<T extends string> {
  id: T
  label: string
  /** Optional short hint shown as the tab's tooltip. */
  hint?: string
}

const tabId = (base: string, id: string) => `${base}-tab-${id}`
const panelId = (base: string, id: string) => `${base}-panel-${id}`

/** A WAI-ARIA tab list: arrow keys / Home / End move between tabs; the active tab carries the accent underline. */
export function Tabs<T extends string>({ base, label, tabs, value, onChange, trailing, className = '' }: {
  base: string
  label: string
  tabs: readonly TabDef<T>[]
  value: T
  onChange: (id: T) => void
  trailing?: ReactNode
  className?: string
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value)
    let next = -1
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    if (next < 0) return
    e.preventDefault()
    onChange(tabs[next].id)
    refs.current.get(tabs[next].id)?.focus()
  }
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div role="tablist" aria-label={label} className="cmp-tabs" onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={tabId(base, t.id)} title={t.hint} data-no-ripple
            ref={(el) => {
              if (el) refs.current.set(t.id, el)
              else refs.current.delete(t.id)
            }}
            aria-selected={t.id === value} aria-controls={panelId(base, t.id)} tabIndex={t.id === value ? 0 : -1}
            className="cmp-tab" onClick={() => onChange(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {trailing}
    </div>
  )
}

/**
 * One tab's content. It is mounted when first opened (so charts never measure a hidden zero-width box before
 * the user has looked) and then kept mounted, so scenario selection, cursor and chart state survive switching.
 */
export function TabPanel<T extends string>({ base, id, value, children }: { base: string; id: T; value: T; children: ReactNode }) {
  const active = id === value
  const [seen, setSeen] = useState(active)
  if (active && !seen) setSeen(true) // set during render: committed before the first paint of this panel
  return (
    <div role="tabpanel" id={panelId(base, id)} aria-labelledby={tabId(base, id)} hidden={!active} data-collapsible="tab"
      className="cmp-reveal">
      {seen && children}
    </div>
  )
}

// ------------------------------------------------------------------ disclosure

function Chevron() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true" className="cmp-chevron shrink-0">
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

/**
 * A labelled block the user opens on purpose. `summary` is always visible next to the title, so the closed state
 * still says what is inside. `card` draws it as a page section (the same surface as <Section>); otherwise it is an
 * inline row. `id` makes it a deep-link target that `useReveal.reveal(id)` opens. `lazy` defers mounting the content
 * (heavy charts) until the first open; after that it stays mounted.
 */
export function Disclosure({ id, title, summary, defaultOpen = false, card = false, lazy = false, level = 3, onOpenChange, children, className = '' }: {
  id?: string
  title: ReactNode
  summary?: ReactNode
  defaultOpen?: boolean
  card?: boolean
  lazy?: boolean
  level?: 2 | 3 | 4
  onOpenChange?: (open: boolean) => void
  children: ReactNode
  className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [seen, setSeen] = useState(defaultOpen)
  const request = useReveal((s) => (id ? s.requests[id] : undefined))
  // A request made before this block mounted (its view was not open yet) still opens it on mount.
  const handled = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (request !== undefined && request !== handled.current) {
      handled.current = request
      setOpen(true)
      setSeen(true)
    }
  }, [request])
  const set = (v: boolean) => {
    setOpen(v)
    if (v) setSeen(true)
    onOpenChange?.(v)
  }
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4'
  const body = id ? `${id}-body` : undefined
  return (
    <section id={id} className={`cmp-disclosure scroll-mt-16 ${card ? 'cmp-section' : ''} ${className}`} data-open={open}>
      <Heading className="m-0">
        <button type="button" className="cmp-disc-btn" aria-expanded={open} aria-controls={body} data-no-ripple onClick={() => set(!open)}>
          <Chevron />
          <span className={`font-medium text-ink ${card ? 'text-lg' : 'text-sm'}`}>{title}</span>
          {summary && <span className="min-w-0 truncate text-xs font-normal text-ink-3">{summary}</span>}
        </button>
      </Heading>
      <div id={body} hidden={!open} data-collapsible="disclosure" className="cmp-reveal pt-3">
        {(!lazy || seen) && children}
      </div>
    </section>
  )
}
