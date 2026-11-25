import { describe, expect, test } from "./_expect.ts";
import {
  conceptToOkfMarkdown,
  currentVerifications,
  deriveTrustTier,
  isCurrentVerification,
  isOkfDotPath,
  isOkfNonConceptReservedFile,
  isReservedOkfFilename,
  isStableStatus,
  isStale,
  normalizeConcept,
  parseTrustFields,
  patchFrontmatterScalar,
  resolveOkfPath,
  validateSource,
} from "../packages/okf/src/index.ts";

describe("OKF v0.2 trust fields", () => {
  test("generated.at fills effective timestamp when timestamp absent", () => {
    const c = normalizeConcept(
      {
        type: "article",
        title: "T",
        generated: { by: "reference_agent/gemini-2.5-pro", at: "2026-06-20T22:53:05Z" },
      },
      "body",
      "t",
    );
    expect(c.timestamp).toBe("2026-06-20T22:53:05Z");
    expect(c.generated?.by).toBe("reference_agent/gemini-2.5-pro");
  });

  test("explicit timestamp wins over generated.at", () => {
    const c = normalizeConcept(
      {
        type: "article",
        title: "T",
        timestamp: "2025-01-01T00:00:00Z",
        generated: { by: "agent/1", at: "2026-06-20T22:53:05Z" },
      },
      "body",
      "t",
    );
    expect(c.timestamp).toBe("2025-01-01T00:00:00Z");
    expect(c.generated?.at).toBe("2026-06-20T22:53:05Z");
  });

  test("verified bare mapping becomes one-element list", () => {
    const c = normalizeConcept(
      {
        type: "article",
        title: "T",
        verified: { by: "human:alice", at: "2026-06-25T09:00:00Z" },
      },
      "body",
      "t",
    );
    expect(c.verified?.length).toBe(1);
    expect(c.verified?.[0]?.by).toBe("human:alice");
    expect(deriveTrustTier(c.verified)).toBe("human-reviewed");
  });

  test("trust tiers from verified actors", () => {
    expect(deriveTrustTier(undefined)).toBe("unverified");
    expect(deriveTrustTier([{ by: "process:nightly", at: "2026-06-25T09:00:00Z" }])).toBe("machine-confirmed");
    expect(deriveTrustTier([
      { by: "agent/1", at: "2026-06-25T09:00:00Z" },
      { by: "human:bob", at: "2026-06-25T09:00:00Z" },
    ])).toBe(
      "human-reviewed",
    );
  });

  test("isStale compares absolute instants", () => {
    expect(isStale("2000-01-01T00:00:00Z", new Date("2026-08-01T00:00:00Z"))).toBe(true);
    expect(isStale("2099-12-31T00:00:00Z", new Date("2026-08-01T00:00:00Z"))).toBe(false);
    expect(isStale(undefined)).toBe(false);
  });

  test("serialize round-trips trust families", () => {
    const c = normalizeConcept(
      {
        type: "article",
        title: "Orders",
        profile: "sorane-okf/0.3",
        status: "stable",
        stale_after: "2026-12-31T00:00:00Z",
        generated: { by: "agent/1", at: "2026-06-20T22:53:05Z" },
        verified: [
          { by: "human:alice", at: "2026-06-25T09:00:00Z" },
          { by: "process:nightly", at: "2026-06-26T02:00:00Z" },
        ],
        sources: [
          {
            id: "schema",
            resource: "https://example.com/schema",
            title: "Schema",
            author: "team:data",
            usage_count: 100,
            last_modified: "2026-05-30T00:00:00Z",
          },
        ],
        usage_window: { from: "2026-06-01T00:00:00Z", to: "2026-06-30T00:00:00Z" },
      },
      "Body.\n",
      "orders",
    );
    const md = conceptToOkfMarkdown(c);
    expect(md).toContain("generated:");
    expect(md).toContain("verified:");
    expect(md).toContain("sources:");
    expect(md).toContain("stale_after: 2026-12-31T00:00:00Z");
    expect(md).toContain("usage_window:");

    const r = validateSource("orders.md", md);
    expect(r.ok).toBe(true);
  });

  test("invalid generated.by is an error", () => {
    const r = validateSource(
      "a.md",
      "---\ntype: article\ntitle: T\ngenerated:\n  at: 2026-01-01T00:00:00Z\n---\n\nbody\n",
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes("generated.by"))).toBe(true);
  });

  test("sources entry without resource is an error", () => {
    const r = validateSource(
      "a.md",
      "---\ntype: article\ntitle: T\nsources:\n  - title: No resource\n---\n\nbody\n",
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes("resource"))).toBe(true);
  });

  test("unknown status string is preserved with a warning and treated as non-stable (OKF v0.3 §5.4)", () => {
    const r = validateSource(
      "a.md",
      "---\ntype: article\ntitle: T\nstatus: shipping\n---\n\nbody\n",
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes('unknown status "shipping"'))).toBe(true);

    const c = normalizeConcept({ type: "article", title: "T", status: "shipping" }, "body", "t");
    expect(c.status).toBe("shipping");
    expect(isStableStatus(c.status)).toBe(false);
    expect(isStableStatus(undefined)).toBe(true);
    expect(isStableStatus("stable")).toBe(true);
  });

  test("non-string status is an error", () => {
    const r = validateSource(
      "a.md",
      "---\ntype: article\ntitle: T\nstatus: 123\n---\n\nbody\n",
    );
    expect(r.ok).toBe(false);
  });

  test("past stale_after yields warning", () => {
    const r = validateSource(
      "a.md",
      "---\ntype: article\ntitle: T\nstale_after: 2000-01-01T00:00:00Z\n---\n\nbody\n",
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.includes("stale_after"))).toBe(true);
  });

  test("parseTrustFields rejects non-list/non-mapping sources", () => {
    const t = parseTrustFields({ sources: "https://example.com" });
    expect(t.issues.length > 0).toBe(true);
  });

  test("OKF v0.3 §5.3: trust tier only uses current verification events (>= generated.at)", () => {
    const generated = { by: "agent/2", at: "2026-06-25T10:00:00Z" };
    const oldHuman = { by: "human:alice", at: "2026-06-20T09:00:00Z" };
    const currentProcess = { by: "process:nightly", at: "2026-06-26T02:00:00Z" };
    const sameInstantHuman = { by: "human:bob", at: "2026-06-25T10:00:00Z" };

    expect(isCurrentVerification(oldHuman, generated)).toBe(false);
    expect(isCurrentVerification(sameInstantHuman, generated)).toBe(true);
    expect(deriveTrustTier([oldHuman], generated)).toBe("unverified");
    expect(deriveTrustTier([oldHuman, currentProcess], generated)).toBe("machine-confirmed");
    expect(deriveTrustTier([oldHuman, sameInstantHuman], generated)).toBe("human-reviewed");
    expect(currentVerifications([oldHuman, currentProcess], generated).length).toBe(1);
    // team: actor gives machine-confirmed, not human-reviewed (§7)
    expect(deriveTrustTier([{ by: "team:finance", at: "2026-06-26T00:00:00Z" }], generated)).toBe(
      "machine-confirmed",
    );
  });

  test("OKF v0.3 §5: accepts RFC 3339 date-only timestamps as UTC start of day", () => {
    const r = validateSource(
      "a.md",
      [
        "---",
        "type: article",
        "title: Date Only",
        "generated: { by: 'human:alice', at: '2026-06-20' }",
        "verified: { by: 'human:bob', at: '2026-06-20' }",
        "stale_after: '2099-12-31'",
        "sources:",
        "  - resource: https://example.com/spec",
        "    last_modified: '2026-05-01'",
        "usage_window: { from: '2026-06-01', to: '2026-06-30' }",
        "---",
        "",
        "body",
        "",
      ].join("\n"),
    );
    expect(r.ok).toBe(true);
    expect(isStale("2026-06-30", new Date("2026-06-30T00:00:00Z"))).toBe(true);
    expect(isStale("2026-06-30", new Date("2026-06-29T23:59:59Z"))).toBe(false);
    // §5.5: unparseable stale_after MUST NOT be treated as fresh
    expect(isStale("not-a-date", new Date("2026-06-29T00:00:00Z"))).toBe(true);
  });

  test("OKF v0.3 §5.4: superseded_by round-trips and warns when status is not deprecated", () => {
    const c = normalizeConcept(
      {
        type: "article",
        title: "Old Metric",
        status: "deprecated",
        superseded_by: "/metrics/new-metric.md",
      },
      "body\n",
      "old",
    );
    expect(c.superseded_by).toBe("/metrics/new-metric.md");
    expect(c.warnings.length).toBe(0);
    const md = conceptToOkfMarkdown(c);
    expect(md).toContain("superseded_by: /metrics/new-metric.md");
    expect(validateSource("old.md", md).ok).toBe(true);

    const rWarn = validateSource(
      "active.md",
      "---\ntype: article\ntitle: Active\nstatus: stable\nsuperseded_by: /metrics/new.md\n---\n\nbody\n",
    );
    expect(rWarn.ok).toBe(true);
    expect(rWarn.warnings.some((w) => w.includes("superseded_by"))).toBe(true);
  });

  test("OKF v0.3 §11.2 & §4.1: null/empty as absent, single-item list coercion, extension preservation", () => {
    const c = normalizeConcept(
      {
        type: "article",
        title: "Resilient",
        tags: "sales, revenue",
        sources: { resource: "https://example.com/one", "x-acme-tier": "gold" },
        verified: null,
        stale_after: "",
        generated: { by: "agent/1", at: "2026-06-20T00:00:00Z", "x-acme-run": "r1" },
      },
      "body\n",
      "resilient",
    );
    // Scalar tags is a single tag; MUST NOT split at commas (§11.2 #2)
    expect(c.tags).toEqual(["sales, revenue"]);
    // Single mapping sources becomes a one-item list
    expect(c.sources?.length).toBe(1);
    expect(c.sources?.[0]?.["x-acme-tier"]).toBe("gold");
    expect(c.verified).toBe(undefined);
    expect(c.stale_after).toBe(undefined);
    expect(c.generated?.["x-acme-run"]).toBe("r1");

    const md = conceptToOkfMarkdown(c);
    expect(md).toContain("x-acme-run: r1");
    expect(md).toContain("x-acme-tier: gold");
    expect(validateSource("resilient.md", md).ok).toBe(true);
  });

  test("OKF v0.3 §3.1, §3.2, §6: path resolution and reserved filenames", () => {
    expect(isReservedOkfFilename("index.md")).toBe(true);
    expect(isReservedOkfFilename("sub/log.md")).toBe(true);
    expect(isReservedOkfFilename("sub/concept.md")).toBe(false);
    expect(isOkfDotPath(".git/config")).toBe(true);
    expect(isOkfDotPath("dir/.hidden.md")).toBe(true);
    expect(isOkfDotPath("dir/file.md")).toBe(false);

    expect(resolveOkfPath("https://example.com/a", "metrics/m.md")).toEqual({
      kind: "uri",
      resolved: "https://example.com/a",
      fragment: undefined,
    });
    expect(resolveOkfPath("/tables/orders.md#schema", "metrics/m.md")).toEqual({
      kind: "bundle",
      resolved: "tables/orders.md",
      fragment: "schema",
    });
    expect(resolveOkfPath("./other.md", "metrics/m.md")).toEqual({
      kind: "bundle",
      resolved: "metrics/other.md",
      fragment: undefined,
    });
    expect(resolveOkfPath("../tables/orders.md", "metrics/m.md")).toEqual({
      kind: "bundle",
      resolved: "tables/orders.md",
      fragment: undefined,
    });
    expect(resolveOkfPath("../../outside.md", "metrics/m.md").kind).toBe("external");

    // §12.1 v0.2 fallback to bundle root when okf_version <= 0.2
    const existing = new Set(["tables/orders.md"]);
    expect(
      resolveOkfPath("tables/orders.md", "metrics/m.md", {
        okfVersion: "0.2",
        existingPaths: existing,
      }),
    ).toEqual({
      kind: "bundle",
      resolved: "tables/orders.md",
      fragment: undefined,
    });
    // In v0.3, bare path resolves strictly from the file's directory
    expect(
      resolveOkfPath("tables/orders.md", "metrics/m.md", {
        okfVersion: "0.3",
        existingPaths: existing,
      }),
    ).toEqual({
      kind: "bundle",
      resolved: "metrics/tables/orders.md",
      fragment: undefined,
    });

    // ibisOffice parity: percent-decoding, query strip, scheme-relative, traversal/dot rejection
    expect(resolveOkfPath("../a%20b.md?view=1#heading", "nested/note.md")).toEqual({
      kind: "bundle",
      resolved: "a b.md",
      fragment: "heading",
    });
    expect(resolveOkfPath("#only-fragment", "nested/note.md")).toEqual({
      kind: "bundle",
      resolved: "nested/note.md",
      fragment: "only-fragment",
    });
    expect(resolveOkfPath("//example.com/a.md", "nested/note.md").kind).toBe("uri");
    for (const invalid of ["/%2e%2e/a.md", "/a%2fb.md", "/.hidden/a.md", "/bad%ZZ.md"]) {
      expect(resolveOkfPath(invalid, "nested/note.md").kind).toBe("external");
    }

    // Non-concept reserved files (log.md at any level, frontmatter-less subdir index.md)
    expect(isOkfNonConceptReservedFile("log.md", "# Log\n")).toBe(true);
    expect(isOkfNonConceptReservedFile("sub/log.md", "# Log\n")).toBe(true);
    expect(isOkfNonConceptReservedFile("sub/index.md", "# Sub\n")).toBe(true);
    expect(
      isOkfNonConceptReservedFile("sub/index.md", "---\ntype: index\ntitle: Sub\n---\n"),
    ).toBe(false);
    expect(isOkfNonConceptReservedFile("index.md", "# Root\n")).toBe(false);
  });

  test("OKF v0.3 §4: patchFrontmatterScalar preserves comments, order, and x-ibis-* keys", () => {
    const raw = [
      "# ibisOffice managed",
      "type: article",
      "title: Old Title # inline comment",
      "x-ibis-format: document",
      "verified: { by: 'human:alice', at: '2026-06-25T09:00:00Z' }",
    ].join("\n");
    const patched = patchFrontmatterScalar(raw, "title", "New: Title");
    expect(patched).not.toBe(null);
    expect(patched!).toContain("# ibisOffice managed");
    expect(patched!).toContain("title: 'New: Title' # inline comment");
    expect(patched!).toContain("x-ibis-format: document");
    expect(patched!).toContain("verified: { by: 'human:alice', at: '2026-06-25T09:00:00Z' }");

    // Multiline block scalar safely returns null to allow fallback
    expect(patchFrontmatterScalar("type: article\ntitle: |\n  Multi\n", "title", "X")).toBe(null);
  });
});
