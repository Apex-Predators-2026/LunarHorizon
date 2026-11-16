import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // '/' for the dev server, Vercel and a custom domain; the GitHub Pages workflow sets VITE_BASE=/LunarHorizon/
  // because a project site is served from that subfolder.
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    // Forward /api calls to the FastAPI backend during development.
    proxy: { '/api': 'http://localhost:8000' },
  },
})
