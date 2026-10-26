import type { Page } from '@playwright/test';

type Hook = { __brickTest?: { openWindow?(id: string): void; closeWindow?(id: string): void } };

const hasHook = (page: Page): Promise<boolean> => page.evaluate(() => !!(window as unknown as Hook).__brickTest);
const shown = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((id) => { const el = document.getElementById(id); return !!el && !el.hidden; }, id);

/** Opens a window of the app: through the test hook, or with Esc presses for the Menu without it. Does nothing in the legacy viewer. */
export async function openWin(page: Page, id: string): Promise<void> {
  if (await hasHook(page)) { await page.evaluate((id) => { (window as unknown as Hook).__brickTest!.openWindow?.(id); }, id); return; }
  if (id !== 'escmenu' || !(await page.locator('#escmenu').count())) return;
  for (let i = 0; i < 4 && !(await shown(page, id)); i++) await page.keyboard.press('Escape');
}

/** Closes a window of the app if it is open. Does nothing in the legacy viewer. */
export async function closeWin(page: Page, id: string): Promise<void> {
  if (await hasHook(page)) { await page.evaluate((id) => { (window as unknown as Hook).__brickTest!.closeWindow?.(id); }, id); return; }
  if (await shown(page, id)) await page.keyboard.press('Escape');
}

/** Runs `act` with the Esc menu open, then closes the menu again. */
export async function inMenu<T>(page: Page, act: () => Promise<T>): Promise<T> {
  await openWin(page, 'escmenu');
  try { return await act(); } finally { await closeWin(page, 'escmenu'); }
}
