import type { SceneStore } from './store.ts';

const CELL = 200;
const SPAN = 65536;
const STRIDE = 2 * SPAN;
const FAR_RATIO = 4;
const FAR_MARGIN = 10000;

export interface MainBuild { focus: number; lo: number[]; hi: number[] }

const cellOf = (v: number): number => Math.max(-SPAN, Math.min(SPAN - 1, Math.floor(v / CELL)));
const keyOf = (x: number, y: number, z: number): number => ((x + SPAN) * STRIDE + (y + SPAN)) * STRIDE + (z + SPAN);

function cellCounts(store: SceneStore): { cells: Map<number, number>; cellOfId: Float64Array } {
  const cells = new Map<number, number>(), cellOfId = new Float64Array(store.n).fill(-1);
  for (const id of store.ids()) {
    const k = keyOf(cellOf(store.px[id]!), cellOf(store.py[id]!), cellOf(store.pz[id]!));
    cells.set(k, (cells.get(k) ?? 0) + 1);
    cellOfId[id] = k;
  }
  return { cells, cellOfId };
}

function unpack(k: number): [number, number, number] {
  const z = k % STRIDE, xy = (k - z) / STRIDE, y = xy % STRIDE, x = (xy - y) / STRIDE;
  return [x - SPAN, y - SPAN, z - SPAN];
}

function largestCluster(cells: Map<number, number>): Set<number> {
  const seen = new Set<number>();
  let best = new Set<number>(), bestCount = -1;
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    const group = new Set<number>([start]), queue = [start];
    seen.add(start);
    let count = 0;
    while (queue.length) {
      const k = queue.pop()!;
      count += cells.get(k)!;
      const [x, y, z] = unpack(k);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const n = keyOf(x + dx, y + dy, z + dz);
        if (!seen.has(n) && cells.has(n)) { seen.add(n); group.add(n); queue.push(n); }
      }
    }
    if (count > bestCount) { best = group; bestCount = count; }
  }
  return best;
}

function wholeBox(store: SceneStore): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], bx = new Array<number>(6);
  for (const id of store.ids()) {
    store.box(id, bx);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, bx[i]!); hi[i] = Math.max(hi[i]!, bx[i + 3]!); }
  }
  return { lo, hi };
}

const span = (b: { lo: number[]; hi: number[] }): number => Math.max(...[0, 1, 2].map((i) => b.hi[i]! - b.lo[i]!));

/** The biggest connected cluster of bricks (by brick centres) and its focus: the first brick if it is in the cluster, else the brick nearest the middle. */
export function mainBuild(store: SceneStore): MainBuild | null {
  const { cells, cellOfId } = cellCounts(store);
  if (!cells.size) return null;
  const keep = largestCluster(cells);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], bx = new Array<number>(6);
  const members: number[] = [];
  for (let id = 0; id < cellOfId.length; id++) {
    const k = cellOfId[id]!;
    if (k < 0 || !keep.has(k)) continue;
    members.push(id);
    store.box(id, bx);
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, bx[i]!); hi[i] = Math.max(hi[i]!, bx[i + 3]!); }
  }
  const first = store.first();
  if (keep.has(cellOfId[first]!)) return { focus: first, lo, hi };
  const mid = [0, 1, 2].map((i) => (lo[i]! + hi[i]!) / 2);
  let focus = members[0]!, bestD = Infinity;
  for (const id of members) {
    const d = (store.px[id]! - mid[0]!) ** 2 + (store.py[id]! - mid[1]!) ** 2 + (store.pz[id]! - mid[2]!) ** 2;
    if (d < bestD) { bestD = d; focus = id; }
  }
  return { focus, lo, hi };
}

/** What the load view frames: the whole save, or only the main build when distant bricks would make the whole save far bigger than it. */
export function loadFraming(store: SceneStore): MainBuild | null {
  if (!store.count) return null;
  const whole = wholeBox(store), wholeSpan = span(whole);
  const main = mainBuild(store)!, mainSpan = span(main);
  if (wholeSpan <= Math.max(FAR_RATIO * mainSpan, mainSpan + FAR_MARGIN)) return { focus: store.first(), ...whole };
  return main;
}
