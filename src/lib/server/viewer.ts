import { asService, withViewer, type Tx, type ViewerCtx } from './db';
import { hmac, safeEqualStr } from './crypto';
import { checkPassword } from './sharing';
import { parseLinkToken, sharedAudioPath } from './share-token';

/**
 * Côté auditeur : un lien de partage est résolu en trois temps.
 * 1. Authentification du lien (accès service, comme la connexion) : signature du jeton, lien actif,
 *    niveau de la cible, mot de passe. Rien du contenu n'est lu ici.
 * 2. Le contenu est lu par withViewer : la base n'accorde que ce que le lien permet (app.link_grants).
 * 3. L'audio passe par une adresse liée au lien, signée et à durée limitée.
 */

export type LinkMeta = {
  linkId: string; ownerId: string; kind: 'project' | 'track'; targetId: string;
  visibility: string; passwordHash: string | null; ownerName: string;
};

export type Resolution =
  | { status: 'not_found' }
  | { status: 'login'; ownerName: string }
  | { status: 'denied'; ownerName: string }
  | { status: 'password'; ownerName: string; linkId: string }
  | { status: 'ok'; meta: LinkMeta; ctx: ViewerCtx; isOwner: boolean };

export const unlockCookieName = (linkId: string) => `sk_unlock_${linkId.replace(/-/g, '').slice(0, 12)}`;
export const unlockValue = (linkId: string, passwordHash: string) => hmac(`unlock:${linkId}:${passwordHash}`);

const metaQuery = (tx: import('./db').Tx, ids: string[]) => tx<LinkMeta[]>`
      select l.id as "linkId", l.owner_id as "ownerId",
             case when l.project_id is not null then 'project' else 'track' end as kind,
             coalesce(l.project_id, l.track_id) as "targetId",
             coalesce(p.visibility, t.visibility) as visibility,
             coalesce(p.password_hash, t.password_hash) as "passwordHash",
             coalesce(pf.display_name, '') as "ownerName"
      from share_links l
      left join projects p on p.id = l.project_id and p.deleted_at is null
      left join tracks t on t.id = l.track_id and t.deleted_at is null
      left join profiles pf on pf.user_id = l.owner_id
      where l.id = any(${ids}::uuid[]) and l.revoked_at is null and (p.id is not null or t.id is not null)`;

async function linkMeta(linkId: string): Promise<LinkMeta | null> {
  return (await linkMetas([linkId])).get(linkId) ?? null;
}

/** Authentification de plusieurs liens en une seule requête (page « Reçus »). */
export async function linkMetas(ids: string[]): Promise<Map<string, LinkMeta>> {
  if (!ids.length) return new Map();
  const rows = await asService((tx) => metaQuery(tx, ids));
  return new Map(rows.map((r) => [r.linkId, r]));
}

export async function resolveLink(token: string, userId: string | null, unlockCookie: string | undefined): Promise<Resolution> {
  const linkId = parseLinkToken(token);
  if (!linkId) return { status: 'not_found' };
  const meta = await linkMeta(linkId);
  if (!meta) return { status: 'not_found' };
  return resolveWithMeta(meta, userId, unlockCookie);
}

/** Décision d'accès une fois le lien authentifié ; « check » = vérifier en base que la cible est lisible. */
export async function resolveWithMeta(meta: LinkMeta, userId: string | null, unlockCookie: string | undefined, check = true): Promise<Resolution> {
  const linkId = meta.linkId;
  const isOwner = userId === meta.ownerId;
  if (isOwner) return { status: 'ok', meta, ctx: { userId, linkId, unlocked: true }, isOwner };
  if (!meta.visibility || meta.visibility === 'private') return { status: 'not_found' };
  if (meta.visibility === 'invite' && !userId) return { status: 'login', ownerName: meta.ownerName };
  const unlocked = Boolean(meta.passwordHash && unlockCookie && safeEqualStr(unlockCookie, unlockValue(linkId, meta.passwordHash)));
  if (meta.passwordHash && !unlocked) {
    // Pas de mot de passe demandé à quelqu'un qui n'est de toute façon pas invité.
    if (meta.visibility === 'invite' && !(await canSeeTarget({ userId, linkId, unlocked: true }, meta))) return { status: 'denied', ownerName: meta.ownerName };
    return { status: 'password', ownerName: meta.ownerName, linkId };
  }
  const ctx: ViewerCtx = { userId, linkId, unlocked };
  if (check && !(await canSeeTarget(ctx, meta))) return meta.visibility === 'invite' ? { status: 'denied', ownerName: meta.ownerName } : { status: 'not_found' };
  return { status: 'ok', meta, ctx, isOwner };
}

async function canSeeTarget(ctx: ViewerCtx, meta: LinkMeta) {
  return withViewer(ctx, async (tx) => {
    const rows = meta.kind === 'project'
      ? await tx`select 1 from projects where id = ${meta.targetId}`
      : await tx`select 1 from tracks where id = ${meta.targetId}`;
    return rows.length > 0;
  });
}

export type SharedTrack = {
  id: string; title: string; bpm: number | null; keyPc: number | null; keyMode: 'major' | 'minor' | null;
  versionId: string; durationMs: number | null; waveform: number[] | null; audioUrl: string;
  allowDownload: boolean; hiddenForListeners: boolean;
};

const sharedTrackCols = (tx: Tx) => tx`
  t.id, t.title, t.bpm::float as bpm, t.key_pc as "keyPc", t.key_mode as "keyMode",
  v.id as "versionId", v.duration_ms as "durationMs", v.waveform, t.allow_download as "allowDownload",
  (coalesce(t.visibility, '') = 'private' or t.password_hash is not null) as "hiddenForListeners"`;

/** Contenu d'une page partagée, lu avec les droits de l'auditeur. */
export async function loadShared(token: string, r: Extract<Resolution, { status: 'ok' }>) {
  return withViewer(r.ctx, async (tx) => {
    const { meta } = r;
    let title: string; let allowDownload = false; let rows: Omit<SharedTrack, 'audioUrl'>[];
    if (meta.kind === 'project') {
      const [p] = await tx<{ title: string; allowDownload: boolean }[]>`select title, allow_download as "allowDownload" from projects where id = ${meta.targetId}`;
      if (!p) return null;
      title = p.title; allowDownload = p.allowDownload;
      rows = await tx<Omit<SharedTrack, 'audioUrl'>[]>`
        select ${sharedTrackCols(tx)}
        from project_tracks pt join tracks t on t.id = pt.track_id join track_versions v on v.id = t.current_version_id
        where pt.project_id = ${meta.targetId} and t.deleted_at is null and v.status = 'ready'
        order by pt.position`;
    } else {
      rows = await tx<Omit<SharedTrack, 'audioUrl'>[]>`
        select ${sharedTrackCols(tx)} from tracks t join track_versions v on v.id = t.current_version_id
        where t.id = ${meta.targetId} and v.status = 'ready'`;
      if (!rows.length) return null;
      title = rows[0].title; allowDownload = rows[0].allowDownload;
    }
    const tracks: SharedTrack[] = rows.map((t) => ({
      ...t,
      allowDownload: allowDownload || t.allowDownload,
      audioUrl: sharedAudioPath(token, meta.linkId, t.versionId),
    }));
    return { kind: meta.kind, title, ownerName: meta.ownerName, isOwner: r.isOwner, allowDownload, tracks };
  });
}

/** Clé du fichier à servir pour une version, si le lien y donne accès (aperçu seulement, ou original pour un téléchargement autorisé). */
export async function sharedFile(ctx: ViewerCtx, meta: LinkMeta, versionId: string, want: 'preview' | 'original') {
  return withViewer(ctx, async (tx) => {
    const [v] = await tx<{ previewKey: string | null; originalKey: string; filename: string; trackId: string; trackDl: boolean }[]>`
      select v.preview_key as "previewKey", v.original_key as "originalKey", v.original_filename as filename,
             t.id as "trackId", t.allow_download as "trackDl"
      from track_versions v join tracks t on t.id = v.track_id and t.current_version_id = v.id
      where v.id = ${versionId} and v.status = 'ready'`;
    if (!v) return null;
    if (want === 'preview') return v.previewKey ? { key: v.previewKey, filename: null, trackId: v.trackId } : null;
    let allowed = v.trackDl;
    if (!allowed && meta.kind === 'project') {
      const [p] = await tx<{ dl: boolean }[]>`select allow_download as dl from projects where id = ${meta.targetId}`;
      allowed = Boolean(p?.dl);
    }
    return allowed ? { key: v.originalKey, filename: v.filename, trackId: v.trackId } : null;
  });
}

const MAX_FAILS_PER_VISITOR = 5; // par cookie visiteur
const MAX_FAILS_PER_IP = 5; // par adresse IP (si l'hébergeur la fournit), le cookie pouvant être effacé
const SLOW_AFTER_LINK_FAILS = 30; // au-delà, chaque essai sur ce lien attend : on freine sans bloquer les vrais auditeurs
const SLOW_MS = 2000;

/** Vérifie un mot de passe de partage (flux d'authentification : accès service), avec limites d'essais. */
export async function unlock(token: string, password: string, visitor: string, ip = 'unknown', sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  const linkId = parseLinkToken(token);
  if (!linkId) return { ok: false as const, error: 'not_found' as const };
  const meta = await linkMeta(linkId);
  if (!meta?.passwordHash) return { ok: false as const, error: 'not_found' as const };
  const counts = await asService(async (tx) => (await tx<{ mine: number; byIp: number; all: number }[]>`
      select count(*) filter (where visitor = ${visitor})::int as mine,
             count(*) filter (where ip = ${ip} and ip <> 'unknown')::int as "byIp",
             count(*)::int as all
      from unlock_attempts where link_id = ${linkId} and created_at > now() - interval '15 minutes'`)[0]);
  if (counts.mine >= MAX_FAILS_PER_VISITOR || counts.byIp >= MAX_FAILS_PER_IP) return { ok: false as const, error: 'rate_limited' as const };
  if (counts.all >= SLOW_AFTER_LINK_FAILS) await sleep(SLOW_MS);
  if (!checkPassword(String(password).slice(0, 100), meta.passwordHash)) {
    await asService((tx) => tx`insert into unlock_attempts (link_id, visitor, ip) values (${linkId}, ${visitor}, ${ip})`);
    return { ok: false as const, error: 'wrong' as const };
  }
  return { ok: true as const, cookieName: unlockCookieName(linkId), value: unlockValue(linkId, meta.passwordHash) };
}
