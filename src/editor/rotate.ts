// Rotate and reorient (backlog E-05) for the placement ghost and the focused brick.
//
//   R tap            one clockwise step about the brick's stud axis (rotateCW); Shift+R goes back
//   R held + drag    the brick's top turns to the world axis the drag points at (dragToWorldDir ->
//                    reorientTo), live while R is held; the whole gesture is one undo step
//
// A viewer brick carries its orientation as derived fields (up / side / ramp run and lip / o ...),
// so a turn goes through the save representation: plainBrick (asset, orientation byte, local
// half-extents, centre) -> new byte -> viewerBrick, keeping the centre. Only the orientation fields
// are taken from the result; colour, material, intensity, grid and pass-through save data stay.
// A placed brick that would newly overlap a brick of its grid is refused (collision.ts rules).

import { S } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import { cloneBrick, type Brick, type V3 } from '../scene/brick.ts';
import { orientOf, plainBrick } from '../scene/save.ts';
import { viewerBrick } from '../scene/load.ts';
import { focusChangeHits } from '../scene/collision.ts';
import { hist, histBegin, histEnd } from '../scene/history.ts';
import { markBrick } from '../render/instances.ts';
import { cameraBasisFromView, dragToWorldDir, reorientTo, rotateBy } from './reorient.ts';
import { ed, ghostName, itemName, rotateItems } from './ghost.ts';
import { keepZoom, resizeBlock, selectBrick } from './resize.ts';
import { initAudio, playClick, playError } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';

/** The fields that describe a brick's orientation (everything else survives a turn untouched). */
const ORIENT_KEYS = ['up', 'side', 'shape', 'run', 'lip', 'closed', 'o', 'asset', 'round'] as const;

/**
 * Brick b (faces in a frame offset by origin from the save's) turned to orientation byte o about its
 * centre, or null when the turned brick isn't a type the viewer can draw.
 */
export function orientBrick(b: Brick, o: number, origin: readonly number[] = [0, 0, 0]): Brick | null {
  const pb = plainBrick(b, origin, false);
  pb.orient = o;
  const vb = viewerBrick(pb, false);
  if ('skip' in vb) return null;
  const out = cloneBrick(b) as unknown as Record<string, unknown>, src = vb as unknown as Record<string, unknown>;
  for (const k of ORIENT_KEYS) { delete out[k]; if (src[k] !== undefined) out[k] = src[k]; }
  const nb = out as unknown as Brick;
  nb.lo = vb.lo.map((v, i) => r3(v - origin[i]!)) as V3; nb.hi = vb.hi.map((v, i) => r3(v - origin[i]!)) as V3;
  return nb;
}

const sameBrick = (a: Brick, b: Brick): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The one-brick ghost turned by f (byte -> byte), back onto its low corner. False = can't. */
function turnGhostItem(f: (o: number) => number): boolean {
  const G = ed.ghost!, t = G.items[0]!;
  const nb = orientBrick(t, f(orientOf(t)));
  if (!nb) return false;
  const m = nb.lo.slice();
  nb.lo = nb.lo.map((v, i) => r3(v - m[i]!)) as V3; nb.hi = nb.hi.map((v, i) => r3(v - m[i]!)) as V3;
  G.items[0] = nb;
  return true;
}

function refuse(msg: string): void {
  resizeBlock.t = performance.now(); resizeBlock.reason = 'overlaps a brick';
  setStatus(msg); initAudio(); playError();
}

/**
 * Turn the focused brick by f. `tx` = the gesture's undo step is already open (reorient drag).
 * Returns false when refused (overlap, or not drawable that way).
 */
function turnFocused(f: (o: number) => number, label: string, tx: { open: boolean }): boolean {
  const b = S.bricks[S.sel];
  if (!b || S.held) return false;
  const nb = orientBrick(b, f(orientOf(b)));
  if (!nb) { refuse(`Can't ${label} ${itemName(b)} that way`); return false; }
  if (sameBrick(nb, b)) return true;
  if (focusChangeHits(b.lo, b.hi, nb.lo, nb.hi)) { refuse(`Can't ${label} ${itemName(b)}: overlaps a brick`); return false; }
  if (!tx.open || !hist.open) { histBegin(label); tx.open = true; }
  const lo = b.lo, hi = b.hi, keep = S.cam.half;
  for (const k of ORIENT_KEYS) delete (b as unknown as Record<string, unknown>)[k];
  Object.assign(b, nb);
  b.lo = lo; b.hi = hi; lo.splice(0, 3, ...nb.lo); hi.splice(0, 3, ...nb.hi);   // S.lo / S.hi are these arrays
  markBrick(S.sel);
  selectBrick(S.sel);                    // size grid, menu and frame follow the new orientation
  keepZoom(keep);
  return true;
}

/** R tap: one clockwise step (Shift: counter-clockwise) for the ghost, else the focused brick. */
export function rotateTap(dir: 1 | -1): void {
  const f = (o: number): number => rotateBy(o, dir);
  const G = ed.ghost;
  if (G) {
    if (G.items.length === 1 && turnGhostItem(f)) { initAudio(); playClick(); return; }
    rotateItems(G.items, dir); initAudio(); playClick();          // a group turns about world Z
    return;
  }
  if (!S.bricks[S.sel]) return;
  const tx = { open: false };
  const ok = turnFocused(f, 'rotate', tx);
  if (tx.open) histEnd();
  if (ok) { initAudio(); playClick(); setStatus(`Rotated ${itemName(S.bricks[S.sel])}`); }
}

/** An R-held reorient gesture: measured from where the pointer was when R went down. */
interface Gesture { start: [number, number]; dir: string | null; moved: boolean; tx: { open: boolean } }
let gest: Gesture | null = null;

export const reorienting = (): boolean => !!gest;
/** True once the gesture picked a direction (so releasing R is not a tap). */
export const gestureMoved = (): boolean => !!gest?.moved;

export function beginReorient(at: [number, number] | null): void {
  gest = { start: at ? [at[0], at[1]] : [innerWidth / 2, innerHeight / 2], dir: null, moved: false, tx: { open: false } };
}

/** Pointer moved while R is held. */
export function reorientMove(p: [number, number]): void {
  const g = gest;
  if (!g) return;
  const d = dragToWorldDir([p[0] - g.start[0], p[1] - g.start[1]], cameraBasisFromView(S.view));
  if (!d) return;
  g.moved = true;
  const key = d.join(',');
  if (key === g.dir) return;
  g.dir = key;
  const f = (o: number): number => reorientTo(o, d);
  const G = ed.ghost;
  if (G) {
    if (G.items.length !== 1) { setStatus(`Reorient works on one brick; ${ghostName(G.items)} turn with R taps`); initAudio(); playError(); return; }
    if (turnGhostItem(f)) { initAudio(); playClick(); } else { setStatus(`Can't turn ${ghostName(G.items)} that way`); initAudio(); playError(); }
    return;
  }
  if (turnFocused(f, 'reorient', g.tx)) { initAudio(); playClick(); setStatus(`Reoriented ${itemName(S.bricks[S.sel])}: top toward ${axisLabel(d)}`); }
}

/** R released (or focus lost): returns true when it was a plain tap. */
export function endReorient(): boolean {
  const g = gest;
  gest = null;
  if (!g) return false;
  if (g.tx.open) histEnd();
  return !g.moved;
}

const axisLabel = (v: readonly number[]): string => { const i = v.findIndex((c) => c !== 0); return (v[i]! > 0 ? '+' : '-') + 'XYZ'[i]!; };
