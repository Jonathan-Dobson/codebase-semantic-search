---
description: "Codebase Semantic Search (MCP + HTTP) — full tool reference for the local vector search engine. MCP is preferred; HTTP is the fallback for clients that can't speak stdio (e.g. raw curl debugging). Use these tools before reading files, grepping, or proposing changes. Duplicate code is a defect."
applyTo: "**"
---

# Codebase Semantic Search (Local Tool)

A local vector search engine indexes the full codebase (whatever is
configured in `.codesearchrc.json`). Use it for **conceptual/meaning-based**
discovery when `grep_search` is too literal.

**Two equivalent interfaces — pick by capability:**

| Interface | When to use | How to invoke |
|-----------|-------------|---------------|
| **MCP (preferred)** | Agent runtime supports stdio MCP (Claude Code, Copilot Chat, OpenCode, Codex) | Runtime spawns `npx -y codebase-semantic-search mcp` on demand; you just call the tools |
| **HTTP (fallback)** | Agent runtime can't speak MCP, or you're debugging with curl | Start `npx codesearch serve` first; call `POST /search`, `/read`, `GET /clip/:id`, etc. |

**Both interfaces query the same Milvus collection, so results are consistent.**
Always prefer MCP when available — it doesn't need a long-running server, it
respects your agent's process boundaries, and it survives multi-project
setups without port collisions. HTTP exists so non-MCP clients (and humans
debugging with curl) have a working path.

## When to use semantic search

- Before creating any new file, component, hook, utility, type, route, or model
- Finding code by intent/meaning rather than exact text
- Discovering related implementations across modules
- Understanding how a concept is implemented across the codebase
- Finding relevant documentation sections

## The four tools (available on both interfaces)

| Tool                    | MCP                                | HTTP                                  |
|-------------------------|------------------------------------|---------------------------------------|
| `codebase_semantic_search` | `tool: codebase_semantic_search`  | `POST /search`                        |
| `codebase_clip`         | `tool: codebase_clip` (id or ids)  | `GET /clip/:id` or `GET\|POST /clips` |
| `codebase_read_file`    | `tool: codebase_read_file`         | `POST /read`                          |
| `codebase_stats`        | `tool: codebase_stats`             | `GET /stats`                          |

Always **search first**, then drill in with the shortcut (clip by id) or
direct read (file slice).

---

## MCP path (preferred)

Agent runtimes (Claude Code, GitHub Copilot Chat, OpenCode, Codex) spawn
the MCP server on demand over stdio. You do **NOT** start it yourself and
do **NOT** shell out to curl for routine queries.

### Run a query

```text
tool:   codebase_semantic_search
input:  { "query": "<natural language description>" }
```

Defaults applied: `top_k: 100` and `min_score_diff: 0.1` (drop anything more
than 10% below the best match). Override with explicit filters:

| filter            | matches against                                | default  | examples                                          |
|-------------------|------------------------------------------------|----------|---------------------------------------------------|
| `top_k`           | number of candidates requested from Milvus     | `100`    | `5` for "give me the top 5"                       |
| `module`          | first path segment under the workspace root    | —        | values depend on the project layout              |
| `language`        | file language                                  | —        | `typescript`, `tsx`, `javascript`, `markdown`, `json`, `yaml`, `python` |
| `chunk_type`      | AST node type (TS/JS) or section kind (md)     | —        | `function`, `class`, `interface`, `section`, `block` |
| `min_score`       | absolute cosine-similarity cutoff (0..1)       | —        | `0.7` for "strong matches only" (mutually exclusive with `min_score_diff`) |
| `min_score_diff`  | relative cutoff from best hit (0..1)           | `0.1`    | `0.05` strict, `0.3` lenient                      |
| `include`         | opt-in metadata fields on each hit             | —        | `["chunkType", "module", "language"]`             |
| `format`          | response format                                | `"markdown"` | `"json"` for structured response             |

### Score bands

- **0.75+** — strong, relevant matches; safe to act on
- **0.55–0.75** — worth reviewing; context may help disambiguate
- **< 0.55** — likely noise; widen the query or add filters instead of lowering the threshold

### Read the results

Each hit carries a short numeric **`id`** alongside `filePath` / `startLine` / `endLine`. Use `codebase_clip` for the shortcut; use `codebase_read_file` when you want to widen the window.

| field                | meaning                                                                       |
|----------------------|-------------------------------------------------------------------------------|
| `id`                 | Short numeric handle (e.g. `42`). Pass to `codebase_clip` to fetch the text   |
| `score`              | 0..1 cosine similarity. ≥0.75 = strong, 0.55–0.75 = review, <0.55 = noise     |
| `filePath`           | Path relative to workspace root                                               |
| `symbolName`         | Function/class/interface name when the chunk is a symbol; `null` otherwise    |
| `startLine`/`endLine`| 1-indexed inclusive line range in `filePath`                                   |
| `content`            | The chunk text itself — read THIS before opening the whole file               |

**Response is markdown by default** — a single `# Search: "..."` doc with fenced code blocks and metadata captions. Pass `format: "json"` for the structured response (default per-hit fields are `id`, `filePath`, `symbolName`, `score`, `startLine`, `endLine`, `content`; pass `include: [...]` for metadata).

### Two ways to fetch the full text

**A. Shortcut — fetch by `id`** (recommended for the common case):

```text
// single
tool:   codebase_clip
input:  { "id": 42 }

// batch (one tool call, many ids)
tool:   codebase_clip
input:  { "ids": [42, 17, 99] }
```

**B. Direct — fetch by file path + line range** (use to expand context, e.g. `startLine - 5` to `endLine + 5`):

```text
tool:   codebase_read_file
input:  { "filePath": "src/...", "startLine": 38, "endLine": 95 }
```

**Limits:** 500 lines per call (chain reads to paginate), 25 MB per file. `filePath` is relative to the workspace root; absolute paths and `../` escapes are rejected. Ids are per-process and ephemeral (FIFO eviction at 10K entries, cleared on MCP restart — re-run a search to get fresh ids).

### MCP typical workflow

```text
1. codebase_semantic_search(query="<natural language>") → results[] (each has an id)
2a. codebase_clip(ids=[r.id for r in results])           → full text of each
2b. codebase_read_file(filePath=results[0].filePath, …)  → expand context around one
3. Make your edit in the lines you've now seen in full
```

### When the MCP tool errors or returns empty

The local engine may be down. Surface the gap to the user instead of silently falling back to literal `grep_search`:

1. Run `codebase_stats` to confirm whether the indexer is up and how many chunks are loaded.
2. If the index is empty, the user needs to run `npx codesearch index --full` (or `npx codesearch up` if the whole stack isn't bootstrapped yet).
3. If `codebase_stats` errors with a Milvus/Ollama connectivity message, suggest `npx codesearch doctor` — it prints one line per dep with the fix command if anything fails.

Do NOT silently fall back to `grep_search`. The user paid for semantic search; falling back without telling them hides a real defect in their setup.

---

## HTTP path (fallback)

Use HTTP only when your agent runtime can't speak MCP (rare; e.g. raw curl
debugging, CI without MCP support, scripted batch tools). The HTTP API
exposes the same data as MCP — just over `http://localhost:7700` instead
of stdio. **Port override:** if multiple projects coexist on the same
machine, set `SEARCH_PORT` (e.g. `7800`) in `.codesearchrc.json` and use
that port instead.

### Start the server (one-time, by the user — not by you)

```bash
# HTTP server only
npx codesearch serve

# HTTP + file watcher (keeps index fresh as files change)
npx codesearch serve:watch
```

The server blocks in the foreground (Ctrl+C to stop). Milvus keeps running
independently — stop the server without tearing down the index.

### Run a query

```
POST /search
Content-Type: application/json

{
  "query": "<natural language description>"
}
```

Same defaults as MCP: `top_k: 100` and `min_score_diff: 0.1`. Override with
the same filter set (see MCP table above).

### Read the results

Same response shape as MCP — markdown by default, JSON opt-in. The only
envelope difference: HTTP wraps in `{ success, data: { ... } }`.

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
        "filePath": "src/...",
        "symbolName": "...",
        "score": 0.842,
        "startLine": 42,
        "endLine": 80,
        "content": "..."
      }
    ]
  }
}
```

Pass `"format": "json"` to opt into the JSON shape. Pass `"include":
["chunkType", "module", "language"]` to opt in to per-hit metadata fields.

### Two ways to fetch the full text

**A. Shortcut — fetch by `id`** (recommended):

```bash
# single
curl -s http://localhost:7700/clip/42

# batch (small, GET-friendly)
curl -s 'http://localhost:7700/clips?ids=42,17,99'

# batch (large, POST)
curl -s -X POST http://localhost:7700/clips \
  -H "Content-Type: application/json" \
  -d '{"ids":[42,17,99,128,256]}'
```

**B. Direct — fetch by file path + line range**:

```bash
curl -s -X POST http://localhost:7700/read \
  -H "Content-Type: application/json" \
  -d '{"filePath":"src/...","startLine":38,"endLine":95}'
```

**Limits (shared by /read, /clip/:id, /clips):** 500 lines per call, 25 MB
per file. `filePath` is relative to the workspace root; absolute paths and
`../` escapes are rejected with HTTP 403. Ids are per-process and ephemeral
(FIFO eviction at 10K entries, cleared on server restart — re-run `/search`
to get fresh ids).

### HTTP typical workflow

```bash
# 1. search — results carry ids
curl -s http://localhost:7700/search \
  -H "Content-Type: application/json" \
  -d '{"query": "<natural language>"}'

# 2a. shortcut — fetch by id
curl -s http://localhost:7700/clip/42

# 2b. expand context — fetch by file path + adjusted range
curl -s -X POST http://localhost:7700/read \
  -H "Content-Type: application/json" \
  -d '{"filePath": "src/...", "startLine": 38, "endLine": 95}'
```

### Other HTTP endpoints

- `GET /health` — liveness check
- `GET /stats` — collection stats (chunk count, etc.) — mirror of `codebase_stats`

### When the HTTP API errors or returns empty

Same recovery flow as MCP:

1. `GET /stats` to confirm the indexer is up and how many chunks are loaded.
2. If the index is empty, the user needs to run `npx codesearch index --full`.
3. If `/stats` errors with a Milvus/Ollama connectivity message, suggest `npx codesearch doctor`.

---

## Bootstrap (one-time, by the user — not by you)

The MCP server and HTTP API both read from a Milvus collection built by the
`codebase-semantic-search` CLI. The user runs these once per project; you
cannot do them on their behalf because they need Docker, Ollama, and
filesystem access:

```bash
# 1. Install as a dev dependency
npm install --save-dev codebase-semantic-search

# 2. Bootstrap the stack (Milvus + embedding model + initial index + watcher)
#    — idempotent, blocks in the foreground, Ctrl+C to stop the dev loop
npx codesearch up
```

After `up` finishes, the user registers the MCP server with their agent
runtime. **You do not need to do anything special** — your runtime spawns
`npx -y codebase-semantic-search mcp` on demand over stdio when it sees
the `mcpServers` / `servers` entry. (For HTTP, the user runs
`npx codesearch serve` or `serve:watch` to expose the index on port 7700.)

**Agent-runtime registration (one-time):**

```json
// Claude Code — ~/.claude/mcp.json or .mcp.json
{ "mcpServers": { "codebase": { "command": "npx",
    "args": ["-y", "codebase-semantic-search", "mcp"] } } }

// GitHub Copilot Chat — .vscode/mcp.json
{ "servers": { "codebase-semantic-search": { "type": "stdio",
    "command": "npx",
    "args": ["-y", "codebase-semantic-search", "mcp"] } } }

// OpenCode — opencode.json
{ "mcp": { "codebase-semantic-search": { "type": "local",
    "command": ["npx", "-y", "codebase-semantic-search", "mcp"] } } }
```