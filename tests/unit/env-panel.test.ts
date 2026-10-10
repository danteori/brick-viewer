// The environment panel's layout and value display follow the game's Environment menu (U-17).
import { describe, expect, it } from 'vitest';
import { fromShown, SECTIONS, shownText, toShown } from '../../src/ui/panels/environment.ts';
import { GROUP_DEFAULTS, type GroupName } from '../../src/format/environment.ts';

describe('environment panel layout', () => {
  it('has the game\'s sections in the game\'s order (Universe for Space, Advanced last)', () => {
    expect(SECTIONS.map((s) => s.title)).toEqual(['Sky', 'Sky - Night', 'Weather', 'Fog', 'Ground', 'Water', 'Universe', 'Ambience', 'Advanced']);
  });

  it('lists the Sky and Weather rows in the game\'s order and words', () => {
    const labels = (id: string): string[] => SECTIONS.find((s) => s.id === id)!.rows.map((r) => r.label);
    expect(labels('sky')).toEqual(['Time of Day', 'Animate Time of Day', 'Day Length', 'Night Length', 'Sun Angle', 'Sun Scale',
      'Sun Horizon Scale', 'Sunlight Color', 'Sky Intensity', 'Sky Color']);
    expect(labels('weather')).toEqual(['Cloud Coverage', 'Rain', 'Snow', 'Dust', 'Thunder', 'Wind', 'Wind Angle', 'Close Lightning',
      'Rain Volume', 'Close Thunder Volume', 'Distant Thunder Volume', 'Wind Volume']);
    expect(labels('ground')).toEqual(['Pattern Intensity', 'Pattern Size', 'Ground Primary Color', 'Ground Accent Color', 'Is Visible', 'Stud Texture']);
    expect(labels('ambience')).toEqual(['Ambience', 'Ambience Volume', 'Reverb Effect']);
  });

  it('shows every setting exactly once, Cloud Speed only under Advanced', () => {
    const seen = SECTIONS.flatMap((s) => s.rows.map((r) => `${r.g}.${r.key}`));
    expect(new Set(seen).size).toBe(seen.length);
    for (const g of ['sky', 'water', 'groundPlate', 'ambience', 'universe'] as GroupName[]) {
      for (const k of Object.keys(GROUP_DEFAULTS[g])) expect(seen).toContain(`${g}.${k}`);
    }
    expect(SECTIONS.find((s) => s.id === 'advanced')!.rows.map((r) => r.key)).toEqual(['cloudSpeedMultiplier']);
    expect(SECTIONS.every((s) => s.rows.every((r) => !/colour/.test(r.label)))).toBe(true);
  });

  it('writes values as the game does', () => {
    expect(shownText(0.3, 'pct')).toBe('30%');
    expect(shownText(0.85, 'pct')).toBe('85%');
    expect(shownText(9.6, 'hr')).toBe('9.6hr');
    expect(shownText(30, 'min')).toBe('30min');
    expect(shownText(300, 'deg')).toBe('300°');
    expect(shownText(1, 'x')).toBe('1x');
    expect(shownText(0.4, 'x')).toBe('0.4x');
    expect(toShown(0.25, 'pct')).toBe(25);
    expect(fromShown(300, 'pct')).toBe(3);
    expect(fromShown(12, 'hr')).toBe(12);
  });
});
