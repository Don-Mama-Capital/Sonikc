const AUDIO_EXT = /\.(wav|wave|mp3|aif|aiff|flac|m4a|aac|ogg)$/i;

/** Titre lisible à partir d'un nom de fichier : sans extension, sans tirets bas, espaces normalisés. */
export function cleanTitle(filename: string) {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const t = base.replace(AUDIO_EXT, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || 'Sans titre').slice(0, 160);
}

export const isAudioFilename = (name: string) => AUDIO_EXT.test(name);
