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

/** Inline pieces: bold runs, everything else as text. Links become their text; inline code becomes plain text. */
export function inlineParts(text: string): { bold: boolean; text: string }[] {
  const clean = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]+)`/g, '$1')
  return clean.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4 ? { bold: true, text: part.slice(2, -2) } : { bold: false, text: part })
}
