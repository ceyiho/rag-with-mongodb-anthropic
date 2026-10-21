// Asks a question from the command line and prints the closest chunks with their scores.
// Usage: npm run search -- "<question>" [--upload <fileName>]... [--limit <n>]
//        [--rerank <n> | --no-rerank] [--search vector|hybrid]
// --upload searches that complete upload (exact search); repeat it to search several.
// Without it, all searchable uploads (approximate search).
// --limit sets how many chunks to return (default in config.js).
// Like answers, results are reranked by default (config.search.rerank), showing both
// scores. --rerank reranks the top n vector results instead; --no-rerank shows vector
// search alone.
// --search hybrid combines vector search with keyword search (always reranked; --rerank
// then sets how many chunks each side fetches). Each result shows its rank in each list
// before reranking.
// Each run embeds the question: a few tokens and one request against the rate limit.
// Reranking costs about 20,000 tokens at 50 candidates; hybrid search up to twice that.

const { connect } = require('../src/db');
const { search } = require('../src/search');
const config = require('../src/config');

const SNIPPET_LENGTH = 160;
const USAGE = 'Usage: npm run search -- "<question>" [--upload <fileName>]... [--limit <n>] '
  + '[--rerank <n> | --no-rerank] [--search vector|hybrid]';

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
  const noRerankAt = args.indexOf('--no-rerank');   // a flag without a value
  if (noRerankAt !== -1) args.splice(noRerankAt, 1);
  const rerank = noRerankAt !== -1 ? 0
    : rerankArg === undefined ? config.search.rerank.candidates : Number(rerankArg);
  const [kind = 'vector'] = takeFlags(args, '--search');
  const question = args.join(' ').trim();

  const badKind = !['vector', 'hybrid'].includes(kind);
  if (kind === 'hybrid' && !rerank) console.error('Hybrid search is always reranked; leave out --no-rerank.');
  if (!question || badKind || (kind === 'hybrid' && !rerank) || fileNames.includes(undefined) || !Number.isInteger(limit) || limit < 1
    || !Number.isInteger(rerank) || rerank < 0 || (noRerankAt !== -1 && rerankArg !== undefined)) {
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
    const result = await search(db, question, { uploadIds, limit, rerank, kind });
    const { mode, uploadCount, chunksSearched, chunks } = result;
    console.log(`"${question}" in ${fileNames.join(', ') || 'All uploads'}`);
    const how = result.search === 'hybrid' ? `hybrid search (${mode} vector side)` : `${mode} vector search`;
    console.log(`${how} over ${uploadCount} upload(s), ${chunksSearched} chunks: `
      + `${chunks.length} result(s) in ${Date.now() - started} ms`);
    if (result.rerank) {
      console.log(`reranked ${result.rerank.candidates} candidates with ${result.rerank.model}; `
        + 'scores: rerank, then cosine and rank in each list');
    }
    console.log('');

    chunks.forEach((chunk, i) => {
      const snippet = chunk.text.replace(/\s+/g, ' ').slice(0, SNIPPET_LENGTH);
      const lists = [
        `vector ${chunk.vectorRank ? `#${chunk.vectorRank} ${chunk.vectorScore.toFixed(4)}` : '-'}`,
        result.search === 'hybrid' && `keyword ${chunk.keywordRank ? `#${chunk.keywordRank}` : '-'}`,
      ].filter(Boolean).join(', ');
      const score = result.rerank ? `${chunk.score.toFixed(4)} (${lists})` : `${chunk.score.toFixed(4)} (vector #${chunk.vectorRank})`;
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
