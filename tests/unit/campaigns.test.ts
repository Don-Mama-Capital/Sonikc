import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asService, withUser } from '@/lib/server/db';
import { runCampaignSend } from '@/lib/server/campaign-send';
import { createContact, deleteContact, importContacts, listContacts } from '@/lib/server/contacts';
import { campaignDetail, cancelCampaign, cancelFollowup, createCampaign, markReplied } from '@/lib/server/campaigns';
import { emailEvent } from '@/lib/server/email-events';
import { parseSendToken } from '@/lib/server/email-token';
import { updateShareSettings } from '@/lib/server/sharing';
import { listenStart, notifications, trackStats } from '@/lib/server/listening';
import { resolveLink } from '@/lib/server/viewer';
import { drain } from '../../worker/index';
import { makeUser } from './helpers';

type Sent = { to: string; subject: string; text: string; html: string; tag: string; from: string; replyTo: string; headers: Record<string, string>; idempotencyKey: string };
async function mails(to?: string): Promise<Sent[]> {
  const dir = process.env.MAIL_DIR!;
  const out: Sent[] = [];
  for (const f of await readdir(dir).catch(() => [] as string[])) {
    const m = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    if (m.tag === 'campaign' && (!to || m.to === to)) out.push(m);
  }
  return out;
}
const tokenIn = (m: Sent, kind: 'c' | 'o' | 'u') => new RegExp(`/e/${kind}/([A-Za-z0-9_-]{44})`).exec(m.text + m.html)![1];

async function setup(n = 3, visibility: 'public' | 'invite' | 'private' = 'public') {
  const owner = await makeUser();
  const trackId = await asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title) values (${owner.id}, 'Nocturne') returning id`;
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms)
      values (${t.id}, ${owner.id}, 1, 'v1', 'ready', 'n.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, 120000) returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    return t.id;
  });
  await updateShareSettings(owner.id, 'track', trackId, { visibility });
  const contacts = [];
  for (let i = 0; i < n; i++) {
    const email = `dest${i}_${randomUUID().slice(0, 6)}@label.fr`;
    contacts.push({ email, name: `Contact ${i}`, ...(await createContact(owner.id, { email, name: `Contact ${i}` })) });
  }
  return { owner, trackId, contacts };
}
const base = (s: Awaited<ReturnType<typeof setup>>, extra: Record<string, unknown> = {}) =>
  ({ kind: 'track', id: s.trackId, subject: 'Nouveau beat pour {prenom}', body: 'Salut {prenom},\n\nÉcoute ça.', ...extra });

describe('Lot 3.2 — emailing', () => {
  it('1. chaque destinataire a son propre lien ; son écoute arrive avec son nom', async () => {
    const s = await setup(2);
    const c = await createCampaign(s.owner.id, base(s));
    expect(c.recipients).toBe(2);
    await drain();
    const [a, b] = await Promise.all(s.contacts.map((x) => mails(x.email)));
    expect(a).toHaveLength(1);
    expect(a[0].subject).toBe('Nouveau beat pour Contact');
    expect(a[0].text).toContain('Salut Contact,');
    expect(a[0].replyTo).toBe(s.owner.email);
    expect(a[0].from).toMatch(/via Sonikc" </);
    expect(tokenIn(a[0], 'c')).not.toBe(tokenIn(b[0], 'c'));
    const click = await emailEvent(tokenIn(a[0], 'c'), 'click');
    const r = await resolveLink(click.ok ? click.sharePath!.split('/s/')[1] : '', null, undefined);
    if (r.status !== 'ok') throw new Error('lien personnel inaccessible');
    await listenStart(r.ctx, s.trackId, randomUUID());
    const st = await trackStats(s.owner.id, s.trackId);
    expect(st.recent[0]).toMatchObject({ who: 'Contact 0' });
    expect((await notifications(s.owner.id)).items[0]).toMatchObject({ kind: 'listen', actor: 'Contact 0' });
    const d = await campaignDetail(s.owner.id, c.id);
    expect(d.campaign).toMatchObject({ sent: 2, clicked: 1, opened: 1, listened: 1 });
  });

  it('2. désinscription en un clic (lien et en-tête) : plus aucun envoi à cette adresse pour ce producteur', async () => {
    const s = await setup(2);
    await createCampaign(s.owner.id, base(s));
    await drain();
    const [m] = await mails(s.contacts[0].email);
    expect(m.headers['List-Unsubscribe']).toMatch(/\/api\/e\/u\/[A-Za-z0-9_-]{44}>$/);
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect((await emailEvent(tokenIn(m, 'u'), 'unsubscribe')).ok).toBe(true);
    expect((await listContacts(s.owner.id, { q: s.contacts[0].email })).contacts[0].unsubscribed).toBe(true);
    const c2 = await createCampaign(s.owner.id, base(s));
    expect(c2.recipients).toBe(1);
    await drain();
    expect(await mails(s.contacts[0].email)).toHaveLength(1);
    // Même une liste explicite ne le recontacte pas.
    await expect(createCampaign(s.owner.id, base(s, { contactIds: [s.contacts[0].id] }))).rejects.toThrow('Aucun destinataire');
  });

  it('3. plafond quotidien par producteur : le reste part le lendemain ; échec réessayé puis en erreur, sans doublon', async () => {
    const s = await setup(3);
    process.env.MAIL_DAILY_LIMIT_PER_OWNER = '2';
    try {
      const c = await createCampaign(s.owner.id, base(s));
      await drain();
      const d = await campaignDetail(s.owner.id, c.id);
      expect(d.campaign).toMatchObject({ sent: 2, status: 'sending' });
      const [job] = await asService((tx) => tx<{ run_after: Date }[]>`select run_after from jobs where kind = 'campaign_send' and payload->>'campaignId' = ${c.id} and status = 'queued'`);
      expect(job.run_after.getTime() - Date.now()).toBeGreaterThan(0);
      expect(job.run_after.getUTCHours()).toBe(0);
    } finally { delete process.env.MAIL_DAILY_LIMIT_PER_OWNER; }

    const f = await setup(1);
    const dir = process.env.MAIL_DIR!;
    process.env.MAIL_DIR = '/dev/null/impossible';
    let campaignId = '';
    try {
      campaignId = (await createCampaign(f.owner.id, base(f))).id;
      for (let i = 0; i < 3; i++) {
        await drain();
        await asService((tx) => tx`update email_sends set next_attempt_at = now() where campaign_id = ${campaignId} and status = 'queued'`);
        await asService((tx) => tx`update jobs set run_after = now() where kind = 'campaign_send' and payload->>'campaignId' = ${campaignId} and status = 'queued'`);
      }
    } finally { process.env.MAIL_DIR = dir; }
    await drain();
    const d = await campaignDetail(f.owner.id, campaignId);
    expect(d.recipients[0]).toMatchObject({ status: 'failed' });
    expect(await mails(f.contacts[0].email)).toHaveLength(0);
    // Chaque envoi porte une clé d'idempotence unique (aucun doublon côté messagerie).
    const ok = await setup(1);
    await createCampaign(ok.owner.id, base(ok));
    await drain(); await drain();
    const sent = await mails(ok.contacts[0].email);
    expect(sent).toHaveLength(1);
    expect(sent[0].idempotencyKey).toMatch(/^send-[0-9a-f-]{36}$/);
  });

  it('4. ouvertures et clics comptés une fois ; le clic mène au partage ; jeton falsifié refusé', async () => {
    const s = await setup(1);
    const c = await createCampaign(s.owner.id, base(s));
    await drain();
    const [m] = await mails(s.contacts[0].email);
    await emailEvent(tokenIn(m, 'o'), 'open');
    const first = (await campaignDetail(s.owner.id, c.id)).recipients[0].openedAt;
    await new Promise((r) => setTimeout(r, 20));
    await emailEvent(tokenIn(m, 'o'), 'open');
    const click1 = await emailEvent(tokenIn(m, 'c'), 'click');
    await emailEvent(tokenIn(m, 'c'), 'click');
    const d = await campaignDetail(s.owner.id, c.id);
    expect(d.recipients[0].openedAt).toEqual(first);
    expect(d.campaign).toMatchObject({ opened: 1, clicked: 1 });
    expect(click1.ok && click1.sharePath).toMatch(/^\/s\/[A-Za-z0-9_-]{44}$/);
    const t = tokenIn(m, 'c');
    expect((await emailEvent(t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'), 'unsubscribe')).ok).toBe(false);
    expect(parseSendToken('x'.repeat(44))).toBeNull();
  });

  it('5. partage privé : envoi refusé ; sur invitation : chaque destinataire est invité', async () => {
    const p = await setup(1, 'private');
    await expect(createCampaign(p.owner.id, base(p))).rejects.toThrow('privé');
    const i = await setup(2, 'invite');
    await createCampaign(i.owner.id, base(i));
    const inv = await asService((tx) => tx<{ email: string }[]>`select email from invites where track_id = ${i.trackId} and revoked_at is null order by email`);
    expect(inv.map((x) => x.email)).toEqual(i.contacts.map((x) => x.email).sort());
    await drain();
    const [m] = await mails(i.contacts[0].email);
    expect(m.text).toContain('connecte-toi avec cette adresse');
  });

  it('un autre producteur ne voit ni ne modifie mes campagnes, ni n’envoie vers mes contacts', async () => {
    const s = await setup(1);
    const other = await makeUser();
    const c = await createCampaign(s.owner.id, base(s));
    await expect(campaignDetail(other.id, c.id)).rejects.toThrow();
    await expect(cancelCampaign(other.id, c.id)).rejects.toThrow();
    await expect(createCampaign(other.id, base(s))).rejects.toThrow();
    await expect(createCampaign(other.id, { ...base(s), id: s.trackId, contactIds: [s.contacts[0].id] })).rejects.toThrow();
  });
});

describe('Corrections de la relecture (phase 3, itération 2)', () => {
  it('désinscription définitive : survit à la suppression, à la recréation et à la réimportation du contact', async () => {
    const s = await setup(1);
    await createCampaign(s.owner.id, base(s));
    await drain();
    const [m] = await mails(s.contacts[0].email);
    await emailEvent(tokenIn(m, 'u'), 'unsubscribe');
    await deleteContact(s.owner.id, s.contacts[0].id);
    await createContact(s.owner.id, { email: s.contacts[0].email.toUpperCase(), name: 'Revenu' });
    await importContacts(s.owner.id, `email\n${s.contacts[0].email}`);
    expect((await listContacts(s.owner.id, { q: s.contacts[0].email })).contacts[0].unsubscribed).toBe(true);
    await expect(createCampaign(s.owner.id, base(s))).rejects.toThrow('Aucun destinataire');
    expect(await mails(s.contacts[0].email)).toHaveLength(1);
  });

  it('contact supprimé : rien de ce qui est en file ne part, et pas de relance', async () => {
    const s = await setup(2);
    const c = await createCampaign(s.owner.id, base(s, { scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
    await deleteContact(s.owner.id, s.contacts[0].id);
    await asService((tx) => tx`update jobs set run_after = now() where kind = 'campaign_send' and payload->>'campaignId' = ${c.id}`);
    await asService((tx) => tx`update campaigns set scheduled_at = now() where id = ${c.id}`);
    await drain();
    expect(await mails(s.contacts[0].email)).toHaveLength(0);
    expect(await mails(s.contacts[1].email)).toHaveLength(1);
    const f = await setup(1);
    const fc = await createCampaign(f.owner.id, base(f, { followup: { days: 1, subject: 'R', body: 'R' } }));
    await drain();
    await deleteContact(f.owner.id, f.contacts[0].id);
    await asService((tx) => tx`update jobs set run_after = now() where kind = 'campaign_followup' and payload->>'campaignId' = ${fc.id}`);
    await drain();
    expect(await mails(f.contacts[0].email)).toHaveLength(1);
  });

  it('objet sur une seule ligne, expéditeur entre guillemets', async () => {
    const s = await setup(1);
    await createCampaign(s.owner.id, base(s, { subject: 'Salut\r\nBcc: spam@evil.fr {nom}' }));
    await drain();
    const [m] = await mails(s.contacts[0].email);
    expect(m.subject).toBe('Salut Bcc: spam@evil.fr Contact 0');
    expect(m.from).toMatch(/^"[^"\r\n]+ via Sonikc" <[^>]+>$/);
  });

  it('plafond respecté même avec plusieurs envois en parallèle', async () => {
    const s = await setup(8);
    process.env.MAIL_DAILY_LIMIT_PER_OWNER = '5';
    try {
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await createCampaign(s.owner.id, base(s, { contactIds: s.contacts.slice(i * 2, i * 2 + 2).map((c) => c.id) }))).id);
      await Promise.all(ids.map((id) => runCampaignSend(id, 0)));
      const [{ n }] = await asService((tx) => tx<{ n: number }[]>`select count(*)::int as n from email_sends where owner_id = ${s.owner.id} and status = 'sent'`);
      expect(n).toBe(5);
    } finally { delete process.env.MAIL_DAILY_LIMIT_PER_OWNER; }
  });

  it('annulation : invitations et liens personnels retirés ; droits restreints du producteur', async () => {
    const s = await setup(1, 'invite');
    const c = await createCampaign(s.owner.id, base(s, { scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
    await cancelCampaign(s.owner.id, c.id);
    const [inv] = await asService((tx) => tx<{ revoked: boolean }[]>`select revoked_at is not null as revoked from invites where track_id = ${s.trackId}`);
    expect(inv.revoked).toBe(true);
    const [l] = await asService((tx) => tx<{ revoked: boolean }[]>`select revoked_at is not null as revoked from share_links where contact_id = ${s.contacts[0].id}`);
    expect(l.revoked).toBe(true);
    const [{ id: sendId }] = await asService((tx) => tx<{ id: string }[]>`select id from email_sends where campaign_id = ${c.id}`);
    await expect(withUser(s.owner.id, (tx) => tx`select app.email_event(${sendId}, 'unsubscribe')`)).rejects.toThrow('permission denied');
    await expect(withUser(s.owner.id, (tx) => tx`update campaigns set status = 'scheduled' where id = ${c.id}`)).rejects.toThrow('permission denied');
  });
});

describe('Lot 3.3 — programmation et relances', () => {
  it('1. un envoi programmé part à l’heure, à 1 min près', async () => {
    const s = await setup(1);
    const at = new Date(Date.now() + 2500);
    const c = await createCampaign(s.owner.id, base(s, { scheduledAt: at.toISOString() }));
    await drain();
    expect(await mails(s.contacts[0].email)).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 2700));
    await drain();
    expect(await mails(s.contacts[0].email)).toHaveLength(1);
    const d = await campaignDetail(s.owner.id, c.id);
    const sentAt = new Date(d.recipients[0].sentAt as string).getTime();
    expect(sentAt - at.getTime()).toBeGreaterThanOrEqual(0);
    expect(sentAt - at.getTime()).toBeLessThan(60_000);
  });

  it('2. la relance ne part pas à qui a écouté, cliqué, répondu ou s’est désinscrit', async () => {
    const s = await setup(5);
    const c = await createCampaign(s.owner.id, base(s, { followup: { days: 3, subject: 'Petite relance', body: 'Tu as pu écouter {prenom} ?' } }));
    await drain();
    const m = await Promise.all(s.contacts.map((x) => mails(x.email).then((l) => l[0])));
    // 0 écoute, 1 clique, 2 répond, 3 se désinscrit, 4 ne fait rien.
    const click0 = await emailEvent(tokenIn(m[0], 'c'), 'click'); // le clic compte aussi : on rouvre ensuite le lien
    const r0 = await resolveLink(click0.ok ? click0.sharePath!.split('/s/')[1] : '', null, undefined);
    if (r0.status !== 'ok') throw new Error();
    await listenStart(r0.ctx, s.trackId, randomUUID());
    await asService((tx) => tx`update email_sends set clicked_at = null where email = ${s.contacts[0].email}`); // isoler « a écouté »
    await emailEvent(tokenIn(m[1], 'c'), 'click');
    const d0 = await campaignDetail(s.owner.id, c.id);
    await markReplied(s.owner.id, d0.recipients.find((r) => r.email === s.contacts[2].email)!.id as string, true);
    await emailEvent(tokenIn(m[3], 'u'), 'unsubscribe');
    const [job] = await asService((tx) => tx<{ run_after: Date }[]>`select run_after from jobs where kind = 'campaign_followup' and payload->>'campaignId' = ${c.id}`);
    expect(job.run_after.getTime() - Date.now()).toBeGreaterThan(2.9 * 86_400_000);
    await asService((tx) => tx`update jobs set run_after = now() where kind = 'campaign_followup' and payload->>'campaignId' = ${c.id}`);
    await drain();
    const second = await Promise.all(s.contacts.map((x) => mails(x.email).then((l) => l.length)));
    expect(second).toEqual([1, 1, 1, 1, 2]);
    const last = (await mails(s.contacts[4].email)).find((x) => x.subject === 'Petite relance')!;
    expect(last.text).toContain('Tu as pu écouter Contact ?');
    const d = await campaignDetail(s.owner.id, c.id);
    expect(d.campaign).toMatchObject({ followupStatus: 'sent', followupSent: 1 });
  });

  it('3. programmation et relance annulables tant qu’elles ne sont pas parties', async () => {
    const s = await setup(2);
    const c = await createCampaign(s.owner.id, base(s, { scheduledAt: new Date(Date.now() + 3600_000).toISOString() }));
    await cancelCampaign(s.owner.id, c.id);
    await asService((tx) => tx`update jobs set run_after = now() where kind = 'campaign_send' and payload->>'campaignId' = ${c.id}`);
    await drain();
    expect(await mails(s.contacts[0].email)).toHaveLength(0);
    expect((await campaignDetail(s.owner.id, c.id)).recipients.map((r) => r.status)).toEqual(['skipped', 'skipped']);

    const c2 = await createCampaign(s.owner.id, base(s, { followup: { days: 2, subject: 'Relance', body: 'Alors ?' } }));
    await drain();
    await expect(cancelCampaign(s.owner.id, c2.id)).rejects.toThrow('déjà parti');
    await cancelFollowup(s.owner.id, c2.id);
    await asService((tx) => tx`update jobs set run_after = now() where kind = 'campaign_followup' and payload->>'campaignId' = ${c2.id}`);
    await drain();
    expect((await mails(s.contacts[1].email)).map((x) => x.subject)).toEqual(['Nouveau beat pour Contact']);
    expect((await campaignDetail(s.owner.id, c2.id)).campaign).toMatchObject({ followupStatus: 'cancelled' });
  });
});
