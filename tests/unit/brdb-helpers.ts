// Shared helpers for the .brdb tests: sql.js in Node, Python cross-checks, temp files.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SqlBackend } from '../../src/format/sql.ts';
import { loadSqlJs } from '../../src/format/sqljs.ts';

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, '../..');

/** sql.js with its wasm read from node_modules (no fetch in Node). */
export function nodeSql(): Promise<SqlBackend> {
  return loadSqlJs({ wasmBinary: readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) });
}

/** The private workspace tools (survey_brz.py, brdb.py), when they're next to this repo. */
export const TOOLS = resolve(repoRoot, process.env.BRICK_TOOLS ?? '../tools');
export const hasTools = existsSync(join(TOOLS, 'brdb.py')) && existsSync(join(TOOLS, 'survey_brz.py'));

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

function pyVersion(): [number, number] | null {
  const r = spawnSync(PY, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const [a, b] = r.stdout.trim().split(' ').map(Number);
  return [a!, b!];
}
const version = pyVersion();
export const hasPython = version !== null;
/** compression.zstd (the private tools need it) arrived in Python 3.14. */
export const hasPython314 = version !== null && (version[0] > 3 || (version[0] === 3 && version[1] >= 14));

/** Runs Python and returns stdout; throws with stderr on failure. */
export function python(args: string[], opts: { isolated?: boolean; pythonPath?: string } = {}): string {
  const env = { ...process.env };
  if (opts.pythonPath) env.PYTHONPATH = opts.pythonPath;
  const r = spawnSync(PY, [...(opts.isolated === false ? [] : ['-I']), ...args], { encoding: 'utf8', env, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`python ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

/** The private tools' own Python path (blake3 and so on live in tools/_pylib). */
export const toolsPythonPath = (): string | undefined => (existsSync(join(TOOLS, '_pylib')) ? join(TOOLS, '_pylib') : undefined);

export interface PyDump {
  pragmas: Record<string, number | string>;
  master: [type: string, name: string, table: string, sql: string | null][];
  revisions: [id: number, description: string, createdAt: number][];
  stats: [id: number, written: number, deleted: number][];
  live: Record<string, [size: number, sha256: string]>;
  at: Record<string, Record<string, [number, string]>>;
  folders?: (number | string | null)[][];
  files?: (number | string | null)[][];
  blobs?: (number | string | null)[][];
}

/** scripts/check_brdb.py on a file. */
export function pyDump(file: string, opts: { rows?: boolean; at?: number[] } = {}): PyDump {
  const args = [join(repoRoot, 'scripts/check_brdb.py'), file];
  if (opts.rows) args.push('--rows');
  for (const r of opts.at ?? []) args.push('--at', String(r));
  return JSON.parse(python(args)) as PyDump;
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** path -> [size, sha256], the shape check_brdb.py prints. */
export function digest(files: Iterable<[string, Uint8Array]>): Record<string, [number, string]> {
  const out: Record<string, [number, string]> = {};
  for (const [p, b] of files) out[p] = [b.length, sha256(b)];
  return out;
}

/** A temp folder, removed by the returned cleanup. Never inside the references folder. */
export function tempDir(): { dir: string; file: (name: string, bytes?: Uint8Array) => string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'brick-viewer-brdb-'));
  return {
    dir,
    file: (name, bytes) => {
      const p = join(dir, name);
      if (bytes) writeFileSync(p, bytes);
      return p;
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
