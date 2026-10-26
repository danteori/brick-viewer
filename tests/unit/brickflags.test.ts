import { describe, expect, it } from 'vitest';
import { FLAG_PROPS, flagMask, flagState, writeFlags } from '../../src/scene/brickflags.ts';
import { F_HAS_FLAGS, FLAG_NAMES, SceneStore } from '../../src/scene/store.ts';

const FIELDS = ['VisibilityFlags', 'CollisionFlags_Player', 'CollisionFlags_Player1', 'CollisionFlags_Player2', 'CollisionFlags_Player3', 'CollisionFlags_Weapon', 'CollisionFlags_Interaction', 'CollisionFlags_Physics'];

function store(rows: number): SceneStore {
  const s = new SceneStore();
  s.flagFields = FIELDS.map((f) => FLAG_NAMES.id(f));
  for (let i = 0; i < rows; i++) s.alloc();
  return s;
}
const fieldsOf = (key: string) => FLAG_PROPS.find((p) => p.key === key)!.fields;

describe('brick flags', () => {
  it('masks only the fields the save has', () => {
    const s = store(0);
    expect(flagMask(s, fieldsOf('visible'))).toBe(1 << FLAG_NAMES.id('VisibilityFlags'));
    const visOnly = new SceneStore();
    visOnly.flagFields = [FLAG_NAMES.id('VisibilityFlags')];
    expect(flagMask(visOnly, fieldsOf('player2'))).toBe(0);
    expect(flagMask(new SceneStore(), fieldsOf('visible'))).toBe(0);
  });

  it('reads rows without stored flags as on', () => {
    const s = store(2);
    expect(flagState(s, [0, 1], flagMask(s, fieldsOf('players')))).toBe('on');
    expect(flagState(s, [0], 0)).toBe('none');
    expect(flagState(s, [], flagMask(s, fieldsOf('visible')))).toBe('none');
  });

  it('writes, reports changes and shows a mix', () => {
    const s = store(2), m = flagMask(s, fieldsOf('players'));
    const rev = s.rev;
    expect(writeFlags(s, [0], m, false)).toEqual([0]);
    expect(s.flags[0]! & F_HAS_FLAGS).toBe(F_HAS_FLAGS);
    expect(s.collision[0]).toBe(m);
    expect(s.rev).toBeGreaterThan(rev);
    expect(flagState(s, [0], m)).toBe('off');
    expect(flagState(s, [0, 1], m)).toBe('mixed');
    expect(writeFlags(s, [0, 1], m, false)).toEqual([1]);
    expect(writeFlags(s, [0, 1], m, true)).toEqual([0, 1]);
    expect(flagState(s, [0, 1], m)).toBe('on');
  });

  it('shows a group with some fields off as mixed and keeps other fields', () => {
    const s = store(1), m = flagMask(s, fieldsOf('players')), vis = flagMask(s, fieldsOf('visible'));
    s.flags[0] = s.flags[0]! | F_HAS_FLAGS;
    s.collision[0] = (1 << FLAG_NAMES.id('CollisionFlags_Player2')) | vis;
    expect(flagState(s, [0], m)).toBe('mixed');
    writeFlags(s, [0], m, true);
    expect(s.collision[0]).toBe(vis);
  });

  it('maps each switch to its save field and the all-players switch to all four', () => {
    const s = store(1), bit = (f: string): number => 1 << FLAG_NAMES.id(f);
    expect(flagMask(s, fieldsOf('projectile'))).toBe(bit('CollisionFlags_Weapon'));
    expect(flagMask(s, fieldsOf('physics'))).toBe(bit('CollisionFlags_Physics'));
    expect(flagMask(s, fieldsOf('interaction'))).toBe(bit('CollisionFlags_Interaction'));
    expect(flagMask(s, fieldsOf('player4'))).toBe(bit('CollisionFlags_Player3'));
    const all = flagMask(s, fieldsOf('players'));
    writeFlags(s, [0], flagMask(s, fieldsOf('player3')), false);
    expect(flagState(s, [0], all)).toBe('mixed');
    writeFlags(s, [0], all, false);
    expect(flagState(s, [0], flagMask(s, fieldsOf('player1')))).toBe('off');
  });
});
