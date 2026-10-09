// Collision rules (E-22), in the app only: within a grid no brick may overlap another. Resizes stop
// at the last size that fits, placements onto a taken spot are refused, and a paste drops the bricks
// that would overlap. Uses only the startup brick, so it needs no private saves.

import { expect, test, type Page } from '@playwright/test';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): Box;
  brickBox(k: number): Box;
  snapshot(): { bricks: Box[]; sel: number; status: string; ghost: boolean };
  paste(items: unknown[]): void;
}
/** the test hook (not declared globally: parity.spec.ts declares its own shape) */
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const snap = (page: Page): Promise<ReturnType<Api['snapshot']>> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot());
const r3 = (v: number): number => +v.toFixed(3);

/** screen point on brick k's box (k = -1: the focused brick), by fractions of its size */
const onBrick = (page: Page, k: number, f: [number, number, number]): Promise<P2> => page.evaluate(([k, f]) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = k < 0 ? t.focusBox() : t.brickBox(k);
  const p = f.map((v, i) => lo[i] + (hi[i] - lo[i]) * v);
  return t.project(p[0], p[1], p[2]);
}, [k, f] as const);

async function click(page: Page, at: P2): Promise<void> {
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
}

/** startup brick A (index 0) plus a copy B two studs beyond its +X face; ends with A focused */
async function twoBricks(page: Page): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#btoggle').click();          // fold the side panels: the bricks stay clickable
  await page.locator('#ptoggle').click();
  await settle(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.keyboard.press('Control+v');
  const at = await page.evaluate(() => {          // ground 0.6 beyond A's +X face: B is centred there
    const { lo, hi } = (window as unknown as W).__brickTest.focusBox();
    return (window as unknown as W).__brickTest.project(hi[0] + 0.6, (lo[1] + hi[1]) / 2, lo[2]);
  });
  await click(page, at);
  await settle(page);
  expect((await snap(page)).bricks.length).toBe(2);
  // focus A again (click its top)
  await click(page, await onBrick(page, 0, [0.5, 0.5, 1]));
  await settle(page);
  const s = await snap(page), [a, b] = [s.bricks[0], s.bricks[1]];
  expect(s.sel).toBe(0);
  expect(r3(b.lo[0] - a.hi[0])).toBe(0.4);          // a two-stud gap along +X
  expect(r3(b.lo[2])).toBe(r3(a.lo[2]));
}

const gapX = async (page: Page): Promise<number> => { const s = await snap(page); return r3(s.bricks[1].lo[0] - s.bricks[0].hi[0]); };
const sizeX = async (page: Page): Promise<number> => { const s = await snap(page); return r3(s.bricks[0].hi[0] - s.bricks[0].lo[0]); };

test('a typed size stops at the neighbour; undo restores it', async ({ page }) => {
  await twoBricks(page);
  await page.locator('#menu .mrow input').first().click();
  await page.keyboard.type('9');
  await page.keyboard.press('Enter');
  await settle(page);
  expect(await sizeX(page)).toBe(0.8);              // 2 studs + the 2-stud gap, not 9
  expect(await gapX(page)).toBe(0);                 // touching is fine
  // a typed size that can't grow at all is refused
  await page.locator('#menu .mrow input').first().click();
  await page.keyboard.type('6');
  await page.keyboard.press('Enter');
  await settle(page);
  expect(await sizeX(page)).toBe(0.8);
  expect((await snap(page)).status).toMatch(/Can't resize: overlaps a brick/);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await sizeX(page)).toBe(0.4);
});

test('arrow keys in the size box stop at the neighbour', async ({ page }) => {
  await twoBricks(page);
  const inp = page.locator('#menu .mrow input').first();
  await inp.click();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await settle(page);
  expect(await sizeX(page)).toBe(0.8);
  expect(await gapX(page)).toBe(0);
});

test('a resize drag stops at the last size that fits', async ({ page }) => {
  await twoBricks(page);
  const from = await onBrick(page, -1, [1, 0.5, 0.5]), to = await onBrick(page, -1, [4, 0.5, 0.5]);
  await page.mouse.move(from[0], from[1]); await frames(page);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 20 });
  await frames(page);
  expect(await page.locator('#hud').innerHTML()).toMatch(/blocked: overlaps a brick/);
  await page.mouse.up();
  await settle(page);
  expect(await sizeX(page)).toBe(0.8);
  expect(await gapX(page)).toBe(0);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(await sizeX(page)).toBe(0.4);
});

test('placing onto a taken spot is refused', async ({ page }) => {
  await twoBricks(page);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await page.mouse.move(...(await onBrick(page, 0, [0.5, 0.5, 1]))); await frames(page);
  await page.keyboard.press('PageDown');            // one plate down: into A
  await frames(page);
  expect(await page.locator('#hud').innerHTML()).toMatch(/blocked: overlaps a brick/);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
  let s = await snap(page);
  expect(s.bricks.length).toBe(2);
  expect(s.status).toMatch(/Can't place .*: overlaps a brick/);
  await page.keyboard.press('PageUp');              // back on top: fine
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  s = await snap(page);
  expect(s.bricks.length).toBe(3);
});

test('a paste drops the bricks that would overlap, as one undo step', async ({ page }) => {
  await twoBricks(page);
  // two 2x2 bricks side by side along X
  await page.evaluate(() => {
    const b = (x: number): unknown => ({ lo: [x, 0, 0], hi: [x + 0.4, 0.4, 0.24], micro: false, color: [1, 0, 0], up: 1 });
    (window as unknown as W).__brickTest.paste([b(0), b(0.4)]);
  });
  // over A's top near its +X edge: the pair spans A and the gap; 3 plates down puts it level with A
  await page.mouse.move(...(await onBrick(page, 0, [0.95, 0.5, 1]))); await frames(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('PageDown');
  await frames(page);
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  let s = await snap(page);
  expect(s.status).toBe('Pasted 1 brick (1 skipped: overlapping)');
  expect(s.bricks.length).toBe(3);
  const [a, , c] = s.bricks;
  expect(r3(c.lo[0] - a.hi[0])).toBe(0);            // the kept one fills the gap next to A
  expect(r3(c.lo[2])).toBe(r3(a.lo[2]));
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z');
  await settle(page);
  s = await snap(page);
  expect(s.bricks.length).toBe(2);
  await page.keyboard.press('Control+y');
  await settle(page);
  expect((await snap(page)).bricks.length).toBe(3);
});

// --- E-05: R on the focused brick (rotate / reorient) follows the same rules
const box0 = async (page: Page): Promise<{ size: number[]; mid: number[] }> => {
  const b = (await snap(page)).bricks[0];
  return { size: b.hi.map((v, i) => r3(v - b.lo[i])), mid: b.hi.map((v, i) => r3((v + b.lo[i]) / 2)) };
};

test('R rotates the focused brick about its centre; undo restores it', async ({ page }) => {
  await twoBricks(page);
  await page.locator('#menu .mrow input').nth(1).click();   // A: 2 x 3 studs, still clear of B when turned
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await settle(page);
  const before = await box0(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('r');
  await settle(page);
  const after = await box0(page);
  expect(after.size).toEqual([before.size[1], before.size[0], before.size[2]]);
  expect(after.mid).toEqual(before.mid);
  expect((await snap(page)).status).toMatch(/Rotated/);
  await page.keyboard.press('Control+z');
  await settle(page);
  expect((await box0(page)).size).toEqual(before.size);
});

test('R is refused when the turned brick would overlap a brick', async ({ page }) => {
  await twoBricks(page);
  await click(page, await onBrick(page, 1, [0.5, 0.5, 1]));   // B: 12 studs long in Y (grows the same way as A will)
  await settle(page);
  await page.locator('#menu .mrow input').nth(1).click();
  await page.keyboard.type('12');
  await page.keyboard.press('Enter');
  await settle(page);
  await click(page, await onBrick(page, 0, [0.5, 0.5, 1]));
  await settle(page);
  expect((await snap(page)).sel).toBe(0);
  await page.locator('#menu .mrow input').nth(1).click();   // A: 2 x 8 studs: turned, it reaches into B
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  await settle(page);
  const before = await box0(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('r');
  await settle(page);
  expect((await box0(page)).size).toEqual(before.size);
  expect((await snap(page)).status).toMatch(/Can't rotate .*: overlaps a brick/);
  expect(await page.locator('#hud').innerHTML()).toMatch(/blocked: overlaps a brick/);
});

test('R held + drag points the top along a world axis, as one undo step', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await settle(page);
  const up0 = await page.evaluate(() => ((window as unknown as W).__brickTest.snapshot() as unknown as { bricks: { up: number }[] }).bricks[0].up);
  expect(up0).toBe(1);
  await page.mouse.move(640, 400); await frames(page);
  await page.keyboard.down('r');
  await page.mouse.move(760, 400, { steps: 8 }); await frames(page);
  await page.keyboard.up('r');
  await settle(page);
  const s = await page.evaluate(() => (window as unknown as W).__brickTest.snapshot() as unknown as { bricks: { up: number; side?: number }[]; status: string });
  expect(s.bricks[0].up).toBe(0);                   // on its side now
  expect(Math.abs(s.bricks[0].side ?? 0)).toBeGreaterThan(1);
  expect(s.status).toMatch(/Reoriented/);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z');
  await settle(page);
  const u = await page.evaluate(() => ((window as unknown as W).__brickTest.snapshot() as unknown as { bricks: { up: number }[] }).bricks[0].up);
  expect(u).toBe(1);
});
