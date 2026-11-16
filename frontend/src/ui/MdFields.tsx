// M3 outlined fields for the Mission Planner's sidebar (see .md-field in index.css).
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

const cls = (...p: (string | false | undefined)[]) => p.filter(Boolean).join(' ')

type Common = { label: string; tip?: string; fieldClassName?: string }

/** Outlined text / number field with a floating label. `tip` is shown as a tooltip. */
export function TextField({ label, tip, fieldClassName, className, placeholder, ...rest }: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cls('md-field', fieldClassName)} data-tip={tip}>
      <input {...rest} placeholder={placeholder ?? ' '} className={cls('md-field-control', className)} />
      <span className="md-field-label">{label}</span>
    </label>
  )
}

/** Outlined select (the label is always floated, a chevron marks it as a menu). */
export function SelectField({
  label,
  tip,
  fieldClassName,
  className,
  children,
  ...rest
}: Common & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <label className={cls('md-field md-field-floated', fieldClassName)} data-tip={tip}>
      <select {...rest} className={cls('md-field-control md-field-select', className)}>
        {children}
      </select>
      <span className="md-field-label">{label}</span>
      <svg className="md-field-trailing md-chevron" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M7 10l5 5 5-5z" />
      </svg>
    </label>
  )
}

/** Outlined field that shows a date and opens a picker when pressed. */
export function DateField({
  label,
  tip,
  value,
  expanded,
  onOpen,
}: {
  label: string
  tip?: string
  value: string
  expanded: boolean
  onOpen: () => void
}) {
  return (
    <div className="md-field md-field-floated" data-tip={tip}>
      <button type="button" onClick={onOpen} aria-label={`${label}, ${value}`} aria-expanded={expanded} aria-haspopup="dialog" className="md-field-control">
        {value}
      </button>
      <span className="md-field-label">{label}</span>
      <svg className="md-field-trailing" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V10h14v10zM5 8V6h14v2H5z" />
      </svg>
    </div>
  )
}
