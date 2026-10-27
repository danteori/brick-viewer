// E-21 hidden bricks (Visible off): they show while a brick is selected, the Menu's Hidden button
// overrides that, and a hidden brick can be picked only while it shows. Synthetic saves only.

import { expect, test, type Page } from '@playwright/test';
import { synthSave, type SynthBrick } from '../unit/synthsave.ts';
import { inMenu } from './windows.ts';

test.describe.configure({ timeout: 120_000 });

type P2 = [number, number];
interface Api {
  loadSave(b64: string, name: string): { bricks: number };
  settle(): Promise<number>;
  mode(): string;
  focus(k: number): void;
  focused(): number;
  brickBox(k: number): { lo: number[]; hi: number[] };
  project(x: number, y: number, z: number): P2;
  hidden(): { mode: string; shown: boolean; ghosts: number };
}
type W = { __brickTest: Api };

const b64 = (bricks: SynthBrick[]): string => Buffer.from(synthSave(bricks)).toString('base64');
const brick = (x: number, hidden = false): SynthBrick => ({ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [x, 0, 6], color: [236, 13, 71], hidden });
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const state = (page: Page): Promise<ReturnType<Api['hidden']>> => page.evaluate(() => (window as unknown as W).__brickTest.hidden());
const focused = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__brickTest.focused());
const centreOf = (page: Page, k: number): Promise<P2> => page.evaluate((k) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
  return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
}, k);

async function open(page: Page): Promise<void> {
  await page.goto('/?test&mode=one');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  expect(await page.evaluate(() => (window as unknown as W).__brickTest.mode())).toBe('free');
  await page.evaluate(async ([s]) => { const t = (window as unknown as W).__brickTest; t.loadSave(s!, 'hidden.brz'); await t.settle(); }, [b64([brick(0), brick(30, true)])]);
  await frames(page);
}

async function deselect(page: Page): Promise<void> {
  await page.mouse.move(640, 790);
  await page.keyboard.press('Escape'); await frames(page);
  expect(await focused(page)).toBe(-1);
}

async function clickBrick(page: Page, k: number): Promise<void> {
  const [x, y] = await centreOf(page, k);
  await page.mouse.move(x, y); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
}

test('Hidden bricks show and can be picked only while a brick is selected (auto)', async ({ page }) => {
  await open(page);
  expect((await state(page)).ghosts).toBe(1);
  expect(await focused(page)).toBe(0);
  expect((await state(page)).shown).toBe(true);
  await deselect(page);
  expect(await state(page)).toMatchObject({ mode: 'auto', shown: false });
  await clickBrick(page, 1);
  expect(await focused(page)).toBe(-1);
  await page.evaluate(() => (window as unknown as W).__brickTest.focus(0)); await frames(page);
  expect((await state(page)).shown).toBe(true);
  await clickBrick(page, 1);
  expect(await focused(page)).toBe(1);
});

test('The Menu Hidden button cycles auto, shown and off', async ({ page }) => {
  await open(page);
  await deselect(page);
  const btn = page.locator('#viewbox #hiddenbtn');
  await inMenu(page, async () => {
    await expect(btn).toHaveText('Hidden: auto');
    await expect(btn).toHaveAttribute('aria-pressed', 'mixed');
    await btn.click();
    await expect(btn).toHaveText('Hidden: shown');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
  });
  expect(await state(page)).toMatchObject({ mode: 'show', shown: true });
  await clickBrick(page, 1);
  expect(await focused(page)).toBe(1);
  await inMenu(page, async () => {
    await btn.click();
    await expect(btn).toHaveText('Hidden: off');
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
  });
  await page.evaluate(() => (window as unknown as W).__brickTest.focus(0)); await frames(page);
  expect(await state(page)).toMatchObject({ mode: 'hide', shown: false });
  await clickBrick(page, 1);
  expect(await focused(page)).toBe(0);
  await inMenu(page, async () => { await btn.click(); await expect(btn).toHaveText('Hidden: auto'); });
});
