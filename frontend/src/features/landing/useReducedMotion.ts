import { useEffect, useState } from 'react'

export function usePrefersReducedMotion() {
  const q = '(prefers-reduced-motion: reduce)'
  const [reduce, setReduce] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const on = () => setReduce(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduce
}
