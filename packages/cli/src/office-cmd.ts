import { exportOfficeWithIbisCli, type IbisOfficeExportFormat } from "@sorane/core";

function takeFlag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const val = args[i + 1];
  if (!val || val.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return val;
}

export async function runOfficeRenderCmd(args: readonly string[]): Promise<void> {
  const inputPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
  const format = (takeFlag(args, "--format") ?? "pdf") as IbisOfficeExportFormat;
  if (!["pdf", "png", "pdf-image"].includes(format)) {
    throw new Error(`unsupported --format: ${format} (expected pdf|png|pdf-image)`);
  }
  const outDir = takeFlag(args, "--out") ?? "dist/office";
  const widthRaw = takeFlag(args, "--width");
  const width = widthRaw !== undefined ? Number(widthRaw) : undefined;
  const slides = takeFlag(args, "--slides");
  if (!inputPath) {
    throw new Error("usage: sorane office-render <file.docx|xlsx|pptx> [--format pdf|png|pdf-image] [--out <dir>] [--width <px>] [--slides <range>]");
  }

  const result = exportOfficeWithIbisCli({ inputPath, format, outDir, width, slides });
  for (const file of result.files) {
    process.stdout.write(`${file}\n`);
  }
}
