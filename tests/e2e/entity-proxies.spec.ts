// W-11 / W-12: balls and wheels show as simple spheres and cylinders with their colours, and the
// world's base map decides the ground. Uses a synthetic world (tests/unit/gridworld.ts).

import { expect, test } from '@playwright/test';
import { writeNewWorldFile } from '../../src/format/brdb.ts';
import { gridWorld } from '../unit/gridworld.ts';

interface Api {
  settle(): Promise<number>;
  proxies(): { id: number; kind: string; centre: number[]; scale: number; colours: number[][] }[];
  baseMap(): { color: number[]; studs: boolean } | null;
}
type W = { __brickTest: Api };

test.describe.configure({ timeout: 120_000 });

const world = Buffer.from(writeNewWorldFile(gridWorld({ proxies: true })));

for (const [label, path] of [['full', '/?test'], ['lite', '/lite.html?test']] as const) {
  test(`${label}: a wheel and a ball show as proxies with their scale and colours`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(path);
    await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
    await page.locator('#pick').setInputFiles({ name: 'proxies.brdb', mimeType: 'application/octet-stream', buffer: world });
    await page.waitForFunction(() => (window as unknown as W).__brickTest.proxies().length === 2, null, { timeout: 30_000 });
    await page.evaluate(() => (window as unknown as W).__brickTest.settle());
    const list = await page.evaluate(() => (window as unknown as W).__brickTest.proxies());
    expect(list.map((p) => [p.kind, p.scale])).toEqual([['wheel', 1.5], ['sphere', 2]]);
    expect(list[0]!.colours[1]![0]).toBeGreaterThan(list[0]!.colours[1]![1]!);
    const map = await page.evaluate(() => (window as unknown as W).__brickTest.baseMap());
    expect(map === null || map.color.length >= 3).toBe(true);
    expect(errors).toEqual([]);
  });
}
