// Creates the collections, regular indexes, and search indexes, then sets searchableAt on
// complete uploads that lack it (see src/readiness.js). Safe to run more than once:
// createIndex does nothing if an identical index already exists, search indexes that
// already exist are skipped, and uploads that have searchableAt aren't checked again.
// The first run filled in the uploads saved before searchableAt existed (milestone 7),
// so their searchableAt says nothing about the embedding delay. Later runs catch an
// upload whose ingest or page was closed before it was searchable.

const { connect } = require('../src/db');
const config = require('../src/config');
const { SEARCH_INDEXES } = require('../src/indexes');
const { checkReadiness } = require('../src/readiness');

// Creates a search index (definitions in src/indexes.js) unless one with the same name
// exists. Never updates an existing index: that would rebuild it (and for the vector
// index, re-embed), so it stays manual.
async function ensureSearchIndex(db, { collection, name, type, definition }) {
  const target = db.collection(collection);
  const [existing] = await target.listSearchIndexes(name).toArray();
  if (existing) {
    console.log(`Search index ${name} already exists (status: ${existing.status}), skipped.`);
    return;
  }
  await target.createSearchIndex({ name, type, definition });
  console.log(`Search index ${name} requested. Atlas builds it in the background;`);
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
    for (const index of SEARCH_INDEXES) await ensureSearchIndex(db, index);

    await fillSearchableAt(db, uploads);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
