import fs from 'fs';
import path from 'path';
import { readTemplate, TEMPLATES_DIR } from './_templates.js';

interface InitOptions {
  force?: boolean;
  agentFiles?: boolean;
  docker?: boolean;
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

  // 1. .codesearchrc.json
  if (fs.existsSync(rcPath) && !opts.force) {
    console.log(`[skip] ${rcPath} already exists (pass --force to overwrite)`);
  } else {
    fs.writeFileSync(rcPath, JSON.stringify(CODESEARCHRC, null, 2) + '\n', 'utf-8');
    console.log(`[write] ${rcPath}`);
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
  console.log('1. Start the vector DB:');
  console.log('   docker compose -f docker-compose.search.yml up -d');
  console.log('2. Make sure Ollama is running and the embedding model is pulled:');
  console.log('   ollama pull nomic-embed-text');
  console.log('3. Bootstrap the index:');
  console.log('   codesearch index --full');
  console.log('4. Start the dev loop (HTTP API + file watcher):');
  console.log('   codesearch serve:watch');
  console.log('5. Or run the MCP server for agents that speak MCP:');
  console.log('   codesearch mcp');
  console.log(`\nTemplates bundled in: ${TEMPLATES_DIR}`);
}
