import { F_HAS_FLAGS, FLAG_NAMES, type SceneStore } from './store.ts';

/** On for every row, off for every row, a mix, or none of the fields are in the save. */
export type FlagState = 'on' | 'off' | 'mixed' | 'none';

const PLAYERS = ['CollisionFlags_Player', 'CollisionFlags_Player1', 'CollisionFlags_Player2', 'CollisionFlags_Player3'];
const OTHERS = ['CollisionFlags_Physics', 'CollisionFlags_Interaction', 'CollisionFlags_Weapon'];

/** The applicator's properties and the save fields each one sets together. */
export const FLAG_PROPS: readonly { key: string; fields: readonly string[] }[] = [
  { key: 'visible', fields: ['VisibilityFlags'] },
  { key: 'all', fields: [...PLAYERS, ...OTHERS] },
  ...PLAYERS.map((f, i) => ({ key: `player${i + 1}`, fields: [f] })),
  { key: 'physics', fields: [OTHERS[0]!] },
  { key: 'interaction', fields: [OTHERS[1]!] },
  { key: 'weapon', fields: [OTHERS[2]!] },
];

/** The bits of `fields` that the store's save has (unknown names are left out, never added to the table). */
export function flagMask(s: SceneStore, fields: readonly string[]): number {
  let m = 0;
  for (const f of s.flagFields) if (f < 16 && fields.includes(FLAG_NAMES.name(f))) m |= 1 << f;
  return m;
}

/** Whether rows `ids` have the fields of `mask` on. */
export function flagState(s: SceneStore, ids: readonly number[], mask: number): FlagState {
  if (!mask) return 'none';
  let on = 0, off = 0;
  for (const id of ids) {
    if (!s.alive(id)) continue;
    const bits = s.flags[id]! & F_HAS_FLAGS ? s.collision[id]! & mask : 0;
    if (bits === 0) on++;
    else if (bits === mask) off++;
    else return 'mixed';
    if (on && off) return 'mixed';
  }
  return off ? 'off' : on ? 'on' : 'none';
}

/** Turns the fields of `mask` on or off for rows `ids`; returns the rows that changed. */
export function writeFlags(s: SceneStore, ids: readonly number[], mask: number, on: boolean): number[] {
  const changed: number[] = [];
  if (!mask) return changed;
  for (const id of ids) {
    if (!s.alive(id)) continue;
    const had = s.flags[id]! & F_HAS_FLAGS ? s.collision[id]! : 0, next = on ? had & ~mask : had | mask;
    if (next === had) continue;
    s.flags[id] = s.flags[id]! | F_HAS_FLAGS;
    s.collision[id] = next;
    s.touch(id);
    changed.push(id);
  }
  return changed;
}
