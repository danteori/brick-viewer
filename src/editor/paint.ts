// Paint tool model (backlog E-03): the current paint (colour, material, intensity), painting a set of
// bricks as one undoable change, the eyedropper, and select-by-colour. Pure logic, no DOM; the only
// browser API is an optional Storage (localStorage by default) for remembering the current paint.
//
// It works on a minimal brick view so any scene store can plug in:
//   - PaintFields  {colour: sRGB bytes, material: BMC_* name, intensity 0-10}
//   - PaintTarget  get(id) / set(id, fields) over the store's own bricks (any id type)
// srgbFloatTarget() adapts the Phase 1 brick list (colour = display sRGB 0..1 floats).
//
// Colour bytes are sRGB (what saves with bColorsAreLinear = false hold, and what the game paints:
// palette values are linear and get converted first, see format/palette.ts). Intensity is the A byte
// of ColorsAndAlphas: 0-10, 10 = 100 %, 5 = the plastic default; the game rejects values above 10.

export type Rgb8 = [number, number, number];

/** The six material names every save's MaterialAssetNames lists, in the game's order. */
export const MATERIALS = [
  'BMC_Plastic', 'BMC_Glass', 'BMC_TranslucentPlastic', 'BMC_Glow', 'BMC_Metallic', 'BMC_Hologram',
] as const;
export type MaterialName = (typeof MATERIALS)[number];

export const DEFAULT_MATERIAL: MaterialName = 'BMC_Plastic';
export const DEFAULT_INTENSITY = 5;
export const MAX_INTENSITY = 10;
/** The default palette's bright red (#FA4040), the viewer's default brick colour. */
export const DEFAULT_COLOUR: Rgb8 = [250, 64, 64];

/** "BMC_TranslucentPlastic" -> "Translucent Plastic". */
export const materialLabel = (m: string | undefined): string =>
  m ? m.replace(/^BMC_/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : 'Plastic';

/** What painting reads and writes on a brick. */
export interface PaintFields {
  colour: Rgb8;
  material: string;
  intensity: number;
}
export type Paint = PaintFields;

/** Which parts of the paint a stroke applies. Default: all three. */
export interface PaintMask {
  colour?: boolean;
  material?: boolean;
  intensity?: boolean;
}

/** The store adapter. `set` is only needed by applyPaint / applyChange. */
export interface PaintSource<Id> {
  get(id: Id): PaintFields | undefined;
}
export interface PaintTarget<Id> extends PaintSource<Id> {
  set(id: Id, fields: PaintFields): void;
}

/** An undoable paint edit: the changed bricks' fields before and after, index-aligned with ids. */
export interface PaintChange<Id> {
  label: string;
  ids: Id[];
  before: PaintFields[];
  after: PaintFields[];
}

// --- helpers ---------------------------------------------------------------------------------------

const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(Number.isFinite(v) ? v : 0)));
export const clampIntensity = (v: number): number => Math.max(0, Math.min(MAX_INTENSITY, Math.round(Number.isFinite(v) ? v : DEFAULT_INTENSITY)));

/** A normalised copy (bytes clamped and rounded, intensity 0-10, a material name). */
export function normalisePaint(p: Partial<PaintFields> | undefined): PaintFields {
  const c = Array.isArray(p?.colour) && p.colour.length >= 3 ? p.colour : DEFAULT_COLOUR;
  return {
    colour: [byte(c[0]!), byte(c[1]!), byte(c[2]!)],
    material: typeof p?.material === 'string' && p.material ? p.material : DEFAULT_MATERIAL,
    intensity: p?.intensity === undefined ? DEFAULT_INTENSITY : clampIntensity(p.intensity),
  };
}

const samePaint = (a: PaintFields, b: PaintFields): boolean =>
  a.colour[0] === b.colour[0] && a.colour[1] === b.colour[1] && a.colour[2] === b.colour[2] &&
  a.material === b.material && a.intensity === b.intensity;

export const hexOfRgb8 = (c: readonly number[]): string => '#' + c.slice(0, 3).map((v) => byte(v).toString(16).padStart(2, '0')).join('');

/** The fields a brick ends up with after `paint` (masked) is applied to `cur`. */
export function paintedFields(cur: PaintFields, paint: PaintFields, mask: PaintMask = {}): PaintFields {
  const p = normalisePaint(paint);
  return {
    colour: mask.colour === false ? [...cur.colour] as Rgb8 : p.colour,
    material: mask.material === false ? cur.material : p.material,
    intensity: mask.intensity === false ? cur.intensity : p.intensity,
  };
}

// --- painting --------------------------------------------------------------------------------------

/**
 * The change painting `ids` would make, without touching the store. Bricks that are missing or
 * already look like that are left out, so an empty change means "nothing to do / nothing to undo".
 */
export function planPaint<Id>(bricks: PaintSource<Id>, ids: Iterable<Id>, paint: PaintFields, mask: PaintMask = {}, label = 'Paint'): PaintChange<Id> {
  const out: PaintChange<Id> = { label, ids: [], before: [], after: [] };
  const seen = new Set<Id>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const got = bricks.get(id);
    if (!got) continue;
    const cur = normalisePaint(got), next = paintedFields(cur, paint, mask);
    if (samePaint(cur, next)) continue;
    out.ids.push(id); out.before.push(cur); out.after.push(next);
  }
  return out;
}

/** Paints `ids` (writes through bricks.set) and returns the change for the undo stack. */
export function applyPaint<Id>(bricks: PaintTarget<Id>, ids: Iterable<Id>, paint: PaintFields, mask: PaintMask = {}, label = 'Paint'): PaintChange<Id> {
  const ch = planPaint(bricks, ids, paint, mask, label);
  applyChange(bricks, ch, 'after');
  return ch;
}

/** Undo (side 'before') or redo (side 'after') a paint change. */
export function applyChange<Id>(bricks: PaintTarget<Id>, change: PaintChange<Id>, side: 'before' | 'after'): void {
  const list = change[side];
  change.ids.forEach((id, i) => bricks.set(id, normalisePaint(list[i])));
}

// --- eyedropper and select-by-colour ---------------------------------------------------------------

/** The eyedropper: the paint a brick has (a normalised copy). PaintModel.pickFrom also adopts it. */
export function pickFrom(brick: Partial<PaintFields>): PaintFields {
  return normalisePaint(brick);
}

export interface SelectByColourOptions {
  /** Largest per-channel byte difference that still counts as the same colour (default 0, exact). */
  tolerance?: number;
  /** Also require this material (default: any material). */
  material?: string;
  /** Also require this intensity (default: any). */
  intensity?: number;
}

/** Ids of the bricks whose colour matches `colour` (sRGB bytes), in iteration order. */
export function selectByColour<Id>(bricks: Iterable<readonly [Id, PaintFields]>, colour: readonly number[], opts: SelectByColourOptions = {}): Id[] {
  const tol = Math.max(0, opts.tolerance ?? 0), want = [byte(colour[0]!), byte(colour[1]!), byte(colour[2]!)];
  const out: Id[] = [];
  for (const [id, f] of bricks) {
    const c = f.colour;
    if (Math.abs(byte(c[0]) - want[0]!) > tol || Math.abs(byte(c[1]) - want[1]!) > tol || Math.abs(byte(c[2]) - want[2]!) > tol) continue;
    if (opts.material !== undefined && (f.material || DEFAULT_MATERIAL) !== opts.material) continue;
    if (opts.intensity !== undefined && clampIntensity(f.intensity) !== clampIntensity(opts.intensity)) continue;
    out.push(id);
  }
  return out;
}

// --- the current paint, remembered -----------------------------------------------------------------

export const PAINT_KEY = 'brickViewer.paint';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/**
 * The current paint. Every change is saved (JSON under PAINT_KEY) and announced to subscribers.
 * Storage failures (private mode, blocked site data) are ignored: the model then lives in memory.
 */
export class PaintModel {
  private cur: PaintFields;
  private readonly subs = new Set<(p: PaintFields) => void>();
  private readonly store: StorageLike | null;

  constructor(storage: StorageLike | null | undefined = defaultStorage(), private readonly key = PAINT_KEY) {
    this.store = storage ?? null;
    this.cur = normalisePaint(this.load());
  }

  private load(): Partial<PaintFields> | undefined {
    try {
      const s = this.store?.getItem(this.key);
      return s ? (JSON.parse(s) as Partial<PaintFields>) : undefined;
    } catch { return undefined; }
  }

  private save(): void {
    try { this.store?.setItem(this.key, JSON.stringify(this.cur)); } catch { /* storage blocked */ }
  }

  /** A copy of the current paint. */
  get paint(): PaintFields { return normalisePaint(this.cur); }
  get colour(): Rgb8 { return [...this.cur.colour] as Rgb8; }
  get material(): string { return this.cur.material; }
  get intensity(): number { return this.cur.intensity; }

  /** Change any part of the current paint. */
  set(p: Partial<PaintFields>): void {
    const next = normalisePaint({ ...this.cur, ...p });
    if (samePaint(next, this.cur)) return;
    this.cur = next;
    this.save();
    for (const f of this.subs) f(this.paint);
  }
  setColour(c: readonly number[]): void { this.set({ colour: [c[0]!, c[1]!, c[2]!] }); }
  setMaterial(m: string): void { this.set({ material: m }); }
  setIntensity(i: number): void { this.set({ intensity: i }); }

  /** The eyedropper: adopt a brick's paint (mask picks which parts) and return it. */
  pickFrom(brick: Partial<PaintFields>, mask: PaintMask = {}): PaintFields {
    this.set(paintedFields(this.cur, pickFrom(brick), mask));
    return this.paint;
  }

  /** Paint `ids` with the current paint; see applyPaint. */
  applyPaint<Id>(bricks: PaintTarget<Id>, ids: Iterable<Id>, mask: PaintMask = {}, label = 'Paint'): PaintChange<Id> {
    return applyPaint(bricks, ids, this.cur, mask, label);
  }

  /** Called with the new paint after every change. Returns an unsubscribe function. */
  subscribe(f: (p: PaintFields) => void): () => void {
    this.subs.add(f);
    return () => { this.subs.delete(f); };
  }
}

// --- adapter for the Phase 1 brick list ------------------------------------------------------------

/** The Phase 1 brick record's paint fields: display sRGB 0..1 floats, material name, intensity 0-10. */
export interface SrgbFloatBrick {
  color: number[];
  material?: string;
  intensity?: number;
}

/**
 * A PaintTarget over an array of Phase 1 bricks, keyed by index. Colours are converted
 * floats <-> bytes (round(v * 255)); `set` writes in place and then calls onChange(index), e.g. to
 * mark the instance buffer dirty. entries() feeds selectByColour.
 */
export function srgbFloatTarget<B extends SrgbFloatBrick>(list: B[], onChange?: (index: number) => void): PaintTarget<number> & { entries(): Iterable<[number, PaintFields]> } {
  const read = (b: B): PaintFields => normalisePaint({
    colour: [b.color[0]! * 255, b.color[1]! * 255, b.color[2]! * 255],
    material: b.material ?? DEFAULT_MATERIAL,
    intensity: b.intensity ?? DEFAULT_INTENSITY,
  });
  return {
    get: (i) => (list[i] ? read(list[i]) : undefined),
    set: (i, f) => {
      const b = list[i];
      if (!b) return;
      b.color = f.colour.map((v) => v / 255);
      b.material = f.material;
      b.intensity = f.intensity;
      onChange?.(i);
    },
    *entries() { for (let i = 0; i < list.length; i++) yield [i, read(list[i]!)]; },
  };
}
