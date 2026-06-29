import { CONFIG } from './config.js';

interface EmbeddingResponse {
  embedding: number[];
}

export async function embedText(text: string): Promise<number[]> {
  // nomic-embed-text requires a prefix for better results
  // Truncate to fit model context (~4000 char limit for nomic-embed-text)
  const truncated = text.slice(0, 3500);
  const prefixedText = `search_document: ${truncated}`;

  const response = await fetch(`${CONFIG.ollamaHost}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.embeddingModel,
      prompt: prefixedText,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Ollama embedding failed: ${response.status} ${response.statusText} - ${body.slice(0, 200)}`,
    );
  }

  const data = (await response.json()) as EmbeddingResponse;
  return data.embedding;
}

export async function embedQuery(query: string): Promise<number[]> {
  // nomic-embed-text uses different prefix for queries
  const prefixedQuery = `search_query: ${query}`;

  const response = await fetch(`${CONFIG.ollamaHost}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CONFIG.embeddingModel,
      prompt: prefixedQuery,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Ollama embedding failed: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as EmbeddingResponse;
  return data.embedding;
}

export async function embedBatch(
  texts: string[],
  batchSize = 10,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await Promise.all(
      batch.map(async (t) => {
        try {
          return await embedText(t);
        } catch (err: any) {
          console.warn(
            `\n  Warning: embedding failed for text (${t.length} chars): ${err.message}`,
          );
          // Return zero vector as fallback
          return new Array(CONFIG.embeddingDimensions).fill(0);
        }
      }),
    );
    results.push(...embeddings);

    if (i + batchSize < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return results;
}
