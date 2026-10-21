// The Atlas Search indexes (search indexes, as opposed to the regular indexes created in
// scripts/setup-db.js): their definitions, and a status check. npm run setup creates
// them, npm run index-status lists them, and the server checks them at startup.
// Three search indexes, chosen to fit the M0 tier's 3 slots: the vector index, the
// title index, and the keyword index (milestone 9). The M10 the app runs on now has no
// cap (see Decisions in PROJECT_PLAN.md).
// Search indexes can't be edited in place: a changed definition means dropping and
// recreating the index (or, for the vector index, a new name; see below).

const config = require('./config');

// Vector search index with Auto-Embedding: Atlas embeds each chunk's text with Voyage AI.
// Scalar quantization, 1024 dimensions, cosine similarity. Cosine, not dotProduct:
// scalar vectors aren't unit length, and dotProduct squeezed every score to about 0.50
// (see Findings in PROJECT_PLAN.md).
// An autoEmbed field can't be edited, and changing the model, path, dimensions or
// quantization re-embeds everything; dropping the index also drops its embeddings. To
// change it, create a new index under a new name.
const vectorIndex = {
  collection: config.collections.chunks,
  name: config.searchIndexes.vector,
  type: 'vectorSearch',
  definition: {
    fields: [
      {
        type: 'autoEmbed',
        modality: 'text',
        path: 'text',
        model: 'voyage-4',
        numDimensions: 1024,
        quantization: 'scalar',
        similarity: 'cosine',
      },
      { type: 'filter', path: 'uploadId' },
    ],
  },
};

// Title search for the web page's picker (GET /api/uploads/search): autocomplete on
// title and fileName, so a few typed letters of any word find an upload. edgeGram
// indexes the start of each word, from 2 letters (fewer match nothing) up to 20.
// foldDiacritics lets "cafe" find "Café". File names are split into words at
// hyphens, underscores and dots by a custom analyzer, since the standard one keeps
// "Shanti_Pouch_Instructions.pdf" as one word. status is indexed to filter on
// complete uploads. Holds no embeddings, so it can be dropped and recreated freely.
const AUTOCOMPLETE = { type: 'autocomplete', tokenization: 'edgeGram', minGrams: 2, maxGrams: 20, foldDiacritics: true };

const titleIndex = {
  collection: config.collections.uploads,
  name: config.searchIndexes.title,
  type: 'search',
  definition: {
    analyzers: [
      {
        name: 'fileNameWords',
        tokenizer: { type: 'regexSplit', pattern: '[-_.\\s]+' },
        tokenFilters: [{ type: 'lowercase' }],
      },
    ],
    mappings: {
      dynamic: false,
      fields: {
        title: AUTOCOMPLETE,
        fileName: { ...AUTOCOMPLETE, analyzer: 'fileNameWords' },
        status: { type: 'token' },
      },
    },
  },
};

// Keyword search on each chunk's text (milestone 9), for hybrid search: $rankFusion
// combines it with vector search. lucene.english lowercases words, drops common ones
// ("the", "a") and reduces them to a base form ("limits" finds "limit"); a question is
// analyzed the same way at search time, and never stored. uploadId is indexed as
// objectId so a query can filter on the selected uploads, like the vector index. Only
// these two fields: dynamic mapping would also index fields no query uses. The analyzer
// splits "NMB-1001" into "nmb" and "1001", while a typed "NMB1001" stays one word, so
// keyword search can't match the two. Holds no embeddings, so it can be dropped and
// recreated freely.
const keywordIndex = {
  collection: config.collections.chunks,
  name: config.searchIndexes.keyword,
  type: 'search',
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        text: { type: 'string', analyzer: 'lucene.english' },
        uploadId: { type: 'objectId' },
      },
    },
  },
};

const SEARCH_INDEXES = [vectorIndex, titleIndex, keywordIndex];

// Each search index with what Atlas reports: { index, exists, status, queryable }.
// queryable is true once a query can use it (also while a new version is building).
async function searchIndexStatus(db) {
  return Promise.all(SEARCH_INDEXES.map(async (index) => {
    const [found] = await db.collection(index.collection).listSearchIndexes(index.name).toArray();
    return { index, exists: Boolean(found), status: found?.status ?? null, queryable: Boolean(found?.queryable) };
  }));
}

module.exports = { vectorIndex, titleIndex, keywordIndex, SEARCH_INDEXES, searchIndexStatus };
