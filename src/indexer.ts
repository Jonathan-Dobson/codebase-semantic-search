/**
 * Reusable indexing library. Used by:
 *   - `codesearch index`        (one-shot incremental)
 *   - `codesearch index --full` (drop + rebuild)
 *   - `watcher.ts`              (event-driven incremental)
 *
 * Same logic, three callers.
 */
import {
  walkFiles,
  loadIndexState,
  saveIndexState,
  getChangedFiles,
  type IndexState,
} from './walker.js';
import { chunkFile, type Chunk } from './chunker.js';
import { embedBatch } from './embedder.js';
import {
  ensureCollection,
  upsertChunks,
  deleteByFilePaths,
  dropCollection,
  getCollectionStats,
} from './milvus.js';

const EMBED_BATCH = 20;

export interface IndexOptions {
  full?: boolean;
  dryRun?: boolean;
  onProgress?: (msg: string) => void;
}

export async function runIndexer(opts: IndexOptions = {}): Promise<void> {
  const { full = false, dryRun = false, onProgress } = opts;
  const startTime = Date.now();

  const log = (msg: string) => {
    console.log(msg);
    onProgress?.(msg);
  };

  log('=== Codebase Semantic Indexer ===\n');

  log('Scanning files...');
  const allFiles = await walkFiles();
  log(`  Found ${allFiles.length} files to consider.\n`);

  let filesToIndex = allFiles;
  let filesToDelete: string[] = [];

  if (!full) {
    const state = loadIndexState();
    const changes = getChangedFiles(allFiles, state);
    filesToIndex = changes.toIndex;
    filesToDelete = changes.toDelete;
    log(
      `  Incremental mode: ${filesToIndex.length} changed, ${filesToDelete.length} deleted.\n`,
    );
  } else {
    log('  Full reindex mode.\n');
  }

  if (dryRun) {
    log('DRY RUN — would index:');
    filesToIndex.slice(0, 20).forEach((f) => log(`  + ${f.relativePath}`));
    if (filesToIndex.length > 20)
      log(`  ... and ${filesToIndex.length - 20} more`);
    if (filesToDelete.length > 0) {
      log('\nWould delete stale chunks for:');
      filesToDelete.slice(0, 10).forEach((p) => log(`  - ${p}`));
    }
    return;
  }

  if (full) {
    try {
      await dropCollection();
    } catch {
      /* may not exist */
    }
  }
  await ensureCollection();

  if (filesToDelete.length > 0) {
    log(`Deleting stale chunks for ${filesToDelete.length} files...`);
    await deleteByFilePaths(filesToDelete);
  }

  log('Chunking files...');
  const allChunks: Chunk[] = [];
  for (const file of filesToIndex) {
    try {
      allChunks.push(...chunkFile(file));
    } catch (err: any) {
      console.warn(`  chunking failed for ${file.relativePath}: ${err.message}`);
    }
  }
  log(`  Generated ${allChunks.length} chunks from ${filesToIndex.length} files.\n`);

  if (allChunks.length === 0) {
    log('Nothing to index. All up to date.');
    return;
  }

  const totalBatches = Math.ceil(allChunks.length / EMBED_BATCH);
  log(`Embedding and upserting ${allChunks.length} chunks in ${totalBatches} batches...`);

  for (let i = 0; i < allChunks.length; i += EMBED_BATCH) {
    const batch = allChunks.slice(i, i + EMBED_BATCH);
    const batchNum = Math.floor(i / EMBED_BATCH) + 1;

    const texts = batch.map((c) => c.content);
    const embeddings = await embedBatch(texts, EMBED_BATCH);

    await upsertChunks(batch, embeddings);

    const pct = Math.round((batchNum / totalBatches) * 100);
    process.stdout.write(
      `\r  Progress: ${batchNum}/${totalBatches} (${pct}%)`,
    );
  }
  process.stdout.write('\n\n');

  const fileHashes: Record<string, string> = {};
  for (const file of allFiles) {
    fileHashes[file.relativePath] = file.lastModified;
  }
  const newState: IndexState = {
    lastIndexedAt: new Date().toISOString(),
    fileHashes,
  };
  saveIndexState(newState);

  const stats = await getCollectionStats();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Done! ${stats.count} total chunks in collection. Took ${elapsed}s.`);
}
