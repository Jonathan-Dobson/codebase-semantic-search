# 150-codebase-semantic-search

## What this is
The `codesearch` engine — a local semantic-search service for any
codebase. v0.2.5 (npm package `codebase-semantic-search`, bin
`codesearch`). Combines Ollama embeddings + Milvus vector storage +
file-watcher + MCP server + HTTP API.

## Project location
`/Users/jdobson/developer/150-codebase-semantic-search/` — migrated
2026-08-21 from `~/developer/codebase-semantic-search/` to conform
with the project-folder convention.

## Remotes (read these first before pushing)
- **`github`** — `https://github.com/Jonathan-Dobson/codebase-semantic-search.git` (real)
- **`origin`** — `/Users/jdobson/.git-origin-repos/codebase-semantic-search` (local mirror)

Per agent memory rule "Multi-remote repos: verify before push": always
`git push <remote> <ref>` explicitly. Do not rely on `git push` alone —
`origin` is the local mirror, `github` is the real remote.

## Project layout
```
150-codebase-semantic-search/
├── src/                 # TS source (cli, http server, mcp, indexer, embedder)
├── dist/                # build output (gitignored)
├── node_modules/        # deps (gitignored)
├── templates/           # scaffold templates for `codesearch init` target projects
├── .github/             # workflows
├── README.md            # 32K — full user-facing docs
├── CHANGELOG.md         # version history
├── package.json         # version 0.2.5, type: module
├── docker-compose.search.yml   # local Milvus + Ollama + engine stack
└── AGENTS.md            # this file
```

## How to use it
```sh
# build & install
npm install
npm run build           # tsc → dist/
npm link                # exposes `codesearch` bin globally

# run a local search stack (Milvus + Ollama + engine)
docker compose -f docker-compose.search.yml up -d
codesearch init <target-project>   # scaffolds .codesearchrc.json + .github/agents
codesearch watch <target-project>  # start indexing
codesearch query "your search"     # CLI search
```

## Agent notes
- This package is published to npm. Bump `version` in `package.json` AND
  add a `CHANGELOG.md` entry on every release. See agent memory →
  `deep/codebase-semantic-search-publishing.md` for the publishing
  recipe (4 identity accounts, dist-tag policy, GitHub PAT scopes).
- The `.codesearchrc.json`, `.github/agents/`, `.github/copilot-instructions.md`,
  and `.search-index-state.json` files in this repo's own root are
  smoke-test artifacts (running `codesearch init` against the engine
  itself). They are **gitignored** for that reason — they are not the
  product surface; the templates in `templates/` are.
- The engine's own collection for testing is `ultravisit_chunks` (per
  agent memory). Production targets use their own collection names.
- Do not `write`-touch `CHANGELOG.md` — append-only history file.
  Use `edit` for the new version's bullet list.
