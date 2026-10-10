// View tools: the underside camera (U-03) and the X-ray cutaway (U-05). Startup brick and synthetic
// saves only, no private data.

import { expect, test, type Page } from '@playwright/test';
import { synthSave } from '../unit/synthsave.ts';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): Box;
  brickBox(k: number): Box;
  snapshot(): { bricks: Box[]; sel: number; status: string };
  loadSave(b64: string, name: string): { bricks: number };
  focus(k: number): void;
}
type W = { __brickTest: Api };

// The CI renders WebGL in software (SwiftShader), where the X-ray house costs up to ~2 s a frame at
// 1280 x 800. These tests check picking and camera maths in CSS pixels, so a half-resolution drawing
// buffer (same layout, a quarter of the pixels to shade) tests the same thing faster.
test.use({ deviceScaleFactor: 0.5 });
test.describe.configure({ timeout: 360_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
async function settle(page: Page): Promise<void> { await page.evaluate(() => (window as unknown as W).__brickTest.settle()); await frames(page); }
const snap = (page: Page): Promise<ReturnType<Api['snapshot']>> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot());
const r3 = (v: number): number => +v.toFixed(3);
const PLATE = 0.08;

/** set a range input the way a user drag does (value + input event) */
const slide = (page: Page, id: string, v: number): Promise<void> => page.evaluate(([id, v]) => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
}, [id, v] as const);

async function click(page: Page, at: P2): Promise<void> {
  await page.mouse.move(at[0], at[1]); await frames(page);
  await page.mouse.down(); await page.mouse.up(); await frames(page);
}

/** drag from the focused brick's bottom face centre by `plates` plate lengths along world Z (screen) */
async function dragBottom(page: Page, plates: number): Promise<void> {
  const [a, b] = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    return [t.project(cx, cy, lo[2]), t.project(cx, cy, lo[2] - 0.08)];
  });
  const v = [(b[0] - a[0]) * plates, (b[1] - a[1]) * plates];
  await page.mouse.move(a[0], a[1]); await frames(page);
  await page.mouse.down(); await frames(page);
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a[0] + v[0] * i / 10, a[1] + v[1] * i / 10); await frames(page, 1); }
  await page.mouse.up(); await frames(page);
}

test('U flips to the iso corner below; the bottom face drags down and up by a plate; undo restores', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#btoggle').click();
  await page.locator('#ptoggle').click();
  await settle(page);
  await page.keyboard.press('u');
  await settle(page);
  await expect(page.locator('#hud')).toContainText('(isometric, from below)');
  await expect(page.locator('#underside')).toHaveAttribute('aria-pressed', 'true');
  const b0 = (await snap(page)).bricks[0];

  await dragBottom(page, 1);                                  // outward from the bottom: one plate down
  await settle(page);
  let b = (await snap(page)).bricks[0];
  expect(r3(b.lo[2])).toBe(r3(b0.lo[2] - PLATE));
  expect(r3(b.hi[2])).toBe(r3(b0.hi[2]));                     // the top (far face from below) stays
  await expect(page.locator('#hud')).toContainText('(isometric, from below)');   // the resize kept the view below

  await page.keyboard.press('Control+z');
  await settle(page);
  b = (await snap(page)).bricks[0];
  expect(r3(b.lo[2])).toBe(r3(b0.lo[2]));

  await dragBottom(page, -1);                                 // inward: one plate up (shrinks)
  await settle(page);
  b = (await snap(page)).bricks[0];
  expect(r3(b.lo[2])).toBe(r3(b0.lo[2] + PLATE));
  expect(r3(b.hi[2])).toBe(r3(b0.hi[2]));
  await page.keyboard.press('Control+z');
  await settle(page);
  expect(r3((await snap(page)).bricks[0].lo[2])).toBe(r3(b0.lo[2]));

  // a resize from above still works from above, and U goes back up
  await page.keyboard.press('u');
  await settle(page);
  await expect(page.locator('#hud')).toContainText('(isometric)');
  await expect(page.locator('#hud')).not.toContainText('from below');
});

// A closed house: the focus block in the middle of the floor (it loads as brick 0), four small
// blocks around it, the floor, four walls (one of glass) and the roof.
const RED: [number, number, number] = [220, 40, 40];
const house = Buffer.from(synthSave([
  { asset: 'PB_DefaultBrick', size: [10, 10, 6], pos: [0, 0, 10], color: RED },
  ...[[-30, -30], [30, -30], [-30, 30], [30, 30]].map(([x, y]) => ({ asset: 'PB_DefaultBrick', size: [5, 5, 6] as [number, number, number], pos: [x!, y!, 10] as [number, number, number], color: [40, 80, 220] as [number, number, number] })),
  { asset: 'PB_DefaultBrick', size: [100, 100, 2], pos: [0, 0, 2], color: [120, 120, 120] },
  { asset: 'PB_DefaultBrick', size: [100, 10, 30], pos: [0, -90, 34], color: [200, 180, 140] },
  { asset: 'PB_DefaultBrick', size: [100, 10, 30], pos: [0, 90, 34], color: [200, 180, 140] },
  { asset: 'PB_DefaultBrick', size: [10, 80, 30], pos: [-90, 0, 34], color: [200, 180, 140] },
  { asset: 'PB_DefaultBrick', size: [10, 80, 30], pos: [90, 0, 34], color: [200, 180, 140], material: 'BMC_Glass', intensity: 0 },
  { asset: 'PB_DefaultBrick', size: [100, 100, 4], pos: [0, 0, 68], color: [90, 60, 50] },
])).toString('base64');

test('X-ray: a click through the hole focuses an interior brick; the hole slider sets its size', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#btoggle').click();
  await page.locator('#ptoggle').click();
  const focus0 = async (): Promise<void> => { await page.evaluate(() => (window as unknown as W).__brickTest.focus(0)); await settle(page); };
  await page.evaluate((b64) => (window as unknown as W).__brickTest.loadSave(b64, 'house.brz'), house);
  await focus0();
  // the interior block farthest from the camera (highest on screen): behind the hole's apex
  const k = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest;
    let best = { k: -1, y: 1e9 };
    for (let k = 0; k < t.snapshot().bricks.length; k++) {
      const { lo, hi } = t.brickBox(k);                      // the load order isn't the save order
      if (k === t.snapshot().sel || Math.abs(hi[0] - lo[0] - 0.2) > 1e-6) continue;   // the small blocks only
      const y = t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2])[1];
      if (y < best.y) best = { k, y };
    }
    return best.k;
  });
  /** brick k's top centre on screen (each focus change can change the zoom) */
  const topOf = (k: number): Promise<P2> => page.evaluate((k) => {
    const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
    return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]);
  }, k);
  const pick = async (): Promise<number> => { await click(page, await topOf(k)); await settle(page); const s = (await snap(page)).sel; await focus0(); return s; };

  expect(k).toBeGreaterThan(0);
  expect(await pick()).not.toBe(k);                           // X-ray off: the roof is in the way
  await page.keyboard.press('x');
  await expect(page.locator('#xray')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#xraybox')).toBeVisible();
  await slide(page, 'xrayspread', 0);                // a straight cylinder: only the hole size counts
  await slide(page, 'xraysize', 100);
  await settle(page);
  expect(await pick()).toBe(k);                               // through the hole to the block inside
  await slide(page, 'xraysize', 0);                  // the hole shrinks to just around the focus
  await settle(page);
  expect(await pick()).not.toBe(k);
  await slide(page, 'xraysize', 100);
  await settle(page);
  expect(await pick()).toBe(k);
  await page.locator('#xray').click();                        // the button toggles it off again
  await expect(page.locator('#xray')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#xraybox')).toBeHidden();
  await settle(page);
  expect(await pick()).not.toBe(k);
  expect(errors).toEqual([]);
});
