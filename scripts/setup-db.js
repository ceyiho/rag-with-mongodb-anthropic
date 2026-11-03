// Creates the collections, regular indexes, and search indexes, then sets searchableAt on
// complete uploads that lack it (see src/readiness.js). Safe to run more than once:
// createIndex does nothing if an identical index already exists, search indexes that
// already exist are skipped, and uploads that have searchableAt aren't checked again.
// The first run filled in the uploads saved before searchableAt existed (milestone 7),
// so their searchableAt says nothing about the embedding delay. Later runs catch an
// upload whose ingest or page was closed before it was searchable.
//
// npm run setup -- --update <index name> also applies a changed definition from
// src/indexes.js to that existing search index (milestone 10). Atlas builds the new
// version in the background and answers from the old one until it is ready, so title
// search keeps working meanwhile. Never the vector index: an autoEmbed field can't be
// edited, and a rebuild would re-embed every chunk.

const { connect } = require('../src/db');
const config = require('../src/config');
const { SEARCH_INDEXES, vectorIndex } = require('../src/indexes');
const { checkReadiness } = require('../src/readiness');

// Creates a search index (definitions in src/indexes.js) unless one with the same name
// exists. Updates an existing one only when it is the index named with --update.
async function ensureSearchIndex(db, { collection, name, type, definition }, update) {
  const target = db.collection(collection);
  const [existing] = await target.listSearchIndexes(name).toArray();
  if (existing && name === update) {
    await target.updateSearchIndex(name, definition);
    console.log(`Search index ${name} update requested. Atlas builds the new version in the`);
    console.log('background and answers from the old one meanwhile; run "npm run index-status"');
    console.log('to check when it is ready.');
    return;
  }
  if (existing) {
    console.log(`Search index ${name} already exists (status: ${existing.status}), skipped.`);
    return;
  }
  await target.createSearchIndex({ name, type, definition });
  console.log(`Search index ${name} requested. Atlas builds it in the background;`);
  console.log('run "npm run index-status" to check when it is ready.');
}

// The index named with --update, if any, checked before anything is changed.
function indexToUpdate(args) {
  const at = args.indexOf('--update');
  if (at === -1) return null;
  const name = args[at + 1];
  const names = SEARCH_INDEXES.filter((index) => index !== vectorIndex).map((index) => index.name);
  if (name === vectorIndex.name) {
    throw new Error(`${name} can't be updated: an autoEmbed field can't be edited. Create a new index under a new name instead.`);
  }
  if (!names.includes(name)) {
    throw new Error(`--update needs the name of a search index: ${names.join(' or ')}.`);
  }
  return name;
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
  const update = indexToUpdate(process.argv.slice(2));
  const { client, db } = await connect();

  try {
    const uploads = db.collection(config.collections.uploads);
    const chunks = db.collection(config.collections.chunks);

    // Only complete uploads count as duplicates, so a failed ingest can be retried.
    // Being partial, the index holds complete uploads only: a lookup by name uses it only
    // if it includes status: 'complete' ({ fileName } alone scans the collection, as an
    // explain run showed). Leave the status out to find unfinished uploads too, as the
    // ingest's leftover check and npm run cleanup do; at this size the scan is fine.
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
    for (const index of SEARCH_INDEXES) await ensureSearchIndex(db, index, update);

    await fillSearchableAt(db, uploads);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
