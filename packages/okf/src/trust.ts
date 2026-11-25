/**
 * OKF v0.3 trust / provenance / lifecycle helpers.
 * Spec: https://github.com/open-knowledge-format/open-knowledge-format/blob/main/SPEC.md
 */

export type KnownOkfConceptStatus = "draft" | "stable" | "deprecated";
/** OKF v0.3 §5.4: unknown status strings are preserved (and treated as non-stable). */
export type OkfConceptStatus = KnownOkfConceptStatus | (string & {});

/** Consumer-derived advisory tier from current `verified` events (§5.3). */
export type OkfTrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export interface OkfActorEvent {
  readonly by: string;
  readonly at: string;
  readonly [extensionKey: string]: unknown;
}

export interface OkfDateRange {
  readonly from?: string;
  readonly to?: string;
  readonly [extensionKey: string]: unknown;
}

export interface OkfSourceEntry {
  readonly resource: string;
  readonly id?: string;
  readonly title?: string;
  readonly author?: string;
  readonly usage_count?: number;
  readonly last_modified?: string;
  readonly usage_window?: OkfDateRange;
  readonly [extensionKey: string]: unknown;
}

export interface TrustParseResult {
  readonly generated?: OkfActorEvent;
  readonly verified?: readonly OkfActorEvent[];
  readonly sources?: readonly OkfSourceEntry[];
  readonly usage_window?: OkfDateRange;
  readonly status?: OkfConceptStatus;
  readonly superseded_by?: string;
  readonly stale_after?: string;
  readonly warnings: readonly string[];
  readonly issues: readonly { path: string; message: string }[];
}

const KNOWN_STATUS_SET = new Set<string>(["draft", "stable", "deprecated"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/** OKF v0.3 §11.2 #1: null, empty string, and empty list are equivalent to an absent key. */
export function isAbsentOkfValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]!;
}

/** RFC 3339 full-date (`YYYY-MM-DD`). */
export function isRfc3339Date(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  return isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** RFC 3339 date-time with explicit UTC offset. */
export function isRfc3339DateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  return (
    isValidCalendarDate(Number(yearText), Number(monthText), Number(dayText)) &&
    Number(hourText) <= 23 &&
    Number(minuteText) <= 59 &&
    Number(secondText) <= 59 &&
    Number(offsetHourText ?? 0) <= 23 &&
    Number(offsetMinuteText ?? 0) <= 59
  );
}

/** OKF v0.3 §5: RFC 3339 date-time or full-date. */
export function isOkfTimestamp(value: string): boolean {
  return isRfc3339DateTime(value) || isRfc3339Date(value);
}

/**
 * Parse an OKF v0.3 timestamp to UTC epoch milliseconds.
 * Date-only (`YYYY-MM-DD`) means start of that day in UTC (`T00:00:00Z`).
 * Returns `NaN` if not a valid RFC 3339 date or date-time.
 */
export function parseOkfTimestampMs(value: string): number {
  if (isRfc3339Date(value)) {
    return Date.parse(`${value}T00:00:00Z`);
  }
  if (isRfc3339DateTime(value)) {
    return Date.parse(value);
  }
  return Number.NaN;
}

/** Accept quoted RFC 3339 string or YAML-native Date (§5). */
function coerceOkfTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && isOkfTimestamp(value)) {
    return value;
  }
  return undefined;
}

function collectExtensionKeys(
  obj: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!knownKeys.has(k) && v !== undefined) {
      extra[k] = v;
    }
  }
  return extra;
}

const DATE_RANGE_KNOWN_KEYS = new Set(["from", "to"]);
const ACTOR_EVENT_KNOWN_KEYS = new Set(["by", "at"]);
const SOURCE_ENTRY_KNOWN_KEYS = new Set([
  "resource",
  "id",
  "title",
  "author",
  "usage_count",
  "last_modified",
  "usage_window",
]);

function parseDateRange(
  value: unknown,
  path: string,
  issues: { path: string; message: string }[],
): OkfDateRange | undefined {
  if (isAbsentOkfValue(value)) return undefined;
  if (!isPlainObject(value)) {
    issues.push({ path, message: `${path} must be a mapping with from/to` });
    return undefined;
  }
  const from = isAbsentOkfValue(value.from) ? undefined : coerceOkfTimestamp(value.from);
  const to = isAbsentOkfValue(value.to) ? undefined : coerceOkfTimestamp(value.to);
  if (!isAbsentOkfValue(value.from) && from === undefined) {
    issues.push({ path: `${path}/from`, message: `${path}.from must be an RFC 3339 date or date-time` });
  }
  if (!isAbsentOkfValue(value.to) && to === undefined) {
    issues.push({ path: `${path}/to`, message: `${path}.to must be an RFC 3339 date or date-time` });
  }
  if (from === undefined && to === undefined) {
    issues.push({ path, message: `${path} needs from and/or to` });
    return undefined;
  }
  const extra = collectExtensionKeys(value, DATE_RANGE_KNOWN_KEYS);
  return { ...extra, from, to };
}

function parseActorEvent(
  value: unknown,
  path: string,
  issues: { path: string; message: string }[],
): OkfActorEvent | undefined {
  if (!isPlainObject(value)) {
    issues.push({ path, message: `${path} must be a mapping with by` });
    return undefined;
  }
  if (typeof value.by !== "string" || value.by.length === 0) {
    issues.push({ path: `${path}/by`, message: `${path}.by is required (actor string)` });
    return undefined;
  }
  const at = coerceOkfTimestamp(value.at);
  if (!at) {
    issues.push({ path: `${path}/at`, message: `${path}.at is required and must be an RFC 3339 date or date-time` });
    return undefined;
  }
  const extra = collectExtensionKeys(value, ACTOR_EVENT_KNOWN_KEYS);
  return { ...extra, by: value.by, at };
}

function parseVerified(
  value: unknown,
  issues: { path: string; message: string }[],
): readonly OkfActorEvent[] | undefined {
  if (isAbsentOkfValue(value)) return undefined;
  if (isPlainObject(value)) {
    const one = parseActorEvent(value, "verified", issues);
    return one ? [one] : undefined;
  }
  if (!Array.isArray(value)) {
    issues.push({
      path: "verified",
      message: "verified must be a { by, at } mapping or a list of them",
    });
    return undefined;
  }
  const out: OkfActorEvent[] = [];
  value.forEach((item, i) => {
    const ev = parseActorEvent(item, `verified/${i}`, issues);
    if (ev) out.push(ev);
  });
  return out.length > 0 ? out : undefined;
}

function parseOneSource(
  item: unknown,
  path: string,
  issues: { path: string; message: string }[],
): OkfSourceEntry | undefined {
  if (!isPlainObject(item)) {
    issues.push({ path, message: `${path} must be a mapping` });
    return undefined;
  }
  if (typeof item.resource !== "string" || item.resource.length === 0) {
    issues.push({
      path: `${path}/resource`,
      message: `${path}.resource is required`,
    });
    return undefined;
  }
  const lastModified = isAbsentOkfValue(item.last_modified)
    ? undefined
    : coerceOkfTimestamp(item.last_modified);
  if (!isAbsentOkfValue(item.last_modified) && lastModified === undefined) {
    issues.push({
      path: `${path}/last_modified`,
      message: `${path}.last_modified must be an RFC 3339 date or date-time`,
    });
  }
  const extra = collectExtensionKeys(item, SOURCE_ENTRY_KNOWN_KEYS);
  return {
    ...extra,
    resource: item.resource,
    id: typeof item.id === "string" && item.id.length > 0 ? item.id : undefined,
    title: typeof item.title === "string" && item.title.length > 0 ? item.title : undefined,
    author: typeof item.author === "string" && item.author.length > 0 ? item.author : undefined,
    usage_count:
      typeof item.usage_count === "number" && Number.isFinite(item.usage_count)
        ? item.usage_count
        : undefined,
    last_modified: lastModified,
    usage_window: parseDateRange(item.usage_window, `${path}/usage_window`, issues),
  };
}

function parseSources(
  value: unknown,
  issues: { path: string; message: string }[],
): readonly OkfSourceEntry[] | undefined {
  if (isAbsentOkfValue(value)) return undefined;
  // OKF v0.3 §11.2 #2: accept single mapping as a list with one item.
  if (isPlainObject(value)) {
    const one = parseOneSource(value, "sources", issues);
    return one ? [one] : undefined;
  }
  if (!Array.isArray(value)) {
    issues.push({ path: "sources", message: "sources must be a list or source mapping" });
    return undefined;
  }
  const out: OkfSourceEntry[] = [];
  value.forEach((item, i) => {
    const entry = parseOneSource(item, `sources/${i}`, issues);
    if (entry) out.push(entry);
  });
  return out.length > 0 ? out : undefined;
}

/** Parse optional OKF v0.3 trust / provenance / lifecycle families from raw frontmatter. */
export function parseTrustFields(raw: Record<string, unknown>): TrustParseResult {
  const issues: { path: string; message: string }[] = [];
  const warnings: string[] = [];

  const generated = !isAbsentOkfValue(raw.generated)
    ? parseActorEvent(raw.generated, "generated", issues)
    : undefined;
  const verified = parseVerified(raw.verified, issues);
  const sources = parseSources(raw.sources, issues);
  const usage_window = parseDateRange(raw.usage_window, "usage_window", issues);

  let status: OkfConceptStatus | undefined;
  if (!isAbsentOkfValue(raw.status)) {
    if (typeof raw.status === "string") {
      status = raw.status;
      if (!KNOWN_STATUS_SET.has(raw.status)) {
        warnings.push(
          `unknown status "${raw.status}" (OKF v0.3 §5.4: treated as non-stable; known values: draft, stable, deprecated)`,
        );
      }
    } else {
      issues.push({
        path: "status",
        message: 'status must be a string ("draft", "stable", or "deprecated")',
      });
    }
  }

  let superseded_by: string | undefined;
  if (!isAbsentOkfValue(raw.superseded_by)) {
    if (typeof raw.superseded_by === "string") {
      superseded_by = raw.superseded_by;
      if (status !== "deprecated") {
        warnings.push(
          `superseded_by "${superseded_by}" has meaning only with status: deprecated (OKF v0.3 §5.4)`,
        );
      }
    } else {
      issues.push({
        path: "superseded_by",
        message: "superseded_by must be a path or URI string",
      });
    }
  }

  let stale_after: string | undefined;
  if (!isAbsentOkfValue(raw.stale_after)) {
    const coerced = coerceOkfTimestamp(raw.stale_after);
    if (coerced) {
      stale_after = coerced;
    } else {
      issues.push({
        path: "stale_after",
        message: "stale_after must be an RFC 3339 date or date-time",
      });
    }
  }

  return {
    generated,
    verified,
    sources,
    usage_window,
    status,
    superseded_by,
    stale_after,
    warnings,
    issues,
  };
}

/**
 * OKF v0.3 §5.3: A verification event is current when its `at` is equal to
 * or later than `generated.at`, or when `generated` is absent.
 */
export function isCurrentVerification(
  event: OkfActorEvent,
  generated?: OkfActorEvent | string,
): boolean {
  const genAt = typeof generated === "string" ? generated : generated?.at;
  if (!genAt) return true;
  const evMs = parseOkfTimestampMs(event.at);
  const genMs = parseOkfTimestampMs(genAt);
  if (!Number.isFinite(evMs) || !Number.isFinite(genMs)) return false;
  return evMs >= genMs;
}

/** Return only the current verification events per OKF v0.3 §5.3. */
export function currentVerifications(
  verified: readonly OkfActorEvent[] | undefined,
  generated?: OkfActorEvent | string,
): readonly OkfActorEvent[] {
  if (!verified || verified.length === 0) return [];
  return verified.filter((ev) => isCurrentVerification(ev, generated));
}

/**
 * Derive OKF v0.3 §5.3 trust tier from current verified events.
 * Pass `generated` (or `generated.at`) so verifications older than the last
 * meaningful change do not elevate the tier.
 */
export function deriveTrustTier(
  verified: readonly OkfActorEvent[] | undefined,
  generated?: OkfActorEvent | string,
): OkfTrustTier {
  const current = currentVerifications(verified, generated);
  if (current.length === 0) return "unverified";
  if (current.some((v) => v.by.startsWith("human:"))) return "human-reviewed";
  return "machine-confirmed";
}

/**
 * OKF v0.3 §5.4: Absent `status` defaults to `stable`.
 * Any unknown status value is NOT `stable` (excluded by current-knowledge filters).
 */
export function isStableStatus(status: string | undefined): boolean {
  return status === undefined || status === "stable";
}

/**
 * OKF v0.3 §5.5: True when `now >= stale_after`.
 * An empty or absent `stale_after` is not stale.
 * A non-empty `stale_after` that cannot be parsed MUST NOT be treated as fresh (returns true).
 */
export function isStale(stale_after: string | undefined, now = new Date()): boolean {
  if (!stale_after) return false;
  const deadline = parseOkfTimestampMs(stale_after);
  if (!Number.isFinite(deadline)) return true;
  return now.getTime() >= deadline;
}

/** Keys reserved for OKF v0.3 trust / provenance / lifecycle families (excluded from generic frontmatter bag). */
export const TRUST_FRONTMATTER_KEYS = [
  "generated",
  "verified",
  "sources",
  "usage_window",
  "status",
  "superseded_by",
  "stale_after",
] as const;
