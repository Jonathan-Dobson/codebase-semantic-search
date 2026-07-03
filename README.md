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
                         │  stdio MCP / HTTP POST /search
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

```
POST /search
Content-Type: application/json

{
  "query": "how does tenant isolation work in mongoose queries",
  "top_k": 10,
  "module": "platform",         // optional filter
  "language": "typescript",     // optional filter
  "chunk_type": "function"      // optional filter
}
```

Other endpoints: `GET /health`, `GET /stats`.

## MCP Server

Spawns a stdio MCP server exposing two tools:

- `codebase_semantic_search` — query the index by meaning
- `codebase_stats` — chunk count and collection name

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

## License

MIT
