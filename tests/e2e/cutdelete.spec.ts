// Cut / Delete remove exactly the selected bricks, also after earlier deletes and placements left
// holes in the store's free list; undo / redo restore exactly them. Every other brick keeps its
// id, box and colour.

import { expect, test, type Page } from '@playwright/test';

type Row = [number, number[], number[], number[]];
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): [number, number];
  focusBox(): { lo: number[]; hi: number[] };
  paste(items: unknown[]): void;
  select(ids: number[]): void;
  byId(): Row[];
  snapshot(): { ghost: boolean; status: string };
  renderStats(): { instances: number };
}
type W = { __brickTest: Api };
test.describe.configure({ timeout: 180_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
/** the live bricks by id, after checking the renderer draws every one of them (the focus is drawn on its own) */
async function rows(page: Page): Promise<Row[]> {
  await frames(page, 2);
  const [r, st] = await page.evaluate(() => { const t = (window as unknown as W).__brickTest; return [t.byId(), t.renderStats()] as const; });
  expect(st.instances, 'every brick is drawn').toBe(r.length - 1);
  return r;
}
const byId = (r: Row[]): Map<number, string> => new Map(r.map(([id, lo, hi, c]) => [id, JSON.stringify([lo, hi, c])]));

/** a grid of n x n 1x1 bricks pasted on the ground beside the startup brick, colours varying */
async function pasteGrid(page: Page, n: number, dx: number, hue: number): Promise<void> {
  await page.evaluate(([n, hue]) => {
    const items = [];
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) items.push({ lo: [x * 0.2, y * 0.2, 0], hi: [x * 0.2 + 0.2, y * 0.2 + 0.2, 0.24], micro: false, up: 1, color: [((x * 37 + hue) % 255) / 255, ((y * 53) % 255) / 255, 0.5] });
    (window as unknown as W).__brickTest.paste(items);
  }, [n, hue] as const);
  const at = await page.evaluate((dx) => { const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox(); return t.project(hi[0] + dx, (lo[1] + hi[1]) / 2, lo[2]); }, dx);
  await page.mouse.move(at[0], at[1]); await frames(page, 4);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
}

function expectOnly(before: Row[], after: Row[], gone: number[]): void {
  const a = byId(before), b = byId(after), g = new Set(gone);
  for (const id of g) expect(b.has(id), `id ${id} should be gone`).toBe(false);
  for (const [id, v] of a) if (!g.has(id)) expect(b.get(id), `id ${id} untouched`).toBe(v);
  expect(b.size).toBe(a.size - g.size);
}

test('cut and delete remove only the selection, with holes in the free list; undo / redo exact', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#btoggle').click();
  await page.evaluate(() => (window as unknown as W).__brickTest.settle());
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await pasteGrid(page, 6, 0.6, 0);
  const r0 = await rows(page);
  expect(r0.length).toBe(37);
  // delete every fourth pasted brick: holes in the free list
  const del = r0.map((x) => x[0]).filter((_, i) => i > 0 && i % 4 === 1);
  await page.evaluate((ids) => (window as unknown as W).__brickTest.select(ids), del);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Delete'); await frames(page);
  let r1 = await rows(page);
  expectOnly(r0, r1, del);
  // a placement reuses some of the freed rows
  await page.keyboard.press('Escape');
  await pasteGrid(page, 2, 2.2, 90);
  const r2 = await rows(page);
  expect(r2.length).toBe(r1.length + 4);
  // cut a scattered selection: only those go
  const cut = r2.map((x) => x[0]).filter((_, i) => i > 0 && i % 3 === 0);
  await page.evaluate((ids) => (window as unknown as W).__brickTest.select(ids), cut);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+x'); await frames(page);
  const r3 = await rows(page);
  expectOnly(r2, r3, cut);
  // cut holds the bricks in a place ghost; Esc leaves them on the clipboard
  expect((await page.evaluate(() => (window as unknown as W).__brickTest.snapshot())).ghost).toBe(true);
  await page.keyboard.press('Escape'); await frames(page);
  expect(byId(await rows(page))).toEqual(byId(r3));
  // undo the cut: exactly the cut bricks come back; redo removes exactly them again
  await page.keyboard.press('Control+z'); await frames(page);
  expect(byId(await rows(page))).toEqual(byId(r2));
  await page.keyboard.press('Control+y'); await frames(page);
  expect(byId(await rows(page))).toEqual(byId(r3));
  // undo cut, undo placement, undo delete: back to the start
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); await frames(page);
  expect(byId(await rows(page))).toEqual(byId(r0));
  await page.keyboard.press('Control+y'); await frames(page);
  r1 = await rows(page);
  expectOnly(r0, r1, del);
});
