// sql.js (MIT; SQLite is public domain) behind the SqlBackend interface. This is the only module
// that imports sql.js, and nothing imports it statically: load it with
//   const { loadSqlJs } = await import('../format/sqljs.ts');
// from code that runs only when FEATURES.brdb is on, so the lite build never contains it.
// In the full build Vite emits the wasm as a hashed same-origin asset (the ?url import below).

import type { BindParams, Database, SqlJsStatic, Statement } from 'sql.js';
import type { SqlBackend, SqlDb, SqlValue } from './sql.ts';

export interface SqlJsOptions {
  /** The wasm bytes, e.g. read from node_modules in Node. Without it the hashed asset URL is fetched. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Where to fetch the wasm from instead of the bundled asset. */
  wasmUrl?: string;
}

let cached: Promise<SqlJsStatic> | null = null;

async function init(opts: SqlJsOptions): Promise<SqlJsStatic> {
  const { default: initSqlJs } = await import('sql.js');
  if (opts.wasmBinary) {
    const bin = opts.wasmBinary instanceof Uint8Array ? opts.wasmBinary : new Uint8Array(opts.wasmBinary);
    return initSqlJs({ wasmBinary: bin.slice().buffer });
  }
  const url = opts.wasmUrl ?? (await import('sql.js/dist/sql-wasm-browser.wasm?url')).default;
  return initSqlJs({ locateFile: () => url });
}

const bindable = (params: readonly SqlValue[]): BindParams =>
  params.map((p) => (typeof p === 'bigint' ? Number(p) : p)) as BindParams;

class SqlJsDb implements SqlDb {
  private readonly stmts = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private stmt(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  query(sql: string, params: readonly SqlValue[] = []): SqlValue[][] {
    const s = this.stmt(sql), rows: SqlValue[][] = [];
    try {
      s.bind(bindable(params));
      while (s.step()) rows.push(s.get() as SqlValue[]);
    } finally {
      s.reset();
    }
    return rows;
  }

  run(sql: string, params: readonly SqlValue[] = []): void {
    const s = this.stmt(sql);
    try {
      s.bind(bindable(params));
      s.step();
    } finally {
      s.reset();
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  export(): Uint8Array {
    this.freeStatements();   // sql.js's export() needs no open statements
    return this.db.export();
  }

  close(): void {
    this.freeStatements();
    this.db.close();
  }

  private freeStatements(): void {
    for (const s of this.stmts.values()) s.free();
    this.stmts.clear();
  }
}

/** Loads sql.js once (later calls reuse it) and returns a backend. */
export async function loadSqlJs(opts: SqlJsOptions = {}): Promise<SqlBackend> {
  cached ??= init(opts);
  const SQL = await cached.catch((e: unknown) => { cached = null; throw e; });
  return { open: (bytes?: Uint8Array): SqlDb => new SqlJsDb(new SQL.Database(bytes ?? null)) };
}
