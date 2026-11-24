import { LegalPage, Todo } from '@/components/legal/Legal';

export const metadata = { title: 'Conditions d’utilisation' };

export default function CguPage() {
  return (
    <LegalPage title="Conditions d’utilisation" updated="23/11/2026">
      <h2>1. Le service</h2>
      <p>Sonikc permet de ranger ses morceaux, de les partager par lien, de savoir qui les écoute, d’écrire à ses contacts et de vendre des licences.</p>
      <h2>2. Ton compte</h2>
      <p>La connexion se fait par code envoyé par email ou avec Google. Tu es responsable de ce qui est publié avec ton compte. Tu peux exporter tes données et supprimer ton compte à tout moment depuis « Mes données ».</p>
      <h2>3. Ce que tu publies</h2>
      <p>Tu garantis avoir les droits sur les morceaux que tu envoies et partages. Sont interdits : les contenus qui ne t’appartiennent pas, illicites, ou envoyés à des personnes qui ne l’ont pas demandé. <Todo>procédure de signalement et de retrait (DSA)</Todo></p>
      <h2>4. Statistiques d’écoute</h2>
      <p>Quand tu partages un morceau, tu vois qui l’écoute et combien de temps. La personne qui écoute en est informée sur la page d’écoute.</p>
      <h2>5. Emails à tes contacts</h2>
      <p>Tu n’écris qu’à des personnes qui ont accepté de te recevoir. Chaque email contient un lien de désinscription respecté immédiatement.</p>
      <h2>6. Offres et abonnements</h2>
      <p>Les offres, leurs prix et leurs limites sont décrits sur la page Tarifs. Si tu passes à une offre plus petite, rien n’est supprimé : seuls les ajouts au-delà des limites sont bloqués. <Todo>durée, résiliation, remboursement des abonnements</Todo></p>
      <h2>7. Responsabilité</h2>
      <p><Todo>limites de responsabilité, disponibilité du service, force majeure</Todo></p>
      <h2>8. Droit applicable</h2>
      <p><Todo>droit français, médiateur de la consommation, juridiction</Todo></p>
    </LegalPage>
  );
}
