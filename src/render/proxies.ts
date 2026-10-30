// Entity proxies drawn (backlog W-11; shapes in src/scene/entityproxies.ts): balls and wheels as
// plain bodies, lit like bricks, depth-tested against the scene. Read-only: they are not in the
// scene store, so they are never picked, selected, moved or saved. Each proxy's mesh is built once,
// turned by the entity's own rotation, and drawn with the brick shader as a single draw at the
// entity's location. Nothing is drawn while the list is empty, so scenes without entities render as before.

import { S } from '../app/state.ts';
import { debugFlag } from '../app/debugflags.ts';
import { BRZ_UNIT } from '../core/units.ts';
import { proxyMeshes, type EntityProxy, type ProxyMesh } from '../scene/entityproxies.ts';
import { LOC } from './gl.ts';
import { G, bindMesh, packWord, setBox, setSingle } from './draw.ts';
import { BOX_MESH, boxIB, type Mesh } from './meshes/registry.ts';

const swapColours = debugFlag('entity-proxies-swap-colours', 'Wheels: tyre uses colour slot 1 and the hub uses slot 0');

interface Drawn { centre: readonly number[]; parts: { mesh: Mesh; slot: 0 | 1 }[]; proxy: EntityProxy }

let drawn: Drawn[] = [];
let owner: unknown = null;
export const proxyState = { on: true };

function upload(m: ProxyMesh, key: string): Mesh {
  const { gl } = G;
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, m.data, gl.STATIC_DRAW);
  return { buf, count: m.count, layout: 0, key };
}

function release(): void {
  for (const d of drawn) for (const p of d.parts) G.gl.deleteBuffer(p.mesh.buf);
  drawn = [];
}

/** Replaces the proxies shown; `scene` is the scene they belong to (they hide while another is shown). */
export function setProxies(list: readonly EntityProxy[], scene: unknown): void {
  release();
  owner = scene;
  drawn = list.map((proxy) => {
    const { body, hub } = proxyMeshes(proxy, BRZ_UNIT);
    const parts: Drawn['parts'] = [{ mesh: upload(body, `proxy|${proxy.id}|body`), slot: 0 }];
    if (hub) parts.push({ mesh: upload(hub, `proxy|${proxy.id}|hub`), slot: 1 });
    return { centre: proxy.centre.map((v) => v * BRZ_UNIT), parts, proxy };
  });
}

export const proxyCount = (): number => drawn.length;

/** The shown proxies, for tests. */
export const shownProxies = (): EntityProxy[] => (proxyState.on && owner === S.scene ? drawn.map((d) => d.proxy) : []);

function drawProxies(): void {
  if (!proxyState.on || !drawn.length || owner !== S.scene) return;
  const { gl, u } = G;
  gl.uniform1f(u.uEdge, 0); gl.uniform1f(u.uFadeR, 0);
  gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
  const word = packWord(16, 2, true);
  for (const d of drawn) {
    for (const part of d.parts) {
      const slot = swapColours.on && d.proxy.kind === 'wheel' ? 1 - part.slot : part.slot;
      const c = d.proxy.colours[slot]!;
      setSingle(d.centre[0]!, d.centre[1]!, d.centre[2]!, 1, 1, 1, word);
      gl.vertexAttrib4f(LOC.iColor, c[0], c[1], c[2], 5 / 255);
      bindMesh(part.mesh);
      gl.drawArrays(gl.TRIANGLES, 0, part.mesh.count);
    }
  }
  bindMesh(BOX_MESH);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, boxIB);
  gl.uniform1f(u.uEdge, 1);
  gl.uniform4f(u.uLine, 0.05, 0.05, 0.08, 1);
  setBox(S.dlo, S.dhi);
}

export function initProxies(): void {
  S.hooks.draw.push(drawProxies);
}
