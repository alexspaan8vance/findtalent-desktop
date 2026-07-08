import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-6 text-center">
      <p className="text-sm font-medium uppercase tracking-wide text-zinc-400">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-zinc-900">
        Pagina niet gevonden
      </h1>
      <p className="mt-2 max-w-sm text-sm text-zinc-600">
        Deze pagina bestaat niet (meer). Controleer de link of ga terug naar de
        startpagina.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800"
      >
        Naar home
      </Link>
    </main>
  );
}
