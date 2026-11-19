'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Recharge la page toutes les 2 s (confirmation du paiement, préparation des fichiers). */
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [router]);
  return null;
}
