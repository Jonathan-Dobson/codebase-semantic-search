import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patternToMatchExpr,
  buildIgnoreExpr,
  parseIgnore,
  resolveIgnore,
  describeIgnore,
  MAX_IGNORE_PATTERNS,
} from '../src/ignore.js';

test('a trailing slash ignores a folder', () => {
  assert.equal(patternToMatchExpr('docs/'), 'file_path like "docs/%"');
});

test('a bare name is that file or a folder of that name', () => {
  assert.equal(patternToMatchExpr('wiki'), '(file_path == "wiki" or file_path like "wiki/%")');
});

test('* and ** both become %, matching across folders', () => {
  assert.equal(patternToMatchExpr('*.md'), 'file_path like "%.md"');
  assert.equal(patternToMatchExpr('server/**/README.md'), 'file_path like "server/%/README.md"');
});

test('_ and % match literally: escaped, then the backslash quoted for the string literal', () => {
  // Milvus `like` treats _ as one character and % as any run; __tests__/ must mean that folder.
  assert.equal(patternToMatchExpr('server/src/__tests__/'), 'file_path like "server/src/\\\\_\\\\_tests\\\\_\\\\_/%"');
  assert.equal(patternToMatchExpr('100%/'), 'file_path like "100\\\\%/%"');
});

test('a double quote cannot break out of the string literal', () => {
  assert.equal(patternToMatchExpr('a"b/'), 'file_path like "a\\"b/%"');
});

test('a leading ./ or / is dropped', () => {
  assert.equal(patternToMatchExpr('./docs/'), 'file_path like "docs/%"');
  assert.equal(patternToMatchExpr('/docs/'), 'file_path like "docs/%"');
});

test('several patterns are each negated and joined with and', () => {
  assert.equal(
    buildIgnoreExpr(['docs/', '*.md']),
    'not (file_path like "docs/%") and not (file_path like "%.md")',
  );
});

test('no usable pattern means no expression', () => {
  assert.equal(buildIgnoreExpr([]), undefined);
  assert.equal(buildIgnoreExpr(['  ']), undefined);
});

test('parseIgnore: absent means "not given"; an empty array is a choice', () => {
  assert.deepEqual(parseIgnore(undefined), { ok: true, patterns: undefined });
  assert.deepEqual(parseIgnore(null), { ok: true, patterns: undefined });
  assert.deepEqual(parseIgnore([]), { ok: true, patterns: [] });
  assert.deepEqual(parseIgnore([' docs/ ']), { ok: true, patterns: ['docs/'] });
});

test('parseIgnore rejects what it cannot use', () => {
  assert.equal(parseIgnore('docs/').ok, false);
  assert.equal(parseIgnore([1]).ok, false);
  assert.equal(parseIgnore(['']).ok, false);
  assert.equal(parseIgnore(Array(MAX_IGNORE_PATTERNS + 1).fill('a/')).ok, false);
  assert.equal(parseIgnore(['x'.repeat(201)]).ok, false);
});

test('resolveIgnore: the request wins, [] turns the default off, absent uses the default', () => {
  assert.deepEqual(resolveIgnore(['e2e/'], ['docs/']), { patterns: ['e2e/'], source: 'request' });
  assert.deepEqual(resolveIgnore([], ['docs/']), { patterns: [], source: 'none' });
  assert.deepEqual(resolveIgnore(undefined, ['docs/', 'wiki/']), { patterns: ['docs/', 'wiki/'], source: 'config' });
  assert.deepEqual(resolveIgnore(undefined, []), { patterns: [], source: 'none' });
});

test('resolveIgnore tolerates a malformed config value', () => {
  assert.deepEqual(resolveIgnore(undefined, 'docs/' as any), { patterns: [], source: 'none' });
  assert.deepEqual(resolveIgnore(undefined, ['docs/', 3, ''] as any), { patterns: ['docs/'], source: 'config' });
});

test('describeIgnore tells the caller what it did not see, and how to include it', () => {
  assert.equal(
    describeIgnore({ patterns: ['docs/', 'wiki/'], source: 'config' }),
    'ignored: docs/, wiki/ (project default; pass ignore: [] to include)',
  );
  assert.equal(describeIgnore({ patterns: ['e2e/'], source: 'request' }), 'ignored: e2e/');
  assert.equal(describeIgnore({ patterns: [], source: 'none' }), undefined);
});
