// Asks a question from the command line and prints the answer with its sources.
// Usage: npm run ask -- "<question>" [--upload <fileName>]
// --upload asks one complete upload; without it, all searchable uploads.
// Each run embeds the question, and calls the LLM unless the top score is below the
// "not found" threshold. To see the raw chunks and scores, use npm run search.

const { connect } = require('../src/db');
const { answer } = require('../src/answer');
const config = require('../src/config');

// Removes "--name value" from args and returns the value (undefined if absent).
// It removes the flag and its value wherever they are, so the leftover words can be
// joined back into the question.
function takeFlag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);   // splice removes the flag and its value
  return value;
}

async function main() {
  // Read the command line. process.argv is ['node', 'scripts/ask.js', ...what you
  // typed after --], so slice(2) keeps only your words. Take out --upload first; what
  // is left is the question (joined, in case it wasn't quoted).
  const args = process.argv.slice(2);
  const fileName = takeFlag(args, '--upload');
  const question = args.join(' ').trim();

  if (!question) {
    console.error('Usage: npm run ask -- "<question>" [--upload <fileName>]');
    process.exit(1);
  }

  const { client, db } = await connect();

  // try/finally: close the database connection even if something below fails, so the
  // script can exit instead of waiting on an open connection.
  try {
    // One upload: turn the file name into its uploadId, which the search filters on.
    // Only complete uploads count; an upload whose ingest failed can't be asked.
    // Without --upload, uploadId stays undefined and the search covers all uploads.
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

    // All the work happens here: search, the threshold check, then the LLM
    // (src/answer.js). result.text is the answer with [n] markers after cited
    // passages, or "not found in your uploads".
    const result = await answer(db, question, { uploadId });
    console.log(`"${question}" in ${fileName || 'All uploads'}\n`);
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
