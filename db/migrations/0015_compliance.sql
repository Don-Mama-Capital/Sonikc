-- Lot 5.3 : conformité.
-- Renonciation expresse au droit de rétractation (contenu numérique livré immédiatement), horodatée sur la commande.
alter table orders add column withdrawal_waived_at timestamptz;
-- Compte supprimé : la ligne reste (ventes et factures gardées pour la loi), sans données personnelles.
alter table users add column deleted_at timestamptz;
