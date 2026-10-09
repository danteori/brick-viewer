// A component catalogue built at run time from saves (backlog C-02 / C-03 support).
//
// Feed it any number of saves; it records, per component type, the data struct, each field's
// schema type and the values seen (the most common one is the practical default), and the ports
// its wires use (as source = output, as target = input). Everything comes from the saves' own
// schemas and GlobalData name lists. No table is shipped with the app.
//
//   const b = new CatalogueBuilder();
//   for (const files of saves) b.add(files);
//   const cat = b.result();
//   loadWires(files, { ports: portLookup(cat) });

import type { FileMap } from '../format/brz.ts';
import { describeType, saveContext, typeText, ComponentStore, type EditorKind, type LoadOptions } from './components.ts';
import { WireGraph, type PortLookup } from './wires.ts';

export interface CatalogueField {
  name: string;
  /** Schema type(s) seen for this field, with how many instances used each. */
  types: Record<string, number>;
  kind: EditorKind;
  /** Most common values (JSON text), most common first. */
  values: { value: string; count: number }[];
  /** Distinct values seen (capped: see CatalogueBuilder). */
  distinct: number;
}

export interface CatalogueEntry {
  type: string;
  /** Data struct names seen ("None" types have none). */
  structs: Record<string, number>;
  instances: number;
  saves: number;
  fields: CatalogueField[];
  /** Port name -> wires seen using it. */
  inputs: Record<string, number>;
  outputs: Record<string, number>;
}

export interface Catalogue {
  saves: number;
  types: Record<string, CatalogueEntry>;
}

/** JSON text for any decoded value (Maps as entry lists, 64-bit bigints as "123n"). */
export function valueText(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) => (v instanceof Map ? { $map: [...v] } : typeof v === 'bigint' ? `${v}n` : v)) ?? 'undefined';
}

interface FieldAcc { types: Map<string, number>; kind: EditorKind; values: Map<string, number>; overflow: boolean }
interface EntryAcc { structs: Map<string, number>; instances: number; saves: number; fields: Map<string, FieldAcc>; inputs: Map<string, number>; outputs: Map<string, number> }

const bump = <K>(m: Map<K, number>, k: K, n = 1): void => {
  m.set(k, (m.get(k) ?? 0) + n);
};

export class CatalogueBuilder {
  private readonly entries = new Map<string, EntryAcc>();
  private saves = 0;

  /** `maxDistinct`: distinct values tracked per field before the rest are only counted. */
  constructor(private readonly maxDistinct = 256) {}

  private entry(type: string): EntryAcc {
    let e = this.entries.get(type);
    if (!e) this.entries.set(type, (e = { structs: new Map(), instances: 0, saves: 0, fields: new Map(), inputs: new Map(), outputs: new Map() }));
    return e;
  }

  /** Adds one save. Returns how many component instances and wires it contributed. */
  add(files: FileMap, opts: LoadOptions = {}): { components: number; wires: number } {
    const ctx = saveContext(files, opts);
    const store = new ComponentStore(ctx);
    const graph = new WireGraph(ctx, { components: store });
    this.saves++;
    const seen = new Set<string>();
    for (const c of store.instances) {
      const e = this.entry(c.type);
      e.instances++;
      if (!seen.has(c.type)) { seen.add(c.type); e.saves++; }
      bump(e.structs, c.struct ?? 'None');
      if (!c.struct || !c.data) continue;
      for (const [f, ft] of c.chunk.schema.S.get(c.struct) ?? []) {
        let fa = e.fields.get(f);
        if (!fa) e.fields.set(f, (fa = { types: new Map(), kind: describeType(c.chunk.schema, ft, f, ctx.global).kind, values: new Map(), overflow: false }));
        bump(fa.types, typeText(ft));
        const v = valueText(c.data[f]);
        if (fa.values.has(v) || fa.values.size < this.maxDistinct) bump(fa.values, v);
        else fa.overflow = true;
      }
    }
    for (const w of graph.wires()) {
      bump(this.entry(w.source.component).outputs, w.source.port);
      bump(this.entry(w.target.component).inputs, w.target.port);
    }
    return { components: store.instances.length, wires: graph.size };
  }

  result(topValues = 5): Catalogue {
    const types: Record<string, CatalogueEntry> = {};
    const obj = (m: Map<string, number>): Record<string, number> => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
    for (const [type, e] of [...this.entries].sort((a, b) => a[0].localeCompare(b[0]))) {
      types[type] = {
        type, structs: obj(e.structs), instances: e.instances, saves: e.saves,
        fields: [...e.fields].map(([name, f]) => ({
          name, types: obj(f.types), kind: f.kind,
          values: [...f.values].sort((a, b) => b[1] - a[1]).slice(0, topValues).map(([value, count]) => ({ value, count })),
          distinct: f.values.size + (f.overflow ? 1 : 0),
        })),
        inputs: obj(e.inputs), outputs: obj(e.outputs),
      };
    }
    return { saves: this.saves, types };
  }
}

/** Port knowledge from a catalogue, for loadWires({ ports }). */
export function portLookup(cat: Catalogue): PortLookup {
  return (type) => {
    const e = cat.types[type];
    return e && { inputs: Object.keys(e.inputs), outputs: Object.keys(e.outputs) };
  };
}
