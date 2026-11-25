import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportOfficeWithIbisCli,
  ibisOfficeCliAvailable,
  resolveIbisOfficeBinary,
} from "../packages/core/src/export/ibis-office-cli.ts";

test("ibis-office-cli invokes ibisOffice --export and returns sorted output files", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sorane-ibis-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const input = join(dir, "slides.pptx");
  writeFileSync(input, "dummy-pptx");
  const outDir = join(dir, "out");
  const argsLog = join(dir, "args.json");

  const mockBin = join(dir, "mock-ibis.mjs");
  writeFileSync(
    mockBin,
    `#!/usr/bin/env node
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args.includes("--help")) process.exit(0);
writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args));
const outIdx = args.indexOf("--out-dir");
const out = args[outIdx + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "slide-10.png"), "png10");
writeFileSync(join(out, "slide-2.png"), "png2");
writeFileSync(join(out, "slide-1.png"), "png1");
`,
    "utf8",
  );
  chmodSync(mockBin, 0o755);

  const prev = process.env.IBIS_OFFICE;
  process.env.IBIS_OFFICE = mockBin;
  t.after(() => {
    if (prev === undefined) delete process.env.IBIS_OFFICE;
    else process.env.IBIS_OFFICE = prev;
  });

  assert.equal(resolveIbisOfficeBinary(), mockBin);
  assert.equal(ibisOfficeCliAvailable(), true);

  const res = exportOfficeWithIbisCli({
    inputPath: input,
    format: "png",
    outDir,
    width: 1280,
    slides: "1-3,10",
  });

  const recorded = JSON.parse(readFileSync(argsLog, "utf8")) as string[];
  assert.deepEqual(recorded, [
    "--export", "png",
    "--out-dir", outDir,
    "--width", "1280",
    "--slides", "1-3,10",
    input,
  ]);
  assert.deepEqual(res.files.map((f) => f.slice(f.lastIndexOf("/") + 1)), [
    "slide-1.png",
    "slide-2.png",
    "slide-10.png",
  ]);
});

test("ibis-office-cli rejects unsupported extensions and invalid options", () => {
  assert.throws(
    () => exportOfficeWithIbisCli({ inputPath: "note.txt", format: "pdf", outDir: "/tmp/out" }),
    /unsupported office file extension/,
  );
  assert.throws(
    () => exportOfficeWithIbisCli({ inputPath: "missing.docx", format: "pdf", outDir: "/tmp/out" }),
    /office input file not found/,
  );
});
