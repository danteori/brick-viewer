// The ONLY file allowed to read __LITE__ (an ESLint rule enforces this). Everything else asks
// this module which features are on, so lite never imports the full-only modules and
// tree-shaking drops them (ARCHITECTURE.md section 2).

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
  /** .brdb read / write (lazy sql.js). */
  brdb: boolean;
  /** HDR pipeline: shadows, SSAO, bloom, AA, sky; quality tiers. */
  hdr: boolean;
  /**
   * Environment settings panel (src/ui/panels/environment.ts, ~13 KB min / ~4 KB gzip on top of
   * the environment format + lighting, which both builds use to light a world as saved).
   */
  environmentPanel: boolean;
}

export const FEATURES: Readonly<FeatureFlags> = Object.freeze({
  brzRead: true,
  brzWriteRaw: true,
  brzWriteZstd: !IS_LITE,
  brdb: !IS_LITE,
  hdr: !IS_LITE,
  environmentPanel: !IS_LITE,
});
