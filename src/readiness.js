// Readiness: whether all of an upload's chunks are searchable (embedded by Atlas and in
// the vector index). New chunks become searchable a few seconds after they are saved;
// until then an upload is left out of "All uploads" and can't be ticked on the page.
//
// The check (search and count): one exact vector search filtered to the upload, with
// limit = its chunk count, then $count. Vector search always returns the closest
// chunks, however unrelated, so any query text works: a chunk comes back if and only
// if it is searchable. Exact search (not approximate) checks every chunk of the
// upload, so none are missed. Each check embeds the query text: a few tokens and one
// request against the Auto-Embedding rate limit.
//
// Once all chunks are searchable, the upload gets searchableAt, which is never checked
// again. It is set only if still unset, so two checks at once (two browser tabs) are
// harmless. Callers: GET /api/uploads/:id, npm run ingest (waits for it), npm run setup
// (fills in uploads that lack it), and npm run probe (counts only).

const config = require('./config');

// How many of the upload's chunks are searchable. `index` lets npm run probe compare
// another vector index.
async function countSearchable(db, upload, { index = config.searchIndexes.vector } = {}) {
  const [counted] = await db.collection(config.collections.chunks).aggregate([
    {
      $vectorSearch: {
        index,
        path: 'text',
        query: { text: 'overview' },
        filter: { uploadId: upload._id },
        exact: true,
        limit: upload.chunkCount,
      },
    },
    { $count: 'searchable' },
  ]).toArray();
  return counted ? counted.searchable : 0;   // $count returns nothing when no chunk matched
}

// Checks a complete upload and sets searchableAt once all its chunks are searchable.
// Returns { searchableAt, searchable } where searchable is the count (chunkCount once
// ready); searchableAt is null while chunks are still missing.
async function checkReadiness(db, upload) {
  if (upload.searchableAt) {
    return { searchableAt: upload.searchableAt, searchable: upload.chunkCount };
  }
  const searchable = await countSearchable(db, upload);
  if (searchable < upload.chunkCount) return { searchableAt: null, searchable };

  const uploads = db.collection(config.collections.uploads);
  const now = new Date();
  const { modifiedCount } = await uploads.updateOne(
    { _id: upload._id, searchableAt: { $exists: false } },
    { $set: { searchableAt: now } },
  );
  // Another check got there first: keep its time.
  const searchableAt = modifiedCount
    ? now
    : (await uploads.findOne({ _id: upload._id })).searchableAt;
  return { searchableAt, searchable };
}

module.exports = { countSearchable, checkReadiness };
