// C-13, C-15, C-16: the logic bar (pause, step, tick rate), the hover prompt and the E / right-click
// interaction, on the synthetic component save: brick 0 of chunk 0_0_0 is a switch that is on.

import { expect, test, type Page } from '@playwright/test';
import { writeBrz } from '../../src/format/brz.ts';
import { save } from '../unit/comp-fixture.ts';

test.describe.configure({ timeout: 240_000 });

interface Logic { ticks: number; tps: number; paused: boolean; prompt: string | null; texts: string[]; switches: boolean[] }
interface Api {
  loadSave(b64: string, name: string): { bricks: number; status: string };
  settle(): Promise<number>;
  logic(): Logic;
  rowOfBrick(key: string): number;
  brickBox(k: number): { lo: number[]; hi: number[] };
  project(x: number, y: number, z: number): [number, number];
}
type W = { __brickTest: Api };

const FIXTURE = Buffer.from(writeBrz(save())).toString('base64');
const logic = (page: Page): Promise<Logic> => page.evaluate(() => (window as unknown as W).__brickTest.logic());
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);

test('Logic bar, hover prompt, E and right-click flip the switch', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await expect(page.locator('#logicbar')).toBeHidden();
  await page.evaluate(async (s) => { const t = (window as unknown as W).__brickTest; t.loadSave(s, 'logic.brz'); await t.settle(); }, FIXTURE);
  await frames(page);

  await expect(page.locator('#logicbar')).toBeVisible();
  await page.locator('#logictps').selectOption('10');
  await page.locator('#logicpause').click();
  const paused = await logic(page);
  expect(paused).toMatchObject({ tps: 10, paused: true, switches: [true] });
  await frames(page, 6);
  expect((await logic(page)).ticks).toBe(paused.ticks);
  await page.locator('#logicstep').click();
  expect((await logic(page)).ticks).toBe(paused.ticks + 1);
  await page.locator('#logicpause').click();
  expect((await logic(page)).paused).toBe(false);

  const [x, y] = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest, b = t.brickBox(t.rowOfBrick('1/0_0_0/0'));
    return t.project((b.lo[0]! + b.hi[0]!) / 2, (b.lo[1]! + b.hi[1]!) / 2, b.hi[2]! - 0.05);
  });
  await page.mouse.move(x + 200, y + 150);
  await frames(page, 3);
  expect((await logic(page)).prompt).toBeNull();
  await expect(page.locator('#interactprompt')).toBeHidden();

  await page.mouse.move(x, y);
  await expect.poll(async () => (await logic(page)).prompt, { timeout: 5000 }).toBe('Interact');
  await expect(page.locator('#interactprompt')).toBeVisible();

  await page.keyboard.press('e');
  await expect.poll(async () => (await logic(page)).switches, { timeout: 5000 }).toEqual([false]);
  await page.keyboard.press('e');
  await expect.poll(async () => (await logic(page)).switches, { timeout: 5000 }).toEqual([true]);

  await page.mouse.click(x, y, { button: 'right' });
  await expect.poll(async () => (await logic(page)).switches, { timeout: 5000 }).toEqual([false]);

  await page.mouse.move(x + 200, y + 150);
  await frames(page, 3);
  await page.keyboard.press('e');
  await frames(page, 4);
  expect((await logic(page)).switches).toEqual([false]);
});
