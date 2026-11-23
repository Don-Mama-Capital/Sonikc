import { z } from 'zod';
import { emailsThisMonth, fail, limitsFor } from './plans';
import { withUser } from './db';
import { groupContactIds } from './contacts';
import { Invalid, NotFound } from './library';
import { kindSchema } from './sharing';

/** Campagnes d'emails côté producteur (lots 3.2 et 3.3). Tout passe par withUser (RLS). */

const uuid = z.string().uuid();
const MAX_RECIPIENTS = 2000;
// Objet sur une seule ligne : un retour à la ligne ne doit jamais atteindre les en-têtes de l'email.
const subjectSchema = z.string().transform((s) => s.replace(/[\r\n\t]+/g, ' ').trim()).pipe(z.string().min(1, 'Objet obligatoire.').max(150));
const bodySchema = z.string().trim().min(1, 'Message obligatoire.').max(5000);

const inputSchema = z.object({
  kind: kindSchema,
  id: uuid,
  subject: subjectSchema,
  body: bodySchema,
  groupId: uuid.nullish(),
  contactIds: z.array(uuid).max(MAX_RECIPIENTS).nullish(),
  scheduledAt: z.string().datetime({ offset: true }).nullish(),
  followup: z.object({ days: z.number().int().min(1).max(60), subject: subjectSchema, body: bodySchema }).nullish(),
});

export async function createCampaign(userId: string, raw: unknown) {
  const input = inputSchema.parse(raw);
  const when = input.scheduledAt ? new Date(input.scheduledAt) : new Date();
  if (when.getTime() < Date.now() - 60_000) throw new Invalid('La date d’envoi est passée.');
  if (when.getTime() > Date.now() + 90 * 86_400_000) throw new Invalid('Programmation possible jusqu’à 90 jours.');
  return withUser(userId, async (tx) => {
    const { plan, limits } = await limitsFor(tx, userId);
    if (input.followup && !limits.followUps) fail(plan, 'followUps');
    if (when.getTime() > Date.now() + 5 * 60_000 && !limits.scheduledSends) fail(plan, 'scheduledSends');
    const col = input.kind === 'project' ? 'project_id' : 'track_id';
    const [t] = input.kind === 'project'
      ? await tx<{ visibility: string | null }[]>`select visibility from projects where id = ${input.id} and deleted_at is null`
      : await tx<{ visibility: string | null }[]>`select visibility from tracks where id = ${input.id} and deleted_at is null`;
    if (!t) throw new NotFound();
    if (!t.visibility || t.visibility === 'private') {
      throw new Invalid('Ce partage est privé : choisis « Public » ou « Sur invitation » avant de l’envoyer.');
    }
    let ids: string[] | null = null;
    if (input.groupId) ids = await groupContactIds(tx, input.groupId);
    else if (input.contactIds?.length) ids = input.contactIds;
    const recipients = await tx<{ id: string; email: string }[]>`
      select c.id, c.email from contacts c
      where not exists (select 1 from email_suppressions x where x.owner_id = c.owner_id and x.email = c.email)
        ${ids ? tx`and c.id = any(${ids}::uuid[])` : tx``}
      order by c.created_at limit ${MAX_RECIPIENTS + 1}`;
    if (!recipients.length) throw new Invalid('Aucun destinataire : ajoute des contacts (les désinscrits sont exclus).');
    if (recipients.length > MAX_RECIPIENTS) throw new Invalid(`${MAX_RECIPIENTS} destinataires au plus par envoi.`);
    // Emails du mois : ceux déjà comptés + ceux-ci (et leur relance éventuelle, réservée d'avance).
    const used = await emailsThisMonth(tx, userId);
    const need = used + recipients.length * (input.followup ? 2 : 1);
    if (need > limits.emailsPerMonth) fail(plan, 'emailsPerMonth', need);

    const [c] = await tx<{ id: string }[]>`
      insert into campaigns (owner_id, ${tx(col)}, subject, body, scheduled_at, followup_days, followup_subject, followup_body, followup_status)
      values (${userId}, ${input.id}, ${input.subject}, ${input.body}, ${when},
              ${input.followup?.days ?? null}, ${input.followup?.subject ?? null}, ${input.followup?.body ?? null},
              ${input.followup ? 'scheduled' : null})
      returning id`;
    // Un lien personnel par destinataire : son écoute arrive avec son nom.
    const label = `Email · ${input.subject}`.slice(0, 60);
    const links = await tx<{ id: string; contactId: string }[]>`
      insert into share_links (owner_id, ${tx(col)}, label, contact_id)
      select ${userId}, ${input.id}, ${label}, x from unnest(${recipients.map((r) => r.id)}::uuid[]) x
      returning id, contact_id as "contactId"`;
    const linkOf = new Map(links.map((l) => [l.contactId, l.id]));
    await tx`insert into email_sends (owner_id, campaign_id, contact_id, email, step, link_id)
      select ${userId}, ${c.id}, r.id, r.email, 0, r.link
      from jsonb_to_recordset(${tx.json(recipients.map((r) => ({ id: r.id, email: r.email, link: linkOf.get(r.id) })) as never)}) as r(id uuid, email text, link uuid)`;
    // Partage sur invitation : chaque destinataire est invité (il devra se connecter avec son adresse).
    if (t.visibility === 'invite') {
      await tx`insert into invites (owner_id, ${tx(col)}, email, link_id)
        select ${userId}, ${input.id}, r.email, r.link
        from jsonb_to_recordset(${tx.json(recipients.map((r) => ({ email: r.email, link: linkOf.get(r.id) })) as never)}) as r(email text, link uuid)
        on conflict do nothing`;
    }
    await tx`select app.enqueue_campaign(${c.id})`;
    return { id: c.id, recipients: recipients.length, scheduledAt: when.toISOString() };
  });
}

const stats = (tx: import('./db').Tx) => tx`
  (select count(*)::int from email_sends s where s.campaign_id = c.id and s.step = 0) as recipients,
  (select count(*)::int from email_sends s where s.campaign_id = c.id and s.step = 0 and s.status = 'sent') as sent,
  (select count(*)::int from email_sends s where s.campaign_id = c.id and s.step = 0 and s.opened_at is not null) as opened,
  (select count(*)::int from email_sends s where s.campaign_id = c.id and s.step = 0 and s.clicked_at is not null) as clicked,
  (select count(*)::int from email_sends s where s.campaign_id = c.id and s.step = 0
     and exists (select 1 from listen_sessions ls where ls.link_id = s.link_id)) as listened,
  (select count(*)::int from email_sends s where s.campaign_id = c.id and s.step = 1 and s.status = 'sent') as "followupSent"`;

export async function listCampaigns(userId: string) {
  return withUser(userId, async (tx) => {
    const rows = await tx<Record<string, unknown>[]>`
      select c.id, c.subject, c.status, c.scheduled_at as "scheduledAt", c.sent_at as "sentAt", c.followup_status as "followupStatus",
             c.followup_days as "followupDays", coalesce(p.title, t.title) as title, ${stats(tx)}
      from campaigns c left join projects p on p.id = c.project_id left join tracks t on t.id = c.track_id
      order by c.created_at desc limit 100`;
    return rows;
  });
}

export async function campaignDetail(userId: string, id: string) {
  uuid.parse(id);
  return withUser(userId, async (tx) => {
    const [c] = await tx<Record<string, unknown>[]>`
      select c.id, c.subject, c.body, c.status, c.scheduled_at as "scheduledAt", c.sent_at as "sentAt",
             c.followup_days as "followupDays", c.followup_subject as "followupSubject", c.followup_status as "followupStatus",
             c.project_id as "projectId", c.track_id as "trackId", coalesce(p.title, t.title) as title, ${stats(tx)}
      from campaigns c left join projects p on p.id = c.project_id left join tracks t on t.id = c.track_id
      where c.id = ${id}`;
    if (!c) throw new NotFound();
    const recipients = await tx<Record<string, unknown>[]>`
      select s.id, s.email, ct.name, s.status, s.skip_reason as "skipReason", s.error, s.sent_at as "sentAt",
             s.opened_at as "openedAt", s.clicked_at as "clickedAt", s.replied_at as "repliedAt",
             (select max(ls.listened_ms) from listen_sessions ls where ls.link_id = s.link_id) as "listenedMs",
             (select s1.status from email_sends s1 where s1.campaign_id = s.campaign_id and s1.email = s.email and s1.step = 1) as "followup"
      from email_sends s left join contacts ct on ct.id = s.contact_id
      where s.campaign_id = ${id} and s.step = 0 order by s.created_at, s.id`;
    return { campaign: c, recipients };
  });
}

export async function cancelCampaign(userId: string, id: string) {
  uuid.parse(id);
  return withUser(userId, async (tx) => {
    const [{ ok }] = await tx<{ ok: boolean }[]>`select app.cancel_campaign(${id}) as ok`;
    if (!ok) throw new Invalid('Cet envoi est déjà parti : il ne peut plus être annulé.');
  });
}

export async function cancelFollowup(userId: string, id: string) {
  uuid.parse(id);
  await withUser(userId, async (tx) => {
    const r = await tx`update campaigns set followup_status = 'cancelled' where id = ${id} and followup_status = 'scheduled'`;
    if (!r.count) throw new Invalid('Pas de relance à annuler.');
  });
}

export async function markReplied(userId: string, sendId: string, replied: unknown) {
  uuid.parse(sendId);
  await withUser(userId, async (tx) => {
    const r = await tx`update email_sends set replied_at = ${z.boolean().parse(replied) ? tx`coalesce(replied_at, now())` : null} where id = ${sendId}`;
    if (!r.count) throw new NotFound();
  });
}
