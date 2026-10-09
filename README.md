# Brick Viewer

A browser viewer and editor for `.brz` brick-building save files. It reads saves locally, in
your browser; nothing is uploaded.

> **Not affiliated with or endorsed by Brickadia.** This is an independent fan project. It
> contains no Brickadia logos, artwork, sounds or other game assets. Brick shapes are
> approximated from public specs and screenshots.

**Status:** early. The new TypeScript/WebGL2 app is being built. Until it reaches parity, the
current single-file viewer lives at [`legacy/save-viewer.html`](legacy/save-viewer.html) and is
also published next to the app.

## Run it

Needs Node.js 24 (LTS) and npm.

```sh
npm install
npm run dev        # http://localhost:5173  (lite entry: http://localhost:5173/lite.html)
```

## Build

```sh
npm run build        # both builds
npm run build:full   # dist/       multi-file app
npm run build:lite   # dist-lite/  brick-viewer.html, one self-contained file (works offline)
npm run size         # lite size budget (300 KB)
npm run site         # site/ = what GitHub Pages serves: /, /lite/brick-viewer.html, /legacy/save-viewer.html
```

## Test

```sh
npm run lint
npm test             # Vitest unit tests
npx playwright install chromium && npx playwright test   # smoke tests in Chromium
```

Some tests run against real save files. Those aren't in this repository: point `BRICK_REFS` at a
folder with a `saves/` subfolder (default `../references`). Without it those tests are skipped.

The `.brdb` world tests also cross-check against Python's `sqlite3` through
`scripts/check_brdb.py` (skipped without Python). To soak-test the world reader on your own
worlds, copy some `.brdb` files into a folder and point `BRICK_WORLDS` at it (they're only read).

`npm run golden:capture` renders reference screenshots of the legacy viewer with Playwright into
`tests/golden/`. They show whatever saves you have locally, so that folder is git-ignored. Pick
the saves in `golden.config.json` (also git-ignored; see the script header).

## Layout

| Path | What |
|---|---|
| `src/format/` | DOM-free save format code: MessagePack, BLAKE3, `.schema`/`.mps`, `.brz` read/write, bricks to and from save chunks, `.brdb` worlds (revisions, schema-at-time decoding, new-world and append-revision writers, stale-schema re-encoding), entities |
| `src/scene/` | Scene data: brick grids placed in the world by their entities (`grids.ts`) |
| `src/core/` | Shared maths, e.g. the orientation byte to rotation table |
| `src/app/` | Entry points (`main.full.ts`, `main.lite.ts`) and `features.ts`, the only file that may read the `__LITE__` build flag |
| `legacy/` | The frozen single-file viewer: the pixel reference for the port and the WebGL1 fallback |
| `tests/unit/`, `tests/e2e/` | Vitest and Playwright tests |

## Third-party code

- [fzstd](https://github.com/101arrowz/fzstd) (MIT, Copyright (c) 2020 Arjun Barrett) decodes
  zstd. It's bundled in both builds and inlined in `legacy/save-viewer.html`, with its licence
  notice.
- [sql.js](https://github.com/sql-js/sql.js) (MIT, Copyright (c) 2017 sql.js authors) runs
  SQLite (public domain) as wasm to read and write `.brdb` worlds. Full build only, loaded on
  demand; the lite build doesn't contain it.

## Licence

MIT; see [LICENSE](LICENSE). Bundled third-party code keeps its own licence (fzstd, sql.js: MIT).
