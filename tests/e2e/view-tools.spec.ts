// View tools: the resize camera glide (U-32) and the X-ray cutaway (U-05). Startup brick and synthetic
// saves only, no private data.

import { expect, test, type Page } from '@playwright/test';
import { synthSave } from '../unit/synthsave.ts';
import { inMenu } from './windows.ts';

type P2 = [number, number];
interface Box { lo: number[]; hi: number[] }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): Box;
  brickBox(k: number): Box;
  snapshot(): { bricks: Box[]; sel: number; status: string; zoom: number };
  setView(a: { k: number; pitchDeg?: number; zoom?: number; baseZoom: number }): void;
  camera(): { x: number; y: number; half: number; yaw: number; pitch: number };
  loadSave(b64: string, name: string): { bricks: number };
  focus(k: number): void;
  autoXray(on: boolean): void;
  xray(): { on: boolean; size: number; keep: number; mode: string; room: boolean };
  xrayMode(mode: string): void;
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

const DEG = Math.PI / 180, YAW0 = -Math.PI / 4, ELEV = Math.atan(1 / Math.SQRT2);
const camera = (page: Page): Promise<ReturnType<Api['camera']>> => page.evaluate(() => (window as unknown as W).__brickTest.camera());
const setPitch = (page: Page, pitchDeg: number): Promise<void> => page.evaluate((p) => {
  const t = (window as unknown as W).__brickTest; t.setView({ k: 0, pitchDeg: p, baseZoom: t.snapshot().zoom });
}, pitchDeg);

/** screen point of the focused brick's face centre on axis Z: the bottom (lo) or the top (hi), and one plate further out */
const zFace = (page: Page, top: boolean): Promise<[P2, P2]> => page.evaluate((top) => {
  const t = (window as unknown as W).__brickTest, { lo, hi } = t.focusBox();
  const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, z = top ? hi[2] : lo[2];
  return [t.project(cx, cy, z), t.project(cx, cy, z + (top ? 0.08 : -0.08))];
}, top);

/** press on the Z face, let the iso glide finish, then drag `plates` plate lengths outward along Z in the iso view */
async function pressAndDragZ(page: Page, top: boolean, plates: number): Promise<P2> {
  const [a] = await zFace(page, top);
  await page.mouse.move(a[0], a[1]); await frames(page);
  await page.mouse.down(); await settle(page);
  const [p, q] = await zFace(page, top), v = [(q[0] - p[0]) * plates, (q[1] - p[1]) * plates];
  for (let i = 1; i <= 10; i++) { await page.mouse.move(a[0] + v[0] * i / 10, a[1] + v[1] * i / 10); await frames(page, 1); }
  return [a[0] + v[0], a[1] + v[1]];
}

test('a resize from below the horizon glides to the iso corner below and back; U and #underside are gone', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#ptoggle').click();
  await setPitch(page, -20);
  await settle(page);
  await expect(page.locator('#underside')).toHaveCount(0);
  await page.keyboard.press('u');
  await settle(page);
  expect((await camera(page)).pitch).toBeCloseTo(-20 * DEG, 6);
  const b0 = (await snap(page)).bricks[0];

  await pressAndDragZ(page, false, 1);
  await expect(page.locator('#hud')).toContainText('(isometric, from below)');
  const mid = await camera(page);
  expect(mid.pitch).toBeCloseTo(-ELEV, 6); expect(mid.yaw).toBeCloseTo(YAW0, 6);
  await page.mouse.up(); await settle(page);
  const b = (await snap(page)).bricks[0];
  expect(r3(b.lo[2])).toBe(r3(b0.lo[2] - PLATE));
  expect(r3(b.hi[2])).toBe(r3(b0.hi[2]));
  const end = await camera(page);
  expect(end.pitch).toBeCloseTo(-20 * DEG, 6); expect(end.yaw).toBeCloseTo(YAW0, 6);

  await page.keyboard.press('Control+z');
  await settle(page);
  expect(r3((await snap(page)).bricks[0].lo[2])).toBe(r3(b0.lo[2]));
});

test('a resize from above glides to the iso corner above; an orbit during it keeps the user view at the end', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#ptoggle').click();
  await setPitch(page, 55);
  await settle(page);
  const b0 = (await snap(page)).bricks[0];

  const at = await pressAndDragZ(page, true, 0);
  await expect(page.locator('#hud')).toContainText('(isometric)');
  await expect(page.locator('#hud')).not.toContainText('from below');
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 10; i++) { await page.mouse.move(at[0] + 6 * i, at[1]); await frames(page, 1); }
  await page.mouse.up({ button: 'right' });
  await page.mouse.up(); await settle(page);
  const end = await camera(page);
  expect(end.yaw).toBeCloseTo(YAW0 + 54 * 0.008, 4);
  expect(end.pitch).toBeCloseTo(ELEV, 2);
  expect(r3((await snap(page)).bricks[0].hi[2])).toBe(r3(b0.hi[2]));
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
  await slide(page, 'xraykeep', 3);                  // the old default: the house's roof is inside the 5-brick default
  await settle(page);
  expect(await pick()).toBe(k);                               // the roof in the way is hidden: through to the block inside
  await slide(page, 'xraysize', 0);                  // the narrowest tube still hides the roof (one brick over the focus)
  await settle(page);
  expect(await pick()).toBe(k);
  await slide(page, 'xraysize', 100);
  await settle(page);
  expect(await pick()).toBe(k);
  // the dead zone: the block nearest the camera stands beside the focus at its height, inside the
  // hole's circle; it isn't between the focus and the camera, so it stays whole and clickable
  const near = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest;
    let best = { k: -1, y: -1e9 };
    for (let k = 0; k < t.snapshot().bricks.length; k++) {
      const { lo, hi } = t.brickBox(k);
      if (k === t.snapshot().sel || Math.abs(hi[0] - lo[0] - 0.2) > 1e-6) continue;
      const y = t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2])[1];
      if (y > best.y) best = { k, y };
    }
    return best.k;
  });
  const pickTop = async (j: number): Promise<number> => {
    const p = await page.evaluate((j) => {
      const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(j);
      return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]);
    }, j);
    await click(page, p); await settle(page); const s = (await snap(page)).sel; await focus0(); return s;
  };
  expect(await pickTop(near)).toBe(near);
  await slide(page, 'xraykeep', 0);                  // even with no dead zone, bricks at the focus's height stay
  await settle(page);
  expect(await pickTop(near)).toBe(near);
  expect(await pick()).toBe(k);
  await inMenu(page, () => page.locator('#xray').click());   // the button toggles it off again
  await expect(page.locator('#xray')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#xraybox')).toBeHidden();
  await settle(page);
  expect(await pick()).not.toBe(k);
  expect(errors).toEqual([]);
});

test('auto X-ray (U-33): a covered focus turns it on with a fitted Keep; hand edits stay; a focus in the clear turns it off', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(() => (window as unknown as W).__brickTest.autoXray(true));
  await page.evaluate((b64) => (window as unknown as W).__brickTest.loadSave(b64, 'house.brz'), house);
  const xray = (): Promise<ReturnType<Api['xray']>> => page.evaluate(() => (window as unknown as W).__brickTest.xray());
  const focusIndex = (pick: 'block' | 'roof'): Promise<number> => page.evaluate((pick) => {
    const t = (window as unknown as W).__brickTest, n = t.snapshot().bricks.length;
    let best = { k: -1, z: -1e9 };
    for (let k = 0; k < n; k++) {
      const { lo, hi } = t.brickBox(k);
      if (pick === 'roof' && lo[2] > best.z) best = { k, z: lo[2] };
      if (pick === 'block' && k !== t.snapshot().sel && Math.abs(hi[0] - lo[0] - 0.2) < 1e-6) return k;
    }
    return best.k;
  }, pick);
  const focus = async (k: number): Promise<void> => { await page.evaluate((k) => (window as unknown as W).__brickTest.focus(k), k); await settle(page); };

  await focus(0);
  let x = await xray();
  expect(x.on).toBe(true);
  expect(x.keep).toBeGreaterThanOrEqual(3 * 3 * PLATE - 1e-6);
  expect(x.keep).toBeLessThanOrEqual(4 * 3 * PLATE + 1e-6);
  await expect(page.locator('#xraybox')).toBeVisible();
  await slide(page, 'xraysize', 90);
  await slide(page, 'xraykeep', 1);
  await focus(await focusIndex('block'));
  x = await xray();
  expect(x.on).toBe(true);
  expect(x.size).toBeCloseTo(0.72);
  expect(x.keep).toBeCloseTo(3 * PLATE);
  await focus(await focusIndex('roof'));
  x = await xray();
  expect(x).toMatchObject({ on: false, size: 0.2, keep: 15 * PLATE });
  await expect(page.locator('#xraybox')).toBeHidden();
  await expect(page.locator('#xray')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('free camera: a middle drag pans during a resize and keeps the angle (U-37)', async ({ page }) => {
  await page.goto('/?test&mode=one');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await settle(page);
  const b0 = (await snap(page)).bricks[0];
  const [a] = await zFace(page, true);
  await page.mouse.move(a[0], a[1]); await frames(page);
  await page.mouse.down(); await frames(page, 4);
  const before = await camera(page);
  await page.mouse.move(a[0], a[1] - 40, { steps: 4 }); await frames(page, 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(a[0] + 90, a[1] - 40, { steps: 10 }); await frames(page, 3);
  await page.mouse.up({ button: 'middle' });
  const after = await camera(page);
  expect(after.yaw).toBeCloseTo(before.yaw, 6);
  expect(after.pitch).toBeCloseTo(before.pitch, 6);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0.01);
  await page.mouse.up(); await settle(page);
  expect((await snap(page)).bricks.length).toBe(1);
  expect(b0).toBeTruthy();

test('X-ray modes (U-39): height slice, room and see-through let a click reach the block inside; the panel shows only the sliders each mode uses', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.locator('#ptoggle').click();
  const focus0 = async (): Promise<void> => { await page.evaluate(() => (window as unknown as W).__brickTest.focus(0)); await settle(page); };
  await page.evaluate((b64) => (window as unknown as W).__brickTest.loadSave(b64, 'house.brz'), house);
  await focus0();
  const k = await page.evaluate(() => {
    const t = (window as unknown as W).__brickTest;
    let best = { k: -1, y: 1e9 };
    for (let k = 0; k < t.snapshot().bricks.length; k++) {
      const { lo, hi } = t.brickBox(k);
      if (k === t.snapshot().sel || Math.abs(hi[0] - lo[0] - 0.2) > 1e-6) continue;
      const y = t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2])[1];
      if (y < best.y) best = { k, y };
    }
    return best.k;
  });
  const pick = async (): Promise<number> => {
    const p = await page.evaluate((k) => {
      const t = (window as unknown as W).__brickTest, { lo, hi } = t.brickBox(k);
      return t.project((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, hi[2]);
    }, k);
    await click(page, p); await settle(page); const s = (await snap(page)).sel; await focus0(); return s;
  };
  const mode = async (m: string): Promise<void> => { await page.locator(`#xraymodes button[data-xmode="${m}"]`).click(); await settle(page); };

  await page.keyboard.press('x');
  await expect(page.locator('#xraybox')).toBeVisible();
  await expect(page.locator('#xraymodes button')).toHaveCount(4);
  await expect(page.locator('#xraymodes button[data-xmode="tube"]')).toHaveAttribute('aria-pressed', 'true');

  await mode('slice');
  await expect(page.locator('#xraysizerow')).toBeHidden();
  await expect(page.locator('#xraykeeprow')).toBeVisible();
  await slide(page, 'xraykeep', 0);
  await settle(page);
  expect(await pick()).toBe(k);

  await mode('room');
  await expect(page.locator('#xraykeeprow')).toBeHidden();
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as W).__brickTest.xray())).room).toBe(true);
  expect(await pick()).toBe(k);

  await mode('ghost');
  await expect(page.locator('#xraysizerow')).toBeVisible();
  await slide(page, 'xraysize', 20);
  await slide(page, 'xraykeep', 3);
  await settle(page);
  expect(await pick()).toBe(k);

  await mode('tube');
  await settle(page);
  expect(await pick()).toBe(k);
  expect(errors).toEqual([]);
});
