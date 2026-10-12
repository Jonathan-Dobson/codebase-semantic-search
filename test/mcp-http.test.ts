import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import http, { type Server } from 'http';

// CONFIG is resolved from process.cwd() at import time, so point cwd at a throwaway
// project BEFORE importing the server. Nothing here touches Milvus or Ollama:
// tools/list and codebase_read_file need neither.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-mcp-http-'));
fs.writeFileSync(path.join(root, '.codesearchrc.json'), '{}');
fs.writeFileSync(path.join(root, 'hello.txt'), 'one\ntwo\nthree\n');
process.chdir(root);
const { createMcpHttpApp } = await import('../src/mcp-http.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

const { app, sessionCount } = createMcpHttpApp();
const server: Server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
// closeAllConnections: keep-alive sockets from fetch would otherwise hold close() open.
after(() => { server.closeAllConnections(); server.close(); });

async function connect() {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

test('two sessions share one process, each with its own MCP server', async () => {
  const a = await connect();
  const b = await connect();
  assert.notEqual(a.transport.sessionId, b.transport.sessionId);
  assert.equal(sessionCount(), 2);

  const [toolsA, toolsB] = await Promise.all([a.client.listTools(), b.client.listTools()]);
  const names = (r: typeof toolsA) => r.tools.map((t) => t.name).sort();
  assert.deepEqual(names(toolsA), ['codebase_clip', 'codebase_read_file', 'codebase_semantic_search', 'codebase_stats']);
  assert.deepEqual(names(toolsB), names(toolsA));

  const read = await b.client.callTool({ name: 'codebase_read_file', arguments: { filePath: 'hello.txt', startLine: 2, endLine: 3 } });
  const [first] = read.content as { type: string; text: string }[];
  assert.equal(JSON.parse(first.text).content, 'two\nthree');

  await a.transport.terminateSession();
  await b.transport.terminateSession();
  assert.equal(sessionCount(), 0);
});

test('a request for an unknown session is refused, not given a new server', async () => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'nope' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 400);
  assert.equal(sessionCount(), 0);
});

test('a foreign Host header is refused (DNS rebinding protection)', async () => {
  // fetch won't send a custom Host header, so use http.request.
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }));
  });
  assert.equal(status, 403);
  assert.equal(sessionCount(), 0);
});
