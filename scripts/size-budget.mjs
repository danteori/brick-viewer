// Lite size budget (ARCHITECTURE.md section 2): dist-lite/brick-viewer.html must stay <= 300 KB.
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const FILE = 'dist-lite/brick-viewer.html';
const BUDGET = 300 * 1024;
const bytes = statSync(FILE).size;
const gz = gzipSync(readFileSync(FILE)).length;
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`${FILE}: ${kb(bytes)} (gzip ${kb(gz)}), budget ${kb(BUDGET)}`);
if (bytes > BUDGET) {
  console.error(`over budget by ${kb(bytes - BUDGET)}`);
  process.exit(1);
}
