import { describe, expect, it } from 'vitest';
import { readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { writeNewWorldFile } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import { bytesSource } from '../../src/format/sqlitelazy.ts';
import { flattenTree } from '../../src/format/stale.ts';
import { readEntities } from '../../src/format/entities.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { storeFromFilesPlain } from '../../src/scene/load.ts';
import { writeScene, scenePlain } from '../../src/scene/save.ts';
import { writeDynamicGrids } from '../../src/scene/gridsave.ts';
import { gridSetOf, loadDynamicGrids, propsOf, settingsOf } from '../../src/scene/dyngrids.ts';
import { outlineRows } from '../../src/scene/outline.ts';
import type { SceneStore } from '../../src/scene/store.ts';
import { gridWorld, MAIN, DYN } from './gridworld.ts';


function open(files: FileMap): SceneStore {
  const { store } = storeFromFilesPlain(files);
  loadDynamicGrids(store, files);
  store.drain();
  return store;
}
function save(template: FileMap, s: SceneStore): FileMap {
  const main = writeScene(template, scenePlain(s, false));
  return writeDynamicGrids(template, main.files, s, false).files;
}
async function viaBrdb(f: FileMap): Promise<FileMap> {
  const w = await LazyBrdbWorld.open(bytesSource(writeNewWorldFile(f)));
  const t = w.tree();
  await t.loadWritten(t.paths().filter((p) => p.endsWith('.mps')));
  await t.load(t.paths());
  return flattenTree(t).files;
}
const entity = (f: FileMap, id: number) => readEntities(fileMapView(f)).byIndex.get(id)!;

describe('outline rows', () => {
  it('lists the main grid and a moving grid with live brick counts and the frozen flag', () => {
    const f = gridWorld(), rows = outlineRows(open(f), f);
    expect(rows.map((r) => [r.kind, r.id, r.bricks, r.frozen, r.sleeping])).toEqual([
      ['main', 1, MAIN.length, false, false],
      ['dynamic', 2, DYN.length, true, false],
    ]);
    expect(rows[1]!.type).toBe('Entity_DynamicBrickGrid');
  });

  it('a world with no entities lists only the main grid', () => {
    const f = gridWorld({ entityless: true });
    expect(outlineRows(open(f), f).map((r) => r.kind)).toEqual(['main']);
  });
});

describe('grid settings', () => {
  it('reads the four settings and none from an empty struct', () => {
    expect(settingsOf({ BouyancyScale: 0.5, MassScale: 2, bEnableGravity: false, CollisionQuality: 1 })).toEqual({ BouyancyScale: 0.5, MassScale: 2, bEnableGravity: false, CollisionQuality: 1 });
    expect(settingsOf({})).toBeNull();
    expect(settingsOf(null)).toBeNull();
  });

  it('are read from the entity on load', () => {
    const f = gridWorld(), s = open(f), p = propsOf(gridSetOf(s)!, 2);
    expect(p).toEqual({ locked: true, settings: { BouyancyScale: 0.5, MassScale: 2, bEnableGravity: true, CollisionQuality: 1 } });
  });

  it('an untouched grid saves byte for byte', () => {
    const f = gridWorld(), out = save(f, open(f));
    for (const [p, b] of f) expect(out.get(p), p).toEqual(b);
  });

  it('an edited grid writes its flag and settings and keeps the other fields, in a .brz and a .brdb', async () => {
    const f = gridWorld(), s = open(f), set = gridSetOf(s)!;
    set.props.set(2, { locked: false, settings: { BouyancyScale: 0.75, MassScale: 3.5, bEnableGravity: false, CollisionQuality: 0 } });
    const out = save(f, s);
    for (const back of [readBrz(writeBrz(out)), await viaBrdb(out)]) {
      const e = entity(back, 2);
      expect(e.physicsLocked).toBe(false);
      expect(e.data).toMatchObject({ BouyancyScale: 0.75, MassScale: 3.5, bEnableGravity: false, CollisionQuality: 0, EntityTag: 'door', bUseNewMassCalculation: true });
      expect(propsOf(gridSetOf(open(back))!, 2)).toEqual(set.props.get(2));
    }
    expect(out.get('World/0/Bricks/Grids/2/Chunks/-1_-1_-1.mps')).toEqual(f.get('World/0/Bricks/Grids/2/Chunks/-1_-1_-1.mps'));
  });

  it('freezing a grid sets only its flag', () => {
    const f = gridWorld(), s = open(f), set = gridSetOf(s)!, was = propsOf(set, 2);
    set.props.set(2, { locked: true, settings: was.settings });
    const out = save(f, s);
    for (const [p, b] of f) expect(out.get(p), p).toEqual(b);
  });
});
