/**
 * MCP (Model Context Protocol) server for the codebase semantic search.
 *
 * Exposes two tools to any MCP-compatible client (Claude Code, GitHub
 * Copilot Chat, OpenCode, Codex, etc.):
 *
 *   - codebase_semantic_search — query the index by meaning
 *   - codebase_stats          — chunk count and collection name
 *
 * Transport: stdio. The agent runtime spawns this process on demand and
 * exchanges JSON-RPC over stdin/stdout. No port, no daemon.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { embedQuery } from './embedder.js';
import { ensureCollection, searchChunks, getCollectionStats } from './milvus.js';
import { CONFIG } from './config.js';

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
      .max(50)
      .default(10)
      .optional()
      .describe('Number of results to return. Default 10, max 50.'),
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
  },
  async ({ query, top_k, module, language, chunk_type }) => {
    try {
      const topK = top_k ?? 10;
      const queryEmbedding = await embedQuery(query);
      const results = await searchChunks(queryEmbedding, topK, {
        module,
        language,
        chunkType: chunk_type,
      });

      const payload = {
        query,
        count: results.length,
        topK,
        filters: { module, language, chunkType: chunk_type },
        results: results.map((r) => ({
          filePath: r.filePath,
          symbolName: r.symbolName || null,
          chunkType: r.chunkType,
          startLine: r.startLine,
          endLine: r.endLine,
          score: Number(r.score.toFixed(4)),
          module: r.module,
          language: r.language,
          content: r.content,
        })),
      };

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
