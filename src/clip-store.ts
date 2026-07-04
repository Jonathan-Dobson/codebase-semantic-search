/**
 * In-memory store of clip references for the /clip endpoints and MCP tool.
 *
 * Each search result is assigned a small auto-increment numeric id when it
 * is returned to a caller. Agents can then fetch the file slice by
 * `GET /clip/:id` (or batch via `GET /clips?ids=…` / `POST /clips`) without
 * re-encoding the path + line range on every call.
 *
 * Properties:
 *  - In-memory only — server restart clears the table. Acceptable trade-off
 *    vs. encoded ids: short numeric handles save a lot of tokens in agent
 *    context, and a mid-session server restart just means re-searching.
 *  - FIFO eviction at `CLIP_STORE_MAX_ENTRIES` — once full, the oldest
 *    inserted id is dropped to make room. A long-idle id may return 404
 *    ("id not found"). Documented in README + templates.
 *  - Dedup on `(filePath, startLine, endLine)` — the same chunk always
 *    returns the same id across searches. Stable within a server lifetime.
 *  - Single-threaded by virtue of Node.js — no locks needed.
 */

export interface ClipRef {
  filePath: string;
  startLine: number;
  endLine: number;
}

export const CLIP_STORE_MAX_ENTRIES = 10_000;

const store = new Map<number, ClipRef>();
// Reverse lookup so eviction can clean dedup entries without scanning.
const dedup = new Map<string, number>();
const idToKey = new Map<number, string>();

let nextId = 1;

function dedupKey(filePath: string, startLine: number, endLine: number): string {
  return `${filePath}\x00${startLine}\x00${endLine}`;
}

function evictOldest(): void {
  const oldest = store.keys().next().value;
  if (oldest === undefined) return;
  store.delete(oldest);
  const key = idToKey.get(oldest);
  idToKey.delete(oldest);
  if (key !== undefined) dedup.delete(key);
}

/**
 * Register a clip reference and return its id. Idempotent — the same
 * (filePath, startLine, endLine) always returns the same id within the
 * lifetime of this server process.
 */
export function putClip(
  filePath: string,
  startLine: number,
  endLine: number,
): number {
  const key = dedupKey(filePath, startLine, endLine);
  const existing = dedup.get(key);
  if (existing !== undefined) return existing;

  while (store.size >= CLIP_STORE_MAX_ENTRIES) {
    evictOldest();
  }

  const id = nextId++;
  store.set(id, { filePath, startLine, endLine });
  dedup.set(key, id);
  idToKey.set(id, key);
  return id;
}

export function getClip(id: number): ClipRef | undefined {
  return store.get(id);
}

export function clipStoreSize(): number {
  return store.size;
}

/** Drop everything. Exposed mainly for tests. */
export function clearClipStore(): void {
  store.clear();
  dedup.clear();
  idToKey.clear();
  nextId = 1;
}