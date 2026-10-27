// The game's ModelExportSupport maps as one texture array, behind the ?maps flag (task R-20).
// The PNGs are not part of this repo: they load from a base URL on the same origin or a server that
// allows CORS. Layer order must match MAP_* in render/shaders/brick.ts.

import { MAPS_UNIT, mapsState } from './gl.ts';

const FILES = ['T_Stud_N', 'T_Bevel_N', 'T_Bumpy_N', 'T_InletBorder_N', 'T_InletBorder_AO', 'T_InletCenter_N', 'T_InletCenter_AO'] as const;
const SIZE = 1024;

export interface MapsInfo { layers: number; bytes: number; loadMs: number }

/** Loads the maps from base, binds them on MAPS_UNIT and switches the look on (mode 1 or 2). */
export async function loadGameMaps(gl: WebGL2RenderingContext, base: string, mode: 1 | 2): Promise<MapsInfo> {
  const t0 = performance.now();
  const bitmaps = await Promise.all(FILES.map(async (name) => {
    const res = await fetch(`${base.replace(/\/?$/, '/')}${name}.png`);
    if (!res.ok) throw new Error(`game map ${name}: HTTP ${res.status}`);
    return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  }));
  const levels = Math.floor(Math.log2(SIZE)) + 1;
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + MAPS_UNIT);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, gl.RGBA8, SIZE, SIZE, FILES.length);
  bitmaps.forEach((b, i) => { gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, SIZE, SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); b.close(); });
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D_ARRAY, ext.TEXTURE_MAX_ANISOTROPY_EXT, 4);
  gl.activeTexture(gl.TEXTURE0);
  mapsState.mode = mode;
  return { layers: FILES.length, bytes: Math.round(SIZE * SIZE * 4 * FILES.length * (4 / 3)), loadMs: Math.round(performance.now() - t0) };
}
