# Changelog

All notable changes to `codebase-semantic-search` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `POST /read` HTTP endpoint — fetch a slice of a file between two
  1-indexed inclusive line numbers. Semantics match
  `sed -n '<start>,<end>p' <filePath>`. Path-traversal safe (resolves
  relative to the workspace root; absolute paths and `../` escapes return
  HTTP 403). Hard cap of 500 lines per call; chain reads to paginate
  larger ranges using the `totalLines` field in the response. Returns
  `{ filePath, startLine, endLine, totalLines, rangeRequested, content }`.
- `codebase_read_file` MCP tool — typed mirror of `/read` for MCP clients.
  Same args, same response shape, same guards and limits. Use it to expand
  the context around a chunk returned by `codebase_semantic_search` without
  re-loading the whole file.
- **Short numeric `id` on every search hit.** Each result from
  `POST /search` and the `codebase_semantic_search` MCP tool now carries an
  `id` field — a small auto-increment integer that points at the chunk in
  an in-memory table. The response also includes `clipStoreSize` so callers
  can see how full the store is.
- **`src/clip-store.ts`** — in-memory `Map<id, {filePath, startLine,
  endLine}>`. FIFO eviction at 10K entries, dedup keyed on `(filePath,
  startLine, endLine)` so the same chunk always returns the same id across
  searches. Ephemeral by design: server restart clears the table.
- **`src/read-clip.ts`** — shared file-slice helper used by `/read`,
  `/clip/:id`, `/clips`, and the MCP `codebase_read_file` /
  `codebase_clip` tools. Encapsulates path-safety guard, 25 MB file-size
  cap, 500-line range cap, 1-indexed inclusive line semantics. Returns a
  discriminated union (`{ ok: true, clip } | { ok: false, error }`) so
  every entry point reports errors identically.
- **`GET /clip/:id`** — fetch one clip by its short id. The recommended
  path when the caller just wants the chunk back exactly as the search
  returned it. 200 / 404 (id not found or expired) / 413 (file too large).
- **`GET /clips?ids=1,2,3`** — batch fetch via comma-separated or repeated
  query param. Curl-friendly, GET-cacheable, max 500 ids per request.
- **`POST /clips { ids: [...] }`** — batch fetch via JSON body for larger
  batches (no query-string length concerns). Same 500-id cap.
- **`codebase_clip` MCP tool** — typed mirror of `/clip/:id` and
  `/clips`. Args: EITHER `id: number` (single) OR `ids: number[]`
  (batch). Per-id errors reported in `results` so one bad id does not
  abort the batch.
- **25 MB file-size cap on `/read`** (previously no cap). Closes the OOM
  footgun if a caller points at a huge generated file. Same cap applies
  to `/clip/:id`, `/clips`, and both MCP `codebase_read_file` /
  `codebase_clip`.
- **`min_score` parameter on `POST /search` and `codebase_semantic_search`** —
  quality filter applied after the vector search. Drops any hit with
  cosine-similarity below the threshold. Must be a finite number in
  `[0, 1]`; out-of-range or non-numeric values return HTTP 400 / MCP
  `isError`. When set, the response echoes `minScore` and
  `candidatesBeforeFilter` so callers can see how aggressive the filter
  was. Recommended bands: ≥0.75 = strong, 0.55–0.75 = review, <0.55 = noise.

### Changed
- README `HTTP API` section now documents `/search`, `/read`, `/clip/:id`,
  and `/clips` (GET + POST) with response shapes, field glossary, score
  interpretation, and the typical search→clip→edit workflow. MCP server
  section documents all four tools.
- Agent and Copilot instruction snippets (`templates/*.md`) substantially
  enriched: full field reference table, score interpretation bands
  (≥0.75 strong / 0.55–0.75 review / <0.55 noise), query-crafting
  guidance, concrete recipes, the search→clip and search→read workflows,
  and a clear "which to pick" table. New projects scaffolded by
  `codesearch init` get the full guidance automatically; existing projects
  need to delete the `<!-- BEGIN:codesearch -->` markers in their agent
  files and re-run `init` to refresh.
- `codebase_read_file` MCP tool refactored to use the shared
  `readFileSlice` helper. Behavior unchanged from the caller's view.

### Notes
- The clip store is **per-process**. An id assigned by the HTTP server is
  not resolvable by the MCP server (they're separate processes). Run a
  search in the same process that will resolve the ids.
- The clip store is **ephemeral**. Server restart clears the table. Agents
  that get "id not found or expired" should just re-run the search — the
  underlying files haven't changed.
- No new dependencies. No env var changes. No breaking changes to
  existing endpoints or tool schemas. `/search`, `/stats`, `/health`,
  and the `codebase_semantic_search` / `codebase_stats` MCP tools are
  unchanged.

## [0.1.0-beta.1] - 2026-07-04

### Added
- First npm release. Published under the `beta` dist-tag. Note: npmjs.org
  auto-sets `latest` to the only published version, so until a stable
  release is promoted via `npm dist-tag add codebase-semantic-search@<stable> latest`,
  every install path (including `npm install codebase-semantic-search`,
  `npm install @beta`, and `npx -y codebase-semantic-search`) resolves to
  this beta. The version string `0.1.0-beta.1` is the load-bearing signal
  that this is pre-release code — read this CHANGELOG before installing.
- `codesearch init` — scaffolds `.codesearchrc.json`, `docker-compose.search.yml`,
  and agent/Copilot snippets in any project. Idempotent.
- `codesearch up` — one-shot bootstrap: init-if-needed → start Milvus →
  pull Ollama `nomic-embed-text` → reindex if empty → start the dev loop
  (HTTP `:7700` + file watcher). Idempotent; safe to re-run.
- `codesearch down` — stops the Milvus stack; data volumes preserved.
- `codesearch doctor` — pre-flight check for the runtime deps (Docker
  Compose v2, Ollama, the embedding model, `curl`). Works pre-`init`.
- `codesearch index` (incremental), `index --full` (drop + rebuild),
  `index --dry-run` (report only).
- `codesearch serve`, `watch`, `serve:watch` — HTTP API + file-watcher controls.
- `codesearch mcp` — stdio MCP server exposing `codebase_semantic_search`
  and `codebase_stats` to MCP-compatible agents (Claude Code, Copilot Chat,
  OpenCode, Codex, …).
- `codesearch status` — current config and chunk count.
- **Multi-arch support** via Milvus `v2.5.5` (linux/amd64 + linux/arm64 in
  one manifest). `up` forwards the host arch via the `UNAME_M` env var, so
  Apple Silicon runs natively instead of under QEMU emulation. Override with
  `UNAME_M=linux/amd64` (or `linux/arm64`) before `up` to pin explicitly.
- **Multi-project isolation** via `--port=<N>` / `--search-port=<N>`.
  Each project gets its own Milvus data volume (`<project>_milvus_data`),
  so several codebases can coexist on the same machine without colliding.

### Changed
- README restructured: a `## Requirements` block is now the second thing in
  the doc (Node 20+, Docker Compose v2, Ollama, embedding model, `curl`,
  per-OS install snippets, footprint table, Apple Silicon note). The
  Quickstart now includes `npx codesearch doctor` as step 2, so deps are
  verified before `up` tries to use them.
- Agent and Copilot instruction snippets now reference the README's
  Requirements section and tell agents NOT to silently fall back to literal
  `grep_search` when the engine is unreachable.

### Notes
- No native modules, no install scripts. The npm install is platform-clean.
- All config is overridable via `.codesearchrc.json` or env vars
  (`OLLAMA_HOST`, `MILVUS_HOST`, `MILVUS_PORT`, `EMBEDDING_MODEL`,
  `SEARCH_PORT`).
- See `README.md` § Requirements for the full dep list, install commands,
  and footprint table.
