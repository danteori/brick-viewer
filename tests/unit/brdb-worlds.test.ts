// Optional soak test on real, large worlds: point BRICK_WORLDS at a folder of .brdb COPIES
// (never the game's own folder: these tests only read, but work on copies anyway). Skipped when
// unset. Checks the reader against Python sqlite3, decodes every grid with schema-at-time, and
// round-trips the flattened world through "save as new world" and an appended revision.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { appendRevision, BrdbWorld, writeNewWorld } from '../../src/format/brdb.ts';
import { readBrz, writeBrz } from '../../src/format/brz.ts';
import { utf8 } from '../../src/format/msgpack.ts';
import { decodeWritten, fileMapView } from '../../src/format/saveview.ts';
import { MPS_TRAILER } from '../../src/format/schema.ts';
import type { SqlBackend } from '../../src/format/sql.ts';
import { flattenTree, StaleSchemaError } from '../../src/format/stale.ts';
import { buildWorldModel, gridBricks } from '../../src/scene/grids.ts';
import { digest, hasPython, hasPython314, hasTools, nodeSql, pyDump, python, TOOLS, tempDir, toolsPythonPath } from './brdb-helpers.ts';

const DIR = process.env.BRICK_WORLDS;
const worlds = DIR && existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith('.brdb')).sort() : [];
const LONG = 20 * 60_000;

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

describe.skipIf(!worlds.length)('large worlds (BRICK_WORLDS)', () => {
  describe.each(worlds)('%s', (name) => {
    const file = join(DIR!, name);
    let w: BrdbWorld;
    beforeAll(() => { w = BrdbWorld.open(sql, new Uint8Array(readFileSync(file))); }, LONG);

    it.skipIf(!hasPython)('revisions, counts, the live tree and a middle revision match Python sqlite3', () => {
      const mid = w.revisions[Math.floor(w.revisions.length / 2)]!.id;
      const py = pyDump(file, { at: [mid] });
      expect(w.revisions.map((r) => [r.id, r.description, r.createdAt])).toEqual(py.revisions);
      expect(w.revisionStats().map((s) => [s.revision.id, s.written, s.deleted])).toEqual(py.stats);
      expect(digest(w.tree().files())).toEqual(py.live);
      expect(digest(w.tree(mid).files())).toEqual(py.at[String(mid)]);
      console.log(`${name}: ${w.revisions.length} revisions, ${w.rows.length} file rows, ${w.tree().paths().length} live files`);
      w.clearCache();
    }, LONG);

    it('every live .mps decodes completely with the schema it was written with', () => {
      const tree = w.tree();
      let n = 0, stale = 0;
      const failed: string[] = [];
      for (const p of tree.paths()) {
        if (!p.endsWith('.mps')) continue;
        let f;
        try {
          f = decodeWritten(tree, p);
        } catch (e) {
          // Some old component chunks use variants no known table decodes (FORMAT.md 1.7, open);
          // survey_brz.py fails on the same ones. Anything else is a bug.
          if (!/\/Components\//.test(p)) throw e;
          failed.push(`${p}: ${(e as Error).message}`);
          continue;
        }
        expect((f.root as { [MPS_TRAILER]?: Uint8Array })[MPS_TRAILER]?.length ?? 0, p).toBe(0);
        if (tree.isStale(f.schemaPath, p)) stale++;
        n++;
      }
      console.log(`${name}: ${n} .mps decoded, ${stale} written with an older schema, ${failed.length} undecodable component chunk(s)${failed.length ? ': ' + failed.join('; ') : ''}`);
      w.clearCache();
    }, LONG);

    it.skipIf(!(hasTools && hasPython314))('entities decode as survey_brz.py decodes them', () => {
      const py = JSON.parse(python([join(import.meta.dirname, '../py/survey_entities.py'), TOOLS, file], { isolated: false, pythonPath: toolsPythonPath() })) as {
        entities: Record<string, { type: string; location: number[]; rotation: number[] }>;
      };
      const m = buildWorldModel(w.tree());
      expect(Object.fromEntries(m.entities.entities.map((e) => [String(e.persistentIndex), { type: e.type, location: e.location, rotation: e.rotation }]))).toEqual(py.entities);
    }, LONG);

    it('grids: every dynamic grid has its entity transform; all bricks decode', () => {
      const tree = w.tree(), m = buildWorldModel(tree);
      const kinds: Record<string, number> = {};
      let bricks = 0;
      for (const g of m.grids) {
        kinds[g.kind] = (kinds[g.kind] ?? 0) + 1;
        if (g.kind !== 'global' && g.kind !== 'orphan') expect(g.transform.pos).toEqual(g.entity!.location);
        bricks += gridBricks(tree, g).length;
      }
      console.log(`${name}: grids ${JSON.stringify(kinds)}, ${m.entities.entities.length} entities, ${bricks} bricks, ${m.warnings.length} warnings`);
      w.clearCache();
    }, LONG);

    it('flattens to one self-consistent tree; "save as new world" and the .brz archive read back identically', () => {
      let flat;
      try {
        flat = flattenTree(w.tree());
      } catch (e) {
        if (e instanceof StaleSchemaError) { console.log(`${name}: not flattened: ${e.message}`); return; }
        throw e;
      }
      console.log(`${name}: flatten re-encoded ${flat.reencoded.length} file(s); ${flat.warnings.join('; ') || 'no warnings'}`);
      // every file that decodes in the versioned tree decodes in the flat one with the live schemas
      const view = fileMapView(flat.files), tree = w.tree();
      for (const p of flat.files.keys()) {
        if (!p.endsWith('.mps')) continue;
        let ok = true;
        try { decodeWritten(tree, p); } catch { ok = false; }
        if (ok) decodeWritten(view, p);
      }
      const back = BrdbWorld.open(sql, writeNewWorld(sql, flat.files, { when: 1_800_000_000 }));
      expect(digest(back.tree().files())).toEqual(digest(flat.files));
      back.close();
      expect(digest(readBrz(writeBrz(flat.files)))).toEqual(digest(flat.files));
      w.clearCache();
    }, LONG);

    it.skipIf(!hasPython)('an appended revision reads back in sql.js and Python', () => {
      const next = w.tree().files();
      next.set('Meta/World.json', utf8('{"environment": "Plate"}'));
      let r;
      try {
        r = appendRevision(w, next, { when: w.head!.createdAt + 60 });
      } catch (e) {
        if (e instanceof StaleSchemaError) { console.log(`${name}: not appended: ${e.message}`); return; }
        throw e;
      }
      console.log(`${name}: appended revision ${r.revision.id}: ${r.written.length} written (${r.reencoded.length} re-encoded), ${r.deleted.length} deleted`);
      const t = tempDir();
      try {
        const py = pyDump(t.file('appended.brdb', r.bytes), { at: [w.head!.id] });
        expect(py.revisions.length).toBe(w.revisions.length + 1);
        expect(py.at[String(w.head!.id)]).toEqual(digest(w.tree(w.head!.id).files()));
        const back = BrdbWorld.open(sql, r.bytes);
        expect(py.live).toEqual(digest(back.tree().files()));
        back.close();
      } finally {
        t.done();
      }
      w.clearCache();
    }, LONG);
  });
});
