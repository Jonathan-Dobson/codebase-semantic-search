## Semantic Search (always run first)

Before reading files, grepping, or proposing changes, run a semantic search
to find existing code by meaning. **Duplicate code is a defect.**

### How you talk to this engine

You have **four tools** exposed by a stdio MCP server. The user's agent
runtime spawns the server on demand — you do **not** start it yourself, and
you do **not** shell out to `curl` for routine queries.

| Tool                    | What it returns                                                        |
|-------------------------|------------------------------------------------------------------------|
| `codebase_semantic_search` | Ranked code chunks matching a natural-language query                |
| `codebase_clip`         | The full text of one or more chunks, by their short numeric `id`        |
| `codebase_read_file`    | A raw file slice by line range (`sed -n 'A,Bp'` semantics)             |
| `codebase_stats`        | Chunk count, collection name, embedding model — use it to confirm the indexer has caught up |

Always **search first**, then drill in with `codebase_clip` (shortcut) or
`codebase_read_file` (expanded context).

### Run a query

```text
tool:   codebase_semantic_search
input:  { "query": "how tenant isolation works in mongoose queries" }
```

Defaults applied: `top_k: 100` and `min_score_diff: 0.1` (drop anything more
than 10% below the best match). To override or add filters:

| filter            | purpose                                                              |
|-------------------|----------------------------------------------------------------------|
| `top_k`           | Candidate pool size from Milvus (1–100, default 100)                  |
| `module`          | First path segment under the workspace root — `src`, `docs`, etc.    |
| `language`        | `typescript`, `tsx`, `javascript`, `markdown`, `json`, `python`, …   |
| `chunk_type`      | AST node type (TS/JS) or section kind (md): `function`, `class`, `interface`, `section`, `block` |
| `min_score`       | Absolute cosine-similarity cutoff in `[0, 1]` (mutually exclusive with `min_score_diff`) |
| `min_score_diff`  | Relative cutoff: drop hits more than this far below the best hit (default `0.1`) |
| `include`         | Opt-in metadata fields on each hit: any subset of `["chunkType", "module", "language"]` |
| `format`          | `"markdown"` (default, single doc with fenced code) or `"json"` (structured) |

### Read the results

Each hit carries a short numeric **`id`** alongside `filePath`/`startLine`/
`endLine`. Use `codebase_clip` for the shortcut; use `codebase_read_file`
when you want to widen the window (e.g. `startLine - 5` to `endLine + 5`).

| field                | meaning                                                                       |
|----------------------|-------------------------------------------------------------------------------|
| `id`                 | Short numeric handle (e.g. `42`). Pass to `codebase_clip` to fetch the text  |
| `score`              | 0..1 cosine similarity. ≥0.75 = strong, 0.55–0.75 = review, <0.55 = noise    |
| `filePath`           | Path relative to workspace root                                              |
| `symbolName`         | Function/class/interface name when the chunk is a symbol; `null` otherwise   |
| `startLine`/`endLine`| 1-indexed inclusive line range in `filePath`                                  |
| `content`            | The chunk text itself — read THIS before opening the whole file              |

### Response format: markdown by default

Default response is a **single markdown document** — `# Search: "..."` title
at the top with a one-line summary (count, `top_k`, `min_score` if
explicit, `min_score_diff` if applied, included fields, clip store size),
then one fenced code block per hit followed by a plain-text caption line
(file path:line range, symbol, score, id). Code is the primary matter;
metadata is the caption beneath it.

Pass `format: "json"` only if you need the structured response (programmatic
extraction or downstream tooling that expects JSON). The lean per-hit
fields are `id`, `filePath`, `symbolName`, `score`, `startLine`, `endLine`,
`content`; the metadata fields are opt-in via `include`.

### Two ways to fetch the full text

**A. Shortcut — fetch by `id` (recommended when you just want the chunk back as-is):**

```text
// single
tool:   codebase_clip
input:  { "id": 42 }

// batch (one call, many ids)
tool:   codebase_clip
input:  { "ids": [42, 17, 99] }
```

Returns `{ id, filePath, startLine, endLine, totalLines, content }`. Per-id
errors are reported in `results` (batch) so one bad id does not abort the
rest. **The id store is in-memory and ephemeral** — server restart clears
it (FIFO eviction at 10K entries). If you get "id not found or expired",
re-run the search.

**B. Direct — fetch by file path + line range** (use when you want to
expand the chunk's context, e.g. `startLine - 5` to `endLine + 5`):

```text
tool:   codebase_read_file
input:  {
  "filePath": "src/auth/login.ts",
  "startLine": 38,
  "endLine": 95
}
```

Returns `{ filePath, startLine, endLine, totalLines, content }`. Hard cap:
500 lines per call — chain reads to paginate. 25 MB per-file cap. Path
safety: `filePath` is relative to the workspace root; absolute paths and
`../` escapes are rejected.

### Typical workflow

```text
1. codebase_semantic_search(query="how invoices are created")          → results[] (each has an id)
2a. codebase_clip(ids=[r.id for r in results])                          → full text of each
2b. codebase_read_file(filePath=results[0].filePath, startLine=…, endLine=…)  // expand context around one
3. Make your edit in the lines you've now seen in full
```

### Query crafting

- Be specific. `"tenant isolation in mongoose queries"` beats `"mongoose"`.
- Add intent: `"how does X…"`, `"where is Y handled…"`, `"what validates Z…"`.
- Filter to narrow: `module: "platform"` + `chunk_type: "function"` cuts noise fast.
- If 0 results, drop filters, then try synonyms (`auth` ↔ `authentication`
  ↔ `login` ↔ `signin`).
- If results are noisy, narrow the query with a concrete noun from the
  domain (a schema field, an HTTP route, an error class).

### When this tool errors or returns empty

The local engine may be down. Surface the gap to the user instead of
silently falling back to literal `grep_search`:

1. Run `codebase_stats` to confirm whether the indexer is up and how many
   chunks are loaded.
2. If the index is empty, the user needs to run `npx codesearch index --full`
   (or `npx codesearch up` if the whole stack isn't bootstrapped yet).
3. If `codebase_stats` errors with a Milvus/Ollama connectivity message,
   suggest `npx codesearch doctor` — it prints one line per dep with the
   fix command if anything fails.

Do NOT silently fall back to `grep_search`. The user paid for semantic
search; falling back without telling them hides a real defect in their
setup.

### Bootstrap (one-time, by the user — not by you)

The MCP server reads from a Milvus collection that's built by the
`codebase-semantic-search` CLI. **The user** runs these once per project;
you cannot do them on their behalf because they need Docker, Ollama, and
filesystem access:

```bash
# 1. Install as a dev dependency
npm install --save-dev codebase-semantic-search

# 2. Bootstrap the stack (Milvus + embedding model + initial index + watcher)
#    — idempotent, blocks in the foreground, Ctrl+C to stop the dev loop
npx codesearch up
```

`up` does, in order: writes `.codesearchrc.json` (idempotent) → starts the
Milvus Docker stack (idempotent) → pulls the `nomic-embed-text` embedding
model (idempotent) → runs an initial full reindex if the collection is
empty → starts the file watcher (Ctrl+C stops the watcher; Milvus keeps
running in the background).

After `up` finishes, the user can register the MCP server with their agent
runtime (Claude Code / GitHub Copilot Chat / OpenCode / Codex). The agent
runtime spawns `npx -y codebase-semantic-search mcp` on demand over stdio;
the user does **not** need to run it manually.

### When MCP isn't available — HTTP fallback (humans / curl only)

If your agent runtime cannot speak MCP (rare; e.g. raw curl debugging),
the same index is also exposed as an HTTP API on `http://localhost:7700`
by running `npx codesearch serve` (or `serve:watch` to also keep the
index fresh). The endpoints mirror the MCP tools:

```bash
# Search
curl -s http://localhost:7700/search \
  -H "Content-Type: application/json" \
  -d '{"query": "<natural language>"}'

# Fetch a chunk by id
curl -s http://localhost:7700/clip/42

# Read a file slice
curl -s -X POST http://localhost:7700/read \
  -H "Content-Type: application/json" \
  -d '{"filePath":"src/auth/login.ts","startLine":38,"endLine":95}'
```

Always prefer the MCP tools — they don't need a long-running server, they
respect your agent's process boundaries, and they survive multi-project
setups without port collisions.