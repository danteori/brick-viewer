// .brdb against the private reference worlds (BRICK_REFS, default ../references; skipped when
// absent, as on CI), cross-checked with Python: scripts/check_brdb.py (sqlite3) and, when the
// private tools are next to this repo (BRICK_TOOLS), brdb.py brdb2brz / rebuild and survey_brz.py.
// Everything Python writes goes to a temp folder.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendRevision, BRDB_CREATE, BrdbWorld, writeNewWorld } from '../../src/format/brdb.ts';
import { readBrz, writeBrz } from '../../src/format/brz.ts';
import { utf8 } from '../../src/format/msgpack.ts';
import { decodeWritten } from '../../src/format/saveview.ts';
import type { SqlBackend } from '../../src/format/sql.ts';
import { flattenTree } from '../../src/format/stale.ts';
import { buildWorldModel, gridBricks } from '../../src/scene/grids.ts';
import { digest, hasPython, hasPython314, hasTools, nodeSql, pyDump, python, TOOLS, tempDir, toolsPythonPath } from './brdb-helpers.ts';
import { hasRefs, REFS } from './refs.ts';

const dir = join(REFS, 'saves', 'full');
const worlds = hasRefs && existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.brdb')).sort() : [];
const withTools = hasTools && hasPython314;

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

describe.skipIf(!worlds.length)('reference worlds', () => {
  describe.each(worlds)('%s', (name) => {
    const file = resolve(dir, name);
    const bytes = new Uint8Array(readFileSync(file));
    const open = (): BrdbWorld => BrdbWorld.open(sql, bytes, { verify: true });

    it.skipIf(!hasPython)('revisions, per-revision counts and the live tree match Python sqlite3', () => {
      const w = open(), py = pyDump(file);
      expect(w.revisions.map((r) => [r.id, r.description, r.createdAt])).toEqual(py.revisions);
      expect(w.revisionStats().map((s) => [s.revision.id, s.written, s.deleted])).toEqual(py.stats);
      expect(digest(w.tree().files())).toEqual(py.live);
      expect([...w.tree().paths()]).toEqual(Object.keys(py.live));
      w.close();
    });

    it.skipIf(!withTools)('the live tree equals brdb.py brdb2brz output', () => {
      const t = tempDir();
      try {
        const out = t.file('brdb2brz.brz');
        python([join(TOOLS, 'brdb.py'), 'brdb2brz', file, out], { isolated: false, pythonPath: toolsPythonPath() });
        const theirs = readBrz(readFileSync(out)), w = open(), ours = w.tree().files();
        expect([...ours.keys()]).toEqual([...theirs.keys()]);
        expect(digest(ours)).toEqual(digest(theirs));
        w.close();
      } finally {
        t.done();
      }
    });

    it('our CREATE statements are the ones in the game-written file', () => {
      const db = sql.open(bytes);
      expect(db.query('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').map((r) => r[0])).toEqual([...BRDB_CREATE]);
      expect(db.query('PRAGMA page_size')[0]![0]).toBe(4096);
      db.close();
    });

    it.skipIf(!withTools)('entity transforms and grid chunk indices decode as survey_brz.py decodes them', () => {
      const w = open(), m = buildWorldModel(w.tree());
      const py = JSON.parse(python([resolve(import.meta.dirname, '../py/survey_entities.py'), TOOLS, file], { isolated: false, pythonPath: toolsPythonPath() })) as {
        entities: Record<string, { type: string; location: number[]; rotation: number[] }>;
        grids: Record<string, { chunks: number[][]; bricks: number[] }>;
      };
      const ours = Object.fromEntries(m.entities.entities.map((e) => [String(e.persistentIndex), { type: e.type, location: e.location, rotation: e.rotation }]));
      expect(ours).toEqual(py.entities);
      for (const g of m.grids) {
        expect(g.chunks.map((c) => c.index), `grid ${g.id}`).toEqual(py.grids[String(g.id)]!.chunks);
        expect(g.chunks.map((c) => c.numBricks)).toEqual(py.grids[String(g.id)]!.bricks);
      }
      w.close();
    });

    it('dynamic grids sit at their entity, bricks placed in world space', () => {
      const w = open(), tree = w.tree(), m = buildWorldModel(tree);
      for (const g of m.grids) {
        if (g.kind === 'global') { expect(g.transform).toEqual({ pos: [0, 0, 0], quat: [0, 0, 0, 1] }); continue; }
        if (g.kind === 'orphan') continue;
        expect(g.transform.pos).toEqual(g.entity!.location);
        expect(Math.hypot(...g.transform.quat)).toBeCloseTo(1, 5);
        for (const c of g.chunks) if (c.offset.join() === '1024,1024,1024' && c.index.join() === '-1,-1,-1') expect(c.centre).toEqual([0, 0, 0]);
        const bricks = gridBricks(tree, g);
        expect(bricks.length).toBe(g.chunks.reduce((s, c) => s + (c.bricks ? c.numBricks : 0), 0));
        for (const b of bricks) {
          // the rotation keeps distances: a brick is as far from the entity as it is from the grid origin
          const d = Math.hypot(b.world[0] - g.transform.pos[0], b.world[1] - g.transform.pos[1], b.world[2] - g.transform.pos[2]);
          expect(d).toBeCloseTo(Math.hypot(...b.pos), 2);
        }
      }
      w.close();
    });

    it.skipIf(!hasPython)('"save as new world" reads back identically with sql.js and with Python sqlite3', () => {
      const w = open(), flat = flattenTree(w.tree());
      const out = writeNewWorld(sql, flat.files, { when: 1_800_000_000 }), t = tempDir();
      try {
        const back = BrdbWorld.open(sql, out, { verify: true });
        expect(digest(back.tree().files())).toEqual(digest(flat.files));
        const py = pyDump(t.file('new.brdb', out), { rows: true });
        expect(py.live).toEqual(digest(flat.files));
        expect(py.master).toEqual(pyDump(file).master);   // same schema objects, same SQL text, same order
        expect(py.revisions).toEqual([[1, 'Initial Revision', 1_800_000_000], [2, 'Manual Save', 1_800_000_000]]);
        back.close();
        if (withTools) {
          // brdb.py rebuild writes the same rows (ids, folders, names, blob sharing); only its zstd blobs and timestamps differ
          const theirs = t.file('rebuild.brdb');
          python([join(TOOLS, 'brdb.py'), 'rebuild', file, theirs], { isolated: false, pythonPath: toolsPythonPath() });
          const ref = pyDump(theirs, { rows: true });
          const noTime = (rows: (number | string | null)[][] | undefined, drop: number[]): unknown[] => (rows ?? []).map((r) => r.filter((_, i) => !drop.includes(i)));
          expect(noTime(py.folders, [3])).toEqual(noTime(ref.folders, [3]));
          expect(noTime(py.files, [4])).toEqual(noTime(ref.files, [4]));
          // blobs: id, size, hash, content digest equal; compression differs (we wrote raw)
          expect((py.blobs ?? []).map((b) => [b[0], b[2], b[5], b[7]])).toEqual((ref.blobs ?? []).map((b) => [b[0], b[2], b[5], b[7]]));
        }
      } finally {
        t.done(); w.close();
      }
    });

    it('world archive .brz holds the same tree', () => {
      const w = open(), flat = flattenTree(w.tree()), brz = readBrz(writeBrz(flat.files), { verify: true });
      expect(digest(brz)).toEqual(digest(flat.files));
      w.close();
    });

    it.skipIf(!hasPython)('a revision appended to the world reads back in sql.js and Python', () => {
      const w = open(), next = w.tree().files();
      next.set('Meta/World.json', utf8('{\n\t"environment": "Plate"\n}'));
      const r = appendRevision(w, next, { when: w.head!.createdAt + 60 }), t = tempDir();
      try {
        expect(r.written).toEqual(['Meta/World.json']);
        const back = BrdbWorld.open(sql, r.bytes, { verify: true });
        expect(back.revisions.length).toBe(w.revisions.length + 1);
        expect(digest(back.tree(w.head!.id).files())).toEqual(digest(w.tree().files()));
        const py = pyDump(t.file('appended.brdb', r.bytes), { at: [w.head!.id, r.revision.id] });
        expect(py.live).toEqual(digest(next));
        expect(py.at[String(w.head!.id)]).toEqual(digest(w.tree().files()));
        expect(py.stats.at(-1)).toEqual([r.revision.id, 1, 1]);
        // every chunk still decodes with its own schema
        for (const p of back.tree().paths()) if (p.endsWith('.mps')) decodeWritten(back.tree(), p);
        back.close();
      } finally {
        t.done(); w.close();
      }
    });
  });
});
