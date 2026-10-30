import { expect, test, type Page } from '@playwright/test';
import { inMenu } from './windows.ts';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  brickBox(k: number): Box;
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

/** a ground point beside the startup brick (a placed brick takes the focus): dx past its +X face, dy from its middle in Y */
const ground = (page: Page, dx: number, dy = 0): Promise<P2> => page.evaluate(([dx, dy]) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(0);
  return t.project(hi[0] + dx, (lo[1] + hi[1]) / 2 + dy, lo[2]);
}, [dx, dy] as const);

async function glide(page: Page, a: P2, b: P2): Promise<void> {
  for (let i = 1; i <= 6; i++) { await page.mouse.move(a[0] + (b[0] - a[0]) * i / 6, a[1] + (b[1] - a[1]) * i / 6); await frames(page, 1); }
  await frames(page);
}

async function pasteGhost(page: Page, url = '/?test'): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await settle(page);
  await page.mouse.move(640, 790);
  await page.mouse.wheel(0, 600);
  await settle(page);
  await page.keyboard.press('Control+c');
  await inMenu(page, () => page.locator('#pastemode button[data-paste="brick"]').click());
  await page.keyboard.press('Control+v');
}

const place = (page: Page): ReturnType<Page['locator']> => page.locator('#precplace');

test('precision mode: a drag moves the ghost along an axis, PgUp floats it, the Place button puts it down', async ({ page }) => {
  await pasteGhost(page);
  const n0 = (await snap(page)).bricks.length, a = (await snap(page)).bricks[0]!;
  const from = await ground(page, 0.6), to = await ground(page, 2.2);
  await page.mouse.move(...from); await frames(page);
  await expect(place(page)).toBeHidden();
  await page.keyboard.press('g'); await frames(page);
  await expect(place(page)).toBeVisible();

  await page.mouse.down(); await frames(page);
  await glide(page, from, to);
  await page.mouse.up(); await frames(page);
  await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp');
  await frames(page);
  expect((await snap(page)).bricks.length).toBe(n0);

  await place(page).click(); await settle(page);
  const s = await snap(page), made = s.bricks[n0]!;
  expect(s.bricks.length).toBe(n0 + 1);
  expect(made.lo[0]! - a.hi[0]!).toBeGreaterThan(1);
  expect(r3(made.lo[1]! - a.lo[1]!)).toBe(0);
  expect(made.lo[2]!).toBeGreaterThan(a.lo[2]!);
  expect(s.ghost).toBe(true);
  await expect(place(page)).toBeVisible();
});

test('precision mode: a short right-click leaves it and keeps the brick in hand; Esc cancels the placement', async ({ page }) => {
  await pasteGhost(page);
  await page.mouse.move(...(await ground(page, 0.6))); await frames(page);
  await page.keyboard.press('g'); await frames(page);
  await expect(place(page)).toBeVisible();
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await frames(page);
  await expect(place(page)).toBeHidden();
  expect((await snap(page)).ghost).toBe(true);
  await page.keyboard.press('g'); await frames(page);
  await expect(place(page)).toBeVisible();
  await page.keyboard.press('Escape'); await frames(page);
  expect((await snap(page)).ghost).toBe(false);
  await expect(place(page)).toBeHidden();
});

test('free camera: C toggles precision mode and it stays on after Place; Ctrl+V pastes at the original location (U-36)', async ({ page }) => {
  await pasteGhost(page, '/?test&mode=one');
  const n0 = (await snap(page)).bricks.length, a = (await snap(page)).bricks[0]!;
  await page.mouse.move(...(await ground(page, 0.6))); await frames(page);
  await page.keyboard.press('c'); await frames(page);
  await expect(place(page)).toBeVisible();
  await page.keyboard.press('c'); await frames(page);
  await expect(place(page)).toBeHidden();
  await page.keyboard.press('c'); await frames(page);
  await page.keyboard.press('Control+v'); await frames(page);
  await expect(place(page)).toBeVisible();
  await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await frames(page);
  await place(page).click(); await settle(page);
  let s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 1);
  const made = s.bricks[n0]!;
  expect(r3(made.lo[0]! - a.lo[0]!)).toBe(0);
  expect(r3(made.lo[1]! - a.lo[1]!)).toBe(0);
  expect(made.lo[2]!).toBeGreaterThan(a.lo[2]!);
  await expect(place(page)).toBeVisible();
  await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); await frames(page);
  await page.keyboard.press('Enter'); await settle(page);
  s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 2);
});

test('alignment: V cycles the step, so one PgUp raises half a plate in Half mode', async ({ page }) => {
  await pasteGhost(page);
  const n0 = (await snap(page)).bricks.length, a = (await snap(page)).bricks[0]!;
  const at = await ground(page, 1.2);
  await page.mouse.move(...at); await frames(page);
  await page.keyboard.press('v'); await frames(page);
  await page.keyboard.press('PageUp'); await frames(page);
  await page.mouse.click(...at); await settle(page);
  const s = await snap(page);
  expect(s.bricks.length).toBe(n0 + 1);
  expect(r3(s.bricks[n0]!.lo[2]! - a.lo[2]!)).toBe(0.04);
});
