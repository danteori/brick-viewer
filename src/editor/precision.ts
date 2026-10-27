import { S, type AxisDir } from '../app/state.ts';
import { r3 } from '../core/units.ts';
import { studPx } from '../render/camera.ts';
import { ed, gsteps, poseGhost } from './ghost.ts';
import { axisDragFinish, axisDragMove, newAxisDrag, type AxisDrag } from './axisdrag.ts';
import { placeGhost } from './ops.ts';
import { initAudio, playClick } from '../ui/audio.ts';
import { setStatus } from '../ui/status.ts';
import { placeholder } from '../ui/placeholder.ts';

const ON_TEXT = placeholder('Precision mode: drag to move the brick');
const OFF_TEXT = placeholder('Precision mode off');
const NO_POSE_TEXT = placeholder('Point at the scene first');
const PLACE_TEXT = placeholder('Place');
export const PRECISION_HINT = placeholder('C toggles precision mode');
export const PRECISION_ON_HINT = placeholder('drag moves the brick along its axes, right-click finishes an axis, PgUp / PgDn raise / lower, Enter places');

interface Move {
  axes: AxisDrag;
  axis: number;
  pending: number;
}
let move: Move | null = null;
let button: HTMLButtonElement | null = null;

/** Whether `key` toggles precision mode: C, or G as an alias; C is autoCenter in the classic camera. */
export const togglesPrecision = (key: string, classic: boolean): boolean => {
  const k = key.toLowerCase();
  return k === 'g' || (k === 'c' && !classic);
};

/** The ghost is in precision mode: it sits where it was and the drag moves it. */
export const precisionOn = (): boolean => !!ed.ghost && !!ed.fixedPose;

/** A precision drag is under way. */
export const precisionDragging = (): boolean => precisionOn() && !!move;

/** Precision mode starts at the ghost's current pose. Refused when the ghost has none. */
export function enterPrecision(): boolean {
  const G = ed.ghost;
  if (!G || G.mode !== 'click' || S.held) return false;
  if (!ed.fixedPose) {
    poseGhost();
    if (!G.pose) { setStatus(NO_POSE_TEXT); return false; }
    ed.fixedPose = G.pose.slice() as typeof G.pose;
    G.dz = 0;
  }
  setStatus(ON_TEXT);
  initAudio(); playClick();
  return true;
}

/** Precision mode ends; the ghost follows the cursor again. */
export function leavePrecision(): void {
  if (!ed.fixedPose) return;
  ed.fixedPose = null; move = null;
  setStatus(OFF_TEXT);
  initAudio(); playClick();
}

export function togglePrecision(): void {
  if (precisionOn()) leavePrecision(); else enterPrecision();
}

const unit = (i: number): number => {
  const st = gsteps(ed.ghost!.items)[i]!;
  return studPx(i) / S.STEPS[i]! * st;
};

function step(q: AxisDir): void {
  const m = move, p = ed.fixedPose;
  if (!m || !p || !ed.ghost) return;
  if (m.axis !== q.i) { m.axis = q.i; m.pending = 0; }
  p[q.i] = r3(p[q.i]! + q.d * gsteps(ed.ghost.items)[q.i]!);
  m.pending += q.d;
  m.axes.lockAxis = m.pending ? m.axis : -1;
}

/** The left button went down at `at`: the drag starts. */
export function precisionPress(at: [number, number]): void {
  move = { axes: newAxisDrag(at.slice() as [number, number]), axis: -1, pending: 0 };
}

/** The cursor moved: the ghost steps along the axis the drag follows. */
export function precisionMove(at: [number, number]): void {
  if (!move || !ed.ghost) return;
  axisDragMove(move.axes, at, S.dirs, unit, step);
}

/** A right-click during the drag: the axis in progress is finished, and the drag can go another way. */
export function precisionFinishAxis(at: [number, number] | null): void {
  if (!move) return;
  axisDragFinish(move.axes, move.axis, at);
  move.axis = -1; move.pending = 0;
  initAudio(); playClick();
}

export function precisionRelease(): void { move = null; }

/** The Place button: the ghost goes down where it is, and precision mode stays on. */
export function placeFromPrecision(): void {
  const G = ed.ghost;
  if (!G || !ed.fixedPose) return;
  if (!placeGhost()) return;
  move = null;
}

/** Makes the Place button and keeps it in step with the mode. */
export function initPrecision(): void {
  button = document.createElement('button');
  button.id = 'precplace'; button.type = 'button'; button.textContent = PLACE_TEXT; button.hidden = true;
  button.addEventListener('click', placeFromPrecision);
  document.body.append(button);
  S.hooks.draw.push(() => { if (button) button.hidden = !precisionOn(); });
}
