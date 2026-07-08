import { prisma } from "../src/lib/db";
import { encrypt, assertCryptoReady } from "../src/lib/crypto";
async function main() {
  assertCryptoReady();
  const slug = process.env.TENANT_SLUG ?? "ivta";
  const clientId = process.env.EIGHTVANCE_CLIENT_ID!;
  const clientSecret = process.env.EIGHTVANCE_CLIENT_SECRET!;
  const companyId = Number.parseInt(process.env.EIGHTVANCE_COMPANY_ID!, 10);
  if (!clientId || !clientSecret || !Number.isFinite(companyId)) throw new Error("missing creds");
  const t = await prisma.tenant.update({
    where: { slug },
    data: { eightvanceClientId: clientId, eightvanceClientSecretEnc: encrypt(clientSecret), eightvanceCompanyId: companyId },
  });
  console.log("updated tenant " + t.slug + " companyId=" + t.eightvanceCompanyId + " clientIdLen=" + t.eightvanceClientId.length);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e.message); await prisma.$disconnect(); process.exit(1); });
