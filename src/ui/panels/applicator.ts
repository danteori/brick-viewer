// The Applicator section of Brick Properties (backlog E-06), under Paint, collapsed by default:
// a brick type list and a material list, each with an Apply button that changes the selection
// (or the focused brick) as one undo step (src/editor/applicator.ts). "From focused" sets both
// lists to the focused brick's type and material. The chosen type and material are remembered.

import { S, hasFocus } from '../../app/state.ts';
import { loadString, saveString } from '../../app/settings.ts';
import { BrickShapes } from '../../render/meshes/shapes.js';
import { applyMaterial, applyType } from '../../editor/applicator.ts';
import { MATERIALS as MATERIAL_NAMES, materialLabel } from '../../editor/paint.ts';
import { ed } from '../../editor/ghost.ts';
import { knownTarget } from '../../scene/convert.ts';
import { ASSETS, MATERIALS } from '../../scene/store.ts';
import { ROUND_NAMES, shapeLabel } from '../names.ts';
import { $ } from '../dom.ts';

const TYPE_KEY = 'brickViewer.applyType', MAT_KEY = 'brickViewer.applyMaterial';

/** The types offered, by group (only ones the viewer draws). */
export function applicatorTypes(): { group: string; assets: string[] }[] {
  const groups: { group: string; assets: string[] }[] = [
    { group: 'Basic', assets: ['PB_DefaultBrick', 'PB_DefaultTile', 'PB_DefaultSmoothTile', 'PB_DefaultMicroBrick', 'PB_DefaultStudded'] },
    { group: 'Ramps', assets: ['PB_DefaultRamp', 'PB_DefaultRampInverted', 'PB_DefaultRampCrest', 'PB_DefaultRampCrestEnd', 'PB_DefaultRampCorner', 'PB_DefaultRampCornerInverted',
      'PB_DefaultRampInnerCorner', 'PB_DefaultRampInnerCornerInverted', 'PB_DefaultRampCrestCorner'] },
    { group: 'Wedges and arches', assets: ['PB_DefaultWedge', 'PB_DefaultSideWedge', 'PB_DefaultSideWedgeTile', 'PB_DefaultArch', 'PB_DefaultArchInverted'] },
    { group: 'Special', assets: ['PB_RoundedCap', 'BP_RoundPlate', 'BP_SquarePlate', 'BP_SpikePlate', 'BP_LatticeThin', 'PB_PicketFence', 'PB_Spike', 'PB_Baguette',
      'PB_AerodynamicSurface', 'PB_AerodynamicSurfaceVertical'] },
    { group: 'Micro', assets: Object.keys(BrickShapes.MICRO_TYPES).filter((a) => a !== 'PB_DefaultMicroBrick').sort() },
    { group: 'Rounds (fixed size)', assets: Object.keys(ROUND_NAMES) },
    { group: 'Fixed size', assets: Object.keys(BrickShapes.FIXED_SHAPES).sort((a, b) => shapeLabel(a).localeCompare(shapeLabel(b))) },
  ];
  for (const g of groups) g.assets = g.assets.filter(knownTarget);
  return groups.filter((g) => g.assets.length);
}

let typeSel: HTMLSelectElement, matSel: HTMLSelectElement, buttons: HTMLButtonElement[] = [], shown = '';

function fill(): void {
  for (const g of applicatorTypes()) {
    const og = document.createElement('optgroup');
    og.label = g.group;
    for (const a of g.assets) og.append(new Option(ROUND_NAMES[a] ?? shapeLabel(a), a));
    typeSel.append(og);
  }
  for (const m of MATERIAL_NAMES) matSel.add(new Option(materialLabel(m), m));
  const t = loadString(TYPE_KEY), m = loadString(MAT_KEY);
  if (t && !S.testMode && [...typeSel.options].some((o) => o.value === t)) typeSel.value = t;
  if (m && !S.testMode && (MATERIAL_NAMES as readonly string[]).includes(m)) matSel.value = m;
}

export function initApplicatorPanel(): void {
  const toggle = $<HTMLButtonElement>('apptoggle'), body = $('appbody');
  typeSel = $<HTMLSelectElement>('apptype'); matSel = $<HTMLSelectElement>('appmat');
  fill();
  toggle.addEventListener('click', () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  typeSel.addEventListener('change', () => saveString(TYPE_KEY, typeSel.value));
  matSel.addEventListener('change', () => saveString(MAT_KEY, matSel.value));
  buttons = [...body.querySelectorAll<HTMLButtonElement>('button')];
  $('appapplytype').addEventListener('click', () => { if (!S.held && !ed.ghost) applyType(typeSel.value); });
  $('appapplymat').addEventListener('click', () => { if (!S.held && !ed.ghost) applyMaterial(matSel.value); });
  $('apppick').addEventListener('click', () => {
    if (!hasFocus()) return;
    const a = ASSETS.name(S.scene.asset[S.sel]!), m = MATERIALS.name(S.scene.material[S.sel]!);
    if ([...typeSel.options].some((o) => o.value === a)) { typeSel.value = a; saveString(TYPE_KEY, a); }
    if ((MATERIAL_NAMES as readonly string[]).includes(m)) { matSel.value = m; saveString(MAT_KEY, m); }
  });
  for (const t of ['pointerdown', 'dblclick', 'wheel']) body.addEventListener(t, (ev) => ev.stopPropagation());
}

/** Per-frame: the buttons are enabled while there is something to change. */
export function tickApplicator(): void {
  const ok = (S.selection.size > 0 || hasFocus()) && !S.held && !ed.ghost, key = `${ok}|${hasFocus()}`;
  if (key === shown || !buttons.length) return;
  shown = key;
  for (const b of buttons) b.disabled = b.id === 'apppick' ? !hasFocus() : !ok;
}
