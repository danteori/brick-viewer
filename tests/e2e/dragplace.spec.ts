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

/** a ground point beside the startup brick: dx past its +X face, through its middle in Y */
const ground = (page: Page, dx: number): Promise<P2> => page.evaluate((dx) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
  return t.project(hi[0] + dx, (lo[1] + hi[1]) / 2, lo[2]);
}, dx);

async function pasteGhost(page: Page): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await settle(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await inMenu(page, () => page.locator('#pastemode button[data-paste="brick"]').click());
  await page.keyboard.press('Control+v');
}

async function dragOnGround(page: Page, from: number, to: number): Promise<void> {
  const a = await ground(page, from), b = await ground(page, to);
  await page.mouse.move(...a); await frames(page);
  await page.mouse.down(); await frames(page);
  for (let i = 1; i <= 6; i++) { await page.mouse.move(a[0] + (b[0] - a[0]) * i / 6, a[1] + (b[1] - a[1]) * i / 6); await frames(page, 1); }
  await frames(page);
  await page.mouse.up(); await settle(page);
}

test('drag resize stretches one brick; J switches to drag repeat, which tiles copies as one undo step', async ({ page }) => {
  await pasteGhost(page);
  expect(await page.locator('#hud').innerHTML()).toMatch(/Drag: resize/);
  const n0 = (await snap(page)).bricks.length;
  await dragOnGround(page, 0.6, 2.2);
  let s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 1);
  const made = s.bricks[n0]!, a = s.bricks[0]!;
  expect(r3(made.hi[0] - made.lo[0])).toBeGreaterThan(r3(a.hi[0] - a.lo[0]));
  expect(r3(made.hi[2] - made.lo[2])).toBe(r3(a.hi[2] - a.lo[2]));

  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+v');
  await page.keyboard.press('j');
  expect(await page.locator('#hud').innerHTML()).toMatch(/Drag: repeat/);
  await dragOnGround(page, 0.6, 1.8);
  s = await snap(page);
  const added = s.bricks.length - n0 - 1;
  expect(s.status).toMatch(/^Placed \d+ bricks/);
  expect(added).toBeGreaterThan(1);
  for (const b of s.bricks.slice(n0 + 1)) expect(r3(b.hi[0] - b.lo[0])).toBe(r3(a.hi[0] - a.lo[0]));
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await settle(page);
  expect((await snap(page)).bricks.length).toBe(n0 + 1);
});

test('a plain click still places one brick, in either mode', async ({ page }) => {
  await pasteGhost(page);
  await page.keyboard.press('j');
  const n0 = (await snap(page)).bricks.length;
  await page.mouse.move(...(await ground(page, 0.6))); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  const s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 1);
  expect(s.ghost).toBe(false);
});
