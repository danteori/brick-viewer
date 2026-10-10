# Brick Viewer

A browser viewer and editor for `.brz` brick-building save files. It reads saves locally, in
your browser; nothing is uploaded.

> **Not affiliated with or endorsed by Brickadia.** This is an independent fan project. It
> contains no Brickadia logos, artwork, sounds or other game assets. Brick shapes are
> approximated from public specs and screenshots.

**Status:** the TypeScript/WebGL2 app has reached parity with the single-file viewer (camera,
resizing, typed sizes, lighting presets and `.bp` environments, every supported brick type in all
orientations, the editor with the Bricks catalogue, copy/paste, delete and undo/redo, and Brick
Properties with the colour wheel). It renders pixel-identically to it. The single-file viewer stays
at [`legacy/save-viewer.html`](legacy/save-viewer.html), published next to the app, for browsers
without WebGL2.

On top of that:

- **Save .brz:** download your edits, written back into the save you opened (uncompressed).
- **Selection:** Shift+click adds or removes a brick, Shift+drag box-selects (Ctrl+Shift+drag
  removes), Ctrl+A selects everything, Esc clears; select by colour or everything connected to the
  selection. Selected bricks are tinted and counted.
- **Move, copy, cut, paste, delete a selection:** M picks the selection up into the placement
  ghost (R turns it, PgUp / PgDn raise or lower a plate, it can't go into other bricks), Ctrl+C /
  Ctrl+X / Ctrl+V, Delete. Each is one undo step.
- **Paint:** a colour palette (upload your own palette `.bp`), material and intensity, with an
  eyedropper; paints the selection (or the focused brick), undoable.
- **Environment:** a world's own environment lights the scene and shows its ground plate; the full
  build adds an Environment panel for every sky, sun, cloud, fog, water and ground plate setting,
  with `.bp` load and save.
- **Worlds (full build):** open `.brdb` worlds, view any earlier revision, see moving grids
  (vehicles, doors) where they are parked (read-only), and save as a new world (experimental).
  **Compare** counts what the shown revision changed since the previous one (or any other): bricks
  added, removed and changed, component and wire totals, files; **Highlight** outlines those bricks.
- **Applicator:** change the brick type or the material of the selection (or the focused brick).
  Resizable types keep their size (only types whose size grid fits are applied), fixed types take their
  own size; changes that would overlap a brick are left out. One undo step, saved with Save .brz.
- **Map (full build):** a top-down map of the opened save; click it to jump to that spot.
- **Components and wires:** Brick Properties > Components lists the focused brick's components
  with an editor per setting (numbers, toggles, choices, text, colours, vectors, map entries,
  variant values), built from the save's own schema; add a component of a type the save uses, or
  remove one. **Wires (W)** draws the save's wires between port dots on the bricks; click an output
  dot, then an input dot, to connect them (one wire per input), or click a wire and press Delete.
  Every edit is one undo step, and saving writes them back.

**Under the hood:** the scene is one structure-of-arrays store in whole save units with stable
brick ids; it renders in chunks of instanced bricks (24 bytes each) positioned relative to the
camera, and every brick's orientation is applied in the shader, so all 24 orientations draw
through one path. Saving keeps components and wires pointing at their bricks.

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
npm run size         # lite size budget (450 KB)
npm run site         # site/ = what GitHub Pages serves: /, /lite/brick-viewer.html, /legacy/save-viewer.html
```

## Test

```sh
npm run lint
npm test             # Vitest unit tests
npx playwright install chromium && npx playwright test --workers=1   # end-to-end tests in Chromium
npm run build && node scripts/bench.mjs SAVE.brz   # frame times over a scripted orbit (GPU)
```

Some tests run against real save files. Those aren't in this repository: point `BRICK_REFS` at a
folder with a `saves/` subfolder (default `../references`). Without it those tests are skipped.

The `.brdb` world tests also cross-check against Python's `sqlite3` through
`scripts/check_brdb.py` (skipped without Python). To soak-test the world reader on your own
worlds, copy some `.brdb` files into a folder and point `BRICK_WORLDS` at it (they're only read).

`npm run golden:capture` renders reference screenshots of the legacy viewer's 3D view (UI panels
and the editor ghost hidden) with Playwright on SwiftShader into `tests/golden/`. They show
whatever saves you have locally, so that folder is git-ignored. Pick the saves in
`golden.config.json` (also git-ignored; see the script header). To check the app against them:

```sh
npm run build
npm run golden:capture -- --target full    # or lite; renders into tests/golden/full/
npm run golden:compare -- --target full    # pass: <= 2/255 on >= 99.9 % of pixels per shot
```

`tests/e2e/parity.spec.ts` runs the same mouse and keyboard script (resize drags, typed sizes,
copy/paste, catalogue placement, focus, delete, undo/redo) against the legacy viewer and the app and
compares the brick lists after every step; with `BRICK_REFS` set it also loads every reference save
in both and compares the results.

## Layout

| Path | What |
|---|---|
| `src/format/` | DOM-free save format code: MessagePack, BLAKE3, `.schema`/`.mps`, `.brz` read/write, bricks to and from save chunks, `.bp` environment presets, `.brdb` worlds (revisions, schema-at-time decoding, new-world and append-revision writers, stale-schema re-encoding), entities, colour palettes, the chunk-index overview and a lazy `.brz` reader |
| `src/core/` | Units, matrices, colour helpers and the orientation byte to rotation table |
| `src/scene/` | The brick record and its size rules, save loading and saving, picking / overlap grid, undo history, dynamic grids placed by their entities (`grids.ts`, `worldgrids.ts`) |
| `src/render/` | WebGL2 renderer: the brick shader (GLSL 3.00, tone map in the shader), instancing (every non-box shape drawn from one shared vertex table, one draw per vertex-count family), far LOD, camera, lighting, grid, ground plate, read-only extra bricks (moving grids), shape meshes; map tiles (`maptiles.ts`, `tileraster.ts`) |
| `src/env/` | Environment to lighting (the calibrated model) and the ground plate's look |
| `src/workers/` | The map tile worker, and the parse worker (full build: big saves are read and face-culled off the main thread) |
| `src/editor/` | Resizing, the placement ghost, catalogue data, copy/paste, place / delete, the paint model |
| `src/ui/` | Page markup and styles, panels (size, file, Brick Properties, catalogue, paint / palette, environment), dimension overlay, HUD, names, sounds |
| `src/app/` | Entry points (`main.full.ts`, `main.lite.ts`), `app.ts` (wiring and the frame loop), `state.ts` (the shared scene / camera state), the `?test` hook, `environment.ts` (the applied environment), `full-ui.ts` (full-build UI: environment panel, worlds, map; loaded lazily) and `features.ts`, the only file that may read the `__LITE__` build flag |
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
