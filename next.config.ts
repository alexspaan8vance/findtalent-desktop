import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  // Strip the `X-Powered-By: Next.js` response header — it fingerprints the
  // stack/version for attackers and carries no value to clients.
  poweredByHeader: false,
  // pdf-parse v2 ships its pdfjs worker as a SIBLING `pdf.worker.mjs` next to its
  // ESM entry and loads it via a relative import at runtime. When Next bundles
  // pdf-parse into a server chunk, that sibling .mjs is NOT emitted into
  // `.next/server/chunks/`, so the worker import throws in the standalone build
  // ("Cannot find module '.../chunks/pdf.worker.mjs'") and EVERY PDF CV upload
  // fails local text extraction. Marking pdf-parse + pdfjs-dist external keeps
  // the `import()` pointing at node_modules (shipped whole in the Docker image),
  // where the worker file sits beside its entry and resolves correctly.
  serverExternalPackages: [
    '@prisma/client',
    '@prisma/engines',
    'pdf-parse',
    'pdfjs-dist',
  ],
};

export default withNextIntl(nextConfig);
