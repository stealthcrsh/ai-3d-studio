import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative paths, so the built site works from any folder or static host with no server code.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  server: { port: 5183 },
  preview: { port: 5184 },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2500 },
});
