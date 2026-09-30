// Finds the chunks closest to a question with Atlas Vector Search.
// The question is sent as text; Atlas embeds it with the same model as the chunks
// (Auto-Embedding), so the app never handles vectors.
//
// Two modes:
// - One upload (uploadId given): exact search within that upload. Exact search checks
//   every chunk that passes the filter, so nothing is missed, and it's cheap within one
//   upload. The caller passes the id of a complete upload.
// - All uploads (no uploadId): approximate search over complete uploads only, so chunks
//   left behind by a failed ingest never reach an answer. Approximate search can miss a
//   few results (see Findings: exact vs approximate search).
//
// Returns the chunks best first, each with its score (cosine: higher is closer).

const { ObjectId } = require('mongodb');
const config = require('./config');

const MAX_CANDIDATES = 10000;   // Atlas limit on numCandidates

async function search(db, question, { uploadId, limit = config.search.limit } = {}) {
  const vectorSearch = {
    index: config.searchIndexes.vector,
    path: 'text',
    query: { text: question },
    limit,
  };

  if (uploadId) {
    // A string would silently match nothing (and look like "not found"), so fail loudly.
    // Callers convert at the edge, e.g. new ObjectId(req.query.uploadId) in the API.
    if (!(uploadId instanceof ObjectId)) throw new TypeError('uploadId must be an ObjectId');
    vectorSearch.filter = { uploadId };
    vectorSearch.exact = true;
  } else {
    const uploadIds = await completeUploadIds(db);
    if (!uploadIds.length) return [];
    vectorSearch.filter = { uploadId: { $in: uploadIds } };
    vectorSearch.numCandidates = Math.min(limit * config.search.candidatesPerResult, MAX_CANDIDATES);
  }

  return db.collection(config.collections.chunks).aggregate([
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
  ]).toArray();
}

// Ids of the complete uploads, for the "All uploads" filter. Chunks have no status
// (it's on the upload), and $vectorSearch can only filter on fields in the vector
// index (uploadId), so the status check happens here first, on the uploads collection.
async function completeUploadIds(db) {
  const uploads = await db.collection(config.collections.uploads)
    .find({ status: 'complete' }, { projection: { _id: 1 } })
    .toArray();
  return uploads.map((upload) => upload._id);
}

module.exports = { search };
