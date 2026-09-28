import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedBatch } from '../src/embedder.js';

test('a failed embedding comes back as null, not a zero vector', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('ollama down'); });
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await embedBatch(['a', 'b']), [null, null]);
});
