import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkByLines } from '../src/chunker.js';

// Every chunk must add at least one line the previous chunk did not cover.
function assertNoSubsetWindows(chunks: { startLine: number; endLine: number }[]) {
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(
      chunks[i].endLine > chunks[i - 1].endLine,
      `chunk ${chunks[i].startLine}-${chunks[i].endLine} adds nothing to ${chunks[i - 1].startLine}-${chunks[i - 1].endLine}`,
    );
  }
}

function assertCoversEveryLine(content: string, chunks: { startLine: number; endLine: number }[]) {
  const n = content.split('\n').length;
  const covered = new Set<number>();
  for (const c of chunks) for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
  for (let l = 1; l <= n; l++) {
    if (content.split('\n')[l - 1].trim()) assert.ok(covered.has(l), `line ${l} not covered`);
  }
}

test('long lines (fewer lines per chunk than the overlap) do not produce a one-line crawl', () => {
  // A markdown table whose rows are ~900 chars: at maxTokens=800 (~3200 chars) each chunk
  // holds 3 rows, fewer than overlap=5. Before the fix: 1-3, 2-4, 3-5, 4-6 ...
  const row = (i: number) => `| row ${i} | ${'x'.repeat(900)} |`;
  const content = Array.from({ length: 12 }, (_, i) => row(i + 1)).join('\n');
  const chunks = chunkByLines(content, 800, 5);
  assertNoSubsetWindows(chunks);
  assertCoversEveryLine(content, chunks);
  assert.ok(chunks.length <= 6, `expected ~4 chunks for 12 rows, got ${chunks.length}`);
});

test('ordinary short lines still overlap by `overlap` lines', () => {
  const content = Array.from({ length: 400 }, (_, i) => `line ${i + 1} some code here`).join('\n');
  const chunks = chunkByLines(content, 800, 5);
  assert.ok(chunks.length > 1);
  assertNoSubsetWindows(chunks);
  assertCoversEveryLine(content, chunks);
  for (let i = 1; i < chunks.length; i++) {
    assert.equal(chunks[i].startLine, chunks[i - 1].endLine - 5 + 1, 'overlap preserved');
  }
});

test('a single line larger than maxTokens still terminates and is emitted once', () => {
  const content = ['short', 'y'.repeat(10000), 'short again'].join('\n');
  const chunks = chunkByLines(content, 800, 5);
  assertNoSubsetWindows(chunks);
  assertCoversEveryLine(content, chunks);
  assert.equal(chunks.filter((c) => c.startLine <= 2 && c.endLine >= 2).length, 1);
});
