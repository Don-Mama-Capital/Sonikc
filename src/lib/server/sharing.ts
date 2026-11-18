import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { withUser, type Tx } from './db';
import { env } from './env';
import { sendMail } from './mail';
import { linkToken } from './share-token';
import { Invalid, NotFound } from './library';

/** Réglages de partage d'un projet ou d'un morceau, côté propriétaire. Tout passe par withUser (RLS). */

export type ShareKind = 'project' | 'track';
export const kindSchema = z.enum(['project', 'track']);
const uuid = z.string().uuid();
// « En vente » existe en base mais n'est proposé qu'avec la vente (phase 4) : pas de fonction annoncée avant d'exister.
const visibilitySchema = z.enum(['private', 'invite', 'public']);
// Un morceau peut aussi « suivre le projet » (null en base) : visible dans un projet partagé, privé seul.
const trackVisibilitySchema = z.enum(['inherit', 'private', 'invite', 'public']);
const labelSchema = z.string().trim().min(1).max(60);
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const passwordSchema = z.string().min(8, 'Mot de passe : 8 caractères minimum.').max(100);
const MAX_INVITES_PER_DAY = 50; // garde-fou contre l'envoi de masse depuis l'adresse de Sonikc

const table = (k: ShareKind) => (k === 'project' ? 'projects' : 'tracks');
const col = (k: ShareKind) => (k === 'project' ? 'project_id' : 'track_id');

export function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `s1$${salt.toString('base64url')}$${scryptSync(pw, salt, 32, { N: 16384 }).toString('base64url')}`;
}
export function checkPassword(pw: string, stored: string) {
  const [v, salt, hash] = stored.split('$');
  if (v !== 's1' || !salt || !hash) return false;
  const got = scryptSync(pw, Buffer.from(salt, 'base64url'), 32, { N: 16384 });
  const want = Buffer.from(hash, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want);
}

export const shareUrl = (linkId: string) => `${env().APP_URL.replace(/\/$/, '')}/s/${linkToken(linkId)}`;

async function target(tx: Tx, kind: ShareKind, id: string) {
  const [row] = await tx<{ id: string; title: string; visibility: string; hasPassword: boolean; allowDownload: boolean }[]>`
    select id, title, coalesce(visibility, 'inherit') as visibility, password_hash is not null as "hasPassword", allow_download as "allowDownload"
    from ${tx(table(kind))} where id = ${id} and deleted_at is null`;
  if (!row) throw new NotFound();
  return row;
}

export async function getShareSettings(userId: string, kind: ShareKind, id: string) {
  uuid.parse(id);
  return withUser(userId, async (tx) => {
    const t = await target(tx, kind, id);
    const links = await tx<{ id: string; label: string; createdAt: Date; revokedAt: Date | null; invite: string | null }[]>`
      select l.id, l.label, l.created_at as "createdAt", l.revoked_at as "revokedAt",
             (select i.email from invites i where i.link_id = l.id limit 1) as invite
      from share_links l where ${tx(col(kind))} = ${id} order by l.created_at desc`;
    const invites = await tx<{ id: string; email: string; createdAt: Date }[]>`
      select id, email, created_at as "createdAt" from invites where ${tx(col(kind))} = ${id} and revoked_at is null order by created_at`;
    return {
      ...t,
      links: links.filter((l) => !l.invite).map((l) => ({ id: l.id, label: l.label, url: l.revokedAt ? null : shareUrl(l.id), createdAt: l.createdAt.toISOString(), revokedAt: l.revokedAt?.toISOString() ?? null })),
      invites: invites.map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt.toISOString() })),
    };
  });
}

export async function updateShareSettings(userId: string, kind: ShareKind, id: string, input: { visibility?: unknown; password?: unknown; allowDownload?: unknown }) {
  uuid.parse(id);
  const vis: string | undefined = input.visibility === undefined ? undefined : (kind === 'track' ? trackVisibilitySchema : visibilitySchema).parse(input.visibility);
  const visibility = vis === 'inherit' ? null : vis;
  const password = input.password === undefined ? undefined : input.password === null || input.password === '' ? null : hashPassword(passwordSchema.parse(input.password));
  const allowDownload = input.allowDownload === undefined ? undefined : z.boolean().parse(input.allowDownload);
  await withUser(userId, async (tx) => {
    await target(tx, kind, id);
    const t = tx(table(kind));
    if (visibility !== undefined) await tx`update ${t} set visibility = ${visibility} where id = ${id}`;
    // Changer le mot de passe annule tous les déverrouillages précédents (ils sont signés avec l'ancien).
    if (password !== undefined) await tx`update ${t} set password_hash = ${password} where id = ${id}`;
    if (allowDownload !== undefined) await tx`update ${t} set allow_download = ${allowDownload} where id = ${id}`;
  });
  return getShareSettings(userId, kind, id);
}

export async function createLink(userId: string, kind: ShareKind, id: string, rawLabel: unknown) {
  uuid.parse(id);
  const label = labelSchema.parse(rawLabel);
  return withUser(userId, async (tx) => {
    await target(tx, kind, id);
    const [l] = await tx<{ id: string }[]>`insert into share_links (owner_id, ${tx(col(kind))}, label) values (${userId}, ${id}, ${label}) returning id`;
    return { id: l.id, label, url: shareUrl(l.id) };
  });
}

export async function revokeLink(userId: string, linkId: string) {
  uuid.parse(linkId);
  await withUser(userId, async (tx) => {
    const r = await tx`update share_links set revoked_at = coalesce(revoked_at, now()) where id = ${linkId}`;
    if (!r.count) throw new NotFound();
  });
}

/** Invite une adresse : crée son lien personnel et lui envoie par email. */
export async function invite(userId: string, kind: ShareKind, id: string, rawEmail: unknown, inviterName: string) {
  uuid.parse(id);
  const email = emailSchema.parse(rawEmail);
  const { url, title } = await withUser(userId, async (tx) => {
    const t = await target(tx, kind, id);
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from invites where created_at > now() - interval '24 hours'`;
    if (n >= MAX_INVITES_PER_DAY) throw new Invalid(`Limite atteinte : ${MAX_INVITES_PER_DAY} invitations par jour.`);
    const [exists] = await tx`select 1 from invites where ${tx(col(kind))} = ${id} and lower(email) = ${email} and revoked_at is null`;
    if (exists) throw new Invalid('Cette adresse est déjà invitée.');
    const [l] = await tx<{ id: string }[]>`insert into share_links (owner_id, ${tx(col(kind))}, label) values (${userId}, ${id}, ${`Invitation · ${email}`.slice(0, 60)}) returning id`;
    await tx`insert into invites (owner_id, ${tx(col(kind))}, email, link_id) values (${userId}, ${id}, ${email}, ${l.id})`;
    return { url: shareUrl(l.id), title: t.title };
  });
  await sendMail({
    to: email,
    tag: 'invite',
    subject: `${inviterName} t’invite à écouter « ${title} »`,
    text: `${inviterName} te partage « ${title} » sur Sonikc.\n\nÉcouter : ${url}\n\nConnecte-toi avec cette adresse (${email}) pour y accéder. ${inviterName} verra quand et combien de temps tu écoutes.`,
  });
  return { email };
}

export async function revokeInvite(userId: string, inviteId: string) {
  uuid.parse(inviteId);
  await withUser(userId, async (tx) => {
    const [i] = await tx<{ link_id: string | null }[]>`update invites set revoked_at = coalesce(revoked_at, now()) where id = ${inviteId} returning link_id`;
    if (!i) throw new NotFound();
    if (i.link_id) await tx`update share_links set revoked_at = coalesce(revoked_at, now()) where id = ${i.link_id}`;
  });
}
