import fs from 'fs';
import path from 'path';
import { readTemplate, TEMPLATES_DIR } from './_templates.js';

interface InitOptions {
  force?: boolean;
  agentFiles?: boolean;
  docker?: boolean;
  port?: number;
  searchPort?: number;
}

const CODESEARCHRC = {
  workspaceRoot: '.',
  indexDirs: ['src', 'server/src', 'docs', 'wiki'],
  excludePatterns: [
    'node_modules',
    '.next',
    'dist',
    'build',
    'coverage',
    '*.lock',
    '*.map',
    '*.min.js',
    '*.min.css',
    'uploads',
    '.git',
    '__pycache__',
    '*.png',
    '*.jpg',
    '*.jpeg',
    '*.gif',
    '*.svg',
    '*.ico',
    '*.woff',
    '*.woff2',
    '*.ttf',
    '*.eot',
    '*.mp4',
    '*.webm',
    '*.pdf',
    '*.xlsx',
    '*.xls',
    '*.zip',
    '*.tar.gz',
    '*.DS_Store',
    'package-lock.json',
  ],
  ollamaHost: 'http://127.0.0.1:11434',
  embeddingModel: 'nomic-embed-text',
  embeddingDimensions: 768,
  milvusHost: '127.0.0.1',
  milvusPort: 19530,
  collectionName: 'codebase_chunks',
  searchPort: 7700,
  maxChunkTokens: 800,
  chunkOverlapLines: 5,
  mcpServerName: 'codebase-semantic-search',
};

const AGENT_MARKER_START = '<!-- BEGIN:codesearch -->';
const AGENT_MARKER_END = '<!-- END:codesearch -->';

function mergeAgentSnippet(
  filePath: string,
  snippet: string,
): 'created' | 'appended' | 'unchanged' | 'skipped' {
  if (!fs.existsSync(filePath)) return 'skipped';

  const existing = fs.readFileSync(filePath, 'utf-8');

  if (existing.includes(AGENT_MARKER_START)) {
    return 'unchanged';
  }

  const wrapped =
    '\n\n' +
    AGENT_MARKER_START +
    '\n' +
    snippet.trim() +
    '\n' +
    AGENT_MARKER_END +
    '\n';

  fs.appendFileSync(filePath, wrapped, 'utf-8');
  return 'appended';
}

function ensureCopilotInstructions(
  snippet: string,
): 'created' | 'appended' | 'unchanged' | 'skipped' {
  const filePath = path.join(process.cwd(), '.github', 'copilot-instructions.md');
  if (!fs.existsSync(path.dirname(filePath))) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    const header = `# Copilot Instructions\n\nAdd project-level rules for Copilot / AI agents here.\n`;
    const body = header + '\n' + AGENT_MARKER_START + '\n' + snippet.trim() + '\n' + AGENT_MARKER_END + '\n';
    fs.writeFileSync(filePath, body, 'utf-8');
    return 'created';
  }
  return mergeAgentSnippet(filePath, snippet);
}

function processAgentFiles(snippet: string): Array<{ file: string; status: string }> {
  const agentsDir = path.join(process.cwd(), '.github', 'agents');
  const results: Array<{ file: string; status: string }> = [];

  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }

  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.agent.md'));
  if (files.length === 0) {
    // Create a default agent file so the snippet has a home
    const defaultAgent = path.join(agentsDir, 'default.agent.md');
    const header =
      '---\n' +
      'description: "Default coding agent. Use when: implementing features, fixing bugs, refactoring, or any general development task."\n' +
      'tools: [read, edit, search, execute, todo]\n' +
      '---\n\n' +
      '# Default Agent\n\n' +
      'General-purpose coding agent. For project-specific domain knowledge, see other agents in this folder.\n';
    const body =
      header + '\n' + AGENT_MARKER_START + '\n' + snippet.trim() + '\n' + AGENT_MARKER_END + '\n';
    fs.writeFileSync(defaultAgent, body, 'utf-8');
    results.push({ file: '.github/agents/default.agent.md', status: 'created' });
    return results;
  }

  for (const f of files) {
    const filePath = path.join(agentsDir, f);
    const status = mergeAgentSnippet(filePath, snippet);
    results.push({ file: `.github/agents/${f}`, status });
  }
  return results;
}

export async function initCommand(opts: InitOptions): Promise<void> {
  console.log('=== Codebase Semantic Search — init ===\n');

  const cwd = process.cwd();
  const rcPath = path.join(cwd, '.codesearchrc.json');
  const composePath = path.join(cwd, 'docker-compose.search.yml');

  // Compute the effective config. Port overrides let multiple codebases
  // coexist on the same machine by namespacing host-side port mappings.
  const effectiveMilvusPort = opts.port ?? 19530;
  const effectiveSearchPort = opts.searchPort ?? 7700;
  const effectiveMetricsPort = effectiveMilvusPort + 1; // 19531 → 9092
  const effectiveMinioApiPort = effectiveMilvusPort + 170; // 19531 → 19701
  const effectiveMinioConsolePort = effectiveMinioApiPort + 1; // 19702

  const rcConfig = {
    ...CODESEARCHRC,
    milvusPort: effectiveMilvusPort,
    searchPort: effectiveSearchPort,
  };

  // 1. .codesearchrc.json
  if (fs.existsSync(rcPath) && !opts.force) {
    console.log(`[skip] ${rcPath} already exists (pass --force to overwrite)`);
  } else {
    fs.writeFileSync(rcPath, JSON.stringify(rcConfig, null, 2) + '\n', 'utf-8');
    console.log(`[write] ${rcPath} (milvusPort: ${effectiveMilvusPort}, searchPort: ${effectiveSearchPort})`);
  }

  // 2. docker-compose.search.yml
  if (opts.docker !== false) {
    if (fs.existsSync(composePath) && !opts.force) {
      console.log(`[skip] ${composePath} already exists (pass --force to overwrite)`);
    } else {
      // Copy from the package's bundled template (next to the dist/ at runtime,
      // or sibling in dev). We resolve relative to the module location.
      const bundledCompose = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        '..',
        '..',
        'docker-compose.search.yml',
      );
      const content = fs.readFileSync(bundledCompose, 'utf-8');
      fs.writeFileSync(composePath, content, 'utf-8');
      console.log(`[write] ${composePath}`);
    }
  }

  // 3. Agent file snippets
  if (opts.agentFiles !== false) {
    const snippet = readTemplate('agent-semantic-search-section.md');
    const copilotSnippet = readTemplate('copilot-instructions-section.md');

    const copilotResult = ensureCopilotInstructions(copilotSnippet);
    const agentResults = processAgentFiles(snippet);

    console.log(`[write] .github/copilot-instructions.md: ${copilotResult}`);
    for (const r of agentResults) {
      console.log(`[write] ${r.file}: ${r.status}`);
    }
  }

  console.log('\n=== Next steps ===');

  console.log(
    '`init` only writes config + agent snippets. To bring up the full\n' +
      'engine (Milvus + embedding model + initial index + dev loop) run:\n',
  );
  console.log('   npx codesearch up');
  console.log(
    '\n`up` is idempotent — it does, in order: scaffolds .codesearchrc.json\n' +
      'if missing → starts Milvus (Docker) → pulls nomic-embed-text via\n' +
      'Ollama → runs an initial full reindex if the collection is empty →\n' +
      'starts the file watcher. Ctrl+C stops the watcher; Milvus keeps\n' +
      'running. To stop Milvus too: `npx codesearch down`.\n',
  );

  // Build the docker compose command. If the user overrode the port, we
  // need to set the env vars so the host-side port mappings line up with
  // the values in .codesearchrc.json.
  const composeEnvVars: string[] = [];
  if (effectiveMilvusPort !== 19530) {
    composeEnvVars.push(`MILVUS_PORT=${effectiveMilvusPort}`);
    composeEnvVars.push(`MILVUS_METRICS_PORT=${effectiveMetricsPort}`);
    composeEnvVars.push(`MINIO_API_PORT=${effectiveMinioApiPort}`);
    composeEnvVars.push(`MINIO_CONSOLE_PORT=${effectiveMinioConsolePort}`);
  }

  console.log('--- Manual steps (only if `up` is not the right entry point) ---');
  console.log('a. Start the vector DB:');
  const composeCmd =
    (composeEnvVars.length ? composeEnvVars.join(' ') + ' ' : '') +
    'docker compose -f docker-compose.search.yml up -d';
  console.log(`   ${composeCmd}`);
  if (composeEnvVars.length) {
    console.log(
      `   (the env vars shift the host-side port mappings so multiple projects can coexist)`,
    );
  }
  console.log('b. Make sure Ollama is running and the embedding model is pulled:');
  console.log('   ollama pull nomic-embed-text');
  console.log('c. Bootstrap the index:');
  console.log('   npx codesearch index --full');
  console.log('d. Start the dev loop (HTTP API + file watcher):');
  console.log('   npx codesearch serve:watch');
  console.log();

  console.log('--- Talking to the index from agents (recommended path) ---');
  console.log(
    'Agent runtimes (Claude Code, GitHub Copilot Chat, OpenCode, Codex)\n' +
      'spawn the MCP server on demand over stdio — you do NOT need to\n' +
      'start it manually. Register it once with your agent runtime:\n',
  );
  console.log('  Claude Code  (~/.claude/mcp.json or .mcp.json):');
  console.log('    { "mcpServers": { "codebase": { "command": "npx",');
  console.log('        "args": ["-y", "codebase-semantic-search", "mcp"] } } }');
  console.log('  GitHub Copilot Chat  (.vscode/mcp.json):');
  console.log('    { "servers": { "codebase-semantic-search": { "type": "stdio",');
  console.log('        "command": "npx",');
  console.log('        "args": ["-y", "codebase-semantic-search", "mcp"] } } }');
  console.log();
  console.log(
    'After registration, the four MCP tools (codebase_semantic_search,\n' +
      'codebase_clip, codebase_read_file, codebase_stats) become available\n' +
      'to your agent — they query the same index that `up` set up.\n',
  );
  console.log(
    'For humans / curl debugging only, run `npx codesearch serve` (HTTP\n' +
      'on :7700) or `npx codesearch serve:watch` to also keep the index\n' +
      'fresh. See the README for endpoint details.',
  );
  console.log(`\nTemplates bundled in: ${TEMPLATES_DIR}`);
}
