// The graphics settings (L-06), both builds: the game's Options/Graphics preset (format/graphics.ts)
// plus two viewer switches, kept in localStorage and mapped onto the renderer's effects
// (render/fx/state.ts wantFromPreset). The full build's Graphics panel (ui/panels/graphics.ts)
// edits them; the lite build uses what is stored, or the defaults.
//
// ?test mode ignores storage and starts with the effects off (the goldens), until a test calls
// the test hook's setGraphics.

import { S } from './state.ts';
import { loadString, saveString } from './settings.ts';
import { cloneGraphicsPreset, defaultGraphicsPreset, parseGraphicsPreset, serialiseGraphicsPreset, type GraphicsPreset } from '../format/graphics.ts';
import { fx, wantFromPreset } from '../render/fx/state.ts';
import { invalidateFx } from '../render/fx/frame.ts';

export const GRAPHICS_KEY = 'brickViewer.graphics';

export interface ViewerGfx {
  /** the graphics effects master switch */
  effects: boolean;
  /** step effects down on heavy scenes */
  adaptive: boolean;
}

const state = {
  preset: defaultGraphicsPreset(),
  viewer: { effects: true, adaptive: true } as ViewerGfx,
  fileName: 'graphics.bp',
  listeners: [] as (() => void)[],
};

function apply(): void {
  fx.want = wantFromPreset(state.preset, state.viewer.effects, state.viewer.adaptive);
  invalidateFx();
  for (const f of state.listeners) f();
}

function persist(): void {
  if (S.testMode) return;
  saveString(GRAPHICS_KEY, JSON.stringify({ bp: serialiseGraphicsPreset(state.preset), viewer: state.viewer, name: state.fileName }));
}

/** Reads the stored settings (call once at start-up). */
export function initGraphics(): void {
  if (!S.testMode) {
    const raw = loadString(GRAPHICS_KEY);
    if (raw) {
      try {
        const j = JSON.parse(raw) as { bp?: string; viewer?: Partial<ViewerGfx>; name?: string };
        if (j.bp) state.preset = parseGraphicsPreset(j.bp);
        if (j.viewer) state.viewer = { ...state.viewer, ...j.viewer };
        if (j.name) state.fileName = j.name;
      } catch (e) { console.warn('stored graphics settings unreadable; using the defaults', e); }
    }
  } else state.viewer.effects = false;
  apply();
}

export const graphicsPreset = (): GraphicsPreset => cloneGraphicsPreset(state.preset);
export const viewerGraphics = (): ViewerGfx => ({ ...state.viewer });
export const graphicsFileName = (): string => state.fileName;

export function setGraphicsPreset(p: GraphicsPreset, fileName?: string): void {
  state.preset = cloneGraphicsPreset(p);
  if (fileName) state.fileName = fileName;
  apply(); persist();
}

export function setViewerGraphics(v: Partial<ViewerGfx>): void {
  state.viewer = { ...state.viewer, ...v };
  apply(); persist();
}

export function onGraphicsChange(f: () => void): void { state.listeners.push(f); }
