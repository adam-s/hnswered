import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    svelte(),
    {
      name: 'hnswered-bundle',
      closeBundle() {
        cpSync(resolve(__dirname, 'manifest.json'), resolve(__dirname, 'dist/manifest.json'));
        cpSync(resolve(__dirname, 'icons'), resolve(__dirname, 'dist/icons'), { recursive: true });
        // Vite emits sidepanel html under src/sidepanel/sidepanel.html; flatten it.
        const nested = resolve(__dirname, 'dist/src/sidepanel/sidepanel.html');
        const flat = resolve(__dirname, 'dist/sidepanel.html');
        if (existsSync(nested)) renameSync(nested, flat);
        const staleSrc = resolve(__dirname, 'dist/src');
        if (existsSync(staleSrc)) rmSync(staleSrc, { recursive: true, force: true });
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        sidepanel: resolve(__dirname, 'src/sidepanel/sidepanel.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        format: 'es',
      },
      preserveEntrySignatures: 'strict',
    },
    target: 'esnext',
    minify: false,
  },
});
