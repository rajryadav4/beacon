import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the FastAPI app (uvicorn on port 8000).
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'maplibre', test: /maplibre-gl/ }] } },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:8000' },
  },
  // `vite preview` serves the production build (and proxies /api) for quick sharing
  // through a Cloudflare quick tunnel; only *.trycloudflare.com hosts are allowed.
  preview: {
    port: 4173,
    strictPort: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:8000' },
  },
});
