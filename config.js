// Application settings. Committed to git.
// Secrets and per-machine values (connection string, database name) go in .env instead.

module.exports = {
  collections: {
    uploads: 'uploads',
    chunks: 'chunks',
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
