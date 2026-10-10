// .brdb: a world database. It's SQLite holding a versioned file tree (verified layout):
//   revisions (revision_id, description, created_at)        one row per save, unix seconds
//   folders   (folder_id, parent_id, name, created_at, deleted_at)
//   files     (file_id, parent_id, name, content_id, created_at, deleted_at)
//   blobs     (blob_id, compression 0 raw | 1 zstd, size_uncompressed, size_compressed,
//              delta_base_id (always NULL so far), hash = BLAKE3 of the uncompressed bytes, content)
// A file is live while deleted_at IS NULL. A save writes only the files that changed: it sets
// deleted_at on the old row and inserts a new one, so the tree as of any time t is the rows with
// created_at <= t and (deleted_at IS NULL or deleted_at > t). Identical contents share a blob.
//
// Unchanged chunks keep the bytes they were written with even after a later save replaced the
// shared .schema, so BrdbTree.asWrittenWith hands out the schema live at a chunk's created_at
// (survey_brz.schema_for). Writers: writeNewWorldFile (pure TS, sqlitewrite.ts; both builds),
// writeNewWorld (the same rows through an SqlBackend, port of brdb.py write_brdb) and
// appendRevision (save into an opened world; needs an SqlBackend, sqljs.ts).
// BrdbWorld copies the whole database into sql.js; brdblazy.ts reads the same tables page by
// page instead (no wasm, contents on demand) on the shared BrdbFileTable / BrdbTree.

import { blake3 } from './blake3.ts';
import { bytesEqual, type FileMap } from './brz.ts';
import type { SaveView } from './saveview.ts';
import type { SqlBackend, SqlDb, SqlValue } from './sql.ts';
import { reencodeForTarget, type ReencodeOptions } from './stale.ts';
import { writeSqlite } from './sqlitewrite.ts';
import { fileMapView } from './saveview.ts';
import { zstdDecompress } from './zstd.ts';

/** The game's CREATE statements, verbatim (tab-indented as the game writes them; from brdb.py). */
export const BRDB_CREATE: readonly string[] = [
  'CREATE TABLE blobs (\n\t\t\t\tblob_id INTEGER PRIMARY KEY,\n\t\t\t\tcompression INTEGER,\n\t\t\t\tsize_uncompressed INTEGER,\n\t\t\t\tsize_compressed INTEGER,\n\t\t\t\tdelta_base_id INTEGER REFERENCES blobs(blob_id),\n\t\t\t\thash BLOB,\n\t\t\t\tcontent BLOB\n\t\t\t)',
  'CREATE INDEX blobs_size_hash ON blobs(size_uncompressed, hash)',
  'CREATE TABLE revisions (\n\t\t\t\trevision_id INTEGER PRIMARY KEY,\n\t\t\t\tdescription TEXT,\n\t\t\t\tcreated_at INTEGER\n\t\t\t)',
  'CREATE TABLE folders (\n\t\t\t\tfolder_id INTEGER PRIMARY KEY,\n\t\t\t\tparent_id INTEGER REFERENCES folders(folder_id),\n\t\t\t\tname TEXT,\n\t\t\t\tcreated_at INTEGER,\n\t\t\t\tdeleted_at INTEGER\n\t\t\t)',
  'CREATE INDEX folders_parent_name_deleted ON folders(parent_id, name, deleted_at)',
  'CREATE TABLE files (\n\t\t\t\tfile_id INTEGER PRIMARY KEY,\n\t\t\t\tparent_id INTEGER REFERENCES folders(folder_id),\n\t\t\t\tname TEXT,\n\t\t\t\tcontent_id INTEGER REFERENCES blobs(blob_id),\n\t\t\t\tcreated_at INTEGER,\n\t\t\t\tdeleted_at INTEGER\n\t\t\t)',
  'CREATE INDEX files_parent_name_deleted ON files(parent_id, name, deleted_at)',
];

const SQLITE_MAGIC = 'SQLite format 3\0';

/** True when the bytes start with the SQLite header (a .brdb rather than a .brz). */
export function isSqlite(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  for (let i = 0; i < 16; i++) if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

export interface BrdbRevision {
  id: number;
  description: string;
  /** Unix seconds. Two revisions can share a time (a new world's Initial Revision + Manual Save). */
  createdAt: number;
}

export interface BrdbFolderRow {
  id: number;
  parentId: number | null;
  name: string;
  createdAt: number;
  deletedAt: number | null;
  path: string;
}

export interface BrdbFileRow {
  id: number;
  folderId: number | null;
  name: string;
  /** Full path, e.g. World/0/GlobalData.mps. */
  path: string;
  contentId: number;
  createdAt: number;
  deletedAt: number | null;
}

export interface BrdbBlobRow {
  id: number;
  compression: number;
  sizeUncompressed: number;
  sizeCompressed: number;
  deltaBaseId: number | null;
  hash: Uint8Array | null;
}

export interface BrdbOpenOptions {
  /** zstd decoder; defaults to fzstd. */
  unzstd?: (bytes: Uint8Array) => Uint8Array;
  /** Check each blob's size and BLAKE3 hash when it's read (throws on a mismatch). */
  verify?: boolean;
}

export interface RevisionStats {
  revision: BrdbRevision;
  /** File rows created at this revision's time (as `survey_brz.py revs` counts them). */
  written: number;
  /** File rows deleted (replaced or removed) at this revision's time. */
  deleted: number;
}

export interface TreeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

const num = (v: SqlValue): number => (typeof v === 'bigint' ? Number(v) : (v as number));
const numOrNull = (v: SqlValue): number | null => (v === null ? null : num(v));

/** Raw table rows in column order (shared by the sql.js and the lazy reader). */
export interface BrdbRawTables {
  /** revision_id, description, created_at, in revision_id order */
  revisions: readonly (readonly SqlValue[])[];
  /** folder_id, parent_id, name, created_at, deleted_at, in folder_id order */
  folders: readonly (readonly SqlValue[])[];
  /** file_id, parent_id, name, content_id, created_at, deleted_at, in file_id order */
  files: readonly (readonly SqlValue[])[];
}

/**
 * The versioned file tree of a world: revisions, folders and file rows, without blob contents.
 * BrdbWorld (sql.js, whole file in memory) and LazyBrdbWorld (brdblazy.ts, pages on demand)
 * both build on it; blob() is how each hands out contents.
 */
export abstract class BrdbFileTable {
  readonly revisions: BrdbRevision[];
  readonly folders: Map<number, BrdbFolderRow>;
  /** Every file row, live or not, in file_id order. */
  readonly rows: BrdbFileRow[];
  private readonly byPath = new Map<string, BrdbFileRow[]>();

  protected constructor(raw: BrdbRawTables) {
    this.revisions = raw.revisions.map(([id, d, t]) => ({ id: num(id!), description: String(d ?? ''), createdAt: num(t!) }));
    const fmeta = new Map<number, { parentId: number | null; name: string; createdAt: number; deletedAt: number | null }>();
    for (const [id, par, name, ca, da] of raw.folders) fmeta.set(num(id!), { parentId: numOrNull(par!), name: String(name), createdAt: num(ca!), deletedAt: numOrNull(da!) });
    const pathOf = (id: number | null): string => {
      const parts: string[] = [];
      for (let f = id, guard = 0; f !== null; guard++) {
        const m = fmeta.get(f);
        if (!m || guard > 1000) throw new Error(`.brdb: broken folder chain at ${f}`);
        parts.unshift(m.name);
        f = m.parentId;
      }
      return parts.join('/');
    };
    this.folders = new Map([...fmeta].map(([id, m]) => [id, { id, ...m, path: pathOf(id) }]));
    this.rows = raw.files.map(([id, par, name, cid, ca, da]) => {
      const folderId = numOrNull(par!), dir = folderId === null ? '' : this.folders.get(folderId)?.path;
      if (dir === undefined) throw new Error(`.brdb: file ${String(id)} is in a missing folder ${folderId}`);
      return { id: num(id!), folderId, name: String(name), path: dir ? `${dir}/${String(name)}` : String(name), contentId: num(cid!), createdAt: num(ca!), deletedAt: numOrNull(da!) };
    });
    for (const r of this.rows) {
      let l = this.byPath.get(r.path);
      if (!l) this.byPath.set(r.path, (l = []));
      l.push(r);
    }
  }

  /** Uncompressed contents of one blob. */
  abstract blob(id: number): Uint8Array;

  /** The latest revision (highest id). */
  get head(): BrdbRevision | undefined {
    return this.revisions[this.revisions.length - 1];
  }

  revision(id: number): BrdbRevision {
    const r = this.revisions.find((x) => x.id === id);
    if (!r) throw new Error(`no revision ${id}`);
    return r;
  }

  /** Every row ever stored for a path, oldest first. */
  history(path: string): readonly BrdbFileRow[] {
    return this.byPath.get(path) ?? [];
  }

  /** The row of `path` alive at unix time `t`, or null. */
  rowAt(path: string, t: number): BrdbFileRow | null {
    let hit: BrdbFileRow | null = null;
    for (const r of this.history(path)) if (r.createdAt <= t && (r.deletedAt === null || r.deletedAt > t)) hit = r;
    return hit;
  }

  /** The rows of the live tree (deleted_at IS NULL), or of the tree as of a revision. */
  protected treeRows(revisionId?: number): BrdbFileRow[] {
    if (revisionId === undefined) return this.rows.filter((r) => r.deletedAt === null);
    const t = this.revision(revisionId).createdAt;
    return this.rows.filter((r) => r.createdAt <= t && (r.deletedAt === null || r.deletedAt > t));
  }

  /** Files written and deleted per revision. */
  revisionStats(): RevisionStats[] {
    const w = new Map<number, number>(), d = new Map<number, number>();
    for (const r of this.rows) {
      w.set(r.createdAt, (w.get(r.createdAt) ?? 0) + 1);
      if (r.deletedAt !== null) d.set(r.deletedAt, (d.get(r.deletedAt) ?? 0) + 1);
    }
    return this.revisions.map((revision) => ({ revision, written: w.get(revision.createdAt) ?? 0, deleted: d.get(revision.createdAt) ?? 0 }));
  }
}

/** Decompresses (and with `verify`, checks) one blob's stored content. */
export function decodeBlob(info: BrdbBlobRow, stored: Uint8Array, opts: BrdbOpenOptions = {}): Uint8Array {
  if (info.deltaBaseId !== null) throw new Error(`.brdb: blob ${info.id} is a delta blob (not seen in any save so far; not supported)`);
  let content = stored;
  if (info.compression === 1) content = (opts.unzstd ?? zstdDecompress)(content);
  else if (info.compression !== 0) throw new Error(`.brdb: blob ${info.id} has unknown compression ${info.compression}`);
  if (opts.verify) {
    if (content.length !== info.sizeUncompressed) throw new Error(`.brdb: blob ${info.id} size ${content.length} != ${info.sizeUncompressed}`);
    if (info.hash && !bytesEqual(blake3(content), info.hash)) throw new Error(`.brdb: blob ${info.id} hash mismatch`);
  }
  return content;
}

/** An opened .brdb. Holds a copy of the database; the input bytes are never changed. */
export class BrdbWorld extends BrdbFileTable {
  readonly blobs: Map<number, BrdbBlobRow>;
  private readonly cache = new Map<number, Uint8Array>();

  private constructor(readonly backend: SqlBackend, readonly bytes: Uint8Array, readonly db: SqlDb, private readonly opts: BrdbOpenOptions) {
    super({
      revisions: db.query('SELECT revision_id, description, created_at FROM revisions ORDER BY revision_id'),
      folders: db.query('SELECT folder_id, parent_id, name, created_at, deleted_at FROM folders ORDER BY folder_id'),
      files: db.query('SELECT file_id, parent_id, name, content_id, created_at, deleted_at FROM files ORDER BY file_id'),
    });
    this.blobs = new Map(db.query('SELECT blob_id, compression, size_uncompressed, size_compressed, delta_base_id, hash FROM blobs').map(([id, c, us, cs, d, h]) =>
      [num(id!), { id: num(id!), compression: num(c!), sizeUncompressed: num(us!), sizeCompressed: num(cs!), deltaBaseId: numOrNull(d!), hash: h instanceof Uint8Array ? h : null }]));
  }

  /** Opens a .brdb from its bytes (a copy is made; nothing is ever written back to them). */
  static open(backend: SqlBackend, bytes: Uint8Array, opts: BrdbOpenOptions = {}): BrdbWorld {
    if (!isSqlite(bytes)) throw new Error('not a .brdb world (no SQLite header)');
    const db = backend.open(bytes);
    try {
      return new BrdbWorld(backend, bytes, db, opts);
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }

  /** Drops decompressed blob contents kept from earlier reads. */
  clearCache(): void {
    this.cache.clear();
  }

  /** Uncompressed contents of one blob. */
  blob(id: number): Uint8Array {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const info = this.blobs.get(id);
    if (!info) throw new Error(`.brdb: missing blob ${id}`);
    if (info.deltaBaseId !== null) throw new Error(`.brdb: blob ${id} is a delta blob (not seen in any save so far; not supported)`);
    const row = this.db.query('SELECT content FROM blobs WHERE blob_id = ?', [id])[0];
    const content = decodeBlob(info, row?.[0] instanceof Uint8Array ? row[0] : new Uint8Array(0), this.opts);
    this.cache.set(id, content);
    return content;
  }

  /** The live tree (deleted_at IS NULL), or the tree as of a revision. */
  tree(revisionId?: number): BrdbTree {
    return new BrdbTree(this, revisionId ?? null, this.treeRows(revisionId));
  }

  /** Which paths differ between two revisions (by content hash). */
  diff(fromRevision: number, toRevision: number): TreeDiff {
    const a = this.tree(fromRevision), b = this.tree(toRevision), out: TreeDiff = { added: [], removed: [], changed: [] };
    const same = (x: BrdbFileRow, y: BrdbFileRow): boolean => {
      if (x.contentId === y.contentId) return true;
      const hx = this.blobs.get(x.contentId), hy = this.blobs.get(y.contentId);
      if (hx?.hash && hy?.hash) return hx.sizeUncompressed === hy.sizeUncompressed && bytesEqual(hx.hash, hy.hash);
      return bytesEqual(this.blob(x.contentId), this.blob(y.contentId));
    };
    for (const [p, r] of b.entries) {
      const o = a.entries.get(p);
      if (!o) out.added.push(p);
      else if (!same(o, r)) out.changed.push(p);
    }
    for (const p of a.entries.keys()) if (!b.entries.has(p)) out.removed.push(p);
    return out;
  }
}

/** One state of a world's file tree: live, or as of a revision. */
export class BrdbTree implements SaveView {
  /** path -> row, in file_id order. */
  readonly entries = new Map<string, BrdbFileRow>();
  /** Paths stored twice at this time (not seen in game saves); the later row wins. */
  readonly duplicates: string[] = [];

  constructor(readonly world: BrdbFileTable, readonly revisionId: number | null, rows: readonly BrdbFileRow[]) {
    for (const r of rows) {
      if (this.entries.has(r.path)) this.duplicates.push(r.path);
      this.entries.set(r.path, r);
    }
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  get(path: string): Uint8Array | undefined {
    const r = this.entries.get(path);
    return r ? this.world.blob(r.contentId) : undefined;
  }

  /** When `path` was written (unix seconds). */
  createdAt(path: string): number | undefined {
    return this.entries.get(path)?.createdAt;
  }

  /** The bytes `path` had when `mpsPath` was written: its schema / GlobalData of that time. */
  asWrittenWith(path: string, mpsPath: string): Uint8Array | undefined {
    const t = this.entries.get(mpsPath)?.createdAt;
    if (t === undefined) return undefined;
    const r = this.world.rowAt(path, t);
    return r ? this.world.blob(r.contentId) : undefined;
  }

  /** Whether `mpsPath` was written with a different `schemaPath` than the tree's current one. */
  isStale(schemaPath: string, mpsPath: string): boolean {
    const now = this.entries.get(schemaPath), t = this.entries.get(mpsPath)?.createdAt;
    if (!now || t === undefined) return false;
    const then = this.world.rowAt(schemaPath, t);
    if (!then) return true;
    if (then.contentId === now.contentId) return false;
    return !bytesEqual(this.world.blob(then.contentId), this.world.blob(now.contentId));
  }

  /** Every file's bytes, as written (no re-encoding). */
  files(): FileMap {
    const out: FileMap = new Map();
    for (const [p, r] of this.entries) out.set(p, this.world.blob(r.contentId));
    return out;
  }
}

// ------------------------------------------------------------------ writing

export interface BrdbWriteOptions {
  /** Unix seconds for the new rows; default now. */
  when?: number;
  /** zstd encoder. With it each blob is compressed when that makes it smaller (as brdb.py); without it blobs are raw. */
  zstd?: (bytes: Uint8Array) => Uint8Array;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
/** Largest value, 0 for none (no argument spread: worlds have 100k+ rows). */
const maxOf = (xs: readonly number[]): number => xs.reduce((m, x) => (x > m ? x : m), 0);

/** Inserts blobs, deduplicated by (size, BLAKE3), reusing the rows already in the database. */
class BlobWriter {
  private readonly known = new Map<string, number>();
  private next: number;

  constructor(private readonly db: SqlDb, private readonly zstd: ((b: Uint8Array) => Uint8Array) | undefined, private readonly lookup: boolean) {
    this.next = num(db.query('SELECT COALESCE(MAX(blob_id), 0) FROM blobs')[0]![0]!) + 1;
  }

  id(content: Uint8Array): number {
    const hash = blake3(content), key = content.length + ':' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    const hit = this.known.get(key);
    if (hit !== undefined) return hit;
    if (this.lookup) {
      const row = this.db.query('SELECT blob_id FROM blobs WHERE size_uncompressed = ? AND hash = ? ORDER BY blob_id LIMIT 1', [content.length, hash])[0];
      if (row) { const id = num(row[0]!); this.known.set(key, id); return id; }
    }
    const z = this.zstd ? this.zstd(content) : null;
    const [comp, body] = z && z.length < content.length ? [1, z] : [0, content];
    const id = this.next++;
    this.db.run('INSERT INTO blobs (blob_id, compression, size_uncompressed, size_compressed, delta_base_id, hash, content) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      [id, comp, content.length, body.length, hash, body]);
    this.known.set(key, id);
    return id;
  }
}

/** Finds or creates folder rows for a path's directories. */
class FolderWriter {
  private readonly ids = new Map<string, number>();
  private next: number;

  constructor(private readonly db: SqlDb, existing: Iterable<BrdbFolderRow>, private readonly when: number) {
    let max = 0;
    for (const f of existing) {
      max = Math.max(max, f.id);
      if (f.deletedAt === null && !this.ids.has(f.path)) this.ids.set(f.path, f.id);
    }
    this.next = max + 1;
  }

  id(dirs: string[]): number | null {
    let parent: number | null = null;
    for (let i = 0; i < dirs.length; i++) {
      const key = dirs.slice(0, i + 1).join('/');
      let id = this.ids.get(key);
      if (id === undefined) {
        id = this.next++;
        this.db.run('INSERT INTO folders (folder_id, parent_id, name, created_at, deleted_at) VALUES (?, ?, ?, ?, NULL)', [id, parent, dirs[i]!, this.when]);
        this.ids.set(key, id);
      }
      parent = id;
    }
    return parent;
  }
}

const entriesOf = (files: ReadonlyMap<string, Uint8Array> | Iterable<[string, Uint8Array]>): [string, Uint8Array][] => [...files];

/**
 * "Save as new world": a fresh .brdb with revisions Initial Revision + Manual Save at one time (as
 * a freshly saved game world), one file row per path, identical contents sharing a blob. A port
 * of brdb.py write_brdb (same row order and ids). Pass a tree that matches its schemas: flatten a
 * multi-revision world with flattenTree (stale.ts) first, never its raw live bytes.
 */
export function writeNewWorld(backend: SqlBackend, files: ReadonlyMap<string, Uint8Array> | Iterable<[string, Uint8Array]>, opts: BrdbWriteOptions = {}): Uint8Array {
  const t = Math.floor(opts.when ?? nowSeconds()), db = backend.open();
  try {
    db.exec('PRAGMA page_size = 4096');
    db.exec('BEGIN');
    for (const s of BRDB_CREATE) db.run(s);
    db.run('INSERT INTO revisions VALUES (1, ?, ?)', ['Initial Revision', t]);
    db.run('INSERT INTO revisions VALUES (2, ?, ?)', ['Manual Save', t]);
    const blobs = new BlobWriter(db, opts.zstd, false), folders = new FolderWriter(db, [], t);
    let fileId = 1;
    for (const [p, content] of entriesOf(files)) {
      const dirs = p.split('/'), name = dirs.pop()!;
      const parent = folders.id(dirs), cid = blobs.id(content);
      db.run('INSERT INTO files (file_id, parent_id, name, content_id, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)', [fileId++, parent, name, cid, t]);
    }
    db.exec('COMMIT');
    return db.export();
  } finally {
    db.close();
  }
}

export interface AppendOptions extends BrdbWriteOptions, ReencodeOptions {
  /** Default "Manual Save". */
  description?: string;
  /**
   * Re-encode unchanged chunks that were written with an older schema than the one the new
   * revision leaves live (and remap their GlobalData indices if needed). Default true.
   */
  reencodeStale?: boolean;
}

export interface AppendResult {
  bytes: Uint8Array;
  revision: BrdbRevision;
  /** Paths given new rows (changed, added or re-encoded). */
  written: string[];
  /** Paths removed from the tree. */
  deleted: string[];
  /** Unchanged files that were re-encoded to the current schema. */
  reencoded: string[];
  warnings: string[];
}

/**
 * Saves `files` (the complete new tree) into an opened world as one new revision: a revision row
 * after the latest one, deleted_at set on every replaced or removed row, new rows only for files
 * whose bytes changed, blobs shared with existing ones by (size, hash). Folders are never deleted
 * (the game doesn't either). The world itself is not changed; the new database comes back as bytes.
 */
export function appendRevision(world: BrdbWorld, files: ReadonlyMap<string, Uint8Array> | Iterable<[string, Uint8Array]>, opts: AppendOptions = {}): AppendResult {
  const last = maxOf(world.revisions.map((r) => r.createdAt));
  const t = Math.floor(opts.when ?? Math.max(nowSeconds(), last + 1));
  // Equal times would make the previous revision see the new rows (tree-at-time is by created_at).
  if (t <= last) throw new Error(`revision time ${t} must be after the latest revision (${last})`);
  const live = world.tree(), final: FileMap = new Map(entriesOf(files)), warnings = new Set<string>(), reencoded: string[] = [];
  if (opts.reencodeStale ?? true) {
    const target = fileMapView(final);
    for (const [p, b] of final) {
      if (!p.endsWith('.mps')) continue;
      const old = live.entries.get(p);
      if (!old || !bytesEqual(world.blob(old.contentId), b)) continue;   // new bytes: the caller encoded them with the final schemas
      const again = reencodeForTarget(live, p, target, opts, warnings);
      if (again) { final.set(p, again); reencoded.push(p); }
    }
  }
  const db = world.backend.open(world.bytes);
  try {
    db.exec('BEGIN');
    const revId = maxOf(world.revisions.map((r) => r.id)) + 1, description = opts.description ?? 'Manual Save';
    db.run('INSERT INTO revisions (revision_id, description, created_at) VALUES (?, ?, ?)', [revId, description, t]);
    const blobs = new BlobWriter(db, opts.zstd, true), folders = new FolderWriter(db, world.folders.values(), t);
    let fileId = maxOf(world.rows.map((r) => r.id)) + 1;
    const written: string[] = [], deleted: string[] = [];
    for (const [p, r] of live.entries) {
      if (final.has(p)) continue;
      db.run('UPDATE files SET deleted_at = ? WHERE file_id = ?', [t, r.id]);
      deleted.push(p);
    }
    for (const [p, content] of final) {
      const old = live.entries.get(p);
      if (old && bytesEqual(world.blob(old.contentId), content)) continue;
      if (old) db.run('UPDATE files SET deleted_at = ? WHERE file_id = ?', [t, old.id]);
      const dirs = p.split('/'), name = dirs.pop()!;
      const parent = folders.id(dirs), cid = blobs.id(content);
      db.run('INSERT INTO files (file_id, parent_id, name, content_id, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, NULL)', [fileId++, parent, name, cid, t]);
      written.push(p);
    }
    db.exec('COMMIT');
    return { bytes: db.export(), revision: { id: revId, description, createdAt: t }, written, deleted, reencoded, warnings: [...warnings] };
  } finally {
    db.close();
  }
}

/**
 * writeNewWorld without an SQL engine: the same rows and ids, written as a fresh SQLite file by the
 * pure-TS writer (sqlitewrite.ts), so the lite build can save worlds too. Blobs are raw unless an
 * encoder is given (the game loads raw blobs).
 */
export function writeNewWorldFile(files: ReadonlyMap<string, Uint8Array> | Iterable<[string, Uint8Array]>, opts: BrdbWriteOptions = {}): Uint8Array {
  const t = Math.floor(opts.when ?? nowSeconds());
  const blobs: [number, SqlValue[]][] = [], folders: [number, SqlValue[]][] = [], fileRows: [number, SqlValue[]][] = [];
  const blobIds = new Map<string, number>(), folderIds = new Map<string, number>();
  for (const [p, content] of entriesOf(files)) {
    const dirs = p.split('/'), name = dirs.pop()!;
    let parent: number | null = null;
    for (let i = 0; i < dirs.length; i++) {
      const key = dirs.slice(0, i + 1).join('/');
      let id = folderIds.get(key);
      if (id === undefined) { id = folders.length + 1; folders.push([id, [null, parent, dirs[i]!, t, null]]); folderIds.set(key, id); }
      parent = id;
    }
    const hash = blake3(content), key = content.length + ':' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    let cid = blobIds.get(key);
    if (cid === undefined) {
      const z = opts.zstd ? opts.zstd(content) : null;
      const [comp, body] = z && z.length < content.length ? [1, z] : [0, content];
      cid = blobs.length + 1;
      blobs.push([cid, [null, comp, content.length, body.length, null, hash, body]]);
      blobIds.set(key, cid);
    }
    fileRows.push([fileRows.length + 1, [null, parent, name, cid, t, null]]);
  }
  const [blobsT, blobsI, revT, foldersT, foldersI, filesT, filesI] = BRDB_CREATE as [string, string, string, string, string, string, string];
  return writeSqlite([
    { type: 'table', name: 'blobs', sql: blobsT, rows: blobs },
    { type: 'index', name: 'blobs_size_hash', table: 'blobs', sql: blobsI, columns: [2, 5] },
    { type: 'table', name: 'revisions', sql: revT, rows: [[1, [null, 'Initial Revision', t]], [2, [null, 'Manual Save', t]]] },
    { type: 'table', name: 'folders', sql: foldersT, rows: folders },
    { type: 'index', name: 'folders_parent_name_deleted', table: 'folders', sql: foldersI, columns: [1, 2, 4] },
    { type: 'table', name: 'files', sql: filesT, rows: fileRows },
    { type: 'index', name: 'files_parent_name_deleted', table: 'files', sql: filesI, columns: [1, 2, 5] },
  ]);
}
