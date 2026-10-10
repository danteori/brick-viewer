// E-06 applicator: change the brick type or material of the selection / focused brick, one undo
// step each, collision-checked, written by Save .brz. Synthetic saves only.

import { expect, test, type Page } from '@playwright/test';
import { synthSave, type SynthBrick } from '../unit/synthsave.ts';
import { readBrz } from '../../src/format/brz.ts';
import { extractBricks } from '../../src/format/world.ts';
import { readFileSync } from 'node:fs';

test.describe.configure({ timeout: 120_000 });

interface SnapBrick { lo: number[]; hi: number[]; material?: string; shape?: string; top?: string; round?: string; micro?: boolean }
interface Api {
  loadSave(b64: string, name: string): { bricks: number };
  settle(): Promise<number>;
  select(ids: number[]): void;
  ids(): number[];
  focus(k: number): void;
  snapshot(): { bricks: SnapBrick[]; status: string };
}
type W = { __brickTest: Api };

const b64 = (bricks: SynthBrick[]): string => Buffer.from(synthSave(bricks)).toString('base64');
const brick = (x: number, y = 0): SynthBrick => ({ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [x, y, 6], color: [200, 40, 40] });
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const snap = (page: Page): Promise<ReturnType<Api['snapshot']>> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot());

async function open(page: Page, save: string): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(async ([s]) => { const t = (window as unknown as W).__brickTest; t.loadSave(s!, 'apply.brz'); await t.settle(); }, [save]);
  await frames(page);
  await page.locator('#apptoggle').click();
  await expect(page.locator('#appbody')).toBeVisible();
}

test('Applicator: type and material changes on the focused brick, undo / redo, saved', async ({ page }) => {
  await open(page, b64([brick(0), brick(60)]));
  await page.evaluate(() => (window as unknown as W).__brickTest.focus(0));
  await page.locator('#apptype').selectOption('PB_DefaultSmoothTile');
  await page.locator('#appapplytype').click();
  let s = await snap(page);
  expect(s.status).toMatch(/Changed 1 brick to Smooth Tile/);
  expect(s.bricks[0]!.top).toBe('smooth');
  expect(s.bricks[1]!.top ?? 'studs').toBe('studs');
  const box0 = { lo: s.bricks[0]!.lo, hi: s.bricks[0]!.hi };
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await frames(page);
  expect((await snap(page)).bricks[0]!.top ?? 'studs').toBe('studs');
  await page.keyboard.press('Control+y'); await frames(page);
  s = await snap(page);
  expect(s.bricks[0]!.top).toBe('smooth');
  expect({ lo: s.bricks[0]!.lo, hi: s.bricks[0]!.hi }).toEqual(box0);   // the size is kept
  // to a fixed type: its own size, standing on the same bottom
  await page.locator('#apptype').selectOption('B_2x2F_Round');
  await page.locator('#appapplytype').click();
  s = await snap(page);
  expect(s.bricks[0]!.shape).toBe('round');
  expect(s.bricks[0]!.round).toBe('B_2x2F_Round');
  expect(s.bricks[0]!.lo[2]).toBeCloseTo(box0.lo[2]!, 6);
  expect(s.bricks[0]!.hi[2]! - s.bricks[0]!.lo[2]!).toBeLessThan(box0.hi[2]! - box0.lo[2]!);
  // material
  await page.locator('#appmat').selectOption('BMC_Glow');
  await page.locator('#appapplymat').click();
  s = await snap(page);
  expect(s.status).toMatch(/Changed 1 brick to Glow/);
  expect(s.bricks[0]!.material).toBe('BMC_Glow');
  // saved
  const dl = page.waitForEvent('download');
  await page.locator('#savebrz').click();
  const files = readBrz(new Uint8Array(readFileSync((await (await dl).path())!)));
  const saved = extractBricks(files).bricks;
  expect(saved.map((b) => b.asset).sort()).toEqual(['B_2x2F_Round', 'PB_DefaultBrick']);
  expect(saved.find((b) => b.asset === 'B_2x2F_Round')!.material).toBe('BMC_Glow');
});

test('Applicator: a selection changes as one step; a change that would overlap a brick is left out', async ({ page }) => {
  await open(page, b64([brick(0), brick(20), brick(100)]));
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; t.select(t.ids()); });
  // 4x4 rounds are twice as wide: the two touching bricks would overlap each other, the far one fits
  await page.locator('#apptype').selectOption('B_4x4_Round');
  await page.locator('#appapplytype').click();
  let s = await snap(page);
  expect(s.status).toMatch(/Changed 1 brick to 4x4 Round · left as they are: 2 would overlap a brick/);
  expect(s.bricks.map((b) => b.round ?? '-')).toEqual(['-', '-', 'B_4x4_Round']);
  // to a resizable type: the bricks keep their size, the round takes its box on the micro grid
  await page.locator('#apptype').selectOption('PB_DefaultMicroBrick');
  await page.locator('#appapplytype').click();
  s = await snap(page);
  expect(s.status).toMatch(/Changed 3 bricks to Microbrick/);
  expect(s.bricks.filter((b) => b.micro).length).toBe(3);
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await frames(page);
  expect((await snap(page)).bricks.filter((b) => b.micro).length).toBe(0);
});
