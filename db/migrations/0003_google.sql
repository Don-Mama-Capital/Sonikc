-- Lot 2.0 : connexion avec Google. Un compte peut être lié à un identifiant Google (sub), une seule fois.
alter table users add column google_sub text;
create unique index users_google_sub_key on users (google_sub) where google_sub is not null;

-- Le profil accepte la notation « auto » depuis la migration 0002 ; rien d'autre à changer ici.
