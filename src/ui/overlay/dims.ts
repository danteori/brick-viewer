// SVG overlays: the dimension lines (stud count along each axis, just outside a visible edge: X on
// the bottom-left edge, Y on the bottom-right, Z on the right vertical edge), the lock arrow, the
// drag guide and the brick name label. An axis lights up while the drag is resizing it or its label
// is being edited.

import { S } from '../../app/state.ts';
import { ACCENT, THRESH } from '../../core/units.ts';
import { farOf, nearOf, studPx, toView } from '../../render/camera.ts';
import { grows, proposedBox, SNAP } from '../../editor/resize.ts';
import { updateHover } from '../../editor/hover.ts';
import { displayName, fmtUnits } from '../names.ts';
import { dimBox, menuInp } from '../panels/size.ts';
import { $ } from '../dom.ts';

const DIM_OFF = 18;                                      // px between the edge and its dimension line
let dimsEl: SVGSVGElement, ov: SVGSVGElement, nameEl: HTMLElement, canvas: HTMLCanvasElement;
let boxCenterPx: [number, number] = [0, 0], shownDims = '';

export function initDims(c: HTMLCanvasElement): void {
  canvas = c;
  dimsEl = document.getElementById('dims') as unknown as SVGSVGElement;
  ov = document.getElementById('ov') as unknown as SVGSVGElement;
  nameEl = $('name');
}

type P2 = [number, number];

function dimLine(a: P2, b: P2, n: string, axis: string, on: boolean, lock: boolean): string {
  const c = lock ? '#ffffff' : on ? ACCENT : '#c9ccd3', o = DIM_OFF;
  on = on || lock;
  // unit outward offset = perpendicular to the edge, pointing away from the box's screen centre
  const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1;
  let px = -ey / el, py = ex / el;
  const [cx, cy] = boxCenterPx;
  if (((a[0] + b[0]) / 2 - cx) * px + ((a[1] + b[1]) / 2 - cy) * py < 0) { px = -px; py = -py; }
  const A = [a[0] + px * o, a[1] + py * o], B = [b[0] + px * o, b[1] + py * o], M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
  const dia = (p: number[]): string => `<rect x="${p[0] - 3.5}" y="${p[1] - 3.5}" width="7" height="7" transform="rotate(45 ${p[0]} ${p[1]})" fill="${c}"/>`;
  let h = '';
  // extension lines from the edge out to the dimension line
  h += `<line x1="${a[0] + px * 4}" y1="${a[1] + py * 4}" x2="${A[0] + px * 5}" y2="${A[1] + py * 5}" stroke="${c}" stroke-opacity=".45"/>`;
  h += `<line x1="${b[0] + px * 4}" y1="${b[1] + py * 4}" x2="${B[0] + px * 5}" y2="${B[1] + py * 5}" stroke="${c}" stroke-opacity=".45"/>`;
  h += `<line x1="${A[0]}" y1="${A[1]}" x2="${B[0]}" y2="${B[1]}" stroke="${c}" stroke-width="${on ? 2.5 : 1.5}"/>`;
  h += dia(A) + dia(B);
  // the label is an HTML input parked on the line's midpoint
  const d = dimBox['XYZ'.indexOf(axis)], editing = document.activeElement === d.inp;
  d.box.style.left = M[0] + 'px'; d.box.style.top = M[1] + 'px';
  d.box.classList.toggle('on', on && !lock);
  d.box.classList.toggle('lock', !!lock);
  if (!editing) { if (d.inp.value !== `${n}`) d.inp.value = n; d.fitWidth(); }
  return h;
}

/** Arrow out of the centre of the locked axis's moving (near) face, pointing out of that face. */
function lockArrow(P: (X: number, Y: number, Z: number) => P2, i: number): string {
  const [pl, ph] = proposedBox();
  const c = [0, 1, 2].map((k) => (k === i ? nearOf(k, pl, ph) : (pl[k] + ph[k]) / 2));
  const a = P(c[0], c[1], c[2]);
  const e = c.slice(); e[i] += S.ns[i];
  const b = P(e[0], e[1], e[2]), L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, px = -uy, py = ux;
  const s = [a[0] + ux * 8, a[1] + uy * 8], t = [a[0] + ux * 62, a[1] + uy * 62];          // shaft
  const tip = [a[0] + ux * 80, a[1] + uy * 80];
  const head = `${tip[0]},${tip[1]} ${t[0] + px * 10},${t[1] + py * 10} ${t[0] - px * 10},${t[1] - py * 10}`;
  return '<g filter="url(#glow)">' +
    `<line x1="${s[0]}" y1="${s[1]}" x2="${t[0]}" y2="${t[1]}" stroke="#1d1e21" stroke-width="7" stroke-linecap="round"/>` +
    `<polygon points="${head}" fill="#1d1e21" stroke="#1d1e21" stroke-width="3" stroke-linejoin="round"/>` +
    `<line x1="${s[0]}" y1="${s[1]}" x2="${t[0]}" y2="${t[1]}" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/>` +
    `<polygon points="${head}" fill="#fff"/>` +
    `<circle cx="${a[0]}" cy="${a[1]}" r="4" fill="#fff" stroke="#1d1e21" stroke-width="2"/></g>`;
}

/** Per frame, after rendering: hover pick, dimension lines, the size menu and the name label. */
export function drawDims(sx: number, sy: number): void {
  const cw = canvas.clientWidth, ch = canvas.clientHeight, { cam } = S;
  document.body.classList.toggle('empty', !S.bricks[S.sel]);   // empty scene: no dimension labels / name (CSS)
  if (!S.bricks[S.sel]) { updateHover(canvas, sx, sy); if (shownDims) dimsEl.innerHTML = shownDims = ''; return; }
  const P = (X: number, Y: number, Z: number): P2 => { const v = toView(X, Y, Z); return [((v[0] - cam.x) * sx + 1) * cw / 2, (1 - (v[1] - cam.y) * sy) * ch / 2]; };
  const [l, u] = proposedBox();                         // dimensions show the size with the ghost applied
  boxCenterPx = P((l[0] + u[0]) / 2, (l[1] + u[1]) / 2, (l[2] + u[2]) / 2);
  const nX = nearOf(0, l, u), nY = nearOf(1, l, u), fY = farOf(1, l, u), fZ = farOf(2, l, u);   // X/Y dims run along the far-Z edges
  updateHover(canvas, sx, sy);
  // Z goes on the vertical edge at the right-most bottom corner on screen
  let zc = [nX, fY], zx = -1e9;
  for (const X of [l[0], u[0]]) for (const Y of [l[1], u[1]]) { const s = P(X, Y, fZ)[0]; if (s > zx) { zx = s; zc = [X, Y]; } }
  const n = (i: number): string => fmtUnits(i, Math.round((u[i] - l[i]) / S.STEPS[i]));
  const on = (i: number): boolean => (S.held && S.grab[i] !== 0) || document.activeElement === dimBox[i].inp;
  const lock = (i: number): boolean => S.held && S.lockAxis === i;
  const dimsHtml =
    '<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur in="SourceGraphic" stdDeviation="3" result="b"/>' +
    '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>' +
    dimLine(P(l[0], nY, fZ), P(u[0], nY, fZ), n(0), 'X', on(0), lock(0)) +
    dimLine(P(nX, l[1], fZ), P(nX, u[1], fZ), n(1), 'Y', on(1), lock(1)) +
    dimLine(P(zc[0], zc[1], l[2]), P(zc[0], zc[1], u[2]), n(2), 'Z', on(2), lock(2)) +
    (S.held && S.lockAxis >= 0 ? lockArrow(P, S.lockAxis) : '');
  if (dimsHtml !== shownDims) dimsEl.innerHTML = shownDims = dimsHtml;   // no DOM work when nothing moved

  // menu fields follow the brick unless being typed in
  menuInp.forEach((inp, i) => { if (document.activeElement !== inp && inp.value !== n(i)) inp.value = n(i); });

  // name label: centred above the brick's highest on-screen point
  const pu = (i: number): number => Math.round((u[i] - l[i]) / S.STEPS[i]);
  let top = 1e9;
  for (let c = 0; c < 8; c++) top = Math.min(top, P(c & 1 ? u[0] : l[0], c & 2 ? u[1] : l[1], c & 4 ? u[2] : l[2])[1]);
  const label = displayName(S.bricks[S.sel], pu(0), pu(1), pu(2));
  if (nameEl.textContent !== label) nameEl.textContent = label;
  nameEl.style.left = boxCenterPx[0] + 'px'; nameEl.style.top = (top - 14) + 'px';
}

/** the drag guide: the anchor, the six axis directions and the line to the cursor */
export function drawGuide(): void {
  if (!S.anchor) return;
  const [ax, ay] = S.anchor; let h = '';
  h += `<circle cx="${ax}" cy="${ay}" r="${(SNAP * studPx(0)).toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity=".15" stroke-dasharray="3 4"/>`;
  for (const q of S.dirs) {
    // locked: only the locked axis is shown; unlocked: the banned axis is faded out
    const off = S.lockAxis >= 0 ? q.i !== S.lockAxis : q.i === S.bannedAxis;
    const on = S.active === q, c = on ? ACCENT : 'currentColor', k = off ? .2 : 1;
    h += `<line x1="${ax + q.v[0] * 14}" y1="${ay + q.v[1] * 14}" x2="${ax + q.v[0] * THRESH}" y2="${ay + q.v[1] * THRESH}" stroke="${c}" stroke-opacity="${(on ? 1 : .3) * k}" stroke-width="${on ? 3 : 1.5}" stroke-linecap="round"/>`;
    const lbl = 'XYZ'[q.i] + (grows(q) ? '+' : '−');    // what a step this way would do right now
    h += `<text x="${ax + q.v[0] * (THRESH + 12)}" y="${ay + q.v[1] * (THRESH + 12) + 4}" text-anchor="middle" font-size="10" fill="${c}" fill-opacity="${(on ? 1 : .4) * k}">${lbl}</text>`;
  }
  h += `<circle cx="${ax}" cy="${ay}" r="3" fill="currentColor"/>`;
  if (S.cursor) h += `<line x1="${ax}" y1="${ay}" x2="${S.cursor[0]}" y2="${S.cursor[1]}" stroke="${S.active ? ACCENT : 'currentColor'}" stroke-opacity=".5"/>`;
  ov.innerHTML = h;
}

export function clearGuide(): void { if (ov) ov.innerHTML = ''; }
