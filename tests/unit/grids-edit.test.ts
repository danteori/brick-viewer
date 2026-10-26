// W-03 / W-04: dynamic grids in the scene. Loading puts a grid's bricks at entity location + R *
// local; moving, turning, new grids, bricks between grids and deleted grids save back (.brz and
// .brdb) and reload to the same scene; an untouched world saves byte for byte.
import { describe, expect, it } from 'vitest';
import { readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { decodeMps, decodeSoa, parseSchema } from '../../src/format/schema.ts';
import { ByteBuf, MsgReader, type MsgValue } from '../../src/format/msgpack.ts';
import { editEntities, packValue, withGridStruct } from '../../src/format/entitywrite.ts';
import { writeNewWorldFile } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import { bytesSource } from '../../src/format/sqlitelazy.ts';
import { flattenTree } from '../../src/format/stale.ts';
import { readEntities } from '../../src/format/entities.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { storeFromFilesPlain } from '../../src/scene/load.ts';
import { S } from '../../src/app/state.ts';
import { partFiles, scenePlain, writeScene } from '../../src/scene/save.ts';
import { writeDynamicGrids } from '../../src/scene/gridsave.ts';
import {
  eulerOfQuat, gridSetOf, jointedGrids, linkGrids, loadDynamicGrids, placeGrid, placeJointed, quatOfEuler, rowsOfGrid, shiftedXf, toLocal, toWorld, turnedXf, xfOf, IDENT, type GridXf,
} from '../../src/scene/dyngrids.ts';
import { GRIDS, type SceneStore } from '../../src/scene/store.ts';
import { rotate } from '../../src/scene/grids.ts';
import { DYN, DYN_LOCATION, ENTITIES_BARE, ENTITIES_FULL, gridWorld, MAIN } from './gridworld.ts';

const W = 'World/0/';

function open(files: FileMap): SceneStore {
  const { store } = storeFromFilesPlain(files);
  loadDynamicGrids(store, files);
  store.drain();
  return store;
}
/** What Save .brz writes: grid 1 (save.ts), then the dynamic grids. */
function save(template: FileMap, s: SceneStore): FileMap {
  const main = writeScene(template, scenePlain(s, false));
  return writeDynamicGrids(template, main.files, s, false).files;
}
const viaBrz = (f: FileMap): FileMap => readBrz(writeBrz(f));
async function viaBrdb(f: FileMap): Promise<FileMap> {
  const w = await LazyBrdbWorld.open(bytesSource(writeNewWorldFile(f)));
  const t = w.tree();
  await t.loadWritten(t.paths().filter((p) => p.endsWith('.mps')));
  await t.load(t.paths());
  return flattenTree(t).files;
}
/** Every row as [grid, x, y, z, orient, size, colour], sorted. */
const rows = (s: SceneStore): string[] => [...s.ids()].map((id) => JSON.stringify([GRIDS.name(s.grid[id]!), s.px[id], s.py[id], s.pz[id], s.orient[id], s.hx[id], s.hy[id], s.hz[id], s.color[id]])).sort();
const entity = (f: FileMap, id: number) => readEntities(fileMapView(f)).byIndex.get(id);
const owners = (f: FileMap) => decodeMps(f.get(W + 'Owners.mps')!, parseSchema(f.get(W + 'Owners.schema')!));

describe('dynamic grids: loading', () => {
  it('puts grid 2 at location + R * local, rounded to whole units', () => {
    const s = open(gridWorld()), set = gridSetOf(s)!;
    expect(set.grids.size).toBe(1);
    const x = set.grids.get(2)!;
    expect(x.origin).toEqual([500, -300, 30]);
    expect(x.frac).toEqual([0.25, 0, 0]);
    expect(x.R).toEqual([[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
    const g = rowsOfGrid(s, 2).map((id) => [s.px[id], s.py[id], s.pz[id]]);
    expect(g).toEqual([[500, -300, 30], [500, -270, 30]]);           // local (30, 0, 0) turned to (0, 30, 0)
    expect(rowsOfGrid(s, 1)).toHaveLength(MAIN.length);
    expect(set.createProblem).toBeNull();
    expect(set.next).toBe(3);
  });

  it('toLocal undoes toWorld for every orientation', () => {
    const x = xfOf([7.5, -3, 2], quatOfEuler(90, 0, 180));
    for (let o = 0; o < 24; o++) {
      const w = toWorld(x, [10, -20, 4], o), l = toLocal(x, w.pos, w.orient);
      expect(l).toEqual({ pos: [10, -20, 4], orient: o });
    }
  });

  it('euler angles round-trip', () => {
    for (const e of [[0, 0, 0], [90, 0, 0], [-90, 0, 180], [45, 30, -60], [180, 0, 0]] as [number, number, number][]) {
      const back = eulerOfQuat(quatOfEuler(...e));
      const q1 = quatOfEuler(...e), q2 = quatOfEuler(...back), dot = Math.abs(q1.reduce((a, v, i) => a + v * q2[i]!, 0));
      expect(dot).toBeCloseTo(1, 9);
    }
  });

  it('euler angles follow Unreal FRotator signs', () => {
    const ue = (p: number, y: number, r: number): number[] => {
      const h = Math.PI / 360, [SP, CP, SY, CY, SR, CR] = [p, p, y, y, r, r].map((v, i) => (i % 2 ? Math.cos : Math.sin)(v * h));
      return [CR * SP * SY - SR * CP * CY, -CR * SP * CY - SR * CP * SY, CR * CP * SY - SR * SP * CY, CR * CP * CY + SR * SP * SY];
    };
    for (const [y, p, r] of [[90, 0, 0], [0, 90, 0], [0, 0, 90], [45, 30, -60], [-120, -15, 170]]) {
      const q = quatOfEuler(y!, p!, r!), u = ue(p!, y!, r!);
      expect(Math.abs(q.reduce((a, v, i) => a + v * u[i]!, 0))).toBeCloseTo(1, 9);
    }
    const near = (v: number[], to: number[]): void => v.forEach((c, i) => expect(c).toBeCloseTo(to[i]!, 9));
    near(rotate(quatOfEuler(90, 0, 0), [1, 0, 0]), [0, 1, 0]);
    near(rotate(quatOfEuler(0, 90, 0), [1, 0, 0]), [0, 0, 1]);
    near(rotate(quatOfEuler(0, 0, 90), [0, 1, 0]), [0, 0, -1]);
  });
});

describe('jointed grids', () => {
  /** gridWorld with the first main-grid brick made grid 3 (at 100, 0, 0, not turned), jointed to grid 2. */
  function jointed(): SceneStore {
    const s = open(gridWorld()), set = gridSetOf(s)!, id = rowsOfGrid(s, 1)[0]!;
    s.grid[id] = GRIDS.id('3');
    set.grids.set(3, xfOf([100, 0, 0], [0, 0, 0, 1]));
    set.links = linkGrids([{ grid: 2, refs: [3] }], set.grids);
    return s;
  }
  const at = (s: SceneStore, id: number): number[] => [s.px[id]!, s.py[id]!, s.pz[id]!];

  it('links dynamic grids both ways, never grid 1, an unknown grid or itself', () => {
    const grids = new Map([[2, 0], [3, 0], [4, 0]]);
    const links = linkGrids([{ grid: 2, refs: [3, 1, 9, 2] }, { grid: 1, refs: [4] }, { grid: 4, refs: [3] }], grids);
    expect([...links].map(([g, l]) => [g, [...l]])).toEqual([[2, [3]], [3, [2, 4]], [4, [3]]]);
  });

  it('a jointed group is found from any of its grids', () => {
    const s = jointed();
    expect(jointedGrids(s, 2)).toEqual([2, 3]);
    expect(jointedGrids(s, 3)).toEqual([3, 2]);
  });

  it('turning a grid turns its jointed grid with it about the same point', () => {
    const s = jointed(), set = gridSetOf(s)!, x2 = set.grids.get(2)!, x3 = set.grids.get(3)!;
    const r2 = rowsOfGrid(s, 2)[0]!, r3 = rowsOfGrid(s, 3)[0]!, main = rowsOfGrid(s, 1).map((id) => at(s, id));
    const before = at(s, r3).map((v, i) => v - x2.origin[i]!), local3 = toLocal(x3, at(s, r3), s.orient[r3]!);
    const local2 = toLocal(x2, at(s, r2), s.orient[r2]!);
    placeJointed(s, 2, x2, turnedXf(x2, 1));
    const n2 = set.grids.get(2)!, n3 = set.grids.get(3)!;
    expect(at(s, r3).map((v, i) => v - n2.origin[i]!)).toEqual([-before[1]!, before[0]!, before[2]!]);
    expect(toLocal(n3, at(s, r3), s.orient[r3]!)).toEqual(local3);
    expect(toLocal(n2, at(s, r2), s.orient[r2]!)).toEqual(local2);
    expect(n3.R).toEqual([[0, -1, 0], [1, 0, 0], [0, 0, 1]]);
    expect(rowsOfGrid(s, 1).map((id) => at(s, id))).toEqual(main);
  });

  it('placing a grid moves its jointed grid by the same offset', () => {
    const s = jointed(), set = gridSetOf(s)!, x2 = set.grids.get(2)!, x3 = set.grids.get(3)!, r3 = rowsOfGrid(s, 3)[0]!, p3 = at(s, r3);
    placeJointed(s, 2, x2, shiftedXf(shiftedXf(x2, 0, 40), 2, -8));
    expect(set.grids.get(3)!.origin).toEqual([x3.origin[0] + 40, 0, -8]);
    expect(at(s, r3)).toEqual([p3[0]! + 40, p3[1], p3[2]! - 8]);
  });
});

describe('dynamic grids: saving', () => {
  it('an untouched world saves byte for byte', () => {
    const f = gridWorld(), out = save(f, open(f));
    expect([...out.keys()].sort()).toEqual([...f.keys()].sort());
    for (const [p, b] of f) expect(out.get(p), p).toEqual(b);
  });

  it('a moved grid writes only its entity (bricks unchanged), and reloads where it was put', async () => {
    const f = gridWorld(), s = open(f), set = gridSetOf(s)!, x = set.grids.get(2)!;
    placeGrid(s, 2, x, shiftedXf(shiftedXf(x, 0, 40), 2, -8));
    const out = save(f, s);
    expect(out.get(W + 'Bricks/Grids/2/Chunks/-1_-1_-1.mps')).toEqual(f.get(W + 'Bricks/Grids/2/Chunks/-1_-1_-1.mps'));
    expect(out.get(W + 'Bricks/Grids/1/Chunks/0_0_0.mps')).toEqual(f.get(W + 'Bricks/Grids/1/Chunks/0_0_0.mps'));
    expect(entity(out, 2)!.location).toEqual([540.25, -300, 22]);
    expect(entity(out, 2)!.data).toMatchObject({ EntityTag: 'door', MassScale: 2 });
    for (const back of [viaBrz(out), await viaBrdb(out)]) expect(rows(open(back))).toEqual(rows(s));
  });

  it('a turned grid writes the composed rotation and reloads turned', async () => {
    const f = gridWorld(), s = open(f), set = gridSetOf(s)!, x = set.grids.get(2)!;
    placeGrid(s, 2, x, turnedXf(x, 1));
    expect(set.grids.get(2)!.R).toEqual([[-1, 0, 0], [0, -1, 0], [0, 0, 1]]);
    const out = save(f, s), e = entity(out, 2)!;
    const q = e.rotation, expected = [0, 0, 1, 0];                    // 90 + 90 degrees about Z
    expect(Math.abs(q.reduce((a, v, i) => a + v * expected[i]!, 0))).toBeCloseTo(1, 6);
    expect(e.location[0]).toBeCloseTo(Math.round(DYN_LOCATION[0]), 5);   // turned about its whole-unit origin:
    expect(e.location[1]).toBeCloseTo(DYN_LOCATION[1] + 0.25, 5);     // the fractional offset turns with it
    for (const back of [viaBrz(out), await viaBrdb(out)]) expect(rows(open(back))).toEqual(rows(s));
  });

  it('a new grid from main-grid bricks: entity, chunk, names and counts as the game writes them', async () => {
    const f = gridWorld(), s = open(f), set = gridSetOf(s)!;
    const ids = rowsOfGrid(s, 1).slice(0, 2), g = set.next++, gi = GRIDS.id(String(g));
    set.grids.set(g, { origin: [20, 0, 6], frac: [0, 0, 0], quat: [0, 0, 0, 1], R: IDENT } satisfies GridXf);
    for (const id of ids) { s.grid[id] = gi; s.srcOrder[id] = -1; s.touch(id); }
    const out = save(f, s);
    const ci = decodeMps(out.get(W + `Bricks/Grids/${g}/ChunkIndex.mps`)!, parseSchema(out.get(W + 'Bricks/ChunkIndexShared.schema')!));
    expect(ci).toMatchObject({ Chunk3DIndices: [{ X: -1, Y: -1, Z: -1 }], ChunkOffsets: [{ X: 1024, Y: 1024, Z: 1024 }], NumBricks: [2] });
    const e = entity(out, g)!;
    expect(e).toMatchObject({ type: 'Entity_DynamicBrickGrid', location: [20, 0, 6], rotation: [0, 0, 0, 1], physicsLocked: false, physicsSleeping: false, owner: 0, originalOwner: 0, prefabSpawnInstance: 0 });
    expect(e.data).toMatchObject({ EntityTag: 'door', MassScale: 2 });                 // settings copied from the save's other grid
    expect(e.colors![0]).toEqual([255, 255, 255, 255]);
    const ei = decodeMps(out.get(W + 'Entities/ChunkIndex.mps')!, parseSchema(out.get(W + 'Entities/ChunkIndex.schema')!));
    expect(ei).toMatchObject({ NextPersistentIndex: g + 1, NumEntities: [2] });
    expect(owners(out)).toMatchObject({ EntityCounts: [2], BrickCounts: [MAIN.length + DYN.length] });
    for (const back of [viaBrz(out), await viaBrdb(out)]) {
      expect(rows(open(back))).toEqual(rows(s));
      expect(gridSetOf(open(back))!.grids.get(g)).toMatchObject({ origin: [20, 0, 6] });
    }
  });

  it('a new grid in a world without entities adds the grid type, its struct and its entity chunk', async () => {
    const f = gridWorld({ entityless: true }), s = open(f), set = gridSetOf(s)!;
    expect(set.createProblem).toBeNull();
    const id = rowsOfGrid(s, 1)[2]!, g = set.next++;
    set.grids.set(g, { origin: [0, 60, 2], frac: [0, 0, 0], quat: [0, 0, 0, 1], R: IDENT });
    s.grid[id] = GRIDS.id(String(g)); s.srcOrder[id] = -1; s.touch(id);
    const out = save(f, s);
    expect(g).toBe(2);
    const gd = decodeMps(out.get(W + 'GlobalData.mps')!, parseSchema(out.get(W + 'GlobalData.schema')!));
    expect(gd).toMatchObject({ EntityTypeNames: ['Entity_DynamicBrickGrid'], EntityDataClassNames: ['BrickGridDynamicActor'] });
    const es = parseSchema(out.get(W + 'Entities/ChunksShared.schema')!);
    expect(es.S.get('BrickGridDynamicActor')!.map(([k]) => k)).toEqual(parseSchema(ENTITIES_FULL).S.get('BrickGridDynamicActor')!.map(([k]) => k));
    expect([...es.S.keys()]).toEqual([...parseSchema(ENTITIES_FULL).S.keys()]);
    expect(out.get(W + 'Entities/ChunksShared.schema')).toEqual(ENTITIES_FULL);   // the game's own order and enum
    expect(entity(out, 2)!.data).toEqual({ BouyancyScale: 0.20000000298023224, MassScale: 1, bEnableGravity: true, bUseNewMassCalculation: true, bReceivesDecals: true, CollisionQuality: 0, EntityTag: '', GameModeTeamName: '', bDetectableByAnyone: false });
    expect(owners(out)).toMatchObject({ EntityCounts: [1] });
    for (const back of [viaBrz(out), await viaBrdb(out)]) expect(rows(open(back))).toEqual(rows(s));
  });

  it('bricks moved into another grid are written in that grid, grid-local', () => {
    const f = gridWorld(), s = open(f);
    const id = rowsOfGrid(s, 1)[2]!;
    s.grid[id] = GRIDS.id('2'); s.srcOrder[id] = -1; s.touch(id);
    const out = save(f, s), back = open(viaBrz(out));
    expect(rows(back)).toEqual(rows(s));
    expect(rowsOfGrid(back, 2)).toHaveLength(DYN.length + 1);
    expect(entity(out, 2)!.location).toEqual(DYN_LOCATION);                // the grid itself didn't move
  });

  it('a grid left without bricks is removed with its entity', () => {
    const f = gridWorld(), s = open(f);
    for (const id of rowsOfGrid(s, 2)) s.remove(id);
    const out = save(f, s);
    expect([...out.keys()].some((p) => p.includes('Grids/2/'))).toBe(false);
    expect(entity(out, 2)).toBeUndefined();
    expect(out.has(W + 'Entities/Chunks/0_0_0.mps')).toBe(false);
    expect(decodeMps(out.get(W + 'Entities/ChunkIndex.mps')!, parseSchema(out.get(W + 'Entities/ChunkIndex.schema')!))).toMatchObject({ Chunk3DIndices: [], NumEntities: [] });
    expect(owners(out)).toMatchObject({ EntityCounts: [0], BrickCounts: [MAIN.length] });
  });
});

describe('entity writer', () => {
  it('re-packs a schema byte for byte, and adds the grid struct where the game puts it', () => {
    for (const b of [ENTITIES_FULL, ENTITIES_BARE]) { const o = new ByteBuf(); packValue(o, new MsgReader(b).next() as MsgValue); expect(o.done()).toEqual(b); }
    expect(withGridStruct(ENTITIES_FULL, true)).toBe(ENTITIES_FULL);
    expect(withGridStruct(ENTITIES_BARE, true)).toEqual(ENTITIES_FULL);
    expect(parseSchema(withGridStruct(ENTITIES_BARE, false)).S.get('BrickGridDynamicActor')).toEqual([]);
  });

  it('inserts rows into their type run and keeps the bit flags lined up', () => {
    const f = gridWorld();
    const out = editEntities(f, { added: [3, 4].map((i) => ({ persistentIndex: i, location: [i, 0, 0], rotation: [0, 0, 0, 1], owner: 0, locked: i === 3 })) }).files;
    const es = parseSchema(out.get(W + 'Entities/ChunksShared.schema')!);
    const gd = decodeMps<{ EntityTypeNames: string[]; EntityDataClassNames: string[] }>(out.get(W + 'GlobalData.mps')!, parseSchema(out.get(W + 'GlobalData.schema')!));
    const c = decodeSoa(out.get(W + 'Entities/Chunks/0_0_0.mps')!, es, gd);
    expect(c.root.PersistentIndices).toEqual([2, 3, 4]);
    expect(c.root.TypeCounters).toEqual([{ TypeIndex: 0, NumEntities: 3 }]);
    expect(c.root.PhysicsLockedFlags).toEqual({ Flags: [0b011] });
    expect(c.data).toHaveLength(3);
    const back = editEntities(out, { removed: new Set([3]) }).files, t = readEntities(fileMapView(back));
    expect(t.entities.map((e) => [e.persistentIndex, e.physicsLocked])).toEqual([[2, true], [4, false]]);
  });
});

describe('selection prefab of a world with a moving grid', () => {
  it('holds each selected brick once, in grid 1, and no other grid', () => {
    const files = gridWorld(), s = open(files);
    S.scene = s;
    const r = partFiles([...s.ids()], files)!;
    expect([...r.files.keys()].some((p) => p.includes('/Grids/2/'))).toBe(false);
    expect(entity(r.files, 2)).toBeUndefined();
    const back = open(r.files);
    expect(back.n).toBe(MAIN.length + DYN.length);
    expect(rowsOfGrid(back, 1)).toHaveLength(MAIN.length + DYN.length);
    expect(gridSetOf(back)?.grids.size ?? 0).toBe(0);
    // the moving grid's bricks sit at their world positions
    const at = rowsOfGrid(back, 1).map((id) => [back.px[id], back.py[id]]);
    expect(at).toContainEqual([500, -300]);
  });
});
