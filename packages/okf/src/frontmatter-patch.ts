/**
 * OKF v0.3 §4: Surgical frontmatter scalar patching without re-serializing
 * unchanged keys, comments, or key order.
 * Mirrors ibisOffice's `crates/ibis-formats/src/markdown/okf_metadata.rs`.
 */

import { formatScalar } from "./serialize.ts";
import { parseYaml } from "./yaml.ts";

function parseMapping(source: string): Record<string, unknown> | null {
  try {
    const parsed = parseYaml(source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
  }
  return false;
}

/**
 * Update a single top-level string scalar key in raw YAML frontmatter while
 * preserving comments, key ordering, and formatting of all other keys.
 *
 * Returns the patched YAML string, or `null` if the key cannot be safely
 * updated in place (e.g. multiline block scalar, YAML anchor/tag, or parse mismatch).
 */
export function patchFrontmatterScalar(
  rawFrontmatter: string,
  key: string,
  newValue: string,
): string | null {
  const original = parseMapping(rawFrontmatter);
  if (!original) return null;

  const expected: Record<string, unknown> = { ...original, [key]: newValue };
  const formatted = formatScalar(newValue);

  if (!Object.prototype.hasOwnProperty.call(original, key)) {
    const newline = rawFrontmatter.includes("\r\n") ? "\r\n" : "\n";
    const sep = rawFrontmatter.length === 0 || rawFrontmatter.endsWith("\n") ? "" : newline;
    const updated = `${rawFrontmatter}${sep}${key}: ${formatted}`;
    const reparsed = parseMapping(updated);
    return reparsed && deepEqual(reparsed, expected) ? updated : null;
  }

  const lines = rawFrontmatter.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let offset = 0;
  for (const line of lines) {
    const start = offset;
    offset += line.length;

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = line.slice(0, colonIdx);
    // Top-level keys only (no leading indentation)
    if (/^\s/.test(name) || name.trimEnd() !== key) continue;

    const tail = line.slice(colonIdx + 1).replace(/\r?\n$/, "");
    const valueStart = start + colonIdx + 1;
    let valueEnd = valueStart + tail.length;

    // Preserve trailing YAML comment if removing it leaves the parsed mapping identical
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] !== "#") continue;
      if (i > 0 && !/\s/.test(tail[i - 1]!)) continue;
      const commentPos = valueStart + i;
      const withoutComment = rawFrontmatter.slice(0, commentPos) + rawFrontmatter.slice(valueEnd);
      const check = parseMapping(withoutComment);
      if (check && deepEqual(check, original)) {
        valueEnd = commentPos;
        break;
      }
    }

    const prefix = rawFrontmatter.slice(valueStart, valueEnd);
    const trimmedStart = prefix.trimStart();
    if (/^[|>&*!]/.test(trimmedStart)) {
      return null;
    }

    const valStart = valueStart + (prefix.length - trimmedStart.length);
    const valEnd = valueStart + prefix.trimEnd().length;
    const updated =
      valStart >= valEnd
        ? `${rawFrontmatter.slice(0, valueStart)} ${formatted}${rawFrontmatter.slice(valueStart)}`
        : `${rawFrontmatter.slice(0, valStart)}${formatted}${rawFrontmatter.slice(valEnd)}`;

    const reparsed = parseMapping(updated);
    return reparsed && deepEqual(reparsed, expected) ? updated : null;
  }

  return null;
}

/**
 * Surgically update or append an inline OKF actor event (`generated` / `verified`)
 * without re-serializing untouched frontmatter keys or comments (OKF v0.3 §4).
 */
export function patchFrontmatterActorEvent(
  rawFrontmatter: string,
  key: string,
  event: { readonly by: string; readonly at: string },
): string | null {
  const original = parseMapping(rawFrontmatter);
  if (!original) return null;

  const expected: Record<string, unknown> = {
    ...original,
    [key]: { by: event.by, at: event.at },
  };
  const formatted = `{ by: ${formatScalar(event.by)}, at: ${formatScalar(event.at)} }`;

  if (!Object.prototype.hasOwnProperty.call(original, key)) {
    const newline = rawFrontmatter.includes("\r\n") ? "\r\n" : "\n";
    const sep = rawFrontmatter.length === 0 || rawFrontmatter.endsWith("\n") ? "" : newline;
    const updated = `${rawFrontmatter}${sep}${key}: ${formatted}`;
    const reparsed = parseMapping(updated);
    return reparsed && deepEqual(reparsed, expected) ? updated : null;
  }

  const lines = rawFrontmatter.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let offset = 0;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const start = offset;
    offset += line.length;

    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const name = line.slice(0, colonIdx);
    if (/^\s/.test(name) || name.trimEnd() !== key) continue;

    // Also consume indented child lines if the existing value was a block mapping.
    let blockEnd = offset;
    let j = idx + 1;
    while (j < lines.length && /^[ \t]+\S/.test(lines[j]!)) {
      blockEnd += lines[j]!.length;
      j++;
    }
    const lineEnding = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const trailingNewline =
      j > idx + 1
        ? lines[j - 1]!.endsWith("\r\n")
          ? "\r\n"
          : lines[j - 1]!.endsWith("\n")
            ? "\n"
            : ""
        : lineEnding;

    const updated = `${rawFrontmatter.slice(0, start)}${key}: ${formatted}${trailingNewline}${rawFrontmatter.slice(blockEnd)}`;
    const reparsed = parseMapping(updated);
    return reparsed && deepEqual(reparsed, expected) ? updated : null;
  }

  return null;
}
