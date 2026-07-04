## 1.1  Codebase Semantic Search (Local Tool)

A local vector search engine indexes the full codebase (docs, wiki, src, server/src — whatever you configure in `.codesearchrc.json`).
Use it for **conceptual/meaning-based** discovery when `grep_search` is too literal.
**This is a required first step before creating any new file, component, hook, utility, type, route, or model.**

### Run a query

Minimum viable call — just the query:

```text
tool:   codebase_semantic_search
input:  { "query": "<natural language>" }
```

```bash
curl -s http://localhost:7700/search \
  -H "Content-Type: application/json" \
  -d '{"query": "<natural language>"}'
```

Defaults applied: `top_k: 10` and `min_score_diff: 0.1` (drop anything more
than 10% below the best match). To override or add filters, see "Optional
filters" below.

### Response format: markdown by default

The default response is a **single markdown document** — `# Search: "..."`
title at the top with a one-line summary (count, `top_k`, `min_score_diff`
if applied, included fields, clip store size), then one fenced code block
per hit followed by a plain-text caption line with the file path:line
range, symbol name, score, and id. Code is the primary matter; metadata
is the caption beneath it.

Pass `format: "json"` if you need the structured response (programmatic
extraction, downstream tooling that expects JSON). In MCP, the `format`
arg is part of the tool schema; in HTTP, set `"format": "json"` in the
request body.

Example markdown response:

````markdown
# Search: "how invoices are created"

3 results • top_k: 10 • min_score_diff: 0.1 • clip store: 142

---

```typescript
/**
 * Clawback transaction — reclaim issued tokens or MPTs from a holder's account.
 */
import type { BaseTransactionFields } from '../types/base.js';
...
```

src/transactions/clawback.ts:1-11 • file-header • score: 0.8146 • id: 1

---

```typescript
export class ClawbackTx extends TokenTransaction { ... }
```

src/transactions/clawback.ts:18-38 • ClawbackTx • score: 0.7353 • id: 2
````

### Optional filters

| filter            | matches against                                | default  | examples                                          |
|-------------------|------------------------------------------------|----------|---------------------------------------------------|
| `top_k`           | number of candidates requested from Milvus     | `10`     | `5` for "give me the top 5"                       |
| `module`          | first path segment under the workspace root    | —        | `src`, `server/src/modules/billing`, `docs`       |
| `language`        | file language                                  | —        | `typescript`, `tsx`, `javascript`, `markdown`, `json`, `yaml`, `terraform`, `python` |
| `chunk_type`      | AST node type (TS/JS) or section kind (md)     | —        | `function`, `class`, `interface`, `section`, `block` |
| `min_score`       | minimum cosine-similarity score (0..1)         | —        | `0.75` for "strong matches only"                  |
| `min_score_diff`  | max distance below best hit (0..1)             | `0.1`    | `0.05` for "tight", `0.3` for "lenient"           |
| `include`         | opt-in metadata fields on each result          | —        | `["chunkType", "module", "language"]`             |
| `format`          | response format                                | `"markdown"` | `"json"` for structured response             |

Combine with `query` to narrow fast. Example — find the TypeScript function that handles a specific HTTP error, requiring a high-quality match:

```json
{
  "query": "how 404 responses are shaped for the public REST API",
  "top_k": 5,
  "language": "typescript",
  "chunk_type": "function",
  "min_score": 0.7
}
```

#### `min_score` semantics (absolute threshold)

Quality filter applied **after** the vector search: the engine asks Milvus
for `top_k` candidates, then drops anything below `min_score`. So you may
get back fewer than `top_k` results. If you need a guaranteed minimum count
of high-quality hits, bump `top_k` (e.g. `top_k: 30, min_score: 0.7` to
ensure at least 5–10 qualifying results on a sizeable codebase).

When set, the response echoes `minScore` and `candidatesBeforeFilter` so
you can see how aggressive the filter was:

```json
{
  "data": {
    "query": "...",
    "count": 6,
    "topK": 10,
    "minScore": 0.7,
    "candidatesBeforeFilter": 10,
    "results": [ ... ]
  }
}
```

#### `min_score_diff` semantics (relative threshold)

Alternative to `min_score`. Threshold is computed from the best hit in
the result set: `appliedThreshold = max_score - min_score_diff`. Useful
when you don't know the absolute score distribution in advance — "show
me everything within 0.1 of the best match" is often more meaningful
than "show me everything above 0.7".

Mutually exclusive with `min_score` — passing both returns HTTP 400 /
MCP `isError`.

When set, the response echoes `minScoreDiff`, `appliedThreshold`,
`maxScore`, and `candidatesBeforeFilter`:

```json
{
  "data": {
    "query": "...",
    "count": 4,
    "topK": 10,
    "minScoreDiff": 0.1,
    "appliedThreshold": 0.7146,
    "maxScore": 0.8146,
    "candidatesBeforeFilter": 10,
    "results": [ ... ]
  }
}
```

Recommended bands:
- **0.05–0.15** — strict relative threshold; typically keeps 3–8 hits
  on a sizeable codebase with `top_k: 10`.
- **0.2–0.3** — lenient; useful when the top match is strong but the
  semantic space drops off sharply below it.

Recommended bands (absolute `min_score`):
- **0.75+** — strong, relevant matches; safe to act on.
- **0.55–0.75** — worth reviewing; context may help disambiguate.
- **< 0.55** — likely noise; widen the query or add filters instead of
  lowering the threshold.

### Response shape (JSON opt-in)

Default response is **markdown** (see "Response format: markdown by default" above). For the structured JSON shape, pass `format: "json"`:

```json
{
  "success": true,
  "data": {
    "query": "...",
    "count": 10,
    "topK": 10,
    "clipStoreSize": 142,
    "results": [
      {
        "id": 42,
        "filePath": "server/src/modules/billing/routes.ts",
        "symbolName": "createInvoice",
        "score": 0.842,
        "startLine": 42,
        "endLine": 80,
        "content": "export async function createInvoice(req, res) { ... }"
      }
    ]
  }
}
```

#### Field reference (JSON `results[]`)

| field                | meaning                                                                       |
|----------------------|-------------------------------------------------------------------------------|
| `id`                 | Short numeric handle. Pass to `codebase_clip` / `GET /clip/:id` for the text  |
| `score`              | 0..1 cosine similarity. ≥0.75 = strong match, 0.55–0.75 = worth reviewing, <0.55 = likely noise |
| `filePath`           | Path relative to workspace root                                              |
| `symbolName`         | Function/class/interface name when the chunk is a symbol; `null` otherwise    |
| `startLine`/`endLine`| 1-indexed inclusive line range in `filePath`                                  |
| `content`            | The chunk text itself — read THIS before opening the whole file              |

`clipStoreSize` reports the current in-memory clip-store size (FIFO capped at 10K entries; cleared on server restart). When `min_score` is set, `minScore` + `candidatesBeforeFilter` are also in `data`. When `include` is set, the chosen fields are added to each result and `includedFields` is echoed in `data`.

#### Opt-in metadata: `include`

`chunkType`, `module`, `language` are **not in the default response** — they are useful as filter inputs but largely redundant in the response (you can read `module` from the first `/`-segment of `filePath`, and `language` from its extension; `chunkType` is usually obvious from `content`). Opt-in only when you actually need them:

```jsonc
// MCP / HTTP
{
  "query": "how invoices are created",
  "top_k": 10,
  "include": ["chunkType", "module", "language"]
}
```

Each hit then also carries those fields. Allowed values: `"chunkType"`, `"module"`, `"language"`. Unknown value → HTTP 400 / MCP `isError` with the allowed list.

### Two ways to fetch the full text of a chunk

#### A. Shortcut — fetch by `id` (recommended for the common case)

You get the chunk back exactly as the search hit described it — no range fiddling.

```text
// MCP — single
tool:   codebase_clip
input:  { "id": 42 }

// MCP — batch (one tool call, many ids)
tool:   codebase_clip
input:  { "ids": [42, 17, 99] }
```

```bash
# HTTP single — GET-friendly, easy to curl/test
curl -s http://localhost:7700/clip/42

# HTTP batch small — GET with comma-separated ids
curl -s 'http://localhost:7700/clips?ids=42,17,99'

# HTTP batch large — POST with JSON body (no query-string length concerns)
curl -s -X POST http://localhost:7700/clips \
  -H "Content-Type: application/json" \
  -d '{"ids":[42,17,99,128,256]}'
```

**Response (single):** `{ success, data: { id, filePath, startLine, endLine, totalLines, content } }`.

**Response (batch):** `{ success, data: { results: [...], requested, succeeded, failed, clipStoreSize } }`. Each result has `success: bool` — failures (id not found, file missing, file too large) do not abort the batch.

**Ephemeral caveat:** ids live in an in-memory table (FIFO eviction at 10K entries). Server restart clears the table, and the oldest id may be evicted under load. If you get "id not found or expired", re-run the search.

#### B. Direct — fetch by file path + line range (use to expand context)

When a hit is a fragment of a larger function and you want the surrounding lines (imports above, callers below, comments in between), use the raw `filePath` + line range. Adjust `startLine`/`endLine` to widen or narrow the window — e.g. `startLine - 10` / `endLine + 10`.

```text
// MCP
tool:   codebase_read_file
input:  { "filePath": "server/src/modules/billing/routes.ts", "startLine": 38, "endLine": 95 }
```

```bash
# HTTP
curl -s -X POST http://localhost:7700/read \
  -H "Content-Type: application/json" \
  -d '{"filePath":"server/src/modules/billing/routes.ts","startLine":38,"endLine":95}'
```

**Returns:** `{ filePath, startLine, endLine, totalLines, rangeRequested, content }`.

**Limits:** 500 lines per call (chain multiple reads to paginate). 25 MB file cap (HTTP 413 / MCP `isError: file too large`). Path safety: `filePath` is relative to the workspace root; absolute paths and `../` escapes are rejected.

#### Which to pick?

| Situation | Use |
|-----------|-----|
| Want the chunk as the search returned it | `id` → `codebase_clip` / `/clip/:id` |
| Need surrounding context (imports, callers, comments) | `codebase_read_file` / `/read` with adjusted range |
| Want many chunks at once | `codebase_clip` with `ids` / `/clips` (GET or POST) |

### Typical workflow

```text
1. codebase_semantic_search(query="how invoices are created")          → results[]
2. codebase_clip(ids=[r.id for r in results])                          → full text of each
3. Make your edit in the lines you've now seen in full
```

### Query crafting

Good queries read like a one-sentence question to a teammate who's read the codebase:

- Be specific. `"tenant isolation in mongoose queries"` beats `"mongoose"`.
- Add intent. `"how does X…"`, `"where is Y handled…"`, `"what validates Z…"`.
- Filter to narrow. `module: "platform"` + `chunk_type: "function"` cuts docs
  and non-code blocks in one shot.
- If 0 results → drop filters first, then try synonyms
  (`auth` ↔ `authentication` ↔ `login` ↔ `signin`).
- If noisy (lots of mid-score irrelevant hits) → narrow the query with a
  concrete noun from the domain (a schema field, an HTTP route, an error
  class). Don't widen `top_k` past 20 to compensate — that buries the good hits.

### Concrete recipes

| Goal                                              | Query                                                                |
|---------------------------------------------------|----------------------------------------------------------------------|
| Find a function by intent                         | `"how requests are authenticated"` + `chunk_type: "function"`         |
| Find where an error is raised                     | `"where ValidationError is thrown"` + `language: "typescript"`       |
| Find configuration / env handling                 | `"environment variables read at startup"` + `chunk_type: "function"` |
| Find tests for a module                           | `"tests for invoice creation"` + `module: "server/src/modules/billing"` |
| Find docs explaining a concept                    | `"how rate limiting works"` + `language: "markdown"`                 |
| Find all uses of a small utility                  | `"tracing span wrapper around fetch"` (use `read` to expand each hit)|

### When to use semantic search

- Before creating any new file, component, hook, utility, type, route, or model
- Finding code by intent/meaning rather than exact text
- Discovering related implementations across modules
- Understanding how a concept is implemented across the codebase
- Finding relevant documentation sections

### Prerequisites (one-time, set up by the user)

- Node.js 20+
- Docker with the Compose v2 plugin (`docker compose version`)
- Ollama running locally on `http://127.0.0.1:11434`
- `curl` on `$PATH`

If this tool errors, suggest the user run `npx codesearch doctor` to confirm
all four are reachable. Do NOT silently fall back to literal grep — surface
the gap so the user knows the engine needs attention.