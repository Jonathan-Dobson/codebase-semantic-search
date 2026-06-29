#!/usr/bin/env node
/**
 * CLI entry point for the codebase-semantic-search package.
 *
 * Subcommands:
 *   init            Scaffold .codesearchrc.json + agent file snippets + docker-compose
 *   doctor          Check prerequisites (Ollama, Milvus, embedding model)
 *   index [--full]  Reindex the codebase (incremental by default)
 *   serve           HTTP search server on CONFIG.searchPort
 *   watch           File watcher — keeps the index in sync, no HTTP
 *   serve:watch     HTTP search server + file watcher in one process
 *   mcp             stdio MCP server (for agents that speak MCP)
 *   status          Show collection stats and config summary
 */
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { indexCommand } from './commands/index.js';
import { serveCommand } from './commands/serve.js';
import { watchCommand } from './commands/watch.js';
import { serveAndWatchCommand } from './commands/serve-and-watch.js';
import { mcpCommand } from './commands/mcp.js';
import { statusCommand } from './commands/status.js';
import { doctorCommand } from './commands/doctor.js';
import { upCommand } from './commands/up.js';
import { downCommand } from './commands/down.js';

const program = new Command();

program
  .name('codesearch')
  .description(
    'Local semantic search engine for any codebase. Reuses Ollama embeddings + Milvus vector storage. Exposes a typed MCP tool for agents and a curl-friendly HTTP API for humans.',
  )
  .version('0.1.0');

program
  .command('init')
  .description(
    'Scaffold .codesearchrc.json + agent file snippets + docker-compose into the current project',
  )
  .option('-f, --force', 'overwrite existing .codesearchrc.json')
  .option('--no-agent-files', 'skip writing agent file snippets')
  .option('--no-docker', 'skip copying docker-compose.search.yml')
  .option(
    '--port <n>',
    'override Milvus gRPC port (default 19530). Use this to run multiple codebases in parallel on the same machine.',
    (v) => parseInt(v, 10),
  )
  .option(
    '--search-port <n>',
    'override the Express HTTP API port (default 7700)',
    (v) => parseInt(v, 10),
  )
  .action(initCommand);

program
  .command('doctor')
  .description(
    'Check prerequisites: Ollama running, Milvus running, embedding model pulled',
  )
  .action(doctorCommand);

program
  .command('index')
  .description(
    'Reindex the codebase. Incremental by default; pass --full to drop and rebuild',
  )
  .option('--full', 'drop the collection and rebuild from scratch')
  .option('--dry-run', 'show what would change without writing')
  .action(indexCommand);

program
  .command('serve')
  .description(
    `Start the HTTP search server on CONFIG.searchPort (default 7700). Agents and humans can hit POST /search.`,
  )
  .action(serveCommand);

program
  .command('watch')
  .description(
    'Run the file watcher only — keeps the index in sync as the codebase changes. No HTTP server.',
  )
  .action(watchCommand);

program
  .command('serve:watch')
  .description(
    'HTTP search server + file watcher in one process. The dev loop.',
  )
  .action(serveAndWatchCommand);

program
  .command('mcp')
  .description(
    'Start the stdio MCP server. Agents that speak MCP (Claude Code, Copilot, etc.) call this via the MCP transport.',
  )
  .action(mcpCommand);

program
  .command('status')
  .description('Show collection stats, chunk count, and current config')
  .action(statusCommand);

program
  .command('up')
  .description(
    'One-shot bootstrap: init (if needed) → start Milvus → pull embedding model → run initial reindex (if empty) → start dev loop (HTTP + watcher). Idempotent — safe to re-run.',
  )
  .option(
    '--port <n>',
    'Milvus port offset (forwarded to init if .codesearchrc.json is missing)',
    (v) => parseInt(v, 10),
  )
  .option('--no-index', 'skip the initial reindex step')
  .option('--no-serve', 'stop after bootstrap; do not start the dev loop')
  .action(upCommand);

program
  .command('down')
  .description(
    'Stop Milvus (docker compose down). Volumes are preserved — your index stays. Use `docker compose down -v` separately to also remove volumes.',
  )
  .action(downCommand);

program.parseAsync().catch((err) => {
  console.error('codesearch: fatal:', err.message);
  process.exit(1);
});
