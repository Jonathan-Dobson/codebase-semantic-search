/**
 * MCP (Model Context Protocol) server for the codebase semantic search.
 *
 * Exposes four tools to any MCP-compatible client (Claude Code, GitHub
 * Copilot Chat, OpenCode, Codex, etc.):
 *
 *   - codebase_semantic_search — query the index by meaning
 *   - codebase_read_file      — fetch a file slice by line range (sed -n 'A,Bp')
 *   - codebase_clip           — fetch a clip by short numeric id (from search)
 *   - codebase_stats          — chunk count and collection name
 *
 * Transport: stdio. The agent runtime spawns this process on demand and
 * exchanges JSON-RPC over stdin/stdout. No port, no daemon.
 *
 * The clip store is per-process and ephemeral — each MCP server start
 * starts with an empty store. Callers who need an id must run a search in
 * the same process to receive it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { embedQuery } from './embedder.js';
import { ensureCollection, searchChunks, getCollectionStats } from './milvus.js';
import { CONFIG } from './config.js';
import { putClip, getClip, clipStoreSize } from './clip-store.js';
import { readFileSlice } from './read-clip.js';
import { renderSearchMarkdown, type MarkdownHit } from './render-search.js';

// Default relative quality threshold. Mirrors the HTTP server constant;
// single source of truth could be moved to a shared module if more
// callers need it.
const DEFAULT_MIN_SCORE_DIFF = 0.1;

const server = new McpServer({
  name: CONFIG.mcpServerName,
  version: '0.1.0',
});

server.tool(
  'codebase_semantic_search',
  'Search the project codebase by meaning. Returns ranked code chunks with file paths, symbols, and content snippets. Use this before adding new files, components, hooks, utilities, types, routes, or models to find existing implementations.',
  {
    query: z
      .string()
      .min(1)
      .describe(
        'Natural language description of what you are looking for. ' +
          'Example: "how does tenant isolation work in mongoose queries"',
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(100)
      .optional()
      .describe('Number of results to return. Default 100, max 100.'),
    module: z
      .string()
      .optional()
      .describe('Filter by module. Values depend on the project layout.'),
    language: z
      .string()
      .optional()
      .describe(
        'Filter by file language. Values: typescript, tsx, javascript, markdown, json, yaml, terraform, python, etc.',
      ),
    chunk_type: z
      .string()
      .optional()
      .describe(
        'Filter by chunk type. Values: function, class, interface, section, block, etc.',
      ),
    min_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Drop hits below this cosine-similarity score (0..1). Absolute quality filter applied AFTER the vector search, so you may receive fewer than top_k results. Bump top_k if you need a guaranteed minimum count. Mutually exclusive with min_score_diff.',
      ),
    min_score_diff: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Relative quality filter: drop hits whose score is more than this far below the best hit. Decimal in [0, 1]. Threshold = max_score - min_score_diff. Applied by default at 0.1 if neither this nor min_score is set. Mutually exclusive with min_score (only when both are explicitly provided).',
      ),
    include: z
      .array(z.enum(['chunkType', 'module', 'language']))
      .optional()
      .describe(
        'Opt-in to include these metadata fields on each result. Default response omits chunkType, module, language — they are useful as filter inputs (chunk_type, module, language above) but largely redundant as response fields (derivable from filePath and content).',
      ),
    format: z
      .enum(['markdown', 'json'])
      .optional()
      .default('markdown')
      .describe(
        'Response format. Default "markdown" — single document with a "# Search: ..." title, per-hit code fence, and metadata caption. Pass "json" for the structured lean response with `include` opt-in fields.',
      ),
  },
  async ({
    query,
    top_k,
    module,
    language,
    chunk_type,
    min_score,
    min_score_diff,
    include,
    format,
  }) => {
    try {
      const userProvidedMinScore = min_score !== undefined;
      const userProvidedMinScoreDiff = min_score_diff !== undefined;

      if (userProvidedMinScore && userProvidedMinScoreDiff) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'codebase_semantic_search failed: min_score and min_score_diff are mutually exclusive — pick one',
            },
          ],
        };
      }

      const topK = top_k ?? 100;
      const queryEmbedding = await embedQuery(query);
      const rawResults = await searchChunks(queryEmbedding, topK, {
        module,
        language,
        chunkType: chunk_type,
      });

      // Apply quality filter (if any) before registering clips, so the
      // clip store doesn't accumulate entries the caller never saw. The
      // server-side default (DEFAULT_MIN_SCORE_DIFF) kicks in when the
      // caller doesn't provide either filter.
      let filtered = rawResults;
      let appliedThreshold: number | undefined;
      let maxScore: number | undefined;
      const effectiveMinScoreDiff = userProvidedMinScoreDiff
        ? min_score_diff
        : DEFAULT_MIN_SCORE_DIFF;
      if (!userProvidedMinScore && rawResults.length > 0) {
        maxScore = rawResults.reduce((m, r) => Math.max(m, r.score), 0);
        const threshold = Math.max(0, maxScore - effectiveMinScoreDiff);
        appliedThreshold = threshold;
        filtered = rawResults.filter((r) => r.score >= threshold);
      } else if (userProvidedMinScore) {
        appliedThreshold = min_score;
        filtered = rawResults.filter((r) => r.score >= min_score);
      }

      const includedFields = new Set(include ?? []);

      // Register each surviving hit in the in-memory clip store so callers
      // can fetch the full text by short numeric id via codebase_clip.
      // Dedup is keyed on (filePath, startLine, endLine).
      const hitsWithIds = filtered.map((r) => ({
        id: putClip(r.filePath, r.startLine, r.endLine),
        filePath: r.filePath,
        symbolName: r.symbolName,
        chunkType: r.chunkType,
        module: r.module,
        language: r.language,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        content: r.content,
      }));

      if (format === 'markdown') {
        const mdHits: MarkdownHit[] = hitsWithIds.map((h) => ({
          id: h.id,
          filePath: h.filePath,
          symbolName: h.symbolName,
          score: Number(h.score.toFixed(4)),
          startLine: h.startLine,
          endLine: h.endLine,
          content: h.content,
          language: h.language,
          chunkType: includedFields.has('chunkType') ? h.chunkType : undefined,
          module: includedFields.has('module') ? h.module : undefined,
        }));
        const includedArr =
          includedFields.size > 0 ? Array.from(includedFields) : undefined;
        const markdown = renderSearchMarkdown({
          query,
          count: mdHits.length,
          topK,
          minScore: userProvidedMinScore ? min_score : undefined,
          minScoreDiff: !userProvidedMinScore ? effectiveMinScoreDiff : min_score_diff,
          includedFields: includedArr,
          clipStoreSize: clipStoreSize(),
          hits: mdHits,
        });
        return {
          content: [{ type: 'text' as const, text: markdown }],
        };
      }

      // JSON renderer: lean default with opt-in include for metadata.
      const payload: Record<string, unknown> = {
        query,
        count: filtered.length,
        topK,
        filters: { module, language, chunkType: chunk_type },
        clipStoreSize: clipStoreSize(),
        results: hitsWithIds.map((h) => {
          const out: Record<string, unknown> = {
            id: h.id,
            filePath: h.filePath,
            symbolName: h.symbolName || null,
            score: Number(h.score.toFixed(4)),
            startLine: h.startLine,
            endLine: h.endLine,
            content: h.content,
          };
          if (includedFields.has('chunkType')) out.chunkType = h.chunkType;
          if (includedFields.has('module')) out.module = h.module;
          if (includedFields.has('language')) out.language = h.language;
          return out;
        }),
      };
      if (userProvidedMinScore) {
        payload.minScore = min_score;
        payload.candidatesBeforeFilter = rawResults.length;
      } else {
        payload.minScoreDiff = effectiveMinScoreDiff;
        payload.appliedThreshold = appliedThreshold;
        payload.maxScore = maxScore;
        payload.candidatesBeforeFilter = rawResults.length;
      }
      if (includedFields.size > 0) {
        payload.includedFields = Array.from(includedFields);
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `codebase_semantic_search failed: ${err.message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'codebase_read_file',
  "Read a slice of a file between two 1-indexed inclusive line numbers — equivalent to `sed -n '<start>,<end>p' <filePath>`. Use this to expand the context around a chunk returned by codebase_semantic_search (each hit carries startLine/endLine), or to peek at any file relative to the workspace root without loading the whole file.",
  {
    filePath: z
      .string()
      .min(1)
      .describe(
        'Path to the file relative to the workspace root (e.g. "src/auth/login.ts"). ' +
          'Absolute paths and parent-directory escapes are rejected for safety.',
      ),
    startLine: z
      .number()
      .int()
      .min(1)
      .describe('First line to return (1-indexed, inclusive).'),
    endLine: z
      .number()
      .int()
      .min(1)
      .describe(
        'Last line to return (1-indexed, inclusive). Must be >= startLine. ' +
          'Hard cap: 500 lines per call — chain multiple reads to paginate larger ranges.',
      ),
  },
  async ({ filePath, startLine, endLine }) => {
    try {
      const result = await readFileSlice(filePath, startLine, endLine);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `codebase_read_file failed: ${result.error.message}`,
            },
          ],
        };
      }
      const { startLine: s, endLine: e, totalLines, content } = result.clip;
      const payload = {
        filePath,
        startLine: s,
        endLine: e,
        totalLines,
        rangeRequested: { startLine, endLine },
        content,
      };
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `codebase_read_file failed: ${err.message}`,
          },
        ],
      };
    }
  },
);

// Mirror of the HTTP /clip/:id and /clips endpoints. Accepts either a single
// `id` (number) or a batch `ids` (number[]). Ids are assigned by
// codebase_semantic_search and are valid for the lifetime of this MCP
// server process — restart clears the table.
server.tool(
  'codebase_clip',
  'Fetch the full text clip for one or more short numeric ids returned by codebase_semantic_search. Provide EITHER `id` (single) OR `ids` (array), not both. Ids are per-process and ephemeral — a server restart invalidates them. Per-id errors are reported in the `results` array so a single bad id does not abort the batch.',
  {
    id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Single clip id to fetch.'),
    ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Array of clip ids to fetch as a batch. Per-item errors are reported in the response.'),
  },
  async ({ id, ids }) => {
    try {
      if ((id === undefined) === (ids === undefined)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'codebase_clip failed: provide EITHER `id` (single) OR `ids` (array), not both and not neither.',
            },
          ],
        };
      }

      // Normalize to a list and dedup while preserving order.
      const idList = id !== undefined ? [id] : Array.from(new Set(ids!));

      const results: any[] = [];
      let succeeded = 0;
      let failed = 0;
      for (const oneId of idList) {
        const ref = getClip(oneId);
        if (!ref) {
          results.push({
            id: oneId,
            success: false,
            error: 'id not found or expired. Re-run codebase_semantic_search to get a fresh id.',
          });
          failed++;
          continue;
        }
        const result = await readFileSlice(ref.filePath, ref.startLine, ref.endLine);
        if (!result.ok) {
          results.push({ id: oneId, success: false, error: result.error.message });
          failed++;
          continue;
        }
        results.push({ id: oneId, success: true, ...result.clip });
        succeeded++;
      }

      const payload = {
        results,
        requested: idList.length,
        succeeded,
        failed,
        clipStoreSize: clipStoreSize(),
      };
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `codebase_clip failed: ${err.message}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'codebase_stats',
  'Return stats about the semantic search index: total chunk count, collection name, and embedding model. Useful to confirm the indexer has caught up before searching.',
  {},
  async () => {
    try {
      const stats = await getCollectionStats();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                collection: CONFIG.collectionName,
                chunkCount: stats.count,
                embeddingModel: CONFIG.embeddingModel,
                embeddingDimensions: CONFIG.embeddingDimensions,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `codebase_stats failed: ${err.message}`,
          },
        ],
      };
    }
  },
);

export async function startMcpServer(): Promise<void> {
  await ensureCollection();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — never write to stdout, the MCP client owns it
  console.error(
    `[mcp] ${CONFIG.mcpServerName} ready (collection: ${CONFIG.collectionName}, transport: stdio)`,
  );
}
