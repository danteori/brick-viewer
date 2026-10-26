# Shipped game assets

This file lists each asset that the app ships from the Brickadia game, and where it came from.
All assets come from the public release on Steam.

## Fonts

| File in this repo | Source in the game | Game version |
|---|---|---|
| `public/fonts/GlacialIndifference-Regular.otf` | `Brickadia-Windows.pak`: `Brickadia/Content/UI/Shared/Fonts/GlacialIndifference/GlacialIndifference-Regular.ufont` | Release-EA3-CL-16374 (Steam build 26049822) |
| `public/fonts/GlacialIndifference-Bold.otf` | `Brickadia-Windows.pak`: `Brickadia/Content/UI/Shared/Fonts/GlacialIndifference/GlacialIndifference-Bold.ufont` | Release-EA3-CL-16374 (Steam build 26049822) |

- **Font:** Glacial Indifference, Copyright (c) 2015 Alfredo Marco Pradil, with Reserved Font Name "Glacial Indifference".
- **Licence:** SIL Open Font License 1.1. The full text is in `public/fonts/OFL.txt`, next to the fonts.
- **How we got the files:** a `.ufont` file holds a 32-bit length, then the OpenType font. We removed the length and kept the font bytes.
- **Changes:** none. Because of the Reserved Font Name, we ship the files unchanged: no subsetting and no format conversion.
- **Where the app uses them:** the window font (`--br-font` in `src/ui/styles.css`). Only the full build loads them (`src/ui/fonts.css`). The lite build uses the fallback fonts in the same stack.
