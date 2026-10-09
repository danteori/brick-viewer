// Ground plate: the base plate a Plate world is built on, from the environment's `groundPlate`
// group. This module turns the saved settings into renderer-ready values and defines the hook a
// renderer implements. DOM-free.
//
// ---------------------------------------------------------------------------------------------
// RENDERER HOOK SPEC (GroundPlateHook)
//
// The app calls `hook.setGroundPlate(look)` whenever the environment changes, and passes null
// when there is no ground plate (Space and Studio worlds, or a preset without the group). The
// renderer owns everything else. Expected behaviour:
//
// 1. Visibility. `look.visible === false` -> draw nothing (bricks float, as in-game). Clicking
//    and placement against the plate may still use the z = 0 plane; that's the app's choice.
// 2. Geometry. A horizontal plane at world z = 0 (the top of the plate; bricks rest on it), in
//    the renderer's own up axis. In-game the plate is effectively endless: draw it out to the far
//    plane, or a large quad centred under the camera, fading into the fog / background colour
//    at the horizon. It never casts shadows and has no underside.
// 3. Colour. `look.color` is the albedo, already converted for the viewer's colour pipeline: it
//    is LINEAR (the .bp value as stored) and goes through the same lighting and tonemap as a
//    brick's albedo, so a brick painted `look.srgbBytes` matches the plate. `look.hex` is the
//    sRGB display value (UI swatches only).
// 4. Variance. When `look.variance > 0`, the plate is split into square cells of
//    `look.cellStuds` studs (varianceBrickSize, minimum 1 stud) and each cell's albedo is
//    mix(color, accent, variance * hash(cell)), with hash(cell) a stable value in [0, 1) per cell
//    index (use `cellMix` below so every renderer agrees). Variance 0 -> one flat colour.
//    (How the game itself distributes the accent is not measured; this is the working model.)
// 5. Stud texture. `look.studTexture` -> draw the stud pattern: one stud per 1 x 1 stud cell
//    (10 x 10 world units), the same stud as a brick top, as a texture / normal-map / procedural
//    shader rather than geometry. False -> a smooth plate.
// 6. Lighting. The plate is lit like an up-facing brick top (N = up) with the scene's lighting,
//    so it gets the same sun / sky / floor terms (see environmentToLighting).
//
// Cheap fallback for a renderer that only has a clear colour or one flat quad: use `look.color`
// lit as a top face, ignore variance, and skip the studs.
// ---------------------------------------------------------------------------------------------

import type { Environment, GroundPlateGroup, LinearColor } from '../format/environment.ts';
import { linearToHex, linearToSrgb } from '../format/environment.ts';

export interface GroundPlateLook {
  visible: boolean;
  /** Albedo, linear RGB (as stored in the .bp). */
  color: [number, number, number];
  /** Accent albedo, linear RGB. */
  accent: [number, number, number];
  /** 0..1: how far cells may move from `color` toward `accent`. */
  variance: number;
  /** Variance cell size in studs (>= 1). */
  cellStuds: number;
  /** Draw the stud pattern. */
  studTexture: boolean;
  /** Display colours (sRGB) for swatches. */
  hex: string;
  accentHex: string;
  /** The colour as sRGB bytes, i.e. the paint colour of a brick that matches the plate. */
  srgbBytes: [number, number, number];
}

/** What a renderer implements to show the ground plate. */
export interface GroundPlateHook {
  /** null = no plate (Space / Studio worlds, or no groundPlate group). */
  setGroundPlate(look: GroundPlateLook | null): void;
}

const lin = (c: LinearColor): [number, number, number] => [c.r, c.g, c.b];

export function groundPlateLook(g: GroundPlateGroup): GroundPlateLook {
  return {
    visible: g.isVisible,
    color: lin(g.groundColor),
    accent: lin(g.groundAccentColor),
    variance: Math.min(1, Math.max(0, g.variance)),
    cellStuds: Math.max(1, g.varianceBrickSize),
    studTexture: g.bUseStudTexture,
    hex: linearToHex(g.groundColor),
    accentHex: linearToHex(g.groundAccentColor),
    srgbBytes: lin(g.groundColor).map((v) => Math.round(255 * linearToSrgb(v))) as [number, number, number],
  };
}

/** The ground plate of an environment, or null when it has none (e.g. a Space world). */
export function environmentGroundPlate(env: Environment): GroundPlateLook | null {
  return env.groups.groundPlate ? groundPlateLook(env.groups.groundPlate) : null;
}

/** Stable per-cell value in [0, 1) for variance (integer cell coordinates). */
export function cellHash(cx: number, cy: number): number {
  let h = (Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cy | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The albedo (linear) of the variance cell containing stud coordinate (sx, sy). */
export function cellMix(look: GroundPlateLook, sx: number, sy: number): [number, number, number] {
  if (look.variance <= 0) return look.color;
  const t = look.variance * cellHash(Math.floor(sx / look.cellStuds), Math.floor(sy / look.cellStuds));
  return look.color.map((v, i) => v + (look.accent[i]! - v) * t) as [number, number, number];
}
