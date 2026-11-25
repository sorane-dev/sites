import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export type IbisOfficeExportFormat = "pdf" | "png" | "pdf-image";

export interface IbisOfficeExportOptions {
  readonly inputPath: string;
  readonly format: IbisOfficeExportFormat;
  readonly outDir: string;
  readonly width?: number;
  readonly slides?: string;
  readonly binary?: string;
}

export interface IbisOfficeExportResult {
  readonly outDir: string;
  readonly files: readonly string[];
}

const OFFICE_EXT_RE = /\.(docx|xlsx|pptx)$/i;

export function resolveIbisOfficeBinary(): string {
  return process.env.IBIS_OFFICE?.trim() || "ibisOffice";
}

export function ibisOfficeCliAvailable(binary = resolveIbisOfficeBinary()): boolean {
  try {
    execFileSync(binary, ["--help"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** ibisOffice CLI のヘッドレス `--export` を使って Office 文書を PDF / PNG に変換する。 */
export function exportOfficeWithIbisCli(opts: IbisOfficeExportOptions): IbisOfficeExportResult {
  const binary = opts.binary?.trim() || resolveIbisOfficeBinary();
  const inputAbs = resolve(opts.inputPath);
  if (!OFFICE_EXT_RE.test(inputAbs)) {
    throw new Error(`unsupported office file extension: ${opts.inputPath}`);
  }
  if (!existsSync(inputAbs)) {
    throw new Error(`office input file not found: ${opts.inputPath}`);
  }
  const outDirAbs = resolve(opts.outDir);
  mkdirSync(outDirAbs, { recursive: true });

  const args: string[] = ["--export", opts.format, "--out-dir", outDirAbs];
  if (opts.width !== undefined) {
    if (!Number.isInteger(opts.width) || opts.width <= 0) {
      throw new Error(`invalid width: ${opts.width}`);
    }
    args.push("--width", String(opts.width));
  }
  if (opts.slides !== undefined) {
    if (!/^[0-9,-]+$/.test(opts.slides)) {
      throw new Error(`invalid slides range: ${opts.slides}`);
    }
    args.push("--slides", opts.slides);
  }
  args.push(inputAbs);

  try {
    execFileSync(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const detail =
      err instanceof Error && "stderr" in err && Buffer.isBuffer((err as NodeJS.ErrnoException & { stderr?: Buffer }).stderr)
        ? (err as NodeJS.ErrnoException & { stderr: Buffer }).stderr.toString("utf8").trim()
        : "";
    throw new Error(
      detail.length > 0
        ? `ibisOffice failed: ${detail}`
        : `ibisOffice failed (is '${binary}' installed?)`,
    );
  }

  const targetExt = opts.format === "png" ? ".png" : ".pdf";
  const files = readdirSync(outDirAbs)
    .filter((name) => name.toLowerCase().endsWith(targetExt))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => resolve(outDirAbs, name));

  return { outDir: outDirAbs, files };
}
