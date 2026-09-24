import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairEmbedded } from '../src/milvus.js';
import type { Chunk } from '../src/chunker.js';

const chunk = (startLine: number): Chunk => ({
  id: String(startLine), content: 'x', filePath: 'f.md', language: 'markdown', module: 'root',
  chunkType: 'section', symbolName: '', startLine, endLine: startLine, lastModified: '',
});

test('a chunk whose embedding failed is skipped, not stored', () => {
  const { kept, skipped } = pairEmbedded([chunk(1), chunk(2), chunk(3)], [[0.1], null, [0.3]]);
  assert.deepEqual(kept.map(([c]) => c.startLine), [1, 3]);
  assert.deepEqual(skipped.map((c) => c.startLine), [2]);
});
