/**
 * The `ignore` search filter: path patterns whose chunks a search leaves out.
 *
 * The index keeps everything; ignoring happens at query time, as a Milvus
 * filter expression on `file_path`, so changing what is ignored needs no
 * reindex. A project can set a default in `.codesearchrc.json`
 * (`searchIgnore`), which applies whenever a request doesn't pass `ignore`;
 * `ignore: []` searches everything.
 *
 * Patterns are relative to the workspace root:
 *   docs/          a folder (trailing slash)
 *   docs           a folder, or a file with exactly that path
 *   *.md           a wildcard: `*` matches any run of characters, `/` included
 *   server/**\/README.md   `**` is the same as `*`
 *
 * Milvus `like` treats `%` and `_` as wildcards, so both are escaped and match
 * literally (`__tests__/` means that folder, not any 9-character name).
 */

export const MAX_IGNORE_PATTERNS = 20;
export const MAX_IGNORE_PATTERN_LENGTH = 200;

export type IgnoreSource = 'request' | 'config' | 'none';

export interface ResolvedIgnore {
  patterns: string[];
  source: IgnoreSource;
}

/** A string as the body of a double-quoted Milvus string literal. */
function quote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** A literal path fragment for a `like` pattern: `%`, `_` and `\` escaped. */
function likeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One pattern as a Milvus expression that MATCHES the paths it names. */
export function patternToMatchExpr(raw: string): string {
  const p = raw.trim().replace(/^\.?\//, '');
  if (p.includes('*')) {
    const like = p.split(/\*+/).map(likeLiteral).join('%');
    return `file_path like "${quote(like)}"`;
  }
  if (p.endsWith('/')) {
    return `file_path like "${quote(likeLiteral(p) + '%')}"`;
  }
  // No wildcard, no trailing slash: that exact file, or a folder of that name.
  return `(file_path == "${quote(p)}" or file_path like "${quote(likeLiteral(p) + '/%')}")`;
}

/** The expression that excludes every pattern, or undefined for none. */
export function buildIgnoreExpr(patterns: readonly string[]): string | undefined {
  const usable = patterns.map((p) => p.trim()).filter(Boolean);
  if (usable.length === 0) return undefined;
  return usable.map((p) => `not (${patternToMatchExpr(p)})`).join(' and ');
}

/**
 * Validate a request's `ignore` value. `undefined` means "not given" (the
 * config default applies); an array, even empty, is the caller's choice.
 */
export function parseIgnore(
  value: unknown,
): { ok: true; patterns: string[] | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, patterns: undefined };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'ignore must be an array of path patterns, e.g. ["docs/", "*.md"]' };
  }
  if (value.length > MAX_IGNORE_PATTERNS) {
    return { ok: false, error: `ignore takes at most ${MAX_IGNORE_PATTERNS} patterns` };
  }
  const patterns: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.trim() === '') {
      return { ok: false, error: 'each ignore pattern must be a non-empty string' };
    }
    if (v.length > MAX_IGNORE_PATTERN_LENGTH) {
      return { ok: false, error: `ignore patterns are at most ${MAX_IGNORE_PATTERN_LENGTH} characters` };
    }
    patterns.push(v.trim());
  }
  return { ok: true, patterns };
}

/** The request's patterns if it gave any (even none), else the config default. */
export function resolveIgnore(
  requested: string[] | undefined,
  configDefault: readonly string[] | undefined,
): ResolvedIgnore {
  if (requested !== undefined) {
    return { patterns: requested, source: requested.length ? 'request' : 'none' };
  }
  // A hand-edited config may hold anything; only non-empty strings count.
  const fallback = (Array.isArray(configDefault) ? configDefault : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter(Boolean);
  return { patterns: fallback, source: fallback.length ? 'config' : 'none' };
}

/** One line for a response, so a caller knows what it didn't see. */
export function describeIgnore(r: ResolvedIgnore): string | undefined {
  if (r.patterns.length === 0) return undefined;
  const list = r.patterns.join(', ');
  return r.source === 'config'
    ? `ignored: ${list} (project default; pass ignore: [] to include)`
    : `ignored: ${list}`;
}
