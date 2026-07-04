## 1.1  Codebase Semantic Search (Local Tool)

A local vector search engine indexes the full codebase (whatever is
configured in `.codesearchrc.json` — typically `src`, `server/src`,
`docs`, `wiki`, etc.). Use it for **conceptual/meaning-based** discovery
when `grep_search` is too literal. **This is a required first step before
creating any new file, component, hook, utility, type, route, or model.**

Two equivalent interfaces — pick by capability:

| Interface | When to use | How to invoke |
|-----------|-------------|---------------|
| **MCP (preferred)** | Agent runtime supports stdio MCP (Claude Code, Copilot Chat, OpenCode, Codex) | Runtime spawns `npx -y codebase-semantic-search mcp` on demand; you just call the tools |
| **HTTP (fallback)** | Agent runtime can't speak MCP, or you're debugging with curl | Start `npx codesearch serve` first; call `POST /search`, `/read`, `GET /clip/:id`, etc. |

**Full reference (both paths, peer depth):** see
`.github/instructions/codebase-semantic-search.instructions.md`
(`applyTo: "**"` — auto-loaded into every agent context). Don't duplicate
that here — read it instead.

**Recovery rule:** when search errors or returns empty (MCP or HTTP), do
NOT silently fall back to `grep_search`. Run `codebase_stats` (or
`GET /stats` on HTTP) to confirm engine health, then surface
`npx codesearch doctor` to the user.