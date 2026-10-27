// C-09 and S-22: Save .brz is blocked when an input has two wires, and a save's own picture shows
// while a big save loads in the worker. Synthetic saves only.

import { expect, test, type Page } from '@playwright/test';
import { writeBrz } from '../../src/format/brz.ts';
import { loadWires } from '../../src/scene/wires.ts';
import { save } from '../unit/comp-fixture.ts';
import { inMenu } from './windows.ts';

test.describe.configure({ timeout: 240_000 });

interface Api {
  loadSave(b64: string, name: string): { bricks: number; status: string };
  loadSaveWorker(b64: string, name: string): Promise<{ bricks: number; viaWorker: boolean }>;
  settle(): Promise<number>;
  snapshot(): { status: string };
}
type W = { __brickTest: Api };

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

function fanInSave(): Uint8Array {
  const files = save(), g = loadWires(files);
  const first = g.wires()[0]!;
  const other = g.wires().find((w) => w.source.brick !== first.source.brick || w.source.grid !== first.source.grid)!;
  g.addWire(other.source, first.target, { force: true });
  return writeBrz(g.encode());
}

async function ready(page: Page): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
}

test('Save .brz is blocked while an input has two wires', async ({ page }) => {
  await ready(page);
  await page.evaluate(async (s) => { const t = (window as unknown as W).__brickTest; t.loadSave(s, 'fanin.brz'); await t.settle(); }, b64(fanInSave()));
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await inMenu(page, () => page.locator('#savebrz').click());
  await expect.poll(async () => (await page.evaluate(() => (window as unknown as W).__brickTest.snapshot())).status).toContain('save blocked');
  expect(downloaded).toBe(false);
});

test('The save picture shows while the worker loads, then goes', async ({ page }) => {
  const files = save();
  files.set('Meta/Screenshot.jpg', Uint8Array.of(0xff, 0xd8, 0xff, 0xd9));
  await ready(page);
  await page.evaluate(() => {
    const seen = { shown: false };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    new MutationObserver(() => { if (document.getElementById('loadpreview')) seen.shown = true; }).observe(document.body, { childList: true, subtree: true });
  });
  const r = await page.evaluate(async (s) => (window as unknown as W).__brickTest.loadSaveWorker(s, 'pic.brz'), b64(writeBrz(files)));
  expect(r.viaWorker).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __seen: { shown: boolean } }).__seen.shown)).toBe(true);
  await expect(page.locator('#loadpreview')).toHaveCount(0);
});
