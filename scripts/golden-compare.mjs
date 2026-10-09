// Compares a capture of the new app with the legacy goldens (ARCHITECTURE.md section 6, Phase 1 gate):
// a shot passes when at least 99.9 % of its pixels differ by at most 2/255 in every channel.
//
//   npm run golden:compare -- --target full      tests/golden/full/ vs tests/golden/
//   npm run golden:compare -- --target lite
//   npm run golden:compare -- --target full --against base-full --tol 0 --need 1
//                                                tests/golden/full/ vs tests/golden/base-full/, exactly
//
// Writes a diff image (red = over the threshold) for each failing shot next to the capture, and
// exits non-zero when any shot fails or is missing. Everything here is local and git-ignored.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = args[i + 1]; args.splice(i, 2); return v; };
const TARGET = opt('--target', 'full'), AGAINST = opt('--against', '');
const TOL = Number(opt('--tol', 2)), NEED = Number(opt('--need', 0.999));
const filter = args.filter((a) => !a.startsWith('--'))[0] ?? '';
const GOLD = AGAINST ? join(ROOT, 'tests/golden', AGAINST) : join(ROOT, 'tests/golden'), CAP = join(ROOT, `tests/golden/${TARGET}`);

if (!existsSync(GOLD)) { console.log('no goldens; run npm run golden:capture first'); process.exit(0); }
const files = readdirSync(GOLD).filter((f) => f.endsWith('.png') && f.includes(filter)).sort();
let fails = 0;
const rows = [];
for (const f of files) {
  const cp = join(CAP, f);
  if (!existsSync(cp)) { rows.push([f, 'missing', '', '']); fails++; continue; }
  const a = PNG.sync.read(readFileSync(join(GOLD, f))), b = PNG.sync.read(readFileSync(cp));
  if (a.width !== b.width || a.height !== b.height) { rows.push([f, 'size', '', '']); fails++; continue; }
  const n = a.width * a.height, diff = new PNG({ width: a.width, height: a.height });
  let bad = 0, maxd = 0;
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    const d = Math.max(Math.abs(a.data[o] - b.data[o]), Math.abs(a.data[o + 1] - b.data[o + 1]), Math.abs(a.data[o + 2] - b.data[o + 2]));
    maxd = Math.max(maxd, d);
    const over = d > TOL;
    if (over) bad++;
    const g = (a.data[o] + a.data[o + 1] + a.data[o + 2]) / 12;
    diff.data[o] = over ? 255 : g; diff.data[o + 1] = over ? 0 : g; diff.data[o + 2] = over ? 0 : g; diff.data[o + 3] = 255;
  }
  const ok = (n - bad) / n >= NEED;
  if (!ok) { fails++; writeFileSync(join(CAP, f.replace(/\.png$/, '.diff.png')), PNG.sync.write(diff)); }
  rows.push([f, ok ? 'ok' : 'FAIL', `${(100 * (n - bad) / n).toFixed(3)} %`, `max ${maxd}`]);
}
const w = Math.max(...rows.map((r) => r[0].length));
for (const r of rows) console.log(`${r[0].padEnd(w)}  ${r[1].padEnd(7)} ${r[2].padStart(10)}  ${r[3]}`);
console.log(`${files.length - fails}/${files.length} shots within ${TOL}/255 on >= ${NEED * 100} % of pixels (${TARGET}${AGAINST ? ` vs ${AGAINST}` : ''})`);
process.exit(fails ? 1 : 0);
