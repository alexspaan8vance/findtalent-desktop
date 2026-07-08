/**
 * In-process cache for the BACKGROUND 8vance CV-parse result (stage 2 of the
 * two-stage CV parse).
 *
 * `POST /api/candidates/parse-cv` returns the fast LOCAL parse immediately and
 * kicks the slower 8vance parser off in the background. It mints an
 * `enrichToken`, marks it pending here, and writes the mapped result (or a
 * 'none' marker on empty/failure) under that token when the parse settles.
 * `GET /api/candidates/parse-cv/enrich?token=…` reads it back so the wizard can
 * merge the richer data in once it lands.
 *
 * Both routes import THIS module so they share the SAME LRU instance (a single
 * module-level singleton — Node keeps it warm across requests in one process).
 * Entries expire after ~5 min; a poll for an unknown/expired token reads as
 * 'none'. Server-only.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { createLru, type Lru } from "@/lib/cache/lru";
import type { EightvanceParsedCv } from "./cv-parser-8vance";

export type EnrichEntry =
  | { status: "pending" }
  | { status: "ready"; parsed: EightvanceParsedCv }
  | { status: "none" };

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 200;

// Module-level singleton, shared by parse-cv (writer) + enrich (reader).
const cache: Lru<EnrichEntry> = createLru<EnrichEntry>({ max: MAX_ENTRIES, ttlMs: TTL_MS });

/** Mint a fresh enrich token (opaque, unguessable). */
export function newEnrichToken(): string {
  return randomUUID();
}

/** Mark a token as in-flight (8vance promise not yet settled). */
export function markEnrichPending(token: string): void {
  cache.set(token, { status: "pending" });
}

/**
 * Record the settled 8vance result. A non-null + `ok` payload becomes 'ready';
 * anything else (null / not-ok / soft failure) becomes a 'none' marker so a
 * background failure can never leak into or block the already-sent response.
 */
export function setEnrichResult(token: string, parsed: EightvanceParsedCv | null): void {
  if (parsed && parsed.ok) cache.set(token, { status: "ready", parsed });
  else cache.set(token, { status: "none" });
}

/** Read the current entry, or undefined for an unknown/expired token. */
export function getEnrich(token: string): EnrichEntry | undefined {
  return cache.get(token);
}
