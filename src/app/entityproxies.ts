// Entity proxies (backlog W-11): after every load, reads the save's balls and wheels and hands
// them to the renderer (src/render/proxies.ts). Read-only.

import { S } from './state.ts';
import { readEntities } from '../format/entities.ts';
import { fileMapView } from '../format/saveview.ts';
import { loadedFiles } from '../scene/load.ts';
import { entityProxies } from '../scene/entityproxies.ts';
import { initProxies, setProxies } from '../render/proxies.ts';

export function initEntityProxies(): void {
  initProxies();
  S.hooks.loaded.push(() => {
    try {
      const list = loadedFiles ? entityProxies(readEntities(fileMapView(loadedFiles)).entities) : [];
      setProxies(list, S.scene);
    } catch (err) {
      console.warn('entity proxies unreadable', err);
      setProxies([], S.scene);
    }
  });
}
