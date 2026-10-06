import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { chunkFile, chunkByLines } from '../src/chunker.js';
import type { Chunk } from '../src/chunker.js';
import { CONFIG } from '../src/config.js';
import type { FileEntry } from '../src/walker.js';

// These tests drive chunkFile() directly with hand-built FileEntry objects, so
// they do NOT need the cwd dance walker.test.ts performs: CONFIG is resolved at
// import time from process.cwd(), and the package root has no .codesearchrc.json,
// so the defaults (maxChunkTokens 800 / overlap 5) apply. CONFIG is read rather
// than hardcoded so a future rc change cannot silently invalidate the size tests.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'csearch-chunker-cpp-'));

function writeCpp(name: string, source: string): FileEntry {
  const absolutePath = path.join(root, name);
  fs.writeFileSync(absolutePath, source);
  return {
    absolutePath,
    relativePath: path.join('src', name),
    language: 'cpp',
    module: 'src',
    lastModified: fs.statSync(absolutePath).mtime.toISOString(),
  };
}

/** First line (1-based) whose trimmed content equals `needle`. */
function lineOf(source: string, needle: string): number {
  const lines = source.split('\n');
  const idx = lines.findIndex((l) => l.trim() === needle);
  assert.notEqual(idx, -1, `fixture is missing a line equal to ${JSON.stringify(needle)}`);
  return idx + 1;
}

/**
 * First line after `fromLine` (1-based) that is a lone closing brace.
 */
function closingBraceAfter(source: string, fromLine: number): number {
  const lines = source.split('\n');
  const idx = lines.findIndex((l, i) => i + 1 > fromLine && l.trim() === '}');
  assert.notEqual(idx, -1, 'fixture has no closing brace after the function');
  return idx + 1;
}

/**
 * Every pair of chunks whose `[startLine, endLine]` ranges intersect.
 *
 * This is the defect-1 invariant. Containment is deliberately NOT what is
 * checked: the prescribed "drop chunks contained in a same-symbol neighbour"
 * rule was measured against 350 real rippled files and matched 0 of 693
 * overlapping pairs, because every real overlap is a *partial* one — two
 * windows of the same function that each stick out past the other. Checking
 * plain intersection catches both shapes, so it is the stronger assertion.
 */
function overlappingPairs(chunks: Chunk[]): string[] {
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const pairs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      // Sorted by startLine, so once j starts past i's end nothing later can
      // overlap it either.
      if (sorted[j].startLine > sorted[i].endLine) break;
      pairs.push(
        `${sorted[i].startLine}-${sorted[i].endLine}[${sorted[i].symbolName}] overlaps ` +
          `${sorted[j].startLine}-${sorted[j].endLine}[${sorted[j].symbolName}]`,
      );
    }
  }
  return pairs;
}

/** Compact rendering of a chunk list, for assertion failure messages. */
function describeRanges(chunks: Chunk[]): string {
  return chunks.map((c) => `${c.startLine}-${c.endLine}[${c.chunkType}/${c.symbolName}]`).join(' ');
}

/**
 * A C++ `function_definition` node starts at its return type, not at the
 * signature — `TERet\nSponsorshipTransfer::preflight(…)` begins at the `TERet`.
 * Walk back over the signature to find the line the declaration really starts on.
 */
function declarationStart(source: string, sigLine: number): number {
  const lines = source.split('\n');
  let n = sigLine;
  while (n - 1 >= 1 && lines[n - 2].trim() !== '') n--;
  return n;
}

// ─────────────────────────── boundary, not mid-function ───────────────────────────

// Shaped like rippled's SponsorshipTransfer.cpp: two long functions inside a
// namespace, each comfortably over half the chunk budget so that the line
// windower's boundary lands inside one of them. This is the case the old path
// got wrong — it produced a 1-109 chunk that ended ~90 lines before
// `preflight`'s real end.
const PREFLIGHT_SIG = 'SponsorshipTransfer::preflight(PreflightContext const& ctx)';
const DOAPPLY_SIG = 'SponsorshipTransfer::doApply(Transactor& trx)';

const rippledLike = [
  '#include <xrpl/protocol/Indexes.h>',
  '#include <xrpl/tx/Transactor.h>',
  '',
  'namespace ripple {',
  '',
  'TERet',
  PREFLIGHT_SIG,
  '{',
  '    static constexpr auto transferFlags = 0x0001;',
  Array.from({ length: 45 }, (_, i) => `    if (ctx.flags & (1u << ${i})) return temINVALID_FLAG;`).join('\n'),
  '    return temSUCCESS;',
  '}',
  '',
  'TERet',
  DOAPPLY_SIG,
  '{',
  Array.from({ length: 40 }, (_, i) => `    trx.on<SponsorshipTransfer>(ctx.account_, ${i});`).join('\n'),
  '    return temSUCCESS;',
  '}',
  '',
  '} // namespace ripple',
  '',
].join('\n');

/** Line ranges of both functions in the rippled-like fixture. */
function fixtureFunctionRanges(source: string): { name: string; start: number; end: number }[] {
  return [PREFLIGHT_SIG, DOAPPLY_SIG].map((sig) => {
    const sigLine = lineOf(source, sig);
    return {
      name: sig.split('(')[0],
      start: declarationStart(source, sigLine),
      end: closingBraceAfter(source, sigLine),
    };
  });
}

test('a C++ fixture chunks on function boundaries, never mid-function', () => {
  const file = writeCpp('SponsorshipTransfer.cpp', rippledLike);
  const chunks = chunkFile(file);
  const fns = fixtureFunctionRanges(rippledLike);

  assert.ok(chunks.length > 0, 'expected at least one chunk');

  // No chunk may begin strictly inside a function body. This is the defect being
  // fixed: the old line window ended mid-body, so a hit pointed at a statement.
  for (const c of chunks) {
    for (const fn of fns) {
      assert.ok(
        !(fn.start < c.startLine && c.startLine < fn.end),
        `chunk starting at line ${c.startLine} lands inside ${fn.name} (${fn.start}-${fn.end})`,
      );
    }
  }

  const preflight = chunks.find((c) => c.symbolName === 'SponsorshipTransfer::preflight');
  assert.ok(preflight, `expected a preflight chunk, got ${chunks.map((c) => c.symbolName).join(', ')}`);
  assert.equal(preflight!.startLine, fns[0].start);
  assert.equal(preflight!.endLine, fns[0].end, 'preflight chunk must reach its closing brace');
  assert.equal(preflight!.chunkType, 'function');

  // The fixture is only meaningful if the old path really did cut a function.
  const legacy = chunkByLines(rippledLike, CONFIG.maxChunkTokens, CONFIG.chunkOverlapLines);
  assert.ok(
    legacy.some((w) => fns.some((fn) => fn.start < w.endLine && w.endLine < fn.end)),
    'fixture no longer discriminates: the line chunker no longer cuts a function',
  );
});

test('a big namespace is descended into rather than stored as one giant chunk', () => {
  const file = writeCpp('BigNamespace.cpp', rippledLike);
  const chunks = chunkFile(file);
  const types = chunks.map((c) => c.chunkType);

  assert.ok(types.includes('function'), `expected function chunks, got ${[...new Set(types)].join(',')}`);
  assert.ok(
    !chunks.some((c) => c.chunkType === 'namespace'),
    'a namespace must be walked, not emitted verbatim',
  );
});

test('a small namespace is walked too, so its symbols stay individually findable', () => {
  // Storing a namespace whole when it fits maxChunkTokens would collapse a whole
  // header into one unsplittable blob and lose every symbol inside it.
  const source = [
    '#include <string>',
    '',
    'namespace ripple {',
    '',
    'int first() { return 1; }',
    '',
    'int second() { return 2; }',
    '',
    '} // namespace ripple',
    '',
  ].join('\n');
  const chunks = chunkFile(writeCpp('SmallNamespace.cpp', source));

  assert.deepEqual(
    chunks.map((c) => `${c.chunkType}/${c.symbolName}`),
    ['function/first', 'function/second'],
  );
});

test('a namespace with nothing indexable inside is kept rather than dropped', () => {
  const source = 'namespace only_using {\nusing std::string;\n}\n';
  const chunks = chunkFile(writeCpp('OnlyUsing.cpp', source));

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].chunkType, 'namespace');
  assert.equal(chunks[0].symbolName, 'only_using');
});

// ────────────────────────────────── symbol names ──────────────────────────────────

const declarations = [
  '#define JLOG(x) (x)',
  '#define MAX_FLAGS 3',
  '',
  'namespace detail {',
  'struct Point { int x; int y; };',
  '} // namespace detail',
  '',
  'enum class Kind { kA, kB };',
  '',
  'class Transactor {',
  'public:',
  '    TERet preflight(Ctx const& ctx);',
  '};',
  '',
  'TERet Transactor::preflight(Ctx const& ctx)',
  '{',
  '    return temSUCCESS;',
  '}',
  '',
  'template <typename T>',
  'T add(T a, T b)',
  '{',
  '    return a + b;',
  '}',
  '',
  'template <typename T>',
  'class Holder',
  '{',
  '    T v_;',
  '};',
  '',
  'int globalConst = 7;',
  '',
  'int freeFn(int a);',
  '',
  'int main() { return 0; }',
  '',
].join('\n');

test('each declaration yields a named chunk typed from the existing vocabulary', () => {
  const file = writeCpp('Declarations.cpp', declarations);
  const chunks = chunkFile(file);
  const seen = new Map(chunks.map((c) => [c.symbolName, c.chunkType]));

  const expected: [string, string][] = [
    ['JLOG', 'macro'],
    ['MAX_FLAGS', 'macro'],
    // `namespace detail` is descended into, so its payload is what gets indexed.
    ['Point', 'class'],
    ['Kind', 'enum'],
    ['Transactor', 'class'],
    ['Transactor::preflight', 'function'],
    ['add', 'function'],
    ['Holder', 'class'],
    ['globalConst', 'variable'],
    // A prototype is a `declaration` in the C++ grammar, but a header is mostly
    // prototypes — calling them `variable` would mis-type most of a header.
    ['freeFn', 'function'],
    ['main', 'function'],
  ];

  for (const [name, type] of expected) {
    assert.equal(seen.get(name), type, `symbol ${name}: expected ${type}, got ${seen.get(name)}`);
  }

  for (const c of chunks) {
    assert.equal(c.language, 'cpp');
    assert.equal(c.module, 'src');
    assert.ok(c.content.trim().length > 0);
    assert.ok(c.startLine >= 1 && c.endLine >= c.startLine);
    assert.ok(c.id.length > 0);
  }
});

test('a parameter name is never mistaken for the declared symbol', () => {
  // `T add(T a, T b)` must be named `add`, not `a` or `T`.
  const file = writeCpp('Params.cpp', 'template <typename T>\nT add(T a, T b)\n{\n    return a + b;\n}\n');
  const chunks = chunkFile(file);
  assert.deepEqual(
    chunks.map((c) => c.symbolName),
    ['add'],
  );
  assert.equal(chunks[0].chunkType, 'function');
});

test('a function is named after its name, not its qualified return type', () => {
  // tree-sitter-cpp parses `std::uint32_t` / `std::pair<TER, XRPAmount>` as a
  // single `qualified_identifier`, which the name BFS accepts. Searching from the
  // function_definition root reached that return type one level before the
  // declarator, so these chunks were named after the *type*. Real occurrences:
  // Transactor.cpp:369 (`std::uint32_t`) and :1294 (`std::pair<TER, XRPAmount>`),
  // and SponsorshipTransfer.cpp:93.
  const source = [
    '#include <cstdint>',
    '#include <utility>',
    '',
    'std::uint32_t',
    'Transactor::getFlagsMask(Ctx const& ctx)',
    '{',
    '    return tfMask;',
    '}',
    '',
    'std::pair<TER, XRPAmount>',
    'Transactor::reset(XRPAmount fee)',
    '{',
    '    return {teSUCCESS, fee};',
    '}',
    '',
    'std::optional<LedgerIndex>',
    'Transactor::getLastLedger(Ctx const& ctx)',
    '{',
    '    return ctx.last;',
    '}',
    '',
  ].join('\n');
  const chunks = chunkFile(writeCpp('QualifiedReturn.cpp', source));

  assert.deepEqual(
    chunks.map((c) => c.symbolName),
    ['Transactor::getFlagsMask', 'Transactor::reset', 'Transactor::getLastLedger'],
  );
  for (const c of chunks) assert.equal(c.chunkType, 'function');
});

// ─────────────────────────────── oversized nodes ───────────────────────────────

test('a node larger than maxChunkTokens is subdivided but keeps its identity', () => {
  const body = Array.from({ length: 400 }, (_, i) => `    doWork(${i});`).join('\n');
  const source = `int huge()\n{\n${body}\n}\n`;
  const file = writeCpp('Huge.cpp', source);
  const chunks = chunkFile(file);

  assert.ok(chunks.length > 1, 'expected the oversized function to be split');
  for (const c of chunks) {
    assert.equal(c.chunkType, 'function');
    assert.equal(c.symbolName, 'huge');
  }
  // Sub-chunks stay inside the function.
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[chunks.length - 1].endLine, lineOf(source, '}'));
});

// ───────────────────── no overlapping / duplicate chunks ─────────────────────
//
// Defect 1: an oversized unit used to be split with `CONFIG.chunkOverlapLines`,
// so consecutive windows re-emitted their shared boundary lines. Each such line
// was embedded twice, and the near-identical vectors tied on score and crowded
// out every other hit for the same function. The overlap exists in
// chunkByLines() for *contextless* line chunking, where a window starting
// mid-function has nothing to identify it; a window cut from a known AST unit
// already carries its symbol and type, so the re-emitted lines buy nothing.

test('an oversized unit is subdivided into windows that do not overlap', () => {
  const body = Array.from({ length: 400 }, (_, i) => `    doWork(${i});`).join('\n');
  const source = `int huge()\n{\n${body}\n}\n`;
  const chunks = chunkFile(writeCpp('NoOverlap.cpp', source));

  assert.ok(chunks.length > 1, 'fixture must be large enough to split');
  assert.deepEqual(
    overlappingPairs(chunks),
    [],
    `windows of one unit must tile it, not overlap: ${describeRanges(chunks)}`,
  );
});

test('an oversized unit is still fully covered — zero overlap drops no content', () => {
  // The reason zero overlap is safe: chunkByLines() advances `start` to `end`, so
  // the windows tile the unit end-to-end. Assert every source line inside the
  // function lands in exactly one chunk, so nothing is silently dropped.
  const body = Array.from({ length: 400 }, (_, i) => `    doWork(${i});`).join('\n');
  const source = `int huge()\n{\n${body}\n}\n`;
  const fnStart = lineOf(source, 'int huge()');
  const fnEnd = lineOf(source, '}');
  const chunks = chunkFile(writeCpp('Coverage.cpp', source));

  const counts = new Map<number, number>();
  for (const c of chunks) {
    for (let l = c.startLine; l <= c.endLine; l++) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const missing: number[] = [];
  const duplicated: number[] = [];
  for (let l = fnStart; l <= fnEnd; l++) {
    const n = counts.get(l) ?? 0;
    if (n === 0) missing.push(l);
    if (n > 1) duplicated.push(l);
  }
  assert.deepEqual(missing, [], 'every line of the function must be indexed');
  assert.deepEqual(duplicated, [], 'no line may be indexed twice');
});

test('adjacent preprocessor directives do not both claim the shared boundary line', () => {
  // A node whose text ends in a newline technically ends on the NEXT row while
  // owning nothing there (`#define A 1\n` spans rows 1-2 for a one-line macro on
  // row 1). Two adjacent macros then both claimed line 2 and overlapped by one.
  // Real occurrences: applySteps.cpp `#define TRANSACTION(...)` /
  // `#define TRANSACTION_INCLUDE 1`.
  const source = [
    '#define FIRST 1',
    '#define SECOND 2',
    '',
    'int after() { return 0; }',
    '',
  ].join('\n');
  const chunks = chunkFile(writeCpp('AdjacentMacros.cpp', source));

  const macros = chunks.filter((c) => c.chunkType === 'macro');
  assert.deepEqual(
    macros.map((c) => `${c.symbolName}:${c.startLine}-${c.endLine}`),
    ['FIRST:1-1', 'SECOND:2-2'],
    'each one-line macro must claim exactly its own line',
  );
  assert.deepEqual(overlappingPairs(chunks), [], 'adjacent macros must not overlap');
});

// ─────────────────────────── error tolerance + fallback ───────────────────────────

const broken = [
  '#include <x.h>',
  'int good() { return 1; }',
  'class Broken { void f( { return ;',
  'int after() { return 2; }',
  '',
].join('\n');

test('a syntax-error file does not throw and still yields chunks', () => {
  const file = writeCpp('Broken.cpp', broken);
  let chunks;
  assert.doesNotThrow(() => {
    chunks = chunkFile(file);
  });

  chunks = chunks!;
  assert.ok(chunks.length > 0, 'a broken file must still produce chunks');
  // The ERROR node swallows the healthy code after it, so descending is what
  // recovers these — emitting the ERROR node verbatim would duplicate them.
  const names = chunks.map((c) => c.symbolName);
  assert.ok(names.includes('good'), `expected a chunk for good(), got ${names.join(',') || '(none)'}`);
  assert.ok(names.includes('after'), `expected a chunk for after(), got ${names.join(',') || '(none)'}`);
  assert.equal(
    new Set(chunks.map((c) => `${c.startLine}-${c.endLine}`)).size,
    chunks.length,
    'chunks must not overlap — an ERROR chunk plus its own children would double-index',
  );
});

test('a file with nothing recognisable still yields chunks via the fallback', () => {
  const file = writeCpp('OnlyComments.cpp', '# just a comment\n// and another\n');
  const chunks = chunkFile(file);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].chunkType, 'block');
});

test('a qualified-type variable is named after the variable, not its type', () => {
  // `std::vector<int> v;` — a BFS that accepts qualified_identifier would return
  // `std::vector<int>`, because the type is a shallower sibling than the name.
  const file = writeCpp('Qualified.cpp', 'std::vector<int> v;\nstd::map<int, int> m;\n');
  const chunks = chunkFile(file);
  assert.deepEqual(
    chunks.map((c) => `${c.chunkType}/${c.symbolName}`),
    ['variable/v', 'variable/m'],
  );
});

test('a header of includes and pragma once is kept as an imports chunk', () => {
  const source = [
    '#pragma once',
    '#include <cstdint>',
    '#include <string>',
    '#include <vector>',
    '#include <memory>',
    '#include <algorithm>',
    '#include <stdexcept>',
    '#include <functional>',
    '#include <optional>',
    '#include <variant>',
    '#include <filesystem>',
    '#include <regex>',
    '',
    'int answer();',
    '',
  ].join('\n');
  const file = writeCpp('OnlyIncludes.h', source);
  const chunks = chunkFile(file);
  const header = chunks.find((c) => c.chunkType === 'imports');

  assert.ok(header, `expected an imports chunk, got ${chunks.map((c) => `${c.chunkType}/${c.symbolName}`).join(', ')}`);
  assert.equal(header!.symbolName, 'file-header');
  assert.equal(header!.startLine, 1);
  const answer = chunks.find((c) => c.symbolName === 'answer');
  assert.ok(answer, 'expected a chunk for the prototype');
  assert.equal(answer!.chunkType, 'function');
});

// ──────────────────────── the 32 KiB native read ceiling ────────────────────────

/**
 * `tree-sitter@0.21.1` copies the source into a fixed `uint16_t` buffer that
 * defaults to `32 * 1024` **UTF-16 code units**. A source longer than that makes
 * `napi_get_value_string_utf16` fail with `napi_invalid_arg`, which surfaces in
 * JS as a bare `Error: Invalid argument`. It is a marshalling failure, not a
 * parse failure: the same file parses once the buffer is sized to the content,
 * and the binding's own `partial_string` continuation path is unreachable
 * because it sits *after* the call that already failed.
 *
 * 38 of rippled's 809 C/C++ files sit over the ceiling — including
 * `repo/src/libxrpl/tx/Transactor.cpp` at 57,089 bytes, which holds
 * `preflight1Sponsor` — so this pins a real corpus regression rather than a
 * synthetic edge case.
 */
const READ_CEILING_UNITS = 32768;

/**
 * A translation unit comfortably over the read ceiling, shaped like
 * `Transactor.cpp`: many small definitions followed by one named function that
 * sits *past* the ceiling, so only a source that is actually read whole can
 * surface it.
 */
function sourceOverReadCeiling(): string {
  const lines = ['#include <cstdint>', '#include <optional>', '', 'namespace ripple {', ''];
  let length = lines.join('\n').length;
  for (let i = 0; length <= READ_CEILING_UNITS + 4096; i++) {
    const fn = [`int filler_${i}(int x)`, '{', `    return x + ${i};`, '}', ''];
    length += fn.join('\n').length + 1;
    lines.push(...fn);
  }
  lines.push(
    'TERet',
    'Transactor::preflight1Sponsor(Ctx const& ctx)',
    '{',
    '    return temSUCCESS;',
    '}',
    '',
    '} // namespace ripple',
    '',
  );
  return lines.join('\n');
}

test('a source over the native read ceiling chunks on the AST path, not the fallback', () => {
  const source = sourceOverReadCeiling();
  assert.ok(
    source.length > READ_CEILING_UNITS,
    `fixture must exceed the read ceiling, got ${source.length}`,
  );
  assert.ok(
    source.indexOf('preflight1Sponsor') > READ_CEILING_UNITS,
    'the target function must sit past the read ceiling for this to discriminate',
  );

  const chunks = chunkFile(writeCpp('Oversized.cpp', source));

  assert.ok(
    chunks.some((c) => c.chunkType !== 'block'),
    `expected AST chunks, got only ${[...new Set(chunks.map((c) => c.chunkType))].join(',')}`,
  );
  const hit = chunks.find((c) => c.symbolName === 'Transactor::preflight1Sponsor');
  assert.ok(
    hit,
    `expected a named chunk past the ceiling, got ${chunks.map((c) => c.symbolName || '(unnamed)').join(', ')}`,
  );
  assert.equal(hit!.chunkType, 'function');
});

test('the read ceiling is 32768 UTF-16 code units, and the chunk text stays exact', () => {
  // Pin the boundary itself. One unit under it the old binding read the file
  // whole; one unit over it threw `Error: Invalid argument` for the same
  // content, so both sides are asserted to keep the number honest.
  const body =
    'namespace ripple {\n' +
    Array.from({ length: 2000 }, (_, i) => `int f${i}();\n`).join('') +
    '}\n';
  assert.ok(body.length < READ_CEILING_UNITS - 8, 'body must leave room to pad');
  /** `n` units total: one comment line of `// ` + filler + `\n`, then the body. */
  const exact = (n: number) => '// ' + 'x'.repeat(n - body.length - 4) + '\n' + body;

  const under = exact(READ_CEILING_UNITS - 1);
  assert.equal(under.length, READ_CEILING_UNITS - 1, 'fixture must sit just under the ceiling');
  const underChunks = chunkFile(writeCpp('UnderCeiling.cpp', under));
  assert.ok(
    underChunks.some((c) => c.chunkType !== 'block'),
    'a source just under the ceiling must still chunk on the AST path',
  );

  const over = exact(READ_CEILING_UNITS);
  assert.equal(over.length, READ_CEILING_UNITS, 'fixture must sit exactly at the ceiling');
  const overChunks = chunkFile(writeCpp('AtCeiling.cpp', over));

  assert.ok(
    overChunks.some((c) => c.chunkType !== 'block'),
    'a source of exactly 32768 units must still chunk on the AST path',
  );

  // The fix must not shift offsets: every named chunk's text has to still be a
  // faithful slice of the source it claims to come from.
  const sourceLines = over.split('\n');
  for (const c of overChunks) {
    if (c.chunkType !== 'function') continue;
    const expected = sourceLines.slice(c.startLine - 1, c.endLine).join('\n').trim();
    assert.equal(c.content, expected, `chunk ${c.startLine}-${c.endLine} does not match the source`);
  }
});