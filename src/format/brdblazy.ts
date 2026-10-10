// A .brdb world read lazily through sqlitelazy.ts (backlog S-08): the revisions and the
// folder / file tree are read at open (a few MB even for big worlds), blob contents only when a
// file is asked for. Nothing is copied whole into memory and no wasm is needed.
//
//   const w = await LazyBrdbWorld.open(blobSource(file));
//   const tree = w.tree();                        // a BrdbTree (SaveView): paths and rows, no contents yet
//   const model = await buildWorldModelLazy(tree);  // scene/grids.ts: reads only chunk indexes and entity chunks
//   await tree.load([chunkPath]);                 // then tree.get(chunkPath) works as with BrdbTree
//
// Contents stay loaded until unload() / clearCache(); the caller (S-10's residency manager)
// decides what to keep. get() on a file that isn't loaded throws NotLoadedError; runLoaded()
// wraps any synchronous SaveView consumer and loads what it asks for as it goes.

import { BRDB_CREATE, BrdbFileTable, BrdbTree, decodeBlob, type BrdbFileRow, type BrdbOpenOptions } from './brdb.ts';
import type { FileMap } from './brz.ts';
import { GLOBAL_MPS, GLOBAL_SCHEMA, schemaPathIn, type SaveView } from './saveview.ts';
import type { SqlValue } from './sql.ts';
import { LazySqlite, type LazyRow, type LazySqliteOptions, type RandomAccessSource, type TableInfo } from './sqlitelazy.ts';

/** What is known about a blob without reading its content row. Null = not read yet. */
export interface LazyBlobInfo {
  id: number;
  compression: number | null;
  sizeUncompressed: number | null;
  sizeCompressed: number | null;
  deltaBaseId: number | null;
  hash: Uint8Array | null;
}

export interface LazyBrdbOptions extends BrdbOpenOptions, LazySqliteOptions {
  /**
   * Blob metadata read at open. 'index' (default): every blob's uncompressed size and hash from
   * the dense blobs_size_hash index; compression and stored size arrive when a blob is read.
   * 'table': every column but content from the blobs table's b-tree pages (no overflow pages,
   * but the leaves sit between the overflow pages, so it reads more). 'none': nothing up front.
   */
  blobMeta?: 'index' | 'table' | 'none';
  /** Blob rows read at once by load() (default 8). */
  concurrency?: number;
}

/** get() / blob() on content that hasn't been loaded. */
export class NotLoadedError extends Error {
  constructor(readonly blobId: number, readonly path?: string) {
    super(`.brdb: blob ${blobId}${path ? ` (${path})` : ''} is not loaded; await load() first`);
    this.name = 'NotLoadedError';
  }
}

const COLS = {
  revisions: ['revision_id', 'description', 'created_at'],
  folders: ['folder_id', 'parent_id', 'name', 'created_at', 'deleted_at'],
  files: ['file_id', 'parent_id', 'name', 'content_id', 'created_at', 'deleted_at'],
  blobs: ['blob_id', 'compression', 'size_uncompressed', 'size_compressed', 'delta_base_id', 'hash', 'content'],
} as const;

const toNum = (v: SqlValue | undefined): number | null => (v === null || v === undefined ? null : typeof v === 'bigint' ? Number(v) : Number(v));

function columnsOf(t: TableInfo, names: readonly string[]): number[] {
  return names.map((n) => {
    const i = t.columns.findIndex((c) => c.toLowerCase() === n);
    if (i < 0) throw new Error(`.brdb: table ${t.name} has no column ${n}`);
    return i;
  });
}

/** Every row of a table, picked to the given columns (columns stored on overflow pages are read too). */
async function readTable(db: LazySqlite, name: keyof typeof COLS): Promise<SqlValue[][]> {
  const t = db.table(name), idx = columnsOf(t, COLS[name]), out: SqlValue[][] = [], late: [LazyRow, SqlValue[]][] = [];
  await db.scan(t, (r) => {
    const v = idx.map((i) => r.values[i]);
    if (v.some((x) => x === undefined)) late.push([r, v as SqlValue[]]);
    out.push(v as SqlValue[]);
  });
  for (const [r, v] of late) for (let k = 0; k < idx.length; k++) if (v[k] === undefined) v[k] = await db.column(r, idx[k]!);
  return out;
}

/** A .brdb opened lazily. Read-only: nothing is ever written to the source. */
export class LazyBrdbWorld extends BrdbFileTable {
  /** Blob metadata known so far (see LazyBrdbOptions.blobMeta). */
  readonly blobs = new Map<number, LazyBlobInfo>();
  /** True when sqlite_master holds exactly the game's CREATE statements (columns are found by name either way). */
  readonly schemaMatches: boolean;
  private readonly loaded = new Map<number, Uint8Array>();
  private readonly pending = new Map<number, Promise<Uint8Array>>();
  private readonly blobsTable: TableInfo;
  private readonly blobCols: number[];
  private loadedBytes = 0;

  private constructor(readonly db: LazySqlite, raw: { revisions: SqlValue[][]; folders: SqlValue[][]; files: SqlValue[][] }, private readonly opts: LazyBrdbOptions) {
    super(raw);
    this.blobsTable = db.table('blobs');
    this.blobCols = columnsOf(this.blobsTable, COLS.blobs);
    const sql = db.master.filter((m) => m.sql !== null && !m.name.startsWith('sqlite_')).map((m) => m.sql);
    this.schemaMatches = sql.length === BRDB_CREATE.length && sql.every((s, i) => s === BRDB_CREATE[i]);
  }

  /** Opens a world: header, sqlite_master, revisions, folders, files, and blob metadata per opts.blobMeta. */
  static async open(source: RandomAccessSource, opts: LazyBrdbOptions = {}): Promise<LazyBrdbWorld> {
    const db = await LazySqlite.open(source, opts);
    const byId = (rows: SqlValue[][]): SqlValue[][] => rows.sort((a, b) => toNum(a[0])! - toNum(b[0])!);
    const raw = {
      revisions: byId(await readTable(db, 'revisions')),
      folders: byId(await readTable(db, 'folders')),
      files: byId(await readTable(db, 'files')),
    };
    const w = new LazyBrdbWorld(db, raw, opts);
    await w.readBlobMeta(opts.blobMeta ?? 'index');
    return w;
  }

  private async readBlobMeta(mode: 'index' | 'table' | 'none'): Promise<void> {
    if (mode === 'none') return;
    const ix = mode === 'index' ? this.db.index('blobs_size_hash') : null;
    if (ix && ix.table === 'blobs' && ix.columns.join() === 'size_uncompressed,hash') {
      await this.db.scanIndex(ix, ([size, hash, rowid]) => {
        const id = toNum(rowid)!;
        this.blobs.set(id, { id, compression: null, sizeUncompressed: toNum(size), sizeCompressed: null, deltaBaseId: null, hash: hash instanceof Uint8Array ? hash : null });
      });
      return;
    }
    await this.db.scan(this.blobsTable, (r) => this.noteBlobRow(r));
  }

  private noteBlobRow(r: LazyRow): LazyBlobInfo {
    const [id, c, us, cs, d, h] = this.blobCols.map((i) => r.values[i]);
    const info: LazyBlobInfo = { id: toNum(id) ?? r.rowid, compression: toNum(c), sizeUncompressed: toNum(us), sizeCompressed: toNum(cs), deltaBaseId: toNum(d), hash: h instanceof Uint8Array ? h : null };
    this.blobs.set(info.id, info);
    return info;
  }

  /** Bytes fetched from the source so far, and other read counters. */
  get stats(): LazySqlite['stats'] & { loadedBlobs: number; loadedBytes: number; pageCacheBytes: number } {
    return { ...this.db.stats, loadedBlobs: this.loaded.size, loadedBytes: this.loadedBytes, pageCacheBytes: this.db.cachedBytes };
  }

  protected override blobMeta(id: number): { size: number | null; hash: Uint8Array | null } | undefined {
    const b = this.blobs.get(id);
    return b && { size: b.sizeUncompressed, hash: b.hash };
  }

  /** Uncompressed contents of a loaded blob; throws NotLoadedError otherwise. */
  blob(id: number): Uint8Array {
    const b = this.loaded.get(id);
    if (!b) throw new NotLoadedError(id);
    return b;
  }

  isLoaded(id: number): boolean {
    return this.loaded.has(id);
  }

  /** Reads one blob's row (b-tree descent plus its overflow chain), decompresses it and keeps it. */
  loadBlob(id: number): Promise<Uint8Array> {
    const hit = this.loaded.get(id);
    if (hit) return Promise.resolve(hit);
    let p = this.pending.get(id);
    if (!p) {
      p = (async () => {
        const row = await this.db.row(this.blobsTable, id);
        if (!row) throw new Error(`.brdb: missing blob ${id}`);
        const known = this.blobs.get(id), info = this.noteBlobRow(row);
        if (!info.hash && known?.hash) info.hash = known.hash;
        if (info.compression === null || info.sizeUncompressed === null) throw new Error(`.brdb: blob ${id} has no compression or size`);
        const stored = await this.db.column(row, this.blobCols[6]!);
        const bytes = decodeBlob({ ...info, compression: info.compression, sizeUncompressed: info.sizeUncompressed, sizeCompressed: info.sizeCompressed ?? 0 },
          stored instanceof Uint8Array ? stored : new Uint8Array(0), this.opts);
        this.loaded.set(id, bytes);
        this.loadedBytes += bytes.length;
        return bytes;
      })().finally(() => this.pending.delete(id));
      this.pending.set(id, p);
    }
    return p;
  }

  /** Loads several blobs, a few at a time. */
  async loadBlobs(ids: Iterable<number>): Promise<void> {
    const todo = [...new Set(ids)].filter((id) => !this.loaded.has(id));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) await this.loadBlob(todo[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(this.opts.concurrency ?? 8, todo.length) }, worker));
  }

  /** Forgets loaded contents (all of them without an argument). Pages stay in the page cache. */
  unloadBlobs(ids?: Iterable<number>): void {
    for (const id of ids ?? [...this.loaded.keys()]) {
      const b = this.loaded.get(id);
      if (b) { this.loadedBytes -= b.length; this.loaded.delete(id); }
    }
  }

  /** Forgets loaded contents and cached pages. */
  clearCache(): void {
    this.unloadBlobs();
    this.db.clearCache();
  }

  /** The live tree (deleted_at IS NULL), or the tree as of a revision. Contents load on demand. */
  tree(revisionId?: number): LazyBrdbTree {
    return new LazyBrdbTree(this, revisionId ?? null, this.treeRows(revisionId));
  }
}

/** A state of a lazily opened world's tree. A SaveView once the files it's asked for are loaded. */
export class LazyBrdbTree extends BrdbTree {
  constructor(readonly lazy: LazyBrdbWorld, revisionId: number | null, rows: readonly BrdbFileRow[]) {
    super(lazy, revisionId, rows);
  }

  override get(path: string): Uint8Array | undefined {
    const r = this.entries.get(path);
    if (!r) return undefined;
    if (!this.lazy.isLoaded(r.contentId)) throw new NotLoadedError(r.contentId, path);
    return this.lazy.blob(r.contentId);
  }

  isLoaded(path: string): boolean {
    const r = this.entries.get(path);
    return !!r && this.lazy.isLoaded(r.contentId);
  }

  /** Uncompressed size from the blob metadata, when known. */
  sizeOf(path: string): number | undefined {
    const r = this.entries.get(path);
    return r ? (this.lazy.blobs.get(r.contentId)?.sizeUncompressed ?? undefined) : undefined;
  }

  /** Bytes the content takes in the database (compressed), when known: after the blob was read, or with blobMeta 'table'. */
  storedSizeOf(path: string): number | undefined {
    const r = this.entries.get(path);
    return r ? (this.lazy.blobs.get(r.contentId)?.sizeCompressed ?? undefined) : undefined;
  }

  /** Loads the contents of these paths (paths not in the tree are ignored). */
  async load(paths: Iterable<string>): Promise<void> {
    const ids: number[] = [];
    for (const p of paths) { const r = this.entries.get(p); if (r) ids.push(r.contentId); }
    await this.lazy.loadBlobs(ids);
  }

  /** Loads .mps files together with the schema and GlobalData each was written with (what decodeWritten reads). */
  async loadWritten(mpsPaths: Iterable<string>): Promise<void> {
    const ids: number[] = [];
    for (const p of mpsPaths) {
      const r = this.entries.get(p);
      if (!r) continue;
      ids.push(r.contentId);
      for (const dep of [schemaPathIn(this, p), GLOBAL_MPS, GLOBAL_SCHEMA]) {
        const d = dep && this.world.rowAt(dep, r.createdAt);
        if (d) ids.push(d.contentId);
      }
    }
    await this.lazy.loadBlobs(ids);
  }

  /** Reads one file (loading it if needed). */
  async read(path: string): Promise<Uint8Array | undefined> {
    const r = this.entries.get(path);
    return r ? this.lazy.loadBlob(r.contentId) : undefined;
  }

  /** Loads every file of the tree and returns them (what BrdbTree.files() gives). */
  async loadAll(): Promise<FileMap> {
    await this.load(this.entries.keys());
    return this.files();
  }

  /** Forgets the contents of these paths. */
  unload(paths: Iterable<string>): void {
    const ids: number[] = [];
    for (const p of paths) { const r = this.entries.get(p); if (r) ids.push(r.contentId); }
    this.lazy.unloadBlobs(ids);
  }

  /**
   * The tree as a FileSource (paths / has / get / sizeOf / storedSizeOf), the shape the S-09
   * overview (overview.ts on feat/map) reads. get() needs the file loaded (use runLoaded).
   */
  fileSource(): { paths(): Iterable<string>; has(p: string): boolean; get(p: string): Uint8Array | undefined; sizeOf(p: string): number | undefined; storedSizeOf(p: string): number | undefined } {
    return { paths: () => this.entries.keys(), has: (p) => this.has(p), get: (p) => this.get(p), sizeOf: (p) => this.sizeOf(p), storedSizeOf: (p) => this.storedSizeOf(p) };
  }
}

const GRID_INDEX = /^World\/0\/Bricks\/Grids\/[^/]+\/ChunkIndex\.mps$/;
const ENTITY_FILES = /^World\/0\/Entities\/(ChunkIndex|Chunks\/[^/]+)\.mps$/;

/** The files an overview reads: every grid's ChunkIndex.mps and the entity index and chunks (no brick, component or wire chunk). */
export function overviewPaths(view: SaveView): string[] {
  return view.paths().filter((p) => GRID_INDEX.test(p) || ENTITY_FILES.test(p));
}

/**
 * Runs a synchronous SaveView consumer over a lazy tree, loading each file it asks for and
 * running it again until it finishes. Preload what it will need (load / loadWritten) so that is
 * one pass; this only catches the rest.
 */
export async function runLoaded<T>(tree: LazyBrdbTree, fn: (view: LazyBrdbTree) => T, maxRetries = 10_000): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return fn(tree);
    } catch (e) {
      if (!(e instanceof NotLoadedError) || i >= maxRetries) throw e;
      await tree.lazy.loadBlob(e.blobId);
    }
  }
}
