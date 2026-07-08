/**
 * Per-tenant VanceClient factory.
 *
 * Loads a Tenant row from Prisma by id, decrypts the OAuth client secret,
 * and constructs a `VanceClient` scoped to that tenant's
 * `eightvanceCompanyId`. Instances are cached per tenant in this process
 * — the underlying token cache + rate-limit buckets already live in
 * module scope inside `auth.ts` / `ratelimit.ts`, so reconstructing on
 * every call would be pure waste.
 *
 * Memory `feedback_security_critical`: never log decrypted secrets.
 */

import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

import { VanceClient } from "./client";

const clientByTenant = new Map<string, VanceClient>();

export class TenantNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantNotConfiguredError";
  }
}

/**
 * Return a `VanceClient` scoped to a specific tenant (talent pool).
 * Caches the instance for reuse in this process.
 */
export async function vanceClientForTenant(
  tenantId: string,
): Promise<VanceClient> {
  if (!tenantId) {
    throw new TenantNotConfiguredError("vanceClientForTenant: tenantId is required");
  }

  const cached = clientByTenant.get(tenantId);
  if (cached) return cached;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      eightvanceClientId: true,
      eightvanceClientSecretEnc: true,
      eightvanceCompanyId: true,
      eightvanceBaseUrl: true,
    },
  });

  if (!tenant) {
    throw new TenantNotConfiguredError(`Tenant ${tenantId} not found.`);
  }
  if (!tenant.eightvanceClientId || !tenant.eightvanceClientSecretEnc) {
    throw new TenantNotConfiguredError(
      `Tenant ${tenantId} is missing 8vance API credentials.`,
    );
  }

  const clientSecret = decrypt(tenant.eightvanceClientSecretEnc);
  const client = new VanceClient({
    clientId: tenant.eightvanceClientId,
    clientSecret,
    companyId: tenant.eightvanceCompanyId,
    allowedCompanyIds: [tenant.eightvanceCompanyId],
    // Per-tenant API host. Null = deploy default (PROD). Set for ACC pools
    // (e.g. KNSV → https://acc.8vance.com/public/v1).
    ...(tenant.eightvanceBaseUrl ? { baseUrl: tenant.eightvanceBaseUrl } : {}),
  });

  clientByTenant.set(tenantId, client);
  return client;
}

export function _resetTenantClientCache(): void {
  clientByTenant.clear();
}
