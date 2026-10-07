/**
 * The fields POST /search accepts, and a check that refuses any other.
 *
 * Unknown fields used to be dropped silently, so a caller who sent `limit`
 * (the field is `top_k`) got 100 results and no hint why. Rejecting them
 * makes a wrong guess visible on the first call.
 */

export const SEARCH_FIELDS = [
  'query',
  'top_k',
  'module',
  'language',
  'chunk_type',
  'min_score',
  'min_score_diff',
  'include',
  'format',
  'ignore',
] as const;

/** Likely guesses, mapped to the field the caller probably meant. */
const DID_YOU_MEAN: Record<string, string> = {
  limit: 'top_k',
  k: 'top_k',
  topK: 'top_k',
  top: 'top_k',
  q: 'query',
  exclude: 'ignore',
  excludes: 'ignore',
  minScore: 'min_score',
  minScoreDiff: 'min_score_diff',
  chunkType: 'chunk_type',
  lang: 'language',
};

/** An error message naming each unknown field, or undefined when all are known. */
export function unknownFieldsError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const known = new Set<string>(SEARCH_FIELDS);
  const unknown = Object.keys(body).filter((k) => !known.has(k));
  if (unknown.length === 0) return undefined;
  const named = unknown
    .map((k) => (DID_YOU_MEAN[k] ? `"${k}" (did you mean "${DID_YOU_MEAN[k]}"?)` : `"${k}"`))
    .join(', ');
  return `unknown field${unknown.length > 1 ? 's' : ''}: ${named}. Accepted: ${SEARCH_FIELDS.join(', ')}`;
}
