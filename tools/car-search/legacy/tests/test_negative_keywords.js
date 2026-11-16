/* Run with: node tests/test_negative_keywords.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const start = source.indexOf('function normaliseExcludedText(');
const end = source.indexOf('function matchingSearchIds(', start);
assert.ok(start >= 0 && end > start, 'Exclusion helpers exist in dashboard');
const functions = vm.runInNewContext(
  source.slice(start, end) + '\n({searchExcludedGroup, normaliseExcludedText})',
  {}
);
const makeSearch = excludeKeywords => ({filters: {excludeKeywords}});
const group = [
  {site: 'autotrader', title: '2017 BMW M2 Coupe', description: 'A lovely example'},
  {site: 'facebook', title: 'BMW M2 non-sport exhaust', description: 'Previously wrapped green'},
];

assert.equal(functions.searchExcludedGroup(group, makeSearch('wrapped')), true,
  'Description in any provider excludes the entire group');
assert.equal(functions.searchExcludedGroup(group, makeSearch('NON SPORT')), true,
  'Case and punctuation variants match complete phrases');
assert.equal(functions.searchExcludedGroup(group, makeSearch('sport')), true);
assert.equal(functions.searchExcludedGroup(group, makeSearch('wrapper')), false,
  'Partial words must not match');
assert.equal(functions.searchExcludedGroup(group, makeSearch('')) , false,
  'Omitting exclusions leaves results unchanged');
assert.equal(functions.searchExcludedGroup(group, makeSearch('damaged, WRAPPED')), true,
  'Any comma-separated exclusion is sufficient');
assert.equal(functions.searchExcludedGroup([
  {title: 'Caterham 7', description: 'Original vehicle'}
], makeSearch('cat')), false,
  'Whole-word matching does not match substrings');
assert.equal(functions.searchExcludedGroup([
  {title: 'BMW M2 cat', description: 'S specification'}
], makeSearch('Cat S')), false,
  'Do not match a phrase by joining different advert fields');
console.log('Negative keyword group-matching tests passed.');
