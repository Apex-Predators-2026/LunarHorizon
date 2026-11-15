// Renders the assistant's light Markdown as React elements. No HTML is ever injected: everything is text,
// escaped by React.
import { inlineParts, parseBlocks } from './markdown'

function Inline({ text }: { text: string }) {
  return <>{inlineParts(text).map((p, i) => (p.bold ? <strong key={i} className="font-medium text-ink">{p.text}</strong> : p.text))}</>
}

export function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {parseBlocks(text).map((b, i) => {
        if (b.kind === 'h') return <h4 key={i} className="pt-1 text-[13px] font-medium text-ink"><Inline text={b.text} /></h4>
        if (b.kind === 'p') return <p key={i}><Inline text={b.text} /></p>
        const items = b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)
        return b.kind === 'ul'
          ? <ul key={i} className="list-disc space-y-1 pl-4">{items}</ul>
          : <ol key={i} className="list-decimal space-y-1 pl-4">{items}</ol>
      })}
    </div>
  )
}
