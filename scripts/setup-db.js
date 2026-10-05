// Creates the collections, regular indexes, and search indexes, then sets searchableAt on
// complete uploads that lack it (see src/readiness.js). Safe to run more than once:
// createIndex does nothing if an identical index already exists, search indexes that
// already exist are skipped, and uploads that have searchableAt aren't checked again.
// The first run filled in the uploads saved before searchableAt existed (milestone 7),
// so their searchableAt says nothing about the embedding delay. Later runs catch an
// upload whose ingest or page was closed before it was searchable.

const { connect } = require('../src/db');
const config = require('../src/config');
const { checkReadiness } = require('../src/readiness');

// Vector search index with Auto-Embedding: Atlas embeds each chunk's text with Voyage AI.
// Scalar quantization, 1024 dimensions, cosine similarity. Cosine, not dotProduct:
// scalar vectors aren't unit length, and dotProduct squeezed every score to about 0.50
// (see Findings in PROJECT_PLAN.md).
// An autoEmbed field can't be edited, and changing the model, path, dimensions or
// quantization re-embeds everything. To change it, create a new index under a new name.
const vectorIndex = {
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

// Creates a search index unless one with the same name exists. Never updates an
// existing index: that would rebuild it (and possibly re-embed), so it stays manual.
async function ensureSearchIndex(collection, index) {
  const [existing] = await collection.listSearchIndexes(index.name).toArray();
  if (existing) {
    console.log(`Search index ${index.name} already exists (status: ${existing.status}), skipped.`);
    return;
  }
  await collection.createSearchIndex(index);
  console.log(`Search index ${index.name} requested. Atlas builds it in the background;`);
  console.log('run "npm run index-status" to check when it is ready.');
}

// Runs the readiness check on each complete upload without searchableAt. An upload that
// isn't fully searchable yet (still embedding, or the vector index still building) is
// left as it is, to be caught by a later run.
async function fillSearchableAt(db, uploads) {
  const pending = await uploads
    .find({ status: 'complete', searchableAt: { $exists: false } })
    .toArray();
  if (!pending.length) {
    console.log('Every complete upload has searchableAt.');
    return;
  }
  console.log(`Checking ${pending.length} upload(s) without searchableAt:`);
  for (const upload of pending) {
    const { searchableAt, searchable } = await checkReadiness(db, upload);
    console.log(searchableAt
      ? `  ${upload.fileName}: searchable, searchableAt set`
      : `  ${upload.fileName}: ${searchable} of ${upload.chunkCount} chunk(s) searchable, `
        + 'left unset; run npm run setup again later');
  }
}

async function main() {
  const { client, db } = await connect();

  try {
    const uploads = db.collection(config.collections.uploads);
    const chunks = db.collection(config.collections.chunks);

    // Only complete uploads count as duplicates, so a failed ingest can be retried.
    await uploads.createIndex(
      { fileName: 1 },
      {
        name: 'fileName_unique_complete',
        unique: true,
        partialFilterExpression: { status: 'complete' },
      },
    );

    // Finds an upload's chunks quickly, for cleanup after a failed ingest.
    await chunks.createIndex({ uploadId: 1 }, { name: 'uploadId' });

    for (const collection of [uploads, chunks]) {
      const indexes = await collection.indexes();
      console.log(`${db.databaseName}.${collection.collectionName} indexes:`);
      for (const index of indexes) {
        console.log(`  ${index.name}`, JSON.stringify(index.key),
          index.unique ? 'unique' : '',
          index.partialFilterExpression ? `where ${JSON.stringify(index.partialFilterExpression)}` : '');
      }
    }

    // After the collections, because a search index needs its collection to exist.
    await ensureSearchIndex(chunks, vectorIndex);

    await fillSearchableAt(db, uploads);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
