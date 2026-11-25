import { createGzip } from "node:zlib";
import type { OkfConcept } from "./normalize.ts";
import { conceptToOkfMarkdown, formatScalar } from "./serialize.ts";

/** Upstream OKF specification version targeted by generated bundles. */
export const OKF_SPEC_VERSION = "0.3";

export interface BundleEntry {
  readonly path: string;
  readonly content: string;
  readonly mtime: number;
}

export interface BundleMetadata {
  /** OKF version string (defaults to `"0.3"`). Always serialized as a quoted YAML string (§4, §8.1). */
  readonly okf_version?: string;
  readonly title?: string;
  readonly description?: string;
  readonly license?: string;
}

function conceptMtime(concept: OkfConcept): number {
  if (!concept.timestamp) return 0;
  const ms = Date.parse(concept.timestamp);
  if (Number.isNaN(ms)) return 0;
  return Math.floor(ms / 1000);
}

export interface BundleConcept {
  readonly concept: OkfConcept;
  readonly slug: string;
}

/** 公開 concept を OKF bundle エントリに変換する（{type}/{slug}.md）。 */
export function buildBundleEntries(concepts: readonly BundleConcept[]): BundleEntry[] {
  return concepts
    .slice()
    .sort((a, b) => {
      const pa = `${a.concept.type}/${a.slug}`;
      const pb = `${b.concept.type}/${b.slug}`;
      return pa < pb ? -1 : pa > pb ? 1 : 0;
    })
    .map((c) => ({
      path: `${c.concept.type}/${c.slug}.md`,
      content: conceptToOkfMarkdown(c.concept),
      mtime: conceptMtime(c.concept),
    }));
}

/**
 * OKF v0.3 §8.1: Bundle-root `index.md` with `okf_version` and optional
 * bundle metadata (`title`, `description`, `license`), plus grouped concept links.
 */
export function buildBundleRootIndex(
  concepts: readonly BundleConcept[],
  meta?: BundleMetadata,
): BundleEntry {
  const version = meta?.okf_version ?? OKF_SPEC_VERSION;
  const fmLines = [`okf_version: "${version.replace(/"/g, '\\"')}"`];
  if (meta?.title) fmLines.push(`title: ${formatScalar(meta.title)}`);
  if (meta?.description) fmLines.push(`description: ${formatScalar(meta.description)}`);
  if (meta?.license) fmLines.push(`license: ${formatScalar(meta.license)}`);

  const byType = new Map<string, BundleConcept[]>();
  let maxMtime = 0;
  for (const c of concepts) {
    const list = byType.get(c.concept.type) ?? [];
    list.push(c);
    byType.set(c.concept.type, list);
    const mt = conceptMtime(c.concept);
    if (mt > maxMtime) maxMtime = mt;
  }

  const bodyLines: string[] = [];
  for (const type of [...byType.keys()].sort()) {
    const group = byType.get(type)!.slice().sort((a, b) => a.slug.localeCompare(b.slug));
    bodyLines.push(`# ${type}`);
    bodyLines.push("");
    for (const item of group) {
      const desc = item.concept.description?.trim();
      const suffix = desc ? ` - ${desc}` : "";
      bodyLines.push(`* [${item.concept.title}](${item.concept.type}/${item.slug}.md)${suffix}`);
    }
    bodyLines.push("");
  }

  const body = bodyLines.length > 0 ? `\n${bodyLines.join("\n")}` : "\n";
  return {
    path: "index.md",
    content: `---\n${fmLines.join("\n")}\n---\n${body}`,
    mtime: maxMtime,
  };
}

/** 最小 tar（USTAR）を組み立てる。 */
function tarEntries(entries: readonly BundleEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    if (entry.path.length > 100) {
      throw new Error(`bundle path exceeds tar name limit (100): ${entry.path}`);
    }
    const content = Buffer.from(entry.content, "utf8");
    const name = entry.path;
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write(entry.mtime.toString(8).padStart(11, "0") + "\0", 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    blocks.push(header, content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad, 0));
  }
  blocks.push(Buffer.alloc(512, 0));
  blocks.push(Buffer.alloc(512, 0));
  return Buffer.concat(blocks);
}

/** OKF bundle を gzip 圧縮した bytes として返す。`meta` 指定時はルート `index.md` (§8.1) を含める。 */
export function buildOkfBundle(
  concepts: readonly BundleConcept[],
  meta?: BundleMetadata,
): Promise<Buffer> {
  const entries = buildBundleEntries(concepts);
  if (meta !== undefined) {
    entries.push(buildBundleRootIndex(concepts, meta));
    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  const tar = tarEntries(entries);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gzip = createGzip();
    gzip.on("data", (c) => chunks.push(c));
    gzip.on("end", () => resolve(Buffer.concat(chunks)));
    gzip.on("error", reject);
    gzip.end(tar);
  });
}
