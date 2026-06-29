## 1.1  Codebase Semantic Search (Local Tool)

A local vector search engine indexes the full codebase (docs, wiki, src, server/src — whatever you configure in `.codesearchrc.json`).
Use it for **conceptual/meaning-based** discovery when `grep_search` is too literal.
**This is a required first step before creating any new file, component, hook, utility, type, route, or model.**

**Preferred — MCP tool `codebase_semantic_search`** (typed, no JSON wrangling):

```text
tool:   codebase_semantic_search
input:  { "query": "<natural language description>", "top_k": 10 }
```

**Fallback — HTTP** (when MCP isn't registered for this client):

```bash
curl -s http://localhost:7700/search \
  -H "Content-Type: application/json" \
  -d '{"query": "<natural language description>", "top_k": 10}'
```

**With filters:**
```json
{
  "query": "how patient data is encrypted at rest",
  "top_k": 10,
  "module": "<module name>",
  "language": "typescript",
  "chunk_type": "function"
}
```

**Optional filters** (values depend on your `.codesearchrc.json` config):
- `module` — first path segment under the workspace root (e.g. `src`, `server/src/modules/<name>`, `docs`, `wiki`)
- `language` — typescript, tsx, javascript, markdown, json, yaml, terraform, python, ...
- `chunk_type` — function, class, interface, type, variable, section, block

**When to use:**
- Before creating any new file, component, hook, utility, type, route, or model
- Finding code by intent/meaning rather than exact text
- Discovering related implementations across modules
- Understanding how a concept is implemented across the codebase
- Finding relevant documentation sections

**Response shape:** `{ success, data: { query, results: [{ filePath, symbolName, chunkType, startLine, endLine, content, score, module, language }], count } }`
