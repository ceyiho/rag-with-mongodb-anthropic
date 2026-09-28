// Checks whether an upload's chunks are searchable yet (embedded and in the vector index).
// Runs one vector search filtered to that upload and prints how many of its chunks came
// back (and the top 3), plus the time since the upload was saved. Used in milestone 3 to measure the embedding delay.
// Usage: npm run probe -- <fileName> [question] [--index <name>]
// --index searches another vector index instead of the one in config.js (to compare indexes).

const { connect } = require('./db');
const config = require('./config');

async function main() {
  const args = process.argv.slice(2);
  let indexName = config.searchIndexes.vector;
  const indexFlag = args.indexOf('--index');
  if (indexFlag !== -1) {
    indexName = args[indexFlag + 1];
    args.splice(indexFlag, 2);
  }

  const [fileName, question = 'overview'] = args;
  if (!fileName || !indexName) {
    console.error('Usage: npm run probe -- <fileName> [question] [--index <name>]');
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

    // Atlas embeds the question text with the index's model, then finds the closest chunks.
    const results = await db.collection(config.collections.chunks).aggregate([
      {
        $vectorSearch: {
          index: indexName,
          path: 'text',
          query: { text: question },
          filter: { uploadId: upload._id },
          // Ask for every chunk, so "N of N found" means the whole upload is searchable.
          numCandidates: Math.max(50, upload.chunkCount),
          limit: upload.chunkCount,
        },
      },
      { $project: { _id: 0, section: 1, chunkIndex: 1, score: { $meta: 'vectorSearchScore' } } },
    ]).toArray();

    const seconds = Math.round((Date.now() - upload.uploadedAt.getTime()) / 1000);
    console.log(`${fileName} [${indexName}]: ${results.length} of ${upload.chunkCount} chunk(s) found, ${seconds}s after upload`);
    for (const { section, chunkIndex, score } of results.slice(0, 3)) {
      console.log(`  ${score.toFixed(4)}  #${chunkIndex}  ${section}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Probe failed:', err.message);
  process.exit(1);
});
