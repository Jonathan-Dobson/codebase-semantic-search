# codebase-semantic-search

A local, project-agnostic semantic search engine for any codebase. Drop it
into a project, point it at your source dirs, and any agent (Claude Code,
GitHub Copilot Chat, OpenCode, Codex) or human can query it by meaning rather
than by literal text match.

- **Vector DB:** Milvus Standalone (Docker)
- **Embeddings:** Ollama `nomic-embed-text` (768-dim, local, fast)
- **Chunker:** AST-aware for TS/JS, heading-based for markdown, sliding window for the rest
- **Interfaces:** stdio MCP server (for agents) + HTTP API (for humans)
- **Live updates:** chokidar file watcher with debounced incremental reindex

## Requirements

`codesearch up` shells out to three external things on your machine: Docker,
Ollama, and `curl`. They must already be installed and reachable **before**
you run `up`. The package itself is pure-JS and installs cleanly via npm on
any platform Node 20+ runs on.

| Need | Why | Where |
|---|---|---|
| **Node.js ≥ 20** | The `engines` requirement | any platform |
| **Docker + Compose v2 plugin** (`docker compose …`) | Milvus Standalone stack (Milvus + etcd + MinIO) | uses ~600 MB of images on first pull |
| **Ollama running** on `http://127.0.0.1:11434` | Provides the embedding endpoint. `up` will *throw* if it's not reachable — `up` does **not** auto-install Ollama (system service requires sudo, out of scope for an npm package) | see install notes below |
| **Embedding model** (`nomic-embed-text`, ~270 MB) | `up` **auto-pulls** this once Ollama is running — but the first pull is slow | managed by `up` |
| **`curl` on your `$PATH`** | `up` uses `curl` to probe Ollama | shipped on macOS / Linux; modern Windows too |

**Verify nothing's missing:** `npx codesearch doctor` (works pre-`init`, prints one line per dep with status and the fix command if anything fails).

### Install Ollama (one-time)

| OS | Command |
|---|---|
| macOS | `brew install ollama && brew services start ollama` (or just `ollama serve` in another terminal) |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh`, then `ollama serve` |
| Windows | Install from [ollama.com/download](https://ollama.com/download), then `ollama serve` |

To prefetch the embedding model (optional — `up` will do it for you):

```bash
ollama pull nomic-embed-text
```

### Footprint

This is a chunky tool. Don't `up` it on a half-full laptop without expecting:

- **Disk** — ~600 MB of Docker images + a few GB per project for the Milvus
  index volume (`<project>_milvus_data`). First time is the biggest.
- **Ports (defaults)** — `19530` Milvus gRPC, `9091` Milvus metrics, `9000`/`9001`
  MinIO API/console, `2379` etcd, `7700` HTTP API. All overridable via
  `.codesearchrc.json` or env vars (`MILVUS_PORT`, `SEARCH_PORT`, etc.).
- **First-run time** — ~45s on Apple Silicon (the bundled Milvus image is
  multi-arch, so Apple Silicon gets **native** `linux/arm64` execution — no
  QEMU emulation), plus 30–60s for the initial index build depending on
  codebase size.

### Apple Silicon / ARM64

**Native, not emulated.** The bundled Milvus image (`milvusdb/milvus:v2.5.5`)
publishes a multi-arch manifest with both `linux/amd64` and `linux/arm64`
digests. `codesearch up` automatically forwards your host architecture to
Docker via the `UNAME_M` env var, so an M-series Mac pulls the native arm64
image and Docker runs it directly — no Rosetta, no QEMU. Startup on M1/M2/M3
is roughly the same as on `linux/amd64` (~45s for the stack + index build).

If you'd rather pin the platform yourself (e.g. for CI on a mixed-architecture
runner), set `UNAME_M=linux/amd64` (or `linux/arm64`) in the shell before
running `codesearch up` and the bundled compose will respect it.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│             Agent (Claude Code, Copilot, …)             │
└────────────────────────┬────────────────────────────────┘
                         │  stdio MCP / HTTP POST /search, /read, /clip/:id, /clips
                         ▼
┌─────────────────────────────────────────────────────────┐
│              codesearch (Node.js, TypeScript)            │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │  Watcher    │  │  HTTP API    │  │  MCP Server    │  │
│  │ (chokidar)  │  │  (express)   │  │ (@modelctx/sdk)│  │
│  └──────┬──────┘  └──────┬───────┘  └────────┬───────┘  │
│         └───────────────┼───────────────────┘           │
│                         ▼                                │
│         ┌────────────────────────────┐                   │
│         │  Indexer (mtime-diff)      │                   │
│         └─────────┬──────────────────┘                   │
│                   ▼                                      │
│         ┌────────────────────────────┐                   │
│         │  Milvus Standalone :19530  │                   │
│         └────────────────────────────┘                   │
│                         ▲                                │
│                         │                                │
│         ┌───────────────┴──────────────┐                 │
│         │  Ollama :11434 (embeddings)  │                 │
│         └──────────────────────────────┘                 │
└─────────────────────────────────────────────────────────┘
```

## Quickstart

```bash
# 1. Install as a dev dep
npm install --save-dev codebase-semantic-search

# 2. Confirm the runtime deps (Docker, Ollama, curl) — see "Requirements" above
#    if any check fails. This is one-time; re-running `up` is still idempotent.
npx codesearch doctor

# 3. One-shot bootstrap: init + start Milvus + pull model + initial reindex + start dev loop
npx codesearch up
```

That's it. `up` is idempotent — re-running it skips anything that's already set up. It blocks in the foreground running the HTTP server + file watcher; Ctrl+C to stop the dev loop (Milvus keeps running). To stop Milvus too, run `npx codesearch down`.

> **If `up` fails on first run,** it's almost always a missing dep. Run `npx codesearch doctor` and follow the fix it prints — usually it's "Ollama not running" or "Docker compose stack not up."

### The underlying subcommands

`up` is the recommended entry point, but the granular subcommands are still available for fine-grained control:

```bash
npx codesearch init         # Scaffold .codesearchrc.json + agent file snippets + docker-compose
npx codesearch doctor       # Check Ollama, Milvus, embedding model
npx codesearch index        # Reindex the codebase (incremental by default)
npx codesearch index --full # Drop the collection and rebuild from scratch
npx codesearch serve        # HTTP search server on :7700
npx codesearch watch        # File watcher only (no HTTP)
npx codesearch serve:watch  # HTTP server + watcher in one process
npx codesearch mcp          # stdio MCP server (for agents that speak MCP)
npx codesearch status       # Show collection stats and current config
npx codesearch up           # One-shot bootstrap (init + Milvus + index + dev loop)
npx codesearch down         # Stop Milvus (volumes preserved — index survives)
```

The `init` command drops:
- `.codesearchrc.json` — project-specific config
- `docker-compose.search.yml` — Milvus + etcd + MinIO
- A `## Semantic Search (always run first)` block appended to every `.github/agents/*.agent.md` (with marker comments so re-runs are idempotent)
- A `## 1.1 Codebase Semantic Search` section in `.github/copilot-instructions.md` (created if missing)

### Running multiple codebases in parallel

Docker container names are auto-namespaced by the compose project, so two projects no longer collide. To run two stacks side-by-side on the same machine, give the second one a port offset:

```bash
# In project A (default ports)
npx codesearch up

# In project B
npx codesearch up --port=19531 --search-port=7800
```

`up` forwards the offset to `init` (if `.codesearchrc.json` is missing) and sets the matching env vars on the `docker compose` invocation. Each project gets its own Milvus data volume (`<project>_milvus_data`), so indexes don't share or overwrite.

## CLI

| Command | What it does |
|---|---|
| `codesearch init` | Scaffold config + agent file snippets + docker-compose |
| `codesearch init --port=19531` | Same, with a Milvus port offset for running multiple codebases in parallel |
| `codesearch init --search-port=7800` | Same, with a custom HTTP API port |
| `codesearch up` | One-shot bootstrap: init (if needed) → Milvus → Ollama model → index (if empty) → dev loop. Idempotent. |
| `codesearch up --port=19531` | Same, with a Milvus port offset |
| `codesearch up --no-index` | Same, but skip the initial reindex |
| `codesearch up --no-serve` | Same, but stop after bootstrap (no dev loop) |
| `codesearch down` | Stop Milvus (volumes preserved — index survives) |
| `codesearch doctor` | Check Ollama, Milvus, embedding model availability |
| `codesearch index` | Reindex the codebase (incremental by default) |
| `codesearch index --full` | Drop the collection and rebuild from scratch |
| `codesearch index --dry-run` | Show what would change without writing |
| `codesearch serve` | HTTP search server on `:7700` |
| `codesearch watch` | File watcher only (no HTTP) |
| `codesearch serve:watch` | HTTP server + watcher in one process |
| `codesearch mcp` | stdio MCP server |
| `codesearch status` | Show collection stats and current config |

All config is overridable via `.codesearchrc.json` or env vars
(`OLLAMA_HOST`, `MILVUS_HOST`, `MILVUS_PORT`, `EMBEDDING_MODEL`,
`SEARCH_PORT`).

## HTTP API

Base URL: `http://localhost:7700` (port overridable via `SEARCH_PORT`).

### `POST /search` — semantic search by meaning

```
POST /search
Content-Type: application/json

{
  "query": "how does tenant isolation work in mongoose queries",
  "top_k": 10,
  "module": "platform",         // optional filter
  "language": "typescript",     // optional filter
  "chunk_type": "function",     // optional filter
  "min_score": 0.7,             // optional quality threshold (0..1)
  "include": ["chunkType", "module", "language"]  // optional opt-in metadata
}
```

**Default response is lean** — each hit carries only the always-useful
fields: `id`, `filePath`, `symbolName`, `score`, `startLine`, `endLine`,
`content`. The `chunkType`, `module`, `language` fields are **opt-in** via
`include` (see below) — they're useful as filter inputs but largely
redundant in the response (you can derive them from `filePath` and
`content`).

Response: `{ success, data: { query, results: [{ id, filePath, symbolName, score, startLine, endLine, content, ...optional includes }], count, topK, clipStoreSize, minScore?, candidatesBeforeFilter?, includedFields? } }`.

- `score` is 0..1 cosine similarity — ≥0.75 = strong, 0.55–0.75 = review,
  <0.55 = likely noise.
- `id` is a **short numeric handle** assigned at search time. Pass it to
  `GET /clip/:id` (or `/clips`) to fetch the full text without re-encoding
  the path + line range.
- `clipStoreSize` reports the current in-memory clip-store size.
- `minScore` and `candidatesBeforeFilter` are echoed only when `min_score`
  was supplied.
- `includedFields` is echoed only when `include` was supplied.

#### `include` — opt-in metadata fields

```jsonc
{
  "include": ["chunkType", "module", "language"]  // any subset
}
```

Allowed values: `"chunkType"`, `"module"`, `"language"`. Unknown value or
wrong type (e.g. a string instead of an array) returns HTTP 400 with the
allowed list. Omit or pass `[]` for the lean default.

#### `min_score` semantics

Quality filter applied **after** the vector search. The engine asks Milvus
for `top_k` candidates, then drops anything below `min_score`. So the
response may contain fewer than `top_k` results — that's by design (you
asked for "up to `top_k` results that score ≥ `min_score`"). Bump `top_k`
(e.g. 30) if you need a guaranteed minimum count of qualifying hits.

Recommended bands:
- **0.75+** — strong, relevant matches; safe to act on.
- **0.55–0.75** — worth reviewing; context may help disambiguate.
- **< 0.55** — likely noise; widen the query or add filters instead of
  lowering the threshold.

Validation: `min_score` must be a finite number in `[0, 1]`. Out-of-range
or non-numeric values return HTTP 400.

### `GET /clip/:id` — fetch one clip by its short id

```
GET /clip/42
```

Returns: `{ success, data: { id, filePath, startLine, endLine, totalLines, content } }`.

The id is assigned by `/search`. The underlying `(filePath, startLine,
endLine)` is stored in an in-memory table keyed by id. Use this when you
want the chunk back exactly as the search returned it.

### `GET /clips?ids=1,2,3` — batch fetch (small batches, curl-friendly)

```
GET /clips?ids=42,17,99
```

Accepts both `?ids=1,2,3` (comma-separated) and `?ids=1&ids=2&ids=3`
(repeated param). Max 500 ids per request.

### `POST /clips` — batch fetch (large batches)

```
POST /clips
Content-Type: application/json

{ "ids": [42, 17, 99, 128, 256] }
```

Same batch cap (500 ids). Use this when the query-string approach gets
unwieldy.

**Batch response shape** (both GET and POST):

```json
{
  "success": true,
  "data": {
    "results": [
      { "id": 42, "success": true,  "filePath": "...", "startLine": 1, "endLine": 50, "totalLines": 191, "content": "..." },
      { "id": 99, "success": false, "error": "id not found or expired. Re-run /search to get a fresh id." }
    ],
    "requested": 2,
    "succeeded": 1,
    "failed": 1,
    "clipStoreSize": 142
  }
}
```

Per-item errors do NOT abort the batch — one bad id returns
`success: false` in its slot, the rest proceed.

### `POST /read` — fetch a file slice by raw line range

Use this when you want to expand a chunk's context (e.g. `startLine - 5` to
`endLine + 5` to see the surrounding function/class). Semantics match
`sed -n '<start>,<end>p' <filePath>`.

```
POST /read
Content-Type: application/json

{
  "filePath": "server/src/modules/billing/routes.ts",
  "startLine": 42,
  "endLine": 95
}
```

Response: `{ success, data: { filePath, startLine, endLine, totalLines, rangeRequested, content } }`.

**Limits shared by `/read`, `/clip/:id`, `/clips`:**

- **Range cap:** 500 lines per call. Chain reads to paginate larger ranges.
- **File size cap:** 25 MB (HTTP 413 if exceeded). Protects against OOM
  when an agent points at a huge generated file.
- **Path safety:** `filePath` is resolved relative to the workspace root.
  Absolute paths and `../` escapes are rejected with HTTP 403.
- **Not found:** HTTP 404.

### Clip store: how ids work

The clip store is a per-process, in-memory `Map<id, {filePath, startLine, endLine}>`:

- **Auto-increment numeric ids** (1, 2, 3, …). Short — easier to log,
  curl, and pass through agent context than encoded base64.
- **Dedup** on `(filePath, startLine, endLine)` — the same chunk always
  returns the same id across searches.
- **FIFO eviction at 10K entries** — once full, the oldest inserted id is
  dropped to make room. Long-idle ids may return 404 ("not found or expired").
- **Ephemeral** — server restart clears the table. Agents mid-session can
  just re-search; no data loss.
- **Per-process** — the MCP server has its own table; an HTTP `/search`
  id is not resolvable by an MCP `codebase_clip` call (they're separate
  processes). Run a search in the same process that will resolve the ids.

### Typical workflow

```bash
# 1. search — results carry ids
curl -s http://localhost:7700/search -H "Content-Type: application/json" \
  -d '{"query": "how invoices are created", "chunk_type": "function"}'

# 2a. shortcut — fetch by id (recommended for the common case)
curl -s http://localhost:7700/clip/42

# 2b. expand context — fetch by raw filePath + adjusted range
curl -s -X POST http://localhost:7700/read -H "Content-Type: application/json" \
  -d '{"filePath": "server/src/modules/billing/routes.ts", "startLine": 38, "endLine": 95}'
```

### Other endpoints

`GET /health` — liveness check. `GET /stats` — collection stats (chunk count, etc.).

## MCP Server

Spawns a stdio MCP server exposing four tools:

- `codebase_semantic_search` — query the index by meaning. Args:
  `query` (natural language), `top_k` (1–50, default 10), `module`,
  `language`, `chunk_type`, `min_score` (optional filters; `min_score`
  drops hits below the cosine-similarity threshold after the vector
  search), `include` (opt-in metadata fields to add to each result).
  Default response is lean: `id`, `filePath`, `symbolName`, `score`,
  `startLine`, `endLine`, `content`. Pass `include: ["chunkType",
  "module", "language"]` (any subset) to opt in to the metadata fields.
  When `min_score` is set, response also includes `minScore` and
  `candidatesBeforeFilter`. When `include` is set, response also
  includes `includedFields`.
- `codebase_clip` — fetch a clip by its short numeric id from the
  in-memory store. Args: EITHER `id: number` (single) OR `ids: number[]`
  (batch). Ids are assigned by `codebase_semantic_search` and are valid
  for the lifetime of this MCP process (FIFO evict at 10K entries;
  cleared on restart).
- `codebase_read_file` — fetch a slice of a file by line range
  (`sed -n '<start>,<end>p'` semantics). Args: `filePath` (relative to
  workspace root), `startLine` (1-indexed inclusive), `endLine`
  (1-indexed inclusive). 500 lines per call, 25 MB file cap. Use it to
  expand the context around a hit returned by `codebase_semantic_search`
  without re-loading the whole file.
- `codebase_stats` — chunk count, collection name, embedding model.

Typical workflow:

```text
1. codebase_semantic_search(query="how invoices are created")          → results[] (each has an id)
2a. codebase_clip(ids=[r.id for r in results])                        → full text of each
2b. codebase_read_file(filePath=results[0].filePath, startLine=…, endLine=…)  // expand context around one
3. make your edit in the lines you've now seen in full
```

Register it with your agent runtime:

**Claude Code** (`~/.claude/mcp.json` or per-project `.mcp.json`):
```json
{
  "mcpServers": {
    "codebase": {
      "command": "npx",
      "args": ["-y", "codebase-semantic-search", "mcp"]
    }
  }
}
```

**GitHub Copilot Chat** (`.vscode/mcp.json`):
```json
{
  "servers": {
    "codebase-semantic-search": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "codebase-semantic-search", "mcp"]
    }
  }
}
```

## Project Layout

```
codebase-semantic-search/
├── package.json             # name: codebase-semantic-search, bin: codesearch
├── docker-compose.search.yml
├── src/
│   ├── cli.ts               # entry: commander dispatch
│   ├── config.ts            # loads .codesearchrc.json + env
│   ├── walker.ts            # file system walker + mtime diff
│   ├── chunker.ts           # AST-aware chunker (ts-morph)
│   ├── embedder.ts          # Ollama client
│   ├── milvus.ts            # Milvus client (create/upsert/search/delete)
│   ├── search-server.ts     # Express HTTP API
│   ├── watcher.ts           # Chokidar file watcher
│   ├── mcp-server.ts        # stdio MCP server
│   ├── indexer.ts           # reindex library (used by index + watch)
│   ├── clip-store.ts        # in-memory store of clip refs (FIFO evict)
│   ├── read-clip.ts         # shared file-slice helper (path safety, caps)
│   └── commands/
│       ├── init.ts          # scaffold config + agent files + docker-compose
│       ├── doctor.ts        # prereq check
│       ├── index.ts         # reindex (full or incremental)
│       ├── serve.ts         # HTTP server
│       ├── watch.ts         # file watcher
│       ├── serve-and-watch.ts
│       ├── mcp.ts           # stdio MCP server
│       └── status.ts        # config + stats
└── templates/               # bundled init templates
    ├── codesearchrc.json
    ├── copilot-instructions-section.md
    └── agent-semantic-search-section.md
```

## Why this exists

Grep is literal. Agents reinvent the same utilities because they don't know
they exist. Semantic search by meaning fixes that, but the existing OSS
options (Qdrant Cloud, hosted vector DBs, custom RAG frameworks) all add
infrastructure that doesn't fit a single-dev box.

This package is the local-first version: Milvus in Docker, Ollama for
embeddings, chokidar for live updates, MCP for agent integration. ~10 source
files, no cloud dependencies, ~50ms per query after a warm cache.

## Releasing

This package publishes to npm automatically via GitHub Actions — see
[`.github/workflows/publish.yml`](.github/workflows/publish.yml). The
publish is triggered by pushing a `v*` tag (or via manual dispatch in the
Actions tab).

### To cut a release

1. Bump `version` in `package.json` (`npm version 0.2.0` for stable,
   `npm version 0.2.0-beta.1 --preid=beta` for a pre-release — `npm
   version` also commits and tags for you).
2. Add an entry to `CHANGELOG.md` summarising what's in the cut.
3. Push the commit and tag:
   ```bash
   git push --follow-tags
   ```
4. CI publishes the version to npm — the dist-tag is **auto-derived from
   the version**: `v0.2.0` → `latest`, `v0.2.0-beta.1` → `beta`,
   `v0.2.0-rc.2` → `rc`. A GitHub Release is opened with auto-generated
   release notes.

### CI prerequisites (one-time, on the repo)

The workflow reads an `NPM_TOKEN` secret from the repo's Actions
settings. Generate it on npmjs.com
([npm tokens docs](https://docs.npmjs.com/creating-and-viewing-access-tokens)):
create a **granular access token** scoped to this repository with
`Packages and scopes → Read and write`. Paste the value into
`Settings → Secrets and variables → Actions → New repository secret`
with name `NPM_TOKEN`. After that, releases are unattended.

## License

MIT
