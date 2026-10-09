// The SQLite interface the .brdb code needs, so the format layer doesn't depend on one engine.
// sqljs.ts adapts sql.js (wasm; full build only, loaded lazily). Tests use the same adapter in Node.

/** A value bound to or read from SQLite. BLOBs are Uint8Array. */
export type SqlValue = number | bigint | string | Uint8Array | null;

/** One open, in-memory SQLite database. */
export interface SqlDb {
  /** Runs one statement and returns its rows, each in column order. */
  query(sql: string, params?: readonly SqlValue[]): SqlValue[][];
  /** Runs one statement that returns nothing. Statements are cached, so call it in loops freely. */
  run(sql: string, params?: readonly SqlValue[]): void;
  /** Runs several statements with no parameters. */
  exec(sql: string): void;
  /** The database file as bytes. */
  export(): Uint8Array;
  close(): void;
}

export interface SqlBackend {
  /** Opens a copy of a database file, or a new empty database. The input bytes are never changed. */
  open(bytes?: Uint8Array): SqlDb;
}
