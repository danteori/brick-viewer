import { describe, expect, it } from 'vitest';
import { ByteBuf, arrayHeader, pack } from '../../src/format/msgpack.ts';
import { decodeMps, encodeMps, parseSchema, schemaPathFor } from '../../src/format/schema.ts';

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
});
