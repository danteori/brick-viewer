// U-18 / U-22: fill paint, the mirror tool, Save selection and Save to game. Synthetic saves only.

import { expect, test, type Page } from '@playwright/test';
import { synthSave, type SynthBrick } from '../unit/synthsave.ts';
import { readBrz } from '../../src/format/brz.ts';
import { extractBricks } from '../../src/format/world.ts';

test.describe.configure({ timeout: 120_000 });

type P2 = [number, number];
interface SnapBrick { lo: number[]; hi: number[]; color: number[]; material?: string; shape?: string; lip?: number; run?: number }
interface Api {
  loadSave(b64: string, name: string): { bricks: number };
  settle(): Promise<number>;
  brickBox(k: number): { lo: number[]; hi: number[] };
  project(x: number, y: number, z: number): P2;
  ids(): number[];
  select(ids: number[]): void;
  focus(k: number): void;
  snapshot(): { bricks: SnapBrick[]; status: string; ghost: boolean };
}
type W = { __brickTest: Api };

const b64 = (bricks: SynthBrick[]): string => Buffer.from(synthSave(bricks)).toString('base64');
const RED: [number, number, number] = [200, 40, 40], BLUE: [number, number, number] = [40, 40, 200];
const brick = (x: number, y: number, color = RED, material?: string): SynthBrick => ({ asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [x, y, 6], color, ...(material && { material }) });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const snap = (page: Page): Promise<ReturnType<Api['snapshot']>> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot());

async function open(page: Page, save: string, name = 'edit2.brz'): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(async ([s, n]) => { const t = (window as unknown as W).__brickTest; t.loadSave(s!, n!); await t.settle(); }, [save, name]);
  await frames(page);
}
const top = (page: Page, k: number): Promise<P2> => page.evaluate((k) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
  return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]);
}, k);

test('Fill paint: Alt+click paints the connected bricks of that colour and material, one undo step; Ctrl+click takes a paint', async ({ page }) => {
  // 0-1 touch (red), 2 blue touches 1, 3 red touches only 2, 4 red glow touches 0
  await open(page, b64([brick(0, 0), brick(20, 0), brick(40, 0, BLUE), brick(60, 0), brick(0, 20, RED, 'BMC_Glow')]));
  const before = (await snap(page)).bricks.map((b) => b.color.join());
  await page.locator('#painttoggle').click();
  await page.locator('#paintbody .bvp-sw').nth(5).click();
  await page.mouse.move(640, 790);
  await page.keyboard.press('3');
  const at = await top(page, 0);
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.keyboard.down('Alt'); await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Alt');
  await frames(page);
  const s = await snap(page), after = s.bricks.map((b) => b.color.join());
  expect(s.status).toMatch(/Fill painted 2 bricks/);
  expect(after[0]).toBe(after[1]);
  expect(after[0]).not.toBe(before[0]);
  expect(after.slice(2)).toEqual(before.slice(2));
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+z'); await frames(page);
  expect((await snap(page)).bricks.map((b) => b.color.join())).toEqual(before);
  // Ctrl+click: the eyedropper takes the blue brick's paint
  const bl = await top(page, 2);
  await page.mouse.move(bl[0], bl[1]); await frames(page);
  await page.keyboard.down('Control'); await page.mouse.down(); await page.mouse.up(); await page.keyboard.up('Control');
  await expect(page.locator('#paintbody .bvp-hex')).toHaveText(/#2828c8/i);
  await page.keyboard.press('1');
});

test('Mirror X: the selection mirrors in place (a ramp flips its lip), one undo step; the ghost mirrors too', async ({ page }) => {
  await open(page, b64([
    { asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [0, 0, 6], orient: 16, color: RED },
    brick(30, 0, BLUE),
  ]));
  const s0 = await snap(page);
  expect(s0.bricks[0]!.shape).toBe('ramp');
  const lip0 = s0.bricks[0]!.lip;
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; t.select(t.ids()); });
  await page.mouse.move(640, 790);
  await page.keyboard.press('Alt+x'); await frames(page);
  const s1 = await snap(page);
  expect(s1.status).toMatch(/Mirrored 2 bricks across X/);
  // the group spans x -20 .. 40 (units): the ramp (-20..20) goes to 0..40, the brick (20..40) to -20..0
  const xs = s1.bricks.map((b) => [+(b.lo[0]! / 0.02).toFixed(0), +(b.hi[0]! / 0.02).toFixed(0)]);
  expect(xs).toEqual([[0, 40], [-20, 0]]);
  expect(s1.bricks[0]!.lip).toBe(-lip0!);
  await page.keyboard.press('Control+z'); await frames(page);
  expect((await snap(page)).bricks).toEqual(s0.bricks);
  // the Mirror Y button works on the selection too
  await page.locator('#selbody button[data-mirror="1"]').click(); await frames(page);
  expect((await snap(page)).status).toMatch(/across Y/);
  // a ghost (Ctrl+C, Ctrl+V of the ramp) mirrors in hand
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; t.select([]); t.focus(0); });
  await page.keyboard.press('Control+c');
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.keyboard.press('Control+v'); await frames(page);
  expect((await snap(page)).ghost).toBe(true);
  await page.keyboard.press('Alt+x'); await frames(page);
  expect((await snap(page)).status).toMatch(/Mirrored .* across X/);
  await page.keyboard.press('Escape');
});

test('Mirror refuses when the mirrored bricks would overlap another brick', async ({ page }) => {
  // ramp (-20..20) and brick 1 (40..60) selected: mirrored, the ramp takes 20..60, where brick 2 (20..40, not selected) is
  await open(page, b64([
    { asset: 'PB_DefaultRamp', size: [20, 10, 6], pos: [0, 0, 6], orient: 16, color: RED },
    brick(50, 0, BLUE),
    brick(30, 0, BLUE),
  ]));
  const s0 = await snap(page);
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; const ids = t.ids(); t.select([ids[0]!, ids[1]!]); });
  await page.mouse.move(640, 790);
  await page.keyboard.press('Alt+x'); await frames(page);
  const s1 = await snap(page);
  expect(s1.status).toMatch(/Can't mirror .* overlap/);
  expect(s1.bricks).toEqual(s0.bricks);
});

test('Save selection downloads just the selection; Save to game writes a timestamped .brz into the picked folder', async ({ page }) => {
  await page.addInitScript(() => {
    const saved: { name: string; bytes: number[] }[] = [];
    (window as unknown as { __saved: typeof saved }).__saved = saved;
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => ({
      name: 'PROJECT WORK',
      async getFileHandle(name: string) {
        return { async createWritable() { const parts: number[] = []; return { async write(d: Uint8Array) { parts.push(...d); }, async close() { saved.push({ name, bytes: parts }); } }; } };
      },
    });
  });
  await open(page, b64([brick(0, 0), brick(20, 0), brick(40, 0, BLUE)]), 'parts.brz');
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; const ids = t.ids(); t.select([ids[0]!, ids[2]!]); });
  const dl = page.waitForEvent('download');
  await page.locator('#savesel').click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe('parts (selection).brz');
  const path = await d.path();
  const { readFileSync } = await import('node:fs');
  const files = readBrz(new Uint8Array(readFileSync(path!)));
  expect(extractBricks(files).bricks.map((b) => b.pos[0])).toEqual([0, 40]);
  // Save to game: the selection, into the (mock) picked folder
  await expect(page.locator('#savegame')).toBeVisible();
  await page.locator('#savegame').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved.length)).toBe(1);
  const out = await page.evaluate(() => (window as unknown as { __saved: { name: string; bytes: number[] }[] }).__saved[0]!);
  expect(out.name).toMatch(/^parts selection \d{4}-\d\d-\d\d \d\d-\d\d-\d\d\.brz$/);
  expect(extractBricks(readBrz(new Uint8Array(out.bytes))).bricks).toHaveLength(2);
  await expect.poll(async () => (await snap(page)).status).toMatch(/into "PROJECT WORK"/);
  // nothing selected: the whole build
  await page.evaluate(() => (window as unknown as W).__brickTest.select([]));
  await page.locator('#savegame').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __saved: unknown[] }).__saved.length)).toBe(2);
  const all = await page.evaluate(() => (window as unknown as { __saved: { name: string; bytes: number[] }[] }).__saved[1]!);
  expect(all.name).toMatch(/^parts \d{4}-/);
  expect(extractBricks(readBrz(new Uint8Array(all.bytes))).bricks).toHaveLength(3);
});

test('Save to game is hidden where the File System Access API is missing', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true }); });
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await expect(page.locator('#savesel')).toBeVisible();
  await expect(page.locator('#savegame')).toHaveCount(0);
});
