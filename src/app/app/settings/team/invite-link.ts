/**
 * Team-invite link builder (plain module — NOT a 'use server' file, so it may
 * export a sync function and be imported by both the server component and the
 * server actions).
 *
 * The link carries ONLY the (already-lowercased) email — no token/secret.
 * Joining still requires the invitee to complete signup (set their own
 * password); they land in the inviter's org because the invite pre-set their
 * `organizationId`. Surfaced to the UI so an owner can copy-paste it when the
 * deploy has no email configured. Same shape the invite email uses.
 */
export function buildInviteLink(email: string): string {
  const base = process.env.NEXTAUTH_URL ?? '';
  return `${base}/signup?email=${encodeURIComponent(email)}`;
}
