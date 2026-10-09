// Dev-only page (env-demo.html, served by `npm run dev`, not part of either build): mounts the
// environment panel and shows what the app would compute from it: the lighting terms, swatches
// through the tonemapper, and the ground plate.
import '../ui/styles.css';
import { createEnvironmentPanel, type PanelWorldKind } from '../ui/panels/environment.ts';
import { environmentToLighting, topFaceK, type Lighting } from '../env/lighting.ts';
import { environmentGroundPlate, cellMix } from '../env/ground-plate.ts';
import { serialiseEnvironment, srgbToLinear, type Environment } from '../format/environment.ts';
import { ueFilmic } from './tonemap.ts';

const app = document.getElementById('app')!;
app.innerHTML = `
<style>
  body { overflow: auto; }
  .demo { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; align-items: flex-start; }
  .demo .envp { flex: 0 1 360px; max-height: calc(100vh - 32px); }
  .out { flex: 1 1 320px; min-width: 0; max-width: 640px; }
  .out h1 { font-size: 16px; margin: 0 0 4px; }
  .out p { margin: 0 0 10px; color: var(--muted); }
  .out table { border-collapse: collapse; font-variant-numeric: tabular-nums; margin-bottom: 12px; }
  .out td, .out th { padding: 2px 10px 2px 0; text-align: left; }
  .sw { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 8px; margin-bottom: 12px; }
  .sw div { border-radius: 6px; overflow: hidden; border: 1px solid rgba(127,127,127,.3); font-size: 11px; }
  .sw i { display: block; height: 30px; }
  .sw span { display: block; padding: 2px 4px; }
  .plate { height: 90px; border-radius: 6px; margin-bottom: 12px; border: 1px solid rgba(127,127,127,.3); }
  pre { max-height: 240px; overflow: auto; font-size: 11px; background: rgba(127,127,127,.12); padding: 8px; border-radius: 6px; }
  .kind { margin-bottom: 10px; }
</style>
<div class="demo">
  <div id="panel-slot"></div>
  <div class="out">
    <h1>Environment panel (dev demo)</h1>
    <p>Edits update the numbers below live. Not part of the app builds.</p>
    <div class="kind">World: <label><input type="radio" name="kind" value="Plate" checked> Plate</label>
      <label><input type="radio" name="kind" value="Space"> Space</label></div>
    <table id="light"></table>
    <div class="sw" id="sw"></div>
    <div><b>Ground plate</b> <span id="gp-info"></span></div>
    <canvas class="plate" id="plate" width="320" height="90"></canvas>
    <details><summary>.bp output</summary><pre id="bp"></pre></details>
  </div>
</div>`;

const SAMPLES: [string, [number, number, number]][] = [
  ['White', [255, 255, 255]], ['Grey', [128, 128, 128]], ['Black', [20, 20, 20]], ['Red', [200, 30, 30]],
  ['Yellow', [250, 220, 60]], ['Green', [40, 160, 60]], ['Blue', [30, 80, 200]], ['Brown', [110, 70, 40]],
];
const hex = (c: number[]): string => '#' + c.map((v) => Math.round(255 * Math.min(1, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
/** A face lit with N.L = ndl, through the tonemapper. albedo is linear. */
const shade = (l: Lighting, albedo: number[], ndl: number): string =>
  hex(ueFilmic([0, 1, 2].map((i) => l.exposure * (albedo[i]! * (l.sky[i]! + l.sun[i]! * ndl) + l.floor[i]!)) as [number, number, number]));
const f3 = (v: number[]): string => v.map((x) => x.toFixed(3)).join(', ');

function show(env: Environment): void {
  const l = environmentToLighting(env);
  document.getElementById('light')!.innerHTML = `
    <tr><th>sun</th><td>${f3(l.sun)}</td></tr><tr><th>sky</th><td>${f3(l.sky)}</td></tr>
    <tr><th>floor</th><td>${f3(l.floor)}</td></tr><tr><th>top-face K</th><td>${f3(topFaceK(l))}</td></tr>
    <tr><th>exposure</th><td>${l.exposure}</td></tr>
    <tr><th>sun azimuth / elevation</th><td>${l.azimuth.toFixed(0)}° / ${l.elevation.toFixed(0)}°${l.night ? ' (moon)' : ''}</td></tr>
    <tr><th>calibrated</th><td>${l.calibrated ? 'yes' : 'no (model guess)'}</td></tr>`;
  document.getElementById('sw')!.innerHTML = SAMPLES.map(([name, b]) => {
    const alb = b.map((v) => srgbToLinear(v / 255));
    return `<div><i style="background:${shade(l, alb, 0.81)}"></i><i style="background:${shade(l, alb, 0.3)}"></i><span>${name}</span></div>`;
  }).join('');
  const gp = environmentGroundPlate(env);
  const info = document.getElementById('gp-info')!, cv = document.getElementById('plate') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!gp) info.textContent = 'none (Space world)';
  else {
    info.textContent = `${gp.visible ? 'visible' : 'hidden'} · ${gp.hex} · accent ${gp.accentHex} · variance ${gp.variance} per ${gp.cellStuds} stud(s) · studs ${gp.studTexture ? 'on' : 'off'}`;
    if (gp.visible) {
      const px = 10;   // 1 stud = 10 px here
      for (let sy = 0; sy < cv.height / px; sy++) for (let sx = 0; sx < cv.width / px; sx++) {
        ctx.fillStyle = shade(l, cellMix(gp, sx, sy), 0.81);
        ctx.fillRect(sx * px, sy * px, px, px);
        if (gp.studTexture) {
          ctx.fillStyle = 'rgba(255,255,255,.12)';
          ctx.beginPath(); ctx.arc(sx * px + 5, sy * px + 5, 3, 0, 2 * Math.PI); ctx.fill();
        }
      }
    }
  }
  document.getElementById('bp')!.textContent = serialiseEnvironment(env);
}

const panel = createEnvironmentPanel({ onChange: show, open: ['sky', 'sun'], onLoad: (_e, k) => setRadio(k) });
document.getElementById('panel-slot')!.replaceWith(panel.el);
const radios = [...document.querySelectorAll<HTMLInputElement>('input[name=kind]')];
const setRadio = (k: PanelWorldKind): void => { for (const r of radios) r.checked = r.value === k; };
for (const r of radios) r.addEventListener('change', () => { if (r.checked) panel.setKind(r.value as PanelWorldKind); });
show(panel.get());
(window as unknown as { envPanel: unknown }).envPanel = panel;   // for poking from the console / e2e
