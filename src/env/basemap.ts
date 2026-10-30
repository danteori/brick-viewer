// Base map (backlog W-12): `Meta/World.json` names the map a world is built on. Plate worlds have
// a ground plate; Space worlds have none (bricks float in the universe). Studio and Peaks have
// ground the viewer does not draw yet, so they get a neutral stand-in plate. DOM-free.

import type { Environment, WorldKind } from '../format/environment.ts';
import { defaultEnvironment } from '../format/environment.ts';
import { groundPlateLook, type GroundPlateLook } from './ground-plate.ts';
import { debugFlag } from '../app/debugflags.ts';

const studStandIn = debugFlag('basemap-studs', 'Studio and Peaks stand-in plate has studs');

/** The neutral stand-in: a smooth mid-grey plate (linear). */
const NEUTRAL: [number, number, number] = [0.2, 0.2, 0.2];

export function standInPlate(): GroundPlateLook {
  return {
    visible: true, color: NEUTRAL, accent: NEUTRAL, variance: 0, cellStuds: 1, studTexture: studStandIn.on,
    hex: '#7c7c7c', accentHex: '#7c7c7c', srgbBytes: [124, 124, 124],
  };
}

/**
 * The ground plate for a world of base map `kind` with environment `env` (either may be missing).
 * Space: none. Plate: the environment's own plate, else the default Plate plate. Any other map:
 * the neutral stand-in. No kind: the environment's plate, if any (as a world without World.json).
 */
export function baseMapGround(kind: WorldKind | null, env: Environment | null): GroundPlateLook | null {
  if (kind === 'Space') return null;
  if (kind === 'Plate') {
    const g = env?.groups.groundPlate ?? defaultEnvironment('Plate').groups.groundPlate;
    return g ? groundPlateLook(g) : null;
  }
  if (kind) return standInPlate();
  return env?.groups.groundPlate ? groundPlateLook(env.groups.groundPlate) : null;
}
