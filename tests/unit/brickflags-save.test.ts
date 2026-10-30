// Flag edits (E-20) survive saving: store rows -> .brz and .brdb files -> store rows, and undo records.
import { beforeAll, describe, expect, it } from 'vitest';
import { BrdbWorld, writeNewWorldFile } from '../../src/format/brdb.ts';
import { readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import type { SqlBackend } from '../../src/format/sql.ts';
import { FLAG_PROPS, flagMask, flagState, writeFlags } from '../../src/scene/brickflags.ts';
import { storeFromFiles } from '../../src/scene/load.ts';
import { packRecords, readRecord } from '../../src/scene/record.ts';
import { scenePlain, writeScene } from '../../src/scene/save.ts';
import type { SceneStore } from '../../src/scene/store.ts';
import { kindOf } from '../../src/scene/view.ts';
import { nodeSql } from './brdb-helpers.ts';
import { synthSave, type SynthBrick } from './synthsave.ts';

const cube = (x: number, extra: Partial<SynthBrick> = {}): SynthBrick => ({ asset: 'PB_DefaultBrick', size: [10, 10, 10], pos: [x, 0, 10], color: [22, 195, 134], ...extra });
const fieldsOf = (key: string): readonly string[] => FLAG_PROPS.find((p) => p.key === key)!.fields;
const maskOf = (s: SceneStore, key: string): number => flagMask(s, fieldsOf(key));
const states = (s: SceneStore, ids: number[]): Record<string, string> => Object.fromEntries(FLAG_PROPS.map((p) => [p.key, flagState(s, ids, flagMask(s, p.fields))]));

const load = (files: FileMap): SceneStore => storeFromFiles(files).store;
const saved = (files: FileMap, s: SceneStore): FileMap => writeScene(files, scenePlain(s, false)).files;
const start = (): { files: FileMap; store: SceneStore } => {
  const files = readBrz(synthSave([cube(0), cube(20), cube(40, { off: ['CollisionFlags_Weapon'] })]));
  return { files, store: load(files) };
};

let sql: SqlBackend;
beforeAll(async () => { sql = await nodeSql(); });

describe('flag edits in saved files', () => {
  it('reads the synthetic collision fields', () => {
    const { store } = start();
    expect(states(store, [0, 1])).toMatchObject({ all: 'on', visible: 'on', weapon: 'on' });
    expect(states(store, [0, 1, 2])).toMatchObject({ all: 'mixed', weapon: 'mixed', physics: 'on' });
    expect(states(store, [2]).weapon).toBe('off');
  });

  it('writes each switch to its own field and nothing else', () => {
    for (const p of FLAG_PROPS) {
      const { files, store } = start();
      writeFlags(store, [0], maskOf(store, p.key), false);
      const back = load(saved(files, store));
      expect(flagState(back, [0], maskOf(back, p.key))).toBe('off');
      for (const q of FLAG_PROPS) {
        if (q.key === p.key || q.key === 'all') continue;
        const shared = q.fields.some((f) => p.fields.includes(f));
        expect(flagState(back, [0], maskOf(back, q.key))).toBe(shared ? 'off' : 'on');
      }
      expect(states(back, [1])).toMatchObject({ all: 'on', visible: 'on' });
    }
  });

  it('keeps edits for a selection of several bricks, and the bricks it did not touch', () => {
    const { files, store } = start();
    const ids = [0, 1];
    writeFlags(store, ids, maskOf(store, 'all'), false);
    writeFlags(store, ids, maskOf(store, 'visible'), false);
    const back = load(saved(files, store));
    expect(states(back, ids)).toMatchObject({ all: 'off', visible: 'off', weapon: 'off' });
    expect(states(back, [2])).toMatchObject({ all: 'mixed', visible: 'on', weapon: 'off', physics: 'on' });
  });

  it('round-trips through .brz bytes', () => {
    const { files, store } = start();
    writeFlags(store, [1], maskOf(store, 'player3'), false);
    const back = load(readBrz(writeBrz(saved(files, store))));
    expect(states(back, [1]).player3).toBe('off');
    expect(states(back, [0, 1]).player3).toBe('mixed');
  });

  it('round-trips through a .brdb file', () => {
    const { files, store } = start();
    writeFlags(store, [0, 2], maskOf(store, 'interaction'), false);
    writeFlags(store, [0], maskOf(store, 'visible'), false);
    const w = BrdbWorld.open(sql, writeNewWorldFile(saved(files, store)), { verify: true });
    const back = load(new Map(w.tree().files()));
    w.close();
    expect(states(back, [0])).toMatchObject({ interaction: 'off', visible: 'off', physics: 'on' });
    expect(states(back, [1])).toMatchObject({ interaction: 'on', visible: 'on' });
    expect(states(back, [2])).toMatchObject({ interaction: 'off', weapon: 'off' });
  });

  it('turns a switch back on and saves the original flags', () => {
    const { files, store } = start();
    const m = maskOf(store, 'all');
    writeFlags(store, [0, 1], m, false);
    writeFlags(store, [0, 1], m, true);
    expect(states(load(saved(files, store)), [0, 1])).toMatchObject({ all: 'on', visible: 'on' });
  });
});

describe('flag edits and undo records', () => {
  it('restores the flags of every selected row from the before records', () => {
    const { store } = start();
    const ids = [0, 1, 2], before = packRecords(store, ids), m = maskOf(store, 'all');
    writeFlags(store, ids, m, false);
    expect(states(store, ids).all).toBe('off');
    const after = packRecords(store, ids);
    expect(after).not.toEqual(before);
    ids.forEach((id, j) => readRecord(store, id, new DataView(before.buffer, before.byteOffset, before.byteLength), j * (before.length / ids.length), kindOf));
    expect(states(store, [0, 1])).toMatchObject({ all: 'on' });
    expect(states(store, [2]).weapon).toBe('off');
  });
});
