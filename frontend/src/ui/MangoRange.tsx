import type { CSSProperties, InputHTMLAttributes } from 'react'

/**
 * Range slider with a solid coral filled track. The native input keeps its behaviour (keyboard, pointer,
 * accessibility); the fill is placed under its transparent track and sized to the handle's position.
 */
export function MangoRange({ wrapperClassName, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { wrapperClassName?: string }) {
  const min = Number(rest.min ?? 0)
  const max = Number(rest.max ?? 100)
  const v = Number(rest.value ?? rest.defaultValue ?? min)
  const p = max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0
  return (
    <div className={`relative ${wrapperClassName ?? 'w-full'}`} style={{ '--p': p } as CSSProperties}>
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-[9px] h-4 overflow-hidden rounded-full"
        style={{ width: 'calc(17px + (100% - 34px) * var(--p))' }}
      >
        <span className="block h-full w-full bg-coral" />
      </div>
      <input type="range" {...rest} className={`mango-range relative ${className ?? ''}`} />
    </div>
  )
}
