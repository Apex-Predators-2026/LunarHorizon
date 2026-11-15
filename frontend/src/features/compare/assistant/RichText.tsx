// Renders the assistant's light Markdown as React elements. No HTML is ever injected: everything is text, escaped
// by React. "Go to" links ([[go:section]]) become buttons that only scroll the page or start the tour.
import { Icon } from '../ui'
import { inlineParts, parseBlocks } from './markdown'
import { ACTION_TARGETS, NAV_TARGETS, type NavTarget } from './navigation'

type OnNav = (target: NavTarget) => void

function Inline({ text, onNav }: { text: string; onNav?: OnNav }) {
  return (
    <>
      {inlineParts(text).map((p, i) => {
        if (p.kind === 'bold') return <strong key={i} className="font-medium text-ink">{p.text}</strong>
        if (p.kind === 'text') return p.text
        if (!onNav) return null
        const label = ACTION_TARGETS.has(p.target) ? NAV_TARGETS[p.target] : `Go to ${NAV_TARGETS[p.target]}`
        return (
          <button key={i} type="button" onClick={() => onNav(p.target)}
            className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 align-baseline text-[11px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink">
            <Icon name="send" size={11} /> {label}
          </button>
        )
      })}
    </>
  )
}

export function RichText({ text, onNav }: { text: string; onNav?: OnNav }) {
  return (
    <div className="space-y-2">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'h') return <h4 key={i} className="pt-1 text-[13px] font-medium text-ink"><Inline text={b.text} onNav={onNav} /></h4>
        if (b.kind === 'p') return <p key={i}><Inline text={b.text} onNav={onNav} /></p>
        const items = b.items.map((it, j) => <li key={j}><Inline text={it} onNav={onNav} /></li>)
        return b.kind === 'ul'
          ? <ul key={i} className="list-disc space-y-1 pl-4">{items}</ul>
          : <ol key={i} className="list-decimal space-y-1 pl-4">{items}</ol>
      })}
    </div>
  )
}
