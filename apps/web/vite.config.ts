import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// The dev server proxies /api to the FastAPI app (uvicorn on port 8000). /openapi.json tells the UI which
// optional endpoints exist (the hazard outlook), so it never calls a missing one.
const api = process.env.API_URL ?? 'http://localhost:8000';
const proxy = { '/api': api, '/openapi.json': api };

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    rolldownOptions: {
      // Two pages: the app and the Beacon Simulator demo (served at /simulator).
      input: { main: page('index.html'), simulator: page('simulator.html') },
      output: { codeSplitting: { groups: [{ name: 'maplibre', test: /maplibre-gl/ }] } },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy,
  },
  // `vite preview` serves the production build (and proxies /api) for quick sharing
  // through a Cloudflare quick tunnel; only *.trycloudflare.com hosts are allowed.
  preview: {
    port: 4173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy,
  },
});
