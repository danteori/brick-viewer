// Builds the GitHub Pages tree (ARCHITECTURE.md section 8) from the two builds:
//   site/                       full app (dist/)
//   site/lite/brick-viewer.html lite build
//   site/legacy/save-viewer.html frozen legacy viewer
// Run after `npm run build`.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

for (const need of ['dist/index.html', 'dist-lite/brick-viewer.html', 'legacy/save-viewer.html']) {
  if (!existsSync(need)) { console.error(`missing ${need}; run npm run build first`); process.exit(1); }
}
rmSync('site', { recursive: true, force: true });
cpSync('dist', 'site', { recursive: true });
mkdirSync('site/lite', { recursive: true });
cpSync('dist-lite/brick-viewer.html', 'site/lite/brick-viewer.html');
mkdirSync('site/legacy', { recursive: true });
cpSync('legacy/save-viewer.html', 'site/legacy/save-viewer.html');
writeFileSync('site/.nojekyll', '');
console.log('site/ assembled');
