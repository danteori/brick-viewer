// Diagnostic (temporary): frame times on the CI machine.
import { test } from '@playwright/test';
for (const url of ['/?test', '/legacy/save-viewer.html']) {
  test(`frame times ${url}`, async ({ page }) => {
    const t0 = Date.now();
    await page.goto(url);
    await page.waitForFunction(() => !!(window as unknown as { __brickTest?: unknown }).__brickTest || typeof (window as unknown as { loadSave?: unknown }).loadSave === 'function');
    const ready = Date.now() - t0;
    const r = await page.evaluate(async () => {
      const c = document.querySelector('canvas')!, gl = (c.getContext('webgl2') || c.getContext('webgl'))!;
      const px = new Uint8Array(4), out: number[] = [];
      for (let i = 0; i < 15; i++) { const t = performance.now(); await new Promise((r) => requestAnimationFrame(r)); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.push(Math.round(performance.now() - t)); }
      const e = gl.getExtension('WEBGL_debug_renderer_info');
      return { frames: out.join(' '), renderer: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '' };
    });
    console.log(`DIAG ${url} ready ${ready} ms, frames ${r.frames}, ${r.renderer}`);
  });
}
