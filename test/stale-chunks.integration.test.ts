// Integration test against a REAL Milvus + Ollama, in a throwaway collection that is dropped
// afterwards. Opt-in, because it needs the stack running:
//
//   CODESEARCH_IT=1 npm test
//
// It reproduces the stale-chunk bug end to end: index a file, insert lines at the top (so
// every chunk boundary moves), re-index incrementally, and require that the collection holds
// exactly the chunks the current file produces — nothing left over from the old version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const enabled = process.env.CODESEARCH_IT === '1';
const collection = `csearch_it_${process.pid}_${Date.now()}`;

test('incremental reindex of an edited file leaves no stale chunks', { skip: !enabled && 'set CODESEARCH_IT=1' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-it-'));
  fs.writeFileSync(path.join(root, '.codesearchrc.json'), JSON.stringify({
    indexDirs: ['docs'], collectionName: collection, maxChunkTokens: 200, chunkOverlapLines: 2,
  }));
  fs.mkdirSync(path.join(root, 'docs'));
  const file = path.join(root, 'docs', 'guide.md');
  const body = Array.from({ length: 6 }, (_, s) =>
    `## Section ${s}\n` + Array.from({ length: 30 }, (_, l) => `Line ${l} of section ${s} explains something.`).join('\n'),
  ).join('\n\n');
  fs.writeFileSync(file, `# Guide\n\n${body}\n`);
  process.chdir(root);

  const { runIndexer } = await import('../src/indexer.js');
  const { chunkFile } = await import('../src/chunker.js');
  const { walkFiles } = await import('../src/walker.js');
  const { getMilvusClient, dropCollection } = await import('../src/milvus.js');
  const { CONFIG } = await import('../src/config.js');
  // This test drops its collection at the end. Refuse to run at all unless CONFIG really
  // resolved to the throwaway collection — never risk dropping a real index.
  assert.equal(CONFIG.collectionName, collection, 'refusing to run: CONFIG did not pick up the throwaway collection');
  const quiet = console.log;
  console.log = () => {};
  try {
    await runIndexer({});

    // Insert lines at the top: every chunk's start line moves, so every id changes.
    const later = new Date(Date.now() + 5000);
    fs.writeFileSync(file, `# Guide\n\nA new intro paragraph.\nAnother line.\nAnd a third.\n\n${body}\n`);
    fs.utimesSync(file, later, later);
    await runIndexer({});

    const milvus = getMilvusClient();
    const res = await milvus.query({
      collection_name: collection,
      filter: 'file_path == "docs/guide.md"',
      output_fields: ['start_line', 'end_line'],
      consistency_level: 'Strong' as any,
    });
    const stored = res.data.map((r: any) => `${r.start_line}-${r.end_line}`).sort();
    const [entry] = (await walkFiles()).filter((f) => f.relativePath === path.join('docs', 'guide.md'));
    const expected = chunkFile(entry).map((c) => `${c.startLine}-${c.endLine}`).sort();
    assert.deepEqual(stored, expected, `stale chunks left in the collection: ${stored.filter((s) => !expected.includes(s)).join(', ')}`);
  } finally {
    console.log = quiet;
    if (CONFIG.collectionName === collection) await dropCollection().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
