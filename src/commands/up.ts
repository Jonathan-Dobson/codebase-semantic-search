import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawnSync } from 'child_process';
import { initCommand } from './init.js';
import { runIndexer } from '../indexer.js';
import { ensureCollection, getCollectionStats } from '../milvus.js';
import { startServer } from '../search-server.js';
import { startWatcher } from '../watcher.js';
import { CONFIG } from '../config.js';

interface UpOptions {
  port?: number;
  // commander treats `--no-X` as option `X` defaulting to `true`. So
  // `opts.index` and `opts.serve` are `true` by default, `false` when
  // `--no-index` / `--no-serve` is passed. We invert the meaning at the
  // call site for readability.
  index?: boolean;
  serve?: boolean;
}

function isOllamaRunning(): boolean {
  try {
    const res = spawnSync('curl', [
      '-sS',
      '-m',
      '2',
      `${CONFIG.ollamaHost}/api/tags`,
    ], { encoding: 'utf-8' });
    if (res.status !== 0) return false;
    const data = JSON.parse(res.stdout);
    return Array.isArray(data?.models) && data.models.length > 0;
  } catch {
    return false;
  }
}

function hasEmbeddingModel(): boolean {
  try {
    const res = spawnSync('curl', [
      '-sS',
      '-m',
      '2',
      `${CONFIG.ollamaHost}/api/tags`,
    ], { encoding: 'utf-8' });
    if (res.status !== 0) return false;
    const data = JSON.parse(res.stdout);
    const models: Array<{ name: string }> = data?.models ?? [];
    return models.some((m) => m.name.startsWith(CONFIG.embeddingModel));
  } catch {
    return false;
  }
}

function pullEmbeddingModel(): void {
  console.log(`[up] Pulling embedding model "${CONFIG.embeddingModel}" via Ollama...`);
  const res = spawnSync('ollama', ['pull', CONFIG.embeddingModel], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`ollama pull exited with code ${res.status}`);
  }
}

function isMilvusRunning(): boolean {
  // Try a TCP connect to the configured host:port. Fast and avoids docker CLI parsing.
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);
    socket.connect(CONFIG.milvusPort, CONFIG.milvusHost, () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  }) as unknown as boolean;
}

// We need the async version of isMilvusRunning for the await chain
async function isMilvusRunningAsync(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);
    socket.connect(CONFIG.milvusPort, CONFIG.milvusHost, () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForMilvus(timeoutMs = 90000): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    if (await isMilvusRunningAsync()) {
      // TCP is reachable. Now wait for the actual Milvus gRPC service
      // to be ready by attempting a real call. `ensureCollection` is
      // idempotent — succeeds on a fresh Milvus (creates) and a populated
      // one (no-op). The first successful call proves Milvus is fully up.
      try {
        await ensureCollection();
        return;
      } catch {
        // Milvus gRPC not ready yet, keep polling
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  throw new Error(
    `Milvus did not become fully ready on ${CONFIG.milvusHost}:${CONFIG.milvusPort} within ${timeoutMs / 1000}s (${attempt} attempts)`,
  );
}

function startMilvus(): void {
  // Build the env vars from the current CONFIG. The user may have used
  // `init --port=<N>` which writes a custom .codesearchrc.json; the
  // docker-compose template uses ${MILVUS_PORT:-19530} substitution
  // so we just need to forward the right env var.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };
  // Pass the host arch so the milvus service's `platform:` directive
  // (e.g. `platform: ${UNAME_M:-linux/amd64}`) pulls the right native
  // image. Falls back to linux/amd64 on unknown arches (covers x86_64,
  // ia32, anything not arm64). On Apple Silicon, process.arch is 'arm64'
  // for native Node; if a user runs Node under Rosetta, they'll get
  // the emulated x86_64 path (acceptable trade-off).
  env.UNAME_M = `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
  // Only set if the config is non-default. The compose file's own
  // ${VAR:-default} handles the default case.
  if (CONFIG.milvusPort !== 19530) {
    env.MILVUS_PORT = String(CONFIG.milvusPort);
    env.MILVUS_METRICS_PORT = String(CONFIG.milvusPort + 1);
    env.MINIO_API_PORT = String(CONFIG.milvusPort + 170);
    env.MINIO_CONSOLE_PORT = String(CONFIG.milvusPort + 171);
  }

  const composeFile = 'docker-compose.search.yml';
  if (!fs.existsSync(composeFile)) {
    throw new Error(
      `No ${composeFile} found in ${process.cwd()}. Run 'codesearch init' first.`,
    );
  }

  console.log(`[up] Starting Milvus via docker compose (port ${CONFIG.milvusPort})...`);
  const res = spawnSync(
    'docker',
    ['compose', '-f', composeFile, '-p', path.basename(process.cwd()), 'up', '-d'],
    { stdio: 'inherit', env },
  );
  if (res.status !== 0) {
    throw new Error(`docker compose up exited with code ${res.status}`);
  }
}

// import path lazily so the synchronous helpers above don't trip the
// import hoisting in some bundlers
export async function upCommand(opts: UpOptions): Promise<void> {
  console.log('=== Codebase Semantic Search — up ===\n');

  // Step 1: init if no .codesearchrc.json
  if (!fs.existsSync('.codesearchrc.json')) {
    console.log('[up] No .codesearchrc.json found — running init first...');
    await initCommand({ port: opts.port });
    console.log();
  } else {
    console.log(`[up] .codesearchrc.json already present. Using existing config.`);
  }

  // Step 2: start Milvus if not already running
  if (!(await isMilvusRunningAsync())) {
    startMilvus();
    console.log('[up] Waiting for Milvus to become healthy...');
    await waitForMilvus();
    console.log('[up] Milvus is up.');
  } else {
    console.log(`[up] Milvus already running on ${CONFIG.milvusHost}:${CONFIG.milvusPort}.`);
  }

  // Step 3: ensure Ollama + embedding model
  if (!isOllamaRunning()) {
    throw new Error(
      `Ollama not reachable at ${CONFIG.ollamaHost}. Start it and re-run 'codesearch up'.`,
    );
  }
  if (!hasEmbeddingModel()) {
    pullEmbeddingModel();
  } else {
    console.log(`[up] Embedding model "${CONFIG.embeddingModel}" already present.`);
  }

  // Step 4: ensure the collection exists, then run a full reindex if empty
  if (opts.index !== false) {
    await ensureCollection();
    const stats = await getCollectionStats();
    if (stats.count === 0) {
      console.log('[up] Collection is empty — running initial full reindex...');
      await runIndexer({ full: true });
      console.log();
    } else {
      console.log(`[up] Index already has ${stats.count.toLocaleString()} chunks. Skipping reindex.`);
      console.log('      (run `codesearch index --full` to force a rebuild)');
    }
  }

  // Step 5: start the dev loop (HTTP + watcher) unless told not to
  if (opts.serve !== false) {
    console.log('\n[up] Starting dev loop (HTTP :' + CONFIG.searchPort + ' + file watcher)...');
    console.log('      Press Ctrl+C to stop. Milvus will keep running.\n');
    await startServer();
    await startWatcher();
    process.stdin.resume();
  } else {
    console.log('\n[up] All set. Run `codesearch serve:watch` when ready.');
  }
}
