import { Suspense } from 'react';
import { BillingView } from './BillingView';

export const metadata = { title: 'Mon offre' };

export default function OfferPage() {
  return <Suspense fallback={<p className="text-sm text-mute">Chargement…</p>}><BillingView /></Suspense>;
}
