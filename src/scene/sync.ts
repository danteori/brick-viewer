// Hands the scene's changes to the parts that mirror it (the render chunks, the pick grid). Once a
// frame (and before any query that needs it current) syncScene drains the store's change set and
// passes it on; when the scene is a different store (a load, or its undo) they rebuild instead.

import { S } from '../app/state.ts';
import type { SceneStore } from './store.ts';

export interface SceneMirror {
  /** the whole scene is new: rebuild from it */
  reset(s: SceneStore): void;
  /** these rows changed (added, removed or edited) */
  changed(s: SceneStore, ids: ReadonlySet<number>): void;
}

const mirrors: SceneMirror[] = [];
let last: SceneStore | null = null;
/** bumped when anything was handed on (hover re-pick key) */
export let sceneRev = 0;

export function addMirror(m: SceneMirror): void { mirrors.push(m); last = null; }

export function syncScene(): void {
  const s = S.scene;
  if (s !== last) {
    last = s;
    s.drain();
    for (const m of mirrors) m.reset(s);
    sceneRev++;
    return;
  }
  if (!s.changed.size) return;
  const ids = s.drain();
  for (const m of mirrors) m.changed(s, ids);
  sceneRev++;
}

/** Forces a rebuild of every mirror on the next sync (e.g. the hidden set changed a lot). */
export function resyncAll(): void { last = null; }
