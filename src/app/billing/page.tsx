import { redirect } from 'next/navigation';

export default function BillingIndex() {
  redirect('/billing/choose-plan');
}
