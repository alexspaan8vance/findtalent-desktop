import { NewCompanyForm } from './company-form';

export default function NewCompanyPage() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-2xl font-semibold text-zinc-900">Add company</h1>
      <p className="text-sm text-zinc-600">
        Configure a new company with its 8vance API credentials. The client secret is
        encrypted at rest with AES-256-GCM. The company ID and source slug are detected
        from 8vance once the credentials are validated.
      </p>

      <NewCompanyForm />
    </div>
  );
}
