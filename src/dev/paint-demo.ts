// Dev-only harness for the paint model and palette panel (paint-demo.html; not part of any build).
// A row of fake bricks stands in for the scene: click to select (Shift/Ctrl adds), "Paint selection"
// paints them, the eyedropper takes a brick's paint, and undo/redo replays the change sets.

import '../ui/styles.css';
import { applyChange, PaintModel, selectByColour, srgbFloatTarget, type PaintChange, type SrgbFloatBrick } from '../editor/paint.ts';
import { mountPalettePanel } from '../ui/panels/palette.ts';

const app = document.getElementById('app')!;
app.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px;padding:16px;max-width:960px;margin:0 auto;';
const side = document.createElement('div');
const main = document.createElement('div');
app.append(side, main);

const bricks: SrgbFloatBrick[] = Array.from({ length: 24 }, (_, i) => ({
  color: [[0.98, 0.25, 0.25], [0.3, 0.55, 0.95], [0.95, 0.95, 0.95]][i % 3]!.slice(),
  material: 'BMC_Plastic',
  intensity: 5,
}));
const sel = new Set<number>();
const undo: PaintChange<number>[] = [], redo: PaintChange<number>[] = [];

const tiles = document.createElement('div');
tiles.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:6px;';
const bar = document.createElement('div');
bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin:12px 0;';
const log = document.createElement('pre');
log.style.cssText = 'font-size:12px;white-space:pre-wrap;color:var(--muted);';
main.append(tiles, bar, log);

const target = srgbFloatTarget(bricks, () => draw());
const model = new PaintModel();

function draw(): void {
  tiles.replaceChildren(...bricks.map((b, i) => {
    const t = document.createElement('button');
    t.type = 'button';
    t.title = `brick ${i}: ${b.material} ${b.intensity}`;
    t.style.cssText = `aspect-ratio:1;border-radius:6px;cursor:pointer;background:rgb(${b.color.map((v) => Math.round(v * 255)).join(',')});` +
      `border:3px solid ${sel.has(i) ? 'var(--accent, #e8590c)' : 'transparent'};font:600 10px system-ui;color:#000a;`;
    t.textContent = b.material === 'BMC_Plastic' ? '' : (b.material ?? '').replace('BMC_', '');
    t.addEventListener('click', (e) => {
      if (panel.eyedropper) { panel.eyedrop(target.get(i)!); return; }
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) sel.clear();
      if (sel.has(i)) sel.delete(i); else sel.add(i);
      draw();
    });
    return t;
  }));
}

const panel = mountPalettePanel(side, {
  model,
  onPick: (p) => { log.textContent = `pick ${JSON.stringify(p)}`; },
  onPaint: () => {
    const ch = model.applyPaint(target, sel);
    if (ch.ids.length) { undo.push(ch); redo.length = 0; }
    log.textContent = `paint: ${ch.ids.length} changed\n${JSON.stringify(ch, null, 1)}`;
  },
  onEyedropper: (on) => { tiles.style.cursor = on ? 'crosshair' : ''; },
});

const button = (label: string, fn: () => void): void => {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label; b.onclick = fn;
  bar.append(b);
};
button('Undo', () => { const c = undo.pop(); if (c) { applyChange(target, c, 'before'); redo.push(c); } });
button('Redo', () => { const c = redo.pop(); if (c) { applyChange(target, c, 'after'); undo.push(c); } });
button('Select by current colour', () => {
  sel.clear();
  for (const i of selectByColour(target.entries(), model.colour)) sel.add(i);
  draw();
});
button('Select all', () => { bricks.forEach((_, i) => sel.add(i)); draw(); });
draw();
