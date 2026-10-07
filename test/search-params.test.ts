import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unknownFieldsError, SEARCH_FIELDS } from '../src/search-params.js';

test('every accepted field passes', () => {
  const body = Object.fromEntries(SEARCH_FIELDS.map((f) => [f, 'x']));
  assert.equal(unknownFieldsError(body), undefined);
});

test('an unknown field is named, with a hint for a likely guess', () => {
  const err = unknownFieldsError({ query: 'x', limit: 5 });
  assert.match(err!, /unknown field: "limit" \(did you mean "top_k"\?\)/);
  assert.match(err!, /Accepted: query, top_k/);
});

test('several unknown fields are all named; no hint where there is no likely guess', () => {
  const err = unknownFieldsError({ query: 'x', exclude: [], foo: 1 });
  assert.match(err!, /unknown fields: "exclude" \(did you mean "ignore"\?\), "foo"\./);
});

test('a missing or non-object body is left to the query check', () => {
  assert.equal(unknownFieldsError(undefined), undefined);
  assert.equal(unknownFieldsError(null), undefined);
  assert.equal(unknownFieldsError(['query']), undefined);
});
