// Asks a question from the command line and prints the closest chunks with their scores.
// Usage: npm run search -- "<question>" [--upload <fileName>]... [--limit <n>] [--rerank <n>]
// --upload searches that complete upload (exact search); repeat it to search several.
// Without it, all searchable uploads (approximate search).
// --limit sets how many chunks to return (default in config.js).
// --rerank reranks the top n vector results (model in config.js) and shows both scores.
// Each run embeds the question: a few tokens and one request against the rate limit.
// Reranking costs about 20,000 tokens at 50 candidates.

const { connect } = require('../src/db');
const { search } = require('../src/search');
const config = require('../src/config');

const SNIPPET_LENGTH = 160;
const USAGE = 'Usage: npm run search -- "<question>" [--upload <fileName>]... [--limit <n>] [--rerank <n>]';

// Removes every "--name value" from args and returns the values ([] if absent).
function takeFlags(args, name) {
  const values = [];
  for (let at = args.indexOf(name); at !== -1; at = args.indexOf(name)) {
    const [, value] = args.splice(at, 2);
    values.push(value);
  }
  return values;
}

async function main() {
  const args = process.argv.slice(2);
  const fileNames = takeFlags(args, '--upload');
  const [limitArg] = takeFlags(args, '--limit');
  const limit = limitArg === undefined ? config.search.limit : Number(limitArg);
  const [rerankArg] = takeFlags(args, '--rerank');
  const rerank = rerankArg === undefined ? 0 : Number(rerankArg);
  const question = args.join(' ').trim();

  if (!question || fileNames.includes(undefined) || !Number.isInteger(limit) || limit < 1
    || !Number.isInteger(rerank) || rerank < 0) {
    console.error(USAGE);
    process.exit(1);
  }

  const { client, db } = await connect();

  try {
    let uploadIds;
    if (fileNames.length) {
      const uploads = await db.collection(config.collections.uploads)
        .find({ fileName: { $in: fileNames }, status: 'complete' }).toArray();
      const missing = fileNames.filter((name) => !uploads.some((u) => u.fileName === name));
      if (missing.length) {
        console.error(`No complete upload named ${missing.map((name) => `"${name}"`).join(', ')}.`);
        process.exit(1);
      }
      uploadIds = uploads.map((upload) => upload._id);
    }

    const started = Date.now();
    const result = await search(db, question, { uploadIds, limit, rerank });
    const { mode, uploadCount, chunksSearched, chunks } = result;
    console.log(`"${question}" in ${fileNames.join(', ') || 'All uploads'}`);
    console.log(`${mode} search over ${uploadCount} upload(s), ${chunksSearched} chunks: `
      + `${chunks.length} result(s) in ${Date.now() - started} ms`);
    if (result.rerank) {
      console.log(`reranked ${result.rerank.candidates} candidates with ${result.rerank.model}; `
        + 'scores: rerank (vector)');
    }
    console.log('');

    chunks.forEach((chunk, i) => {
      const snippet = chunk.text.replace(/\s+/g, ' ').slice(0, SNIPPET_LENGTH);
      const score = chunk.score.toFixed(4) + (result.rerank ? ` (${chunk.vectorScore.toFixed(4)})` : '');
      console.log(`${i + 1}. ${score}  ${chunk.title} (${chunk.fileType}) `
        + `#${chunk.chunkIndex + 1} of ${chunk.chunkCount}  [${chunk.section}]`);
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
