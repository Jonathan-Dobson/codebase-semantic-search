import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'fs';
import path from 'path';
import ignore from 'ignore';
import { CONFIG } from './config.js';
import {
  walkFiles,
  loadIndexState,
  saveIndexState,
  getChangedFiles,
  type IndexState,
} from './walker.js';
import { chunkFile, type Chunk } from './chunker.js';
import { embedBatch } from './embedder.js';
import { ensureCollection, upsertChunks, deleteByFilePaths } from './milvus.js';

// After the last file event, wait this long before re-indexing. Lets bursts
// of editor saves (which fire multiple events) collapse into a single run.
const DEBOUNCE_MS = 1500;

const EMBED_BATCH = 20;

let debounceTimer: NodeJS.Timeout | null = null;
let inFlight = false;
const pendingReasons: string[] = [];

function buildIgnoreMatcher() {
  const ig = ignore();
  const gitignorePath = path.join(CONFIG.workspaceRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
  }
  ig.add(CONFIG.excludePatterns);

  return (absolutePath: string): boolean => {
    const rel = path.relative(CONFIG.workspaceRoot, absolutePath);
    if (!rel || rel.startsWith('..')) return true;

    const underIndexDir = CONFIG.indexDirs.some(
      (d) => rel === d || rel.startsWith(d + path.sep),
    );
    if (!underIndexDir) return true;

    return ig.ignores(rel);
  };
}

async function runIncremental(reason: string): Promise<void> {
  if (inFlight) {
    pendingReasons.push(reason);
    return;
  }
  inFlight = true;
  const start = Date.now();
  console.log(`\n[watch] ${reason} -> running incremental reindex...`);

  try {
    const allFiles = await walkFiles();
    const state = loadIndexState();
    const { toIndex, toDelete } = getChangedFiles(allFiles, state);

    if (toIndex.length === 0 && toDelete.length === 0) {
      console.log('[watch] No actual changes detected. Skipping.');
      return;
    }

    if (toDelete.length > 0) {
      console.log(
        `[watch] Deleting chunks for ${toDelete.length} removed file(s)...`,
      );
      await deleteByFilePaths(toDelete);
    }

    const allChunks: Chunk[] = [];
    for (const file of toIndex) {
      try {
        allChunks.push(...chunkFile(file));
      } catch (err: any) {
        console.warn(
          `[watch] chunking failed for ${file.relativePath}: ${err.message}`,
        );
      }
    }
    console.log(
      `[watch] Re-embedding ${allChunks.length} chunk(s) from ${toIndex.length} file(s)...`,
    );

    if (allChunks.length > 0) {
      for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
        const batch = allChunks.slice(i, i + EMBED_BATCH);
        const embeddings = await embedBatch(
          batch.map((c) => c.content),
          EMBED_BATCH,
        );
        await upsertChunks(batch, embeddings);
        const pct = Math.round(((i + batch.length) / allChunks.length) * 100);
        process.stdout.write(
          `\r[watch] progress: ${pct}% (${i + batch.length}/${allChunks.length})`,
        );
      }
      process.stdout.write('\n');
    }

    const fileHashes: Record<string, string> = {};
    for (const f of allFiles) fileHashes[f.relativePath] = f.lastModified;
    const newState: IndexState = {
      lastIndexedAt: new Date().toISOString(),
      fileHashes,
    };
    saveIndexState(newState);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(
      `[watch] Done in ${elapsed}s (re-indexed ${toIndex.length}, removed ${toDelete.length}).`,
    );
  } catch (err: any) {
    console.error(`[watch] reindex failed: ${err.message}`);
  } finally {
    inFlight = false;
    if (pendingReasons.length > 0) {
      const next = pendingReasons.shift()!;
      setTimeout(() => {
        void runIncremental(next);
      }, 200);
    }
  }
}

function scheduleReindex(reason: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void runIncremental(reason);
  }, DEBOUNCE_MS);
}

export async function startWatcher(): Promise<FSWatcher> {
  console.log('[watch] Starting file watcher...');
  console.log(`[watch] Watching: ${CONFIG.indexDirs.join(', ')}`);

  await ensureCollection();

  const watchPaths = CONFIG.indexDirs.map((d) =>
    path.join(CONFIG.workspaceRoot, d),
  );
  const isIgnored = buildIgnoreMatcher();

  const watcher = chokidar.watch(watchPaths, {
    ignored: isIgnored,
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher
    .on('add', (p) => {
      const rel = path.relative(CONFIG.workspaceRoot, p);
      console.log(`[watch] + ${rel}`);
      scheduleReindex('file added');
    })
    .on('change', (p) => {
      const rel = path.relative(CONFIG.workspaceRoot, p);
      console.log(`[watch] ~ ${rel}`);
      scheduleReindex('file changed');
    })
    .on('unlink', (p) => {
      const rel = path.relative(CONFIG.workspaceRoot, p);
      console.log(`[watch] - ${rel}`);
      scheduleReindex('file removed');
    })
    .on('ready', () => {
      console.log(
        '[watch] Initial scan complete. Watching for changes... (Ctrl+C to stop)',
      );
    })
    .on('error', (err) => {
      console.error('[watch] error:', err);
    });

  return watcher;
}
