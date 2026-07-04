/**
 * Markdown renderer for /search and `codebase_semantic_search` results.
 *
 * Produces a single document with:
 *   - a "# Search: ..." title and one-line summary
 *   - per-hit code fence (language hint from the chunker) followed by a
 *     metadata caption line
 *   - '---' separators between hits
 *
 * The caption uses plain text (no backticks) per design call — keeps the
 * line visually subordinate to the code fence above it.
 *
 * Shared between the HTTP server (src/search-server.ts) and the MCP server
 * (src/mcp-server.ts) so both renderers stay in lockstep.
 */

export interface MarkdownHit {
  id: number;
  filePath: string;
  symbolName: string | null;
  score: number;
  startLine: number;
  endLine: number;
  content: string;
  language?: string;
  chunkType?: string;
  module?: string;
}

export interface MarkdownArgs {
  query: string;
  count: number;
  topK: number;
  minScore?: number;
  includedFields?: string[];
  clipStoreSize: number;
  hits: MarkdownHit[];
}

export function renderSearchMarkdown(args: MarkdownArgs): string {
  const out: string[] = [];
  out.push(`# Search: "${args.query}"`);
  out.push('');

  const summary: string[] = [];
  summary.push(`${args.count} ${args.count === 1 ? 'result' : 'results'}`);
  summary.push(`top_k: ${args.topK}`);
  if (args.minScore !== undefined) summary.push(`min_score: ${args.minScore}`);
  if (args.includedFields && args.includedFields.length > 0) {
    summary.push(`included: ${args.includedFields.join(', ')}`);
  }
  summary.push(`clip store: ${args.clipStoreSize}`);
  out.push(summary.join(' • '));
  out.push('');

  if (args.count === 0) {
    return out.join('\n');
  }

  for (let i = 0; i < args.hits.length; i++) {
    const h = args.hits[i];
    out.push('---');
    out.push('');

    // Sanitize the language hint for the code fence — only alphanumerics,
    // `+`, `#`, `-` are recognized by GitHub-flavored markdown. Anything
    // else falls back to `text` (no highlighting).
    const fenceLang = (h.language || 'text')
      .toLowerCase()
      .replace(/[^a-z0-9+#-]/g, '');
    out.push('```' + fenceLang);
    // Trim trailing newlines so the fence closes cleanly.
    out.push(h.content.replace(/\n+$/, ''));
    out.push('```');
    out.push('');

    const cap: string[] = [];
    cap.push(`${h.filePath}:${h.startLine}-${h.endLine}`);
    if (h.symbolName) cap.push(h.symbolName);
    cap.push(`score: ${h.score}`);
    if (h.chunkType) cap.push(`chunkType: ${h.chunkType}`);
    if (h.module) cap.push(`module: ${h.module}`);
    cap.push(`id: ${h.id}`);
    out.push(cap.join(' • '));
    out.push('');
  }

  // Drop the trailing blank line — markdown renderers tolerate it but
  // it's slightly cleaner without.
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}