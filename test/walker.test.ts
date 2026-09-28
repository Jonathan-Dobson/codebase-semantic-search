import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// CONFIG is resolved from process.cwd() at import time, so point cwd at a throwaway
// project BEFORE importing the walker.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-walker-'));
fs.writeFileSync(path.join(root, '.codesearchrc.json'), JSON.stringify({
  indexDirs: ['README.md', 'docs', 'missing.md'],
}));
fs.writeFileSync(path.join(root, 'README.md'), '# Root readme\n');
fs.writeFileSync(path.join(root, 'NOT-LISTED.md'), '# not listed\n');
fs.mkdirSync(path.join(root, 'docs'));
fs.writeFileSync(path.join(root, 'docs', 'a.md'), '# A\n');
process.chdir(root);
const { walkFiles, getChangedFiles, pathsToClear } = await import('../src/walker.js');

test('indexDirs may name a single file', async () => {
  const files = (await walkFiles()).map((f) => f.relativePath).sort();
  assert.deepEqual(files, ['README.md', path.join('docs', 'a.md')]);
});

test('a file entry gets the root module and its real language', async () => {
  const readme = (await walkFiles()).find((f) => f.relativePath === 'README.md');
  assert.equal(readme?.module, 'root');
  assert.equal(readme?.language, 'markdown');
});

test('pathsToClear includes CHANGED files, not only removed ones', () => {
  const files = [
    { absolutePath: '', relativePath: 'kept.md', language: 'markdown', module: 'root', lastModified: 't1' },
    { absolutePath: '', relativePath: 'edited.md', language: 'markdown', module: 'root', lastModified: 't2' },
  ];
  const state = { lastIndexedAt: '', fileHashes: { 'kept.md': 't1', 'edited.md': 't1', 'gone.md': 't1' } };
  const changes = getChangedFiles(files, state);
  assert.deepEqual(changes.toIndex.map((f) => f.relativePath), ['edited.md']);
  assert.deepEqual(changes.toDelete, ['gone.md']);
  assert.deepEqual(pathsToClear(changes).sort(), ['edited.md', 'gone.md']);
});
