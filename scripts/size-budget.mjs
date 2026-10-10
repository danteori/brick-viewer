// Lite size budget (ARCHITECTURE.md section 2): dist-lite/brick-viewer.html must stay <= 450 KB (raised
// from 300 KB when the fixed-mesh bricks came in, 2026-10-10),
// and full-only libraries must stay out of it (sql.js is loaded lazily by the full build only).
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const FILE = 'dist-lite/brick-viewer.html';
const BUDGET = 450 * 1024;
const FULL_ONLY = [['sql.js', /initSqlJs|sqlite3_open/]];
const bytes = statSync(FILE).size;
const html = readFileSync(FILE);
const gz = gzipSync(html).length;
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`${FILE}: ${kb(bytes)} (gzip ${kb(gz)}), budget ${kb(BUDGET)}`);
let fail = false;
if (bytes > BUDGET) {
  console.error(`over budget by ${kb(bytes - BUDGET)}`);
  fail = true;
}
const text = html.toString('latin1');
for (const [name, re] of FULL_ONLY) {
  if (re.test(text)) {
    console.error(`${name} is in the lite build; load it through an IS_LITE-gated export in src/app/features.ts`);
    fail = true;
  }
}
if (fail) process.exit(1);
