// Finds the chunks closest to a question with Atlas Vector Search.
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
// Reranking (option `rerank`: a number of candidates; milestone 9, being measured):
// vector search fetches that many chunks, and the $rerank stage (a Voyage AI reranker,
// run by Atlas outside the cluster) reads each one's text against the question and
// re-sorts them; the top `limit` are kept. It replaces the score, so the cosine score is
// kept as vectorScore first. Billed per token: the question once per candidate plus
// every candidate's text.
//
// Returns { mode, uploadCount, chunksSearched, rerank, chunks }: mode is 'exact' or
// 'approximate', chunksSearched the chunk count of the uploads searched, rerank
// { model, candidates } or null, and chunks the results best first, each with its score
// (cosine: higher is closer; when reranked, the rerank score: higher is more relevant,
// with vectorScore the cosine one) and its upload's title, fileType and chunkCount,
// joined from uploads.

const { ObjectId } = require('mongodb');
const config = require('./config');

const MAX_CANDIDATES = 10000;     // Atlas limit on numCandidates
const EXACT_MAX_CHUNKS = 10000;   // the Atlas documentation: exact search below 10,000

async function search(db, question, { uploadIds, limit = config.search.limit, rerank } = {}) {
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

  const chunksSearched = uploads.reduce((sum, upload) => sum + upload.chunkCount, 0);
  const exact = Boolean(uploadIds) && chunksSearched <= EXACT_MAX_CHUNKS;
  // Reranking needs at least `limit` candidates to keep `limit` results.
  const candidates = rerank ? Math.max(rerank, limit) : limit;
  const result = {
    mode: exact ? 'exact' : 'approximate',
    uploadCount: uploads.length,
    chunksSearched,
    rerank: rerank ? { model: config.search.rerank.model, candidates } : null,
  };
  if (!uploads.length) return { ...result, chunks: [] };

  // The filter is always a list of upload ids: $vectorSearch can only filter on fields
  // in the vector index (uploadId), and searchableAt is on the upload, not the chunks.
  const vectorSearch = {
    index: config.searchIndexes.vector,
    path: 'text',
    query: { text: question },
    filter: { uploadId: { $in: uploads.map((upload) => upload._id) } },
    limit: candidates,
  };
  if (exact) {
    vectorSearch.exact = true;
  } else {
    vectorSearch.numCandidates = Math.min(candidates * config.search.candidatesPerResult, MAX_CANDIDATES);
  }

  // $rerank takes the candidates in pipeline order; $vectorSearch returns them best first.
  const reranking = rerank ? [
    {
      $rerank: {
        query: { text: question },
        path: 'text',
        numDocsToRerank: candidates,
        model: config.search.rerank.model,
      },
    },
    { $set: { vectorScore: '$score', score: { $meta: 'score' } } },
    { $limit: limit },
  ] : [];

  const chunks = await db.collection(config.collections.chunks).aggregate([
    { $vectorSearch: vectorSearch },
    {
      $project: {
        uploadId: 1,
        fileName: 1,
        section: 1,
        chunkIndex: 1,
        text: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
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

  return { ...result, chunks };
}

// Complete uploads matching the filter, with what the search needs from them.
function findUploads(db, filter) {
  return db.collection(config.collections.uploads)
    .find({ ...filter, status: 'complete' }, { projection: { _id: 1, chunkCount: 1 } })
    .toArray();
}

module.exports = { search };
