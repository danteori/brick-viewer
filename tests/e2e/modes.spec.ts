// Explore / Edit modes (U-24), in the app only. Uses the startup brick and a copy of it.

import { expect, test, type Page } from '@playwright/test';

type P2 = [number, number];
interface Cam { x: number; y: number; half: number; yaw: number; pitch: number }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): { lo: number[]; hi: number[] };
  brickBox(k: number): { lo: number[]; hi: number[] };
  selection(): number[];
  snapshot(): { bricks: unknown[]; sel: number };
  mode(): string;
  setMode(m: 'explore' | 'edit'): void;
  camera(): Cam;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
const settle = async (page: Page): Promise<void> => { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); };
const mode = (page: Page): Promise<string> => page.evaluate(() => (window as unknown as W).__brickTest.mode());
const cam = (page: Page): Promise<Cam> => page.evaluate(() => (window as unknown as W).__brickTest.camera());
const sel = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot().sel);
const selection = (page: Page): Promise<number[]> => page.evaluate(() => (window as unknown as W).__brickTest.selection());
const onBrick = (page: Page, k: number): Promise<P2> => page.evaluate((k) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
  return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]);
}, k);

/** the startup brick A (focused) plus a copy B beside it, then Explore. */
async function twoBricksExplore(page: Page): Promise<void> {
  await page.goto('/?test');                               // ?test starts in Edit
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  expect(await mode(page)).toBe('edit');
  await page.locator('#btoggle').click();
  await settle(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.keyboard.press('Control+v');
  const at = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
    return t.project(hi[0] + 0.6, (lo[1] + hi[1]) / 2, lo[2]);
  });
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  expect((await page.evaluate(() => (window as unknown as W).__brickTest.snapshot().bricks.length))).toBe(2);
  await page.evaluate(() => (window as unknown as W).__brickTest.setMode('explore'));
  await settle(page);
}

test('startup is Explore and the mode is shown', async ({ page }) => {
  await page.goto('/?test&mode=explore');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  expect(await mode(page)).toBe('explore');
  await expect(page.locator('#viewmode button[data-vm="explore"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#hud')).toContainText('Explore');
});

test('Explore: clicks leave bricks alone; drag orbits freely, right-drag pans, scroll zooms; WASD pans; double-click edits; Esc leaves', async ({ page }) => {
  await twoBricksExplore(page);
  const focus = await sel(page), other = focus === 0 ? 1 : 0;        // whichever the paste left focused
  const b = await onBrick(page, other);
  await page.mouse.move(b[0], b[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
  expect(await sel(page)).toBe(focus);                      // a click on a brick doesn't focus it
  expect(await mode(page)).toBe('explore');

  // left-drag orbits: yaw and pitch change, no snapping to the iso corner
  let c0 = await cam(page);
  await page.mouse.move(b[0], b[1]); await page.mouse.down();
  await page.mouse.move(b[0] + 57, b[1] + 21, { steps: 6 }); await page.mouse.up(); await settle(page);
  let c1 = await cam(page);
  expect(Math.abs(c1.yaw - c0.yaw)).toBeGreaterThan(0.2);
  expect(Math.abs(c1.pitch - c0.pitch)).toBeGreaterThan(0.05);
  expect(await sel(page)).toBe(focus);

  // double-click brick B: Edit, B focused
  const b2 = await onBrick(page, other);
  await page.mouse.dblclick(b2[0], b2[1]); await settle(page);
  expect(await mode(page)).toBe('edit');
  expect(await sel(page)).toBe(other);
  await expect(page.locator('#viewmode button[data-vm="edit"]')).toHaveAttribute('aria-pressed', 'true');

  // Esc: clears the selection first, then returns to Explore
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+a');
  expect((await selection(page)).length).toBe(2);
  await page.keyboard.press('Escape');
  expect(await selection(page)).toEqual([]);
  expect(await mode(page)).toBe('edit');
  await page.keyboard.press('Escape');
  expect(await mode(page)).toBe('explore');

  // right-drag pans
  c0 = await cam(page);
  await page.mouse.move(600, 400); await page.mouse.down({ button: 'right' });
  await page.mouse.move(700, 400, { steps: 5 }); await page.mouse.up({ button: 'right' }); await frames(page);
  c1 = await cam(page);
  expect(c1.x).toBeLessThan(c0.x - 0.01);                   // dragging right moves the scene right = the camera left
  expect(c1.half).toBeCloseTo(c0.half, 6);

  // scroll up zooms in
  c0 = await cam(page);
  await page.mouse.move(400, 300); await page.mouse.wheel(0, -300); await frames(page);
  c1 = await cam(page);
  expect(c1.half).toBeLessThan(c0.half);

  // WASD pans; Shift is faster; W does not toggle the wires view
  c0 = await cam(page);
  await page.keyboard.down('d'); await page.waitForTimeout(300); await page.keyboard.up('d'); await frames(page);
  c1 = await cam(page);
  const slow = c1.x - c0.x;
  expect(slow).toBeGreaterThan(0);
  await page.keyboard.down('Shift'); await page.keyboard.down('d'); await page.waitForTimeout(300); await page.keyboard.up('d'); await page.keyboard.up('Shift'); await frames(page);
  expect((await cam(page)).x - c1.x).toBeGreaterThan(slow);
  c0 = await cam(page);
  await page.keyboard.down('w'); await page.waitForTimeout(200); await page.keyboard.up('w'); await frames(page);
  expect((await cam(page)).y).toBeGreaterThan(c0.y);
  await expect(page.locator('#wiresbtn')).toHaveAttribute('aria-pressed', 'false');
});

test('the toggle leaves the camera where it is; an editing panel enters Edit', async ({ page }) => {
  await twoBricksExplore(page);
  const c0 = await cam(page);
  await page.locator('#viewmode button[data-vm="edit"]').click(); await settle(page);
  expect(await mode(page)).toBe('edit');
  const c1 = await cam(page);
  expect(c1.x).toBeCloseTo(c0.x, 6); expect(c1.y).toBeCloseTo(c0.y, 6); expect(c1.half).toBeCloseTo(c0.half, 6);
  await page.locator('#viewmode button[data-vm="explore"]').click(); await frames(page);
  expect(await mode(page)).toBe('explore');
  await page.locator('#tool button[data-tool="move"]').click();   // an editing panel
  expect(await mode(page)).toBe('edit');
});
