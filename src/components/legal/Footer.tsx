import Link from 'next/link';
import { LEGAL_LINKS } from './Legal';

export function Footer() {
  return (
    <footer className="border-t border-line px-4 py-6 text-xs text-mute sm:px-6" data-testid="footer">
      <nav aria-label="Informations légales" className="mx-auto flex max-w-5xl flex-wrap gap-x-4 gap-y-2">
        {LEGAL_LINKS.map((l) => <Link key={l.href} href={l.href} className="hover:text-text">{l.label}</Link>)}
        <Link href="/compte" className="hover:text-text">Mes données</Link>
      </nav>
    </footer>
  );
}
