import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// CONFIG is resolved from process.cwd() at import time, so point cwd at a throwaway
// project BEFORE importing the walker. Same pattern as walker-cpp.test.ts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-macro-'));
fs.mkdirSync(path.join(root, 'include', 'detail'), { recursive: true });
fs.writeFileSync(
  path.join(root, '.codesearchrc.json'),
  JSON.stringify({ indexDirs: ['include'] }),
);

// A fixture shaped like rippled's include/xrpl/protocol/detail/transactions.macro:
// a `#error` guard, a doc comment documenting the macro signature, then one
// doc-commented multi-line invocation per transaction type.
fs.writeFileSync(
  path.join(root, 'include', 'detail', 'transactions.macro'),
  [
    '#if !defined(TRANSACTION)',
    '#error "undefined macro: TRANSACTION"',
    '#endif',
    '',
    '/**',
    ' * TRANSACTION(tag, value, name, settings, fields)',
    ' *',
    ' * Defines one transaction type and its permitted fields.',
    ' */',
    '',
    '/** This transaction type creates an escrow object. */',
    'TRANSACTION(ttESCROW_CREATE, 1, EscrowCreate, ({}), ({',
    '    {sfDestination, SoeRequired},',
    '    {sfAmount, SoeRequired, SoeMptSupported},',
    '    {sfCondition, SoeOptional},',
    '}))',
    '',
    '/** This transaction type adjusts various account settings. */',
    'TRANSACTION(ttACCOUNT_SET, 3, AccountSet,',
    '    ({}),',
    '    ({',
    '    {sfTransferRate, SoeOptional},',
    '    {sfTickSize, SoeOptional},',
    '}))',
    '',
    '/** Grants the ability to set Domain. */',
    'GRANULAR_PERMISSION(AccountDomainSet, ttACCOUNT_SET, 65540, tfUniversal,',
    '    ({{sfDomain, SoeOptional}}))',
    '',
  ].join('\n'),
);

// Control: still unmapped, so the walker must keep dropping it.
fs.writeFileSync(path.join(root, 'include', 'detail', 'e.xyz'), 'not a real language\n');

process.chdir(root);
const { walkFiles } = await import('../src/walker.js');
const { chunkFile } = await import('../src/chunker.js');

test('the walker collects .macro files instead of silently skipping them', async () => {
  const files = (await walkFiles()).map((f) => f.relativePath).sort();
  assert.deepEqual(files, [path.join('include', 'detail', 'transactions.macro')]);
});

test('.macro files are tagged as the macro language', async () => {
  const files = await walkFiles();
  const f = files.find((x) => x.relativePath.endsWith('transactions.macro'));
  assert.equal(f?.language, 'macro');
});

test('chunkFile splits an X-macro table into one chunk per invocation', async () => {
  const files = await walkFiles();
  const file = files.find((f) => f.relativePath.endsWith('transactions.macro'))!;

  const chunks = chunkFile(file);
  const macroChunks = chunks.filter((c) => c.chunkType === 'macro');
  // Three invocations in the fixture. A line-window split at the default 800
  // tokens would have produced ONE chunk for the whole file, which is the defect.
  assert.equal(macroChunks.length, 3, 'expected one chunk per top-level invocation');

  // The preamble (the #error guard + the macro signature doc) is its own chunk.
  assert.equal(chunks.filter((c) => c.chunkType === 'header').length, 1);

  for (const c of chunks) {
    assert.ok(c.content.trim().length > 0);
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
  }
});

test('each chunk carries its own entry, doc comment, and symbol name', async () => {
  const files = await walkFiles();
  const file = files.find((f) => f.relativePath.endsWith('transactions.macro'))!;

  const macroChunks = chunkFile(file).filter((c) => c.chunkType === 'macro');
  const byName = new Map(macroChunks.map((c) => [c.symbolName, c]));

  // symbolName is the macro's identifier, making it searchable.
  assert.deepEqual([...byName.keys()].sort(), [
    'GRANULAR_PERMISSION',
    'TRANSACTION',
  ]);

  // The AccountSet entry must contain its own fields and NOT its neighbour's —
  // this is what "which fields does AccountSet accept?" needs to match on.
  const accountSet = macroChunks.find((c) => c.content.includes('ttACCOUNT_SET'))!;
  assert.ok(accountSet, 'expected an AccountSet chunk');
  assert.match(accountSet.content, /sfTransferRate/);
  assert.match(accountSet.content, /sfTickSize/);
  assert.ok(
    !accountSet.content.includes('sfDestination'),
    'AccountSet chunk must not absorb the EscrowCreate entry',
  );
  // Its doc comment travels with it, so the chunk is self-describing.
  assert.match(accountSet.content, /adjusts various account settings/);

  // Line numbers must point at the real span of the entry.
  const all = file.absolutePath;
  const src = fs.readFileSync(all, 'utf-8').split('\n');
  const slice = src.slice(accountSet.startLine - 1, accountSet.endLine).join('\n');
  assert.equal(slice.trim(), accountSet.content.trim());
});

test('chunks tile the file with no line dropped and no line stored twice', async () => {
  const files = await walkFiles();
  const file = files.find((f) => f.relativePath.endsWith('transactions.macro'))!;

  const chunks = chunkFile(file);
  const src = fs.readFileSync(file.absolutePath, 'utf-8').split('\n');
  // The trailing '' from the final newline is not content.
  const covered = new Map<number, number>();
  for (const c of chunks) {
    for (let ln = c.startLine; ln <= c.endLine; ln += 1) {
      covered.set(ln, (covered.get(ln) ?? 0) + 1);
    }
  }
  const blanks = [...covered.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(blanks, [], `lines stored more than once: ${blanks.slice(0, 5)}`);

  // Every non-blank source line is reachable from some chunk.
  for (let i = 0; i < src.length; i += 1) {
    if (src[i].trim() === '') continue;
    assert.ok(covered.has(i + 1), `source line ${i + 1} was dropped: ${src[i]}`);
  }
});