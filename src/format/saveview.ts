// A read-only view of a save's file tree that also knows which schema each file was written with.
//
// In a .brz every file matches the schemas next to it. In a .brdb an unchanged chunk keeps the
// bytes it was written with, even after a later save replaced the shared .schema (and
// GlobalData), so a chunk must be decoded with the schema that was live at the chunk's
// created_at (survey_brz.schema_for). BrdbTree (brdb.ts) implements that; fileMapView is the
// trivial .brz case. Both feed the same decoders.

import type { FileMap } from './brz.ts';
import { decodeMps, decodeSoa, parseSchema, schemaPathFor, type MpsObject, type Schema, type SoaFile } from './schema.ts';

export interface SaveView {
  /** Paths in container order. */
  paths(): string[];
  has(path: string): boolean;
  /** Uncompressed bytes, or undefined when the path isn't in the tree. */
  get(path: string): Uint8Array | undefined;
  /** Bytes of `path` as they were when `mpsPath` was written (its schema, GlobalData...). */
  asWrittenWith(path: string, mpsPath: string): Uint8Array | undefined;
}

export const GLOBAL_MPS = 'World/0/GlobalData.mps';
export const GLOBAL_SCHEMA = 'World/0/GlobalData.schema';

/** A .brz (or any flat file map): every file goes with the files beside it. */
export function fileMapView(files: FileMap): SaveView {
  return {
    paths: () => [...files.keys()],
    has: (p) => files.has(p),
    get: (p) => files.get(p),
    asWrittenWith: (p) => files.get(p),
  };
}

const parsed = new WeakMap<Uint8Array, Schema>();

/** parseSchema with a cache keyed by the bytes object (views hand out the same object per blob). */
export function schemaOf(bytes: Uint8Array): Schema {
  let s = parsed.get(bytes);
  if (!s) { s = parseSchema(bytes); parsed.set(bytes, s); }
  return s;
}

/** The schema path for an .mps in this tree (see schemaPathFor). */
export function schemaPathIn(view: SaveView, mpsPath: string): string | null {
  return schemaPathFor(mpsPath, { has: (p: string) => view.has(p) } as ReadonlyMap<string, unknown>);
}

/** The schema an .mps was written with: its path and parsed form. */
export function writtenSchema(view: SaveView, mpsPath: string): { path: string; bytes: Uint8Array; schema: Schema } | null {
  const path = schemaPathIn(view, mpsPath);
  if (!path) return null;
  const bytes = view.asWrittenWith(path, mpsPath);
  return bytes ? { path, bytes, schema: schemaOf(bytes) } : null;
}

/** GlobalData as it was when `mpsPath` was written (the name tables its indices point into). */
export function writtenGlobalData<T extends MpsObject = MpsObject>(view: SaveView, mpsPath: string): T | null {
  const m = view.asWrittenWith(GLOBAL_MPS, mpsPath), s = view.asWrittenWith(GLOBAL_SCHEMA, mpsPath);
  return m && s ? decodeMps<T>(m, schemaOf(s)) : null;
}

/**
 * Decodes one .mps with the schema and GlobalData it was written with. Component and entity
 * chunks come back with their per-instance data (decodeSoa); other files have an empty data list.
 */
export function decodeWritten(view: SaveView, mpsPath: string): SoaFile & { schema: Schema; schemaPath: string } {
  const bytes = view.get(mpsPath);
  if (!bytes) throw new Error('missing ' + mpsPath);
  const ws = writtenSchema(view, mpsPath);
  if (!ws) throw new Error('no schema for ' + mpsPath);
  const global = mpsPath === GLOBAL_MPS ? {} : (writtenGlobalData(view, mpsPath) ?? {});
  const file = ws.schema.root === 'BRSavedComponentChunkSoA' || ws.schema.root === 'BRSavedEntityChunkSoA'
    ? decodeSoa(bytes, ws.schema, global)
    : { root: decodeMps(bytes, ws.schema), data: [] };
  return { ...file, schema: ws.schema, schemaPath: ws.path };
}
