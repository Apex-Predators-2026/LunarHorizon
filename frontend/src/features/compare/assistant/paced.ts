// Word-by-word reveal of an answer: the first N words of the text, cut so partial Markdown never shows stray
// markers (an unfinished **bold** run or an unfinished [[go:...]] link).

const WORD = /\S+/g

export function countWords(text: string): number {
  return (text.match(WORD) ?? []).length
}

/** The text up to and including its n-th word (all of it once n reaches the end). */
export function firstWords(text: string, n: number): string {
  if (n <= 0) return ''
  let end = 0
  let seen = 0
  for (const m of text.matchAll(WORD)) {
    seen++
    end = (m.index ?? 0) + m[0].length
    if (seen >= n) break
  }
  if (seen < n || end >= text.trimEnd().length) return text // everything is revealed
  let out = text.slice(0, end)
  // A [[go:...]] link that has not finished is held back until its last word arrives.
  const open = out.lastIndexOf('[[')
  if (open > out.lastIndexOf(']]')) out = out.slice(0, open).trimEnd()
  // An unfinished **bold** run is closed so no raw markers show.
  if ((out.match(/\*\*/g) ?? []).length % 2 === 1) out += '**'
  return out
}
