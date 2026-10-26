import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { readBrz, writeBrz, type FileMap } from '../../src/format/brz.ts';
import { readEntities } from '../../src/format/entities.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { extractBricks, rebuildFromLoaded } from '../../src/format/world.ts';
import { gridWorld, MAIN } from '../unit/gridworld.ts';

type P2 = [number, number];
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  ids(): number[];
  byId(): [number, number[], number[], number[]][];
  grids(): { id: number; ids: number[] }[] | null;
  snapshot(): { zoom: number };
  setView(a: { k: number; zoom?: number; baseZoom: number }): void;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 180_000 });

function moved(files: FileMap, shift: (i: number) => [number, number, number]): FileMap {
  const { bricks } = extractBricks(files);
  return rebuildFromLoaded(files, bricks.map((b, i) => ({ ...b, pos: b.pos.map((v, k) => v + shift(i)[k]!) as [number, number, number] }))).files;
}
const FAR: [number, number, number] = [0, 0, 400];
const base = Buffer.from(writeBrz(gridWorld()));
const far = Buffer.from(writeBrz(moved(gridWorld({ entityless: true }), () => FAR)));
const partly = Buffer.from(writeBrz(moved(gridWorld({ entityless: true }), (i) => (i === 0 ? [0, 0, 0] : FAR))));
const withGrid = Buffer.from(writeBrz(moved(gridWorld(), () => FAR)));

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const settle = async (page: Page): Promise<void> => { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); };
const status = (page: Page) => page.locator('#status');
const count = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as W).__brickTest.ids().length);

async function openBase(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#pick').setInputFiles({ name: 'base.brz', mimeType: 'application/octet-stream', buffer: base });
  await expect(status(page)).toContainText('1 moving grid', { timeout: 30_000 });
  await settle(page);
}
async function pick(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.locator('#pick').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.locator('#importdlg')).toBeVisible();
}
async function savedBrz(page: Page): Promise<FileMap> {
  const dl = page.waitForEvent('download');
  await page.locator('#savebrz').click();
  return readBrz(new Uint8Array(readFileSync((await (await dl).path())!)));
}
const mainZ = (f: FileMap): number[] => extractBricks(f).bricks.map((b) => b.pos[2]).sort((a, b) => a - b);

test('full: replace bricks is one undo step; add at the saved position leaves out overlapping bricks', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openBase(page, '/?test');
  const before = await count(page);

  await pick(page, 'far.brz', far);
  await expect(page.locator('#imp-entities')).toBeDisabled();
  await expect(page.locator('#imp-environment')).toBeEnabled();
  await page.locator('#imp-bricks-mode').selectOption('replace');
  await page.locator('#imp-ok').click();
  await expect(status(page)).toContainText('imported far.brz', { timeout: 30_000 });
  await settle(page);
  expect(await count(page)).toBe(before);
  expect(mainZ(await savedBrz(page))).toEqual(MAIN.map((b) => b.pos[2] + FAR[2]).sort((a, b) => a - b));

  await page.keyboard.press('Control+z'); await settle(page);
  await expect(status(page)).toContainText('Undo: import');
  const undone = await savedBrz(page);
  expect(mainZ(undone)).toEqual(MAIN.map((b) => b.pos[2]).sort((a, b) => a - b));
  expect(readEntities(fileMapView(undone)).entities).toHaveLength(1);

  await pick(page, 'partly.brz', partly);
  await page.locator('#imp-ok').click();
  await expect(status(page)).toContainText('1 overlapping brick left out', { timeout: 30_000 });
  await settle(page);
  expect(await count(page)).toBe(before + MAIN.length - 1);
  expect(extractBricks(await savedBrz(page)).bricks).toHaveLength(2 * MAIN.length - 1);

  await pick(page, 'partly.brz', partly);
  await page.locator('#imp-cancel').click();
  await expect(page.locator('#importdlg')).toHaveCount(0);
  await expect(status(page)).toContainText('Import cancelled');
  expect(errors).toEqual([]);
});

test('full: add as a prefab, turned, with its moving grid', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openBase(page, '/?test');
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; t.setView({ k: 0, baseZoom: t.snapshot().zoom * 6 }); });
  await settle(page);
  const before = await count(page);
  await pick(page, 'grid.brz', withGrid);
  await expect(page.locator('#imp-entities')).toBeChecked();
  await page.locator('#imp-place-prefab').check();
  await page.locator('#imp-ok').click();
  await expect(status(page)).toContainText('Placing grid.brz');
  const at = await page.evaluate(() => (window as unknown as W).__brickTest.project(-6, -6, 0));
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.keyboard.press('r'); await frames(page);
  await page.mouse.move(at[0] + 2, at[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up();
  await expect(status(page)).toContainText('imported grid.brz', { timeout: 30_000 });
  await settle(page);
  expect(await count(page)).toBe(2 * before);
  expect(await page.evaluate(() => (window as unknown as W).__brickTest.grids()?.length)).toBe(2);
  await expect(status(page)).not.toContainText('left out');
  const saved = await savedBrz(page);
  expect(extractBricks(saved).bricks).toHaveLength(2 * MAIN.length);
  expect(readEntities(fileMapView(saved)).entities).toHaveLength(2);

  await page.keyboard.press('Control+z'); await settle(page);
  expect(await count(page)).toBe(before);
  expect(errors).toEqual([]);
});

test('lite: the import dialog adds bricks, and "Open as a new world instead" replaces the save', async ({ page }) => {
  await openBase(page, '/lite.html?test');
  const before = await count(page);
  await pick(page, 'far.brz', far);
  await page.locator('#imp-ok').click();
  await expect(status(page)).toContainText('imported far.brz', { timeout: 30_000 });
  await settle(page);
  expect(await count(page)).toBe(before + MAIN.length);
  await pick(page, 'far.brz', far);
  await page.locator('#imp-new').click();
  await expect(status(page)).toContainText(`far.brz: ${MAIN.length} bricks`, { timeout: 30_000 });
});
