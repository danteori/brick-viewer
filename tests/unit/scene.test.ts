import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brickName, fmtUnits, parseUnits } from '../../src/ui/names.ts';
import { brickFlags, rampDir, sizeRule, turnOrient, type Brick } from '../../src/scene/brick.ts';
import { RAMP_VERTS, rampMesh } from '../../src/render/meshes/ramp.ts';
import { lightFromBp } from '../../src/format/bp.ts';
import { readBrz } from '../../src/format/brz.ts';
import { bricksFromFiles } from '../../src/scene/load.ts';
import { hasRefs, REFS, referenceSaves } from './refs.ts';

describe('names', () => {
  it('names stud bricks by studs and bricks + plates', () => {
    expect(brickName(2, 2, 3)).toBe('2x2');
    expect(brickName(1, 6, 1)).toBe('1x6f');
    expect(brickName(2, 2, 2)).toBe('2x2x0+2f');
    expect(brickName(2, 2, 6)).toBe('2x2x2');
    expect(brickName(2, 2, 5)).toBe('2x2 Cube');
  });
  it('round-trips height labels on the plate axis', () => {
    for (const n of [1, 2, 3, 4, 5, 7, 30]) expect(parseUnits(2, fmtUnits(2, n))).toBe(n);
    expect(parseUnits(2, '1+2')).toBe(5);
    expect(parseUnits(2, '2')).toBe(6);
    expect(parseUnits(0, '4')).toBe(4);
  });
});

describe('brick rules', () => {
  it('maps ramp rotations to lip directions', () => {
    expect([16, 17, 18, 19].map(rampDir)).toEqual([{ run: 0, lip: 1 }, { run: 1, lip: 1 }, { run: 0, lip: -1 }, { run: 1, lip: -1 }]);
  });
  it('turns orientation bytes a quarter at a time', () => {
    for (let o = 0; o < 24; o++) {
      let t = o;
      for (let k = 0; k < 4; k++) t = turnOrient(t);
      expect(t).toBe(o);
    }
    expect(turnOrient(16)).toBe(17);
  });
  it('gives plates along the stud axis and a 2-stud ramp run', () => {
    const b: Brick = { lo: [0, 0, 0], hi: [1, 1, 1], micro: false, color: [1, 1, 1], up: 1 };
    expect(sizeRule(b).steps).toEqual([0.2, 0.2, 0.08]);
    expect(sizeRule({ ...b, shape: 'ramp', run: 1, lip: 1 }).min).toEqual([1, 2, 1]);
    expect(brickFlags({ ...b, top: 'smooth' })).toEqual([0, 1, 1, 1]);
    expect(brickFlags({ ...b, micro: true })).toEqual([0, 0, 1, 0]);
  });
  it('builds ramp meshes of 16 triangles', () => {
    expect(rampMesh([0.4, 0.4, 0.24], 0, 1, 1).length).toBe(RAMP_VERTS * 7);
  });
});

describe('environment presets', () => {
  it('reads a .bp sky group', () => {
    const p = lightFromBp({ data: { groups: { Sky: { timeOfDay: 12, sunlightColor: { r: 1, g: 1, b: 1 }, skyColor: { r: 0.5, g: 0.5, b: 0.5 } } } } });
    expect(p.exposure).toBe(0.93);
    expect(p.sun[0]).toBeCloseTo(7.567 / 0.81, 3);
    expect(() => lightFromBp({})).toThrow(/environment preset/);
  });
});

describe.skipIf(!hasRefs)('loading reference saves', () => {
  it('turns every readable save into bricks with boxes', () => {
    let any = 0;
    for (const rel of referenceSaves()) {
      let files;
      try { files = readBrz(readFileSync(join(REFS, rel))); } catch { continue; }
      let out;
      try { out = bricksFromFiles(files); } catch { continue; }
      for (const b of out.bricks) for (let i = 0; i < 3; i++) expect(b.hi[i]).toBeGreaterThan(b.lo[i]);
      any += out.bricks.length;
    }
    expect(any).toBeGreaterThan(0);
  });
});
