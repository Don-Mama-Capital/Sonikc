import { currentUser } from '@/lib/server/session';
import { listPurchases, orderToken } from '@/lib/server/commerce';
import { euros } from '@/lib/licences';

export default async function PurchasesPage() {
  const user = (await currentUser())!;
  const rows = await listPurchases(user.id);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold">Mes achats</h1>
        <p className="text-sm text-mute">Les licences achetées avec {user.email}. Fichiers, licence et facture sont dans chaque commande.</p>
      </header>
      {rows.length === 0 ? <p className="card p-6 text-center text-sm text-mute">Aucun achat pour l’instant.</p> : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-panel" data-testid="purchases">
          {rows.map((p) => (
            <li key={p.id}>
              <a className="flex items-center gap-3 px-4 py-3 hover:bg-panel-2" href={`/commande/${orderToken(p.id)}`}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.trackTitle}</span>
                  <span className="block text-xs text-mute">{p.sellerName} · licence {p.licenceName} · {p.paidAt.toLocaleDateString('fr-FR')}</span>
                </span>
                <span className="shrink-0 text-sm">{p.status === 'refunded' ? <span className="text-mute">Remboursé</span> : euros(p.grossCents)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
