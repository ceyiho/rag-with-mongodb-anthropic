// Checks whether an upload's chunks are searchable yet (embedded and in the vector index).
// Prints how many of its chunks are searchable, plus the time since the upload was saved,
// using the readiness check in src/readiness.js (search and count). Used in milestone 3
// to measure the embedding delay. Only counts: it never sets searchableAt.
// Usage: npm run probe -- <fileName> [--index <name>]
// --index searches another vector index instead of the one in config.js (to compare indexes).
//
// Caveats:
// - The seconds count from uploadedAt, set when ingest starts. For large uploads they
//   include ingest time (Atlas starts embedding while chunks are still being inserted),
//   so they mean "upload started to fully searchable", not the pure embedding delay.
// - limit is set to the upload's chunk count. Works up to 311 chunks (a 280-page PDF,
//   milestone 6); the Atlas documentation gives no cap on limit for exact search, but
//   recommends exact search below 10,000 MDB docs.
// - Exact search compares against every chunk of the upload, so each run costs more for
//   larger uploads (still small at a few thousand chunks). Each run also embeds the query
//   text: a few tokens and one request against the Auto-Embedding rate limit.
// - Large uploads can take longer than the measured 5–11 s: embedding beyond the rate
//   limit is queued. 311 chunks still took ≤13 s (milestone 6); larger ones may not.
//   The probe reports partial progress correctly ("1400 of 2000").
// - Refuses uploads still "processing" (their chunk count isn't known yet).

const { connect } = require('../src/db');
const config = require('../src/config');
const { countSearchable } = require('../src/readiness');

async function main() {
  const args = process.argv.slice(2);
  let indexName = config.searchIndexes.vector;
  const indexFlag = args.indexOf('--index');
  if (indexFlag !== -1) {
    indexName = args[indexFlag + 1];
    args.splice(indexFlag, 2);
  }

  const [fileName] = args;
  if (!fileName || !indexName) {
    console.error('Usage: npm run probe -- <fileName> [--index <name>]');
    process.exit(1);
  }

  const { client, db } = await connect();

  try {
    const upload = await db.collection(config.collections.uploads)
      .findOne({ fileName, status: 'complete' });
    if (!upload) {
      console.error(`No complete upload named "${fileName}".`);
      process.exit(1);
    }

    const searchable = await countSearchable(db, upload, { index: indexName });
    const seconds = Math.round((Date.now() - upload.uploadedAt.getTime()) / 1000);
    console.log(`${fileName} [${indexName}]: ${searchable} of ${upload.chunkCount} chunk(s) searchable, ${seconds}s after upload`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
