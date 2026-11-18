// Tonalités : stockage canonique (classe de hauteur 0–11 + mode), affichage selon la notation choisie.

export type Mode = 'major' | 'minor';
export type Notation = 'auto' | 'sharps' | 'flats';

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
// Écriture usuelle (celle des partitions et des logiciels de MAO).
const USUAL_MAJOR = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const USUAL_MINOR = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

export function formatKey(pc: number | null | undefined, mode: Mode | null | undefined, notation: Notation = 'auto') {
  if (pc == null || mode == null) return null;
  const table = notation === 'flats' ? FLATS : notation === 'sharps' ? SHARPS : mode === 'major' ? USUAL_MAJOR : USUAL_MINOR;
  const name = table[((pc % 12) + 12) % 12];
  return `${name} ${mode === 'major' ? 'maj' : 'min'}`;
}

/** Comprend « Am », « A min », « A minor », « F#m », « Gb maj », « C », « la mineur »… */
export function parseKey(input: string): { pc: number; mode: Mode } | null {
  const s = input.trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  if (!s) return null;
  const fr: Record<string, string> = { do: 'C', re: 'D', ré: 'D', mi: 'E', fa: 'F', sol: 'G', la: 'A', si: 'B' };
  const m = /^(do|ré|re|mi|fa|sol|la|si|[A-Ga-g])\s*(dièse|diese|bémol|bemol|#|b)?\s*(.*)$/i.exec(s);
  if (!m) return null;
  const letter = (fr[m[1].toLowerCase()] ?? m[1]).toUpperCase();
  let pc = SHARPS.indexOf(letter);
  if (pc < 0) return null;
  const acc = (m[2] ?? '').toLowerCase();
  if (acc === '#' || acc.startsWith('di')) pc += 1;
  if (acc === 'b' || acc.startsWith('bé') || acc.startsWith('be')) pc -= 1;
  const rest = m[3].trim().toLowerCase();
  let mode: Mode;
  if (rest === '' || /^(maj|major|majeur|M)$/.test(m[3].trim())) mode = 'major';
  else if (/^(m|min|minor|mineur|-)$/.test(rest)) mode = 'minor';
  else return null;
  return { pc: ((pc % 12) + 12) % 12, mode };
}
