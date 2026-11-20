import { describe, expect, it } from 'vitest';
import { asService, withUser } from '@/lib/server/db';
import { createLink, updateShareSettings } from '@/lib/server/sharing';
import { addToProject, createProject } from '@/lib/server/library';
import { listTemplates, publicPreviewKey, saveTemplate, setTrackLicence, storefront, deleteTemplate, updatePublicProfile } from '@/lib/server/storefront';
import { handleProblem } from '@/lib/handle';
import { FORMAT_LABEL, licenceLines } from '@/lib/licences';
import { makeUser } from './helpers';

async function track(ownerId: string, title: string, bpm: number, keyPc: number, keyMode: 'major' | 'minor') {
  return asService(async (tx) => {
    const [t] = await tx<{ id: string }[]>`insert into tracks (owner_id, title, bpm, key_pc, key_mode, tags) values (${ownerId}, ${title}, ${bpm}, ${keyPc}, ${keyMode}, ${['trap']}) returning id`;
    const [v] = await tx<{ id: string }[]>`insert into track_versions (track_id, owner_id, version_no, label, status, original_filename, original_key, preview_key, duration_ms, format)
      values (${t.id}, ${ownerId}, 1, 'v1', 'ready', 'b.wav', ${`o/${t.id}`}, ${`p/${t.id}`}, 60000, 'wav') returning id`;
    await tx`update tracks set current_version_id = ${v.id} where id = ${t.id}`;
    return { id: t.id, versionId: v.id };
  });
}

async function shop() {
  const u = await makeUser();
  const pub = await track(u.id, 'Public 140', 140, 9, 'minor');
  const sale = await track(u.id, 'En vente 90', 90, 0, 'major');
  const priv = await track(u.id, 'Privé', 100, 2, 'major');
  const invite = await track(u.id, 'Invités', 110, 4, 'minor');
  const pass = await track(u.id, 'Protégé', 120, 5, 'major');
  const inProject = await track(u.id, 'Dans un projet public', 95, 7, 'major');
  const inPrivProject = await track(u.id, 'Dans un projet privé', 95, 7, 'major');
  await updateShareSettings(u.id, 'track', pub.id, { visibility: 'public' });
  await updateShareSettings(u.id, 'track', sale.id, { visibility: 'for_sale' });
  await updateShareSettings(u.id, 'track', priv.id, { visibility: 'private' });
  await updateShareSettings(u.id, 'track', invite.id, { visibility: 'invite' });
  await updateShareSettings(u.id, 'track', pass.id, { visibility: 'public', password: 'motdepasse1' });
  const pp = await createProject(u.id, { title: 'EP public' });
  await addToProject(u.id, pp.id, [inProject.id]);
  await updateShareSettings(u.id, 'project', pp.id, { visibility: 'public' });
  const pr = await createProject(u.id, { title: 'Projet privé' });
  await addToProject(u.id, pr.id, [inPrivProject.id]);
  return { u, pub, sale, priv, invite, pass, inProject, inPrivProject, pp, pr };
}

describe('Lot 4.1 — page publique', () => {
  it('1. seul le public apparaît (morceaux publics, en vente, ou suivant un projet public) ; contrôlé par la base', async () => {
    const s = await shop();
    await updatePublicProfile(s.u.id, { bio: 'Prod à Paris', links: { instagram: 'instagram.com/prod', site: 'javascript:alert(1)' } }).catch(() => {});
    await updatePublicProfile(s.u.id, { bio: 'Prod à Paris', links: { instagram: 'instagram.com/prod' } });
    const page = await storefront(s.u.handle);
    expect(page!.profile).toMatchObject({ bio: 'Prod à Paris', links: { instagram: 'https://instagram.com/prod' } });
    expect(page!.tracks.map((t) => t.title).sort()).toEqual(['Dans un projet public', 'En vente 90', 'Public 140']);
    expect(page!.projects.map((p) => p.title)).toEqual(['EP public']);
    // Hors contexte « catalogue », un autre compte ne voit rien de tout ça.
    const other = await makeUser();
    expect(await withUser(other.id, (tx) => tx`select id from tracks where id = ${s.pub.id}`)).toEqual([]);
    // L'audio public ne sert que la version courante d'un morceau public.
    expect(await publicPreviewKey(s.pub.versionId)).toBe(`p/${s.pub.id}`);
    expect(await publicPreviewKey(s.priv.versionId)).toBeNull();
    expect(await publicPreviewKey(s.pass.versionId)).toBeNull();
  });

  it('2. recherche et filtres BPM, tonalité, prix', async () => {
    const s = await shop();
    const titles = async (f: Record<string, unknown>) => (await storefront(s.u.handle, f))!.tracks.map((t) => t.title).sort();
    expect(await titles({ bpmMin: 92, bpmMax: 150 })).toEqual(['Dans un projet public', 'Public 140']);
    expect(await titles({ key: '9-minor' })).toEqual(['Public 140']);
    expect(await titles({ q: 'vente' })).toEqual(['En vente 90']);
    expect(await titles({ q: 'trap' })).toHaveLength(3);
    // Prix : le moins cher en vente = Basique 29 € HT = 34,80 € TTC France.
    expect(await titles({ priceMax: 34 })).toEqual([]);
    expect(await titles({ priceMax: 35 })).toEqual(['En vente 90']);
    expect(await titles({ project: s.pp.id })).toEqual(['Dans un projet public']);
    expect(await titles({ key: 'n’importe quoi' })).toHaveLength(3); // filtre invalide ignoré
  });

  it('3. identifiants réservés refusés ; inconnu = introuvable', async () => {
    for (const h of ['app', 'login', 'recus', 'achats', 'checkout', 'stripe']) expect(handleProblem(h)).toBe('Cet identifiant est réservé.');
    expect(await storefront('personne_inconnue_xyz')).toBeNull();
  });
});

describe('Lot 4.2 — licences', () => {
  it('1. modèles proposés par défaut puis modifiables ; prix par morceau', async () => {
    const u = await makeUser();
    const t = await listTemplates(u.id);
    expect(t.map((x) => x.name)).toEqual(['Basique', 'Premium', 'Exclusive']);
    expect(await listTemplates(u.id)).toHaveLength(3); // pas de doublon au second passage
    await saveTemplate(u.id, t[0].id, { ...t[0], priceCents: 1990, formats: ['mp3', 'wav'] });
    const { id } = await saveTemplate(u.id, null, { name: 'Location', description: '', formats: ['mp3'], maxStreams: 10000, maxCopies: null, musicVideos: 0, radio: false, exclusive: false, priceCents: 990 });
    const sale = await track(u.id, 'Beat', 90, 0, 'major');
    await updateShareSettings(u.id, 'track', sale.id, { visibility: 'for_sale' });
    await setTrackLicence(u.id, sale.id, id, { enabled: true, priceCents: 1490 });
    const page = await storefront(u.handle);
    const offers = page!.tracks[0].offers;
    expect(offers.map((o) => [o.name, o.netCents])).toEqual([['Basique', 1990], ['Premium', 5900], ['Exclusive', 49900], ['Location', 1490]]);
    await expect(saveTemplate(u.id, null, { name: 'Gratuite', formats: ['mp3'], maxStreams: null, maxCopies: null, musicVideos: null, radio: false, exclusive: false, priceCents: 0 })).rejects.toThrow();
    const other = await makeUser();
    await expect(saveTemplate(other.id, id, { ...t[0] })).rejects.toThrow();
    await expect(setTrackLicence(other.id, sale.id, id, { enabled: false })).rejects.toThrow();
  });

  it('2. libellés lisibles, aucune clé technique', () => {
    const lines = licenceLines({ formats: ['mp3', 'wav', 'stems'], maxStreams: 500000, maxCopies: null, musicVideos: 0, radio: true, exclusive: true }).join(' | ');
    expect(lines).toContain('MP3, WAV, Pistes séparées (stems)');
    expect(lines).toContain('500');
    expect(lines).toMatch(/illimités/);
    const words = lines.replace('Pistes séparées (stems)', '').split(/[\s,|:()]+/);
    for (const raw of ['mp3', 'wav', 'stems', 'max_streams', 'maxCopies', 'null', 'true', 'false', 'exclusive']) {
      expect(words).not.toContain(raw);
    }
    expect(Object.keys(FORMAT_LABEL)).toEqual(['mp3', 'wav', 'stems']);
  });

  it('3. licence indisponible masquée ; exclusive vendue = morceau retiré de la vente', async () => {
    const u = await makeUser();
    const tpls = await listTemplates(u.id);
    const sale = await track(u.id, 'Beat', 90, 0, 'major');
    await updateShareSettings(u.id, 'track', sale.id, { visibility: 'for_sale' });
    await setTrackLicence(u.id, sale.id, tpls[1].id, { enabled: false });
    await deleteTemplate(u.id, tpls[0].id);
    await saveTemplate(u.id, null, { name: 'Stems', formats: ['stems'], maxStreams: null, maxCopies: null, musicVideos: null, radio: true, exclusive: false, priceCents: 9900 });
    expect((await storefront(u.handle))!.tracks[0].offers.map((o) => o.name)).toEqual(['Exclusive']);
    await asService((tx) => tx`update tracks set exclusive_reserved_until = now() + interval '10 minutes' where id = ${sale.id}`);
    expect((await storefront(u.handle))!.tracks[0].offers).toEqual([]);
    await asService((tx) => tx`update tracks set exclusive_reserved_until = null, exclusive_sold_at = now() where id = ${sale.id}`);
    const t = (await storefront(u.handle))!.tracks[0];
    expect(t).toMatchObject({ soldExclusive: true, offers: [] });
    // L'app ne peut pas « dévendre » une exclusivité.
    await expect(withUser(u.id, (tx) => tx`update tracks set exclusive_sold_at = null where id = ${sale.id}`)).rejects.toThrow('permission denied');
  });
});

describe('Lot 4.2 — vente par projet', () => {
  it('4. un morceau sans réglage propre suit son projet « En vente »', async () => {
    const u = await makeUser();
    const t = await track(u.id, 'Suit le projet', 90, 0, 'major');
    const p = await createProject(u.id, { title: 'Pack' });
    await addToProject(u.id, p.id, [t.id]);
    await updateShareSettings(u.id, 'project', p.id, { visibility: 'for_sale' });
    const page = await storefront(u.handle);
    expect(page!.tracks.map((x) => [x.title, x.offers.length])).toEqual([['Suit le projet', 3]]);
  });
});
