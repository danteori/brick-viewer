import { ELEV, YAW0 } from '../app/state.ts';

export interface Angles { yaw: number; pitch: number }

const QUARTER = Math.PI / 2;

/** Nearest isometric corner to a yaw. */
export const snapYaw = (y: number): number => YAW0 + Math.round((y - YAW0) / QUARTER) * QUARTER;

/**
 * The isometric view a resize glides to: the iso corner nearest `from`, on the same side of the
 * horizon. The near face of every axis stays the near face, so the resize axis keeps its side.
 */
export const resizeIso = (from: Angles): Angles => ({ yaw: snapYaw(from.yaw), pitch: from.pitch < 0 ? -ELEV : ELEV });
