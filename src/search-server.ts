import express, { type Express } from 'express';
import { embedQuery } from './embedder.js';
import {
  ensureCollection,
  searchChunks,
  getCollectionStats,
  type SearchFilters,
} from './milvus.js';
import { CONFIG } from './config.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', collection: CONFIG.collectionName });
  });

  app.get('/stats', async (_req, res) => {
    try {
      const stats = await getCollectionStats();
      res.json({ success: true, data: stats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/search', async (req, res) => {
    try {
      const { query, top_k = 10, module, language, chunk_type } = req.body;

      if (!query || typeof query !== 'string') {
        res
          .status(400)
          .json({ success: false, error: 'query is required and must be a string' });
        return;
      }

      const topK = Math.min(Math.max(1, Number(top_k) || 10), 50);

      const filters: SearchFilters = {};
      if (module) filters.module = String(module);
      if (language) filters.language = String(language);
      if (chunk_type) filters.chunkType = String(chunk_type);

      const queryEmbedding = await embedQuery(query);
      const results = await searchChunks(queryEmbedding, topK, filters);

      res.json({
        success: true,
        data: {
          query,
          results,
          count: results.length,
        },
      });
    } catch (err: any) {
      console.error('Search error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app;
}

export async function startServer(): Promise<void> {
  await ensureCollection();
  const stats = await getCollectionStats();
  console.log(`Collection has ${stats.count} chunks indexed.`);

  const app = createApp();
  app.listen(CONFIG.searchPort, () => {
    console.log(
      `\nCodebase Semantic Search API running at http://localhost:${CONFIG.searchPort}`,
    );
    console.log(`  POST /search  — semantic search`);
    console.log(`  GET  /stats   — collection stats`);
    console.log(`  GET  /health  — health check\n`);
  });
}
