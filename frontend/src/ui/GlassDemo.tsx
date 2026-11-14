import { GlassSurface, GlassToolbar } from './GlassSurface'
import { InteractiveGrainGradient } from './InteractiveGrainGradient'

const ICONS = {
  play: 'M8 5v14l11-7z',
  layers: 'M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z',
  pin: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z',
  check: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
}

/** Standalone look at the glass over the animated gradient: open the app with #glass at the end of the address. */
export function GlassDemo() {
  return (
    <div className="relative h-full overflow-hidden" style={{ fontFamily: 'var(--font-inter)' }}>
      <InteractiveGrainGradient fill patternScale={0.6} />
      <div className="relative flex h-full flex-col items-center justify-center gap-10 p-8 text-calcite-ink">
        <GlassToolbar role="toolbar" aria-label="Demo toolbar" className="gap-1 p-2">
          {Object.entries(ICONS).map(([name, d]) => (
            <button key={name} type="button" aria-label={name} className="flex h-12 w-12 items-center justify-center rounded-full">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d={d} />
              </svg>
            </button>
          ))}
        </GlassToolbar>
        <GlassToolbar className="gap-8 px-8 py-3">
          <span className="font-display text-3xl font-bold tracking-[-0.06em]">Site Navigator</span>
          <span className="text-xl font-bold tracking-[-0.06em] underline">Mission Planner</span>
          <span className="text-xl font-bold tracking-[-0.06em]">Scenario Comparison</span>
        </GlassToolbar>
        <GlassSurface className="max-w-md p-6">
          <h2 className="text-xl font-semibold">Glass surface</h2>
          <p className="mt-2 text-sm">Frosted, lightly translucent, with a soft light that follows the cursor while the surface stays still.</p>
        </GlassSurface>
      </div>
    </div>
  )
}
