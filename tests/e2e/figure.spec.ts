// Player reference figure (U-16): P / the Figure button shows a 4-brick-tall mannequin beside the
// focused brick, on its base level. It is not a brick: clicks pass through it and it is never saved.
// Startup brick only, no private data.

import { expect, test, type Page } from '@playwright/test';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): Box;
  snapshot(): { bricks: Box[]; sel: number };
  selection(): number[];
  figureBoxes(): [number[], number[]][];
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 180_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const api = <T>(page: Page, f: (t: Api) => T): Promise<T> => page.evaluate(f as never) as Promise<T>;
const UNIT = 0.02;          // viewer units per Brickadia unit (a plate, 4 units, is 0.08)

test('P shows the figure beside the focused brick, 48 units tall on its base level; clicks pass through; P hides it', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#btoggle').click();
  await page.locator('#ptoggle').click();
  await settle(page);
  expect(await api(page, () => (window as unknown as W).__brickTest.figureBoxes())).toEqual([]);
  const before = await api(page, () => (window as unknown as W).__brickTest.snapshot());

  await page.keyboard.press('p');
  await settle(page);
  await expect(page.locator('#figure')).toHaveAttribute('aria-pressed', 'true');
  const boxes = await api(page, () => (window as unknown as W).__brickTest.figureBoxes());
  const focus = await api(page, () => (window as unknown as W).__brickTest.focusBox());
  expect(boxes.length).toBe(11);
  const zlo = Math.min(...boxes.map((b) => b[0][2]!)), zhi = Math.max(...boxes.map((b) => b[1][2]!));
  expect(zlo).toBeCloseTo(focus.lo[2]!, 6);                           // on the brick's base level
  expect(zhi - zlo).toBeCloseTo(48 * UNIT, 6);                        // 4 bricks tall
  const xlo = Math.min(...boxes.map((b) => b[0][0]!)), xhi = Math.max(...boxes.map((b) => b[1][0]!));
  expect(xlo >= focus.hi[0]! - 1e-6 || xhi <= focus.lo[0]! + 1e-6).toBe(true);   // beside the brick, not in it

  // a click on the figure's chest picks nothing: the focus, the selection and the scene stay
  const torso = boxes[4]!;
  const at = await page.evaluate(([l, h]) => (window as unknown as W).__brickTest.project((l[0]! + h[0]!) / 2, (l[1]! + h[1]!) / 2, (l[2]! + h[2]!) / 2), torso);
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await settle(page);
  const after = await api(page, () => (window as unknown as W).__brickTest.snapshot());
  expect(after.bricks).toEqual(before.bricks);
  expect(after.sel).toBe(before.sel);
  expect(await api(page, () => (window as unknown as W).__brickTest.selection())).toEqual([]);

  await page.locator('#figure').click();                              // the View button toggles it too
  await settle(page);
  await expect(page.locator('#figure')).toHaveAttribute('aria-pressed', 'false');
  expect(await api(page, () => (window as unknown as W).__brickTest.figureBoxes())).toEqual([]);
});
