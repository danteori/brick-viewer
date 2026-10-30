// Entity proxies (backlog W-11): stand-in shapes for entities that are not brick grids. A ball is a
// sphere and a wheel is a cylinder with a hub disc, both our own simple meshes sized from the
// entity's `Scale`. Sizes are working values: the game's real dimensions are not measured yet.
// The wheel axle is the entity's local Z axis (checked against the axle direction of saved cars).
// Pure and DOM-free; src/render/proxies.ts draws the result.

import { linearByteToSrgb } from '../core/colour.ts';
import type { EntityRecord, Quat, Vec3 } from '../format/entities.ts';
import { rotate } from './grids.ts';

export type ProxyKind = 'sphere' | 'wheel';
export type Rgb = [r: number, g: number, b: number];

/** Radius of a ball at Scale 1, in Brickadia units. */
export const BALL_RADIUS = 10;
/** Radius and half width of a wheel at Scale 1, in Brickadia units. */
export const WHEEL_RADIUS = 12;
export const WHEEL_HALF_WIDTH = 5;
/** The hub disc: its radius as a fraction of the wheel's, and how far it stands out of each side. */
export const HUB_RADIUS = 0.6;
export const HUB_STANDOUT = 0.3;

export interface EntityProxy {
  id: number;
  kind: ProxyKind;
  centre: Vec3;
  rotation: Quat;
  scale: number;
  /** Colour slots 0 and 1 as display sRGB. */
  colours: [Rgb, Rgb];
}

const WHITE: Rgb = [1, 1, 1];

function slotColour(e: EntityRecord, slot: number): Rgb {
  const c = e.colors?.[slot];
  if (!c) return WHITE;
  const to = e.colorsAreLinear === false ? (v: number): number => v / 255 : linearByteToSrgb;
  return [to(c[0]), to(c[1]), to(c[2])];
}

export function proxyKindOf(type: string): ProxyKind | null {
  if (/^Entity_Ball/.test(type)) return 'sphere';
  if (/^Entity_Wheel/.test(type)) return 'wheel';
  return null;
}

/** The proxies of a save's entities (balls and wheels; brick-grid entities draw as bricks). */
export function entityProxies(entities: readonly EntityRecord[]): EntityProxy[] {
  const out: EntityProxy[] = [];
  for (const e of entities) {
    const kind = proxyKindOf(e.type);
    if (!kind) continue;
    const s = e.data?.Scale;
    out.push({
      id: e.persistentIndex, kind, centre: [...e.location], rotation: [...e.rotation],
      scale: typeof s === 'number' && s > 0 ? s : 1,
      colours: [slotColour(e, 0), slotColour(e, 1)],
    });
  }
  return out;
}

/** A mesh as interleaved position and normal (6 floats a vertex), triangles in order, GL axes. */
export interface ProxyMesh { data: Float32Array; count: number }

const SPHERE_STACKS = 14, SPHERE_SLICES = 24, CYLINDER_SEGMENTS = 28;

class Builder {
  readonly floats: number[] = [];
  constructor(private readonly q: Quat, private readonly unit: number) {}

  private point(v: Vec3): Vec3 {
    const r = rotate(this.q, v);
    return [r[0] * this.unit, r[2] * this.unit, r[1] * this.unit];
  }

  tri(a: Vec3, b: Vec3, c: Vec3, na: Vec3, nb: Vec3, nc: Vec3): void {
    const p = [this.point(a), this.point(b), this.point(c)], n = [this.point(na), this.point(nb), this.point(nc)];
    const u = [p[1]![0] - p[0]![0], p[1]![1] - p[0]![1], p[1]![2] - p[0]![2]], v = [p[2]![0] - p[0]![0], p[2]![1] - p[0]![1], p[2]![2] - p[0]![2]];
    const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const facing = cross[0]! * (n[0]![0] + n[1]![0] + n[2]![0]) + cross[1]! * (n[0]![1] + n[1]![1] + n[2]![1]) + cross[2]! * (n[0]![2] + n[1]![2] + n[2]![2]);
    const order = facing >= 0 ? [0, 1, 2] : [0, 2, 1];
    for (const i of order) this.floats.push(...p[i]!, ...n[i]!);
  }

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, na: Vec3, nb: Vec3, nc: Vec3, nd: Vec3): void {
    this.tri(a, b, c, na, nb, nc);
    this.tri(a, c, d, na, nc, nd);
  }

  done(): ProxyMesh { return { data: new Float32Array(this.floats), count: this.floats.length / 6 }; }
}

/** The sphere of a ball, centred on the origin, in viewer units, turned by `q`. */
export function sphereMesh(radius: number, q: Quat, unit: number): ProxyMesh {
  const b = new Builder(q, unit);
  const at = (i: number, j: number): [Vec3, Vec3] => {
    const th = Math.PI * i / SPHERE_STACKS, ph = 2 * Math.PI * j / SPHERE_SLICES;
    const n: Vec3 = [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
    return [[n[0] * radius, n[1] * radius, n[2] * radius], n];
  };
  for (let i = 0; i < SPHERE_STACKS; i++) {
    for (let j = 0; j < SPHERE_SLICES; j++) {
      const [p00, n00] = at(i, j), [p01, n01] = at(i, j + 1), [p10, n10] = at(i + 1, j), [p11, n11] = at(i + 1, j + 1);
      if (i > 0) b.tri(p00, p10, p01, n00, n10, n01);
      if (i < SPHERE_STACKS - 1) b.tri(p01, p10, p11, n01, n10, n11);
    }
  }
  return b.done();
}

/** A cylinder along local Z with flat caps, from z0 to z1. */
function cylinder(b: Builder, radius: number, z0: number, z1: number): void {
  const ring = (k: number): [number, number] => [Math.cos(2 * Math.PI * k / CYLINDER_SEGMENTS), Math.sin(2 * Math.PI * k / CYLINDER_SEGMENTS)];
  for (let k = 0; k < CYLINDER_SEGMENTS; k++) {
    const [c0, s0] = ring(k), [c1, s1] = ring(k + 1);
    const n0: Vec3 = [c0, s0, 0], n1: Vec3 = [c1, s1, 0];
    b.quad([c0 * radius, s0 * radius, z0], [c1 * radius, s1 * radius, z0], [c1 * radius, s1 * radius, z1], [c0 * radius, s0 * radius, z1], n0, n1, n1, n0);
    for (const [z, nz] of [[z0, -1], [z1, 1]] as const) {
      const n: Vec3 = [0, 0, nz];
      b.tri([0, 0, z], [c0 * radius, s0 * radius, z], [c1 * radius, s1 * radius, z], n, n, n);
    }
  }
}

/** The tyre of a wheel: radius `radius`, half width `half`, axle along local Z. */
export function wheelMesh(radius: number, half: number, q: Quat, unit: number): ProxyMesh {
  const b = new Builder(q, unit);
  cylinder(b, radius, -half, half);
  return b.done();
}

/** The hub of a wheel: a disc that stands out of both sides of the tyre. */
export function hubMesh(radius: number, half: number, q: Quat, unit: number): ProxyMesh {
  const b = new Builder(q, unit);
  const hub = radius * HUB_RADIUS, reach = half + HUB_STANDOUT * hub;
  cylinder(b, hub, -reach, reach);
  return b.done();
}

/** The meshes of one proxy: its body (colour slot 0) and, for a wheel, its hub (colour slot 1). */
export function proxyMeshes(p: EntityProxy, unit: number): { body: ProxyMesh; hub: ProxyMesh | null } {
  if (p.kind === 'sphere') return { body: sphereMesh(BALL_RADIUS * p.scale, p.rotation, unit), hub: null };
  const r = WHEEL_RADIUS * p.scale, h = WHEEL_HALF_WIDTH * p.scale;
  return { body: wheelMesh(r, h, p.rotation, unit), hub: hubMesh(r, h, p.rotation, unit) };
}
