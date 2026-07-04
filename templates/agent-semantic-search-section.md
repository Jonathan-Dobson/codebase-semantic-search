## Semantic Search (always run first)

Before reading files, grepping, or proposing changes, run a semantic search
to find existing code by meaning. **Duplicate code is a defect.**

### Run a query

**Preferred — MCP tool `codebase_semantic_search`** (typed, no JSON wrangling):

```text
tool:   codebase_semantic_search
input:  { "query": "<natural language>", "top_k": 10 }
```

**Fallback — HTTP** (when MCP isn't registered for this client):

```bash
curl -s http://localhost:7700/search -H "Content-Type: application/json" \
  -d '{"query": "<natural language>", "top_k": 10}'
```

Optional filters: `module` (first path segment under the workspace root),
`language` (typescript, tsx, javascript, markdown, json, yaml, terraform,
python, …), `chunk_type` (function, class, interface, section, block),
`min_score` (0..1 cosine-similarity threshold; drops lower-scoring hits
AFTER the vector search — you may get fewer than `top_k` results, bump
`top_k` if you need a guaranteed count). Combine filters with `query` to
narrow fast.

### Response is lean by default

Default response per hit: `id`, `filePath`, `symbolName`, `score`,
`startLine`, `endLine`, `content`. The `chunkType`, `module`, `language`
fields are **opt-in** via `include` — they're useful as filter inputs
but largely redundant in the response (derivable from `filePath` and
`content`). Pass `include: ["chunkType", "module", "language"]` (or a
subset) only when you actually need them.

### Read the results

Each hit carries a short numeric **`id`** alongside `filePath`/`startLine`/
`endLine`. Use the `id` for the shortcut workflow below; use the raw fields
when you want to construct a different range.

| field                | meaning                                                                       |
|----------------------|-------------------------------------------------------------------------------|
| `id`                 | Short numeric handle (e.g. `42`). Pass to `codebase_clip` to fetch the text  |
| `score`              | 0..1 cosine similarity. ≥0.75 = strong, 0.55–0.75 = review, <0.55 = noise    |
| `filePath`           | Path relative to workspace root                                              |
| `symbolName`         | Function/class/interface name when the chunk is a symbol; `null` otherwise   |
| `startLine`/`endLine`| 1-indexed inclusive line range in `filePath`                                  |
| `content`            | The chunk text itself — read THIS before opening the whole file              |

Opt-in (request `include: [...]` to receive): `chunkType`, `module`,
`language`. Useful as filter inputs but redundant in the response.

### Two ways to fetch the full text

**A. Shortcut — fetch by `id` (recommended when you just want the chunk back as-is):**

```text
// MCP
tool:   codebase_clip
input:  { "id": 42 }

// or batch:
input:  { "ids": [42, 17, 99] }

// HTTP single
curl -s http://localhost:7700/clip/42

// HTTP batch (small, GET-friendly)
curl -s 'http://localhost:7700/clips?ids=42,17,99'

// HTTP batch (large, POST)
curl -s -X POST http://localhost:7700/clips \
  -H "Content-Type: application/json" \
  -d '{"ids":[42,17,99,128,256]}'
```

Returns `{ id, filePath, startLine, endLine, totalLines, content }`. Per-id
errors are reported in `results` (batch) so one bad id does not abort the
rest. **The id store is in-memory and ephemeral** — server restart clears
it, and the oldest id may be evicted under load (FIFO at 10K entries). If
you get "id not found or expired", re-run the search.

**B. Direct — fetch by file path + line range** (use when you want to
expand the chunk's context, e.g. `startLine - 5` to `endLine + 5`):

```text
// MCP
tool:   codebase_read_file
input:  { "filePath": "src/auth/login.ts", "startLine": 38, "endLine": 95 }

// HTTP
curl -s -X POST http://localhost:7700/read \
  -H "Content-Type: application/json" \
  -d '{"filePath":"src/auth/login.ts","startLine":38,"endLine":95}'
```

Returns `{ filePath, startLine, endLine, totalLines, content }`. Hard cap:
500 lines per call — chain reads to paginate. 25 MB per-file cap.

### Query crafting

- Be specific. `"tenant isolation in mongoose queries"` beats `"mongoose"`.
- Add intent: `"how does X…"`, `"where is Y handled…"`, `"what validates Z…"`.
- Filter to narrow: `module: "platform"` + `chunk_type: "function"` cuts noise fast.
- If 0 results, drop filters, then try synonyms (`auth` ↔ `authentication`
  ↔ `login` ↔ `signin`).
- If results are noisy, narrow the query with a concrete noun from the
  domain (a schema field, an HTTP route, an error class).

### When this tool errors or returns empty

The local engine may be down. Suggest the user run `npx codesearch doctor`
to verify Docker + Ollama are reachable; the package README's "Requirements"
section lists what's needed. Do NOT silently fall back to literal
`grep_search` — surface the gap so the user knows the engine needs attention.