## Semantic Search (always run first)

Before reading files, grepping, or proposing changes, run a semantic search
to find existing code by meaning. **Duplicate code is a defect.**

**Preferred — MCP tool `codebase_semantic_search`** (typed, no JSON wrangling):

```text
tool:   codebase_semantic_search
input:  { "query": "<natural language description>", "top_k": 10 }
```

**Fallback — HTTP** (when MCP isn't registered for this client):

```bash
curl -s http://localhost:7700/search -H "Content-Type: application/json" \
  -d '{"query": "<natural language description>", "top_k": 10}'
```

Optional filters: `module` (first path segment under workspace root),
`language` (typescript, tsx, markdown, json, etc.), `chunk_type` (function,
class, interface, section, block). Use this in addition to `grep_search` and
`file_search` — semantic search finds code by meaning, not by literal text
match, so it surfaces existing patterns that the literal tools miss.
