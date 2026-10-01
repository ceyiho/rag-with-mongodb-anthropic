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
  // The Atlas documentation suggests at least 20× the limit; Atlas caps it at 10,000.
  search: {
    limit: 5,
    candidatesPerResult: 20,
    // "Not found" thresholds on the top score, one per search mode: below it, the app
    // replies "not found in your uploads" without calling the LLM. See Findings in
    // PROJECT_PLAN.md ("Not found" score threshold); re-check with a real PDF.
    notFoundThreshold: {
      oneUpload: 0.62,
      allUploads: 0.62,
    },
  },

  // Answers (src/answer.js). The API key is in .env (ANTHROPIC_API_KEY).
  answer: {
    model: 'claude-sonnet-5-5',
    // Output cap per answer, including the model's thinking. Answers are short; this
    // only stops a runaway reply.
    maxTokens: 16000,
    notFoundReply: 'not found in your uploads',
  },

  // PDF extraction (src/extractors/pdf.js). A PDF averaging fewer characters per page
  // than this is rejected as scanned. Text PDFs here averaged ~800–1,200; covers and
  // picture pages pull the average down, so keep this well below that.
  pdf: {
    minAverageChars: 100,
  },

  // Sizes in characters (≈4 characters per token). Confirmed in milestone 4 against
  // 1,000 (see Findings in PROJECT_PLAN.md: Chunk size). Changing them means
  // re-ingesting, and so re-embedding, every upload.
  chunking: {
    targetSize: 1600,
    maxSize: 2000,
    overlap: 200,
  },
};
