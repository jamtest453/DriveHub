/* Run with node tests/test_keyword_modes.js */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/dashboard.js'), 'utf8');
const start = source.indexOf('function normaliseExcludedText(');
const end = source.indexOf('function searchHiddenIds(', start);
assert.ok(start !== -1 && end > start, 'Dashboard keyword helpers found');

const data = {
  a: {id: 'a', site: 'autotrader', title: 'BMW M2 manual', description: 'Well maintained'},
  b: {id: 'b', site: 'facebook', title: 'BMW M2 coupe', description: 'Heated seats and performance exhaust'},
};
const context = {
  state: {listings: data},
  availableIds: () => ['a', 'b'],
  grouped: rows => [rows],
  searchColourMatchesGroup: () => true,
};
const helpers = vm.runInNewContext(source.slice(start, end) +
  '\n({keywordTerms, textHasPhrase, searchRequiredGroup, searchPreferredScore, searchExcludedGroup, matchingSearchIds, preferredKeywords})', context);
const filters = (fields={}) => ({filters: fields});

assert.equal(helpers.searchRequiredGroup([data.a, data.b],
  filters({requiredKeywords:'manual, heated seats'})), true,
  'Required phrases may be supplied by different adverts for one car');
assert.equal(helpers.searchRequiredGroup([data.a, data.b],
  filters({requiredKeywords:'manual, panoramic roof'})), false,
  'All required phrases are mandatory');
assert.equal(helpers.searchRequiredGroup([data.a, data.b],
  filters({requiredKeywords:''})), true,
  'No required phrases means no filtering');
assert.equal(helpers.searchRequiredGroup([data.a, data.b],
  filters({requiredKeywords:'HEATED-SEATS, manual'})), true,
  'Case and punctuation variants match');
assert.equal(helpers.searchRequiredGroup([data.a, data.b],
  filters({requiredKeywords:'heat'})), false,
  'Required keywords use word boundaries');

assert.equal(helpers.searchPreferredScore([data.a, data.b],
  filters({preferredKeywords:'performance exhaust, manual, panoramic roof'})), 3,
  'Title matches get two points, description matches get one, absent terms do not exclude');
assert.equal(helpers.searchPreferredScore([data.a, data.b],
  filters({preferredKeywords:'panoramic roof'})), 0);
assert.equal(helpers.searchPreferredScore([data.a, data.b],
  filters({keywords:'manual'})), 2, 'Legacy extra keywords become preferred');
assert.equal(helpers.searchExcludedGroup([data.a, data.b],
  filters({excludeKeywords:'convertible, heated seats'})), true);
assert.equal(helpers.searchExcludedGroup([data.a, data.b],
  filters({excludeKeywords:'Caterham'})), false);

// Group-level filtering: every contributing advert stays or is filtered together.
assert.deepEqual(Array.from(helpers.matchingSearchIds(
  filters({requiredKeywords:'manual, heated seats'}))), ['a','b']);
assert.deepEqual(Array.from(helpers.matchingSearchIds(
  filters({requiredKeywords:'manual, heated seats', excludeKeywords:'performance exhaust'}))), []);
assert.deepEqual(Array.from(helpers.matchingSearchIds(
  filters({preferredKeywords:'unlikely'}))), ['a','b'],
  'Preferred keywords cannot remove cars');
// Grouped AND/OR: the example 'C4S OR Carrera 4S, manual' requires a
// Porsche 4S synonym plus manual, not both competing descriptions.
const porsche = [
  {id:'p', site:'autotrader', title:'Porsche 911 C4S', description:'6 speed manual'},
  {id:'q', site:'ebay', title:'Porsche 911 Carrera 4S', description:'Automatic'}
];
const alternatives = filters({requiredKeywords:'C4S OR Carrera 4S, manual'});
assert.equal(helpers.searchRequiredGroup([porsche[0]], alternatives), true);
assert.equal(helpers.searchRequiredGroup([porsche[1]], alternatives), false);
assert.equal(helpers.searchRequiredGroup(porsche, alternatives), true,
  'Matching evidence can come from different providers for the same car');
assert.equal(helpers.searchRequiredGroup(
  [{title:'Porsche 911 Carrera S',description:'Manual'}], alternatives), false);
assert.equal(helpers.searchRequiredGroup([porsche[1]],
  filters({requiredKeywords:'Carrera 4S, manual',requiredKeywordLogic:'any'})), true,
  'OR mode accepts any comma-delimited group');
assert.equal(helpers.searchRequiredGroup([porsche[1]],
  filters({requiredKeywords:'Carrera 4S, manual',requiredKeywordLogic:'all'})), false,
  'AND mode requires every comma-delimited group');
assert.equal(helpers.searchRequiredGroup([porsche[1]],
  filters({requiredKeywords:'C4S | Carrera 4S',requiredKeywordLogic:'all'})), true,
  'Pipe is also an OR separator');
assert.equal(helpers.searchRequiredGroup(
  [{title:'BMW C4S line',description:'automatic'}],
  filters({requiredKeywords:'C4S, manual',requiredKeywordLogic:'any'})), true);
assert.equal(helpers.searchExcludedGroup([porsche[1]],
  filters({excludeKeywords:'convertible OR Carrera 4S'})), true);
assert.equal(helpers.searchPreferredScore([porsche[1]],
  filters({preferredKeywords:'C4S OR Carrera 4S'})), 2,
  'Preferred synonyms award at most one group score');

console.log('Required and preferred keyword mode tests passed.');
