import { startMcpServer } from '../mcp-server.js';
import { startMcpHttpServer } from '../mcp-http.js';

export async function mcpCommand(opts: { http?: boolean | string } = {}): Promise<void> {
  if (opts.http === undefined || opts.http === false) {
    await startMcpServer();
    return;
  }
  const port = opts.http === true ? undefined : parseInt(opts.http, 10);
  if (port !== undefined && !Number.isInteger(port)) {
    throw new Error(`--http takes a port number, got "${opts.http}"`);
  }
  await startMcpHttpServer(port);
}
