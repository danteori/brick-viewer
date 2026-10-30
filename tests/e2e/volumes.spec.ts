// W-13 / C-08: the Zones and Lights toggles draw translucent zone boxes and light glows from the
// components of the synthetic component save, with two of its component types renamed.

import { expect, test, type Page } from '@playwright/test';
import { writeBrz } from '../../src/format/brz.ts';
import { decodeMps, encodeMps, parseSchema } from '../../src/format/schema.ts';
import { save } from '../unit/comp-fixture.ts';
import { inMenu } from './windows.ts';

test.describe.configure({ timeout: 240_000 });

interface Volumes { zones: boolean; lights: boolean; drawn: { zones: number; water: number; point: number; spot: number } }
interface Api {
  loadSave(b64: string, name: string): { bricks: number; status: string };
  settle(): Promise<number>;
  volumes(): Volumes;
  setVolumes(zones: boolean, lights: boolean): void;
}
type W = { __brickTest: Api };

function fixture(): string {
  const files = save();
  const path = 'World/0/GlobalData.mps', schema = parseSchema(files.get('World/0/GlobalData.schema')!);
  const g = decodeMps<Record<string, unknown>>(files.get(path)!, schema);
  const rename: Record<string, string> = { Test_Switch: 'Component_Internal_AttachedZone', Test_Light: 'Component_PointLight' };
  g.ComponentTypeNames = (g.ComponentTypeNames as string[]).map((n) => rename[n] ?? n);
  files.set(path, encodeMps(g, schema));
  return Buffer.from(writeBrz(files)).toString('base64');
}
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const volumes = (page: Page): Promise<Volumes> => page.evaluate(() => (window as unknown as W).__brickTest.volumes());

test('Zones and Lights: off by default; the buttons draw one zone box and one glow; off clears them', async ({ page }) => {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(async (b64) => { const t = (window as unknown as W).__brickTest; t.loadSave(b64, 'volumes.brz'); await t.settle(); }, fixture());
  await frames(page);
  expect(await volumes(page)).toMatchObject({ zones: false, lights: false });
  await expect(page.locator('#volumes .zone')).toHaveCount(0);
  await page.mouse.move(640, 790);
  await inMenu(page, () => page.locator('#zonesbtn').click());
  await expect(page.locator('#zonesbtn')).toHaveText('Zones: on');
  await expect.poll(async () => (await volumes(page)).drawn.zones).toBe(1);
  await expect(page.locator('#volumes .zone polygon')).toHaveCount(6);
  await expect(page.locator('#volumes .glow')).toHaveCount(0);
  await inMenu(page, () => page.locator('#lightsbtn').click());
  await expect.poll(async () => (await volumes(page)).drawn.point).toBe(1);
  await expect(page.locator('#volumes .glow.point')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as W).__brickTest.setVolumes(false, false));
  await expect(page.locator('#volumes > *')).toHaveCount(0);
});
