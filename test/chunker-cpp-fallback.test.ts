import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Simulate an absent or unloadable native grammar BEFORE the chunker resolves
// it. The loader is memoised per module instance and node's test runner gives
// every test file its own process, so this cannot leak into chunker-cpp.test.ts.
const cjsModule = Module as unknown as {
  _load: (request: string, ...rest: unknown[]) => unknown;
};
const originalLoad = cjsModule._load;
cjsModule._load = function patchedLoad(request: string, ...rest: unknown[]) {
  if (request === 'tree-sitter' || request === 'tree-sitter-cpp') {
    throw new Error('simulated: native grammar unavailable');
  }
  return originalLoad.call(this, request, ...rest);
};

// The grammar is loaded lazily on the first C++ chunk, not at import time, so the
// capture has to stay installed until after the tests have chunked something.
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(' '));
};
test.after(() => {
  console.warn = originalWarn;
});

const { chunkFile } = await import('../src/chunker.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-cpp-nogrammar-'));
const absolutePath = path.join(root, 'NoGrammar.cpp');
const source = [
  '#include <xrpl/tx/Transactor.h>',
  '',
  'namespace ripple {',
  '',
  'TERet',
  'SponsorshipTransfer::preflight(Ctx const& ctx)',
  '{',
  '    return temSUCCESS;',
  '}',
  '',
  '} // namespace ripple',
  '',
].join('\n');
fs.writeFileSync(absolutePath, source);

const file = {
  absolutePath,
  relativePath: path.join('src', 'NoGrammar.cpp'),
  language: 'cpp',
  module: 'src',
  lastModified: fs.statSync(absolutePath).mtime.toISOString(),
};

test('a missing native grammar degrades to line chunking instead of throwing', () => {
  let chunks;
  assert.doesNotThrow(() => {
    chunks = chunkFile(file);
  });

  chunks = chunks!;
  assert.ok(chunks.length > 0, 'the fallback must still produce chunks');
  for (const c of chunks) {
    assert.equal(c.chunkType, 'block', 'the fallback signature is chunkType block');
    assert.equal(c.symbolName, '');
    assert.equal(c.language, 'cpp');
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
  }
});

test('the missing grammar is reported once, not once per file', () => {
  const grammarWarnings = warnings.filter((w) => w.includes('tree-sitter-cpp'));
  assert.equal(grammarWarnings.length, 1, `expected exactly one warning, got ${grammarWarnings.length}`);
  assert.match(grammarWarnings[0], /falling back/i);
});