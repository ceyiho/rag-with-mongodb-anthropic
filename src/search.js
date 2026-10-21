// Finds the chunks closest to a question, with Atlas Vector Search, or with hybrid
// search (vector search and keyword search combined).
// The question is sent as text; Atlas embeds it with the same model as the chunks
// (Auto-Embedding), so the app never handles vectors.
//
// Two modes:
// - Selected uploads (uploadIds given, one or more): exact search within them. Exact
//   search checks every chunk that passes the filter, so nothing is missed, and it's
//   cheap within a few uploads. Above EXACT_MAX_CHUNKS in total it switches to
//   approximate search, which the Atlas documentation recommends at that size. The
//   caller passes the ids of complete uploads.
// - All uploads (no uploadIds): approximate search over searchable uploads only (those
//   with searchableAt, see src/readiness.js), so chunks left behind by a failed ingest,
//   and uploads still being embedded, never reach an answer. Approximate search can
//   miss a few results (see Findings: exact vs approximate search).
//
// Reranking (option `rerank`: a number of candidates; 0 or absent: none): vector search
// fetches that many chunks, and the $rerank stage (a Voyage AI reranker, run by Atlas
// outside the cluster) reads each one's text against the question and re-sorts them;
// the top `limit` are kept. Billed per token: the question once per candidate plus every
// candidate's text. src/answer.js reranks by default (config.search.rerank).
//
// Hybrid search (option `kind: 'hybrid'`; always reranked): vector search and keyword
// search (Atlas Search on the chunks' text, index in src/indexes.js) each fetch `rerank`
// chunks, filtered on the same uploads. $rankFusion merges the two lists, each chunk
// once (Reciprocal Rank Fusion: each list adds 1 / (60 + the chunk's rank)), and
// $rerank re-sorts the whole merged list: between `rerank` chunks (the lists agree)
// and twice that (no overlap). Not cut first: a chunk on both lists always outranks one
// on a single list (at least 2/110 vs at most 1/61), so a cut would drop the tail of
// each list, including vector results that vector search alone would rerank. A missing
// keyword index makes $search find nothing rather than fail, so it's checked when the
// keyword side found nothing.
//
// Returns { search, mode, uploadCount, chunksSearched, rerank, chunks }: search is the
// kind ('vector' or 'hybrid'), mode 'exact' or 'approximate' (how vector search ran),
// chunksSearched the chunk count of the uploads searched, rerank { model, candidates }
// (candidates: how many chunks were actually reranked) or null, and chunks the results
// best first, each with its upload's title, fileType and chunkCount, joined from
// uploads, and:
// - score: what the threshold checks. The rerank score when reranked (higher is more
//   relevant), otherwise the cosine one.
// - vectorScore: the cosine score (higher is closer); null for a chunk only keyword
//   search found.
// - vectorRank, keywordRank: the chunk's position in each list before reranking (1 =
//   first), or null when that list didn't find it (or, for keyword, didn't run).
// - fusionScore: the merged score (hybrid only, else null). It depends only on the
//   ranks (about 0.009 to 0.033), so it says nothing about relevance.

const { ObjectId } = require('mongodb');
const config = require('./config');
const { keywordIndex } = require('./indexes');

const MAX_CANDIDATES = 10000;     // Atlas limit on numCandidates
const EXACT_MAX_CHUNKS = 10000;   // the Atlas documentation: exact search below 10,000
const KINDS = ['vector', 'hybrid'];

// Thrown when hybrid search can't run because the keyword index is missing or not
// queryable yet (the API turns it into 503 hybridUnavailable).
class HybridUnavailable extends Error {}

let keywordIndexKnownQueryable = false;   // seen queryable since the server started

async function search(db, question, { uploadIds, limit = config.search.limit, rerank, kind = 'vector' } = {}) {
  let uploads;
  if (uploadIds) {
    // A string would silently match nothing (and look like "not found"), and an empty
    // list mustn't quietly mean "all uploads", so fail loudly. Callers convert at the
    // edge, e.g. src/api/ids.js in the API.
    if (!uploadIds.length || !uploadIds.every((id) => id instanceof ObjectId)) {
      throw new TypeError('uploadIds must be a non-empty array of ObjectIds');
    }
    uploads = await findUploads(db, { _id: { $in: uploadIds } });
  } else {
    uploads = await findUploads(db, { searchableAt: { $exists: true } });
  }
  // A count, not a yes/no (that's src/answer.js's option): `true` would quietly rerank
  // only `limit` candidates.
  if (rerank !== undefined && !(Number.isInteger(rerank) && rerank >= 0)) {
    throw new TypeError('rerank must be a number of candidates (0 for none)');
  }
  if (!KINDS.includes(kind)) throw new TypeError(`kind must be one of ${KINDS.join(', ')}`);
  // The merged score depends only on ranks, so no threshold can use it.
  const hybrid = kind === 'hybrid';
  if (hybrid && !rerank) throw new TypeError('hybrid search is always reranked');

  const chunksSearched = uploads.reduce((sum, upload) => sum + upload.chunkCount, 0);
  const exact = Boolean(uploadIds) && chunksSearched <= EXACT_MAX_CHUNKS;
  // Reranking needs at least `limit` candidates to keep `limit` results. In hybrid
  // search, each side fetches this many.
  const candidates = rerank ? Math.max(rerank, limit) : limit;
  const result = {
    search: kind,
    mode: exact ? 'exact' : 'approximate',
    uploadCount: uploads.length,
    chunksSearched,
    rerank: rerank ? { model: config.search.rerank.model, candidates: 0 } : null,
  };
  if (!uploads.length) return { ...result, chunks: [] };

  // The filter is always a list of upload ids: $vectorSearch can only filter on fields
  // in the vector index (uploadId), and searchableAt is on the upload, not the chunks.
  const ids = uploads.map((upload) => upload._id);
  const vectorSearch = {
    index: config.searchIndexes.vector,
    path: 'text',
    query: { text: question },
    filter: { uploadId: { $in: ids } },
    limit: candidates,
  };
  if (exact) {
    vectorSearch.exact = true;
  } else {
    vectorSearch.numCandidates = Math.min(candidates * config.search.candidatesPerResult, MAX_CANDIDATES);
  }

  const fields = { uploadId: 1, fileName: 1, section: 1, chunkIndex: 1, text: 1 };
  // Counts the candidates before $rerank (and, in hybrid search, the keyword side's
  // finds). Each chunk carries the totals; they're read off the first one below.
  const counting = (extra = {}) => ({
    candidateCount: { $count: {}, window: { documents: ['unbounded', 'unbounded'] } },
    ...extra,
  });

  const searching = hybrid ? [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: vectorSearch }],
            keyword: [
              {
                $search: {
                  index: config.searchIndexes.keyword,
                  compound: {
                    must: [{
                      text: { query: question, path: 'text', fuzzy: { maxEdits: config.search.hybrid.fuzzyMaxEdits } },
                    }],
                    // Filter clauses don't change the score, like $vectorSearch's filter.
                    filter: [{ in: { path: 'uploadId', value: ids } }],
                  },
                },
              },
              { $limit: candidates },   // $search has no limit of its own
            ],
          },
        },
        scoreDetails: true,
      },
    },
    // Input pipelines can't add fields, and after $rankFusion the vector score is only
    // in scoreDetails ($meta "vectorSearchScore" fails there), so the ranks and the
    // cosine are copied out of it.
    { $project: { ...fields, fusionScore: { $meta: 'score' }, details: { $meta: 'scoreDetails' } } },
    {
      $set: {
        vectorRank: fromDetails('vector', 'rank'),
        keywordRank: fromDetails('keyword', 'rank'),
        vectorScore: fromDetails('vector', 'value'),
      },
    },
    { $unset: 'details' },
    {
      $setWindowFields: {
        output: counting({
          keywordFound: {
            $sum: { $cond: [{ $eq: ['$keywordRank', null] }, 0, 1] },
            window: { documents: ['unbounded', 'unbounded'] },
          },
        }),
      },
    },
    { $set: { score: '$fusionScore' } },   // replaced by the rerank score
  ] : [
    { $vectorSearch: vectorSearch },
    {
      $project: {
        ...fields,
        score: { $meta: 'vectorSearchScore' },
        vectorScore: { $meta: 'vectorSearchScore' },
      },
    },
    // Numbers the chunks in vector order, so the page can show how far reranking moved
    // each one ("vector #23 → #2").
    {
      $setWindowFields: {
        sortBy: { vectorScore: -1 },
        output: { vectorRank: { $documentNumber: {} }, ...counting() },
      },
    },
    { $set: { keywordRank: null, fusionScore: null } },
  ];

  // $rerank takes the candidates in pipeline order; numDocsToRerank covers all of them
  // (hybrid search: up to both lists in full).
  const reranking = rerank ? [
    {
      $rerank: {
        query: { text: question },
        path: 'text',
        numDocsToRerank: hybrid ? candidates * 2 : candidates,
        model: config.search.rerank.model,
      },
    },
    { $set: { score: { $meta: 'score' } } },   // $rerank replaced the search score
    // Rerank scores keep about 3 significant digits, so ties are common, and $rerank
    // returns tied chunks in no useful order. The merged score (hybrid), then the
    // cosine, break ties, so the cut at `limit` keeps the better chunks and runs repeat.
    { $sort: { score: -1, fusionScore: -1, vectorScore: -1 } },
    { $limit: limit },
  ] : [];

  const chunks = await db.collection(config.collections.chunks).aggregate([
    ...searching,
    ...reranking,
    // Joins each chunk's upload (a join between collections, like SQL's JOIN), for the
    // fields citations show. Keeps the order of the search results.
    {
      $lookup: {
        from: config.collections.uploads,
        localField: 'uploadId',
        foreignField: '_id',
        pipeline: [{ $project: { _id: 0, title: 1, fileType: 1, chunkCount: 1 } }],
        as: 'upload',
      },
    },
    { $unwind: '$upload' },
    { $replaceWith: { $mergeObjects: ['$$ROOT', '$upload'] } },
    { $unset: 'upload' },
  ]).toArray();

  const { candidateCount = 0, keywordFound = 0 } = chunks[0] ?? {};
  for (const chunk of chunks) {
    delete chunk.candidateCount;
    delete chunk.keywordFound;
  }
  if (hybrid && !keywordFound && !(await keywordIndexQueryable(db))) {
    throw new HybridUnavailable('the keyword search index is missing or not queryable yet');
  }
  if (result.rerank) result.rerank.candidates = candidateCount;
  return { ...result, chunks };
}

// An expression that reads one field (rank or value) of one input list's entry in
// $rankFusion's scoreDetails, or null when that list didn't find the chunk: its entry
// then has rank "NA" (text, not documented) and no value. scoreDetails' format isn't
// guaranteed, so anything that isn't a number counts as missing.
function fromDetails(pipelineName, field) {
  const entry = {
    $first: { $filter: { input: '$details.details', cond: { $eq: ['$$this.inputPipelineName', pipelineName] } } },
  };
  return {
    $let: {
      vars: { entry },
      in: {
        $cond: [
          { $and: [{ $isNumber: '$$entry.rank' }, { $isNumber: `$$entry.${field}` }] },
          `$$entry.${field}`,
          null,
        ],
      },
    },
  };
}

// Like the title index in src/title-search.js: asking Atlas takes about 1 s, so a
// queryable keyword index is remembered until the server stops; "not queryable" isn't.
async function keywordIndexQueryable(db) {
  if (keywordIndexKnownQueryable) return true;
  const [index] = await db.collection(keywordIndex.collection).listSearchIndexes(keywordIndex.name).toArray();
  keywordIndexKnownQueryable = Boolean(index?.queryable);
  return keywordIndexKnownQueryable;
}

// Complete uploads matching the filter, with what the search needs from them.
function findUploads(db, filter) {
  return db.collection(config.collections.uploads)
    .find({ ...filter, status: 'complete' }, { projection: { _id: 1, chunkCount: 1 } })
    .toArray();
}

module.exports = { search, HybridUnavailable };
