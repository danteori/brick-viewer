// The App context: the scene, the focus, the camera and the interaction state, shared by every
// module. The scene is a SceneStore (src/scene/store.ts, ARCHITECTURE.md section 4): bricks as SoA
// rows in integer units with stable ids. Everything on the CPU works in ABSOLUTE coordinates
// (viewer units, 1 stud = 0.2); only the GPU sees positions relative to `origin`, the render origin
// near the camera (chunk offsets are computed in doubles), so nothing is ever re-based.
// The legacy page hooks (editorDraw, editorHud, editorPlacing, editorPaste) are S.hooks.

import { BRICK, INITIAL } from '../core/units.ts';
import type { Mat4 } from '../core/math.ts';
import { viewOf } from '../core/math.ts';
import { sizeRule, type Brick, type SizeRule, type V3 } from '../scene/brick.ts';
import { ASSETS, F_ALIVE, GRIDS, MATERIALS, SceneStore } from '../scene/store.ts';
import type { GroundPlateLook } from '../env/ground-plate.ts';

export const ELEV = Math.atan(1 / Math.SQRT2);             // 35.2644 degrees
export const YAW0 = -Math.PI / 4;

/** One screen-space axis direction: world axis i, sign d, unit screen vector v (px, y down). */
export interface AxisDir { i: number; d: number; v: [number, number] }

/**
 * An undoable edit of some rows: each id's BrickRecord before and after (`has` 0 = the brick
 * didn't exist on that side), the focus on each side and, for selection operations, the selection.
 */
export interface EditTx {
  kind: 'edit';
  label: string;
  /** the focused brick when the transaction was opened (colour drags merge on it) */
  sel: number;
  ids: number[];
  before: Uint8Array;
  beforeHas: Uint8Array;
  after?: Uint8Array;
  afterHas?: Uint8Array;
  focusBefore: number;
  focusAfter: number;
  selBefore?: number[];
  selAfter?: number[];
}
/** A scene as a load's undo keeps it: the store, the focus, the zoom and the render origin (the camera's frame). */
export interface SceneSnap { scene: SceneStore; sel: number; zoom: number; origin: V3 }
export interface SceneTx { kind: 'scene'; label: string; before: SceneSnap; after: SceneSnap }
export type Tx = EditTx | SceneTx;

export interface Hooks {
  /** end of the frame: the placement ghost */
  draw: (() => void)[];
  /** extra HUD lines */
  hud: (() => string)[];
  /** a placement ghost is out: no hover / grab highlights */
  placing: () => boolean;
  /** an undo / redo is about to change the scene (the editor drops its ghost) */
  beforeTx: (() => void)[];
  /** after an undo / redo was applied */
  afterTx: ((t: Tx, side: 'before' | 'after') => void)[];
  /** Ctrl+V in "Paste brick" mode; true = handled */
  paste: (e: ClipboardEvent) => boolean;
  /** before / after a save loads */
  beforeLoad: (() => void)[];
  loaded: (() => void)[];
}

/** The startup scene: a red 2x2 brick (#FA4040) centred on the origin. */
export function startScene(): SceneStore {
  const s = new SceneStore(), id = s.alloc();
  s.hx[id] = 10; s.hy[id] = 10; s.hz[id] = 6; s.orient[id] = 16;
  s.asset[id] = ASSETS.id('PB_DefaultBrick'); s.material[id] = MATERIALS.id('BMC_Plastic'); s.grid[id] = GRIDS.id('1');
  s.color[id] = (250 | (64 << 8) | (64 << 16) | (5 << 24)) >>> 0;
  s.flags[id] = F_ALIVE;
  s.touch(id);
  return s;
}
const scene0 = startScene();

export const S = {
  /** the scene's bricks */
  scene: scene0,
  /** the focused brick's id, or -1 (empty scene) */
  sel: 0,
  /** the focused brick as an editor record; S.lo / S.hi are its faces (pushFocus writes it back) */
  focus: null as Brick | null,
  /** the focused brick's target faces, absolute viewer units */
  lo: INITIAL.map((v) => -v) as V3,
  hi: INITIAL.slice() as V3,
  /** displayed faces (snapped to the target each frame) */
  dlo: INITIAL.map((v) => -v) as V3,
  dhi: INITIAL.slice() as V3,
  /**
   * The render origin (viewer units): GPU positions are relative to it so float32 stays exact near
   * the camera. Moved to the focused brick whenever the focus moves; nothing else depends on it.
   */
  origin: [0, 0, 0] as V3,
  /** ids not drawn and not colliding (the originals of a selection being moved) */
  hidden: new Set<number>(),
  /** the selection (E-01): ids, separate from the focus; empty = the focused brick alone */
  selection: new Set<number>(),
  micro: false,
  STEPS: BRICK.steps.slice() as V3,
  START: BRICK.start.slice() as V3,
  RULE: sizeRule(null) as SizeRule,

  // camera (absolute view-plane coordinates)
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
  /** the ground plate of the applied environment; null = none (the default: no environment applied) */
  ground: null as GroundPlateLook | null,
  /** ?test: the golden / parity hook is installed; world environments aren't applied on load */
  testMode: false,
  hooks: {
    draw: [], hud: [], beforeLoad: [], loaded: [], beforeTx: [], afterTx: [],
    placing: () => false,
    paste: () => false,
  } as Hooks,
  /** test hook: no UI overlays (hover washes, grab glow, editor ghost) in the render */
  noOverlay: false,
};

export type State = typeof S;

/** Is there a focused brick? */
export const hasFocus = (): boolean => S.sel >= 0 && S.focus !== null && S.scene.alive(S.sel);
