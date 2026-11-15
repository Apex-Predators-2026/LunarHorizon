import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import './roverMascot.css'

// The sprite's columns are spaced differently in each row. These crops keep each row aligned.
const CROPS = {
  right: { x: [0, 164, 328], y: -2 },
  left: { x: [0, 169.3146, 336.3146], y: 182 },
} as const
const FRAME_WIDTH = 160
const FRAME_HEIGHT = 148
const BLINK = [0, 1, 2, 1, 0] as const
const TALK = [0, 1, 2, 1] as const
const between = (min: number, max: number) => min + Math.random() * (max - min)

export function RoverMascot({ facing = 'right', size = 160, animated = true, state = 'idle' }: {
  facing?: keyof typeof CROPS
  size?: number
  animated?: boolean
  state?: 'idle' | 'talking'
}) {
  const sprite = useRef<SVGSVGElement>(null)
  const [playing, setPlaying] = useState(false)
  const [frame, setFrame] = useState<0 | 1 | 2>(0)

  useEffect(() => {
    const element = sprite.current
    if (!animated || !element) return

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let inView = typeof IntersectionObserver === 'undefined'
    function update() {
      setPlaying(inView && !motion.matches && !document.hidden)
    }
    const observer = inView ? null : new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      update()
    })
    observer?.observe(element)
    motion.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    update()

    return () => {
      observer?.disconnect()
      motion.removeEventListener('change', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [animated])

  const canAnimate = animated && playing
  const talking = state === 'talking' && canAnimate
  useLayoutEffect(() => {
    if (!canAnimate) return
    setFrame(0)
    if (talking) {
      let step = 0
      const interval = setInterval(() => {
        step = (step + 1) % TALK.length
        setFrame(TALK[step])
      }, 125)
      return () => clearInterval(interval)
    }
    let timer: ReturnType<typeof setTimeout>

    function blink(step: number, canRepeat: boolean) {
      setFrame(BLINK[step])
      if (step < BLINK.length - 1) {
        timer = setTimeout(() => blink(step + 1, canRepeat), between(80, 120))
      } else if (canRepeat && Math.random() < 0.15) {
        timer = setTimeout(() => blink(1, false), between(180, 350))
      } else {
        timer = setTimeout(() => blink(1, true), between(3000, 9000))
      }
    }

    timer = setTimeout(() => blink(1, true), between(3000, 9000))
    return () => clearTimeout(timer)
  }, [canAnimate, talking])

  const crop = CROPS[facing]
  const x = crop.x[canAnimate ? frame : 0]
  return (
    <svg
      ref={sprite}
      className="rover-mascot"
      data-animating={canAnimate}
      width={size}
      height={size * FRAME_HEIGHT / FRAME_WIDTH}
      viewBox={`${x} ${crop.y} ${FRAME_WIDTH} ${FRAME_HEIGHT}`}
      aria-hidden="true"
    >
      <image href={`${import.meta.env.BASE_URL}rover-sprites.svg`} width="505" height="330" visibility={talking ? 'hidden' : 'visible'} />
      <image href={`${import.meta.env.BASE_URL}rover-talking.svg`} width="505" height="330" visibility={talking ? 'visible' : 'hidden'} />
    </svg>
  )
}
