import { expect, test, type Page } from '@playwright/test';

interface Cam { x: number; y: number; half: number; yaw: number; pitch: number }
interface PerspState { on: boolean; fly: boolean; follow: boolean; eye: number[]; anchor: number[]; dist: number; effDist: number }
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): [number, number];
  focusBox(): { lo: number[]; hi: number[] };
  camera(): Cam;
  persp(): PerspState;
  mode(): string;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);
const persp = (page: Page): Promise<PerspState> => page.evaluate(() => (window as unknown as W).__brickTest.persp());
const cam = (page: Page): Promise<Cam> => page.evaluate(() => (window as unknown as W).__brickTest.camera());
const focusBox = (page: Page): Promise<{ lo: number[]; hi: number[] }> => page.evaluate(() => (window as unknown as W).__brickTest.focusBox());

async function open(page: Page): Promise<void> {
  await page.goto('/?test&mode=one');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(() => (window as unknown as W).__brickTest.settle());
  await frames(page);
}

test('V switches to the perspective camera and back; the ortho view returns framed on the same point', async ({ page }) => {
  await open(page);
  const before = await cam(page);
  expect((await persp(page)).on).toBe(false);
  await page.keyboard.press('v');
  await frames(page, 4);
  const p = await persp(page);
  expect(p.on).toBe(true);
  expect(p.follow).toBe(true);
  await expect(page.locator('#persp')).toHaveAttribute('aria-pressed', 'true');
  const box = await focusBox(page);
  const centre = [0, 1, 2].map((i) => (box.lo[i]! + box.hi[i]!) / 2);
  const at = await page.evaluate(([x, y, z]) => (window as unknown as W).__brickTest.project(x!, y!, z!), centre);
  const vp = page.viewportSize()!;
  expect(Math.abs(at[0] - vp.width / 2)).toBeLessThan(vp.width * 0.2);
  expect(Math.abs(at[1] - vp.height / 2)).toBeLessThan(vp.height * 0.2);
  await page.keyboard.press('v');
  await frames(page, 4);
  expect((await persp(page)).on).toBe(false);
  const after = await cam(page);
  expect(after.yaw).toBeCloseTo(before.yaw, 6);
  expect(after.half).toBeGreaterThan(before.half * 0.5);
  expect(after.half).toBeLessThan(before.half * 2);
});

test('the wheel changes the boom length; the camera never enters the focused brick', async ({ page }) => {
  await open(page);
  await page.keyboard.press('v');
  await frames(page, 3);
  const start = await persp(page);
  await page.mouse.move(640, 400);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -200);
  await frames(page, 5);
  const near = await persp(page);
  expect(near.dist).toBeLessThan(start.dist);
  const box = await focusBox(page);
  const inside = near.eye.every((v, i) => v > box.lo[i]! && v < box.hi[i]!);
  expect(inside).toBe(false);
});

test('fly mode stops at a brick: the player-sized body never overlaps it', async ({ page }) => {
  await open(page);
  await page.keyboard.press('v');
  await page.keyboard.press('f');
  await frames(page, 3);
  expect((await persp(page)).fly).toBe(true);
  const box = await focusBox(page);
  await page.keyboard.down('w');
  await page.waitForTimeout(3000);
  await page.keyboard.up('w');
  await frames(page, 3);
  const p = await persp(page);
  const hw = 0.23;
  const overlap = p.eye[0]! + hw > box.lo[0]! && p.eye[0]! - hw < box.hi[0]! && p.eye[1]! + hw > box.lo[1]! && p.eye[1]! - hw < box.hi[1]!
    && p.eye[2]! + 0.08 > box.lo[2]! && p.eye[2]! - 0.88 < box.hi[2]!;
  expect(overlap).toBe(false);
});
