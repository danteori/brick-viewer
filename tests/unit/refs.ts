// Reference saves live OUTSIDE this repo, in the private sibling folder ../references.
// Point BRICK_REFS somewhere else to override. When the folder is missing (CI, a fresh clone),
// tests that need it are skipped.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '../..');
export const REFS = resolve(repoRoot, process.env.BRICK_REFS ?? '../references');
export const hasRefs = existsSync(join(REFS, 'saves'));

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Every .brz under saves/** and generated/*.brz, as paths relative to REFS (forward slashes). */
export function referenceSaves(): string[] {
  if (!hasRefs) return [];
  const saves = walk(join(REFS, 'saves')).filter((p) => p.endsWith('.brz'));
  const gen = existsSync(join(REFS, 'generated'))
    ? readdirSync(join(REFS, 'generated')).filter((n) => n.endsWith('.brz')).sort().map((n) => join(REFS, 'generated', n))
    : [];
  return [...saves, ...gen].map((p) => relative(REFS, p).replace(/\\/g, '/'));
}

export function readRef(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(join(REFS, rel)));
}
