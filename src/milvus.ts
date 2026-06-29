import { MilvusClient, DataType, MetricType } from '@zilliz/milvus2-sdk-node';
import { CONFIG } from './config.js';
import type { Chunk } from './chunker.js';

let client: MilvusClient;

export function getMilvusClient(): MilvusClient {
  if (!client) {
    client = new MilvusClient({
      address: `${CONFIG.milvusHost}:${CONFIG.milvusPort}`,
    });
  }
  return client;
}

export async function ensureCollection(): Promise<void> {
  const milvus = getMilvusClient();
  const collectionName = CONFIG.collectionName;

  const hasCollection = await milvus.hasCollection({ collection_name: collectionName });

  if (hasCollection.value) {
    return;
  }

  console.log(`Creating collection "${collectionName}"...`);

  await milvus.createCollection({
    collection_name: collectionName,
    fields: [
      {
        name: 'id',
        data_type: DataType.VarChar,
        is_primary_key: true,
        max_length: 64,
      },
      {
        name: 'embedding',
        data_type: DataType.FloatVector,
        dim: CONFIG.embeddingDimensions,
      },
      { name: 'file_path', data_type: DataType.VarChar, max_length: 512 },
      { name: 'language', data_type: DataType.VarChar, max_length: 16 },
      { name: 'module', data_type: DataType.VarChar, max_length: 64 },
      { name: 'chunk_type', data_type: DataType.VarChar, max_length: 32 },
      { name: 'symbol_name', data_type: DataType.VarChar, max_length: 256 },
      { name: 'start_line', data_type: DataType.Int32 },
      { name: 'end_line', data_type: DataType.Int32 },
      { name: 'content', data_type: DataType.VarChar, max_length: 16384 },
      { name: 'last_modified', data_type: DataType.VarChar, max_length: 32 },
    ],
  });

  await milvus.createIndex({
    collection_name: collectionName,
    field_name: 'embedding',
    index_type: 'IVF_FLAT',
    metric_type: MetricType.COSINE,
    params: { nlist: 128 },
  });

  await milvus.loadCollection({ collection_name: collectionName });

  console.log(`Collection "${collectionName}" created and loaded.`);
}

export async function upsertChunks(
  chunks: Chunk[],
  embeddings: number[][],
): Promise<void> {
  const milvus = getMilvusClient();
  const collectionName = CONFIG.collectionName;

  if (chunks.length === 0) return;

  const batchSize = 100;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batchChunks = chunks.slice(i, i + batchSize);
    const batchEmbeddings = embeddings.slice(i, i + batchSize);

    const data = batchChunks.map((chunk, idx) => ({
      id: chunk.id,
      embedding: batchEmbeddings[idx],
      file_path: chunk.filePath,
      language: chunk.language,
      module: chunk.module,
      chunk_type: chunk.chunkType,
      symbol_name: chunk.symbolName || '',
      start_line: chunk.startLine,
      end_line: chunk.endLine,
      content: chunk.content.slice(0, 16000),
      last_modified: chunk.lastModified,
    }));

    await milvus.upsert({
      collection_name: collectionName,
      data,
    });
  }
}

export async function deleteByFilePaths(filePaths: string[]): Promise<void> {
  const milvus = getMilvusClient();
  const collectionName = CONFIG.collectionName;

  if (filePaths.length === 0) return;

  for (const fp of filePaths) {
    await milvus.delete({
      collection_name: collectionName,
      filter: `file_path == "${fp}"`,
    });
  }
}

export interface SearchResult {
  filePath: string;
  symbolName: string;
  chunkType: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  module: string;
  language: string;
}

export interface SearchFilters {
  module?: string;
  language?: string;
  chunkType?: string;
}

export async function searchChunks(
  queryEmbedding: number[],
  topK: number = 10,
  filters?: SearchFilters,
): Promise<SearchResult[]> {
  const milvus = getMilvusClient();
  const collectionName = CONFIG.collectionName;

  const filterParts: string[] = [];
  if (filters?.module) filterParts.push(`module == "${filters.module}"`);
  if (filters?.language) filterParts.push(`language == "${filters.language}"`);
  if (filters?.chunkType) filterParts.push(`chunk_type == "${filters.chunkType}"`);

  const filterExpr =
    filterParts.length > 0 ? filterParts.join(' && ') : undefined;

  const results = await milvus.search({
    collection_name: collectionName,
    vector: queryEmbedding,
    limit: topK,
    output_fields: [
      'file_path',
      'symbol_name',
      'chunk_type',
      'start_line',
      'end_line',
      'content',
      'module',
      'language',
    ],
    filter: filterExpr,
    params: { nprobe: 16 },
  });

  return (results.results || []).map((r: any) => ({
    filePath: r.file_path,
    symbolName: r.symbol_name,
    chunkType: r.chunk_type,
    startLine: r.start_line,
    endLine: r.end_line,
    content: r.content,
    score: r.score,
    module: r.module,
    language: r.language,
  }));
}

export async function getCollectionStats(): Promise<{ count: number }> {
  const milvus = getMilvusClient();
  const stats = await milvus.getCollectionStatistics({
    collection_name: CONFIG.collectionName,
  });
  const rowCount = stats.data?.row_count ?? stats.stats?.[0]?.value ?? 0;
  return { count: Number(rowCount) };
}

export async function dropCollection(): Promise<void> {
  const milvus = getMilvusClient();
  await milvus.dropCollection({ collection_name: CONFIG.collectionName });
  console.log(`Collection "${CONFIG.collectionName}" dropped.`);
}
