import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// CONFIG is resolved from process.cwd() at import time, so point cwd at a throwaway
// project BEFORE importing the walker. Same pattern as walker.test.ts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-cpp-'));
fs.mkdirSync(path.join(root, 'cpp'));
fs.writeFileSync(
  path.join(root, '.codesearchrc.json'),
  JSON.stringify({ indexDirs: ['cpp'] }),
);

// A fixture shaped like rippled's Transactor.cpp: enough lines that the line
// chunker must emit more than one window.
const cpp = Array.from(
  { length: 120 },
  (_, i) => `    int line_${i + 1} = ${i + 1};`,
).join('\n');
fs.writeFileSync(
  path.join(root, 'cpp', 'Transactor.cpp'),
  `#include <xrpl/tx/Transactor.h>\n\nnamespace ripple {\n\n${cpp}\n\n} // namespace ripple\n`,
);
fs.writeFileSync(
  path.join(root, 'cpp', 'Transactor.h'),
  `#pragma once\n\nnamespace ripple {\n\n${cpp}\n\n} // namespace ripple\n`,
);
// Other mapped C++ extensions must be collected too.
fs.writeFileSync(path.join(root, 'cpp', 'a.hpp'), '#pragma once\nint a();\n');
fs.writeFileSync(path.join(root, 'cpp', 'b.ipp'), '#pragma once\ninline int b() { return 1; }\n');
fs.writeFileSync(path.join(root, 'cpp', 'c.cc'), 'int c() { return 1; }\n');
fs.writeFileSync(path.join(root, 'cpp', 'd.cxx'), 'int d() { return 1; }\n');
// Control: still unmapped, so the walker must keep dropping it.
fs.writeFileSync(path.join(root, 'cpp', 'e.xyz'), 'not a real language\n');

process.chdir(root);
const { walkFiles } = await import('../src/walker.js');
const { chunkFile } = await import('../src/chunker.js');

test('the walker collects C++ files instead of silently skipping them', async () => {
  const files = (await walkFiles()).map((f) => f.relativePath).sort();
  assert.deepEqual(files, [
    path.join('cpp', 'Transactor.cpp'),
    path.join('cpp', 'Transactor.h'),
    path.join('cpp', 'a.hpp'),
    path.join('cpp', 'b.ipp'),
    path.join('cpp', 'c.cc'),
    path.join('cpp', 'd.cxx'),
  ]);
});

test('C++ files are tagged as cpp and land in the cpp module', async () => {
  const files = await walkFiles();
  const cppFile = files.find((f) => f.relativePath.endsWith('Transactor.cpp'));
  assert.equal(cppFile?.language, 'cpp');
  assert.equal(cppFile?.module, 'cpp');
  assert.ok(fs.statSync(cppFile!.absolutePath).mtime.toISOString() === cppFile!.lastModified);
});

test('chunkFile on a .cpp fixture returns non-empty chunks', async () => {
  const files = await walkFiles();
  const cppFile = files.find((f) => f.relativePath.endsWith('Transactor.cpp'))!;

  const chunks = chunkFile(cppFile);
  assert.ok(chunks.length > 0, 'expected at least one chunk');
  for (const c of chunks) {
    assert.equal(c.language, 'cpp');
    assert.ok(c.content.trim().length > 0);
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
  }
  // The fixture is 120 statements inside `namespace ripple`. The AST path walks the
  // namespace and emits one named chunk per declaration; `chunkType === 'block'`
  // with an empty symbolName is the chunkFallback() signature, i.e. the old
  // placeholder this replaced.
  assert.equal(chunks.length, 120, 'expected one chunk per declaration inside the namespace');
  assert.ok(
    chunks.every((c) => c.chunkType === 'variable' && /^line_\d+$/.test(c.symbolName)),
    `expected per-declaration variable chunks, got ${[...new Set(chunks.map((c) => `${c.chunkType}/${c.symbolName}`))].slice(0, 3).join(', ')}`,
  );
  assert.ok(chunks.every((c) => c.chunkType !== 'block'), 'no chunk should come from the fallback');
});

test('chunkFile on a .h header produces symbol-aware chunks', async () => {
  const files = await walkFiles();
  const header = files.find((f) => f.relativePath.endsWith('Transactor.h'))!;
  const chunks = chunkFile(header);
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.chunkType !== 'block'), 'no chunk should come from the fallback');
});
