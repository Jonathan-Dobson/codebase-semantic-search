import express, { type Express, type Request, type Response } from 'express';
import { embedQuery } from './embedder.js';
import {
  ensureCollection,
  searchChunks,
  getCollectionStats,
  type SearchFilters,
  type SearchResult,
} from './milvus.js';
import { CONFIG } from './config.js';
import { putClip, getClip, clipStoreSize } from './clip-store.js';
import { readFileSlice, READ_MAX_RANGE, READ_MAX_FILE_SIZE } from './read-clip.js';

// Cap on batch ids per /clips request. Keeps response payloads bounded
// even if a caller dumps the entire store into one request.
const MAX_BATCH_IDS = 500;

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
      const { query, top_k = 10, module, language, chunk_type, min_score } = req.body;

      if (!query || typeof query !== 'string') {
        res
          .status(400)
          .json({ success: false, error: 'query is required and must be a string' });
        return;
      }

      const topK = Math.min(Math.max(1, Number(top_k) || 10), 50);

      // Optional min_score filter: drop hits below the threshold AFTER the
      // vector search. This means we may return fewer than top_k — the
      // caller asked for "up to top_k results that score >= min_score",
      // which is a quality filter, not a guarantee of count. Bump top_k
      // if you need a guaranteed minimum count.
      let minScore = 0;
      let minScoreApplied = false;
      if (min_score !== undefined && min_score !== null) {
        const parsed = Number(min_score);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          res.status(400).json({
            success: false,
            error: 'min_score must be a finite number between 0 and 1 (inclusive)',
          });
          return;
        }
        minScore = parsed;
        minScoreApplied = true;
      }

      const filters: SearchFilters = {};
      if (module) filters.module = String(module);
      if (language) filters.language = String(language);
      if (chunk_type) filters.chunkType = String(chunk_type);

      const queryEmbedding = await embedQuery(query);
      const rawResults = await searchChunks(queryEmbedding, topK, filters);

      // Apply min_score filter (if any) before registering clips, so the
      // clip store doesn't accumulate entries the caller never saw.
      const filtered = minScoreApplied
        ? rawResults.filter((r) => r.score >= minScore)
        : rawResults;

      // Register each surviving hit in the in-memory clip store so callers
      // can fetch the full text by short numeric id via /clip/:id. Dedup
      // is keyed on (filePath, startLine, endLine).
      const resultsWithIds = filtered.map((r: SearchResult) => ({
        id: putClip(r.filePath, r.startLine, r.endLine),
        filePath: r.filePath,
        symbolName: r.symbolName || null,
        chunkType: r.chunkType,
        startLine: r.startLine,
        endLine: r.endLine,
        score: Number(r.score.toFixed(4)),
        module: r.module,
        language: r.language,
        content: r.content,
      }));

      const data: Record<string, unknown> = {
        query,
        results: resultsWithIds,
        count: resultsWithIds.length,
        topK,
        clipStoreSize: clipStoreSize(),
      };
      if (minScoreApplied) {
        data.minScore = minScore;
        data.candidatesBeforeFilter = rawResults.length;
      }

      res.json({
        success: true,
        data,
      });
    } catch (err: any) {
      console.error('Search error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /read — fetch a slice of a file by 1-indexed inclusive line range.
  // Semantics match `sed -n '<start>,<end>p' <filePath>`. Companion to
  // /search: every search hit carries a startLine/endLine, and the agent can
  // pass those straight back here to expand the surrounding context without
  // re-loading the whole file. For the short-id shortcut workflow, see
  // GET /clip/:id and GET|POST /clips.
  app.post('/read', async (req, res) => {
    try {
      const { filePath, startLine, endLine } = req.body ?? {};
      const result = await readFileSlice(filePath, startLine, endLine);
      if (!result.ok) {
        res.status(result.error.statusCode).json({
          success: false,
          error: result.error.message,
        });
        return;
      }
      const { filePath: fp, startLine: s, endLine: e, totalLines, content } =
        result.clip;
      res.json({
        success: true,
        data: {
          filePath: fp,
          startLine: s,
          endLine: e,
          totalLines,
          rangeRequested: { startLine, endLine },
          content,
        },
      });
    } catch (err: any) {
      console.error('Read error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /clip/:id — fetch a single clip by its short numeric id.
  // Ids are assigned by /search; the underlying (filePath, startLine,
  // endLine) is stored in an in-memory table (FIFO eviction at 10K entries,
  // server restart clears the table — see clip-store.ts).
  app.get('/clip/:id', async (req: Request<{ id: string }>, res: Response) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) {
        res.status(400).json({ success: false, error: 'id must be a positive integer' });
        return;
      }
      const ref = getClip(id);
      if (!ref) {
        res.status(404).json({
          success: false,
          error: `id ${id} not found or expired. Re-run /search to get a fresh id.`,
        });
        return;
      }
      const result = await readFileSlice(ref.filePath, ref.startLine, ref.endLine);
      if (!result.ok) {
        res.status(result.error.statusCode).json({
          success: false,
          error: `id ${id}: ${result.error.message}`,
        });
        return;
      }
      res.json({
        success: true,
        data: {
          id,
          ...result.clip,
        },
      });
    } catch (err: any) {
      console.error('Clip error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /clips?ids=1,2,3 — batch fetch with comma-separated ids in the
  // query string. Use this for small batches (curl-friendly, cacheable).
  // For larger batches, prefer POST /clips.
  app.get('/clips', async (req: Request, res: Response) => {
    try {
      const raw = req.query.ids;
      const idList = parseIdsParam(raw);
      if (idList === null) {
        res.status(400).json({
          success: false,
          error: 'ids query param is required (e.g. ?ids=1,2,3 or ?ids=1&ids=2&ids=3)',
        });
        return;
      }
      if (idList.length === 0) {
        res.status(400).json({ success: false, error: 'ids must contain at least one id' });
        return;
      }
      if (idList.length > MAX_BATCH_IDS) {
        res.status(400).json({
          success: false,
          error: `Too many ids: ${idList.length} (max ${MAX_BATCH_IDS}). Use POST /clips for larger batches, or split into multiple requests.`,
        });
        return;
      }
      res.json({
        success: true,
        data: await resolveBatch(idList),
      });
    } catch (err: any) {
      console.error('Clips (GET) error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /clips { ids: [...] } — batch fetch with a JSON body. Use this for
  // larger batches where the query-string approach gets unwieldy.
  app.post('/clips', async (req: Request, res: Response) => {
    try {
      const { ids } = req.body ?? {};
      if (!Array.isArray(ids)) {
        res.status(400).json({
          success: false,
          error: 'ids is required and must be an array of positive integers',
        });
        return;
      }
      if (ids.length === 0) {
        res.status(400).json({ success: false, error: 'ids must contain at least one id' });
        return;
      }
      if (ids.length > MAX_BATCH_IDS) {
        res.status(400).json({
          success: false,
          error: `Too many ids: ${ids.length} (max ${MAX_BATCH_IDS}). Split into multiple requests.`,
        });
        return;
      }
      // Validate each id is a positive integer.
      const normalized: number[] = [];
      for (const v of ids) {
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
          res.status(400).json({
            success: false,
            error: `Invalid id: ${JSON.stringify(v)} — must be a positive integer`,
          });
          return;
        }
        normalized.push(v);
      }
      res.json({
        success: true,
        data: await resolveBatch(normalized),
      });
    } catch (err: any) {
      console.error('Clips (POST) error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app;
}

// ---------- helpers ----------

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Parse the `ids` query param for GET /clips. Accepts either a single
 * comma-separated string (`?ids=1,2,3`) or a repeated parameter
 * (`?ids=1&ids=2&ids=3`). Returns null if no ids param is present at all.
 */
function parseIdsParam(raw: unknown): number[] | null {
  if (raw === undefined) return null;
  const parts: string[] = [];
  if (typeof raw === 'string') {
    parts.push(...raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
  } else if (Array.isArray(raw)) {
    for (const v of raw) {
      if (typeof v !== 'string') return null;
      parts.push(...v.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    }
  } else {
    return null;
  }
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isInteger(n) || n < 1) return null;
    out.push(n);
  }
  return out;
}

interface BatchItemOk {
  id: number;
  success: true;
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
}
interface BatchItemErr {
  id: number;
  success: false;
  error: string;
}
type BatchItem = BatchItemOk | BatchItemErr;

async function resolveBatch(ids: number[]): Promise<{
  results: BatchItem[];
  requested: number;
  succeeded: number;
  failed: number;
}> {
  const results: BatchItem[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    const ref = getClip(id);
    if (!ref) {
      results.push({
        id,
        success: false,
        error: 'id not found or expired. Re-run /search to get a fresh id.',
      });
      failed++;
      continue;
    }
    const result = await readFileSlice(ref.filePath, ref.startLine, ref.endLine);
    if (!result.ok) {
      results.push({ id, success: false, error: result.error.message });
      failed++;
      continue;
    }
    results.push({ id, success: true, ...result.clip });
    succeeded++;
  }
  return { results, requested: ids.length, succeeded, failed };
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
    console.log(`  POST /search             — semantic search (returns results with short numeric ids)`);
    console.log(`  POST /read               — fetch a slice of a file by line range`);
    console.log(`  GET  /clip/:id           — fetch one clip by its short id (from /search results)`);
    console.log(`  GET  /clips?ids=1,2,3    — batch fetch (small batches, curl-friendly)`);
    console.log(`  POST /clips  {ids:[..]}  — batch fetch (large batches)`);
    console.log(`  GET  /stats              — collection stats`);
    console.log(`  GET  /health             — health check`);
    console.log(`\n  Clip store: in-memory, FIFO evict @ ${10000} entries, ${READ_MAX_FILE_SIZE / 1024 / 1024} MB file cap, ${READ_MAX_RANGE} line range cap per call`);
  });
}
