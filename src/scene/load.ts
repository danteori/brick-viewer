// Loading a .brz into the scene (ported from the legacy viewer's loadSave). The format layer reads
// the container and the grid's chunks (src/format); this turns each save brick into a viewer brick
// with its world box, shape and display colour, and swaps the scene in as one undoable step.

import { S } from '../app/state.ts';
import { BrickShapes } from '../render/meshes/shapes.js';
import { readBrz, type FileMap } from '../format/brz.ts';
import { extractBricks } from '../format/world.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { linearByteToSrgb } from '../core/colour.ts';
import { rampDir, sideCode, type Brick, type V3 } from './brick.ts';
import { roundHalf } from '../render/meshes/registry.ts';
import { histEnd, histPush, sceneSnap } from './history.ts';
import { instAll } from '../render/instances.ts';
import { selectBrick } from '../editor/resize.ts';
import { fitHalf, ZOOM_MAX } from '../render/camera.ts';
import { setStatus } from '../ui/status.ts';

export interface LoadReport { name: string; drawn: number; skipped: number; skippedTypes: Record<string, number>; sideways: number; extraGrids: number }

/** Save files -> viewer bricks of grid 1 (other grids are physics entities, not shown yet). */
export function bricksFromFiles(files: FileMap): { bricks: Brick[]; report: Omit<LoadReport, 'name' | 'drawn'> } {
  const out: Brick[] = [], skippedTypes: Record<string, number> = {};
  let skipped = 0, sideways = 0, extraGrids = 0;
  const grids = [...new Set([...files.keys()].map((k) => k.match(/^World\/0\/Bricks\/Grids\/([^/]+)\//)?.[1]).filter(Boolean))];
  for (const g of grids) if (g !== '1') extraGrids++;
  if (grids.includes('1')) {
    const { bricks, linear } = extractBricks(files);
    bricks.forEach((pb, i) => {
      const asset = pb.asset, procedural = pb.size !== null;
      const isMicro = procedural && /MicroBrick$/i.test(asset), isBrick = procedural && /DefaultBrick$/.test(asset);
      const isTile = procedural && /DefaultSmoothTile$/.test(asset);   // a stud brick with a smooth top
      const isPlain = procedural && /DefaultTile$/.test(asset);         // a stud brick with a plain, bevelled top
      const isRamp = procedural && /DefaultRamp$/.test(asset);          // (RampInverted is a special shape)
      const isCrest = procedural && /DefaultRampCrest$/.test(asset), isCrestEnd = procedural && /DefaultRampCrestEnd$/.test(asset);
      // fixed-asset (B_*) rounds / cones: no size in the save, the generator gives their half-extents
      const basic = procedural ? null : asset;
      const isRound = !!basic && BrickShapes.isRound(basic);
      const isMicroShape = procedural && !isMicro && BrickShapes.isMicro(asset), isSpecial = procedural && BrickShapes.isSpecial(asset);
      if (!isRound && (!procedural || !(isMicro || isBrick || isTile || isPlain || isMicroShape || isSpecial))) {
        skipped++; const k = asset || 'unknown'; skippedTypes[k] = (skippedTypes[k] || 0) + 1; return;
      }
      // World box from the verified orientation rule: h[i] = sum_j |M[i][j]| s[j].
      const o = pb.orient, M = BrickShapes.brickOrient(o), dir = (o >> 2) % 6;
      const s = isRound ? roundHalf(basic!) : pb.size!;
      const half = [0, 1, 2].map((r) => Math.abs(M[r][0]) * s[0] + Math.abs(M[r][1]) * s[1] + Math.abs(M[r][2]) * s[2]);
      const up = dir === 4 ? 1 : dir === 5 ? -1 : 0;
      if (!up) sideways++;
      // Ramps / crests upright or upside down keep their world-frame meshes; sideways they're special shapes.
      const shape: Partial<Brick> = isRamp && up ? { shape: 'ramp', ...rampDir(o) }
        : isCrest && up ? { shape: 'crest', ...BrickShapes.crestDir(o) }
          : isCrestEnd && up ? { shape: 'crestEnd', ...BrickShapes.crestEndDir(o) }
            : isRound ? { shape: 'round', round: basic!, ...(up ? {} : { o }) }
              : isMicroShape ? { shape: 'micro', asset, o }
                : isSpecial ? { shape: 'special', asset, o } : {};
      if (!up) shape.side = sideCode(o);
      const pos = pb.pos, col = pb.color;
      // The stored bytes are sRGB-encoded (bColorsAreLinear = false); bricks keep display (sRGB)
      // colours and the shader decodes them. Saves from before CL14860 store LINEAR bytes, so those
      // get the sRGB OETF applied first. The A byte is not colour.
      const toS = linear[i] ? linearByteToSrgb : (v: number): number => v / 255;
      out.push({
        lo: pos.map((v, a) => +((v - half[a]) * BRZ_UNIT).toFixed(3)) as V3,
        hi: pos.map((v, a) => +((v + half[a]) * BRZ_UNIT).toFixed(3)) as V3,
        micro: !!(isMicro || isMicroShape), tile: !!isTile, top: isTile ? 'smooth' : isPlain ? 'plain' : 'studs', color: [toS(col[0]), toS(col[1]), toS(col[2])], up,
        material: pb.material,
        ...shape,
      });
    });
  }
  return { bricks: out, report: { skipped, skippedTypes, sideways, extraGrids } };
}

export let lastLoad: LoadReport | null = null;

/** Read a .brz and make it the scene, framed around its first brick. One undo step. */
export function loadSave(buf: ArrayBuffer | Uint8Array, name: string): LoadReport {
  for (const f of S.hooks.beforeLoad) f();
  const files = readBrz(buf);
  const { bricks: out, report } = bricksFromFiles(files);
  if (!out.length) throw new Error('no supported bricks in this save');
  histEnd();
  const prevScene = sceneSnap();
  S.bricks.length = 0; S.bricks.push(...out);
  S.histOrigin = [0, 0, 0];                    // a new scene starts its own frame
  instAll();
  selectBrick(0);
  // frame the whole save around the focused brick
  const { lo, hi, bricks } = S;
  const sl = [0, 1, 2].map((i) => Math.min(...bricks.map((b) => b.lo[i]))), sh = [0, 1, 2].map((i) => Math.max(...bricks.map((b) => b.hi[i])));
  const c = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2), r = [0, 1, 2].map((i) => Math.max(c[i] - sl[i], sh[i] - c[i]));
  S.zoomMul = Math.min(ZOOM_MAX, Math.max(1, fitHalf(c.map((v, i) => v - r[i]), c.map((v, i) => v + r[i])) / fitHalf(lo, hi)));
  histPush({ kind: 'scene', label: 'load save', before: prevScene, after: sceneSnap() });
  lastLoad = { name, drawn: out.length, ...report };
  const { skipped, skippedTypes, sideways, extraGrids } = report;
  const notes = [skipped && `${skipped} unsupported skipped (${Object.entries(skippedTypes).map(([k, n]) => `${k.replace(/^(PB|BP|B)_(Default)?/, '')} ${n}`).join(', ')})`,
    sideways && `${sideways} sideways`,
    extraGrids && `${extraGrids} moving grid(s) not shown yet`].filter(Boolean);
  setStatus(`${name}: ${out.length} brick${out.length === 1 ? '' : 's'}${notes.length ? ' · ' + notes.join(' · ') : ''}`);
  for (const f of S.hooks.loaded) f();
  return lastLoad;
}
