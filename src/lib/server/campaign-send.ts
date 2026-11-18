import { asService } from './db';
import { env } from './env';
import { sendMail } from './mail';
import { enqueue } from './jobs';
import { sendToken } from './email-token';
import { renderCampaignEmail, personalize } from './email-render';

/**
 * Envoi des campagnes par le worker (accès service) :
 * - un envoi est réservé (« sending ») avant l'appel à la messagerie, avec une clé d'idempotence :
 *   jamais deux emails pour le même envoi, même après une coupure ;
 * - plafonds quotidiens (global et par producteur) : le reste repart le lendemain ;
 * - 3 essais par destinataire, puis « en erreur ».
 */

const MAX_ATTEMPTS = 3;
const limits = () => ({
  global: Number(process.env.MAIL_DAILY_LIMIT ?? 100),
  perOwner: Number(process.env.MAIL_DAILY_LIMIT_PER_OWNER ?? process.env.MAIL_DAILY_LIMIT ?? 100),
});
const base = () => env().APP_URL.replace(/\/$/, '');
const tomorrow = () => { const d = new Date(); d.setUTCHours(24, 5, 0, 0); return d; };

type Campaign = {
  id: string; ownerId: string; status: string; subject: string; body: string;
  followupDays: number | null; followupSubject: string | null; followupBody: string | null; followupStatus: string | null;
  ownerName: string; replyTo: string; title: string; visibility: string | null;
};

async function loadCampaign(id: string) {
  return asService(async (tx) => (await tx<Campaign[]>`
    select c.id, c.owner_id as "ownerId", c.status, c.subject, c.body,
           c.followup_days as "followupDays", c.followup_subject as "followupSubject", c.followup_body as "followupBody",
           c.followup_status as "followupStatus",
           coalesce(pf.display_name, 'Un producteur') as "ownerName", u.email as "replyTo",
           coalesce(p.title, t.title) as title, coalesce(p.visibility, t.visibility) as visibility
    from campaigns c join users u on u.id = c.owner_id left join profiles pf on pf.user_id = c.owner_id
    left join projects p on p.id = c.project_id left join tracks t on t.id = c.track_id
    where c.id = ${id}`)[0] ?? null);
}

export async function runCampaignSend(campaignId: string, step: 0 | 1, now = () => new Date()) {
  let c = await loadCampaign(campaignId);
  if (!c || c.status === 'cancelled' || (step === 1 && c.followupStatus !== 'scheduled')) return;
  if (step === 0 && c.status === 'scheduled') {
    await asService((tx) => tx`update campaigns set status = 'sending' where id = ${campaignId} and status = 'scheduled'`);
  }
  // Un envoi resté « en cours » plus de 15 min (worker tombé) n'est pas renvoyé : pas de doublon possible.
  await asService((tx) => tx`update email_sends set status = 'failed', error = 'Envoi interrompu (worker arrêté) : non renvoyé pour éviter un doublon.'
    where campaign_id = ${campaignId} and status = 'sending' and next_attempt_at < now() - interval '15 minutes'`);

  for (;;) {
    c = await loadCampaign(campaignId);
    if (!c || c.status === 'cancelled') return;
    const { global, perOwner } = limits();
    const [{ all, mine }] = await asService((tx) => tx<{ all: number; mine: number }[]>`
      select count(*)::int as all, count(*) filter (where owner_id = ${c!.ownerId})::int as mine
      from email_sends where status = 'sent' and sent_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`);
    if (all >= global || mine >= perOwner) {
      await asService((tx) => enqueue(tx, 'campaign_send', { campaignId, step }, tomorrow()));
      return;
    }
    const [s] = await asService((tx) => tx<{ id: string; email: string; contactId: string | null; linkId: string | null; attempts: number; contactName: string | null; unsubscribed: boolean }[]>`
      update email_sends es set status = 'sending', attempts = attempts + 1, next_attempt_at = now()
      from (select id from email_sends where campaign_id = ${campaignId} and step = ${step} and status = 'queued' and next_attempt_at <= now()
            order by created_at, id limit 1 for update skip locked) pick
      where es.id = pick.id
      returning es.id, es.email, es.contact_id as "contactId", es.link_id as "linkId", es.attempts,
        (select name from contacts where id = es.contact_id) as "contactName",
        exists (select 1 from contacts ct where ct.owner_id = es.owner_id and ct.email = lower(es.email) and ct.unsubscribed_at is not null) as unsubscribed`);
    if (!s) {
      const [next] = await asService((tx) => tx<{ at: Date }[]>`
        select min(next_attempt_at) as at from email_sends where campaign_id = ${campaignId} and step = ${step} and status = 'queued'`);
      if (next?.at) { await asService((tx) => enqueue(tx, 'campaign_send', { campaignId, step }, next.at)); return; }
      await finish(c, step);
      return;
    }
    if (s.unsubscribed) {
      await asService((tx) => tx`update email_sends set status = 'skipped', skip_reason = 'unsubscribed' where id = ${s.id}`);
      continue;
    }
    const token = sendToken(s.id);
    const subject = personalize(step === 1 ? c.followupSubject ?? c.subject : c.subject, s.contactName).slice(0, 150);
    const { text, html } = renderCampaignEmail({
      body: step === 1 ? c.followupBody ?? c.body : c.body,
      contactName: s.contactName, ownerName: c.ownerName, title: c.title, email: s.email,
      clickUrl: `${base()}/e/c/${token}`, openUrl: `${base()}/e/o/${token}`, unsubscribeUrl: `${base()}/e/u/${token}`,
      invite: c.visibility === 'invite',
    });
    try {
      await sendMail({
        to: s.email, subject, text, html, tag: 'campaign', fromName: `${c.ownerName} via Sonikc`, replyTo: c.replyTo,
        idempotencyKey: `send-${s.id}`,
        headers: { 'List-Unsubscribe': `<${base()}/api/e/u/${token}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      await asService((tx) => tx`update email_sends set status = 'sent', sent_at = ${now()}, error = null where id = ${s.id}`);
    } catch (e) {
      const msg = String((e as Error).message ?? e).slice(0, 500);
      const giveUp = s.attempts >= MAX_ATTEMPTS;
      await asService((tx) => tx`update email_sends set status = ${giveUp ? 'failed' : 'queued'}, error = ${msg},
        next_attempt_at = now() + ${`${2 ** s.attempts} minutes`}::interval where id = ${s.id}`);
    }
  }
}

async function finish(c: Campaign, step: 0 | 1) {
  await asService(async (tx) => {
    if (step === 0) {
      const [done] = await tx<{ id: string }[]>`update campaigns set status = 'sent', sent_at = now() where id = ${c.id} and status = 'sending' returning id`;
      if (done && c.followupStatus === 'scheduled' && c.followupDays) {
        await enqueue(tx, 'campaign_followup', { campaignId: c.id }, new Date(Date.now() + c.followupDays * 86_400_000));
      }
    } else {
      await tx`update campaigns set followup_status = 'sent' where id = ${c.id} and followup_status = 'scheduled'`;
    }
  });
}

/**
 * Relance : seulement aux destinataires qui n'ont ni écouté (par leur lien ou autrement depuis l'envoi),
 * ni cliqué, ni répondu, et qui ne se sont pas désinscrits.
 */
export async function runFollowup(campaignId: string) {
  const c = await loadCampaign(campaignId);
  if (!c || c.status !== 'sent' || c.followupStatus !== 'scheduled') return;
  await asService((tx) => tx`
    insert into email_sends (owner_id, campaign_id, contact_id, email, step, link_id)
    select s0.owner_id, s0.campaign_id, s0.contact_id, s0.email, 1, s0.link_id
    from email_sends s0 left join contacts ct on ct.id = s0.contact_id
    where s0.campaign_id = ${campaignId} and s0.step = 0 and s0.status = 'sent'
      and s0.clicked_at is null and s0.replied_at is null and ct.unsubscribed_at is null
      and not exists (select 1 from listen_sessions ls where ls.link_id = s0.link_id
                      or (s0.contact_id is not null and ls.contact_id = s0.contact_id and ls.started_at >= s0.sent_at))
    on conflict do nothing`);
  await runCampaignSend(campaignId, 1);
}
