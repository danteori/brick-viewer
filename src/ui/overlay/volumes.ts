// Read-only previews of zone and light components (backlog W-13 and C-08), two toggles in the Esc menu.
// Zones: the zone of an AttachedZone component as a translucent box over the brick's footprint, from
// ZoneStartDistance to ZoneEndDistance (brick units) above its top face; water zones are blue.
// Lights: a glow sprite for a point light, a cone for a spot light, from colour, radius and brightness.
// Both are SVG over the canvas, like the wire view. Nothing is drawn while a toggle is off, so
// renders and goldens do not change.

import { debugFlag, onDebugFlagChange } from '../../app/debugflags.ts';
import { hiddenShown } from '../../app/hidden.ts';
import { S } from '../../app/state.ts';
import { BRZ_UNIT } from '../../core/units.ts';
import { camSignature, toView } from '../../render/camera.ts';
import { isHiddenRow, hiddenBit } from '../../scene/hidden.ts';
import { componentsOf, onComponentsChange } from '../../scene/compmodel.ts';
import type { ComponentInstance } from '../../scene/components.ts';
import { initAudio, playClick } from '../audio.ts';
import { setStatus } from '../status.ts';

const MAX_LIGHTS = 500, MAX_ZONES = 300, CONE_SIDES = 16, CONE_LENGTH = 300, GLOW_MAX_PX = 180;
const flagZoneFill = debugFlag('zones-outline', 'Zone boxes: outline only, no translucent fill');
const flagGlowSize = debugFlag('lights-glow-size', 'Light glow: a small halo sized by brightness, not the full light radius');

export const volumeView = { zones: false, lights: false, drawn: { zones: 0, water: 0, point: 0, spot: 0 } };

let svg: SVGSVGElement, canvas: HTMLCanvasElement, zoneBtn: HTMLButtonElement, lightBtn: HTMLButtonElement;
let shownKey = '';

const f1 = (v: number): string => v.toFixed(1);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function makeButton(id: string, title: string, label: string, toggle: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button'; b.id = id; b.title = title; b.setAttribute('aria-pressed', 'false');
  b.textContent = `${label}: off`;
  b.addEventListener('click', () => { toggle(); initAudio(); playClick(); });
  document.getElementById('mview')!.append(b);
  return b;
}

export function initVolumes(c: HTMLCanvasElement): void {
  canvas = c;
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'volumes';
  svg.setAttribute('aria-label', 'Zones and lights');
  document.getElementById('ov')!.after(svg);
  zoneBtn = makeButton('zonesbtn', 'Zones: draw zone components as translucent boxes (water zones blue)', 'Zones', () => setZoneView(!volumeView.zones));
  lightBtn = makeButton('lightsbtn', 'Lights: draw point and spot light components as glow sprites and cones', 'Lights', () => setLightView(!volumeView.lights));
  onComponentsChange(() => { shownKey = ''; });
  S.hooks.loaded.push(() => { shownKey = ''; });
  onDebugFlagChange(() => { shownKey = ''; });
}

function refresh(): void {
  shownKey = '';
  if (!volumeView.zones && !volumeView.lights) svg.replaceChildren();
}

export function setZoneView(on: boolean): void {
  volumeView.zones = on;
  zoneBtn.setAttribute('aria-pressed', String(on));
  zoneBtn.textContent = on ? 'Zones: on' : 'Zones: off';
  refresh();
  setStatus(on ? 'Zones shown' : 'Zones hidden');
}

export function setLightView(on: boolean): void {
  volumeView.lights = on;
  lightBtn.setAttribute('aria-pressed', String(on));
  lightBtn.textContent = on ? 'Lights: on' : 'Lights: off';
  refresh();
  setStatus(on ? 'Lights shown' : 'Lights hidden');
}

export const redrawVolumes = (): void => { shownKey = ''; };

function colourOf(d: Record<string, unknown> | null, scene: typeof S.scene, row: number): string {
  const c = d?.Color as Record<string, number> | undefined;
  if (d?.bUseBrickColor === true && row >= 0) {
    const v = scene.color[row]!;
    return `rgb(${v & 255},${(v >>> 8) & 255},${(v >>> 16) & 255})`;
  }
  if (!c) return 'rgb(255,240,200)';
  return `rgb(${num(c.R, 255) & 255},${num(c.G, 255) & 255},${num(c.B, 255) & 255})`;
}

/** Unreal rotator (degrees, +X forward, +Z up) to a unit direction in brick axes. */
export function rotatorDirection(pitch: number, yaw: number): [number, number, number] {
  const p = pitch * Math.PI / 180, y = yaw * Math.PI / 180;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p)];
}

/** Zone box (brick units) over a brick box: footprint, from `start` to `end` above the top face. */
export function zoneBox(box: readonly number[], start: number, end: number): [number[], number[]] {
  const lo = [box[0]!, box[1]!, box[5]! + start], hi = [box[3]!, box[4]!, box[5]! + end];
  return [lo, hi];
}

const FACES = [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]];

/** Per frame, after rendering: redraws the volumes when the camera, the bricks or the components changed. */
export function drawVolumes(sx: number, sy: number): void {
  if (!volumeView.zones && !volumeView.lights) return;
  const m = componentsOf(S.scene), cw = canvas.clientWidth, ch = canvas.clientHeight;
  const key = [S.scene.rev, camSignature(), cw, ch, S.hidden.size, hiddenShown(), m?.version ?? -1, volumeView.zones, volumeView.lights, flagZoneFill.on, flagGlowSize.on].join('|');
  if (key === shownKey) return;
  shownKey = key;
  volumeView.drawn = { zones: 0, water: 0, point: 0, spot: 0 };
  if (!m) { svg.replaceChildren(); return; }
  const { cam } = S, scene = S.scene, shown = hiddenShown(), bit = hiddenBit(scene);
  const P = (p: readonly number[]): [number, number] => { const v = toView(p[0]! * BRZ_UNIT, p[1]! * BRZ_UNIT, p[2]! * BRZ_UNIT); return [((v[0] - cam.x) * sx + 1) * cw / 2, (1 - (v[1] - cam.y) * sy) * ch / 2]; };
  const onScreen = (x: number, y: number, pad: number): boolean => x > -pad && y > -pad && x < cw + pad && y < ch + pad;
  const bx = new Array<number>(6), defs: string[] = [], zones: string[] = [], lights: string[] = [];
  const usable = (c: ComponentInstance): number => {
    const row = m.rowOfRef(c.brickRef);
    if (row < 0 || S.hidden.has(row) || !scene.alive(row) || (!shown && isHiddenRow(scene, row, bit))) return -1;
    scene.box(row, bx);
    return row;
  };
  for (const c of m.store.instances) {
    const isZone = c.type.endsWith('AttachedZone'), isPoint = c.type.endsWith('PointLight'), isSpot = c.type.endsWith('SpotLight');
    if (!isZone && !isPoint && !isSpot) continue;
    if (isZone ? !volumeView.zones : !volumeView.lights) continue;
    const row = usable(c);
    if (row < 0) continue;
    const d = c.data as Record<string, unknown> | null;
    const box = bx.map((v) => v);
    if (isZone) {
      if (volumeView.drawn.zones >= MAX_ZONES) continue;
      const water = d?.bWater === true;
      const [lo, hi] = zoneBox(box, num(d?.ZoneStartDistance), num(d?.ZoneEndDistance, 60));
      const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => P([i & 1 ? hi[0]! : lo[0]!, i & 2 ? hi[1]! : lo[1]!, i & 4 ? hi[2]! : lo[2]!]));
      if (!pts.some(([x, y]) => onScreen(x, y, 300))) continue;
      volumeView.drawn.zones++; if (water) volumeView.drawn.water++;
      const col = water ? '#2f9bff' : '#ffb020', fill = flagZoneFill.on ? 'none' : col;
      zones.push(`<g class="zone${water ? ' water' : ''}" data-row="${row}" stroke="${col}" fill="${fill}">${FACES.map((f) => `<polygon points="${f.map((i) => `${f1(pts[i]![0])},${f1(pts[i]![1])}`).join(' ')}"/>`).join('')}</g>`);
      continue;
    }
    if (volumeView.drawn.point + volumeView.drawn.spot >= MAX_LIGHTS || d?.bEnabled === false) continue;
    const centre = [(box[0]! + box[3]!) / 2, (box[1]! + box[4]!) / 2, (box[2]! + box[5]!) / 2];
    const [cx, cy] = P(centre);
    if (!onScreen(cx, cy, 250)) continue;
    const col = colourOf(d, scene, row), radius = num(d?.Radius, 100), bright = num(d?.Brightness, 10);
    if (isPoint) {
      const [ex, ey] = P([centre[0]! + radius, centre[1]!, centre[2]!]), [fx, fy] = P([centre[0]!, centre[1]! + radius, centre[2]!]);
      const reach = Math.max(Math.hypot(ex - cx, ey - cy), Math.hypot(fx - cx, fy - cy));
      const halo = Math.max(10, 6 + 7 * Math.log10(1 + bright) * Math.sqrt(canvas.clientWidth / 1000));
      const r = Math.min(GLOW_MAX_PX, flagGlowSize.on ? halo : Math.max(10, reach)), a = Math.min(0.85, 0.25 + 0.2 * Math.log10(1 + bright));
      const id = `lg${volumeView.drawn.point + volumeView.drawn.spot}`;
      defs.push(`<radialGradient id="${id}"><stop offset="0" stop-color="${col}" stop-opacity="${f1(a)}"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`);
      lights.push(`<circle class="glow point" data-row="${row}" cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="url(#${id})"/>`);
      volumeView.drawn.point++;
    } else {
      const rot = d?.Rotation as Record<string, number> | undefined;
      const dir = rotatorDirection(num(rot?.Pitch), num(rot?.Yaw));
      const up = Math.abs(dir[2]) > 0.95 ? [1, 0, 0] : [0, 0, 1];
      const side = [dir[1] * up[2]! - dir[2] * up[1]!, dir[2] * up[0]! - dir[0] * up[2]!, dir[0] * up[1]! - dir[1] * up[0]!];
      const sl = Math.hypot(side[0]!, side[1]!, side[2]!) || 1, s = side.map((v) => v / sl);
      const t = [dir[1] * s[2]! - dir[2] * s[1]!, dir[2] * s[0]! - dir[0] * s[2]!, dir[0] * s[1]! - dir[1] * s[0]!];
      const len = Math.min(radius, CONE_LENGTH), outer = Math.min(85, num(d?.OuterConeAngle, 45)) * Math.PI / 180, rr = len * Math.tan(outer);
      const ring: string[] = [];
      for (let i = 0; i < CONE_SIDES; i++) {
        const an = i / CONE_SIDES * Math.PI * 2, ca = Math.cos(an) * rr, sa = Math.sin(an) * rr;
        const [x, y] = P([centre[0]! + dir[0] * len + s[0]! * ca + t[0]! * sa, centre[1]! + dir[1] * len + s[1]! * ca + t[1]! * sa, centre[2]! + dir[2] * len + s[2]! * ca + t[2]! * sa]);
        ring.push(`${f1(x)},${f1(y)}`);
      }
      const a = Math.min(0.5, 0.12 + 0.1 * Math.log10(1 + bright));
      lights.push(`<g class="glow spot" data-row="${row}" fill="${col}" fill-opacity="${f1(a)}" stroke="${col}"><polygon points="${ring.join(' ')}"/>${[0, 1, 2, 3].map((q) => `<polygon points="${f1(cx)},${f1(cy)} ${ring[q * CONE_SIDES / 4]} ${ring[(q * CONE_SIDES / 4 + CONE_SIDES / 4) % CONE_SIDES]}"/>`).join('')}<circle cx="${f1(cx)}" cy="${f1(cy)}" r="3" stroke="none"/></g>`);
      volumeView.drawn.spot++;
    }
  }
  svg.innerHTML = `<defs>${defs.join('')}</defs>${zones.join('')}${lights.join('')}`;
}
