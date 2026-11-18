/** Mise en forme d'un email d'envoi : texte brut + HTML simple, accessible, sans image externe hors pixel d'ouverture. */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function personalize(text: string, contactName: string | null) {
  const full = (contactName ?? '').trim();
  const first = full.split(/\s+/)[0] ?? '';
  return text.replace(/\{prenom\}|\{prénom\}/gi, first).replace(/\{nom\}/gi, full).replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+([,.])/g, '$1'); // pas d'espace avant « , » « . » ; « ? » et « ! » gardent l'espace français
}

export function renderCampaignEmail(o: {
  body: string; contactName: string | null; ownerName: string; title: string;
  clickUrl: string; openUrl: string; unsubscribeUrl: string; invite: boolean; email: string;
}) {
  const body = personalize(o.body, o.contactName).trim();
  const cta = `Écouter « ${o.title} »`;
  const inviteNote = o.invite ? `Ce partage est réservé : connecte-toi avec cette adresse (${o.email}) pour l’écouter.` : '';
  const tracking = `${o.ownerName} verra si tu écoutes (date et durée).`;
  const text = [body, '', `${cta} : ${o.clickUrl}`, inviteNote, '', '—', tracking, `Ne plus recevoir d’emails de ${o.ownerName} : ${o.unsubscribeUrl}`]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  const paragraphs = body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 16px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#18181b">
<div style="max-width:560px;margin:0 auto;padding:24px">
<div style="background:#fff;border-radius:16px;padding:28px;font-size:16px;line-height:1.55">
${paragraphs}
<p style="margin:24px 0"><a href="${esc(o.clickUrl)}" style="display:inline-block;background:#ff5a36;color:#0b0b0e;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px">${esc(cta)}</a></p>
${inviteNote ? `<p style="margin:0;font-size:14px;color:#52525b">${esc(inviteNote)}</p>` : ''}
</div>
<p style="font-size:12px;color:#71717a;margin:16px 4px">${esc(tracking)} <a href="${esc(o.unsubscribeUrl)}" style="color:#71717a">Ne plus recevoir d’emails de ${esc(o.ownerName)}</a>. Envoyé avec Sonikc.</p>
</div><img src="${esc(o.openUrl)}" width="1" height="1" alt="" style="display:block;border:0"></body></html>`;
  return { text, html };
}
