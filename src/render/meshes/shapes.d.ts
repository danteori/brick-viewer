// Types for shapes.js (kept as plain JS so it stays a verbatim copy of the legacy generator).

export type V3 = [number, number, number];
export type Mat3 = [V3, V3, V3];

export interface ShapeMesh {
  positions: Float32Array;
  normals: Float32Array;
  flags: Float32Array;
  parts: Float32Array;
  caps: Float32Array;
  count: number;
  size?: V3;
  half?: V3;
  worldHalf?: V3;
  [extra: string]: unknown;
}

export interface RoundType { n: number; h: number; cone: boolean; stud: number; top?: number; base?: number }

export interface BrickShapesApi {
  STUD: number;
  UNIT: number;
  MICRO: number;
  PLATE: number;
  PART: Record<string, number>;
  ROUND_TYPES: Record<string, RoundType>;
  MICRO_TYPES: Record<string, string>;
  SPECIAL_TYPES: Record<string, unknown>;
  roundMesh(name: string, up?: number): ShapeMesh & { size: V3; half: V3 };
  crestMesh(size: V3, run?: number, up?: number): ShapeMesh;
  crestEndMesh(size: V3, run?: number, closed?: number, up?: number): ShapeMesh;
  microMesh(asset: string, half: V3, o?: number): ShapeMesh & { size: V3; worldHalf: V3 };
  specialMesh(asset: string, half: V3, o?: number): ShapeMesh & { size: V3; worldHalf: V3 };
  boxMesh(): ShapeMesh;
  crestDir(o: number): { run: number };
  crestEndDir(o: number): { run: number; closed: number };
  isRound(name: string): boolean;
  isMicro(name: string): boolean;
  isSpecial(name: string): boolean;
  brickOrient(o: number): Mat3;
  interleave(mesh: ShapeMesh, extras?: boolean): Float32Array;
}

export const BrickShapes: BrickShapesApi;
