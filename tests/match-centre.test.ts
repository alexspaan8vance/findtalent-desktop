import { describe, it, expect, vi } from "vitest";

// `server-only` is a Next.js build marker with no runtime in vitest — stub it
// so importing service.ts (which is server-only) doesn't throw.
vi.mock("server-only", () => ({}));

import { localHomeCentre, resolveMatchCentre } from "@/lib/candidate/service";

/**
 * Regression: the match page's map reads the candidate's home from the LOCAL
 * `profileJson.detailed_location` (page.tsx `matchOrigin`), while the matcher
 * used to read ONLY the remote 8vance `/talent/{id}/location/`. A candidate
 * with local coords but no usable 8vance location then got "JobDigger skipped —
 * candidate has no location" WHILE the map rendered their home marker (live:
 * Tim, Enschede, 2026-07-08). Both must resolve the SAME centre.
 */
describe("localHomeCentre — parse the map's home field (profileJson.detailed_location)", () => {
  it("parses the page-shaped detailed_location with STRING coords + city label", () => {
    // Enschede — exactly how the CV pipeline persists it (strings).
    const profileJson = {
      detailed_location: { city: "Enschede", latitude: "52.2215", longitude: "6.8937" },
    };
    expect(localHomeCentre(profileJson)).toEqual({
      lat: 52.2215,
      lng: 6.8937,
      label: "Enschede",
    });
  });

  it("accepts numeric coords and null city", () => {
    expect(
      localHomeCentre({ detailed_location: { latitude: 51.44, longitude: 5.47 } }),
    ).toEqual({ lat: 51.44, lng: 5.47, label: null });
  });

  it("treats a 0 coordinate as the geocode-failed sentinel (same as the map)", () => {
    // page.tsx rejects each coordinate independently when 0 — mirror that.
    expect(
      localHomeCentre({ detailed_location: { city: "X", latitude: 0, longitude: 6.9 } }),
    ).toBeNull();
    expect(
      localHomeCentre({ detailed_location: { city: "X", latitude: "52.2", longitude: "0" } }),
    ).toBeNull();
  });

  it("returns null for missing/garbage shapes", () => {
    expect(localHomeCentre(null)).toBeNull();
    expect(localHomeCentre({})).toBeNull();
    expect(localHomeCentre({ detailed_location: {} })).toBeNull();
    expect(
      localHomeCentre({ detailed_location: { city: "Enschede", latitude: "n/a", longitude: "x" } }),
    ).toBeNull();
    expect(localHomeCentre("not an object")).toBeNull();
  });
});

describe("resolveMatchCentre — map and matcher agree on the real centre", () => {
  const enschedeLocal = { lat: 52.2215, lng: 6.8937, label: "Enschede" };

  it("THE BUG SHAPE: local (map) home present, remote 8vance home absent → home centre, feed NOT skipped", () => {
    // Tim: 8vance talent has no stored location (sync gap), but the CV/profile
    // has Enschede — the map shows the marker, so the matcher must have a
    // centre too (pre-fix this returned null → JobDigger `filter_required`).
    const centre = resolveMatchCentre({ remoteHome: null, localHome: enschedeLocal });
    expect(centre).toEqual({ lat: 52.2215, lng: 6.8937, label: "Enschede", kind: "home" });
  });

  it("remote home ZEROED (0,0 placeholder) also falls back to the local map field", () => {
    const centre = resolveMatchCentre({
      remoteHome: { latitude: "0", longitude: "0" },
      localHome: enschedeLocal,
    });
    expect(centre).toMatchObject({ lat: 52.2215, lng: 6.8937, kind: "home" });
  });

  it("remote home with garbage coords falls back to the local map field", () => {
    const centre = resolveMatchCentre({
      remoteHome: { latitude: null, longitude: undefined },
      localHome: enschedeLocal,
    });
    expect(centre).toMatchObject({ lat: 52.2215, lng: 6.8937, kind: "home" });
  });

  it("remote 8vance home wins over local when both exist (Henk: Nieuwolda)", () => {
    // The synced 8vance location stays authoritative when usable — the fallback
    // only fills the gap, it does not change the healthy path.
    const centre = resolveMatchCentre({
      remoteHome: { latitude: "53.2447", longitude: "6.9748" },
      localHome: enschedeLocal,
    });
    expect(centre).toEqual({ lat: 53.2447, lng: 6.9748, label: null, kind: "home" });
  });

  it("no location ANYWHERE → null (feed is then honestly skipped as filter_required)", () => {
    expect(resolveMatchCentre({ remoteHome: null, localHome: null })).toBeNull();
  });

  it("locationOverride (relocation search) has top precedence and keeps its label + kind", () => {
    const centre = resolveMatchCentre({
      override: { lat: 51.4416, lng: 5.4697, label: "Eindhoven" },
      regionCentre: { label: "Groningen", latitude: 53.2, longitude: 6.57 },
      remoteHome: { latitude: "53.2447", longitude: "6.9748" },
      localHome: enschedeLocal,
    });
    expect(centre).toEqual({ lat: 51.4416, lng: 5.4697, label: "Eindhoven", kind: "relocation" });
  });

  it("a geocoded desired work region beats home (both remote and local)", () => {
    const centre = resolveMatchCentre({
      regionCentre: { label: "Groningen", latitude: 53.2194, longitude: 6.5665 },
      remoteHome: { latitude: "53.2447", longitude: "6.9748" },
      localHome: enschedeLocal,
    });
    expect(centre).toEqual({ lat: 53.2194, lng: 6.5665, label: "Groningen", kind: "region" });
  });

  it("an INVALID override does not silently retarget the run at home under a wrong kind", () => {
    // rematchAction validates overrides, so this is unreachable in practice —
    // but if it ever happens the run must not masquerade a home run as a
    // relocation run (or vice versa).
    const centre = resolveMatchCentre({
      override: { lat: Number.NaN, lng: 5.47, label: "Eindhoven" },
      localHome: enschedeLocal,
    });
    expect(centre).toBeNull();
  });
});
