## Semantic Search (always run first)

Before reading files, grepping, or proposing changes, run a semantic search
to find existing code by meaning. **Duplicate code is a defect.**

### Run a query

Minimum viable call — just the query:

```text
tool:   codebase_semantic_search
input:  { "query": "<natural language>" }
```

```bash
curl -s http://localhost:7700/search -H "Content-Type: application/json" \
  -d '{"query": "<natural language>"}'
```

Defaults applied: `top_k: 100` and `min_score_diff: 0.1` (drop anything more
than 10% below the best match). To override or add filters:

**Optional filters**: `top_k` (1–100, default 100), `module`, `language`,
`chunk_type`, `min_score` (absolute 0..1 threshold), `min_score_diff`
(0..1 relative threshold — default 0.1; drops hits more than this far
below the best hit). `min_score` and `min_score_diff` are mutually
exclusive — pick one.

### Response format: markdown by default

The default response is a **single markdown document** — `# Search: "..."`
title at the top with a one-line summary (count, `top_k`, `min_score` if
explicit, `min_score_diff` if applied, included fields, clip store size),
then one fenced code block per hit followed by a plain-text caption line
with the file path:line range, symbol name, score, and id. Code is the
primary matter, metadata is the caption beneath it.

Pass `format: "json"` if you need the structured response (programmatic
extraction, downstream tooling that expects JSON). In MCP, the `format`
arg is part of the tool schema; in HTTP, set `"format": "json"` in the
request body.

### Lean by default

Default response per hit: `id`, `filePath`, `symbolName`, `score`,
`startLine`, `endLine`, `content`. The `chunkType`, `module`, `language`
fields are **opt-in** via `include` — they're useful as filter inputs
but largely redundant in the response (derivable from `filePath` and
`content`). Pass `include: ["chunkType", "module", "language"]` (or a
subset) only when you actually need them. (For markdown responses,
`language` is always used for the code-fence hint even when not in the
caption.)

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