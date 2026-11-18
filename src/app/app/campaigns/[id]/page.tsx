import { CampaignView } from './CampaignView';

export const metadata = { title: 'Envoi' };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  return <CampaignView id={(await params).id} />;
}
