import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asService } from '@/lib/server/db';
import { completeUpload, startUpload } from '@/lib/server/uploads';
import { restoreTrack } from '@/lib/server/library';
import { exists, store } from '@/lib/server/storage';
import { updateShareSettings } from '@/lib/server/sharing';
import { trackStats, linkFunnel } from '@/lib/server/listening';
import { createContact, importContacts } from '@/lib/server/contacts';
import { createCampaign } from '@/lib/server/campaigns';
import { LimitReached } from '@/lib/server/plans';
import { LIMIT_LABELS, OFFERS, offerIds, type Limits } from '@/config/offers';
import { makeUser } from './helpers';

const limits = (id: keyof typeof OFFERS) => OFFERS[id].limits as Limits;

async function track(ownerId: string, title = 'Beat', visibility: string | null = null) {
  return asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, visibility) values (${ownerId}, ${title}, ${visibility}) returning id`;
    return t.id;
  });
}
async function contacts(ownerId: string, n: number) {
  await asService((tx) => tx`insert into contacts (owner_id, email) select ${ownerId}, 'c' || g || '_' || ${ownerId}::text || '@x.fr' from generate_series(1, ${n}) g`);
}
const expectLimit = async (p: Promise<unknown>, key: keyof Limits) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(LimitReached);
  expect((e as LimitReached).limit).toBe(key);
  expect((e as Error).message).toContain(`Limite de ton offre ${OFFERS.free.name}`);
  return e as LimitReached;
};

describe('Lot 5.1 — chaque limite du fichier des offres est appliquée côté serveur', () => {
  it('morceaux : nouvelle piste refusée au-delà, nouvelle version d’un morceau existant toujours possible', async () => {
    const u = await makeUser(undefined, 'free');
    const max = limits('free').tracks!;
    await asService((tx) => tx`insert into tracks (owner_id, title) select ${u.id}, 'b' || g from generate_series(1, ${max}) g`);
    const e = await expectLimit(startUpload(u.id, { filename: 'new.wav', size: 1000 }), 'tracks');
    expect(e.message).toContain(OFFERS.pro.name);
    const [t] = await asService((tx) => tx<{ id: string }[]>`select id from tracks where owner_id = ${u.id} limit 1`);
    await expect(startUpload(u.id, { filename: 'v2.wav', size: 1000, trackId: t.id })).resolves.toBeTruthy();
    // En corbeille, un morceau ne compte plus.
    await asService((tx) => tx`update tracks set deleted_at = now() where id = ${t.id}`);
    await expect(startUpload(u.id, { filename: 'new.wav', size: 1000 })).resolves.toBeTruthy();
    const p = await makeUser(undefined, 'pro');
    await asService((tx) => tx`insert into tracks (owner_id, title) select ${p.id}, 'b' || g from generate_series(1, ${max}) g`);
    await expect(startUpload(p.id, { filename: 'new.wav', size: 1000 })).resolves.toBeTruthy();
  });

  it('stockage : envoi refusé s’il dépasse l’espace de l’offre', async () => {
    const u = await makeUser(undefined, 'free');
    const t = await track(u.id);
    const quota = limits('free').storageGb * 1e9;
    await asService((tx) => tx`insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key, size_bytes)
      values (${t}, ${u.id}, 1, 'v1', 'a.wav', 'k', ${quota - 1000})`);
    await expectLimit(startUpload(u.id, { filename: 'b.wav', size: 2000, trackId: t }), 'storageGb');
    await expect(startUpload(u.id, { filename: 'b.wav', size: 500, trackId: t })).resolves.toBeTruthy();
  });

  it('stockage : les envois commencés comptent tout de suite ; un fichier plus lourd qu’annoncé est refusé', async () => {
    const u = await makeUser(undefined, 'free');
    const quota = limits('free').storageGb * 1e9;
    const share = 450_000_000; // sous la taille maximale d'un fichier
    const n = Math.floor(quota / share);
    for (let i = 0; i < n; i++) await startUpload(u.id, { filename: `a${i}.wav`, size: share });
    await expectLimit(startUpload(u.id, { filename: 'z.wav', size: share }), 'storageGb');
    await expectLimit(startUpload(u.id, { filename: 'z.zip', size: 250_000_000 }), 'storageGb');
    // Annoncé 10 octets, reçu 2000 : refusé, fichier effacé.
    const tk = await startUpload(u.id, { filename: 'petit.wav', size: 10 });
    const [v] = await asService((tx) => tx<{ key: string }[]>`select original_key as key from track_versions where id = ${tk.id}`);
    await store().put(v.key, Buffer.alloc(2000), 2000);
    await expect(completeUpload(u.id, 'version', tk.id)).rejects.toThrow('plus lourd');
    expect(await exists(v.key)).toBe(false);
  });

  it('stockage des offres payantes : Pro et Studio plafonnés à leur valeur de la config', async () => {
    for (const plan of ['pro', 'studio'] as const) {
      const u = await makeUser(undefined, plan);
      const t = await track(u.id);
      const quota = limits(plan).storageGb * 1e9;
      await asService((tx) => tx`insert into track_versions (track_id, owner_id, version_no, label, original_filename, original_key, size_bytes)
        values (${t}, ${u.id}, 1, 'v1', 'a.wav', 'k', ${quota - 1000})`);
      const e = await startUpload(u.id, { filename: 'b.wav', size: 2000, trackId: t }).then(() => null, (x) => x);
      expect(e).toBeInstanceOf(LimitReached);
      expect((e as LimitReached).limit).toBe('storageGb');
      expect((e as Error).message).toContain(`Limite de ton offre ${OFFERS[plan].name}`);
    }
    expect([limits('pro').storageGb, limits('studio').storageGb]).toEqual([100, 500]);
  });

  it('morceaux : restaurer depuis la corbeille compte aussi dans la limite', async () => {
    const u = await makeUser(undefined, 'free');
    const max = limits('free').tracks!;
    await asService((tx) => tx`insert into tracks (owner_id, title) select ${u.id}, 'b' || g from generate_series(1, ${max}) g`);
    const [t] = await asService((tx) => tx<{ id: string }[]>`update tracks set deleted_at = now()
      where id = (select id from tracks where owner_id = ${u.id} limit 1) returning id`);
    await asService((tx) => tx`insert into tracks (owner_id, title) values (${u.id}, 'nouveau')`);
    await expectLimit(restoreTrack(u.id, t.id), 'tracks');
    await asService((tx) => tx`update tracks set deleted_at = now() where owner_id = ${u.id} and title = 'nouveau'`);
    await expect(restoreTrack(u.id, t.id)).resolves.toBeUndefined();
  });

  it('mot de passe sur un partage : réservé aux offres qui l’incluent', async () => {
    const u = await makeUser(undefined, 'free');
    const t = await track(u.id);
    await expectLimit(updateShareSettings(u.id, 'track', t, { visibility: 'public', password: 'motdepasse1' }), 'passwordLinks');
    await expect(updateShareSettings(u.id, 'track', t, { visibility: 'public' })).resolves.toBeTruthy();
    const p = await makeUser(undefined, 'pro');
    const tp = await track(p.id);
    await expect(updateShareSettings(p.id, 'track', tp, { visibility: 'public', password: 'motdepasse1' })).resolves.toBeTruthy();
  });

  it('historique des écoutes : limité aux derniers jours de l’offre, complet ailleurs (rien n’est effacé)', async () => {
    const u = await makeUser(undefined, 'free');
    const t = await track(u.id, 'Beat', 'public');
    const days = limits('free').statsDays!;
    await asService((tx) => tx`insert into listen_sessions (owner_id, track_id, visitor, source, listened_ms, started_at) values
      (${u.id}, ${t}, 'v1', 'direct', 40000, now() - ${`${days + 10} days`}::interval),
      (${u.id}, ${t}, 'v2', 'direct', 40000, now() - interval '1 day')`);
    expect((await trackStats(u.id, t)).plays).toBe(1);
    expect((await trackStats(u.id, t)).statsDays).toBe(days);
    await asService((tx) => tx`update profiles set plan = 'pro' where user_id = ${u.id}`);
    expect((await trackStats(u.id, t)).plays).toBe(2);
    expect(await linkFunnel(u.id, 'track', t)).toEqual([]);
  });

  it('contacts : ajout et import refusés au-delà de la limite', async () => {
    const u = await makeUser(undefined, 'free');
    await contacts(u.id, limits('free').contacts);
    await expectLimit(createContact(u.id, { email: 'plus@x.fr' }), 'contacts');
    await expectLimit(importContacts(u.id, 'email\nun@x.fr\ndeux@x.fr'), 'contacts');
    expect(await asService((tx) => tx`select 1 from contacts where owner_id = ${u.id} and email in ('un@x.fr', 'deux@x.fr')`)).toEqual([]);
  });

  it('emails par mois, envois programmés, relances : contrôlés à la création de l’envoi', async () => {
    const u = await makeUser(undefined, 'free');
    const t = await track(u.id, 'Beat', 'public');
    const max = limits('free').emailsPerMonth;
    await contacts(u.id, max + 1);
    await expectLimit(createCampaign(u.id, { kind: 'track', id: t, subject: 'Nouveau beat', body: 'Écoute {lien}' }), 'emailsPerMonth');
    const ids = (await asService((tx) => tx<{ id: string }[]>`select id from contacts where owner_id = ${u.id} order by created_at limit 2`)).map((r) => r.id);
    await expectLimit(createCampaign(u.id, { kind: 'track', id: t, subject: 'Nouveau beat', body: 'Écoute {lien}', contactIds: ids,
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }), 'scheduledSends');
    await expectLimit(createCampaign(u.id, { kind: 'track', id: t, subject: 'Nouveau beat', body: 'Écoute {lien}', contactIds: ids,
      followup: { days: 3, subject: 'Relance', body: 'Tu as écouté ? {lien}' } }), 'followUps');
    await expect(createCampaign(u.id, { kind: 'track', id: t, subject: 'Nouveau beat', body: 'Écoute {lien}', contactIds: ids })).resolves.toBeTruthy();
    // Pro : programmation oui, relances non ; Studio : les deux.
    await asService((tx) => tx`update profiles set plan = 'pro' where user_id = ${u.id}`);
    await expect(createCampaign(u.id, { kind: 'track', id: t, subject: 'Nouveau beat', body: 'Écoute {lien}', contactIds: ids,
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString() })).resolves.toBeTruthy();
    await expect(createCampaign(u.id, { kind: 'track', id: t, subject: 'Nouveau beat', body: 'Écoute {lien}', contactIds: ids,
      followup: { days: 3, subject: 'Relance', body: 'Tu as écouté ? {lien}' } })).rejects.toThrow(LimitReached);
  });
});

describe('Lot 5.1 — fichier unique et zéro texte d’offre en dur', () => {
  async function files(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await files(p)));
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it('aucun nom, prix ou commission d’offre écrit ailleurs que dans le fichier des offres ; rien de « bientôt »', async () => {
    const names = offerIds.map((id) => OFFERS[id].name);
    const prices = offerIds.flatMap((id) => [OFFERS[id].priceMonthCents, OFFERS[id].priceYearCents]).filter(Boolean).map((c) => String(c / 100));
    for (const f of await files('src')) {
      if (f.endsWith(path.join('config', 'offers.ts'))) continue;
      const src = await readFile(f, 'utf8');
      for (const n of names) expect(src, `${f} : « ${n} »`).not.toMatch(new RegExp(`['"\`>]${n}['"\`<]`));
      for (const p of prices) expect(src, `${f} : prix ${p}`).not.toMatch(new RegExp(`\\b${p}\\s?(€|euros)`));
      expect(src, `${f} : commissionPct`).not.toMatch(/commissionPct\s*:\s*\d/);
      expect(src.toLowerCase(), `${f} : « bientôt »`).not.toContain('bientôt');
    }
  });

  it('chaque limite a un libellé ; chaque avantage annoncé est une limite contrôlée', () => {
    const keys = Object.keys(LIMIT_LABELS).sort();
    for (const id of offerIds) expect(Object.keys(OFFERS[id].limits).sort()).toEqual(keys);
    // Les contrôles du serveur couvrent toutes les limites (une fonction par clé).
    expect(keys).toEqual(['contacts', 'emailsPerMonth', 'followUps', 'passwordLinks', 'scheduledSends', 'statsDays', 'storageGb', 'tracks'].sort());
  });
});
