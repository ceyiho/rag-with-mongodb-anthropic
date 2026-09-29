// Application settings. Committed to git.
// Secrets and per-machine values (connection string, database name) go in .env instead.

module.exports = {
  collections: {
    uploads: 'uploads',
    chunks: 'chunks',
  },

  // Atlas Search indexes on the chunks collection. The definitions are in scripts/setup-db.js.
  // Search indexes can't be edited, so a changed definition gets a new name.
  searchIndexes: {
    vector: 'chunks_vector_cosine',
  },

  // Vector search (src/search.js). numCandidates applies to "All uploads" (approximate
  // search) only: how many nearest chunks Atlas considers before keeping the top `limit`.
  // The Atlas docs suggest 10–20× the limit; Atlas caps it at 10,000.
  search: {
    limit: 5,
    candidatesPerResult: 20,
    // "Not found" thresholds on the top score, one per search mode: below it, the app
    // replies "not found in your uploads" without calling the LLM. Provisional; see
    // Findings in PROJECT_PLAN.md ("Not found" score threshold).
    notFoundThreshold: {
      oneUpload: 0.62,
      allUploads: 0.62,
    },
  },

  // Sizes in characters (≈4 characters per token). Provisional: confirm with
  // test-questions.json in milestone 4, before bulk uploads. Changing them after
  // that means re-embedding everything.
  chunking: {
    targetSize: 1600,
    maxSize: 2000,
    overlap: 200,
  },
};
