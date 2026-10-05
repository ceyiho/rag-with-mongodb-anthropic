// Asks a question from the command line and prints the answer with its sources.
// Usage: npm run ask -- "<question>" [--upload <fileName>]...
// --upload asks that complete upload; repeat it to ask several. Without it, all
// searchable uploads.
// Each run embeds the question, and calls the LLM unless the top score is below the
// "not found" threshold. To see the raw chunks and scores, use npm run search.

const { connect } = require('../src/db');
const { answer } = require('../src/answer');
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
  const question = args.join(' ').trim();

  if (!question || fileNames.includes(undefined)) {
    console.error('Usage: npm run ask -- "<question>" [--upload <fileName>]...');
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
    const result = await answer(db, question, { uploadIds });
    console.log(`"${question}" in ${fileNames.join(', ') || 'All uploads'}\n`);
    console.log(result.text);

    // Sources: one line per [n] marker in the answer. A plain-text file's only section
    // is named after the file, so show the file name once instead of twice.
    if (result.citations.length) {
      console.log('\nSources:');
      for (const c of result.citations) {
        const where = c.section && c.section !== c.fileName ? `${c.fileName}: ${c.section}` : c.fileName;
        console.log(`[${c.n}] ${where}`);
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
