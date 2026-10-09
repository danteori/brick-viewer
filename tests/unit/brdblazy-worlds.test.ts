// The lazy .brdb reader on real worlds: the private reference worlds (BRICK_REFS) and, when
// BRICK_WORLDS points at a folder of .brdb COPIES, those too. Skipped when neither is there (CI).
// Each world is checked against sql.js (BrdbWorld) and Python sqlite3 (scripts/check_brdb.py):
// revisions, every folder / file / blob row, the live tree and a middle revision byte for byte,
// and the grid / entity model. The files are read through a file handle, never loaded whole.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BrdbWorld } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import type { SqlBackend } from '../../src/format/sql.ts';
import type { RandomAccessSource } from '../../src/format/sqlitelazy.ts';
import { buildWorldModel, buildWorldModelLazy } from '../../src/scene/grids.ts';
import { digest, hasPython, nodeSql, pyDump } from './brdb-helpers.ts';
import { hasRefs, REFS } from './refs.ts';

const list = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.brdb')).sort().map((n) => join(dir, n)) : []);
const files = [
  ...(hasRefs ? [...list(join(REFS, 'saves', 'full')), ...list(join(REFS, 'generated'))] : []),
  ...(process.env.BRICK_WORLDS ? list(process.env.BRICK_WORLDS) : []),
];
const LONG = 20 * 60_000;

/** A file read through a Node file handle (what Blob.slice is in the browser). */
async function fileSource(path: string): Promise<RandomAccessSource & { close(): Promise<void> }> {
  const fh = await open(path, 'r'), size = (await fh.stat()).size;
  return {
    size,
    readAt: async (o, n) => {
      const b = new Uint8Array(n), { bytesRead } = await fh.read(b, 0, n, o);
      if (bytesRead !== n) throw new Error(`short read at ${o}`);
      return b;
    },
    close: () => fh.close(),
  };
}

const hex = (b: Uint8Array | null): string | null => (b ? Buffer.from(b).toString('hex') : null);
const mb = (n: number): string => (n / 1048576).toFixed(2) + ' MB';

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

describe.skipIf(!files.length)('lazy reader on real worlds', () => {
  describe.each(files)('%s', (file) => {
    it('tables, trees, files and the world model match sql.js and Python sqlite3', async () => {
      const name = file.split(/[\\/]/).pop()!;
      const src = await fileSource(file);
      try {
        const t0 = performance.now();
        const lazy = await LazyBrdbWorld.open(src, { verify: true });
        const tOpen = performance.now() - t0, openBytes = lazy.stats.bytesRead;
        const model = await buildWorldModelLazy(lazy.tree());
        const tOverview = performance.now() - t0, overviewBytes = lazy.stats.bytesRead;

        const t1 = performance.now();
        const ref = BrdbWorld.open(sql, new Uint8Array(readFileSync(file)), { verify: true });
        const refModel = buildWorldModel(ref.tree());
        const tFull = performance.now() - t1;
        console.log(`${name}: ${mb(src.size)}; lazy open ${mb(openBytes)} in ${tOpen.toFixed(0)} ms, + overview ${mb(overviewBytes)} total in ${tOverview.toFixed(0)} ms (${lazy.stats.reads} reads); sql.js load + model ${tFull.toFixed(0)} ms`);

        expect(model).toEqual(refModel);
        expect(lazy.revisions).toEqual(ref.revisions);
        expect([...lazy.folders]).toEqual([...ref.folders]);
        expect(lazy.rows).toEqual(ref.rows);
        expect(lazy.revisionStats()).toEqual(ref.revisionStats());
        for (const [id, b] of ref.blobs) {
          const l = lazy.blobs.get(id)!;
          expect([l.sizeUncompressed, hex(l.hash)], `blob ${id}`).toEqual([b.sizeUncompressed, hex(b.hash)]);
        }
        const mid = ref.revisions[Math.floor(ref.revisions.length / 2)]!.id;
        for (const rev of [undefined, mid]) {
          const a = ref.tree(rev), b = lazy.tree(rev);
          expect(b.paths()).toEqual(a.paths());
          expect(digest(await b.loadAll())).toEqual(digest(a.files()));
          lazy.unloadBlobs(); ref.clearCache();
        }
        for (const [id, b] of ref.blobs) if (lazy.blobs.get(id)!.compression !== null) expect(lazy.blobs.get(id)).toEqual({ ...b });
        if (hasPython) {
          const py = pyDump(file, { at: [mid] });
          expect(lazy.revisions.map((r) => [r.id, r.description, r.createdAt])).toEqual(py.revisions);
          expect(lazy.revisionStats().map((s) => [s.revision.id, s.written, s.deleted])).toEqual(py.stats);
          expect(digest(await lazy.tree().loadAll())).toEqual(py.live);
          lazy.unloadBlobs();
          expect(digest(await lazy.tree(mid).loadAll())).toEqual(py.at[String(mid)]);
        }
        ref.close();
      } finally {
        await src.close();
      }
    }, LONG);
  });
});
