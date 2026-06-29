import { ensureCollection, getCollectionStats } from '../milvus.js';
import { CONFIG } from '../config.js';

export async function statusCommand(): Promise<void> {
  console.log('=== Codebase Semantic Search — status ===\n');

  console.log('Configuration:');
  console.log(`  Workspace root:   ${CONFIG.workspaceRoot}`);
  console.log(`  Index dirs:       ${CONFIG.indexDirs.join(', ')}`);
  console.log(`  Embedding model:  ${CONFIG.embeddingModel} (${CONFIG.embeddingDimensions}-dim)`);
  console.log(`  Ollama host:      ${CONFIG.ollamaHost}`);
  console.log(`  Milvus host:      ${CONFIG.milvusHost}:${CONFIG.milvusPort}`);
  console.log(`  Collection:       ${CONFIG.collectionName}`);
  console.log(`  Search port:      ${CONFIG.searchPort}`);
  console.log(`  MCP server name:  ${CONFIG.mcpServerName}\n`);

  try {
    await ensureCollection();
    const stats = await getCollectionStats();
    console.log(`Collection: ${stats.count.toLocaleString()} chunks indexed.`);
  } catch (err: any) {
    console.error(`Milvus unreachable: ${err.message}`);
    console.error('  Start it with:  docker compose -f docker-compose.search.yml up -d');
    process.exit(1);
  }
}
