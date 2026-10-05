import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  // libraw-wasm starts its worker with new URL('./worker.js', import.meta.url);
  // pre-bundling would move the module away from its worker and .wasm files.
  optimizeDeps: { exclude: ['libraw-wasm'] },
});
