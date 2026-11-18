import { ContactDetail } from './ContactDetail';

export const metadata = { title: 'Contact' };

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  return <ContactDetail id={(await params).id} />;
}
