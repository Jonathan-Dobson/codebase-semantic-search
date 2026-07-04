## Semantic Search (always run first)

Before reading files, grepping, or proposing changes, query the codebase by
meaning. **Duplicate code is a defect.**

Two equivalent interfaces — pick by capability:

**MCP (preferred):** use `codebase_semantic_search`. Your agent runtime
spawns the MCP server on demand over stdio — you don't start it yourself.
**HTTP (fallback):** when your agent runtime can't speak MCP (rare; e.g.
raw curl debugging), use `POST /search` etc. on `http://localhost:7700`.

**Full reference (both paths, peer depth):**
`.github/instructions/codebase-semantic-search.instructions.md`
(`applyTo: "**"` — auto-loaded into every agent context). Read that, not this.

**Recovery (both paths):** when the search errors or returns empty, do NOT
silently fall back to `grep_search`. Run `codebase_stats` (or
`GET /stats` on HTTP) to confirm engine health, then surface
`npx codesearch doctor` to the user.