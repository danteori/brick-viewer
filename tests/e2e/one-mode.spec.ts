import { expect, test, type Page } from '@playwright/test';

type P2 = [number, number];
interface Cam { x: number; y: number; half: number; yaw: number; pitch: number }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): { lo: number[]; hi: number[] };
  brickBox(k: number): { lo: number[]; hi: number[] };
  snapshot(): { bricks: unknown[]; sel: number };
  mode(): string;
  gliding(): boolean;
  focused(): number;
  windows(): string[];
  openWindow(id: string): void;
  closeWindow(id: string): void;
  camera(): Cam;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
const settle = async (page: Page): Promise<void> => { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); };
const cam = (page: Page): Promise<Cam> => page.evaluate(() => (window as unknown as W).__brickTest.camera());
const sel = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__brickTest.focused());
const windows = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as W).__brickTest.windows());
const centreOf = (page: Page, k: number): Promise<P2> => page.evaluate((k) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
  return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
}, k);
const nearTopOf = (page: Page, k: number): Promise<P2> => page.evaluate((k) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
  return t.project(lo[0] + (hi[0] - lo[0]) / 4, (lo[1] + hi[1]) / 2, hi[2]);
}, k);

async function open(page: Page): Promise<void> {
  await page.goto('/?test&mode=one');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  expect(await page.evaluate(() => (window as unknown as W).__brickTest.mode())).toBe('free');
  await settle(page);
}

async function twoBricks(page: Page): Promise<void> {
  await open(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await page.evaluate(() => (window as unknown as W).__brickTest.openWindow('escmenu'));
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.evaluate(() => (window as unknown as W).__brickTest.closeWindow('escmenu'));
  await page.keyboard.press('Control+v');
  const at = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
    return t.project(hi[0] + 0.6, (lo[1] + hi[1]) / 2, lo[2]);
  });
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  expect((await page.evaluate(() => (window as unknown as W).__brickTest.snapshot().bricks.length))).toBe(2);
  await page.keyboard.press('Escape');
}

test('B opens and closes the Bricks window; Esc closes it too', async ({ page }) => {
  await open(page);
  await expect(page.locator('#catwin')).toBeHidden();
  await page.keyboard.press('b');
  await expect(page.locator('#catwin')).toBeVisible();
  await expect(page.locator('#catwin .bitem').first()).toBeVisible();
  expect(await windows(page)).toEqual(['catwin']);
  await page.keyboard.press('b');
  await expect(page.locator('#catwin')).toBeHidden();
  await page.keyboard.press('b');
  const before = await sel(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#catwin')).toBeHidden();
  expect(await sel(page)).toBe(before);
});

test('Esc deselects first, then opens the Menu, then closes it', async ({ page }) => {
  await open(page);
  expect(await sel(page)).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  expect(await sel(page)).toBe(-1);
  await expect(page.locator('#escmenu')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('#escmenu')).toBeVisible();
  await expect(page.locator('#escmenu #open')).toBeVisible();
  await expect(page.locator('#escmenu #wiresbtn')).toHaveText('Wires: off');
  await page.keyboard.press('Escape');
  await expect(page.locator('#escmenu')).toBeHidden();
  expect(await windows(page)).toEqual([]);
});

test('a click selects a brick and leaves the camera; a double-click centres on it', async ({ page }) => {
  await twoBricks(page);
  const other = (await sel(page)) === 0 ? 1 : 0;
  const c0 = await cam(page), s0 = await centreOf(page, 0);
  const p = await nearTopOf(page, other);
  await page.mouse.move(p[0], p[1]); await frames(page, 4);
  await page.mouse.click(p[0], p[1]); await frames(page, 6);
  expect(await sel(page)).toBe(other);
  const c1 = await cam(page), s1 = await centreOf(page, 0);
  expect(Math.abs(s1[0] - s0[0])).toBeLessThan(0.5); expect(Math.abs(s1[1] - s0[1])).toBeLessThan(0.5);
  expect(c1.half).toBeCloseTo(c0.half, 6); expect(c1.yaw).toBeCloseTo(c0.yaw, 6); expect(c1.pitch).toBeCloseTo(c0.pitch, 6);

  await page.keyboard.press('Escape');
  const target = (await sel(page)) === 0 ? 1 : 0;
  const q = await nearTopOf(page, target);
  await page.mouse.move(q[0], q[1]); await frames(page, 4);
  await page.mouse.dblclick(q[0], q[1]);
  await page.waitForFunction(() => !(window as unknown as W).__brickTest.gliding(), undefined, { timeout: 10_000 });
  await frames(page);
  expect(await sel(page)).toBe(target);
  const box = await page.locator('#c').boundingBox();
  const m = await centreOf(page, target);
  expect(Math.abs(m[0] - box!.width / 2)).toBeLessThan(3);
  expect(Math.abs(m[1] - box!.height / 2)).toBeLessThan(3);
  expect((await cam(page)).half).toBeCloseTo(c1.half, 6);
});

test('the camera keys are off while a brick is selected; after Esc, Space moves up and a held Shift moves down', async ({ page }) => {
  await open(page);
  await page.mouse.move(5, 400);
  expect(await sel(page)).toBeGreaterThanOrEqual(0);
  const c0 = await cam(page);
  await page.keyboard.down(' '); await page.waitForTimeout(400); await page.keyboard.up(' ');
  await page.keyboard.down('w'); await page.waitForTimeout(300); await page.keyboard.up('w');
  expect(await cam(page)).toEqual(c0);
  await page.keyboard.press('Escape');
  expect(await sel(page)).toBeLessThan(0);
  const y0 = (await cam(page)).y;
  await page.keyboard.down(' '); await page.waitForTimeout(400); await page.keyboard.up(' ');
  const y1 = (await cam(page)).y;
  expect(y1).toBeGreaterThan(y0);
  await page.keyboard.down('Shift'); await page.waitForTimeout(700); await page.keyboard.up('Shift');
  expect((await cam(page)).y).toBeLessThan(y1);
});

test('the context panel docks at the right edge with a selection and hides without one', async ({ page }) => {
  await open(page);
  const panel = page.locator('#props');
  await expect(panel).toBeVisible();
  await expect(page.locator('#flagbody .flagsw')).toHaveCount(9);
  await expect(page.locator('#props #tool')).toBeVisible();
  await expect(page.locator('#ctxdone')).toHaveCount(0);
  await expect(page.locator('#side #viewbox')).toHaveCount(0);
  await frames(page, 4);
  const r = await panel.boundingBox();
  const vp = page.viewportSize()!;
  expect(r!.x + r!.width).toBeLessThanOrEqual(vp.width);
  expect(vp.width - (r!.x + r!.width)).toBeLessThan(40);
  expect(r!.y).toBeGreaterThanOrEqual(0);

  await page.keyboard.press('Escape');
  expect(await sel(page)).toBe(-1);
  await expect(panel).toBeHidden();
  const p = await nearTopOf(page, 0);
  await page.mouse.move(p[0], p[1]); await frames(page, 4);
  await page.mouse.click(p[0], p[1]); await frames(page, 4);
  expect(await sel(page)).toBe(0);
  await expect(panel).toBeVisible();
});
