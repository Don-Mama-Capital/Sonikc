import { describe, expect, it } from 'vitest';
import { formatKey, parseKey } from '@/lib/audio/keys';

describe('Tonalités', () => {
  it('écriture usuelle par défaut pour les 24 tonalités', () => {
    const major = Array.from({ length: 12 }, (_, pc) => formatKey(pc, 'major'));
    const minor = Array.from({ length: 12 }, (_, pc) => formatKey(pc, 'minor'));
    expect(major).toEqual(['C maj', 'Db maj', 'D maj', 'Eb maj', 'E maj', 'F maj', 'F# maj', 'G maj', 'Ab maj', 'A maj', 'Bb maj', 'B maj']);
    expect(minor).toEqual(['C min', 'C# min', 'D min', 'Eb min', 'E min', 'F min', 'F# min', 'G min', 'G# min', 'A min', 'Bb min', 'B min']);
  });

  it('dièses ou bémols forcés au choix, une seule notation à la fois', () => {
    expect(formatKey(3, 'major', 'sharps')).toBe('D# maj');
    expect(formatKey(3, 'major', 'flats')).toBe('Eb maj');
    for (let pc = 0; pc < 12; pc++) {
      expect(formatKey(pc, 'minor', 'sharps')).not.toMatch(/b /);
      expect(formatKey(pc, 'minor', 'flats')).not.toMatch(/#/);
    }
  });

  it('la saisie libre est comprise, quelle que soit l’écriture', () => {
    for (const [txt, pc, mode] of [['Am', 9, 'minor'], ['F#m', 6, 'minor'], ['Gb min', 6, 'minor'], ['Eb maj', 3, 'major'], ['C', 0, 'major'], ['la mineur', 9, 'minor'], ['si bémol majeur', 10, 'major']] as const) {
      expect(parseKey(txt)).toEqual({ pc, mode });
    }
    expect(parseKey('H')).toBeNull();
    expect(parseKey('A dorien')).toBeNull();
  });
});
