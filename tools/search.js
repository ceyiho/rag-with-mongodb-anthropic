// Asks a question from the command line and prints the closest chunks with their scores.
// Usage: npm run search -- "<question>" [--upload <fileName>] [--limit <n>]
// --upload searches one complete upload (exact search); without it, all searchable uploads.
// --limit sets how many chunks to return (default in config.js).
// Each run embeds the question: a few tokens and one request against the rate limit.

const { connect } = require('../src/db');
const { search } = require('../src/search');
const config = require('../src/config');

const SNIPPET_LENGTH = 160;

// Removes "--name value" from args and returns the value (undefined if absent).
function takeFlag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const fileName = takeFlag(args, '--upload');
  const limitArg = takeFlag(args, '--limit');
  const limit = limitArg === undefined ? config.search.limit : Number(limitArg);
  const question = args.join(' ').trim();

  if (!question || !Number.isInteger(limit) || limit < 1) {
    console.error('Usage: npm run search -- "<question>" [--upload <fileName>] [--limit <n>]');
    process.exit(1);
  }

  const { client, db } = await connect();

  try {
    let uploadId;
    if (fileName) {
      const upload = await db.collection(config.collections.uploads)
        .findOne({ fileName, status: 'complete' });
      if (!upload) {
        console.error(`No complete upload named "${fileName}".`);
        process.exit(1);
      }
      uploadId = upload._id;
    }

    const results = await search(db, question, { uploadId, limit });
    console.log(`"${question}" in ${fileName || 'All uploads'}: ${results.length} result(s)\n`);

    results.forEach((chunk, i) => {
      const snippet = chunk.text.replace(/\s+/g, ' ').slice(0, SNIPPET_LENGTH);
      console.log(`${i + 1}. ${chunk.score.toFixed(4)}  ${chunk.fileName} #${chunk.chunkIndex}  [${chunk.section}]`);
      console.log(`   ${snippet}${chunk.text.length > SNIPPET_LENGTH ? '…' : ''}\n`);
    });
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Search failed:', err.message);
  process.exit(1);
});
