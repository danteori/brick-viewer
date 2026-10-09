// Round-trip tests over every reference save (private, read from BRICK_REFS / ../references).
// Skipped when the folder isn't there, as on GitHub CI.
import { describe, expect, it } from 'vitest';
import { blake3, toHex } from '../../src/format/blake3.ts';
import { bytesEqual, readBrzArchive, writeBrz } from '../../src/format/brz.ts';
import { decodeMps, decodeSoa, encodeMps, encodeSoa, MPS_TRAILER, parseSchema, schemaPathFor } from '../../src/format/schema.ts';
import { extractBricks, rebuildFromLoaded } from '../../src/format/world.ts';
import { hasRefs, readRef, referenceSaves, REFS } from './refs.ts';

const saves = referenceSaves();

describe.skipIf(!hasRefs)(`reference saves (${REFS})`, () => {
  it('finds saves', () => {
    expect(saves.length).toBeGreaterThan(0);
  });

  describe.each(saves)('%s', (rel) => {
    const bytes = readRef(rel);
    const archive = readBrzArchive(bytes);

    it('stored BLAKE3 hashes match the recomputed ones', () => {
      expect(toHex(blake3(archive.index))).toBe(toHex(archive.indexHash));
      const blobs = [...new Set(archive.fileBlob)];
      const byBlob = new Map<number, Uint8Array>();
      [...archive.files.values()].forEach((b, i) => byBlob.set(archive.fileBlob[i]!, b));
      for (const b of blobs) expect(toHex(blake3(byBlob.get(b)!)), `blob ${b}`).toBe(toHex(archive.blobs[b]!.hash));
      expect(archive.index.length).toBe(archive.indexSize);
    });

    it('re-encodes every .mps byte-identically', () => {
      let n = 0;
      for (const [path, data] of archive.files) {
        if (!path.endsWith('.mps')) continue;
        const sp = schemaPathFor(path, archive.files);
        expect(sp, `schema for ${path}`).not.toBe(null);
        const schema = parseSchema(archive.files.get(sp!)!);
        const again = encodeMps(decodeMps(data, schema), schema);
        expect(bytesEqual(again, data), path).toBe(true);
        n++;
      }
      expect(n).toBeGreaterThan(0);
    });

    it('decodes component / entity chunks fully (per-instance data) and re-encodes them byte-identically', () => {
      const gs = archive.files.get('World/0/GlobalData.schema'), gm = archive.files.get('World/0/GlobalData.mps');
      if (!gs || !gm) return;
      const global = decodeMps(gm, parseSchema(gs));
      for (const [path, data] of archive.files) {
        if (!/\/(Components|Entities)\/[^/]+\.mps$/.test(path) && !/Entities\/Chunks\//.test(path)) continue;
        const schema = parseSchema(archive.files.get(schemaPathFor(path, archive.files)!)!);
        const file = decodeSoa(data, schema, global);
        const left = (file.root as { [MPS_TRAILER]?: Uint8Array })[MPS_TRAILER];
        expect(left?.length ?? 0, `${path}: undecoded bytes`).toBe(0);
        expect(bytesEqual(encodeSoa(file, schema), data), path).toBe(true);
      }
    });

    it('container round-trips (method 0, hashes recomputed)', () => {
      const out = writeBrz(archive.files);
      const back = readBrzArchive(out, { verify: true });
      expect([...back.files.keys()]).toEqual([...archive.files.keys()]);
      for (const [p, b] of archive.files) expect(bytesEqual(back.files.get(p)!, b), p).toBe(true);
      // uncompressed one-blob-per-file originals (our own writer's output) come back byte-identical
      const raw = archive.indexMethod === 0 && archive.blobs.every((b) => b.method === 0) && archive.blobs.length === archive.files.size;
      if (raw) expect(bytesEqual(out, bytes)).toBe(true);
    });

    it('bricks survive extract -> rebuild -> extract', () => {
      if (!archive.files.has('World/0/Bricks/ChunksShared.schema')) return;
      const { bricks } = extractBricks(archive.files);
      const rebuilt = rebuildFromLoaded(archive.files, bricks);
      const again = extractBricks(readBrzArchive(writeBrz(rebuilt.files), { verify: true }).files).bricks;
      expect(again).toEqual(bricks);
    });
  });
});
