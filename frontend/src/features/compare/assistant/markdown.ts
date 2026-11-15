import { isNavTarget, type NavTarget } from './navigation'

// The light Markdown the assistant is asked to use, parsed into blocks (no HTML, no external parser).
export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (const raw of src.replace(/\r/g, '').split('\n')) {
    const line = raw.trim()
    const item = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line)
    const head = /^#{1,6}\s+(.*)$/.exec(line)
    if (!line) {
      flush()
    } else if (head) {
      flush()
      blocks.push({ kind: 'h', text: head[1].replace(/\*\*/g, '') })
    } else if (item) {
      flush()
      const kind = /^\d/.test(line) ? 'ol' : 'ul'
      const last = blocks[blocks.length - 1]
      if (last && last.kind === kind) last.items.push(item[1])
      else blocks.push({ kind, items: [item[1]] })
    } else {
      para.push(line)
    }
  }
  flush()
  return blocks
}

export type InlinePart = { kind: 'text'; text: string } | { kind: 'bold'; text: string } | { kind: 'nav'; target: NavTarget }

/**
 * Inline pieces: bold runs, "Go to" links ([[go:section]], only to places that exist; others are dropped), and text.
 * Markdown links become their text; inline code becomes plain text.
 */
export function inlineParts(text: string): InlinePart[] {
  const clean = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]+)`/g, '$1')
  const out: InlinePart[] = []
  for (const piece of clean.split(/(\[\[go:[a-z-]+\]\])/g)) {
    if (!piece) continue
    const nav = /^\[\[go:([a-z-]+)\]\]$/.exec(piece)
    if (nav) {
      if (isNavTarget(nav[1])) out.push({ kind: 'nav', target: nav[1] })
      continue
    }
    for (const part of piece.split(/(\*\*[^*]+\*\*)/g)) {
      if (!part) continue
      if (part.startsWith('**') && part.endsWith('**') && part.length > 4) out.push({ kind: 'bold', text: part.slice(2, -2) })
      else out.push({ kind: 'text', text: part })
    }
  }
  return out
}
