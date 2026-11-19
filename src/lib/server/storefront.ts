import { z } from 'zod';
import { withPublic, withUser, type Tx } from './db';
import { Invalid, NotFound } from './library';
import { normalizeHandle } from '../handle';
import { withVat } from '@/config/vat';
import { hmac, safeEqualStr } from './crypto';

/** Page publique (lot 4.1) et licences (lot 4.2). */

const uuid = z.string().uuid();
const cents = z.number().int().min(100).max(10_000_000);

// ───────── Modèles de licence (propriétaire) ─────────

const templateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(1000).default(''),
  formats: z.array(z.enum(['mp3', 'wav', 'stems'])).min(1).max(3),
  maxStreams: z.number().int().positive().nullable(),
  maxCopies: z.number().int().positive().nullable(),
  musicVideos: z.number().int().min(0).nullable(),
  radio: z.boolean(),
  exclusive: z.boolean(),
  priceCents: cents,
  active: z.boolean().default(true),
});
export type TemplateInput = z.infer<typeof templateSchema>;

/** Proposés au premier passage, puis entièrement modifiables. */
const DEFAULTS: TemplateInput[] = [
  { name: 'Basique', description: 'Pour tester un morceau et le sortir en indépendant.', formats: ['mp3'], maxStreams: 50000, maxCopies: 2000, musicVideos: 1, radio: false, exclusive: false, priceCents: 2900, active: true },
  { name: 'Premium', description: 'Qualité studio pour une sortie sérieuse.', formats: ['mp3', 'wav'], maxStreams: 500000, maxCopies: 10000, musicVideos: 2, radio: true, exclusive: false, priceCents: 5900, active: true },
  { name: 'Exclusive', description: 'Le morceau est à toi seul : il est retiré de la vente.', formats: ['mp3', 'wav'], maxStreams: null, maxCopies: null, musicVideos: null, radio: true, exclusive: true, priceCents: 49900, active: true },
];

const tplCols = (tx: Tx) => tx`lt.id, lt.name, lt.description, lt.formats, lt.max_streams as "maxStreams", lt.max_copies as "maxCopies",
  lt.music_videos as "musicVideos", lt.radio, lt.exclusive, lt.price_cents as "priceCents", lt.active, lt.position`;

export type Template = TemplateInput & { id: string; position: number };

export async function listTemplates(userId: string) {
  return withUser(userId, async (tx) => {
    let rows = await tx<Template[]>`select ${tplCols(tx)} from licence_templates lt order by lt.position, lt.created_at`;
    if (!rows.length) {
      for (const [i, d] of DEFAULTS.entries()) {
        await tx`insert into licence_templates (owner_id, name, description, formats, max_streams, max_copies, music_videos, radio, exclusive, price_cents, position)
          values (${userId}, ${d.name}, ${d.description}, ${d.formats}, ${d.maxStreams}, ${d.maxCopies}, ${d.musicVideos}, ${d.radio}, ${d.exclusive}, ${d.priceCents}, ${i})`;
      }
      rows = await tx<Template[]>`select ${tplCols(tx)} from licence_templates lt order by lt.position, lt.created_at`;
    }
    return rows;
  });
}

export async function saveTemplate(userId: string, id: string | null, raw: unknown) {
  const t = templateSchema.parse(raw);
  return withUser(userId, async (tx) => {
    if (id) {
      uuid.parse(id);
      const r = await tx`update licence_templates set name = ${t.name}, description = ${t.description}, formats = ${t.formats},
        max_streams = ${t.maxStreams}, max_copies = ${t.maxCopies}, music_videos = ${t.musicVideos}, radio = ${t.radio},
        exclusive = ${t.exclusive}, price_cents = ${t.priceCents}, active = ${t.active} where id = ${id}`;
      if (!r.count) throw new NotFound();
      return { id };
    }
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from licence_templates`;
    if (n >= 20) throw new Invalid('20 licences au plus.');
    const [r] = await tx<{ id: string }[]>`insert into licence_templates (owner_id, name, description, formats, max_streams, max_copies, music_videos, radio, exclusive, price_cents, position)
      values (${userId}, ${t.name}, ${t.description}, ${t.formats}, ${t.maxStreams}, ${t.maxCopies}, ${t.musicVideos}, ${t.radio}, ${t.exclusive}, ${t.priceCents}, ${n}) returning id`;
    return r;
  });
}

/** Une licence déjà vendue reste en base (les commandes y renvoient) : on la désactive au lieu de la supprimer. */
export async function deleteTemplate(userId: string, id: string) {
  uuid.parse(id);
  await withUser(userId, async (tx) => {
    const r = await tx`update licence_templates set active = false where id = ${id}`;
    if (!r.count) throw new NotFound();
  });
}

export async function setTrackLicence(userId: string, trackId: string, templateId: string, raw: { enabled?: unknown; priceCents?: unknown }) {
  uuid.parse(trackId); uuid.parse(templateId);
  const enabled = z.boolean().parse(raw.enabled ?? true);
  const price = raw.priceCents == null ? null : cents.parse(raw.priceCents);
  await withUser(userId, (tx) => tx`insert into track_licences (track_id, template_id, owner_id, enabled, price_cents)
    values (${trackId}, ${templateId}, ${userId}, ${enabled}, ${price})
    on conflict (track_id, template_id) do update set enabled = excluded.enabled, price_cents = excluded.price_cents`);
}

// ───────── Licences en vente d'un morceau ─────────

/** En vente : réglé sur le morceau, ou morceau sans réglage propre dans un projet en vente (sans mot de passe). */
const forSaleExpr = (tx: Tx) => tx`(t.password_hash is null and (t.visibility = 'for_sale' or (t.visibility is null and exists (
  select 1 from project_tracks pt join projects p on p.id = pt.project_id
  where pt.track_id = t.id and p.visibility = 'for_sale' and p.password_hash is null))))`;

export type Offer = Template & { finalPriceCents: number };

/**
 * Licences proposées pour un morceau : modèles actifs non désactivés pour ce morceau ; aucune si l'exclusivité
 * est vendue ; l'exclusive masquée pendant qu'un autre paiement la réserve ; les stems ne sont pas encore livrables.
 */
export async function trackOffers(tx: Tx, trackId: string): Promise<Offer[]> {
  const [t] = await tx<{ ownerId: string; forSale: boolean; soldAt: Date | null; reservedUntil: Date | null }[]>`
    select t.owner_id as "ownerId", ${forSaleExpr(tx)} as "forSale", t.exclusive_sold_at as "soldAt", t.exclusive_reserved_until as "reservedUntil"
    from tracks t where t.id = ${trackId}`;
  if (!t || !t.forSale || t.soldAt) return [];
  const rows = await tx<(Template & { override: number | null; enabled: boolean | null })[]>`
    select ${tplCols(tx)}, tl.price_cents as override, tl.enabled
    from licence_templates lt left join track_licences tl on tl.template_id = lt.id and tl.track_id = ${trackId}
    where lt.owner_id = ${t.ownerId} and lt.active order by lt.position, lt.created_at`;
  const reserved = t.reservedUntil && t.reservedUntil.getTime() > Date.now();
  return rows
    .filter((r) => r.enabled !== false && !r.formats.includes('stems') && !(r.exclusive && reserved))
    .map(({ override, enabled: _e, ...r }) => ({ ...r, finalPriceCents: override ?? r.priceCents }));
}

// ───────── Page publique ─────────

const filtersSchema = z.object({
  q: z.string().trim().max(80).optional(),
  bpmMin: z.coerce.number().min(20).max(300).optional(),
  bpmMax: z.coerce.number().min(20).max(300).optional(),
  key: z.string().regex(/^(1[01]|[0-9])-(major|minor)$/).optional(),
  priceMax: z.coerce.number().min(0).max(100000).optional(), // en euros TTC (France)
  project: z.string().uuid().optional(),
});
export type StoreFilters = z.infer<typeof filtersSchema>;

export function publicAudioPath(versionId: string, ttlS = 2 * 3600, now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttlS;
  return `/api/pub/${versionId}?exp=${exp}&sig=${hmac(`pub:${versionId}:${exp}`)}`;
}
export function verifyPublicAudio(versionId: string, exp: string | null, sig: string | null, now = Date.now()) {
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) * 1000 < now) return false;
  return safeEqualStr(sig, hmac(`pub:${versionId}:${exp}`));
}

export async function storefront(rawHandle: string, rawFilters: Record<string, unknown> = {}) {
  const handle = normalizeHandle(rawHandle);
  const f = filtersSchema.safeParse(Object.fromEntries(Object.entries(rawFilters).filter(([, v]) => v !== '' && v != null)));
  const filters: StoreFilters = f.success ? f.data : {};
  return withPublic(async (tx) => {
    const [p] = await tx<{ userId: string; handle: string; displayName: string; bio: string; links: Record<string, string> }[]>`
      select user_id as "userId", handle, display_name as "displayName", bio, links from profiles where lower(handle) = ${handle}`;
    if (!p) return null;
    const projects = await tx<{ id: string; title: string; n: number }[]>`
      select p.id, p.title, (select count(*)::int from project_tracks pt join tracks t on t.id = pt.track_id where pt.project_id = p.id) as n
      from projects p where p.owner_id = ${p.userId} order by p.created_at desc`;
    const [kpc, kmode] = filters.key ? filters.key.split('-') : [];
    const q = filters.q?.toLowerCase().replace(/[%_\\]/g, '\\$&');
    const rows = await tx<{ id: string; title: string; bpm: number | null; keyPc: number | null; keyMode: 'major' | 'minor' | null; tags: string[];
      versionId: string; durationMs: number | null; waveform: number[] | null; forSale: boolean; soldAt: Date | null }[]>`
      select t.id, t.title, t.bpm::float as bpm, t.key_pc as "keyPc", t.key_mode as "keyMode", t.tags,
             v.id as "versionId", v.duration_ms as "durationMs", v.waveform, ${forSaleExpr(tx)} as "forSale", t.exclusive_sold_at as "soldAt"
      from tracks t join track_versions v on v.id = t.current_version_id and v.status = 'ready'
      where t.owner_id = ${p.userId}
        ${q ? tx`and (lower(t.title) like ${`%${q}%`} or exists (select 1 from unnest(t.tags) g where lower(g) like ${`%${q}%`}))` : tx``}
        ${filters.bpmMin ? tx`and t.bpm >= ${filters.bpmMin}` : tx``}
        ${filters.bpmMax ? tx`and t.bpm <= ${filters.bpmMax}` : tx``}
        ${filters.key ? tx`and t.key_pc = ${Number(kpc)} and t.key_mode = ${kmode}` : tx``}
        ${filters.project ? tx`and exists (select 1 from project_tracks pt where pt.track_id = t.id and pt.project_id = ${filters.project})` : tx``}
      order by t.created_at desc limit 200`;
    const tracks = [];
    for (const r of rows) {
      const offers = r.forSale ? await trackOffers(tx, r.id) : [];
      const from = offers.length ? Math.min(...offers.map((o) => o.finalPriceCents)) : null;
      const fromGross = from === null ? null : withVat(from, 'FR').gross;
      if (filters.priceMax !== undefined && (fromGross === null || fromGross > filters.priceMax * 100)) continue;
      tracks.push({
        id: r.id, title: r.title, bpm: r.bpm, keyPc: r.keyPc, keyMode: r.keyMode, tags: r.tags, durationMs: r.durationMs, waveform: r.waveform,
        audioUrl: publicAudioPath(r.versionId), soldExclusive: Boolean(r.soldAt), fromGrossCents: fromGross,
        offers: offers.map((o) => ({ id: o.id, name: o.name, description: o.description, formats: o.formats, maxStreams: o.maxStreams, maxCopies: o.maxCopies,
          musicVideos: o.musicVideos, radio: o.radio, exclusive: o.exclusive, netCents: o.finalPriceCents, grossFrCents: withVat(o.finalPriceCents, 'FR').gross })),
      });
    }
    return { profile: { handle: p.handle, displayName: p.displayName, bio: p.bio, links: p.links }, projects: projects.filter((x) => x.n > 0), tracks, filters };
  });
}

/** Version courante d'un morceau public : seule chose servie par l'audio public. */
export async function publicPreviewKey(versionId: string) {
  uuid.parse(versionId);
  return withPublic(async (tx) => {
    const [v] = await tx<{ key: string | null }[]>`select preview_key as key from track_versions where id = ${versionId} and status = 'ready'`;
    return v?.key ?? null;
  });
}

// ───────── Profil public (propriétaire) ─────────

const LINK_KEYS = ['instagram', 'youtube', 'soundcloud', 'spotify', 'tiktok', 'site'] as const;
export async function updatePublicProfile(userId: string, raw: { bio?: unknown; links?: unknown; displayName?: unknown }) {
  const bio = raw.bio === undefined ? undefined : z.string().trim().max(500).parse(raw.bio);
  const displayName = raw.displayName === undefined ? undefined : z.string().trim().min(1).max(60).parse(raw.displayName);
  let links: Record<string, string> | undefined;
  if (raw.links !== undefined) {
    const obj = z.record(z.string(), z.string().trim().max(200)).parse(raw.links);
    links = {};
    for (const k of LINK_KEYS) {
      const v = obj[k];
      if (!v) continue;
      const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
      try { const u = new URL(url); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(); links[k] = u.toString(); }
      catch { throw new Invalid(`Lien ${k} invalide.`); }
    }
  }
  await withUser(userId, (tx) => tx`update profiles set
    bio = ${bio === undefined ? tx`bio` : bio},
    display_name = ${displayName === undefined ? tx`display_name` : displayName},
    links = ${links === undefined ? tx`links` : tx.json(links as never)}
    where user_id = ${userId}`);
}

export async function publicProfileSettings(userId: string) {
  return withUser(userId, async (tx) => {
    const [p] = await tx<{ handle: string; displayName: string; bio: string; links: Record<string, string> }[]>`
      select handle, display_name as "displayName", bio, links from profiles where user_id = ${userId}`;
    return p;
  });
}

/** Réglages de vente d'un morceau : chaque licence, activée ou non, avec son prix propre éventuel. */
export async function trackLicenceSettings(userId: string, trackId: string) {
  uuid.parse(trackId);
  await listTemplates(userId);
  return withUser(userId, async (tx) => {
    const [t] = await tx`select 1 from tracks where id = ${trackId}`;
    if (!t) throw new NotFound();
    return tx<{ id: string; name: string; priceCents: number; active: boolean; formats: string[]; enabled: boolean; overrideCents: number | null }[]>`
      select lt.id, lt.name, lt.price_cents as "priceCents", lt.active, lt.formats, coalesce(tl.enabled, true) as enabled, tl.price_cents as "overrideCents"
      from licence_templates lt left join track_licences tl on tl.template_id = lt.id and tl.track_id = ${trackId}
      where lt.active order by lt.position, lt.created_at`;
  });
}
