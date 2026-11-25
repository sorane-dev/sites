/**
 * OKF v0.3 path resolution & reserved filename helpers (§3.1, §3.2, §6, §12.1).
 */

import { posix } from "node:path";

/** OKF v0.3 §3.1: Reserved filenames at all levels of the hierarchy. */
export const OKF_RESERVED_FILENAMES = new Set(["index.md", "log.md"]);

const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

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

export interface ResolvedOkfPath {
  /**
   * - `uri`: absolute URI with scheme (e.g. `https://...`)
   * - `bundle`: in-bundle path relative to the bundle root (no leading `/`)
   * - `external`: resolves outside the bundle root (consumers MUST NOT read from local fs)
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

function normalizeInsideBundle(candidate: string): string | null {
  const norm = posix.normalize(candidate).replace(/^\/+/, "");
  if (norm === ".." || norm.startsWith("../")) return null;
  if (norm === ".") return "";
  return norm;
}

/**
 * Resolve an OKF v0.3 link target or path field (§6).
 *
 * 1. Value with URI scheme → `kind: "uri"`.
 * 2. Leading `/` → resolves from the bundle root.
 * 3. Otherwise → resolves from the directory of `fromFile`.
 *    (§12.1: for v0.2 or unversioned bundles, if `existingPaths` is given and
 *    the file-relative path does not exist, fall back to bundle-root resolution.)
 * 4. Any path escaping above the bundle root → `kind: "external"`.
 */
export function resolveOkfPath(
  target: string,
  fromFile: string,
  opts?: ResolveOkfPathOptions,
): ResolvedOkfPath {
  const hashIdx = target.indexOf("#");
  const rawPath = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const fragment = hashIdx >= 0 ? target.slice(hashIdx + 1) : undefined;

  if (URI_SCHEME_RE.test(rawPath)) {
    return { kind: "uri", resolved: rawPath, fragment };
  }

  if (rawPath.startsWith("/")) {
    const rel = normalizeInsideBundle(rawPath.slice(1));
    if (rel === null) {
      return { kind: "external", resolved: rawPath, fragment };
    }
    return { kind: "bundle", resolved: rel, fragment };
  }

  const fromNorm = fromFile.replace(/\\/g, "/").replace(/^\/+/, "");
  const fromDir = posix.dirname(fromNorm);
  const joined = fromDir === "." ? rawPath : `${fromDir}/${rawPath}`;
  const rel = normalizeInsideBundle(joined);

  if (rel === null) {
    return { kind: "external", resolved: joined, fragment };
  }

  if (
    opts?.existingPaths &&
    !opts.existingPaths.has(rel) &&
    isLegacyVersion(opts.okfVersion)
  ) {
    const rootFallback = normalizeInsideBundle(rawPath);
    if (rootFallback !== null && opts.existingPaths.has(rootFallback)) {
      return { kind: "bundle", resolved: rootFallback, fragment };
    }
  }

  return { kind: "bundle", resolved: rel, fragment };
}
