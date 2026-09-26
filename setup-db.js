// Creates the collections and regular indexes. Safe to run more than once:
// createIndex does nothing if an identical index already exists.

const { connect } = require('./db');
const config = require('./config');

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
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
