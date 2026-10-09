// Entities: dynamic brick grids, microchip grids, wheels, balls... (FORMAT.md 1.5)
//
//   World/0/Entities/ChunkIndex.mps     {NextPersistentIndex, Chunk3DIndices, NumEntities}
//   World/0/Entities/Chunks/X_Y_Z.mps   BRSavedEntityChunkSoA, then one data struct per entity
//                                       (EntityDataClassNames[TypeIndex]) in type-counter order
// Each entity is identified by its PersistentIndex; a dynamic grid's bricks live in
// World/0/Bricks/Grids/<PersistentIndex>/. Locations are absolute, in brick units (every save
// seen so far keeps all entities in chunk 0_0_0, wherever they are). Rotations are quaternions
// (x, y, z, w) in the save's own axes. Fields that older schemas lack come back as null.

import type { MpsObject } from './schema.ts';
import { decodeWritten, writtenGlobalData, type SaveView } from './saveview.ts';

export type Vec3 = [x: number, y: number, z: number];
export type Quat = [x: number, y: number, z: number, w: number];
export type Rgba = [r: number, g: number, b: number, a: number];

export interface EntityRecord {
  persistentIndex: number;
  typeIndex: number;
  /** EntityTypeNames[typeIndex], e.g. Entity_DynamicBrickGrid. */
  type: string;
  /** EntityDataClassNames[typeIndex], e.g. BrickGridDynamicActor (null in saves without that list). */
  dataClass: string | null;
  /** The chunk file and the entity's position in it. */
  chunk: string;
  index: number;
  owner: number | null;
  originalOwner: number | null;
  prefabSpawnInstance: number | null;
  location: Vec3;
  rotation: Quat;
  physicsLocked: boolean;
  physicsSleeping: boolean;
  /** Older schemas only. */
  weldParent: boolean | null;
  linearVelocity: Vec3 | null;
  angularVelocity: Vec3 | null;
  /** Eight colour slots (wheel and ball paint), bytes as stored. */
  colors: Rgba[] | null;
  /** null when the chunk has no bColorsAreLinear field, which means the bytes are linear (FORMAT.md 2.3). */
  colorsAreLinear: boolean | null;
  remainingLifeSpan: number | null;
  /** The per-entity data struct (e.g. BrickGridDynamicActor physics settings), or null. */
  data: MpsObject | null;
}

export interface EntityTable {
  nextPersistentIndex: number | null;
  /** Entity chunk files read. */
  chunks: string[];
  entities: EntityRecord[];
  byIndex: Map<number, EntityRecord>;
  /** Entity chunk roots as decoded, by path (for fields this table doesn't map). */
  roots: Map<string, MpsObject>;
}

interface XYZ { X: number; Y: number; Z: number }
interface XYZW extends XYZ { W: number }
type Colour = { R: number; G: number; B: number; A: number };

const bit = (flags: { Flags?: number[] } | undefined, i: number): boolean | null =>
  flags?.Flags ? ((flags.Flags[i >> 3] ?? 0) >> (i & 7) & 1) === 1 : null;
const v3 = (v: XYZ | undefined): Vec3 | null => (v ? [v.X, v.Y, v.Z] : null);

export interface EntityNames {
  EntityTypeNames?: string[];
  EntityDataClassNames?: string[];
}

/** Entities of one decoded entity chunk. `global` is the GlobalData it was written with. */
export function entitiesOfChunk(root: MpsObject, data: { value: MpsObject | null }[], global: EntityNames, chunk: string): EntityRecord[] {
  const types = global.EntityTypeNames ?? [], classes = global.EntityDataClassNames;
  const counters = (root.TypeCounters as { TypeIndex: number; NumEntities: number }[] | undefined) ?? [];
  const ids = (root.PersistentIndices as number[] | undefined) ?? [];
  const arr = <T>(k: string): T[] | undefined => root[k] as T[] | undefined;
  const loc = arr<XYZ>('Locations') ?? [], rot = arr<XYZW>('Rotations') ?? [];
  const owners = arr<number>('OwnerIndices'), orig = arr<number>('OriginalOwnerIndices'), prefab = arr<number>('PrefabSpawnInstanceIndices');
  const lin = arr<XYZ>('LinearVelocities'), ang = arr<XYZ>('AngularVelocities'), life = arr<number>('RemainingLifeSpans');
  const cols = arr<Record<string, Colour>>('ColorsAndAlphas');
  const linear = typeof root.bColorsAreLinear === 'boolean' ? root.bColorsAreLinear : null;
  const out: EntityRecord[] = [];
  let i = 0;
  for (const c of counters) {
    for (let n = 0; n < c.NumEntities; n++, i++) {
      const l = loc[i], r = rot[i], slots = cols?.[i];
      out.push({
        persistentIndex: ids[i]!,
        typeIndex: c.TypeIndex,
        type: types[c.TypeIndex] ?? `#${c.TypeIndex}`,
        dataClass: classes?.[c.TypeIndex] ?? null,
        chunk,
        index: i,
        owner: owners?.[i] ?? null,
        originalOwner: orig?.[i] ?? null,
        prefabSpawnInstance: prefab?.[i] ?? null,
        location: l ? [l.X, l.Y, l.Z] : [0, 0, 0],
        rotation: r ? [r.X, r.Y, r.Z, r.W] : [0, 0, 0, 1],
        physicsLocked: bit(root.PhysicsLockedFlags as { Flags: number[] }, i) ?? false,
        physicsSleeping: bit(root.PhysicsSleepingFlags as { Flags: number[] }, i) ?? false,
        weldParent: bit(root.WeldParentFlags as { Flags: number[] } | undefined, i),
        linearVelocity: v3(lin?.[i]),
        angularVelocity: v3(ang?.[i]),
        colors: slots ? Object.values(slots).map((c) => [c.R, c.G, c.B, c.A] as Rgba) : null,
        colorsAreLinear: linear,
        remainingLifeSpan: life?.[i] ?? null,
        data: data[i]?.value ?? null,
      });
    }
  }
  if (i !== ids.length) throw new Error(`${chunk}: type counters cover ${i} entities, PersistentIndices has ${ids.length}`);
  return out;
}

const ENTITY_CHUNK = /^World\/0\/Entities\/Chunks\/[^/]+\.mps$/;

/** Every entity in the save, each chunk decoded with the schema and GlobalData it was written with. */
export function readEntities(view: SaveView): EntityTable {
  const table: EntityTable = { nextPersistentIndex: null, chunks: [], entities: [], byIndex: new Map(), roots: new Map() };
  if (view.has('World/0/Entities/ChunkIndex.mps')) {
    const ci = decodeWritten(view, 'World/0/Entities/ChunkIndex.mps').root;
    table.nextPersistentIndex = (ci.NextPersistentIndex as number | undefined) ?? null;
  }
  for (const p of view.paths()) {
    if (!ENTITY_CHUNK.test(p)) continue;
    const f = decodeWritten(view, p);
    const gd = (writtenGlobalData(view, p) ?? {}) as EntityNames;
    table.chunks.push(p);
    table.roots.set(p, f.root);
    for (const e of entitiesOfChunk(f.root, f.data, gd, p)) {
      table.entities.push(e);
      table.byIndex.set(e.persistentIndex, e);
    }
  }
  return table;
}
