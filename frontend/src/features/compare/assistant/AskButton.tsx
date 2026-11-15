// A small "ask the Mission Assistant" button for comparison panels. It only asks a question: the assistant cannot
// change anything on the page. `iconOnly` is for table rows, where a labelled button would crowd the data: with a
// mouse it appears on row hover or keyboard focus (put `group` on the row); on touch screens it is always shown.
import { Icon } from '../ui'
import { useAssistant } from './useAssistant'

export function AskButton({ question, label = 'Ask the assistant', iconOnly = false, className = '' }: {
  question: string
  label?: string
  iconOnly?: boolean
  className?: string
}) {
  const askFromPage = useAssistant((s) => s.askFromPage)
  if (iconOnly) {
    return (
      <button type="button" onClick={() => askFromPage(question)} aria-label={`Ask the Mission Assistant: ${question}`}
        data-tip={`Ask the assistant: “${question}”`}
        className={`inline-grid h-5 w-5 place-items-center rounded text-ink-4 hover:bg-inset hover:text-ink focus-visible:text-ink [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus-visible:opacity-100 ${className}`}>
        <Icon name="chat" size={12} />
      </button>
    )
  }
  return (
    <button type="button" onClick={() => askFromPage(question)} data-tip={`Ask the Mission Assistant: “${question}”`}
      className={`inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-2 hover:border-ink-3 hover:text-ink ${className}`}>
      <Icon name="chat" size={13} /> {label}
    </button>
  )
}
