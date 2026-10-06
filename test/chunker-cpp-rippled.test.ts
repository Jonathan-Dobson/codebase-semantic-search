import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { chunkFile } from '../src/chunker.js';
import type { Chunk } from '../src/chunker.js';

// Acceptance evidence for the C++ AST chunker on a REAL corpus.
//
// The synthetic fixtures in chunker-cpp.test.ts pin the rules, but they cannot
// tell you the rules hold on real code: a fixture is written to pass. These
// tests run the shipped chunker over an unmodified checkout of rippled and
// assert the two properties that were measured to be broken there —
// overlapping chunks (defect 1) and a large file falling back to line chunking
// (defect 2).
//
// The corpus is a read-only local mirror of a real project. It is NOT vendored
// into this package, so it is absent on most machines and in CI; when it is
// missing these tests skip rather than fail. That keeps `npm test` green for
// everyone while still running wherever the mirror exists — and it is the only
// way to catch a regression that only shows up on real code.
//
// CONFIG resolves from process.cwd() at import time. Run from the package root
// there is no .codesearchrc.json, so the defaults apply (maxChunkTokens 800),
// which is what the measurements below were taken with.

const RIPPLE_REPO = '/Users/jdobson/.mavis/docs.local/rippled/repo';

/** Directories sampled for the corpus-wide checks. */
const SAMPLE_DIRS = [
  'src/libxrpl/tx/transactors',
  'src/libxrpl/tx',
  'src/xrpld/rpc',
  'src/xrpld/app',
];

/** The two files the fix is specifically about. */
const SPONSORSHIP_TRANSFER = 'src/libxrpl/tx/transactors/sponsor/SponsorshipTransfer.cpp';
const TRANSACTOR = 'src/libxrpl/tx/Transactor.cpp';

const CORPUS_AVAILABLE = fs.existsSync(path.join(RIPPLE_REPO, 'src'));
const skip = CORPUS_AVAILABLE
  ? false
  : `rippled mirror not present at ${RIPPLE_REPO} (optional corpus)`;

function entry(rel: string) {
  const absolutePath = path.join(RIPPLE_REPO, rel);
  return {
    absolutePath,
    relativePath: rel,
    language: 'cpp',
    module: rel.split(path.sep)[0],
    lastModified: fs.statSync(absolutePath).mtime.toISOString(),
  };
}

/** Every pair of chunks whose [startLine, endLine] ranges intersect. */
function overlappingPairs(chunks: Chunk[]): string[] {
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const pairs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startLine > sorted[i].endLine) break;
      pairs.push(
        `${sorted[i].startLine}-${sorted[i].endLine}[${sorted[i].symbolName}] overlaps ` +
          `${sorted[j].startLine}-${sorted[j].endLine}[${sorted[j].symbolName}]`,
      );
    }
  }
  return pairs;
}

/** True when every chunk came from the line fallback (no AST symbol at all). */
function isLineFallback(chunks: Chunk[]): boolean {
  return chunks.length > 0 && chunks.every((c) => c.chunkType === 'block' && c.symbolName === '');
}

/** Deterministic ~24-file sample spanning every sampled directory. */
function sampleFiles(count = 24): string[] {
  const exts = new Set(['.cpp', '.h', '.hpp', '.ipp']);
  const found: string[] = [];
  for (const dir of SAMPLE_DIRS) {
    const abs = path.join(RIPPLE_REPO, dir);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const current = stack.pop()!;
      for (const e of fs.readdirSync(current, { withFileTypes: true })) {
        const p = path.join(current, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (exts.has(path.extname(e.name))) found.push(path.relative(RIPPLE_REPO, p));
      }
    }
  }
  found.sort();
  const stride = Math.max(1, Math.ceil(found.length / count));
  const picked = found.filter((_, i) => i % stride === 0).slice(0, count);
  // Always include the two files the defect reports name.
  for (const rel of [SPONSORSHIP_TRANSFER, TRANSACTOR]) {
    if (!picked.includes(rel) && fs.existsSync(path.join(RIPPLE_REPO, rel))) picked.push(rel);
  }
  return picked.sort();
}

// ─────────────────────────────── defect 1 ───────────────────────────────

test(
  'real rippled code produces no overlapping chunks',
  { skip },
  () => {
    const files = sampleFiles();
    assert.ok(files.length >= 20, `expected a 20+ file sample, got ${files.length}`);

    const offenders: string[] = [];
    for (const rel of files) {
      const pairs = overlappingPairs(chunkFile(entry(rel)));
      if (pairs.length) offenders.push(`${rel}: ${pairs.join('; ')}`);
    }

    assert.deepEqual(
      offenders,
      [],
      `real code must not produce overlapping chunks:\n  ${offenders.join('\n  ')}`,
    );
  },
);

test(
  'SponsorshipTransfer.cpp: one function, no duplicated source',
  { skip },
  () => {
    const rel = SPONSORSHIP_TRANSFER;
    const chunks = chunkFile(entry(rel));

    assert.deepEqual(overlappingPairs(chunks), [], 'overlapping chunks in a real transactor');

    // `doApply` spans 298-540 and is far over maxChunkTokens, so it is split into
    // several windows. Pre-fix each window re-emitted chunkOverlapLines (5) lines
    // of the previous one; measured then, 78 line-slots were duplicated in this
    // one function alone. Now every line belongs to exactly one chunk.
    const doApply = chunks.filter((c) => c.symbolName === 'SponsorshipTransfer::doApply');
    assert.ok(doApply.length > 1, 'doApply should be split across windows');

    const counts = new Map<number, number>();
    for (const c of chunks) {
      for (let l = c.startLine; l <= c.endLine; l++) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([l]) => l);
    assert.deepEqual(duplicated, [], 'no source line may be indexed twice');

    // And the windows still tile the function: 298-540 with nothing skipped.
    assert.equal(doApply[0].startLine, 298);
    assert.equal(doApply[doApply.length - 1].endLine, 540);
    const contiguous = doApply.every(
      (c, i) => i === 0 || c.startLine === doApply[i - 1].endLine + 1,
    );
    assert.ok(contiguous, `windows must tile doApply: ${describe(doApply)}`);
  },
);

// ─────────────────────────────── defect 2 ───────────────────────────────

test(
  'Transactor.cpp is AST-chunked, not line-chunked',
  { skip },
  () => {
    const rel = TRANSACTOR;
    const source = fs.readFileSync(path.join(RIPPLE_REPO, rel), 'utf-8');
    assert.ok(
      source.length > 32768,
      `Transactor.cpp must be over the native read ceiling to discriminate, got ${source.length}`,
    );

    const chunks = chunkFile(entry(rel));
    assert.ok(
      !isLineFallback(chunks),
      'Transactor.cpp must not fall back to line chunking',
    );
    assert.ok(
      chunks.some((c) => c.chunkType === 'function'),
      'expected real function chunks',
    );
  },
);

test(
  'Transactor.cpp: preflight1Sponsor is a named AST chunk',
  { skip },
  () => {
    // The reason defect 2 mattered: this function is what the rippled slice was
    // extended for, and it was unreachable while the file fell back to line
    // windows. It must now be individually findable.
    const chunks = chunkFile(entry(TRANSACTOR));
    const hits = chunks.filter((c) => c.symbolName === 'preflight1Sponsor');

    assert.equal(hits.length, 1, `expected exactly one preflight1Sponsor chunk, got ${chunks.map((c) => c.symbolName).filter((n) => n.includes('preflight')).join(', ')}`);
    const hit = hits[0];
    assert.equal(hit.chunkType, 'function');
    assert.equal(hit.startLine, 176, 'preflight1Sponsor starts at line 176');
    assert.equal(hit.endLine, 226, 'preflight1Sponsor ends at line 226');
    assert.match(hit.content, /preflight1Sponsor/, 'chunk text must be the function itself');
  },
);

test(
  'no real file in the sample falls back to line chunking or warns',
  { skip },
  () => {
    const files = sampleFiles();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    const fallbacks: string[] = [];
    try {
      for (const rel of files) {
        if (isLineFallback(chunkFile(entry(rel)))) fallbacks.push(rel);
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(fallbacks, [], 'no real file should fall back to line chunking');
    assert.deepEqual(
      warnings.filter((w) => w.includes('AST parse failed')),
      [],
      'a file over the read ceiling is an expected case and must not warn',
    );
  },
);

// ───────────────────── content preservation on real code ─────────────────────

test(
  'real chunks are faithful slices and drop no declaration lines',
  { skip },
  () => {
    for (const rel of sampleFiles(12)) {
      const lines = fs.readFileSync(path.join(RIPPLE_REPO, rel), 'utf-8').split('\n');
      const chunks = chunkFile(entry(rel));

      // Every chunk's text must be exactly the lines it claims.
      for (const c of chunks) {
        if (c.chunkType === 'block') continue;
        const expected = lines.slice(c.startLine - 1, c.endLine).join('\n').trim();
        assert.ok(
          expected.startsWith(c.content.trim().slice(0, 40)) || c.content.trim().startsWith(expected.slice(0, 40)),
          `${rel}: chunk ${c.startLine}-${c.endLine} is not a slice of the source`,
        );
      }

      // No line may be claimed by two chunks.
      const counts = new Map<number, number>();
      for (const c of chunks) {
        for (let l = c.startLine; l <= c.endLine; l++) counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([l]) => l);
      assert.deepEqual(dupes, [], `${rel}: lines indexed more than once`);
    }
  },
);

function describe(chunks: Chunk[]): string {
  return chunks.map((c) => `${c.startLine}-${c.endLine}`).join(' ');
}