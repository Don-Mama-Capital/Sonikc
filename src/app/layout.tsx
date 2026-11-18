import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Sonikc', template: '%s · Sonikc' },
  description: 'Range tes beats, envoie-les, sache qui les écoute.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b0b0f' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
