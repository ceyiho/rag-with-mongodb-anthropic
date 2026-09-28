// Creates the collections, regular indexes, and search indexes. Safe to run more than once:
// createIndex does nothing if an identical index already exists, and search indexes
// that already exist are skipped.

const { connect } = require('./db');
const config = require('./config');

// Vector search index with Auto-Embedding: Atlas embeds each chunk's text with Voyage AI.
// Settings are the Atlas recommended default (scalar, 1024 dimensions, dotProduct).
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
        similarity: 'dotProduct',
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

    // Last, because a search index needs its collection to exist.
    await ensureSearchIndex(chunks, vectorIndex);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
