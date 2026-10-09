// Hidden-face culling timings (S-02). Opt-in, like bigworlds.test.ts: point BRICK_BIG_WORLDS at a
// folder of .brz files (worlds converted with `python tools/brdb.py brdb2brz` into a temp folder).
// Prints one line per save plus a synthetic 500k-brick scene; nothing about the saves is stored.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBrz } from '../../src/format/brz.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { buildWorldModel, gridBricks } from '../../src/scene/grids.ts';
import { FaceCuller, cullBrickOf, type CullBrick } from '../../src/scene/cull.ts';

const DIR = process.env.BRICK_BIG_WORLDS;
const worlds = DIR && existsSync(DIR) ? readdirSync(DIR).filter((n) => n.endsWith('.brz')).sort().map((n) => join(DIR, n)) : [];
const pct = (a: number, b: number): string => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;

function report(name: string, bricks: CullBrick[]): number {
  let t = performance.now();
  const c = new FaceCuller(bricks);
  const ms = performance.now() - t, s = c.stats();
  // a typical edit: one brick moved by a stud, then updateAround
  const id = Math.floor(bricks.length / 2), b = bricks[id]!;
  t = performance.now();
  c.set(id, { ...b, pos: [b.pos[0] + 10, b.pos[1], b.pos[2]] });
  c.updateAround([id]);
  const editMs = performance.now() - t;
  console.log([name, `bricks ${s.bricks}`, `occluders ${s.occluders} (${pct(s.occluders, s.bricks)})`,
    `hidden faces ${s.hiddenFaces} (${pct(s.hiddenFaces, s.faces)} of all, ${pct(s.hiddenFaces, s.occluders * 6)} of box faces)`,
    `hidden bricks ${s.hiddenBricks} (${pct(s.hiddenBricks, s.bricks)})`, `full ${ms.toFixed(0)} ms`, `edit ${editMs.toFixed(2)} ms`].join(' | '));
  return ms;
}

describe.skipIf(!worlds.length)('cull on big worlds (BRICK_BIG_WORLDS)', () => {
  it.each(worlds)('%s', (path) => {
    const view = fileMapView(readBrz(new Uint8Array(readFileSync(path))));
    const model = buildWorldModel(view), bricks: CullBrick[] = [];
    let unread = 0;
    for (const g of model.grids) {
      try { for (const b of gridBricks(view, g)) bricks.push(cullBrickOf(b, g.id)); } catch { unread++; }   // older chunk layouts
    }
    if (bricks.length) report(`${basename(path)} (${model.grids.length} grids${unread ? `, ${unread} unreadable` : ''})`, bricks);
  });

  it('synthetic 500k bricks', () => {
    // a 100 x 100 x 50 block of 1x1 bricks with every 7th brick glass and every 11th a ramp
    const bricks: CullBrick[] = [];
    let k = 0;
    for (let z = 0; z < 50; z++) for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++, k++)
      bricks.push({ pos: [x * 10, y * 10, z * 12], half: [5, 5, 6], shape: k % 11 ? 'box' : 'ramp', fullBox: k % 11 !== 0, material: k % 7 ? 'BMC_Plastic' : 'BMC_Glass' });
    expect(report('synthetic 500k', bricks)).toBeLessThan(2000);
  });
});
