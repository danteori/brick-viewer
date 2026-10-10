// Multi-select (E-01) and operations on a selection (E-02), in the app only. Uses only the startup
// brick and copies of it, so it needs no private saves.

import { expect, test, type Page } from '@playwright/test';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): Box;
  brickBox(k: number): Box;
  selection(): number[];
  snapshot(): { bricks: (Box & { color: number[] })[]; sel: number; status: string; ghost: boolean };
  blocks(): { n: number; reason: string; age: number };
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const blockCount = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__brickTest.blocks().n);
/** a refused edit was noted since n0. The HUD shows the note for only 1.5 s (slow software GL can
 *  outlast that), so the HUD text is checked only while the note is still fresh. */
async function expectBlocked(page: Page, n0: number): Promise<void> {
  const b = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(r));
    return { ...(window as unknown as W).__brickTest.blocks(), hud: document.getElementById('hud')!.innerHTML };
  });
  expect(b.n).toBeGreaterThan(n0);
  expect(b.reason).toBe('overlaps a brick');
  if (b.age < 1000) expect(b.hud).toMatch(/blocked: overlaps a brick/);
}
const snap = (page: Page): Promise<ReturnType<Api['snapshot']>> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot());
const selection = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as W).__brickTest.selection());
const r3 = (v: number): number => +v.toFixed(3);

/** screen point on brick k's box (k = -1: the focused brick), by fractions of its size */
const onBrick = (page: Page, k: number, f: [number, number, number]): Promise<P2> => page.evaluate(([k, f]) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = k < 0 ? t.focusBox() : t.brickBox(k);
  const p = f.map((v, i) => lo[i] + (hi[i] - lo[i]) * v);
  return t.project(p[0], p[1], p[2]);
}, [k, f] as const);
/** screen point of the ground (brick 0's bottom) at dx, dy viewer units from brick 0's centre */
const ground = (page: Page, dx: number, dy: number): Promise<P2> => page.evaluate(([dx, dy]) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(0);
  return t.project((lo[0] + hi[0]) / 2 + dx, (lo[1] + hi[1]) / 2 + dy, lo[2]);
}, [dx, dy] as const);

async function click(page: Page, at: P2, mod?: string): Promise<void> {
  await page.mouse.move(at[0], at[1]); await frames(page);
  if (mod) await page.keyboard.down(mod);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
  if (mod) await page.keyboard.up(mod);
}

/** startup brick A (0) plus a copy B two studs beyond its +X face; A focused */
async function twoBricks(page: Page): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#btoggle').click();
  await settle(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.keyboard.press('Control+v');
  const at = await page.evaluate(() => {
    const { lo, hi } = (window as unknown as W).__brickTest.focusBox();
    return (window as unknown as W).__brickTest.project(hi[0] + 0.6, (lo[1] + hi[1]) / 2, lo[2]);
  });
  await click(page, at);
  await settle(page);
  await click(page, await onBrick(page, 0, [0.5, 0.5, 1]));
  await settle(page);
  const s = await snap(page);
  expect(s.bricks.length).toBe(2);
  expect(s.sel).toBe(0);
}

test('Shift+click, Ctrl+A, Esc, box select and select by colour', async ({ page }) => {
  await twoBricks(page);
  await click(page, await onBrick(page, 1, [0.5, 0.5, 1]), 'Shift');
  expect(await selection(page)).toEqual([0, 1]);          // the focused brick joins the first time
  expect((await snap(page)).sel).toBe(0);                 // Shift+click doesn't move the focus
  expect(await page.locator('#hud').innerHTML()).toMatch(/2 bricks selected/);
  expect(await page.locator('#selcount').textContent()).toBe('2 selected');
  await click(page, await onBrick(page, 0, [0.5, 0.5, 1]), 'Shift');
  expect(await selection(page)).toEqual([0, 1]);          // Shift+click never drops the focused brick
  await click(page, await onBrick(page, 1, [0.5, 0.5, 1]), 'Shift');
  expect(await selection(page)).toEqual([0]);             // a second Shift+click takes another brick out
  await page.mouse.move(640, 790);
  await page.keyboard.press('Escape');
  expect(await selection(page)).toEqual([]);
  await page.keyboard.press('Control+a');
  expect(await selection(page)).toEqual([0, 1]);
  await page.keyboard.press('Escape');
  // a box round both
  const a = await onBrick(page, 0, [0.5, 0.5, 0.5]), b = await onBrick(page, 1, [0.5, 0.5, 0.5]);
  const x0 = Math.min(a[0], b[0]) - 60, x1 = Math.max(a[0], b[0]) + 60, y0 = Math.min(a[1], b[1]) - 60, y1 = Math.max(a[1], b[1]) + 60;
  await page.mouse.move(x0, y0); await page.keyboard.down('Shift'); await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Shift'); await frames(page);
  expect(await selection(page)).toEqual([0, 1]);
  // Ctrl+Shift box round B removes it
  await page.mouse.move(b[0] - 25, b[1] - 25); await page.keyboard.down('Control'); await page.keyboard.down('Shift'); await page.mouse.down();
  await page.mouse.move(b[0] + 25, b[1] + 25, { steps: 6 }); await page.mouse.up(); await page.keyboard.up('Shift'); await page.keyboard.up('Control'); await frames(page);
  expect(await selection(page)).toEqual([0]);
  // same colour: the copy has the startup brick's colour
  await page.locator('#selbody button[data-sel="colour"]').click();
  expect(await selection(page)).toEqual([0, 1]);
  // connected: the two-stud gap keeps B out
  await page.locator('#selbody button[data-sel="clear"]').click();
  await page.locator('#selbody button[data-sel="connected"]').click();
  expect(await selection(page)).toEqual([0]);
});

test('delete, copy and paste a selection, each one undo step', async ({ page }) => {
  await twoBricks(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  expect((await snap(page)).status).toMatch(/Copied 2 bricks/);
  await page.keyboard.press('Control+v');
  await click(page, await ground(page, 0, -1.2));
  await settle(page);
  let s = await snap(page);
  expect(s.bricks.length).toBe(4);
  expect(s.status).toMatch(/Pasted 2 bricks/);
  expect(await selection(page)).toEqual([2, 3]);           // the pasted pair stays selected
  await page.mouse.move(640, 790);
  await page.keyboard.press('Delete');
  await settle(page);
  expect((await snap(page)).bricks.length).toBe(2);
  expect(await selection(page)).toEqual([]);
  await page.keyboard.press('Control+z');                 // the delete comes back, selected again
  await settle(page);
  expect((await snap(page)).bricks.length).toBe(4);
  expect(await selection(page)).toEqual([2, 3]);
  await page.keyboard.press('Control+z');                 // the paste goes
  await settle(page);
  s = await snap(page);
  expect(s.bricks.length).toBe(2);
});

test('cut and paste, and painting the selection', async ({ page }) => {
  await twoBricks(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+x');
  await settle(page);
  expect((await snap(page)).bricks.length).toBe(0);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect((await snap(page)).bricks.length).toBe(2);
  await page.keyboard.press('Control+a');
  await page.locator('#painttoggle').click();
  const before = (await snap(page)).bricks.map((b) => b.color.join());
  await page.locator('#paintbody .bvp-sw').nth(3).click();
  await page.locator('#paintbody button', { hasText: 'Paint selection' }).click();
  await settle(page);
  const after = (await snap(page)).bricks.map((b) => b.color.join());
  expect(after[0]).toBe(after[1]);
  expect(after[0]).not.toBe(before[0]);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z');                 // one step paints both back
  await settle(page);
  expect((await snap(page)).bricks.map((b) => b.color.join())).toEqual(before);
});

test('Paint tool: a stroke over both bricks paints each once as one undo step; Ctrl+click takes a paint', async ({ page }) => {
  await twoBricks(page);
  await page.locator('#painttoggle').click();
  await page.locator('#paintbody .bvp-sw').nth(5).click();
  const before = (await snap(page)).bricks.map((b) => b.color.join());
  await page.mouse.move(640, 790);
  await page.keyboard.press('3');
  const a = await onBrick(page, 0, [0.5, 0.5, 1]), b = await onBrick(page, 1, [0.5, 0.5, 1]);
  await page.mouse.move(a[0], a[1]); await frames(page);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 2 });            // a fast stroke: picked along the way
  await page.mouse.up(); await settle(page);
  const after = (await snap(page)).bricks.map((b) => b.color.join());
  expect(after[0]).toBe(after[1]);
  expect(after[0]).not.toBe(before[0]);
  expect((await snap(page)).status).toMatch(/Painted 2 bricks/);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect((await snap(page)).bricks.map((b) => b.color.join())).toEqual(before);
  // Ctrl+click: the eyedropper takes brick 0's paint (the startup red)
  await click(page, await onBrick(page, 0, [0.5, 0.5, 1]), 'Control');
  await expect(page.locator('#paintbody .bvp-hex')).toHaveText(/#fa4040/i);
  await page.keyboard.press('1');
});

/** screen point of brick k's box (its list index) at fractions f */
const at = (page: Page, k: number, f: [number, number, number]): Promise<P2> => onBrick(page, k, f);
/** a drag with the left button from a to b */
async function drag(page: Page, a: P2, b: P2): Promise<void> {
  await page.mouse.move(a[0], a[1]); await frames(page);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 14 }); await frames(page);
}

test('Move tool: the Resize drag moves the brick; it stops at a brick; one undo step', async ({ page }) => {
  await twoBricks(page);
  const start = (await snap(page)).bricks.map((b) => [b.lo.slice(), b.hi.slice()]);
  await page.mouse.move(640, 790);
  await page.keyboard.press('2');
  await expect(page.locator('#tool button[data-tool="move"]')).toHaveAttribute('aria-pressed', 'true');
  // grab A's +X face and pull far along +X: A slides 2 studs and stops against B
  const n0 = await blockCount(page);
  await drag(page, await at(page, -1, [1, 0.5, 0.5]), await at(page, -1, [5, 0.5, 0.5]));
  await expectBlocked(page, n0);
  await page.mouse.up(); await settle(page);
  let s = await snap(page);
  expect(r3(s.bricks[0].lo[0] - start[0][0][0])).toBe(0.4);
  expect(r3(s.bricks[0].hi[0] - s.bricks[0].lo[0])).toBe(r3(start[0][1][0] - start[0][0][0]));   // same size
  expect(s.bricks[0].lo[1]).toBe(start[0][0][1]);
  expect(s.bricks[1].lo).toEqual(start[1][0]);                       // B untouched
  expect(s.status).toMatch(/Move stopped: overlaps a brick/);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await settle(page);
  s = await snap(page);
  expect(s.bricks.map((b) => [b.lo, b.hi])).toEqual(start);
  await page.keyboard.press('1');
});

test('Move tool: right-click commits one axis and the drag goes on along another, one undo step', async ({ page }) => {
  await twoBricks(page);
  const start = (await snap(page)).bricks.map((b) => [b.lo.slice(), b.hi.slice()]);
  await page.mouse.move(640, 790);
  await page.keyboard.press('2');
  // -X first (away from B), then right-click, then along Y from the same press
  const x0 = await at(page, -1, [1, 0.5, 0.5]), x1 = await at(page, -1, [0, 0.5, 0.5]);
  await drag(page, x0, x1);
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await frames(page);
  const y1 = await page.evaluate(([p]) => {
    const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
    const a = t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2), b = t.project((lo[0] + hi[0]) / 2, hi[1] + 0.6, (lo[2] + hi[2]) / 2);
    return [p![0] + b[0] - a[0], p![1] + b[1] - a[1]];
  }, [x1] as const) as P2;
  await page.mouse.move(y1[0], y1[1], { steps: 14 }); await frames(page);
  await page.mouse.up(); await settle(page);
  const s = await snap(page);
  expect(r3(s.bricks[0].lo[0] - start[0][0][0])).toBeLessThan(0);   // moved along -X
  expect(r3(s.bricks[0].lo[1] - start[0][0][1])).toBeGreaterThan(0); // and along +Y
  expect(s.bricks[0].lo[2]).toBe(start[0][0][2]);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await settle(page);
  expect((await snap(page)).bricks.map((b) => [b.lo, b.hi])).toEqual(start);   // both axes in one step
  await page.keyboard.press('1');
});

test('Selector: Brick adds one brick per Shift+click; Box selects what is fully inside a growing box', async ({ page }) => {
  await twoBricks(page);
  // Brick mode: exactly the two
  await click(page, await at(page, 1, [0.5, 0.5, 1]), 'Shift');
  expect(await selection(page)).toEqual([0, 1]);
  await page.mouse.move(640, 790); await page.keyboard.press('Escape');
  // a group: M (1x1), Mid (1x1) between M and B2 (2x2), P (1x2) half outside in Y, Out (1x1) beyond
  await page.evaluate(() => {
    const it = (lo: number[], hi: number[], c: number[]) => ({ lo, hi, micro: false, up: 1, color: c });
    (window as unknown as W & { __brickTest: { paste(i: unknown[]): void } }).__brickTest.paste([
      it([0, 0, 0], [0.2, 0.2, 0.24], [0, 0, 1]), it([0.3, 0.1, 0], [0.5, 0.3, 0.24], [0, 1, 0]), it([0.6, 0, 0], [1.0, 0.4, 0.24], [1, 1, 0]),
      it([0.2, 0.3, 0], [0.4, 0.7, 0.24], [1, 0, 1]), it([1.2, 0, 0], [1.4, 0.2, 0.24], [0, 1, 1]),
    ]);
  });
  const g = await ground(page, -0.4, -1.4);
  await page.mouse.move(g[0], g[1]); await frames(page, 4);
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  expect((await snap(page)).bricks.length, (await snap(page)).status).toBe(7);
  await page.mouse.move(640, 790); await page.keyboard.press('Escape');
  // list indices 2..6 = M, Mid, B2, P, Out; focus M, Box mode, Shift+click B2
  await click(page, await at(page, 2, [0.5, 0.5, 1]));
  await settle(page);
  expect((await snap(page)).sel).toBe(2);
  await page.locator('#selbody button[data-selector="box"]').click();
  await click(page, await at(page, 4, [0.5, 0.5, 1]), 'Shift');
  expect(await selection(page)).toEqual([2, 3, 4]);       // M, Mid between, B2; not P (partly out) nor Out
  // the box grows: Shift+click P takes P in (and keeps the rest); Out still outside
  await click(page, await at(page, 5, [0.5, 0.5, 1]), 'Shift');
  expect(await selection(page)).toEqual([2, 3, 4, 5]);
  // selecting changed no brick
  expect((await snap(page)).bricks.length).toBe(7);
  await page.locator('#selbody button[data-selector="brick"]').click();
});

test('middle-click a brick places a copy (Ctrl+V repeats it); a middle drag still orbits', async ({ page }) => {
  await twoBricks(page);
  const b = await at(page, 1, [0.5, 0.5, 1]);
  await page.mouse.move(b[0], b[1]); await frames(page);
  await page.mouse.down({ button: 'middle' }); await page.mouse.up({ button: 'middle' }); await frames(page);
  let s = await snap(page);
  expect(s.ghost).toBe(true);
  expect(s.status).toMatch(/Copied .*click to place/);
  await click(page, await ground(page, 0, -1.2)); await settle(page);
  s = await snap(page);
  expect(s.bricks.length).toBe(3);
  expect(s.bricks[2].hi[0] - s.bricks[2].lo[0]).toBeCloseTo(s.bricks[1].hi[0] - s.bricks[1].lo[0]);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+v');
  expect((await snap(page)).ghost).toBe(true);
  await page.keyboard.press('Escape');
  // a middle drag orbits and copies nothing
  const yaw0 = await page.locator('#hud').innerHTML();
  await page.mouse.move(b[0], b[1]); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(b[0] + 120, b[1], { steps: 8 }); await page.mouse.up({ button: 'middle' }); await frames(page);
  expect((await snap(page)).ghost).toBe(false);
  expect(await page.locator('#hud').innerHTML()).not.toBe(yaw0);
  expect((await snap(page)).bricks.length).toBe(3);
});
