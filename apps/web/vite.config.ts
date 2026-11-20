import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url));

// The dev server proxies /api to the FastAPI app (uvicorn on port 8000).
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
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:8000' },
  },
});
