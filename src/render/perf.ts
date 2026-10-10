// Frame profiling (off by default): CPU time per render section and, where the browser has
// EXT_disjoint_timer_query_webgl2, GPU time per section. Sections run back to back:
// perfMark('opaque') closes the previous one and opens the next; perfEnd() closes the last.
// Read by the test hook (renderStats) and the bench script; costs nothing while perf.on is false.

import { G } from './draw.ts';

interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export const perf = {
  on: false,
  /** last frame's CPU ms per section */
  cpu: {} as Record<string, number>,
  /** GPU ms per section, from the most recent frame whose queries have come back */
  gpu: {} as Record<string, number>,
};

let ext: TimerExt | null | undefined;
let open = '', t0 = 0, q: WebGLQuery | null = null;
let frame: { name: string; q: WebGLQuery }[] = [];
const waiting: { name: string; q: WebGLQuery }[][] = [];

function close(): void {
  if (!open) return;
  perf.cpu[open] = (perf.cpu[open] ?? 0) + performance.now() - t0;
  if (q && ext) { G.gl.endQuery(ext.TIME_ELAPSED_EXT); frame.push({ name: open, q }); q = null; }
  open = '';
}

/** Starts section `name` (closing the one before). */
export function perfMark(name: string): void {
  if (!perf.on) return;
  close();
  const gl = G.gl;
  if (ext === undefined) ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  open = name; t0 = performance.now();
  if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
}

/** Starts a frame: clears the CPU times and collects GPU results that have come back. */
export function perfBegin(): void {
  if (!perf.on) return;
  perf.cpu = {};
  perfCollect();
}

/** Collects the GPU results that have come back; true when none are still outstanding. */
export function perfCollect(): boolean {
  const gl = G.gl;
  while (waiting.length && ext) {
    const f = waiting[0]!;
    if (!gl.getQueryParameter(f[f.length - 1]!.q, gl.QUERY_RESULT_AVAILABLE)) break;
    waiting.shift();
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
    const out: Record<string, number> = {};
    for (const s of f) {
      if (!disjoint) out[s.name] = (out[s.name] ?? 0) + (gl.getQueryParameter(s.q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(s.q);
    }
    if (!disjoint) perf.gpu = out;
  }
  return !waiting.length;
}

/** Ends the frame's last section. */
export function perfEnd(): void {
  if (!perf.on) return;
  close();
  if (frame.length) { waiting.push(frame); frame = []; }
  while (waiting.length > 8) for (const s of waiting.shift()!) G.gl.deleteQuery(s.q);
}
