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

# 2. Scaffold project config + agent file snippets + docker-compose
npx codesearch init

# 3. Start the vector DB
docker compose -f docker-compose.search.yml up -d

# 4. Make sure Ollama is running and the embedding model is pulled
ollama pull nomic-embed-text

# 5. Bootstrap the index
npx codesearch index --full

# 6. Start the dev loop (HTTP API + file watcher)
npx codesearch serve:watch

# OR run the MCP server for agents that speak MCP
npx codesearch mcp
```

The `init` command drops:
- `.codesearchrc.json` — project-specific config
- `docker-compose.search.yml` — Milvus + etcd + MinIO
- A `## Semantic Search (always run first)` block appended to every `.github/agents/*.agent.md` (with marker comments so re-runs are idempotent)
- A `## 1.1 Codebase Semantic Search` section in `.github/copilot-instructions.md` (created if missing)

## CLI

| Command | What it does |
|---|---|
| `codesearch init` | Scaffold config + agent file snippets + docker-compose |
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
