import { COOKIES } from '@/config/cookies';
import { LegalPage } from '@/components/legal/Legal';
import { ConsentReopen } from '@/components/legal/ConsentBanner';

export const metadata = { title: 'Cookies' };

export default function CookiesPage() {
  return (
    <LegalPage title="Cookies" updated="23/11/2026">
      <p>Sonikc n’utilise ni publicité ni outil de mesure d’une autre entreprise. Voici tous les cookies posés, à quoi ils servent et combien de temps ils restent.</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left" data-testid="cookie-list">
          <thead><tr className="text-mute"><th className="py-2 pr-3">Nom</th><th className="py-2 pr-3">À quoi il sert</th><th className="py-2 pr-3">Durée</th><th className="py-2">Ton accord</th></tr></thead>
          <tbody className="divide-y divide-line">
            {COOKIES.map((c) => (
              <tr key={c.name}><td className="py-2 pr-3 font-mono text-xs">{c.name}</td><td className="py-2 pr-3">{c.purpose}</td>
                <td className="py-2 pr-3">{c.duration}</td><td className="py-2">{c.needsConsent ? 'Demandé' : 'Indispensable'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Si tu refuses</h2>
      <p>Tu écoutes exactement de la même façon. Le producteur voit toujours qu’un partage a été écouté, mais sans pouvoir te reconnaître d’une visite à l’autre : rien n’est écrit sur ton appareil.</p>
      <ConsentReopen className="btn-ghost" />
    </LegalPage>
  );
}
