import { LegalPage, Todo } from '@/components/legal/Legal';
import { COMPANY } from '@/config/company';

export const metadata = { title: 'Mentions légales' };

export default function MentionsPage() {
  return (
    <LegalPage title="Mentions légales" updated="23/11/2026">
      <h2>Éditeur</h2>
      <p>{COMPANY.name} — <Todo>forme juridique, capital, RCS, SIRET</Todo> — <Todo>adresse du siège</Todo> — N° de TVA : <Todo>numéro intracommunautaire</Todo>.</p>
      <p>Directeur de la publication : <Todo>nom</Todo>. Contact : <Todo>adresse email de contact</Todo>.</p>
      <h2>Hébergement</h2>
      <p>Base de données et fichiers : Supabase (serveurs dans l’Union européenne, Irlande). Application : <Todo>hébergeur choisi à la mise en ligne, adresse</Todo>.</p>
      <h2>Paiements</h2>
      <p>Les paiements sont traités par Stripe. Sonikc ne voit ni ne conserve aucun numéro de carte.</p>
      <h2>Propriété intellectuelle</h2>
      <p>Les morceaux publiés appartiennent à leurs auteurs. La marque et l’interface de Sonikc appartiennent à {COMPANY.name}. <Todo>dépôt de marque</Todo></p>
    </LegalPage>
  );
}
