import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the project root (where .codesearchrc.json lives, if any).
// CLI is at <projectRoot>/.codesearchrc.json's dir, or dist/cli.js's grandparent.
function findProjectRoot(): string {
  // Walk up from cwd until we find a .codesearchrc.json or hit /
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, '.codesearchrc.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const DEFAULTS = {
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

export type Config = typeof DEFAULTS & {
  workspaceRoot: string;
  stateFile: string;
};

function loadRcFile(projectRoot: string): Partial<Config> {
  const rcPath = path.join(projectRoot, '.codesearchrc.json');
  if (!fs.existsSync(rcPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(rcPath, 'utf-8'));
  } catch (err: any) {
    throw new Error(`Failed to parse ${rcPath}: ${err.message}`);
  }
}

function buildConfig(): Config {
  const projectRoot = findProjectRoot();
  const rc = loadRcFile(projectRoot);

  // Env vars override rc file
  const env = process.env;

  const workspaceRoot = path.resolve(projectRoot, rc.workspaceRoot ?? '.');
  // State lives at the project root, NOT inside node_modules — any
  // `npm install` of this package would otherwise wipe the indexer's
  // mtime ledger and silently degrade incremental mode to a full reindex.
  // See 0.2.4 fix: root-scoped state survives reinstalls.
  const stateFile = path.join(projectRoot, '.search-index-state.json');

  return {
    ...DEFAULTS,
    ...rc,
    workspaceRoot,
    stateFile,
    ollamaHost: env.OLLAMA_HOST || rc.ollamaHost || DEFAULTS.ollamaHost,
    embeddingModel:
      env.EMBEDDING_MODEL || rc.embeddingModel || DEFAULTS.embeddingModel,
    milvusHost: env.MILVUS_HOST || rc.milvusHost || DEFAULTS.milvusHost,
    milvusPort: parseInt(
      env.MILVUS_PORT || String(rc.milvusPort ?? DEFAULTS.milvusPort),
      10,
    ),
    searchPort: parseInt(
      env.SEARCH_PORT || String(rc.searchPort ?? DEFAULTS.searchPort),
      10,
    ),
  };
}

export const CONFIG: Config = buildConfig();
