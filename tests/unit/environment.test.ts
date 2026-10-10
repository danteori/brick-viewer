import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  completeEnvironment, defaultEnvironment, environmentForKind, environmentFromWorld, EnvironmentError, formatUeNumber, hexToLinear,
  linearToHex, parseEnvironment, parseWorldKind, serialiseEnvironment, setEnvValue, GROUP_DEFAULTS,
} from '../../src/format/environment.ts';
import { REFS } from './refs.ts';

const f = Math.fround;
const CRLF = (s: string): string => s.replace(/\r?\n/g, '\r\n');

describe('formatUeNumber (%.17g)', () => {
  it.each([
    [0, '0'], [-0, '-0'], [1, '1'], [30, '30'], [-42, '-42'], [12345, '12345'],
    [f(2.3), '2.2999999523162842'], [f(0.07), '0.070000000298023224'], [f(0.35), '0.34999999403953552'],
    [f(3e-6), '3.0000001061125658e-06'], [f(0.0003), '0.00030000001424923539'], [0.25, '0.25'],
    [f(123.0009765625), '123.0009765625'], [1e20, '1e+20'], [f(2.5e-5), '2.4999999368446879e-05'],
  ])('%s -> %s', (n, s) => {
    expect(formatUeNumber(n)).toBe(s);
    expect(Number(s)).toBe(n);
  });
});

// A synthetic preset in the game's layout (tab indent, CRLF, no final newline), lacking some keys.
const SYNTH = CRLF(`{
\t"formatVersion": "1",
\t"presetVersion": "1",
\t"type": "Environment",
\t"data":
\t{
\t\t"groups":
\t\t{
\t\t\t"sky":
\t\t\t{
\t\t\t\t"timeOfDay": 13.5,
\t\t\t\t"sunlightColor":
\t\t\t\t{
\t\t\t\t\t"r": 1,
\t\t\t\t\t"g": 0.5,
\t\t\t\t\t"b": 0.25,
\t\t\t\t\t"a": 1
\t\t\t\t},
\t\t\t\t"cloudCoverage": 0.10000000149011612,
\t\t\t\t"futureKey": "kept"
\t\t\t},
\t\t\t"groundPlate":
\t\t\t{
\t\t\t\t"isVisible": false
\t\t\t},
\t\t\t"someNewGroup":
\t\t\t{
\t\t\t\t"x": 1
\t\t\t}
\t\t}
\t}
}`).replace(/\r\n$/, '');

describe('parse / serialise', () => {
  it('round-trips a partial synthetic file byte for byte', () => {
    const env = parseEnvironment(SYNTH);
    expect(env.groups.sky!.timeOfDay).toBe(13.5);
    expect(env.groups.sky!.sunScale).toBe(GROUP_DEFAULTS.sky.sunScale);
    expect(env.groups.groundPlate!.isVisible).toBe(false);
    expect(env.extras.sky).toEqual({ futureKey: 'kept' });
    expect(env.extraGroups).toEqual({ someNewGroup: { x: 1 } });
    expect(env.absent.sky).toContain('dayLength');
    expect(serialiseEnvironment(env, { complete: false })).toBe(SYNTH);
  });

  it('complete output has every key, in order, and re-parses equal', () => {
    const env = parseEnvironment(SYNTH);
    const full = serialiseEnvironment(env);
    const keys = Object.keys((JSON.parse(full) as { data: { groups: { sky: object } } }).data.groups.sky);
    expect(keys.slice(0, -1)).toEqual(Object.keys(GROUP_DEFAULTS.sky));
    expect(keys.at(-1)).toBe('futureKey');
    const again = parseEnvironment(full);
    expect(again.groups).toEqual(env.groups);
    expect(serialiseEnvironment(again)).toBe(full);
  });

  it('default environments round-trip', () => {
    for (const kind of ['Plate', 'Space'] as const) {
      const text = serialiseEnvironment(defaultEnvironment(kind));
      expect(text.startsWith('{\r\n\t"formatVersion": "1",')).toBe(true);
      expect(text.endsWith('\r\n}')).toBe(true);
      expect(serialiseEnvironment(parseEnvironment(text), { complete: false })).toBe(text);
    }
    expect(Object.keys(defaultEnvironment('Space').groups)).toEqual(['universe', 'ambience']);
  });

  it('accepts bytes with a BOM, and rejects other presets', () => {
    const bytes = new TextEncoder().encode('\uFEFF' + SYNTH);
    expect(parseEnvironment(bytes).groups.sky!.timeOfDay).toBe(13.5);
    expect(() => parseEnvironment('{"type":"ColorPalette","data":{"groups":[]}}')).toThrow(EnvironmentError);
    expect(() => parseEnvironment('nope')).toThrow(EnvironmentError);
  });

  it('wrong-typed values keep the default and are preserved', () => {
    const env = parseEnvironment({ type: 'Environment', data: { groups: { sky: { timeOfDay: 'noon' } } } });
    expect(env.groups.sky!.timeOfDay).toBe(GROUP_DEFAULTS.sky.timeOfDay);
    expect(env.extras.sky).toEqual({ timeOfDay: 'noon' });
  });

  it('setEnvValue marks a key present', () => {
    let env = parseEnvironment(SYNTH);
    env = setEnvValue(env, 'sky', 'dayLength', GROUP_DEFAULTS.sky.dayLength);
    expect(serialiseEnvironment(env, { complete: false })).toContain('"dayLength": ');
    expect(parseEnvironment(SYNTH).groups.sky!.dayLength).toBe(GROUP_DEFAULTS.sky.dayLength);   // input untouched
  });

  it('completeEnvironment adds the groups a world kind needs', () => {
    const env = completeEnvironment(parseEnvironment(SYNTH), 'Plate');
    expect(Object.keys(env.groups).sort()).toEqual(['ambience', 'groundPlate', 'sky', 'water']);
    expect(serialiseEnvironment(env, { complete: false })).toBe(SYNTH.replace(
      '\t\t\t"someNewGroup"', '\t\t\t"water":\r\n\t\t\t{\r\n\t\t\t},\r\n\t\t\t"ambience":\r\n\t\t\t{\r\n\t\t\t},\r\n\t\t\t"someNewGroup"'));
  });
});

describe('environmentForKind', () => {
  it('keeps only the groups a world kind stores, plus unknown groups', () => {
    const env = environmentForKind(parseEnvironment(SYNTH), 'Space');
    expect(Object.keys(env.groups).sort()).toEqual(['ambience', 'universe']);
    expect(env.extraGroups).toEqual({ someNewGroup: { x: 1 } });
    expect(env.extras.sky).toBeUndefined();
  });
});

describe('older presets', () => {
  const OLD = {
    formatVersion: '1', presetVersion: '1', type: 'Environment',
    data: {
      groups: {
        Sky: { timeOfDay: 8, timeChangeSpeed: 0, weatherIntensity: 0.8, rainSnow: 1, cloudSpeedMultiplier: 2, precipitationParticleAmount: 1 },
        GroundPlate: { isVisible: true, groundColor: { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
        Ambience: { selectedAmbienceTypeInt: 0, ambienceVolume: 0.5, reverbEffect: 'Default' },
      },
    },
  };
  it('maps capitalised groups and old keys to the modern shape', () => {
    const env = parseEnvironment(OLD);
    expect(Object.keys(env.groups)).toEqual(['sky', 'groundPlate', 'ambience']);
    const sky = env.groups.sky!;
    expect(sky.snow).toBeCloseTo(0.8);
    expect(sky.rain).toBe(0);
    expect(sky.animateTimeOfDay).toBe(false);
    expect(sky.cloudSpeedMultiplier).toBe(2);
    expect(env.groups.ambience!.selectedAmbienceType).toBe('None');
    expect(env.legacy.sky).toEqual({ timeChangeSpeed: 0, weatherIntensity: 0.8, rainSnow: 1 });
    expect(env.extras.sky).toEqual({ precipitationParticleAmount: 1 });
    const out = serialiseEnvironment(env);
    expect(out).toContain('"sky":');
    expect(out).not.toContain('"Sky"');
    expect(out).not.toContain('weatherIntensity');
    expect(out).toContain('"precipitationParticleAmount": 1');
  });
  it('maps the oldest key names', () => {
    const env = parseEnvironment({ data: { groups: { Sky: { sunAzimuth: 292, skyLightIntensity: 2, moonLightIntensity: 2, fogDensity: 0.08, fogHeightFalloff: 1, fogStartHeight: 263 } } } });
    const sky = env.groups.sky!;
    expect([sky.sunAngle, sky.skyIntensity, sky.moonlightIntensity, sky.clearFogDensity, sky.clearFogHeightFalloff]).toEqual([292, 2, 2, 0.08, 1]);
    expect(env.extras.sky).toEqual({ fogStartHeight: 263 });
  });
  it('a modern key wins over its old alias', () => {
    const env = parseEnvironment({ data: { groups: { sky: { sunAzimuth: 10, sunAngle: 20 } } } });
    expect(env.groups.sky!.sunAngle).toBe(20);
    expect(env.extras.sky).toEqual({ sunAzimuth: 10 });
  });
});

describe('colours and worlds', () => {
  it('linear <-> hex', () => {
    expect(linearToHex({ r: 1, g: 0, b: 0.2158605, a: 1 })).toBe('#ff0080');
    const c = hexToLinear('#ff0080');
    expect(linearToHex(c)).toBe('#ff0080');
  });
  it('reads a world file tree', () => {
    const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
    const files = new Map([['Meta/World.json', enc('{\r\n\t"environment": "Space"\r\n}')], ['World/0/Environment.bp', enc(serialiseEnvironment(defaultEnvironment('Space')))]]);
    const w = environmentFromWorld(files);
    expect(w.kind).toBe('Space');
    expect(w.env!.groups.universe).toBeTruthy();
    expect(environmentFromWorld(new Map()).env).toBeNull();
    expect(parseWorldKind('garbage')).toBeNull();
  });
});

// Real presets, read at test time from the private reference folder (never committed). Modern files
// must round-trip byte for byte; older ones must re-parse to the same values. BRICK_ENV_DIR can
// point at any other folder of presets for a wider sweep.
const dirs = [join(REFS, 'environments'), process.env.BRICK_ENV_DIR].filter((d): d is string => !!d && existsSync(d));
const files = dirs.flatMap((d) => readdirSync(d).filter((n) => n.toLowerCase().endsWith('.bp')).map((n) => join(d, n)));
describe.skipIf(!files.length)('reference presets', () => {
  it(`round-trip (${files.length} files)`, () => {
    let exact = 0;
    for (const p of files) {
      const text = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      const env = parseEnvironment(text);
      const modern = !Object.keys(env.legacy).length && Object.keys((JSON.parse(text) as { data: { groups: object } }).data.groups).every((g) => g === g.toLowerCase().replace('groundplate', 'groundPlate'));
      const out = serialiseEnvironment(env, { complete: false });
      if (modern) { expect(out, p).toBe(text); exact++; }
      const again = parseEnvironment(out);
      expect(again.groups, p).toEqual(env.groups);
      expect(again.extras, p).toEqual(env.extras);
      expect(again.extraGroups, p).toEqual(env.extraGroups);
    }
    expect(exact).toBeGreaterThan(0);
  });
});

// The built-in defaults are the game's stock default environment: some reference preset holds
// exactly these values (every Plate group; cloudSpeedMultiplier is ours, the game's file lacks it).
describe.skipIf(!files.length)('built-in default', () => {
  it('equals a reference stock default preset', () => {
    const want = defaultEnvironment('Plate').groups;
    const match = files.some((p) => {
      const g = parseEnvironment(readFileSync(p, 'utf8')).groups;
      const sky = g.sky ? { ...g.sky, cloudSpeedMultiplier: want.sky!.cloudSpeedMultiplier } : undefined;
      try { expect({ ...g, sky }).toEqual(want); return true; } catch { return false; }
    });
    expect(match).toBe(true);
  });
});
