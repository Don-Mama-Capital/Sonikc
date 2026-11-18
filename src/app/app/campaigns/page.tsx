import Link from 'next/link';
import { requireUser } from '@/lib/server/session';
import { listCampaigns } from '@/lib/server/campaigns';

export const metadata = { title: 'Envois' };
const STATUS: Record<string, string> = { scheduled: 'Programmé', sending: 'En cours', sent: 'Envoyé', cancelled: 'Annulé' };

export default async function CampaignsPage() {
  const user = await requireUser();
  const list = await listCampaigns(user.id);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Envois</h1>
      <p className="text-sm text-mute">Pour envoyer un projet ou un morceau, ouvre-le et clique sur « Envoyer par email ».</p>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel" data-testid="campaigns">
        {list.map((c) => (
          <li key={String(c.id)}>
            <Link href={`/app/campaigns/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 hover:bg-panel-2">
              <span className="min-w-0 flex-1 truncate font-medium">{String(c.subject)} <span className="text-mute">· {String(c.title ?? '')}</span></span>
              <span className="text-xs text-mute">{STATUS[String(c.status)]} · {String(c.sent)}/{String(c.recipients)} envoyés · {String(c.listened)} écoute{Number(c.listened) > 1 ? 's' : ''}</span>
            </Link>
          </li>
        ))}
        {!list.length && <li className="px-3 py-4 text-sm text-mute">Aucun envoi pour l’instant.</li>}
      </ul>
    </div>
  );
}
