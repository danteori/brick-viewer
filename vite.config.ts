import { defineConfig, type Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

/**
 * Dev server only: serves .local/palette.bp (git-ignored, never bundled) at __local/palette.bp, so
 * local development can use a private default palette. Builds never see this file.
 */
function localPalette(): Plugin {
  const file = resolve(import.meta.dirname, '.local/palette.bp');
  return {
    name: 'local-palette',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.split('?')[0]!.endsWith('/__local/palette.bp')) return next();
        if (!existsSync(file)) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(readFileSync(file));
      });
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
    plugins: lite ? [viteSingleFile(), renameLiteHtml(), localPalette()] : [localPalette()],
  };
});
