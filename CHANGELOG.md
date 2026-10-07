# Changelog

All notable changes to `codebase-semantic-search` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Releases publish with npm trusted publishing (OIDC)** instead of an `NPM_TOKEN`
  secret. The token had expired, so the v0.3.0 publish failed with a 404 on the PUT. The
  workflow upgrades npm to 11.5.1 or later, passes no token, checks that the tag matches
  `package.json`, and can be dispatched with an existing tag to publish it again.

## [0.3.0] - 2026-10-07

### Changed
- **`POST /search` refuses unknown fields with a 400.** They used to be dropped
  silently, so a caller who sent `limit` (the field is `top_k`) got 100 results
  and no hint why. The error names each unknown field, suggests the likely one
  for common guesses (`limit`/`k` → `top_k`, `exclude` → `ignore`, camelCase
  forms of the snake_case fields), and lists the accepted fields
  (`src/search-params.ts`). MCP clients already validate arguments against the
  tool's schema.

### Added
- **`ignore` search filter, with a project default (`searchIgnore`).** Searches
  (HTTP `POST /search` and the MCP `codebase_semantic_search` tool) take
  `ignore`, a list of path patterns relative to the project root: `docs/`
  (folder), `*.md` (wildcard), `server/src/__tests__/`. Each becomes
  `not (file_path like "…")` in the Milvus filter, so it's applied inside the
  vector search, and the index is untouched: no reindex to change what's
  ignored. `_` and `%` are escaped, because Milvus `like` treats them as
  wildcards (`src/compo_ents/%` matches `src/components/`).

  `searchIgnore` in `.codesearchrc.json` sets what's left out when a request
  doesn't say; `ignore: []` searches everything. Responses name what was
  ignored (`ignored` / `ignoreSource` in JSON, a summary-line note in
  markdown), so an agent can't silently miss docs it needed.

  Why: indexing prose (`docs/`, `wiki/`) alongside code makes code-mapping
  queries noisy. The existing `module` / `language` filters match one exact value
  each, so there was no way to ask for "everything except docs".
- **X-macro tables (`.macro`) are now collected and chunked per entry.** These
  were missing from the language map, so `walkFiles()` dropped them silently.
  They are not valid C++ — a list of top-level invocations (`TRANSACTION(...)`,
  `TYPED_SFIELD(...)`) consumed by `#include` into a generator — so they cannot
  go through `chunkCpp()`, which finds no declarations in them. `chunkMacro()`
  splits on invocation boundaries by counting paren depth, giving one chunk per
  table row with the entry's doc comment and its macro identifier as
  `symbolName`.

  On the rippled mirror this adds 561 chunks across 5 files (82 transaction
  definitions, 349 serialized fields, 32 ledger entries, 12 granular
  permissions, 81 feature gates). These files are where rippled keeps its
  authoritative tables: `include/xrpl/protocol/detail/transactions.macro` is the
  only place that states which fields each transaction type accepts, and
  `sfields.macro` maps every field to its serialized type and wire code.
  Without them the index cannot answer "which fields does AccountSet accept?",
  which is exactly the question a protocol audit asks. Routing them to the line
  chunker instead would not help — an 800-token window welds ~40 unrelated
  `sfields.macro` rows into one chunk.
- **C/C++ source files are now collected and AST-chunked.** `.cpp .h .hpp .cc
  .cxx .ipp` were missing from the language map, so a C++-heavy tree was almost
  entirely invisible to the indexer — on the rippled mirror, 165 of 2085 files
  (7.9%) were being collected. `chunkCpp()` walks the file with `tree-sitter`
  and `tree-sitter-cpp` and emits one chunk per declaration.
- **The README documents the C++ grammar** as an optional dependency, what the
  line-window fallback costs you, and how to install the grammar explicitly.

### Fixed
- **`tree-sitter@0.21.1` could not read any file over 32,768 bytes.** Its
  `CallbackInput::Read` copies into a fixed `uint16_t` buffer, and the
  `partial_string` continuation path that would read the rest is dead code, so
  a large file produced a truncated parse and an `ERROR` node spanning the
  remainder. The parser is now constructed with an explicit `bufferSize`.
  Measured on the rippled mirror: **0 of 38 oversized files parsed correctly
  before, 38 of 38 after.**
- **Return type was used as the chunk name for C++ functions.** 1,064 of 5,353
  function chunks (19.9%) were named after their return type rather than the
  function, so `preflight1Sponsor` was indexed under `void`. 1,206 chunks were
  renamed; no chunk's content length changed.
- **Native grammars load lazily and degrade instead of throwing.** The C++
  parser is constructed on the first C++ chunk, never at import time. If the
  grammar cannot be loaded, the chunker warns once and falls back to
  line-window chunking for C++ files only; a JS/TS index run never aborts.
  `tree-sitter` and `tree-sitter-cpp` moved from `dependencies` to
  `optionalDependencies` for the same reason — a failed native build no longer
  breaks `npm install` outright.

### Known limitations
- Without the optional grammar, C++ falls back to line windows that cut
  mid-function, so a hit's line range tends to land on a body statement rather
  than a declaration.
- `getFlags` chunk ids are `hash(path:startLine)`. Any change to a file's chunk
  *boundaries* requires `codesearch index --full`; incremental reindex cannot
  move an existing id.

## [0.2.5] - 2026-09-28

### Fixed
- **Incremental reindex left an edited file's old chunks in the collection forever.**
  Chunk ids are `hash(path:startLine)`, so an upsert only replaced a chunk whose start line
  had not moved, and incremental mode deleted chunks only for *removed* files. Any edit that
  shifted a chunk boundary left the old chunk behind. Both `codesearch index` and the watcher
  now delete a changed file's chunks before re-upserting (`pathsToClear`). In one real
  project the collection had grown to ~14k chunks for a tree that chunks to ~7k. A full
  reindex is needed once to purge chunks already left behind.
- **Near-duplicate chunks from long lines.** When a chunk held no more lines than
  `chunkOverlapLines` (long markdown table rows), `chunkByLines` advanced one line at a time
  and re-emitted almost the same text, which tied on score and crowded out other results.
  Overlap is now capped at half the previous chunk, and a window that adds no new line is
  never emitted.
- **A failed embedding was stored as a zero vector**, which has no direction, so its
  similarity to any query is meaningless. It is now skipped, and the skipped chunks are listed.

### Added
- **`indexDirs` entries may name a single file** (e.g. a root `README.md` or `AGENTS.md`).
  Previously a file entry was globbed as a directory and silently matched nothing.
- **Tests** (`npm test`, `node:test` via `tsx`). `CODESEARCH_IT=1 npm test` also runs an
  integration test against a live Milvus + Ollama in a throwaway collection.

## [0.2.4] - 2026-07-04

### Fixed
- **Index state file moved out of `node_modules`** — `stateFile` now
  resolves to `<projectRoot>/.search-index-state.json` instead of
  `node_modules/codebase-semantic-search/.search-index-state.json`.
  Previously, any `npm install` of this package would silently wipe the
  indexer's mtime ledger, which caused `codesearch index` (incremental)
  to fall through to a full reindex of the entire codebase on the next
  run. Symptom: identical batch counts from `index --full` and `index`
  in quick succession, even when no files changed. The state survives
  reinstalls now.

## [0.2.3] - 2026-07-04

### Changed
- **`init` now writes a canonical reference doc + slim pointers**
  instead of duplicating ~200 lines of MCP documentation into every
  agent file. Previously, each `.github/agents/*.agent.md` got the full
  MCP reference inline — for a project with N agents, that meant N
  copies of the same ~200 lines and a real risk of drift if any one
  was edited by hand. Now `init` writes:

  - **`.github/instructions/codebase-semantic-search.instructions.md`**
    — the canonical MCP + HTTP reference (full tool list, defaults,
    response shapes, filters, recovery flow, bootstrap). Auto-loaded
    into every agent context via `applyTo: "**"`. One file, one source
    of truth.
  - **A slim dual-pointer block** appended to every
    `.github/agents/*.agent.md` (marker-bounded so re-runs are
    idempotent). ~20 lines per agent pointing at the canonical doc
    above. With N agents, total bloat is `N × 20 + 1 × ~300` lines
    instead of `N × 200`.
  - **A slim pointer section** in `.github/copilot-instructions.md`
    (created if missing).

- **The canonical doc covers both MCP and HTTP at peer depth**, not
  HTTP-as-an-appendix. Both paths are now documented identically: the
  same four tools (with MCP and HTTP equivalents side by side), the
  same filter set, the same recovery flow (codebase_stats / GET /stats
  → codesearch doctor, never silent grep fallback), the same bootstrap
  (npm install + codesearch up + agent-runtime registration).

- **Per-agent pointer block is now a dual-pointer** — it mentions both
  the MCP path (preferred) and the HTTP path (fallback) so an agent
  knows about both without having to read the canonical doc first.

- **Templates** (`templates/codesearch-instructions.md`,
  `templates/agent-semantic-search-section.md`,
  `templates/copilot-instructions-section.md`) updated to match.

- **README.md** updated: "Agent templates" section explains the
  canonical-doc-plus-slim-pointer design and the bloat math
  (`N × 20 + 1 × ~300` vs `N × 200`). "The init command drops" list
  updated to include the new canonical instruction file.

No code or runtime behavior changes — only docs and template content,
plus a new `init` artifact (the canonical instruction file).

## [0.2.2] - 2026-07-04

### Changed
- **Docs and agent templates rewritten to lead with MCP**, treating HTTP
  as a fallback for humans / curl debugging. Previously the README and
  embedded agent snippets put HTTP and MCP on equal footing, with curl
  examples interspersed throughout — this made it look like agents should
  shell out to curl for routine queries, when in fact MCP is the right
  surface for every agent runtime that supports it.

  - **README.md**: TL;DR at the top now reads "Install + `npx codesearch
    up` + register MCP with agent runtime". The "How it fits together"
    section explicitly labels MCP stdio as **preferred** and HTTP as the
    **fallback**. Agent-runtime registration snippets (Claude Code,
    GitHub Copilot Chat, OpenCode) are now in the Quickstart, not buried
    at the end of the MCP section. HTTP API moved below the MCP section
    and clearly labeled "humans / curl fallback". Added an explicit note
    that MCP users don't need to run `codesearch mcp` themselves — the
    agent runtime spawns it on demand.
  - **`templates/agent-semantic-search-section.md`** (written into
    `.github/agents/*.agent.md` by `init`): the primary "Run a query"
    block now shows only the MCP tool call; curl is moved to a clearly
    labeled "When MCP isn't available — HTTP fallback" appendix. Added
    a "Bootstrap (one-time, by the user — not by you)" section that
    tells the agent exactly what its human needs to do (`npm install`,
    `npx codesearch up`, register the MCP server). Added an "When this
    tool errors or returns empty" recovery flow that directs the agent to
    run `codebase_stats` and surface `codesearch doctor` to the user
    instead of silently falling back to `grep_search`.
  - **`templates/copilot-instructions-section.md`** (written into
    `.github/copilot-instructions.md` by `init`): same MCP-first
    restructure as the agent template, plus the agent-runtime
    registration snippets (Claude Code / Copilot / OpenCode) inline so
    the human running `init` can copy-paste from their own agent file.
  - **`src/commands/init.ts`** "Next steps" output: leads with
    `npx codesearch up` as the recommended path. The previous manual
    sequence (`docker compose up` → `ollama pull` → `index --full` →
    `serve:watch`) is now labeled "Manual steps (only if `up` is not the
    right entry point)". A new "Talking to the index from agents
    (recommended path)" block prints the Claude Code / Copilot
    registration snippets directly to the terminal so the user has them
    in hand before they leave `init`.

## [0.2.1] - 2026-07-04

### Fixed
- **CLI and MCP server version reporting** — both consumers now read
  the version from `package.json` (via the new `src/version.ts` shared
  module) instead of hardcoding `'0.1.0'`. Previously `codesearch --version`
  and the MCP `serverInfo.version` field both reported `0.1.0` even after
  the package was bumped to `0.2.0`; the next bump only needs to touch
  `package.json` now.

First stable release of the 0.2.x series. Consolidates the four
0.2.0-beta.x pre-releases with no API changes since 0.2.0-beta.4.
See the beta entries below for the full change history since 0.1.0.

### Fixed
- **README**: dropped `2379 etcd` from the host port list — etcd is an
  internal Milvus dependency, not exposed to the host in
  `docker-compose.search.yml`. Noted that etcd + MinIO are reachable
  only between containers on the `search-network` bridge.
- **README**: response summary format now mentions `min_score_diff?`
  alongside `min_score?` — both filters echo in the markdown header when
  applied (the default `min_score_diff: 0.1` shows up on most calls).
- **README**: `min_score` guidance no longer says "Bump `top_k` (e.g. 30)"
  — 30 is below the new default of 100. Updated to direct callers to
  tighten the query / use a relative cutoff instead.
- **README**: `codebase_stats` description now lists `embeddingDimensions`
  alongside chunk count / collection name / model (matches the MCP tool
  output).
- **README**: Project Layout now includes `commands/up.ts` and
  `commands/down.ts` (added in 0.2.0-beta.3 but missed from the layout
  diagram).
- **Templates** (both `copilot-instructions-section.md` and
  `agent-semantic-search-section.md`): response summary description
  mentions both `min_score` and `min_score_diff` (each only shows when
  applied). Previously each template named only one of the two.
- **Copilot template**: relative-band recommendation now explicitly says
  the hit count depends on score distribution, not `top_k`. Removed the
  stale `top_k: 10` calibration (the older default was 10).
- **Copilot template**: "Don't widen `top_k` past 20" advice refreshed
  for the new default of 100 — the candidate pool is already maxed at
  the default, so widening isn't an option. Now directs to tighten the
  filter or sharpen the query.

## [0.2.0-beta.4] - 2026-07-04

### Changed
- **Default `top_k` bumped from 30 to 100** on `/search` and
  `codebase_semantic_search`. Returns more candidates before the
  relative filter (`min_score_diff: 0.1`) drops low-relevance hits.
  Max cap raised from 50 to 100 to match. To request fewer results,
  set `top_k` explicitly. Also fixes a stale `Default 10, max 50`
  in the MCP tool's `top_k` description (the runtime default was
  already 30).

## [0.2.0-beta.3] - 2026-07-04

### Changed
- **Default `top_k` bumped from 10 to 30** on `/search` and
  `codebase_semantic_search`. Returns more candidates before the
  relative filter (`min_score_diff: 0.1`) drops low-relevance hits.
  Max cap unchanged at 50. To request fewer results, set `top_k`
  explicitly. Also fixes a latent bug where a stale `top_k = 10`
  default in the request body destructuring was overriding the
  handler's own default fallback.

## [0.2.0-beta.2] - 2026-07-04

Two related changes: a new `min_score_diff` relative quality filter, and
then turning that filter on by default. The new param ships first so
callers can override the default; the default change follows in the same
release because the project's brand-new and has no users to migrate.

### Added
- **`min_score_diff` parameter on `POST /search` and
  `codebase_semantic_search`** — relative quality filter. Decimal in
  `[0, 1]`. Threshold is computed from the best hit in the result set:
  `appliedThreshold = max_score - min_score_diff`. Drops any hit whose
  score is below that. Useful when you don't know the absolute score
  distribution in advance — "everything within 0.1 of the best match"
  is often more meaningful than "everything above 0.7". Mutually
  exclusive with `min_score` — passing both returns HTTP 400 / MCP
  `isError`. When applied, response echoes `minScoreDiff`,
  `appliedThreshold`, `maxScore`, and `candidatesBeforeFilter`.

### Changed (breaking)
- **`min_score_diff: 0.1` is now applied by default** on every
  `/search` and `codebase_semantic_search` call when the caller does
  not supply a quality filter. To disable the default, set
  `min_score_diff: 0` explicitly (keeps only ties with the top hit)
  or `min_score_diff: 1.0` (clamp keeps everything). Supplying
  `min_score` overrides the default; they're still mutually exclusive
  (only when both are explicitly provided). **This is a behavior
  change** for any caller that previously got the raw top-`top_k`
  results without a quality filter — those calls now return only the
  results within 10% of the best match by default.

## [0.2.0-beta.1] - 2026-07-04

Two breaking changes in this release: leaner default `/search` response
(per-hit `chunkType` / `module` / `language` now opt-in via `include`),
and default response format flipped from JSON to markdown (opt back in
via `format: "json"`). Both migrations are mechanical — one extra
parameter per request. No data loss, no semantic changes.

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
- **`include` parameter on `POST /search` and `codebase_semantic_search`** —
  opt-in metadata fields on each result. Default response is now lean
  (omits `chunkType`, `module`, `language`); pass
  `include: ["chunkType", "module", "language"]` (any subset) to opt
  back in. These fields are still useful as filter inputs (`chunk_type`,
  `module`, `language` on the request), they are just no longer echoed
  in every result by default — they can be derived from `filePath` and
  `content`. Allowed values: `"chunkType"`, `"module"`, `"language"`.
  Unknown value or wrong type returns HTTP 400 with the allowed list.
  When `include` is set, response also includes `includedFields`.
- **`format` parameter on `POST /search` and `codebase_semantic_search`** —
  response format selector. Default `"markdown"`, opt-in `"json"` via
  `format: "json"` on the request body / tool args. Markdown response
  is a single document with a `# Search: "..."` title and one-line
  summary at the top, then per-hit fenced code blocks with a plain-text
  caption line beneath each (`filePath:startLine-endLine • symbolName •
  score: N • chunkType • module • id: N`). Code is the primary matter;
  metadata is the caption. `Content-Type: text/markdown; charset=utf-8`.
  The language hint in the code fence is always populated from the
  chunker (server-known), even when `language` is not in the response.
  Hits are separated by `---` (horizontal rule). JSON response is the
  same lean shape as before — opt-in `include` still works there.
  Allowed values: `"markdown"`, `"json"`. Unknown value returns HTTP
  400 with the allowed list. Other endpoints (`/clip/:id`, `/clips`,
  `/read`) remain JSON-only.
- **`src/render-search.ts`** — shared markdown renderer used by both the
  HTTP server and the MCP server so both formats stay in lockstep.

### Changed (breaking)
- **`POST /search` and `codebase_semantic_search` response shape** —
  the per-result fields `chunkType`, `module`, `language` are no longer
  included by default in JSON responses. Default response now contains
  only the always-useful set: `id`, `filePath`, `symbolName`, `score`,
  `startLine`, `endLine`, `content`. **This is a breaking change** for
  any caller that was reading those three fields in the response. To
  restore the old behavior, pass `include: ["chunkType", "module",
  "language"]` on every request. Migration is mechanical: add the
  `include` param to every search call. Documented in README and
  templates; rationale is that those fields are largely redundant in
  the response (derivable from `filePath` / `content`) and were wasting
  tokens on every search.
- **`POST /search` and `codebase_semantic_search` default response format**
  — flipped from JSON to **markdown**. The default response is now a
  single markdown document (`Content-Type: text/markdown; charset=utf-8`)
  with code fences and metadata captions. This is a breaking change for
  any caller that was parsing the JSON response by default. To restore
  the old behavior, pass `format: "json"` on every request. Migration is
  mechanical: add `"format": "json"` to every search body / tool args.
  Documented in README and templates; rationale is that markdown gives
  the code the visual prominence it deserves and parks metadata in the
  gutter, which is more readable for both agents and humans.

### Changed
- README `HTTP API` section now documents `/search`, `/read`, `/clip/:id`,
  and `/clips` (GET + POST) with response shapes, field glossary, score
  interpretation, and the typical search→clip→edit workflow. MCP server
  section documents all four tools and the new `format` parameter.
- Agent and Copilot instruction snippets (`templates/*.md`) substantially
  enriched: full field reference table, score interpretation bands
  (≥0.75 strong / 0.55–0.75 review / <0.55 noise), query-crafting
  guidance, concrete recipes, the search→clip and search→read workflows,
  a clear "which to pick" table, and the markdown default + `format`
  opt-in. New projects scaffolded by `codesearch init` get the full
  guidance automatically; existing projects need to delete the
  `<!-- BEGIN:codesearch -->` markers in their agent files and re-run
  `init` to refresh.
- `codebase_read_file` MCP tool refactored to use the shared
  `readFileSlice` helper. Behavior unchanged from the caller's view.

### Notes
- The clip store is **per-process**. An id assigned by the HTTP server is
  not resolvable by the MCP server (they're separate processes). Run a
  search in the same process that will resolve the ids.
- The clip store is **ephemeral**. Server restart clears the table. Agents
  that get "id not found or expired" should just re-run the search — the
  underlying files haven't changed.
- No new dependencies. No env var changes.
- Breaking changes are scoped to `/search` and `codebase_semantic_search`.
  All other endpoints and tools (`/stats`, `/health`, `codebase_read_file`,
  `codebase_clip`, `codebase_stats`) are unchanged.

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
