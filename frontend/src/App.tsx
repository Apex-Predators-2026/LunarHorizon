import { Scene } from './viz/Scene'

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-800 px-4 py-3 font-semibold">
        Lunar Landing Site Navigator
      </header>
      <main className="flex min-h-0 flex-1">
        {/* Mission configuration panel (Nimansh) */}
        <aside className="w-72 border-r border-slate-800 p-4" />
        <div className="relative flex-1">
          <Scene />
        </div>
      </main>
    </div>
  )
}
