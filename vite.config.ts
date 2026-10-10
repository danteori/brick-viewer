import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two builds from one codebase (docs: ARCHITECTURE.md section 2):
//   vite build --mode full  -> dist/       index.html + hashed assets (hosted at /)
//   vite build --mode lite  -> dist-lite/  brick-viewer.html, everything inlined (hosted at /lite/)
// __LITE__ is a compile-time constant; only src/app/features.ts may read it (ESLint enforces this).

/** Renames the lite entry from lite.html to brick-viewer.html in the output. */
function renameLiteHtml(): Plugin {
  return {
    name: 'rename-lite-html',
    enforce: 'post',
    generateBundle(_, bundle) {
      const html = bundle['lite.html'];
      if (html) html.fileName = 'brick-viewer.html';
    },
  };
}

export default defineConfig(({ mode }) => {
  const lite = mode === 'lite';
  return {
    base: './',
    define: { __LITE__: JSON.stringify(lite) },
    server: { port: 5173, strictPort: true },
    build: lite
      ? {
          outDir: 'dist-lite',
          emptyOutDir: true,
          rollupOptions: { input: 'lite.html' },
        }
      : {
          outDir: 'dist',
          emptyOutDir: true,
          rollupOptions: { input: 'index.html' },
        },
    plugins: lite ? [viteSingleFile(), renameLiteHtml()] : [],
  };
});
