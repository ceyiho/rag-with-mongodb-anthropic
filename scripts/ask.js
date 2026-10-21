// Asks a question from the command line and prints the answer with its sources.
// Usage: npm run ask -- "<question>" [--upload <fileName>]... [--no-rerank | --search hybrid]
// --upload asks that complete upload; repeat it to ask several. Without it, all
// searchable uploads.
// --no-rerank answers from vector search alone (by default the chunks are reranked).
// --search hybrid answers from hybrid search: vector and keyword search combined, always
// reranked (up to twice the rerank tokens). --search vector is the default.
// Each run embeds the question, reranks (about 20,000 tokens), and calls the LLM unless
// the top score is below the "not found" threshold. To see the raw chunks and scores,
// use npm run search.

const { connect } = require('../src/db');
const { answer, locationLabel } = require('../src/answer');
const config = require('../src/config');

// Removes every "--name value" from args and returns the values ([] if absent).
// It removes the flags and their values wherever they are, so the leftover words can
// be joined back into the question.
function takeFlags(args, name) {
  const values = [];
  for (let at = args.indexOf(name); at !== -1; at = args.indexOf(name)) {
    const [, value] = args.splice(at, 2);   // splice removes the flag and its value
    values.push(value);
  }
  return values;
}

async function main() {
  // Read the command line. process.argv is ['node', 'scripts/ask.js', ...what you
  // typed after --], so slice(2) keeps only your words. Take out --upload first; what
  // is left is the question (joined, in case it wasn't quoted).
  const args = process.argv.slice(2);
  const fileNames = takeFlags(args, '--upload');
  // --no-rerank has no value, so remove just the flag itself.
  const noRerankAt = args.indexOf('--no-rerank');
  if (noRerankAt !== -1) args.splice(noRerankAt, 1);
  const [search = 'vector'] = takeFlags(args, '--search');
  const question = args.join(' ').trim();

  // Hybrid search is always reranked: its merged score can't be checked against a
  // threshold.
  const badSearch = !['vector', 'hybrid'].includes(search) || (search === 'hybrid' && noRerankAt !== -1);
  if (!question || fileNames.includes(undefined) || badSearch) {
    console.error('Usage: npm run ask -- "<question>" [--upload <fileName>]... [--no-rerank | --search hybrid]');
    process.exit(1);
  }

  const { client, db } = await connect();

  // try/finally: close the database connection even if something below fails, so the
  // script can exit instead of waiting on an open connection.
  try {
    // Selected uploads: turn the file names into uploadIds, which the search filters
    // on. Only complete uploads count; an upload whose ingest failed can't be asked.
    // Without --upload, uploadIds stays undefined and the search covers all uploads.
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

    // All the work happens here: search, the threshold check, then the LLM
    // (src/answer.js). result.text is the answer with [n] markers after cited
    // passages, or "not found in your uploads".
    const result = await answer(db, question, { uploadIds, rerank: noRerankAt === -1, search });
    const how = search === 'hybrid' ? ' (hybrid search)' : noRerankAt === -1 ? '' : ' (without reranking)';
    console.log(`"${question}" in ${fileNames.join(', ') || 'All uploads'}${how}\n`);
    console.log(result.text);

    // Sources: one line per [n] marker in the answer, with where it points ("page 12",
    // a heading path, or "passage 2 of 6").
    if (result.citations.length) {
      console.log('\nSources:');
      for (const c of result.citations) {
        const where = locationLabel(c);
        console.log(`[${c.n}] ${c.fileName}${where ? `: ${where}` : ''}`);
      }
    }
  } finally {
    await client.close();
  }
}

// main() is async, so its errors arrive as a rejected promise; catch them here and
// print one readable line instead of a stack trace.
main().catch((err) => {
  console.error('Ask failed:', err.message);
  process.exit(1);
});
