// The ONLY file allowed to read __LITE__ (an ESLint rule enforces this). Everything else asks
// this module which features are on, so lite never imports the full-only modules and
// tree-shaking drops them (ARCHITECTURE.md section 2).

import type { SqlBackend } from '../format/sql.ts';

declare const __LITE__: boolean;

// The dev server serves both entries from one config, so there lite.html opts in by its path.
// In builds import.meta.env.DEV is false and this folds to the constant.
export const IS_LITE: boolean =
  __LITE__ || (import.meta.env.DEV && typeof location !== 'undefined' && location.pathname.endsWith('/lite.html'));

export interface FeatureFlags {
  /** .brz read with fzstd bundled (works offline). */
  brzRead: boolean;
  /** .brz write, raw (method 0). */
  brzWriteRaw: boolean;
  /** .brz write with zstd (lazy wasm). */
  brzWriteZstd: boolean;
  /** .brdb write and the sql.js read fallback (lazy wasm; full only). */
  brdb: boolean;
  /**
   * .brdb read through the lazy page reader (src/format/brdblazy.ts, no wasm, ~22 KB min / ~8 KB
   * gzip): open a world and its revisions in both builds.
   */
  brdbRead: boolean;
  /** HDR pipeline: shadows, SSAO, bloom, AA, sky; quality tiers. */
  hdr: boolean;
  /**
   * Environment settings panel (src/ui/panels/environment.ts, ~13 KB min / ~4 KB gzip on top of
   * the environment format + lighting, which both builds use to light a world as saved).
   */
  environmentPanel: boolean;
  /** Palette + paint tool docked in Brick Properties (both builds). */
  paint: boolean;
  /** Top-down map with click-to-focus (module worker + 2D canvas; full only). */
  mapPanel: boolean;
}

/**
 * The lazy SQLite backend for .brdb worlds, or null in lite. Load full-only modules through
 * IS_LITE-gated exports like this one: the bundler folds IS_LITE to a constant and drops the
 * import from lite, but it can't see through FEATURES.x (a property of a frozen object), so
 * `if (FEATURES.brdb) import(...)` would still pull sql.js and its wasm into the lite file.
 */
export const loadBrdbBackend: (() => Promise<SqlBackend>) | null = IS_LITE
  ? null
  : () => import('../format/sqljs.ts').then((m) => m.loadSqlJs());

/**
 * The full build's extra UI (src/app/full-ui.ts: the Environment panel, .brdb worlds with revisions
 * and dynamic grids, save as a new world, and the Map with its tile worker), or null in lite.
 */
export const loadFullUi: (() => Promise<{ mountFullUi(): void }>) | null = IS_LITE
  ? null
  : () => import('./full-ui.ts');

/**
 * Hidden-face culling (src/render/facecull.ts + scene/cull.ts, ~9 KB min), or null in lite: it
 * saves GPU work on big builds, which the lite build's size budget can't afford to carry.
 */
export const loadFaceCull: (() => Promise<{ initFaceCull(): void }>) | null = IS_LITE
  ? null
  : () => import('../render/facecull.ts');

export const FEATURES: Readonly<FeatureFlags> = Object.freeze({
  brzRead: true,
  brzWriteRaw: true,
  brzWriteZstd: !IS_LITE,
  brdb: !IS_LITE,
  brdbRead: true,
  hdr: !IS_LITE,
  environmentPanel: !IS_LITE,
  paint: true,
  mapPanel: !IS_LITE,
});
