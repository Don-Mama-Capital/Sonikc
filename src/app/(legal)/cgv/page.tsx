import { LegalPage, Todo } from '@/components/legal/Legal';
import { COMPANY } from '@/config/company';

export const metadata = { title: 'Conditions de vente' };

export default function CgvPage() {
  return (
    <LegalPage title="Conditions de vente" updated="23/11/2026">
      <h2>1. Qui vend</h2>
      <p>Les licences sont vendues par {COMPANY.name}, au nom et pour le compte du producteur du morceau (mandat de vente). {COMPANY.name} encaisse le paiement, émet la facture et reverse sa part au producteur. <Todo>références du mandat et identification des vendeurs professionnels</Todo></p>
      <h2>2. Prix</h2>
      <p>Les prix sont fixés hors taxes par le producteur. La TVA du pays de l’acheteur s’y ajoute ; le total TTC est affiché avant le paiement.</p>
      <h2>3. Licence</h2>
      <p>Chaque licence précise les fichiers livrés et les droits accordés (écoutes, ventes, clips, radio, exclusivité). Le PDF de licence et son certificat sont remis avec les fichiers.</p>
      <h2>4. Livraison</h2>
      <p>Les fichiers sont livrés immédiatement après le paiement, sur la page de la commande et par email.</p>
      <h2>5. Droit de rétractation</h2>
      <p>S’agissant d’un contenu numérique livré immédiatement, l’acheteur demande expressément cette livraison avant la fin du délai de rétractation et reconnaît perdre son droit de rétractation (case à cocher avant le paiement). <Todo>validation du texte par un juriste</Todo></p>
      <h2>6. Remboursement</h2>
      <p>Une vente peut être remboursée par le producteur jusqu’au virement de sa part, puis par {COMPANY.name}. Une licence remboursée n’est plus valable et un avoir est émis.</p>
      <h2>7. Litiges</h2>
      <p><Todo>médiateur de la consommation, plateforme européenne de règlement des litiges, juridiction</Todo></p>
    </LegalPage>
  );
}
