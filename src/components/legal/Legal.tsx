import Link from 'next/link';

/** Passage à compléter avec le juriste : visible, repérable (et compté par un test). */
export function Todo({ children }: { children: React.ReactNode }) {
  return <mark className="rounded bg-warn/20 px-1 text-text" data-testid="todo">[À compléter : {children}]</mark>;
}

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 pb-24 pt-10 sm:px-6">
      <Link href="/" className="text-sm font-semibold uppercase tracking-[0.3em] text-accent">Sonikc</Link>
      <h1 className="text-3xl font-black">{title}</h1>
      <p className="text-sm text-mute">Version de travail du {updated} : les passages surlignés sont à compléter et le texte entier à faire valider par un juriste avant l’ouverture au public.</p>
      <div className="legal space-y-4 text-sm leading-relaxed [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc">{children}</div>
    </main>
  );
}

export const LEGAL_LINKS = [
  { href: '/mentions-legales', label: 'Mentions légales' },
  { href: '/cgu', label: 'Conditions d’utilisation' },
  { href: '/cgv', label: 'Conditions de vente' },
  { href: '/confidentialite', label: 'Confidentialité' },
  { href: '/cookies', label: 'Cookies' },
  { href: '/tarifs', label: 'Tarifs' },
];
