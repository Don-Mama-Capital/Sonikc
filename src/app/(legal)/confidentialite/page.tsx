import { LegalPage, Todo } from '@/components/legal/Legal';
import { COMPANY } from '@/config/company';

export const metadata = { title: 'Confidentialité' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Confidentialité" updated="24/11/2026">
      <p>Responsable du traitement : {COMPANY.name}. Contact : <Todo>adresse email pour les demandes sur les données</Todo>.</p>
      <h2>Ce que nous gardons, et pourquoi</h2>
      <ul>
        <li>Ton compte (email, identifiant, nom affiché, présentation, liens) : faire fonctionner le service.</li>
        <li>Tes morceaux et leurs fichiers, dossiers, projets, partages : le service lui-même.</li>
        <li>Les écoutes de tes partages (durée, lien utilisé, nom si l’auditeur est connu) : te montrer qui écoute ; l’auditeur en est informé sur la page.</li>
        <li>Tes contacts et tes envois : t’aider à écrire à des personnes qui l’ont accepté.</li>
        <li>Les ventes, factures et virements : obligations comptables et fiscales (conservés 10 ans).</li>
        <li>Si tu as eu un essai gratuit : une empreinte (donnée pseudonymisée) de ton adresse email et de ton compte Google, gardée 3 ans même après la suppression de ton compte. Base : notre intérêt légitime à éviter les essais répétés. Elle ne permet pas de lire ton adresse, seulement de reconnaître la même adresse.</li>
      </ul>
      <h2>Avec qui nous les partageons</h2>
      <p>Supabase (hébergement, Union européenne), Stripe (paiements), Resend (envoi des emails), Google (si tu te connectes avec Google). <Todo>hébergeur de l’application, transferts hors UE et garanties</Todo></p>
      <h2>Tes droits</h2>
      <p>Tu peux télécharger toutes tes données en un fichier et supprimer ton compte depuis « Mes données ». Pour toute autre demande (rectification, opposition…), écris-nous ; tu peux aussi saisir la CNIL.</p>
      <h2>Durées</h2>
      <p><Todo>durées de conservation détaillées par catégorie</Todo></p>
    </LegalPage>
  );
}
