import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "./_expect.ts";
import {
  renderDatasetPageBody,
  validateDatasetWarnings,
} from "../packages/core/src/dataset-page.ts";
import { resolveMediaType } from "../packages/core/src/open-data.ts";
import { normalizeConcept } from "../packages/okf/src/index.ts";

describe("validateDatasetWarnings", () => {
  test("未知 EU theme コードを警告", () => {
    const warnings = validateDatasetWarnings({
      theme: "ZZZZ",
      license: "CC-BY-4.0",
      distributions: [],
    });
    expect(warnings.some((w) => w.includes("unknown EU data-theme"))).toBe(true);
    const ok = validateDatasetWarnings({
      theme: "GOVE",
      license: "CC-BY-4.0",
      publisher: { name: "Org" },
    });
    expect(ok.some((w) => w.includes("data-theme"))).toBe(false);
  });

  test("未知ライセンスと http distribution を警告", () => {
    const warnings = validateDatasetWarnings({
      license: "Custom-License",
      distributions: [{ title: "CSV", format: "csv", accessURL: "http://ex.dev/data.csv" }],
    });
    expect(warnings.some((w) => w.includes("unknown license"))).toBe(true);
    expect(warnings.some((w) => w.includes("http://"))).toBe(true);
  });

  test("OOXML media types and local static distribution byteSize/checksum drift warnings", () => {
    expect(resolveMediaType("docx")).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(resolveMediaType("pptx")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );

    const staticDir = mkdtempSync(join(tmpdir(), "sorane-dist-check-"));
    try {
      const payload = Buffer.from("id,val\n1,42\n", "utf8");
      writeFileSync(join(staticDir, "report.csv"), payload);
      const digest = createHash("sha256").update(payload).digest("hex");

      const ok = validateDatasetWarnings(
        {
          license: "CC-BY-4.0",
          publisher: { name: "Org" },
          distributions: [
            {
              title: "Report",
              format: "csv",
              accessURL: "static/report.csv",
              byteSize: payload.length,
              checksum: `sha256:${digest}`,
            },
          ],
        },
        { staticDir },
      );
      expect(ok.length).toBe(0);

      const drifted = validateDatasetWarnings(
        {
          license: "CC-BY-4.0",
          publisher: { name: "Org" },
          distributions: [
            {
              title: "Report",
              format: "csv",
              accessURL: "/report.csv",
              byteSize: 999,
              checksum: `sha256:${"0".repeat(64)}`,
            },
            {
              title: "Missing",
              format: "xlsx",
              accessURL: "/missing.xlsx",
              byteSize: 100,
            },
          ],
        },
        { staticDir },
      );
      expect(drifted.some((w) => w.includes("byteSize"))).toBe(true);
      expect(drifted.some((w) => w.includes("sha256 checksum mismatch"))).toBe(true);
      expect(drifted.some((w) => w.includes("local file not found"))).toBe(true);
    } finally {
      rmSync(staticDir, { recursive: true, force: true });
    }
  });
});

describe("renderDatasetPageBody", () => {
  test("メタデータと distribution テーブル", () => {
    const concept = normalizeConcept(
      {
        type: "dataset",
        title: "Transit",
        profile: "sorane-okf/0.3",
        license: "CC-BY-4.0",
        identifier: "ds-1",
        language: "ja",
        theme: "transport",
        resource: "https://ex.dev/data",
        publisher: { name: "Org", url: "https://ex.dev" },
        distributions: [
          { title: "Tiny", format: "json", accessURL: "tiny.json", byteSize: 512 },
          { title: "CSV", format: "csv", accessURL: "data.csv", byteSize: 2048, checksum: "sha256:abc" },
        ],
      },
      "<p>Body</p>",
      "transit",
    );
    const html = renderDatasetPageBody(concept, "<p>Rendered</p>", {
      pageUrl: "https://ex.dev/transit.html",
      baseUrl: "https://ex.dev",
    });
    expect(html).toContain("dataset-meta");
    expect(html).toContain("CC-BY-4.0");
    expect(html).toContain("Org");
    expect(html).toContain("ds-1");
    expect(html).toContain("transport");
    expect(html).toContain("512 B");
    expect(html).toContain("2.0 KB");
    expect(html).toContain("sha256:abc");
    expect(html).toContain("dataset-distributions");
    expect(html).toContain("<p>Rendered</p>");
  });

  test("distribution 無しはテーブルを省略", () => {
    const concept = normalizeConcept(
      { type: "dataset", title: "Empty", profile: "sorane-okf/0.3" },
      "body",
      "empty",
    );
    const html = renderDatasetPageBody(concept, "<p>x</p>", {
      pageUrl: "https://ex.dev/empty.html",
      baseUrl: "",
    });
    expect(html).not.toContain("dataset-distributions");
    expect(html).toContain("dataset-body");
  });
});