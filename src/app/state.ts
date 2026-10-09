// The App context: the scene, the focus, the camera and the interaction state, shared by every
// module. Phase 1 keeps the legacy viewer's model (one mutable state, box faces in viewer units);
// the page globals of the legacy file became the fields of S, and its hook functions
// (editorDraw, editorHud, editorPlacing, editorApplyList, editorPaste) became S.hooks.

import { BRICK, DEFAULT_COLOR, INITIAL } from '../core/units.ts';
import type { Mat4 } from '../core/math.ts';
import { viewOf } from '../core/math.ts';
import { sizeRule, type Brick, type SizeRule, type V3 } from '../scene/brick.ts';

export const ELEV = Math.atan(1 / Math.SQRT2);             // 35.2644 degrees
export const YAW0 = -Math.PI / 4;

/** One screen-space axis direction: world axis i, sign d, unit screen vector v (px, y down). */
export interface AxisDir { i: number; d: number; v: [number, number] }

export interface ListTx {
  kind: 'list';
  label: string;
  adds: [number, Brick][];
  removes: [number, Brick][];
  selBefore: number;
  selAfter: number;
}
export interface BrickTx { kind: 'brick'; label: string; sel: number; idx: number[]; before: Brick[]; after?: Brick[] }
export interface SceneSnap { list: Brick[]; origin: V3; sel: number; zoom: number }
export interface SceneTx { kind: 'scene'; label: string; before: SceneSnap; after: SceneSnap }
export type Tx = ListTx | BrickTx | SceneTx;

export interface Hooks {
  /** end of the frame: the placement ghost */
  draw: (() => void)[];
  /** extra HUD lines */
  hud: (() => string)[];
  /** a placement ghost is out: no hover / grab highlights */
  placing: () => boolean;
  /** undo / redo of bricks added or removed */
  applyList: (t: ListTx, side: 'before' | 'after') => void;
  /** Ctrl+V in "Paste brick" mode; true = handled */
  paste: (e: ClipboardEvent) => boolean;
  /** before / after a save loads */
  beforeLoad: (() => void)[];
  loaded: (() => void)[];
}

const startBrick: Brick = { lo: INITIAL.map((v) => -v) as V3, hi: INITIAL.slice() as V3, micro: false, color: DEFAULT_COLOR, up: 1 };

export const S = {
  bricks: [startBrick] as Brick[],
  sel: 0,
  /** the focused brick's target faces (its own arrays) */
  lo: startBrick.lo,
  hi: startBrick.hi,
  /** displayed faces (snapped to the target each frame) */
  dlo: startBrick.lo.slice() as V3,
  dhi: startBrick.hi.slice() as V3,
  /**
   * Total shift recenter() has applied to this scene: a brick's local coords + histOrigin are
   * frame-independent, so undo snapshots don't care how often the world was recentred since.
   */
  histOrigin: [0, 0, 0] as V3,
  micro: false,
  STEPS: BRICK.steps.slice() as V3,
  START: BRICK.start.slice() as V3,
  RULE: sizeRule(null) as SizeRule,

  // camera
  orbit: { yaw: YAW0, pitch: ELEV, yawT: YAW0, pitchT: ELEV, dragging: false, last: null as [number, number] | null },
  view: viewOf(YAW0, ELEV) as Mat4,
  viewT: viewOf(YAW0, ELEV) as Mat4,
  /** which face of X / Y / Z faces the camera: +1 hi, -1 lo */
  ns: [1, 1, 1] as V3,
  dirs: [] as AxisDir[],
  cam: { x: 0, y: 0, half: 0 },
  zoomMul: 1,
  userZoomed: false,
  /** C toggles: keep gliding the camera onto the brick while dragging */
  autoCenter: true,

  // resize drag
  anchor: null as [number, number] | null,
  cursor: null as [number, number] | null,
  active: null as AxisDir | null,
  held: false,
  /** grab[i]: 1 once this drag has resized axis i */
  grab: [0, 0, 0] as V3,
  lastAxis: -1,
  lockAxis: -1,
  bannedAxis: -1,
  dragDir: null as AxisDir | null,
  steppedThisDrag: false,
  pendAxis: -1,
  pendUnits: 0,
  edgeT: 0,

  // hover / pick
  hoverAxis: -1,
  hoverBrick: -1,
  hoverFace: -1,
  pickKey: '',
  mouse: null as [number, number] | null,
  mouseOnCanvas: false,

  lighting: 'default',
  hooks: {
    draw: [], hud: [], beforeLoad: [], loaded: [],
    placing: () => false,
    applyList: () => {},
    paste: () => false,
  } as Hooks,
  /** test hook: no UI overlays (hover washes, grab glow, editor ghost) in the render */
  noOverlay: false,
};

export type State = typeof S;
