import { readBrz, type FileMap } from '../format/brz.ts';

const PICTURES = [['Meta/Screenshot.jpg', 'image/jpeg'], ['Meta/Thumbnail.png', 'image/png']] as const;

let img: HTMLImageElement | null = null;
let url: string | null = null;

function pictureOf(files: FileMap): Blob | null {
  for (const [path, type] of PICTURES) {
    const bytes = files.get(path);
    if (bytes?.length) return new Blob([bytes as Uint8Array<ArrayBuffer>], { type });
  }
  return null;
}

/** Shows the save's own picture over the canvas, until hidePreview(). Does nothing when the save has none. */
export function showPreview(source: Uint8Array | FileMap): void {
  hidePreview();
  try {
    const canvas = document.getElementById('c');
    if (!canvas) return;
    const files = source instanceof Map ? source : readBrz(source, { only: PICTURES.map(([p]) => p) });
    const blob = pictureOf(files);
    if (!blob) return;
    url = URL.createObjectURL(blob);
    img = document.createElement('img');
    img.id = 'loadpreview';
    img.alt = '';
    img.src = url;
    canvas.after(img);
  } catch {
    hidePreview();
  }
}

/** The picture now shown, or null. */
export const currentPreview = (): HTMLImageElement | null => img;

/** Removes the picture. With `only`, removes it just if it is that picture (a newer load may have its own). */
export function hidePreview(only?: HTMLImageElement | null): void {
  if (only !== undefined && only !== img) return;
  img?.remove();
  img = null;
  if (url) URL.revokeObjectURL(url);
  url = null;
}

/** Removes the picture after the next two animation frames, so the first frame of the save shows first. */
export function hidePreviewAfterFrame(shown: HTMLImageElement | null): void {
  requestAnimationFrame(() => requestAnimationFrame(() => { hidePreview(shown); }));
}
