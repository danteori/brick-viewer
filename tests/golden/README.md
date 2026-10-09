# Goldens (local only)

`npm run golden:capture` renders the 3D view of the frozen `legacy/save-viewer.html` (UI panels and
the editor ghost hidden) with reference saves read from `BRICK_REFS` (default `../references`) and
writes PNGs plus `manifest.json` here. `npm run golden:capture -- --target full` (or `lite`) renders
the built app the same way into `full/` (or `lite/`), and `npm run golden:compare -- --target full`
checks it against the goldens (at most 2/255 on at least 99.9 % of pixels per shot).
`--against <folder> --tol <n> --need <fraction>` compares with another capture in this folder
instead (e.g. a capture of the previous build, `--tol 0 --need 1` for exact identity).

Capture every save in one run: a save's framing depends on the scene shown before it, so a
capture of a single save (the filter argument) only compares with another single-save capture.

Those images show private saves, so everything in this folder except this README is git-ignored.
