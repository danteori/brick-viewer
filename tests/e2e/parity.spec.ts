// Phase 1 interaction parity: the same mouse and keyboard script runs against the frozen legacy
// viewer and the new app, and both must end every step with the same brick list (frame-independent
// records), focus, clipboard and paste mode. Uses only the startup brick and the catalogue, so it
// needs no private saves.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { REFS, referenceSaves } from '../unit/refs.ts';

type P2 = [number, number];
interface Api {
  settle(): Promise<number>;
  project(x: number, y: number, z: number): P2;
  focusBox(): { lo: number[]; hi: number[] };
  brickBox(k: number): { lo: number[]; hi: number[] };
  snapshot(): unknown;
}
declare global { interface Window { __brickTest: Api } }

/** window.__brickTest for the legacy page, from its globals (as scripts/golden-capture.mjs does) */
async function legacyAdapter(page: Page): Promise<void> {
  await page.waitForFunction(() => typeof (window as unknown as { loadSave?: unknown }).loadSave === 'function');
  await page.evaluate(() => {
    const g = window as unknown as Record<string, never>;
    const ev = (s: string): unknown => (0, eval)(s);
    const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
    window.__brickTest = {
      async settle() {
        let prev = '', prev2 = '', same = 0;
        for (let i = 0; i < 4000; i++) {
          await raf();
          const s = ev('[cam.x, cam.y, cam.half, orbit.yaw, orbit.pitch]') as number[];
          const k = s.map((v) => Math.round(v * 1e12)).join();
          if (!(ev('isoSettling()') as boolean) && (k === prev || k === prev2)) { if (++same >= 6) return i; } else same = 0;
          prev2 = prev; prev = k;
        }
        return -1;
      },
      project(x, y, z) {
        const c = ev('canvas') as HTMLCanvasElement, cam = ev('cam') as { x: number; y: number; half: number };
        const cw = c.clientWidth, ch = c.clientHeight, fx = Math.max(cw / ch, 1), fy = Math.max(ch / cw, 1);
        const sx = 1 / (cam.half * fx), sy = 1 / (cam.half * fy), v = (ev('toView') as (a: number, b: number, c: number) => number[])(x, y, z);
        return [((v[0] - cam.x) * sx + 1) * cw / 2, (1 - (v[1] - cam.y) * sy) * ch / 2];
      },
      focusBox: () => ({ lo: (ev('lo') as number[]).slice(), hi: (ev('hi') as number[]).slice() }),
      brickBox: (k) => { const b = (ev('bricks') as { lo: number[]; hi: number[] }[])[k]; return { lo: b.lo.slice(), hi: b.hi.slice() }; },
      snapshot() {
        const bricks = ev('bricks') as unknown[], snap = ev('snapBrick') as (k: number) => unknown, ed = g.editor as unknown as { clip: unknown; pasteMode: string; ghost: unknown };
        return { bricks: bricks.map((_, k) => snap(k)), sel: ev('sel'), clip: ed.clip, pasteMode: ed.pasteMode, ghost: !!ed.ghost, status: document.getElementById('status')!.textContent, held: ev('held'), zoom: +(ev('zoomMul') as number).toPrecision(10), active: document.activeElement?.id || document.activeElement?.tagName };
      },
    };
  });
}

const frames = (page: Page, n = 3): Promise<void> => page.evaluate(async (n) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r));
}, n);

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => window.__brickTest.settle());
  await frames(page);
}

/** screen point of a world point on the focused brick's box, by fractions of its size */
async function onFocus(page: Page, fx: number, fy: number, fz: number): Promise<P2> {
  return page.evaluate(([fx, fy, fz]) => {
    const { lo, hi } = window.__brickTest.focusBox();
    const p = [fx, fy, fz].map((f, i) => lo[i] + (hi[i] - lo[i]) * f);
    return window.__brickTest.project(p[0], p[1], p[2]);
  }, [fx, fy, fz]);
}

/** screen point of the ground (the focused brick's bottom) at (dx, dy) viewer units beyond its faces */
async function beside(page: Page, dx: number, dy: number): Promise<P2> {
  return page.evaluate(([dx, dy]) => {
    const { lo, hi } = window.__brickTest.focusBox();
    const x = dx > 0 ? hi[0] + dx : dx < 0 ? lo[0] + dx : (lo[0] + hi[0]) / 2;
    const y = dy > 0 ? hi[1] + dy : dy < 0 ? lo[1] + dy : (lo[1] + hi[1]) / 2;
    return window.__brickTest.project(x, y, lo[2]);
  }, [dx, dy]);
}

async function drag(page: Page, from: P2, to: P2): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await frames(page);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 12 });
  await page.mouse.up();
  await frames(page);
}

async function click(page: Page, at: P2): Promise<void> {
  await page.mouse.move(at[0], at[1]);
  await frames(page);
  await page.mouse.down(); await page.mouse.up();
}

/** The interaction script; returns a snapshot after each step. */
async function run(page: Page): Promise<{ step: string; snap: unknown }[]> {
  const out: { step: string; snap: unknown }[] = [];
  const snap = async (step: string): Promise<void> => {
    await settle(page);
    out.push({ step, snap: await page.evaluate(() => window.__brickTest.snapshot()) });
  };
  await snap('start');

  // resize drag: grab the top face and pull it up
  const top = await onFocus(page, 0.5, 0.5, 1);
  await drag(page, top, [top[0], top[1] - 70]);
  await snap('drag top face');

  // resize drag along +X from the near X face
  const xf = await onFocus(page, 1, 0.5, 0.5);
  const xt = await onFocus(page, 2, 0.5, 0.5);
  await drag(page, xf, xt);
  await snap('drag X face');

  // typed sizes in the size menu: Y = 3, height 2+1f
  await page.locator('#menu .mrow input').nth(1).click();
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  await snap('typed Y');
  await page.locator('#menu .mrow input').nth(2).click();
  await page.keyboard.type('2+1f');
  await page.keyboard.press('Enter');
  await snap('typed Z');

  // copy, switch Ctrl+V to Paste brick, paste and place on the ground beside the brick
  await page.mouse.move(640, 790);
  await page.keyboard.press('Control+c');
  await page.locator('#pastemode button[data-paste="brick"]').click();
  await page.keyboard.press('Control+v');
  await click(page, await beside(page, 0.6, 0));
  await snap('paste');

  // catalogue: drag a Ramp next to it
  const item = page.locator('.bitem', { hasText: /^Ramp$/ });
  await item.scrollIntoViewIfNeeded();
  const box = (await item.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const dest = await beside(page, 0, -0.5);
  await page.mouse.move(dest[0], dest[1], { steps: 10 });
  await frames(page);
  await page.mouse.up();
  await snap('place ramp');

  // catalogue: click Microbrick, turn it with R, click to place
  await page.locator('.bitem', { hasText: /^Microbrick$/ }).click();
  await page.keyboard.press('r');
  await click(page, await beside(page, 0, -0.3));
  await snap('place microbrick');

  // fold the side panels away so more of the scene is clickable, then zoom out (scroll down)
  await page.locator('#btoggle').click();
  await page.locator('#ptoggle').click();
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 500);
  await snap('zoom out');

  // click the top of the first other brick that's on screen (not under a panel): the focus moves to it
  const b0 = await page.evaluate(() => {
    const t = window.__brickTest, snap = t.snapshot() as { bricks: unknown[]; sel: number };
    for (let k = 0; k < snap.bricks.length; k++) {
      if (k === snap.sel) continue;
      const { lo, hi } = t.brickBox(k);
      for (const fx of [0.5, 0.25, 0.75]) for (const fy of [0.5, 0.25, 0.75]) {
        const p = t.project(lo[0] + (hi[0] - lo[0]) * fx, lo[1] + (hi[1] - lo[1]) * fy, hi[2]);
        if (document.elementFromPoint(p[0], p[1])?.id === 'c') return p;
      }
    }
    throw new Error('no other brick on screen');
  });
  await click(page, b0);
  await snap('focus click');

  // delete the focused brick
  await page.mouse.move(640, 790);
  await page.keyboard.press('Delete');
  await snap('delete');

  // undo x3, redo x1
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await snap('undo x3');
  await page.keyboard.press('Control+y');
  await snap('redo');
  return out;
}

test('interaction script gives the same brick lists in legacy and the new app', async ({ browser }) => {
  test.setTimeout(600_000);
  const results: { step: string; snap: unknown }[][] = [];
  for (const url of ['/legacy/save-viewer.html', '/?test']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    if (url.startsWith('/legacy')) await legacyAdapter(page);
    else await page.waitForFunction(() => !!window.__brickTest);
    results.push(await run(page));
    expect(errors).toEqual([]);
    await ctx.close();
  }
  const [legacy, app] = results;
  for (const r of legacy) {
    const s = r.snap as { bricks: unknown[]; sel: number; status: string; held: boolean; active: string; ghost: boolean };
    console.log(`${r.step.padEnd(18)} ${s.bricks.length} bricks, focus ${s.sel}, held ${s.held}, ghost ${s.ghost}, active ${s.active}: ${s.status}`);
  }
  expect(app.map((r) => r.step)).toEqual(legacy.map((r) => r.step));
  for (let i = 0; i < legacy.length; i++) expect(app[i].snap, `after "${legacy[i].step}"`).toEqual(legacy[i].snap);
  // the script really edited the scene
  const counts = legacy.map((r) => (r.snap as { bricks: unknown[] }).bricks.length);
  const size = (i: number, a: number): number => {
    const b = (legacy[i].snap as { bricks: { lo: number[]; hi: number[] }[] }).bricks[0];
    return +(b.hi[a] - b.lo[a]).toFixed(3);
  };
  expect(size(1, 2)).toBeGreaterThan(size(0, 2));   // the top-face drag made it taller
  expect(size(2, 0)).toBeGreaterThan(size(1, 0));   // the X drag made it longer
  expect(counts).toEqual([1, 1, 1, 1, 1, 2, 3, 4, 4, 4, 3, 2, 3]);
});

// Loading: every reference save (private, from BRICK_REFS; skipped without it) must give the same
// brick list, focus, zoom and status line in both. Saves either viewer can't read must fail in both.
test('every reference save loads to the same brick list', async ({ browser }) => {
  const saves = referenceSaves();
  test.skip(!saves.length, 'no reference saves (BRICK_REFS)');
  test.setTimeout(900_000);
  const pages: Page[] = [];
  for (const url of ['/legacy/save-viewer.html', '/?test']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(url);
    if (url.startsWith('/legacy')) await legacyAdapter(page);
    else await page.waitForFunction(() => !!window.__brickTest);
    pages.push(page);
  }
  const load = (page: Page, b64: string, name: string, legacy: boolean): Promise<unknown> => page.evaluate(({ b64, name, legacy }) => {
    const bin = atob(b64), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    try {
      if (legacy) (0, eval)('loadSave')(u.buffer, name);
      else (window.__brickTest as unknown as { loadSave(b: string, n: string): unknown }).loadSave(b64, name);
    } catch (e) { return { error: String((e as Error).message) }; }
    return window.__brickTest.snapshot();
  }, { b64, name, legacy });
  let compared = 0;
  for (const rel of saves) {
    const b64 = readFileSync(join(REFS, rel)).toString('base64'), name = basename(rel);
    const [a, b] = [await load(pages[0], b64, name, true), await load(pages[1], b64, name, false)];
    expect(b, rel).toEqual(a);
    compared++;
  }
  expect(compared).toBe(saves.length);
});
