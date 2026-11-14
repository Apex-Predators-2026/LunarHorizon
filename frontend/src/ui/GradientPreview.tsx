import { InteractiveGrainGradient } from './InteractiveGrainGradient'

/** Preview of the mango mesh on its own: open the app with #mango at the end of the address. */
export function GradientPreview() {
  return (
    <div className="flex h-full flex-col gap-6 bg-black p-8 text-white" style={{ fontFamily: 'var(--font-inter)' }}>
      <h1 className="font-display text-4xl font-bold tracking-[-0.06em]">Mango mesh</h1>
      <InteractiveGrainGradient className="min-h-0 flex-1 rounded-[32px]" />
      <div className="flex items-center gap-6">
        <InteractiveGrainGradient className="h-24 w-24 rounded-[20px]" />
        <InteractiveGrainGradient className="h-6 w-80 rounded-full" />
        <p className="text-sm text-white/70">Move the pointer across it. It drifts slowly by itself, and holds still with reduced motion.</p>
      </div>
    </div>
  )
}
