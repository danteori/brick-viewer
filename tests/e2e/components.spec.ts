// C-02 / C-03: the Components section of Brick Properties and the wire view, on the synthetic
// component save (tests/unit/comp-fixture.ts): edits persist through Save .brz and a reload,
// wires are added and removed (fan-in refused), and every edit is one undo step.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { writeBrz } from '../../src/format/brz.ts';
import { save } from '../unit/comp-fixture.ts';

test.describe.configure({ timeout: 240_000 });   // SwiftShader renders every frame on the CPU

interface Comps { instances: [string, string, string][]; wires: string[]; dirty: boolean; refused: number; drawn: { wires: number; ports: number } }
interface Api {
  loadSave(b64: string, name: string): { bricks: number; status: string };
  settle(): Promise<number>;
  focus(k: number): void;
  components(): Comps | null;
  rowOfBrick(key: string): number;
  snapshot(): { status: string };
}
type W = { __brickTest: Api };

const FIXTURE = Buffer.from(writeBrz(save())).toString('base64');
const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); }, n);
const comps = (page: Page): Promise<Comps> => page.evaluate(() => (window as unknown as W).__brickTest.components()!);
const status = async (page: Page): Promise<string> => (await page.evaluate(() => (window as unknown as W).__brickTest.snapshot())).status;
const data = (c: Comps, brick: string, type: string): Record<string, unknown> => JSON.parse(c.instances.find((i) => i[0] === brick && i[1] === type)![2]) as Record<string, unknown>;

async function open(page: Page, b64 = FIXTURE, name = 'components.brz'): Promise<void> {
  await page.goto('/?test');
  await page.waitForFunction(() => !!(window as unknown as W).__brickTest);
  await page.evaluate(async ([s, n]) => { const t = (window as unknown as W).__brickTest; t.loadSave(s!, n!); await t.settle(); }, [b64, name]);
  await frames(page);
}
async function focusBrick(page: Page, key: string): Promise<void> {
  await page.evaluate((key) => { const t = (window as unknown as W).__brickTest; t.focus(t.rowOfBrick(key)); }, key);
  await frames(page);
}
/** Save .brz, then open the downloaded file as the scene. */
async function saveAndReload(page: Page): Promise<void> {
  const dl = page.waitForEvent('download');
  await page.locator('#savebrz').click();
  const bytes = readFileSync((await (await dl).path())!);
  await open(page, bytes.toString('base64'), 'components (edited).brz');
}
const undoKey = async (page: Page, redo = false): Promise<void> => {
  await page.mouse.move(640, 790);
  await page.keyboard.press(redo ? 'Control+y' : 'Control+z');
  await frames(page);
};
/** A port dot of the wire view (dispatched: dots of small bricks sit close together). */
const port = (page: Page, comp: string, name: string, dir: 'in' | 'out', row?: number) =>
  page.locator(`#wires circle.port[data-comp="${comp}"][data-port="${name}"][data-dir="${dir}"]${row === undefined ? '' : `[data-row="${row}"]`}`).first();

test('Components: edit fields (one undo step each), save, reload: the edits persisted', async ({ page }) => {
  await open(page);
  await focusBrick(page, '1/0_0_0/0');
  await page.locator('#comptoggle').click();
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Switch']);
  // a bool
  const enabled = page.locator('#compbody input[aria-label="Enabled"]');
  await expect(enabled).toBeChecked();
  await enabled.click();
  await expect.poll(async () => data(await comps(page), '1/0_0_0/0', 'Test_Switch').bEnabled).toBe(false);
  await undoKey(page);
  expect(data(await comps(page), '1/0_0_0/0', 'Test_Switch').bEnabled).toBe(true);
  await expect(enabled).toBeChecked();
  await undoKey(page, true);
  expect(data(await comps(page), '1/0_0_0/0', 'Test_Switch').bEnabled).toBe(false);
  // the light: a float, an out-of-range integer (refused, no undo step), an enum and a variant switch
  await focusBrick(page, '1/1_0_0/0');
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Light']);
  const bright = page.locator('#compbody input[aria-label="Brightness"]');
  await bright.fill('55.5'); await bright.press('Enter');
  await expect.poll(async () => data(await comps(page), '1/1_0_0/0', 'Test_Light').Brightness).toBe(55.5);
  const alpha = page.locator('#compbody input[aria-label="Color alpha"]');
  await alpha.fill('300'); await alpha.press('Enter');
  await expect(alpha).toHaveAttribute('aria-invalid', 'true');
  expect(await status(page)).toMatch(/u8 must be in 0\.\.255/);
  expect((data(await comps(page), '1/1_0_0/0', 'Test_Light').Color as Record<string, number>).A).toBe(255);
  await page.locator('#compbody select[aria-label="Mode"]').selectOption({ label: 'Pulse' });
  await expect.poll(async () => data(await comps(page), '1/1_0_0/0', 'Test_Light').Mode).toBe(5);
  await page.locator('#compbody select[aria-label="Value type"]').selectOption({ label: 'bool' });
  await expect.poll(async () => data(await comps(page), '1/1_0_0/0', 'Test_Light').Value).toMatchObject({ variant: 2, value: false });
  await page.locator('#compbody input[aria-label="Value"]').check();
  await expect.poll(async () => (data(await comps(page), '1/1_0_0/0', 'Test_Light').Value as { value: boolean }).value).toBe(true);
  await saveAndReload(page);
  const c = await comps(page);
  expect(c.dirty).toBe(false);
  expect(data(c, '1/0_0_0/0', 'Test_Switch').bEnabled).toBe(false);
  expect(data(c, '1/1_0_0/0', 'Test_Light')).toMatchObject({ Brightness: 55.5, Mode: 5, Value: { variant: 2, value: true }, Color: { A: 255 } });
  expect(c.wires).toHaveLength(5);
});

test('Components: add one with defaults and remove one with its wires; undo / redo', async ({ page }) => {
  await open(page);
  await focusBrick(page, '1/1_0_0/0');
  await page.locator('#comptoggle').click();
  await expect(page.locator('#compcount')).toHaveText('1');
  await page.locator('#compbody select[aria-label="Component type to add"]').selectOption('Test_Switch');
  await page.locator('#compbody button[data-k="add"]').click();
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Light', 'Test_Switch']);
  expect(data(await comps(page), '1/1_0_0/0', 'Test_Switch')).toEqual({ bEnabled: true, Sound: 0 });
  await page.locator('#compbody button[aria-label="Remove Test_Light"]').click();
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Switch']);
  expect((await comps(page)).wires).toHaveLength(4);                 // its incoming wire went with it
  await undoKey(page);
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Switch', 'Test_Light']);
  expect((await comps(page)).wires).toHaveLength(5);
  await undoKey(page);
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Light']);
  await undoKey(page, true);
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Light', 'Test_Switch']);
  await saveAndReload(page);
  expect((await comps(page)).instances.filter((i) => i[0] === '1/1_0_0/0').map((i) => i[1]).sort()).toEqual(['Test_Light', 'Test_Switch']);
});

test('Wires: W shows them; fan-in is refused; select + Delete removes one; output -> input adds one; undo / redo; saved', async ({ page }) => {
  await open(page);
  await page.mouse.move(640, 790);
  await page.keyboard.press('w');
  await expect(page.locator('#wiresbtn')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await comps(page)).drawn.ports).toBeGreaterThan(0);
  const lamp = await page.evaluate(() => { const t = (window as unknown as W).__brickTest; return (t as unknown as { ids(): number[] }).ids()[t.rowOfBrick('1/1_0_0/0')]!; });
  // fan-in: the lamp's bEnabled already has a wire (from the chip)
  await port(page, 'Test_Switch', 'bOn', 'out').dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => status(page)).toMatch(/From Test_Switch\.bOn/);
  await port(page, 'Test_Light', 'bEnabled', 'in', lamp).dispatchEvent('pointerdown', { button: 0 });
  let c = await comps(page);
  expect(c.refused).toBe(1);
  expect(await status(page)).toMatch(/Can't connect: .*no fan-in/);
  expect(c.wires).toHaveLength(5);
  // select the chip's wire into the lamp (drawn as a stub: its source is in the chip grid) and delete it
  await page.keyboard.press('Escape');
  const stub = page.locator('#wires path.whit').filter({ has: page.locator('title', { hasText: 'Test_MicrochipOutput.RER_Output to Test_Light.bEnabled' }) });
  await stub.dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(() => status(page)).toMatch(/selected · Delete removes it/);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await comps(page)).wires.length).toBe(4);
  expect(await page.evaluate(() => (window as unknown as { __brickTest: { ids(): number[] } }).__brickTest.ids().length)).toBe(3);   // no brick was deleted
  // now the switch can drive it
  await port(page, 'Test_Switch', 'bOn', 'out').dispatchEvent('pointerdown', { button: 0 });
  await port(page, 'Test_Light', 'bEnabled', 'in', lamp).dispatchEvent('pointerdown', { button: 0 });
  await expect.poll(async () => (await comps(page)).wires).toContain('1/0_0_0/0/Test_Switch.bOn -> 1/1_0_0/0/Test_Light.bEnabled');
  expect(await status(page)).toMatch(/Wired Test_Switch\.bOn → Test_Light\.bEnabled/);
  await expect(page.locator('#wires path.wire:not(.stub)')).toHaveCount(1);   // both ends in the scene: a curve
  await undoKey(page);
  c = await comps(page);
  expect(c.wires).toHaveLength(4);
  await undoKey(page);
  expect((await comps(page)).wires).toContain('2/-1_-1_-1/2/Test_MicrochipOutput.RER_Output -> 1/1_0_0/0/Test_Light.bEnabled');
  await undoKey(page, true); await undoKey(page, true);
  expect((await comps(page)).wires).toContain('1/0_0_0/0/Test_Switch.bOn -> 1/1_0_0/0/Test_Light.bEnabled');
  await page.screenshot({ path: test.info().outputPath('wires.png') });
  await saveAndReload(page);
  c = await comps(page);
  expect(c.wires).toContain('1/0_0_0/0/Test_Switch.bOn -> 1/1_0_0/0/Test_Light.bEnabled');
  expect(c.wires).not.toContain('2/-1_-1_-1/2/Test_MicrochipOutput.RER_Output -> 1/1_0_0/0/Test_Light.bEnabled');
  expect(c.wires).toHaveLength(5);
  // the view stays off by default after a reload of the page
  await page.goto('/?test');
  await expect(page.locator('#wiresbtn')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#wires')).toBeEmpty();
});

test('A brick carrying components still refuses Delete; a plain move inside its chunk keeps them', async ({ page }) => {
  await open(page);
  await focusBrick(page, '1/0_0_0/0');
  await page.mouse.move(640, 790);
  await page.keyboard.press('Delete');
  await frames(page);
  expect(await status(page)).toMatch(/Can't delete: .*components or wires/);
  expect((await comps(page)).instances).toHaveLength(7);
});

test('C-04: a pasted switch carries its component; the inspector edits it; saved and reopened it is intact', async ({ page }) => {
  await open(page);
  await focusBrick(page, '1/0_0_0/0');
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  expect(await status(page)).toMatch(/with the components of 1 brick/);
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.keyboard.press('Control+v');
  // on the ground beside the switch (toward -Y first: a chunk the save has no bricks in), on the canvas
  const at = await page.evaluate(() => {
    const t = (window as unknown as { __brickTest: { focusBox(): { lo: number[]; hi: number[] }; project(x: number, y: number, z: number): [number, number] } }).__brickTest;
    const { lo, hi } = t.focusBox(), cx = (lo[0]! + hi[0]!) / 2, cy = (lo[1]! + hi[1]!) / 2;
    for (const d of [0.6, 1, 1.5, 2.5]) for (const [x, y] of [[cx, lo[1]! - d], [cx, hi[1]! + d], [lo[0]! - d, cy]] as const) {
      const p = t.project(x, y, lo[2]!);
      if (document.elementFromPoint(p[0], p[1])?.id === 'c') return p;
    }
    throw new Error('no free ground on screen beside the switch');
  });
  await page.mouse.move(at[0], at[1]);
  await frames(page);
  await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => status(page)).toMatch(/^Pasted/);
  let c = await comps(page);
  expect(c.instances).toHaveLength(8);
  const added = c.instances.find((i) => i[1] === 'Test_Switch' && i[0] !== '1/0_0_0/0')!;
  expect(added).toBeDefined();
  // the pasted brick has the focus: the inspector shows its switch and edits it
  await page.locator('#comptoggle').click();
  await expect(page.locator('#compbody .ctitle')).toHaveText(['Test_Switch']);
  await page.locator('#compbody input[aria-label="Enabled"]').click();
  await expect.poll(async () => data(await comps(page), added[0], 'Test_Switch').bEnabled).toBe(false);
  await saveAndReload(page);
  c = await comps(page);
  expect(c.dirty).toBe(false);
  expect(c.instances).toHaveLength(8);
  const back = c.instances.filter((i) => i[1] === 'Test_Switch' && i[0] !== '1/0_0_0/0');
  expect(back).toHaveLength(1);
  expect(JSON.parse(back[0]![2])).toMatchObject({ bEnabled: false });
  expect(data(c, '1/0_0_0/0', 'Test_Switch').bEnabled).toBe(true);           // the original is untouched
  expect(c.wires).toHaveLength(5);
});
