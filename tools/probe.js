// Checks whether an upload's chunks are searchable yet (embedded and in the vector index).
// Runs one exact vector search filtered to that upload and prints how many of its chunks
// are searchable, plus the time since the upload was saved. Used in milestone 3 to measure
// the embedding delay; the reference version of readiness check A (see Open decisions).
// Usage: npm run probe -- <fileName> [--index <name>]
// --index searches another vector index instead of the one in config.js (to compare indexes).
//
// Caveats:
// - The seconds count from uploadedAt, set when ingest starts. For large uploads they
//   include ingest time (Atlas starts embedding while chunks are still being inserted),
//   so they mean "upload started to fully searchable", not the pure embedding delay.
// - limit is set to the upload's chunk count. Tested only up to 11 chunks; the docs give
//   no cap on limit for exact search, but recommend exact search below 10,000 MDB docs.
//   Confirm with a large PDF in milestone 6.
// - Exact search compares against every chunk of the upload, so each run costs more for
//   larger uploads (still small at a few thousand chunks). Each run also embeds the query
//   text: a few tokens and one request against the Auto-Embedding rate limit.
// - Large uploads can take longer than the measured 5–11 s: embedding beyond the rate
//   limit is queued. The probe reports partial progress correctly ("1400 of 2000").
// - Refuses uploads still "processing" (their chunk count isn't known yet).

const { connect } = require('../src/db');
const config = require('../src/config');

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

    // Vector search always returns the closest chunks, however unrelated, so any query text
    // works: a chunk comes back if and only if it is searchable. Exact search (not
    // approximate) checks every chunk of the upload, so none are missed; $count returns
    // just the number instead of the chunks.
    const [counted] = await db.collection(config.collections.chunks).aggregate([
      {
        $vectorSearch: {
          index: indexName,
          path: 'text',
          query: { text: 'overview' },
          filter: { uploadId: upload._id },
          exact: true,
          limit: upload.chunkCount,
        },
      },
      { $count: 'searchable' },
    ]).toArray();

    // $count returns nothing at all when no chunk matched.
    const searchable = counted ? counted.searchable : 0;
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
