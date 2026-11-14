// Class-string helpers shared by primitives and by elements that cannot use them (links, labels).

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON: Record<ButtonVariant, string> = {
  primary: 'border-accent bg-accent text-canvas hover:bg-accent-strong hover:border-accent-strong',
  secondary: 'border-line-strong bg-raised text-ink-2 hover:border-ink-4 hover:text-ink',
  ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-raised hover:text-ink',
  danger: 'border-line-strong bg-raised text-ink-2 hover:border-crit hover:text-crit',
}

/** Class string for button-like elements (links, labels) that cannot use <Button>. */
export const buttonClass = (variant: ButtonVariant = 'secondary', size: 'sm' | 'md' = 'sm') =>
  cx(
    'inline-flex items-center justify-center gap-1.5 rounded-control border font-medium transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-40',
    size === 'sm' ? 'h-7 px-2.5 text-label' : 'h-8 px-3 text-body',
    BUTTON[variant],
  )

/** Shared class for text inputs, number inputs, date inputs and selects. */
export const inputClass =
  'h-8 w-full rounded-control border border-line-strong bg-inset px-2 text-body text-ink nums ' +
  'placeholder:text-ink-4 hover:border-ink-4 focus:border-accent focus:outline-none disabled:opacity-50'

