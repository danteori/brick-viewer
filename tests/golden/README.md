# Goldens (local only)

`npm run golden:capture` renders the frozen `legacy/save-viewer.html` with reference saves read
from `BRICK_REFS` (default `../references`) and writes PNGs plus `manifest.json` here.

Those images show private saves, so everything in this folder except this README is git-ignored.
Phase 1 compares the new renderer against them.
