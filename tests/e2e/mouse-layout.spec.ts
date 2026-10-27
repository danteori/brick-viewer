import { expect, test, type Page } from '@playwright/test';

interface Cam { x: number; y: number; half: number; yaw: number; pitch: number }
interface Api {
  settle(): Promise<number>;
  snapshot(): { bricks: unknown[]; ghost: boolean };
  camera(): Cam;
  openWindow(id: string): void;
  closeWindow(id: string): void;
}
type W = { __brickTest: Api };
type Button = 'left' | 'right' | 'middle';

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
const cam = (page: Page): Promise<Cam> => page.evaluate(() => (window as unknown as W).__brickTest.camera());
const ghost = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as W).__brickTest.snapshot().ghost);

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(() => (window as unknown as W).__brickTest.settle());
  await frames(page);
}

async function dragWith(page: Page, button: Button, from: [number, number], dx: number, dy = 0): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down({ button });
  for (let i = 1; i <= 8; i++) { await page.mouse.move(from[0] + dx * i / 8, from[1] + dy * i / 8); await frames(page, 1); }
  await page.mouse.up({ button });
  await frames(page);
}

async function holdCopy(page: Page): Promise<void> {
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await page.evaluate(() => (window as unknown as W).__brickTest.openWindow('escmenu'));
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.evaluate(() => (window as unknown as W).__brickTest.closeWindow('escmenu'));
  await page.keyboard.press('Control+v');
  await frames(page);
  expect(await ghost(page)).toBe(true);
}

const EMPTY: [number, number] = [120, 420];

test('free camera: right drag orbits, middle drag pans, left drag on empty space orbits', async ({ page }) => {
  await open(page, '/?test&mode=one');
  let c0 = await cam(page);
  await dragWith(page, 'right', EMPTY, 120);
  let c1 = await cam(page);
  expect(Math.abs(c1.yaw - c0.yaw)).toBeGreaterThan(0.2);

  c0 = c1;
  await dragWith(page, 'middle', EMPTY, 120, 40);
  c1 = await cam(page);
  expect(c1.yaw).toBeCloseTo(c0.yaw, 6);
  expect(c1.pitch).toBeCloseTo(c0.pitch, 6);
  expect(Math.hypot(c1.x - c0.x, c1.y - c0.y)).toBeGreaterThan(c0.half * 0.05);

  c0 = c1;
  await dragWith(page, 'left', EMPTY, 120);
  c1 = await cam(page);
  expect(Math.abs(c1.yaw - c0.yaw)).toBeGreaterThan(0.2);
});

test('free camera: a short right-click does not move the camera', async ({ page }) => {
  await open(page, '/?test&mode=one');
  const c0 = await cam(page);
  await page.mouse.move(EMPTY[0], EMPTY[1]);
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await frames(page);
  const c1 = await cam(page);
  expect(c1).toEqual(c0);
});

test('free camera, brick in hand: a right drag orbits and keeps the brick; a short right-click puts it away', async ({ page }) => {
  await open(page, '/?test&mode=one');
  await holdCopy(page);
  const c0 = await cam(page);
  await dragWith(page, 'right', EMPTY, 120);
  expect(Math.abs((await cam(page)).yaw - c0.yaw)).toBeGreaterThan(0.2);
  expect(await ghost(page)).toBe(true);
  await page.mouse.move(EMPTY[0], EMPTY[1]);
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' }); await frames(page);
  expect(await ghost(page)).toBe(false);
});

test('classic camera: a right drag orbits', async ({ page }) => {
  await open(page, '/?test');
  const c0 = await cam(page);
  await dragWith(page, 'right', EMPTY, 120);
  expect(Math.abs((await cam(page)).yaw - c0.yaw)).toBeGreaterThan(0.2);
});
