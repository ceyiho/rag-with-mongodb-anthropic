// Title search and facet counts for the web page's picker, both on the title index
// (src/indexes.js).
//
// Title search finds complete uploads whose title or file name has words starting with
// what was typed, with Atlas Search autocomplete. Every typed word must match the start
// of some word in the title or the file name, so "nim gui" finds "Nimbus CLI Guide".
// Words of fuzzyFrom letters or more may contain one typo ("nimbsu" finds Nimbus). Best
// matches first.
//
// Facets (milestone 10) count complete uploads by file type and by size (chunk count),
// with the facet collector of $searchMeta. They count the whole library, not the typed
// words: the page's list isn't narrowed by them, so a chip greyed for 0 matches would
// block a filter that works on the list. Both take the Filter block's ticked chips:
// { type: ['pdf'], size: ['large'] }.
//
// Title search returns the uploads, or null if the title index is missing or not
// queryable yet: $search on a missing index just finds nothing, so an empty result is
// checked. Asking Atlas takes about 1 s, so once the index has been seen queryable, the
// server remembers it until it stops and doesn't ask again. "Not queryable" isn't
// remembered, so an index still being built is picked up once it's ready. An index
// dropped while the server runs then goes unnoticed (searches find nothing) until it
// restarts. The facets return null when the index is missing or doesn't index the
// facet fields yet (an older definition).

const config = require('./config');
const { titleIndex } = require('./indexes');

const MAX_WORDS = 6;
// The index stores word starts up to this many letters, so a longer typed word is cut
// to it; its first letters still match.
const MAX_LETTERS = titleIndex.definition.mappings.fields.title.maxGrams;

const { types: TYPES, sizes: SIZES } = config.facets;

let knownQueryable = false;   // the title index was seen queryable since the server started

async function searchTitles(db, text, filters = {}) {
  const words = typedWords(text);
  if (!words.length) return [];

  const uploads = db.collection(config.collections.uploads);
  const found = await uploads.aggregate([
    { $search: { index: titleIndex.name, compound: matching(words, filterClauses(filters)) } },
    { $limit: config.titleSearch.limit },
  ]).toArray();

  if (found.length) knownQueryable = true;   // a result proves the index works
  else if (!(await titleIndexQueryable(uploads))) return null;
  return found;
}

// Counts by type and size: { type: { pdf: 2, md: 3, txt: 2 }, size: { small: 5, ... } },
// every value listed. Each row's counts apply the other row's chips but not its own, so
// the page can show what adding a second value to a row would give: one $searchMeta per
// row, sent together, or a single one while no chip is ticked.
async function countFacets(db, filters = {}) {
  const uploads = db.collection(config.collections.uploads);
  const { type = [], size = [] } = filters;
  try {
    if (!type.length && !size.length) {
      const facet = await facetQuery(uploads, [], { type: TYPE_FACET, size: SIZE_FACET });
      return facet && { type: typeCounts(facet.type), size: sizeCounts(facet.size) };
    }
    const [byType, bySize] = await Promise.all([
      facetQuery(uploads, filterClauses({ size }), { type: TYPE_FACET }),
      facetQuery(uploads, filterClauses({ type }), { size: SIZE_FACET }),
    ]);
    return byType && bySize && { type: typeCounts(byType.type), size: sizeCounts(bySize.size) };
  } catch (err) {
    // A definition without fileType or chunkCount makes Atlas refuse the facet:
    // 'Cannot facet on field "fileType" because it was not indexed as a "token" field…'
    if (/Cannot facet on field/.test(err.message)) return null;
    throw err;
  }
}

// Split like the index does (spaces, hyphens, underscores, dots). One-letter words match
// nothing (the index starts at 2 letters), so they are left out unless they are all
// there is: "nimbus g" searches "nimbus" while the next letter is typed.
function typedWords(text) {
  let words = text.toLowerCase().split(/[\s\-_.]+/).filter(Boolean).slice(0, MAX_WORDS)
    .map((word) => word.slice(0, MAX_LETTERS));
  if (words.some((word) => word.length > 1)) words = words.filter((word) => word.length > 1);
  return words;
}

// The compound clause: every word (if any) must start a word of the title or the file
// name, and the upload must be complete and pass the filters.
function matching(words, filters) {
  const compound = { filter: [{ equals: { path: 'status', value: 'complete' } }, ...filters] };
  if (words.length) {
    compound.must = words.map((word) => ({
      compound: {
        should: ['title', 'fileName'].map((path) => ({ autocomplete: { path, query: word, ...fuzzy(word) } })),
        minimumShouldMatch: 1,
      },
    }));
  }
  return compound;
}

function fuzzy(word) {
  return word.length >= config.titleSearch.fuzzyFrom
    ? { fuzzy: { maxEdits: 1, prefixLength: 1 } }   // the first letter must be right
    : {};
}

// The ticked chips as filter clauses: within a row any value may match ("or"), and
// each row is its own clause, so the rows combine with "and".
function filterClauses({ type = [], size = [] }) {
  const clauses = [];
  if (type.length) clauses.push({ in: { path: 'fileType', value: type } });
  if (size.length) {
    clauses.push({
      compound: { should: size.map((name) => ({ range: { path: 'chunkCount', ...sizeRange(name) } })), minimumShouldMatch: 1 },
    });
  }
  return clauses;
}

// A size's chunk counts: from the previous size's limit, below its own.
function sizeRange(name) {
  const at = SIZES.findIndex((s) => s.name === name);
  const range = {};
  if (at > 0) range.gte = SIZES[at - 1].below;
  if (SIZES[at].below) range.lt = SIZES[at].below;
  return range;
}

const TYPE_FACET = { type: 'string', path: 'fileType', numBuckets: TYPES.length };
// Number buckets start at each boundary; the last size gets the rest (the default).
// The default would also catch a count below 1, but an upload always has a chunk: a
// file without text is rejected (noText).
const SIZE_FACET = {
  type: 'number',
  path: 'chunkCount',
  boundaries: [1, ...SIZES.filter((s) => s.below).map((s) => s.below)],
  default: SIZES.at(-1).name,
};

// One $searchMeta: the facets asked for, or null if the index is missing (then Atlas
// returns no facets at all).
async function facetQuery(uploads, filters, facets) {
  const [result] = await uploads.aggregate([
    { $searchMeta: { index: titleIndex.name, facet: { operator: { compound: matching([], filters) }, facets } } },
  ]).toArray();
  return result?.facet ?? null;
}

function typeCounts({ buckets }) {
  const counts = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const { _id, count } of buckets) if (_id in counts) counts[_id] = count;
  return counts;
}

// Buckets are named by their lower boundary (1, 10) or by the default name.
function sizeCounts({ buckets }) {
  const counts = Object.fromEntries(SIZES.map((s) => [s.name, 0]));
  for (const { _id, count } of buckets) {
    const at = SIZE_FACET.boundaries.indexOf(_id);
    const name = at === -1 ? _id : SIZES[at].name;
    if (name in counts) counts[name] = count;
  }
  return counts;
}

async function titleIndexQueryable(uploads) {
  if (knownQueryable) return true;
  const [index] = await uploads.listSearchIndexes(titleIndex.name).toArray();
  knownQueryable = Boolean(index?.queryable);
  return knownQueryable;
}

module.exports = { searchTitles, countFacets };
