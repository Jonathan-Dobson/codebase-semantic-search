# Changelog

All notable changes to `codebase-semantic-search` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
