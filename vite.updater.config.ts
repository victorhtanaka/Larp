import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(process.cwd(), 'src/updater'),
  build: {
    outDir: resolve(process.cwd(), '.vite/renderer/updater_window'),
    emptyOutDir: true,
  },
});
