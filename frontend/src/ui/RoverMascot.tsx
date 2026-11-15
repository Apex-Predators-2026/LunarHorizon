import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import './roverMascot.css'

// The sprite's columns are spaced differently in each row. These crops keep each row aligned.
const CROPS = {
  right: { x: [0, 164, 328], y: -2 },
  left: { x: [0, 169.3146, 336.3146], y: 182 },
} as const
const FRAME_WIDTH = 160
const FRAME_HEIGHT = 148
// Extra room above the sprite so his head isn't cropped when he squashes / stretches (the layout size is unchanged).
const HEADROOM = 22
const BLINK = [0, 1, 2, 1, 0] as const
const TALK = [0, 1, 2, 1] as const
// Open eyes in frame 0 of each row (sheet coordinates). They are baked into the sprite, so Rover covers them with the
// face colour and draws the same eyes again, nudged toward the cursor.
const EYES = {
  right: [{ cx: 54.17, cy: 35.2714, r: 4.5 }, { cx: 61.67, cy: 34.7714, r: 4 }],
  left: [{ cx: 58.5701, cy: 218.271, r: 4.5 }, { cx: 51.0701, cy: 217.771, r: 4 }],
} as const
const FACE = '#E4DDC4'
const EYE = '#56473C'
const LOOK_X = 2.4 // furthest the eyes drift (sprite units)
const LOOK_Y = 1.6
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
  const eyes = useRef<SVGGElement>(null)
  const body = useRef<SVGGElement>(null)

  // Clicking Rover makes him squash and spring in place (a few quick boings).
  const boing = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    body.current?.animate(
      [
        { transform: 'scale(1, 1)' },
        { transform: 'scale(1.14, 0.8)', offset: 0.18 },
        { transform: 'scale(0.9, 1.14)', offset: 0.4 },
        { transform: 'scale(1.07, 0.92)', offset: 0.62 },
        { transform: 'scale(0.97, 1.04)', offset: 0.82 },
        { transform: 'scale(1, 1)' },
      ],
      { duration: 520, easing: 'ease-out' },
    )
  }

  // Eyes drift slightly toward the cursor, easing so they never snap.
  useEffect(() => {
    const group = eyes.current
    if (!canAnimate || !group) return
    let tx = 0
    let ty = 0
    let cx = 0
    let cy = 0
    let raf = 0
    const tick = () => {
      cx += (tx - cx) * 0.18
      cy += (ty - cy) * 0.18
      group.setAttribute('transform', `translate(${cx.toFixed(2)} ${cy.toFixed(2)})`)
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.02 ? requestAnimationFrame(tick) : 0
    }
    // Pointer events only record the position; the layout read and the maths happen once per frame.
    let px = 0
    let py = 0
    let queued = 0
    const aim = () => {
      queued = 0
      const r = sprite.current?.getBoundingClientRect()
      if (!r) return
      const dx = px - (r.left + r.width / 2)
      const dy = py - (r.top + r.height * 0.3)
      const d = Math.hypot(dx, dy) || 1
      const k = Math.min(1, d / 160)
      tx = (dx / d) * k * LOOK_X
      ty = (dy / d) * k * LOOK_Y
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const onMove = (e: PointerEvent) => {
      px = e.clientX
      py = e.clientY
      if (!queued) queued = requestAnimationFrame(aim)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(queued)
    }
  }, [canAnimate])
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
      height={size * (FRAME_HEIGHT + HEADROOM) / FRAME_WIDTH}
      style={{ marginTop: -(size * HEADROOM) / FRAME_WIDTH }}
      viewBox={`${x} ${crop.y - HEADROOM} ${FRAME_WIDTH} ${FRAME_HEIGHT + HEADROOM}`}
      aria-hidden="true"
      onPointerDown={boing}
    >
      <g ref={body} style={{ transformBox: 'view-box', transformOrigin: '50% 100%' }}>
      <image href={`${import.meta.env.BASE_URL}rover-sprites.svg`} width="505" height="330" visibility={talking ? 'hidden' : 'visible'} />
      <image href={`${import.meta.env.BASE_URL}rover-talking.svg`} width="505" height="330" visibility={talking ? 'visible' : 'hidden'} />
      {canAnimate && (
        <g visibility={frame === 0 ? 'visible' : 'hidden'}>
          {EYES[facing].map((e, i) => <circle key={`c${i}`} cx={e.cx} cy={e.cy} r={e.r + 0.9} fill={FACE} />)}
          <g ref={eyes}>
            {EYES[facing].map((e, i) => <circle key={`e${i}`} cx={e.cx} cy={e.cy} r={e.r} fill={EYE} />)}
          </g>
        </g>
      )}
      </g>
    </svg>
  )
}
