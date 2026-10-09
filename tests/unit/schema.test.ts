import { describe, expect, it } from 'vitest';
import { ByteBuf, arrayHeader, pack } from '../../src/format/msgpack.ts';
import { decodeMps, decodeSoa, encodeMps, encodeSoa, parseSchema, schemaPathFor } from '../../src/format/schema.ts';

// test-only MessagePack writer with maps (JS objects -> maps, in key order)
function mp(x: unknown, o = new ByteBuf()): ByteBuf {
  if (Array.isArray(x)) { arrayHeader(o, x.length); x.forEach((e) => mp(e, o)); }
  else if (x && typeof x === 'object' && !(x instanceof Uint8Array)) {
    const e = Object.entries(x);
    o.byte(0x80 | e.length);
    for (const [k, v] of e) { pack(o, k); mp(v, o); }
  } else pack(o, x as never);
  return o;
}

const structs = {
  Vec: { X: 'i32', Y: 'i32', Z: 'i32' },
  Col: { R: 'u8', G: 'u8', B: 'u8', A: 'u8' },
  Root: { Name: 'str', N: 'u16', Pos: ['Vec', null], Cols: ['Col', null], Tags: ['str'], V: 'Vec', F: 'f32', Big: ['u64', null], On: 'bool' },
};
const value = {
  Name: 'test', N: 300,
  Pos: [{ X: 1, Y: -2, Z: 3 }, { X: -100000, Y: 0, Z: 7 }],
  Cols: [{ R: 1, G: 2, B: 3, A: 5 }],
  Tags: ['a', 'bb'], V: { X: 0, Y: -40, Z: 70000 }, F: 0.5, Big: [2 ** 40], On: true,
};

describe('schema', () => {
  for (const [label, top] of [['2-part (older saves)', [{}, structs]], ['3-part (newer saves)', [{}, [], structs]]] as const) {
    it(`parses the ${label} layout and round-trips a value`, () => {
      const schema = parseSchema(mp(top).done());
      expect(schema.root).toBe('Root');
      expect([...schema.S.keys()]).toEqual(['Vec', 'Col', 'Root']);
      const bytes = encodeMps(value, schema);
      expect(decodeMps(bytes, schema)).toEqual(value);
      expect(encodeMps(decodeMps(bytes, schema), schema)).toEqual(bytes);
    });
  }
  it('finds schemas by the Shared rule', () => {
    const files = new Map<string, unknown>([
      ['World/0/GlobalData.schema', 1],
      ['World/0/Bricks/ChunksShared.schema', 1],
      ['World/0/Bricks/ChunkIndexShared.schema', 1],
    ]);
    expect(schemaPathFor('World/0/GlobalData.mps', files)).toBe('World/0/GlobalData.schema');
    expect(schemaPathFor('World/0/Bricks/Grids/1/Chunks/0_0_0.mps', files)).toBe('World/0/Bricks/ChunksShared.schema');
    expect(schemaPathFor('World/0/Bricks/Grids/1/ChunkIndex.mps', files)).toBe('World/0/Bricks/ChunkIndexShared.schema');
    expect(schemaPathFor('World/0/Nothing.mps', files)).toBe(null);
  });

  describe('encoding rules (the game / brdb)', () => {
    const one = (type: string, x: number): number[] => [...encodeMps({ v: x }, parseSchema(mp([{}, {}, { R: { v: type } }]).done()))];
    it('writes u8 as a signed int, never 0xcc', () => {
      expect(one('u8', 100)).toEqual([0x64]);
      expect(one('u8', 200)).toEqual([0xd0, 0xc8]);   // -56
      expect(one('u8', 255)).toEqual([0xff]);         // -1, negative fixint
      expect(one('u8', 224)).toEqual([0xe0]);         // -32
    });
    it('writes whole floats as ints and f64 as f32 only when exact', () => {
      expect(one('f32', 2)).toEqual([0x02]);
      expect(one('f32', -5)).toEqual([0xfb]);
      expect(one('f32', 145)).toEqual([0xcc, 0x91]);   // as the game writes it (CL12560)
      expect(one('f32', 70000)[0]).toBe(0xca);         // outside (-32768, 65535): stays a float
      expect(one('f32', 1.5)).toEqual([0xca, 0x3f, 0xc0, 0, 0]);
      expect(one('f64', 3)).toEqual([0x03]);
      expect(one('f64', 70000)).toEqual([0xce, 0, 1, 0x11, 0x70]);
      expect(one('f64', 1.5)).toEqual([0xca, 0x3f, 0xc0, 0, 0]);   // the game's choice; brdb writes 0xcb
      expect(one('f64', 0.1)[0]).toBe(0xcb);
      expect(one('f64', 1e10 + 1)[0]).toBe(0xcb);
    });
    it('keeps other ints in the smallest form', () => {
      expect(one('u16', 200)).toEqual([0xcc, 0xc8]);
      expect(one('i32', -200)).toEqual([0xd1, 0xff, 0x38]);
    });
  });

  it('handles map, variant, fixed-array and nil packed types', () => {
    const schema = parseSchema(mp([
      { EDir: ['A', 'B'] },
      { Var: ['f64', 'str', 'Vec2'] },
      {
        Vec2: { X: 'f32', Y: 'f32' },
        Root: { M: { str: 'Vec2' }, V: ['Var'], Fixed: ['u8', 3], P: ['u8', null], Q: ['u8', null], D: 'EDir' },
      },
    ]).done());
    const value = {
      M: new Map([['a', { X: 1, Y: 2.5 }], ['b', { X: -1, Y: 0 }]]),
      V: [{ variant: 0, type: 'f64', value: 0.25 }, { variant: 1, type: 'str', value: 'hi' }, { variant: 2, type: 'Vec2', value: { X: 3, Y: 4 } }],
      Fixed: [1, 200, 3], P: [9, 8], Q: [], D: 1,
    };
    const bytes = encodeMps(value, schema);
    const back = decodeMps<typeof value>(bytes, schema);
    expect(back).toEqual(value);
    expect(encodeMps(back, schema)).toEqual(bytes);
    // a packed array stored as nil comes back as nil
    const nilBytes = Uint8Array.from([...bytes.subarray(0, bytes.length - 3), 0xc0, 0x01]);
    const nilBack = decodeMps<typeof value>(nilBytes, schema);
    expect(nilBack.Q).toEqual([]);
    expect(encodeMps(nilBack, schema)).toEqual(nilBytes);
  });

  it('decodes SoA per-instance data runs', () => {
    const schema = parseSchema(mp([{}, {}, {
      Counter: { TypeIndex: 'u32', NumInstances: 'u32' },
      Data_A: { C: 'u8', F: 'f32' },
      BRSavedComponentChunkSoA: { ComponentTypeCounters: ['Counter'], ComponentBrickIndices: ['u32', null] },
    }]).done());
    const global = { ComponentDataStructNames: ['Data_A', 'None'] };
    const file = {
      root: { ComponentTypeCounters: [{ TypeIndex: 0, NumInstances: 2 }, { TypeIndex: 1, NumInstances: 1 }], ComponentBrickIndices: [0, 1, 2] },
      data: [
        { typeIndex: 0, struct: 'Data_A', value: { C: 255, F: 0.5 } },
        { typeIndex: 0, struct: 'Data_A', value: { C: 3, F: 2 } },
        { typeIndex: 1, struct: null, value: null },
      ],
    };
    const bytes = encodeSoa(file, schema);
    expect(decodeSoa(bytes, schema, global)).toEqual(file);
  });
});
