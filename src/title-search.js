// Title search for the web page's picker: finds complete uploads whose title or file
// name has words starting with what was typed, with Atlas Search autocomplete (index
// in src/indexes.js). Every typed word must match the start of some word in the title
// or the file name, so "nim gui" finds "Nimbus CLI Guide". Words of fuzzyFrom letters
// or more may contain one typo ("nimbsu" finds Nimbus). Best matches first.
//
// Returns the uploads, or null if the title index is missing or not queryable yet:
// $search on a missing index just finds nothing, so an empty result is checked.

const config = require('./config');
const { titleIndex } = require('./indexes');

const MAX_WORDS = 6;
// The index stores word starts up to this many letters, so a longer typed word is cut
// to it; its first letters still match.
const MAX_LETTERS = titleIndex.definition.mappings.fields.title.maxGrams;

async function searchTitles(db, text) {
  // Split like the index does (spaces, hyphens, underscores, dots). One-letter words
  // match nothing (the index starts at 2 letters), so they are left out unless they
  // are all there is: "nimbus g" searches "nimbus" while the next letter is typed.
  let words = text.toLowerCase().split(/[\s\-_.]+/).filter(Boolean).slice(0, MAX_WORDS)
    .map((word) => word.slice(0, MAX_LETTERS));
  if (words.some((word) => word.length > 1)) words = words.filter((word) => word.length > 1);
  if (!words.length) return [];

  const uploads = db.collection(config.collections.uploads);
  const found = await uploads.aggregate([
    {
      $search: {
        index: titleIndex.name,
        compound: {
          must: words.map((word) => ({
            compound: {
              should: ['title', 'fileName'].map((path) => ({ autocomplete: { path, query: word, ...fuzzy(word) } })),
              minimumShouldMatch: 1,
            },
          })),
          filter: [{ equals: { path: 'status', value: 'complete' } }],
        },
      },
    },
    { $limit: config.titleSearch.limit },
  ]).toArray();

  if (!found.length && !(await titleIndexQueryable(uploads))) return null;
  return found;
}

function fuzzy(word) {
  return word.length >= config.titleSearch.fuzzyFrom
    ? { fuzzy: { maxEdits: 1, prefixLength: 1 } }   // the first letter must be right
    : {};
}

async function titleIndexQueryable(uploads) {
  const [index] = await uploads.listSearchIndexes(titleIndex.name).toArray();
  return Boolean(index?.queryable);
}

module.exports = { searchTitles };
