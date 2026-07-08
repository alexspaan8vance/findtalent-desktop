import { signOut } from '@/auth';

/**
 * Stable sign-out endpoint.
 *
 * The header sign-out used to be an inline Server Action. Server Action ids are
 * content-hashed per build, so a tab still running an OLD client bundle (very
 * common right after a deploy) posts an action id the new build no longer knows
 * → "Failed to find Server Action … from an older or newer deployment" → the
 * root error boundary ("something went wrong"). Routing sign-out through a fixed
 * URL instead means a stale tab still logs out cleanly across redeploys.
 *
 * POST-only (a GET could be triggered by a stray link/prefetch and log the user
 * out unintentionally). `signOut` clears the session cookie and redirects to '/'.
 */
export async function POST(): Promise<void> {
  await signOut({ redirectTo: '/' });
}
