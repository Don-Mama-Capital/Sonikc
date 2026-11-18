/**
 * Lecture CSV tolérante pour l'import de contacts : séparateur « , » ou « ; » (détecté), guillemets,
 * fin de ligne Windows, BOM. En-têtes français ou anglais ; sans en-tête, la colonne qui contient un « @ » est l'email.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
const EMAIL = ['email', 'mail', 'courriel', 'adresse', 'adressemail', 'emailaddress'];
const NAME = ['nom', 'name', 'prenom', 'fullname', 'nomcomplet', 'contact', 'artiste', 'firstname'];
const LAST = ['lastname', 'nomdefamille'];
const TAGS = ['tags', 'tag', 'etiquettes', 'etiquette', 'labels', 'categorie', 'groupe'];

export type ParsedContact = { line: number; email: string; name: string | null; tags: string[] };
export type InvalidLine = { line: number; reason: string };

export function contactsFromCsv(text: string): { contacts: ParsedContact[]; invalid: InvalidLine[] } {
  const rows = parseCsv(text);
  if (!rows.length) return { contacts: [], invalid: [] };
  const header = rows[0].map(norm);
  const hasHeader = header.some((h) => EMAIL.includes(h)) && !rows[0].some((c) => c.includes('@'));
  let iEmail = hasHeader ? header.findIndex((h) => EMAIL.includes(h)) : -1;
  const iName = hasHeader ? header.findIndex((h) => NAME.includes(h)) : -1;
  const iLast = hasHeader ? header.findIndex((h) => LAST.includes(h)) : -1;
  const iTags = hasHeader ? header.findIndex((h) => TAGS.includes(h)) : -1;
  const body = hasHeader ? rows.slice(1) : rows;
  if (iEmail < 0) iEmail = Math.max(0, (body[0] ?? []).findIndex((c) => c.includes('@')));
  const contacts: ParsedContact[] = [];
  const invalid: InvalidLine[] = [];
  body.forEach((r, k) => {
    const line = k + (hasHeader ? 2 : 1);
    const email = (r[iEmail] ?? '').toLowerCase().replace(/^mailto:/, '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) { invalid.push({ line, reason: email ? `adresse invalide : ${email.slice(0, 60)}` : 'adresse manquante' }); return; }
    let name: string | null = [iName >= 0 ? r[iName] : '', iLast >= 0 ? r[iLast] : ''].filter(Boolean).join(' ').trim() || null;
    if (!hasHeader && name === null) name = r.filter((_, j) => j !== iEmail).find((c) => c && !c.includes('@')) ?? null;
    const tags = iTags >= 0 ? splitTags(r[iTags] ?? '') : [];
    name = name ? name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || null : null;
    contacts.push({ line, email, name, tags });
  });
  return { contacts, invalid };
}

export const splitTags = (s: string) =>
  [...new Set(s.split(/[|,;/]/).map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 30);
