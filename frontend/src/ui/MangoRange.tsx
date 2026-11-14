import type { CSSProperties, InputHTMLAttributes } from 'react'
import { InteractiveGrainGradient } from './InteractiveGrainGradient'

/**
 * Range slider whose filled track is the live mango mesh. The native input keeps its behaviour (keyboard,
 * pointer, accessibility); a gradient is placed under its transparent track and sized to the fill. Dragging
 * the handle sweeps the pointer across the gradient, so the colours stream with the motion.
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
        <InteractiveGrainGradient fill strength={1.6} patternScale={0.45} />
      </div>
      <input type="range" {...rest} className={`mango-range relative ${className ?? ''}`} />
    </div>
  )
}
