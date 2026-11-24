import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { ConsentBanner } from '@/components/legal/ConsentBanner';
import { Footer } from '@/components/legal/Footer';
import { CONSENT_COOKIE } from '@/config/cookies';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sonikc', template: '%s · Sonikc' },
  description: 'Range tes beats, envoie-les, sache qui les écoute.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b0b0f' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const consent = (await cookies()).get(CONSENT_COOKIE)?.value ?? null;
  return (
    <html lang="fr">
      <body className="flex min-h-dvh flex-col">
        <div className="flex-1">{children}</div>
        <Footer />
        <ConsentBanner initial={consent} />
      </body>
    </html>
  );
}
