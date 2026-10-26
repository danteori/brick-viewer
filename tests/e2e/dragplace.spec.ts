import { expect, test, type Page } from '@playwright/test';
import { inMenu } from './windows.ts';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): Box;
  snapshot(): { bricks: Box[]; sel: number; status: string; ghost: boolean };
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const snap = (page: Page): Promise<ReturnType<Api['snapshot']>> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot());
const r3 = (v: number): number => +v.toFixed(3);

/** a ground point beside the startup brick: dx past its +X face, dy from its middle in Y */
const ground = (page: Page, dx: number, dy = 0): Promise<P2> => page.evaluate(([dx, dy]) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
  return t.project(hi[0] + dx, (lo[1] + hi[1]) / 2 + dy, lo[2]);
}, [dx, dy] as const);

async function glide(page: Page, a: P2, b: P2): Promise<void> {
  for (let i = 1; i <= 6; i++) { await page.mouse.move(a[0] + (b[0] - a[0]) * i / 6, a[1] + (b[1] - a[1]) * i / 6); await frames(page, 1); }
  await frames(page);
}

async function pasteGhost(page: Page): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await settle(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await inMenu(page, () => page.locator('#pastemode button[data-paste="brick"]').click());
  await page.keyboard.press('Control+v');
}

/** Drags on the ground through the given points; a right-click at each inner point finishes that axis. */
async function dragOnGround(page: Page, ...pts: [number, number][]): Promise<void> {
  const at = await Promise.all(pts.map(([dx, dy]) => ground(page, dx, dy)));
  await page.mouse.move(...at[0]!); await frames(page);
  await page.mouse.down(); await frames(page);
  for (let j = 1; j < at.length; j++) {
    if (j > 1) { await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await frames(page); }
    await glide(page, at[j - 1]!, at[j]!);
  }
  await page.mouse.up(); await settle(page);
}

const size = (b: Box, i: number): number => r3(b.hi[i]! - b.lo[i]!);

test('drag resize snaps to one axis; a right-click finishes it and the drag goes on along another; the brick stays in hand', async ({ page }) => {
  await pasteGhost(page);
  expect(await page.locator('#hud').innerHTML()).toMatch(/Drag: resize/);
  const n0 = (await snap(page)).bricks.length, a = (await snap(page)).bricks[0]!;

  await dragOnGround(page, [0.6, 0], [2.2, 0.15]);
  let s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 1);
  let made = s.bricks[n0]!;
  expect(size(made, 0)).toBeGreaterThan(size(a, 0));
  expect(size(made, 1)).toBe(size(a, 1));
  expect(size(made, 2)).toBe(size(a, 2));
  expect(s.ghost).toBe(true);

  await dragOnGround(page, [0.6, 1.6], [2.2, 1.6], [2.2, 2.8]);
  s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 2);
  made = s.bricks[n0 + 1]!;
  expect(size(made, 0)).toBeGreaterThan(size(a, 0));
  expect(size(made, 1)).toBeGreaterThan(size(a, 1));
  expect(s.ghost).toBe(true);

  await page.keyboard.press('Escape'); await settle(page);
  expect((await snap(page)).ghost).toBe(false);
});

test('drag repeat tiles copies along each axis in turn, as one undo step', async ({ page }) => {
  await pasteGhost(page);
  await page.keyboard.press('j');
  expect(await page.locator('#hud').innerHTML()).toMatch(/Drag: repeat/);
  const n0 = (await snap(page)).bricks.length, a = (await snap(page)).bricks[0]!;
  await dragOnGround(page, [0.6, 0], [1.8, 0], [1.8, 1.2]);
  const s = await snap(page);
  expect(s.status).toMatch(/^Placed \d+ bricks/);
  const added = s.bricks.slice(n0);
  expect(added.length).toBeGreaterThan(3);
  expect(new Set(added.map((b) => r3(b.lo[1]))).size).toBeGreaterThan(1);
  for (const b of added) expect(size(b, 0)).toBe(size(a, 0));
  expect(s.ghost).toBe(true);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await settle(page);
  expect((await snap(page)).bricks.length).toBe(n0);
});

test('a plain click places one brick and keeps it in hand; a right-click puts it away, a right drag does not', async ({ page }) => {
  await pasteGhost(page);
  const n0 = (await snap(page)).bricks.length;
  for (const dx of [0.6, 2]) {
    await page.mouse.move(...(await ground(page, dx))); await frames(page);
    await page.mouse.down(); await page.mouse.up(); await settle(page);
  }
  let s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 2);
  expect(s.ghost).toBe(true);

  const p = await ground(page, 3);
  await page.mouse.move(...p); await page.mouse.down({ button: 'right' });
  await page.mouse.move(p[0] + 30, p[1]); await page.mouse.up({ button: 'right' }); await settle(page);
  expect((await snap(page)).ghost).toBe(true);

  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await settle(page);
  s = await snap(page);
  expect(s.ghost).toBe(false);
  expect(s.bricks.length).toBe(n0 + 2);
});
