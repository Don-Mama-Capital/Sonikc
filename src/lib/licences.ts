/** Libellés lisibles des licences : aucune clé technique n'est jamais affichée telle quelle. */

export const FORMAT_LABEL: Record<string, string> = { mp3: 'MP3', wav: 'WAV', stems: 'Pistes séparées (stems)' };

export type LicenceTerms = {
  formats: string[]; maxStreams: number | null; maxCopies: number | null; musicVideos: number | null; radio: boolean; exclusive: boolean;
};

const n = (x: number) => x.toLocaleString('fr-FR');

export function licenceLines(t: LicenceTerms): string[] {
  return [
    `Fichiers : ${t.formats.map((f) => FORMAT_LABEL[f] ?? 'Autre format').join(', ')}`,
    t.maxStreams ? `Jusqu’à ${n(t.maxStreams)} écoutes en streaming` : 'Écoutes en streaming illimitées',
    t.maxCopies ? `Jusqu’à ${n(t.maxCopies)} ventes ou téléchargements` : 'Ventes et téléchargements illimités',
    t.musicVideos === null ? 'Clips illimités' : t.musicVideos === 0 ? 'Pas de clip' : `${t.musicVideos} clip${t.musicVideos > 1 ? 's' : ''}`,
    t.radio ? 'Diffusion radio autorisée' : 'Pas de diffusion radio',
    t.exclusive ? 'Exclusivité : le morceau est retiré de la vente après l’achat' : 'Licence non exclusive : le producteur peut vendre d’autres licences',
  ];
}

export const euros = (cents: number) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
