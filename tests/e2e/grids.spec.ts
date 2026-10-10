// W-03 / W-04: a world's moving grid is selected by clicking one of its bricks, dragged with the
// Move tool and turned with R (one undo step each); new grids are made from a selection, bricks
// move between grids and a grid's place is typed in Brick Properties > Grid; the saved world and
// .brz carry it all. Uses a synthetic world (tests/unit/gridworld.ts), no private data.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeNewWorldFile } from '../../src/format/brdb.ts';
import { LazyBrdbWorld } from '../../src/format/brdblazy.ts';
import { readBrz, type FileMap } from '../../src/format/brz.ts';
import { bytesSource } from '../../src/format/sqlitelazy.ts';
import { flattenTree } from '../../src/format/stale.ts';
import { readEntities } from '../../src/format/entities.ts';
import { fileMapView } from '../../src/format/saveview.ts';
import { extractBricks } from '../../src/format/world.ts';
import { gridWorld } from '../unit/gridworld.ts';

type P2 = [number, number];
interface Grid { id: number; origin: number[]; frac: number[]; quat: number[]; ids: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): { lo: number[]; hi: number[] };
  byId(): [number, number[], number[], number[]][];
  selection(): number[];
  ids(): number[];
  grids(): Grid[] | null;
  snapshot(): { zoom: number };
  setView(a: { k: number; zoom?: number; baseZoom: number }): void;
  focus(k: number): void;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 150_000 });

const world = Buffer.from(writeNewWorldFile(gridWorld()));
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const grids = (page: Page): Promise<Grid[]> => page.evaluate(() => (window as unknown as W).__brickTest.grids() ?? []);
const status = (page: Page) => page.locator('#status');
/** a point on the top face of row `id` on screen (fx, fy: fractions across it; default its centre) */
const topOf = (page: Page, id: number, fx = 0.5, fy = 0.5): Promise<P2> => page.evaluate(([id, fx, fy]) => {
  const t = (window as unknown as W).__brickTest, r = t.byId().find((x) => x[0] === id)!;
  return t.project(r[1][0]! + (r[2][0]! - r[1][0]!) * fx, r[1][1]! + (r[2][1]! - r[1][1]!) * fy, r[2][2]!);
}, [id, fx, fy] as const);
/** screen point on the focused brick's box, by fractions of its size */
const onFocus = (page: Page, f: [number, number, number]): Promise<P2> => page.evaluate((f) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox(), p = f.map((v, i) => lo[i]! + (hi[i]! - lo[i]!) * v);
  return t.project(p[0]!, p[1]!, p[2]!);
}, f);
async function click(page: Page, at: P2, mod?: string): Promise<void> {
  await page.mouse.move(at[0], at[1]); await frames(page);
  if (mod) await page.keyboard.down(mod);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
  if (mod) await page.keyboard.up(mod);
  await settle(page);
}
async function open(page: Page, path: string, zoomOut = true): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#pick').setInputFiles({ name: 'grids.brdb', mimeType: 'application/octet-stream', buffer: world });
  await expect(status(page)).toContainText('1 moving grid', { timeout: 30_000 });
  await settle(page);
  if (!zoomOut) return;
  // zoom out so the grid (parked 100 studs away) is on screen, clear of the panels
  await page.evaluate(() => { const t = (window as unknown as W).__brickTest; t.setView({ k: 0, baseZoom: t.snapshot().zoom * 1.6 }); });
  await settle(page);
}
async function flatWorld(bytes: Uint8Array): Promise<FileMap> {
  const w = await LazyBrdbWorld.open(bytesSource(bytes)), t = w.tree();
  await t.loadWritten(t.paths().filter((p) => p.endsWith('.mps')));
  await t.load(t.paths());
  return flattenTree(t).files;
}
const qdot = (a: number[], b: number[]): number => Math.abs(a.reduce((s, v, i) => s + v * b[i]!, 0));

for (const [label, path] of [['full', '/?test'], ['lite', '/lite.html?test']] as const) {
  test(`${label}: click selects a moving grid; Move drags it, R turns it, undo / redo; the saved world has its new place`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await open(page, path);
    const g0 = (await grids(page))[0]!;
    expect(g0).toMatchObject({ id: 2, origin: [500, -300, 30] });
    expect(g0.ids).toHaveLength(2);
    await click(page, await topOf(page, g0.ids[0]!));
    expect(await page.evaluate(() => (window as unknown as W).__brickTest.selection().length)).toBe(2);
    await expect(status(page)).toContainText('Grid 2 selected');
    await expect(page.locator('#hud')).toContainText('grid 2 selected');
    const before = await page.evaluate(() => (window as unknown as W).__brickTest.byId().map((r) => r[1]));

    // Move tool: grab the focused brick's +X face and pull along +X
    await page.keyboard.press('2');
    const a = await onFocus(page, [1, 0.5, 0.5]), b = await onFocus(page, [3, 0.5, 0.5]);
    await page.mouse.move(a[0], a[1]); await frames(page);
    await page.mouse.down(); await page.mouse.move(b[0], b[1], { steps: 14 }); await frames(page);
    await page.mouse.up(); await settle(page);
    const g1 = (await grids(page))[0]!, dx = g1.origin[0]! - 500;
    expect(dx).toBeGreaterThan(0);
    expect(dx % 10).toBe(0);                                            // whole studs
    expect(g1.origin.slice(1)).toEqual([-300, 30]);
    const after = await page.evaluate(() => (window as unknown as W).__brickTest.byId().map((r) => [r[0], r[1]] as const));
    const moved = after.filter(([id]) => g0.ids.includes(id));
    for (const [id, lo] of moved) {
      const was = before[after.findIndex((r) => r[0] === id)]!;
      expect(+(lo[0]! - was[0]!).toFixed(3)).toBe(+(dx * 0.02).toFixed(3))   // 0.02 viewer units a unit;
    }

    // R: a quarter turn about Z
    await page.keyboard.press('r'); await settle(page);
    const g2 = (await grids(page))[0]!;
    expect(qdot(g2.quat, [0, 0, 1, 0])).toBeCloseTo(1, 5);              // 90 (loaded) + 90 degrees
    expect(g2.origin).toEqual(g1.origin);

    // undo: the turn, then the move; redo both
    await page.keyboard.press('Control+z'); await settle(page);
    expect(qdot((await grids(page))[0]!.quat, [0, 0, Math.SQRT1_2, Math.SQRT1_2])).toBeCloseTo(1, 5);
    await page.keyboard.press('Control+z'); await settle(page);
    expect((await grids(page))[0]!.origin).toEqual([500, -300, 30]);
    expect(await page.evaluate(() => (window as unknown as W).__brickTest.byId().map((r) => r[1]))).toEqual(before);
    await page.keyboard.press('Control+y'); await page.keyboard.press('Control+y'); await settle(page);
    expect((await grids(page))[0]).toMatchObject({ origin: g2.origin, quat: g2.quat });

    // the saved world: the entity is where the grid now is
    const dl = page.waitForEvent('download');
    await page.locator('#savebrdb').click();
    const files = await flatWorld(new Uint8Array(readFileSync((await (await dl).path())!)));
    const e = readEntities(fileMapView(files)).byIndex.get(2)!;
    expect(e.location[0]).toBeCloseTo(g2.origin[0]! + g2.frac[0]!, 3);
    expect(e.location[1]).toBeCloseTo(g2.origin[1]! + g2.frac[1]!, 3);
    expect(qdot(e.rotation, [0, 0, 1, 0])).toBeCloseTo(1, 5);
    await page.keyboard.press('1');
    expect(errors).toEqual([]);
  });
}

test('full: New grid from a selection, Move to grid and a typed place, saved in a .brz', async ({ page }) => {
  await open(page, '/?test', false);
  const main = await page.evaluate(() => { const t = (window as unknown as W).__brickTest, g = new Set(t.grids()!.flatMap((x) => x.ids)); return t.ids().filter((id) => !g.has(id)); });
  expect(main).toHaveLength(3);
  // focus main-grid brick 0, Shift+click brick 1: a selection of two
  await click(page, await topOf(page, main[0]!));
  await click(page, await topOf(page, main[1]!, 0.85, 0.3), 'Shift');   // clear of the focused brick's size labels
  expect(await page.evaluate(() => (window as unknown as W).__brickTest.selection().length)).toBe(2);
  await page.locator('#gridtoggle').click();
  await expect(page.locator('#gridbody')).toBeVisible();
  await page.locator('#gridbody button[data-grid="new"]').click(); await settle(page);
  let gs = await grids(page);
  expect(gs.map((g) => g.id)).toEqual([2, 3]);
  expect(gs[1]!.ids.sort()).toEqual(main.slice(0, 2).sort());
  await expect(status(page)).toContainText('New grid 3');
  await expect(page.locator('#gridname')).toContainText('grid 3');
  // type its place: 100 units further along X, turned 90 degrees
  const loc = gs[1]!.origin;
  await page.locator('#gridxf input[data-xf="0"]').fill(String(loc[0]! + 100));
  await page.locator('#gridxf input[data-xf="3"]').fill('90');
  await page.locator('#gridxf input[data-xf="3"]').press('Enter'); await settle(page);
  gs = await grids(page);
  expect(gs[1]!.origin).toEqual([loc[0]! + 100, loc[1], loc[2]]);
  expect(qdot(gs[1]!.quat, [0, 0, Math.SQRT1_2, Math.SQRT1_2])).toBeCloseTo(1, 5);
  // the third main-grid brick into grid 2
  await page.locator('#gridxf input[data-xf="3"]').blur();
  await page.keyboard.press('Escape');                                   // clears the selection (grid 3)
  expect(await page.evaluate(() => (window as unknown as W).__brickTest.selection().length)).toBe(0);
  await page.evaluate((id) => { const t = (window as unknown as W).__brickTest; t.focus(t.ids().indexOf(id)); }, main[2]!);   // (the turned grid 3 now covers it on screen)
  await settle(page);
  await page.locator('#gridto').selectOption('2');
  await page.locator('#gridbody button[data-grid="to"]').click(); await settle(page);
  gs = await grids(page);
  expect(gs[0]!.ids).toContain(main[2]);
  await expect(status(page)).toContainText('into grid 2');
  // Save .brz: three grids' worth of bricks where they are, two entities
  const dl = page.waitForEvent('download');
  await page.locator('#savebrz').click();
  const files = readBrz(new Uint8Array(readFileSync((await (await dl).path())!)));
  const t = readEntities(fileMapView(files));
  expect(t.entities.map((e) => e.persistentIndex).sort()).toEqual([2, 3]);
  expect(t.byIndex.get(3)!.location).toEqual([loc[0]! + 100, loc[1], loc[2]]);
  expect(t.byIndex.get(3)!.physicsLocked).toBe(true);
  expect(extractBricks(files, { grid: '3' }).bricks).toHaveLength(2);
  expect(extractBricks(files, { grid: '2' }).bricks).toHaveLength(3);
  expect(extractBricks(files).bricks).toHaveLength(0);
});
