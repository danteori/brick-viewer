import { describe, expect, it } from 'vitest';
import { readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { decodeMps, encodeMps, parseSchema, type MpsObject } from '../../src/format/schema.ts';
import { extractBricks } from '../../src/format/world.ts';
import { readEntities } from '../../src/format/entities.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { loadComponents } from '../../src/scene/components.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { importParts, mergeImport, placePos, prefabOffset } from '../../src/scene/importmerge.ts';
import { DYN, DYN_LOCATION, gridWorld, MAIN } from './gridworld.ts';
import { save as compSave } from './comp-fixture.ts';

const W = 'World/0/';

const owners = (f: FileMap): MpsObject => decodeMps(f.get(W + 'Owners.mps')!, parseSchema(f.get(W + 'Owners.schema')!));
const grid1 = (f: FileMap) => extractBricks(f).bricks;
const entities = (f: FileMap) => readEntities(fileMapView(f));

function withOwner(f: FileMap, id: { A: number; B: number; C: number; D: number }, name: string): FileMap {
  const out = new Map(f), s = parseSchema(f.get(W + 'Owners.schema')!), o = owners(f);
  o.UserIds = [id];
  o.UserNames = [name];
  out.set(W + 'Owners.mps', encodeMps(o, s));
  return out;
}

const gridOneWires = (f: FileMap) => loadWires(f).wires().filter((w) => w.source.grid === 1 && w.target.grid === 1);
const gridOneComponents = (f: FileMap) => loadComponents(f).instances.filter((c) => c.brickRef.grid === 1);

describe('import parts', () => {
  it('counts grid-1 bricks and dynamic grids, and finds the environment', () => {
    expect(importParts(gridWorld())).toEqual({ bricks: MAIN.length, entities: 1, environment: true, other: false });
    expect(importParts(gridWorld({ entityless: true }))).toMatchObject({ bricks: MAIN.length, entities: 0 });
  });
});

describe('prefab placement', () => {
  it('puts the turned outline with its low corner at the pose', () => {
    const low = [10, 20, 0], size = [40, 20, 12], centre = [30, 30, 6];
    for (const [turns, placed] of [[0, [70, 110, 18]], [1, [60, 120, 18]], [2, [70, 110, 18]], [3, [60, 120, 18]]] as const) {
      expect(placePos(centre, turns, prefabOffset(low, size, turns, [1, 2, 0.24], 0.02))).toEqual(placed);
    }
  });
});

describe('merging an import', () => {
  it('adds grid-1 bricks at their saved position and counts them for the same owner', () => {
    const r = mergeImport(gridWorld(), gridWorld(), { bricks: 'add' });
    const b = grid1(r.files);
    expect(b).toHaveLength(2 * MAIN.length);
    expect(b.slice(MAIN.length).map((x) => x.pos)).toEqual(MAIN.map((x) => x.pos));
    expect(owners(r.files).BrickCounts).toEqual([2 * MAIN.length + DYN.length]);
    expect(r.dropped).toBe(0);
  });

  it('turns and moves added bricks, and leaves out the dropped ones', () => {
    const r = mergeImport(gridWorld(), gridWorld(), { bricks: 'add' }, { turns: 1, offset: [100, 200, 0], drop: new Set([0]) });
    const added = grid1(r.files).slice(MAIN.length);
    expect(r.dropped).toBe(1);
    expect(added.map((x) => x.pos)).toEqual(MAIN.slice(1).map((x) => placePos(x.pos, 1, [100, 200, 0])));
    expect(placePos([40, 0, 6], 1, [100, 200, 0])).toEqual([100, 240, 6]);
    expect(added[0]!.orient).not.toBe(16);
  });

  it('replaces grid-1 bricks and keeps the dynamic grids', () => {
    const r = mergeImport(gridWorld(), gridWorld({ entityless: true }), { bricks: 'replace' }, { offset: [0, 0, 100] });
    expect(grid1(r.files).map((x) => x.pos)).toEqual(MAIN.map((x) => [x.pos[0], x.pos[1], x.pos[2] + 100]));
    expect(entities(r.files).entities).toHaveLength(1);
    expect(owners(r.files).BrickCounts).toEqual([MAIN.length + DYN.length]);
  });

  it('adds a new owner row for an unknown user and counts its bricks there', () => {
    const r = mergeImport(gridWorld(), withOwner(gridWorld({ entityless: true }), { A: 9, B: 9, C: 9, D: 9 }, 'other'), { bricks: 'add' });
    const o = owners(r.files);
    expect(o.UserNames).toEqual([...owners(gridWorld()).UserNames as string[], 'other']);
    expect(o.BrickCounts).toEqual([MAIN.length + DYN.length, MAIN.length]);
    expect(grid1(r.files).slice(MAIN.length).every((b) => b.owner === 1)).toBe(true);
  });

  it('adds dynamic grids as new grids, turned and moved with the bricks', () => {
    const r = mergeImport(gridWorld(), gridWorld(), { entities: 'add' }, { turns: 1, offset: [10, 0, 0] });
    const t = entities(r.files);
    expect(t.entities.map((e) => e.persistentIndex)).toEqual([2, 3]);
    const e = t.byIndex.get(3)!;
    expect(e.location[0]).toBeCloseTo(placePos(DYN_LOCATION, 1, [10, 0, 0])[0], 3);
    expect(e.location[1]).toBeCloseTo(placePos(DYN_LOCATION, 1, [10, 0, 0])[1], 3);
    expect(e.data?.EntityTag).toBe('door');
    expect(extractBricks(r.files, { grid: '3' }).bricks).toHaveLength(DYN.length);
    expect(owners(r.files).EntityCounts).toEqual([2]);
    expect(owners(r.files).BrickCounts).toEqual([MAIN.length + 2 * DYN.length]);
    expect(grid1(r.files)).toHaveLength(MAIN.length);
  });

  it('replaces dynamic grids', () => {
    const r = mergeImport(gridWorld(), gridWorld(), { entities: 'replace' });
    expect(entities(r.files).entities.map((e) => e.persistentIndex)).toEqual([3]);
    expect(r.files.has(W + 'Bricks/Grids/2/ChunkIndex.mps')).toBe(false);
    expect(owners(r.files).BrickCounts).toEqual([MAIN.length + DYN.length]);
  });

  it('carries components and wires with their bricks and keeps them connected', () => {
    const base = compSave(), add = compSave();
    expect(gridOneComponents(base).length).toBeGreaterThan(1);
    expect(gridOneWires(base).length).toBeGreaterThan(0);
    const r = mergeImport(base, add, { bricks: 'add' }, { offset: [0, 0, 100] });
    expect(r.warnings.join('|')).toMatch(/wires lost an end|joint and microchip/);
    expect(gridOneComponents(r.files)).toHaveLength(2 * gridOneComponents(base).length);
    expect(gridOneWires(r.files)).toHaveLength(2 * gridOneWires(base).length);
    const again = readBrz(writeBrz(r.files));
    expect(gridOneWires(again)).toHaveLength(2 * gridOneWires(base).length);
    const ws = loadWires(r.files).wires().filter((w) => w.source.grid === 1 && w.target.grid === 1);
    const added = ws.slice(gridOneWires(base).length);
    const bricks = grid1(r.files);
    const index = new Map<string, number>();
    const seen = new Map<string, number>();
    bricks.forEach((b, i) => {
      const k = b.pos.map((v) => Math.floor(Math.round(v) / 2048)).join('_'), n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      index.set(`${k}/${n}`, i);
    });
    for (const w of added) {
      const at = index.get(`${w.target.chunk.X}_${w.target.chunk.Y}_${w.target.chunk.Z}/${w.target.brick}`)!;
      expect(bricks[at]!.pos[2]).toBeGreaterThanOrEqual(100);
    }
  });

  it('carries components into a save without component lists', () => {
    const add = compSave();
    const r = mergeImport(gridWorld({ entityless: true }), add, { bricks: 'add' }, { offset: [5000, 0, 0] });
    expect(gridOneComponents(r.files)).toHaveLength(gridOneComponents(add).length);
    expect(gridOneWires(r.files)).toHaveLength(gridOneWires(add).length);
  });

  it('replaces the environment and other world data', () => {
    const add = gridWorld(), env = new TextEncoder().encode('{"type":"Environment"}');
    add.set(W + 'Environment.bp', env);
    add.set('GameMode/GameMode/Settings.json', new TextEncoder().encode('{}'));
    const base = gridWorld();
    base.set('GameMode/Rules/GameMode.json', new TextEncoder().encode('[]'));
    expect(importParts(add)).toMatchObject({ environment: true, other: true });
    const r = mergeImport(base, add, { environment: true, other: true });
    expect(r.files.get(W + 'Environment.bp')).toBe(env);
    expect(r.files.has('GameMode/GameMode/Settings.json')).toBe(true);
    expect(r.files.has('GameMode/Rules/GameMode.json')).toBe(false);
    expect(grid1(r.files)).toHaveLength(MAIN.length);
  });
});
