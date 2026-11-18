import { z } from 'zod';
import { withUser, type Tx } from './db';
import { contactsFromCsv, splitTags } from './csv';
import { Invalid, NotFound } from './library';

/** Contacts du producteur (lot 3.1). Tout passe par withUser (RLS). */

const uuid = z.string().uuid();
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const nameSchema = z.string().trim().max(120).nullable().optional();
const tagsSchema = z.array(z.string()).max(30).optional();
const MAX_IMPORT = 5000;
const MAX_CONTACTS = 20000;

export const ruleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('listened_over'), seconds: z.number().int().min(1).max(3600), days: z.number().int().min(1).max(365).optional() }),
  z.object({ type: z.literal('tag'), tag: z.string().trim().toLowerCase().min(1).max(40) }),
  z.object({ type: z.literal('score_min'), min: z.number().int().min(1).max(10000) }),
  z.object({ type: z.literal('inactive'), days: z.number().int().min(1).max(3650) }),
]);
export type Rule = z.infer<typeof ruleSchema>;

export function describeRule(r: Rule) {
  switch (r.type) {
    case 'listened_over': return `A écouté plus de ${r.seconds} s${r.days ? ` (${r.days} derniers jours)` : ''}`;
    case 'tag': return `Tag « ${r.tag} »`;
    case 'score_min': return `Score d’activité ≥ ${r.min}`;
    case 'inactive': return `Sans activité depuis ${r.days} jours`;
  }
}

/** Condition SQL d'une règle sur un contact « c » joint à son activité « a ». */
function ruleWhere(tx: Tx, r: Rule) {
  switch (r.type) {
    case 'listened_over':
      return tx`exists (select 1 from listen_sessions s where s.contact_id = c.id and s.listened_ms >= ${r.seconds * 1000}
                ${r.days ? tx`and s.started_at > now() - ${`${r.days} days`}::interval` : tx``})`;
    case 'tag': return tx`${r.tag} = any(c.tags)`;
    case 'score_min': return tx`a.score >= ${r.min}`;
    case 'inactive': return tx`(a.last_activity_at is null or a.last_activity_at < now() - ${`${r.days} days`}::interval)`;
  }
}

const contactCols = (tx: Tx) => tx`
  c.id, c.email, c.name, c.tags, c.unsubscribed_at is not null as unsubscribed, c.created_at as "createdAt",
  a.score, a.plays, a.last_activity_at as "lastActivityAt"`;

export type ContactRow = { id: string; email: string; name: string | null; tags: string[]; unsubscribed: boolean; createdAt: Date; score: number; plays: number; lastActivityAt: Date | null };

export async function listContacts(userId: string, opts: { q?: string; tag?: string; groupId?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  return withUser(userId, async (tx) => {
    let groupFilter = tx``;
    if (opts.groupId) {
      uuid.parse(opts.groupId);
      const [g] = await tx<{ rule: Rule | null }[]>`select rule from contact_groups where id = ${opts.groupId}`;
      if (!g) throw new NotFound();
      groupFilter = g.rule
        ? tx`and ${ruleWhere(tx, ruleSchema.parse(g.rule))}`
        : tx`and exists (select 1 from contact_group_members m where m.group_id = ${opts.groupId} and m.contact_id = c.id)`;
    }
    const q = opts.q?.trim().toLowerCase().slice(0, 100);
    const rows = await tx<ContactRow[]>`
      select ${contactCols(tx)} from contacts c join contact_activity a on a.contact_id = c.id
      where true
        ${q ? tx`and (c.email like ${`%${q.replace(/[%_\\]/g, '\\$&')}%`} or lower(coalesce(c.name, '')) like ${`%${q.replace(/[%_\\]/g, '\\$&')}%`})` : tx``}
        ${opts.tag ? tx`and ${opts.tag.toLowerCase()} = any(c.tags)` : tx``}
        ${groupFilter}
      order by a.last_activity_at desc nulls last, c.created_at desc, c.id
      limit ${limit + 1} offset ${offset}`;
    const [{ total }] = await tx<{ total: number }[]>`select count(*)::int as total from contacts`;
    const tags = await tx<{ tag: string; n: number }[]>`select t as tag, count(*)::int as n from contacts, unnest(tags) t group by t order by n desc, t limit 50`;
    return { contacts: rows.slice(0, limit).map(fmt), hasMore: rows.length > limit, total, tags };
  });
}

const fmt = (c: ContactRow) => ({ ...c, createdAt: c.createdAt.toISOString(), lastActivityAt: c.lastActivityAt?.toISOString() ?? null });

export async function createContact(userId: string, input: { email?: unknown; name?: unknown; tags?: unknown }) {
  const email = emailSchema.parse(input.email);
  const name = nameSchema.parse(input.name ?? null) || null;
  const tags = splitTags((tagsSchema.parse(input.tags) ?? []).join(','));
  return withUser(userId, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from contacts`;
    if (n >= MAX_CONTACTS) throw new Invalid(`Limite atteinte : ${MAX_CONTACTS} contacts.`);
    const [c] = await tx<{ id: string }[]>`insert into contacts (owner_id, email, name, tags) values (${userId}, ${email}, ${name}, ${tags})
      on conflict (owner_id, email) do nothing returning id`;
    if (!c) throw new Invalid('Ce contact existe déjà.');
    return { id: c.id };
  });
}

export async function updateContact(userId: string, id: string, input: { name?: unknown; tags?: unknown }) {
  uuid.parse(id);
  const name = input.name === undefined ? undefined : nameSchema.parse(input.name) || null;
  const tags = input.tags === undefined ? undefined : splitTags((tagsSchema.parse(input.tags) ?? []).join(','));
  await withUser(userId, async (tx) => {
    const r = await tx`update contacts set
      name = ${name === undefined ? tx`name` : name},
      tags = ${tags === undefined ? tx`tags` : tags}
      where id = ${id}`;
    if (!r.count) throw new NotFound();
  });
}

export async function deleteContact(userId: string, id: string) {
  uuid.parse(id);
  await withUser(userId, async (tx) => { if (!(await tx`delete from contacts where id = ${id}`).count) throw new NotFound(); });
}

/** Import CSV : doublons fusionnés (dans le fichier et avec l'existant), lignes invalides signalées. */
export async function importContacts(userId: string, csv: unknown, extraTags: unknown = []) {
  const text = z.string().max(5_000_000).parse(csv);
  const { contacts, invalid } = contactsFromCsv(text);
  if (contacts.length > MAX_IMPORT) throw new Invalid(`Fichier trop long : ${MAX_IMPORT} lignes au plus par import.`);
  const add = splitTags((z.array(z.string()).max(30).parse(extraTags ?? [])).join(','));
  const merged = new Map<string, { email: string; name: string | null; tags: Set<string> }>();
  for (const c of contacts) {
    const prev = merged.get(c.email);
    if (prev) { prev.name ??= c.name; c.tags.forEach((t) => prev.tags.add(t)); }
    else merged.set(c.email, { email: c.email, name: c.name, tags: new Set([...c.tags, ...add]) });
  }
  const list = [...merged.values()];
  return withUser(userId, async (tx) => {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from contacts`;
    const res = list.length ? await tx<{ inserted: boolean }[]>`
      insert into contacts (owner_id, email, name, tags)
      select ${userId}, x.email, x.name, x.tags
      from jsonb_to_recordset(${tx.json(list.map((c) => ({ email: c.email, name: c.name, tags: [...c.tags].slice(0, 30) })) as never)})
        as x(email text, name text, tags text[])
      on conflict (owner_id, email) do update set
        name = coalesce(contacts.name, excluded.name),
        tags = (select coalesce(array_agg(distinct t), '{}') from unnest(contacts.tags || excluded.tags) t)
      returning (xmax = 0) as inserted` : [];
    const created = res.filter((r) => r.inserted).length;
    if (n + created > MAX_CONTACTS) throw new Invalid(`Limite atteinte : ${MAX_CONTACTS} contacts.`);
    return { lines: contacts.length + invalid.length, created, merged: contacts.length - created, invalid: invalid.slice(0, 100), invalidCount: invalid.length };
  });
}

// ───────────── Groupes ─────────────

export async function listGroups(userId: string) {
  return withUser(userId, async (tx) => {
    const groups = await tx<{ id: string; name: string; rule: Rule | null }[]>`select id, name, rule from contact_groups order by name`;
    const out = [];
    for (const g of groups) {
      const [{ n }] = g.rule
        ? await tx<{ n: number }[]>`select count(*)::int as n from contacts c join contact_activity a on a.contact_id = c.id where ${ruleWhere(tx, ruleSchema.parse(g.rule))}`
        : await tx<{ n: number }[]>`select count(*)::int as n from contact_group_members where group_id = ${g.id}`;
      out.push({ ...g, size: n, description: g.rule ? describeRule(ruleSchema.parse(g.rule)) : 'Groupe manuel' });
    }
    return out;
  });
}

export async function createGroup(userId: string, input: { name?: unknown; rule?: unknown }) {
  const name = z.string().trim().min(1).max(60).parse(input.name);
  const rule = input.rule == null ? null : ruleSchema.parse(input.rule);
  return withUser(userId, async (tx) => {
    const [g] = await tx<{ id: string }[]>`insert into contact_groups (owner_id, name, rule) values (${userId}, ${name}, ${rule ? tx.json(rule as never) : null})
      on conflict (owner_id, name) do nothing returning id`;
    if (!g) throw new Invalid('Un groupe porte déjà ce nom.');
    return { id: g.id };
  });
}

export async function deleteGroup(userId: string, id: string) {
  uuid.parse(id);
  await withUser(userId, async (tx) => { if (!(await tx`delete from contact_groups where id = ${id}`).count) throw new NotFound(); });
}

export async function setGroupMembers(userId: string, groupId: string, contactIds: unknown, add: boolean) {
  uuid.parse(groupId);
  const ids = z.array(uuid).max(1000).parse(contactIds);
  await withUser(userId, async (tx) => {
    const [g] = await tx<{ rule: unknown }[]>`select rule from contact_groups where id = ${groupId}`;
    if (!g) throw new NotFound();
    if (g.rule) throw new Invalid('Un groupe à règle se remplit tout seul.');
    if (add) {
      await tx`insert into contact_group_members (group_id, contact_id, owner_id)
               select ${groupId}, c.id, ${userId} from contacts c where c.id = any(${ids}::uuid[]) on conflict do nothing`;
    } else {
      await tx`delete from contact_group_members where group_id = ${groupId} and contact_id = any(${ids}::uuid[])`;
    }
  });
}

/** Contacts visés par un groupe (pour l'emailing). */
export async function groupContactIds(tx: Tx, groupId: string): Promise<string[]> {
  const [g] = await tx<{ rule: Rule | null }[]>`select rule from contact_groups where id = ${groupId}`;
  if (!g) throw new NotFound();
  const rows = g.rule
    ? await tx<{ id: string }[]>`select c.id from contacts c join contact_activity a on a.contact_id = c.id where ${ruleWhere(tx, ruleSchema.parse(g.rule))}`
    : await tx<{ id: string }[]>`select contact_id as id from contact_group_members where group_id = ${groupId}`;
  return rows.map((r) => r.id);
}

/** Fiche d'un contact : activité détaillée. */
export async function contactDetail(userId: string, id: string) {
  uuid.parse(id);
  return withUser(userId, async (tx) => {
    const [c] = await tx<ContactRow[]>`select ${contactCols(tx)} from contacts c join contact_activity a on a.contact_id = c.id where c.id = ${id}`;
    if (!c) throw new NotFound();
    const listens = await tx<{ id: string; trackId: string; title: string | null; source: string; listenedMs: number; durationMs: number | null; startedAt: Date }[]>`
      select s.id, s.track_id as "trackId", t.title, s.source, s.listened_ms as "listenedMs", s.duration_ms as "durationMs", s.started_at as "startedAt"
      from listen_sessions s left join tracks t on t.id = s.track_id where s.contact_id = ${id} order by s.started_at desc limit 50`;
    const other = await tx<{ kind: string; title: string | null; at: Date }[]>`
      select i.kind, t.title, i.created_at as at from interactions i left join tracks t on t.id = i.track_id where i.contact_id = ${id}
      union all
      select 'save', coalesce(p.title, t.title), sv.created_at from saves sv join share_links l on l.id = sv.link_id
        left join projects p on p.id = l.project_id left join tracks t on t.id = l.track_id where sv.contact_id = ${id}
      order by 3 desc limit 50`;
    const groups = await tx<{ id: string; name: string }[]>`select g.id, g.name from contact_group_members m join contact_groups g on g.id = m.group_id where m.contact_id = ${id} order by g.name`;
    return {
      contact: fmt(c),
      listens: listens.map((l) => ({ ...l, startedAt: l.startedAt.toISOString() })),
      events: other.map((e) => ({ ...e, at: e.at.toISOString() })),
      groups,
    };
  });
}
