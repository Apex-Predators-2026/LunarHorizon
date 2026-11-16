import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

// One id per build (the commit on GitHub Actions), baked into the app and written to version.json, so an open
// page can tell when a newer build has been published (src/freshBuild.ts).
const BUILD_ID = process.env.GITHUB_SHA || String(Date.now())
const buildVersion = (): Plugin => ({
  name: 'build-version',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: BUILD_ID }) })
  },
})

export default defineConfig({
  // '/' for the dev server, Vercel and a custom domain; the GitHub Pages workflow sets VITE_BASE=/LunarHorizon/
  // because a project site is served from that subfolder.
  base: process.env.VITE_BASE || '/',
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), tailwindcss(), buildVersion()],
  server: {
    // Forward /api calls to the FastAPI backend during development.
    proxy: { '/api': 'http://localhost:8000' },
  },
})
