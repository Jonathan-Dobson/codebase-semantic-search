/**
 * MCP over Streamable HTTP: one long-running process serves every agent
 * session on the machine, instead of each session spawning its own stdio
 * server (~150 MB of Node apiece).
 *
 * Each session gets its own McpServer (a server serves exactly one client);
 * the tools, the Milvus client and the clip store are shared, so a session
 * costs a few kilobytes. Bound to 127.0.0.1 with the SDK's host-header check
 * (DNS rebinding protection) and no authentication: it is a local tool, the
 * same trust level as the HTTP search server.
 *
 * Client config (Claude Code):
 *   { "type": "http", "url": "http://127.0.0.1:7701/mcp" }
 */
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp-server.js';
import { ensureCollection } from './milvus.js';
import { CONFIG } from './config.js';

/** The Express app behind `codesearch mcp --http`, without listening (tests use it directly). */
export function createMcpHttpApp(): { app: Express; sessionCount: () => number } {
  const app = createMcpExpressApp();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const sessionTransport = (req: Request): StreamableHTTPServerTransport | undefined => {
    const id = req.headers['mcp-session-id'];
    return typeof id === 'string' ? transports.get(id) : undefined;
  };

  const rpcError = (res: Response, status: number, message: string) =>
    res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

  app.post('/mcp', async (req, res) => {
    const existing = sessionTransport(req);
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    if (req.headers['mcp-session-id'] !== undefined || !isInitializeRequest(req.body)) {
      rpcError(res, 400, 'No such session: send an initialize request without an mcp-session-id header');
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });
    // Runs on a client's DELETE as well as when the transport closes.
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    await createMcpServer().connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // GET opens the server-to-client stream; DELETE ends a session.
  const existingOnly = async (req: Request, res: Response) => {
    const transport = sessionTransport(req);
    if (!transport) {
      rpcError(res, 400, 'No such session');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', existingOnly);
  app.delete('/mcp', existingOnly);

  return { app, sessionCount: () => transports.size };
}

export async function startMcpHttpServer(port: number = CONFIG.mcpPort): Promise<void> {
  await ensureCollection();
  const { app } = createMcpHttpApp();
  await new Promise<void>((resolve, reject) => {
    app.listen(port, '127.0.0.1', () => resolve()).on('error', reject);
  });
  console.error(
    `[mcp] ${CONFIG.mcpServerName} ready (collection: ${CONFIG.collectionName}, transport: http://127.0.0.1:${port}/mcp)`,
  );
}
