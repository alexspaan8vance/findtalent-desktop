/**
 * Barrel export for the 8vance client.
 *
 * Typical usage (default creds via defaultVanceCredentials in @/lib/env,
 * which reconciles VANCE_PROD_* with the Docker deploy's EIGHTVANCE_* names):
 *
 *   import { VanceClient } from "@/lib/eightvance";
 *   import { defaultVanceCredentials } from "@/lib/env";
 *   const { clientId, clientSecret } = defaultVanceCredentials();
 *   const v = new VanceClient({
 *     clientId: clientId!,
 *     clientSecret: clientSecret!,
 *     companyId: 34231,
 *   });
 *   const fn = await v.resources.resolveFunctionName("installatietechniek");
 */

export { VanceClient } from "./client";
export type { VanceClientOptions } from "./client";
export {
  VanceError,
  VanceAuthError,
  VanceRateLimitError,
  CompanyIdGateError,
} from "./errors";
export { acquire, penalize, _resetBuckets } from "./ratelimit";
export { getToken, invalidateToken } from "./auth";
export { redact } from "./util";
export type {
  TokenResponse,
  JobRef,
  JobDetail,
  JobCreatePayload,
  JobSkillInput,
  DetailedLocation,
  MatchTaskHandle,
  MatchStatus,
  MatchResult,
  TalentProfile,
  TalentSkill,
  TalentExperience,
  TalentEducation,
  TalentLanguage,
  TalentLocation,
  LocationResult,
  ReferenceItem,
  PaginatedResponse,
} from "./types";
