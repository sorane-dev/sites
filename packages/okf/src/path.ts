/**
 * OKF v0.3 path resolution & reserved filename helpers (§3.1, §3.2, §6, §12.1).
 * Aligned with ibisOffice's `crates/ibis-formats/src/okf.rs` boundary rules.
 */

import { extract } from "./extract.ts";

/** OKF v0.3 §3.1: Reserved filenames at all levels of the hierarchy. */
export const OKF_RESERVED_FILENAMES = new Set(["index.md", "log.md"]);

/** True when the basename of `relPath` is a reserved OKF filename (`index.md` or `log.md`). */
export function isReservedOkfFilename(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? norm;
  return OKF_RESERVED_FILENAMES.has(base);
}

/** OKF v0.3 §3.2 #4: Files and directories whose names start with `.` are not part of the bundle. */
export function isOkfDotPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return norm.split("/").some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

/**
 * True when `relPath` + `source` represents a non-concept OKF v0.3 reserved file
 * that coexists with concepts in a shared bundle/content directory:
 * - `log.md` at any level (OKF v0.3 §9)
 * - subdirectory `index.md` without frontmatter (OKF v0.3 §8)
 *
 * Root `index.md` (sorane's site landing page) is NOT treated as a non-concept file.
 */
export function isOkfNonConceptReservedFile(relPath: string, source: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = norm.split("/");
  const base = parts[parts.length - 1] ?? norm;
  if (base === "log.md") return true;
  if (base === "index.md" && parts.length > 1) {
    return extract(source).frontmatter === null;
  }
  return false;
}

export interface ResolvedOkfPath {
  /**
   * - `uri`: absolute URI with scheme (e.g. `https://...`) or scheme-relative URI (`//...`)
   * - `bundle`: in-bundle path relative to the bundle root (no leading `/`)
   * - `external`: resolves outside the bundle root, escapes via percent-encoding,
   *   references a dot-path, or contains forbidden path characters
   */
  readonly kind: "uri" | "bundle" | "external";
  readonly resolved: string;
  readonly fragment?: string;
}

export interface ResolveOkfPathOptions {
  /** Declared bundle `okf_version` (enables §12.1 v0.2 bundle-root fallback when `<= 0.2` or absent). */
  readonly okfVersion?: string;
  /** Known bundle-relative paths (without leading `/`) for §12.1 fallback checks. */
  readonly existingPaths?: ReadonlySet<string>;
}

function isLegacyVersion(okfVersion: string | undefined): boolean {
  if (!okfVersion) return true;
  const m = /^(\d+)\.(\d+)$/.exec(okfVersion.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major === 0 && minor <= 2;
}

/**
 * Decode and normalize bundle-relative segments strictly inside the bundle root.
 * Rejects escape via `..` (including `%2e%2e`), dot-paths (`.git`), empty segments,
 * invalid percent-encoding, and decoded separators (`/`, `\`, `\0`, `:`).
 */
function resolveSegmentsInsideBundle(
  baseParts: readonly string[],
  rawSegments: string,
): string | null {
  const parts = [...baseParts];
  const trimmed = rawSegments.replace(/^\/+/, "");
  if (trimmed.length === 0) return null;

  for (const segment of trimmed.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === ".") continue;
    if (decoded === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (
      decoded.length === 0 ||
      decoded.startsWith(".") ||
      /[/\\\0:]/.test(decoded)
    ) {
      return null;
    }
    parts.push(decoded);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * Resolve an OKF v0.3 link target or path field (§6).
 *
 * 1. Scheme-relative (`//...`) or URI scheme (first segment contains `:`) → `kind: "uri"`.
 * 2. Empty path (e.g. `#fragment`) → resolves to `fromFile`.
 * 3. Leading `/` → resolves from the bundle root.
 * 4. Otherwise → resolves from the directory of `fromFile`.
 *    (§12.1: for v0.2 or unversioned bundles, if `existingPaths` is given and
 *    the file-relative path does not exist, fall back to bundle-root resolution.)
 * 5. Any path escaping above the bundle root, using `%2e%2e` / `%2f` / dot-segments,
 *    or invalid percent-encoding → `kind: "external"`.
 */
export function resolveOkfPath(
  target: string,
  fromFile: string,
  opts?: ResolveOkfPathOptions,
): ResolvedOkfPath {
  const hashIdx = target.indexOf("#");
  const beforeHash = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const fragment = hashIdx >= 0 ? target.slice(hashIdx + 1) : undefined;
  const queryIdx = beforeHash.indexOf("?");
  const rawPath = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;

  const firstSegment = rawPath.split("/")[0] ?? "";
  if (rawPath.startsWith("//") || firstSegment.includes(":")) {
    return { kind: "uri", resolved: beforeHash, fragment };
  }

  const fromNorm = fromFile.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rawPath.length === 0) {
    return { kind: "bundle", resolved: fromNorm, fragment };
  }

  if (rawPath.startsWith("/")) {
    const rel = resolveSegmentsInsideBundle([], rawPath.slice(1));
    if (rel === null) {
      return { kind: "external", resolved: rawPath, fragment };
    }
    return { kind: "bundle", resolved: rel, fragment };
  }

  const fromParts = fromNorm.split("/");
  fromParts.pop();
  const rel = resolveSegmentsInsideBundle(fromParts, rawPath);

  if (rel === null) {
    return { kind: "external", resolved: rawPath, fragment };
  }

  if (
    opts?.existingPaths &&
    !opts.existingPaths.has(rel) &&
    isLegacyVersion(opts.okfVersion)
  ) {
    const rootFallback = resolveSegmentsInsideBundle([], rawPath);
    if (rootFallback !== null && opts.existingPaths.has(rootFallback)) {
      return { kind: "bundle", resolved: rootFallback, fragment };
    }
  }

  return { kind: "bundle", resolved: rel, fragment };
}
