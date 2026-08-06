import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  build: {
    assetsDir: 'assets',
    emptyOutDir: true,
    outDir: '../dist/ui-assets',
    sourcemap: false,
    target: 'es2022',
  },
});
