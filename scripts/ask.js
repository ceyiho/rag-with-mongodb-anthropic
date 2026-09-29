// Asks a question from the command line and prints the answer with its sources.
// Usage: npm run ask -- "<question>" [--upload <fileName>]
// --upload asks one complete upload; without it, all complete uploads.
// Each run embeds the question, and calls the LLM unless the top score is below the
// "not found" threshold. To see the raw chunks and scores, use npm run search.

const { connect } = require('../src/db');
const { answer } = require('../src/answer');
const config = require('../src/config');

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
  const question = args.join(' ').trim();

  if (!question) {
    console.error('Usage: npm run ask -- "<question>" [--upload <fileName>]');
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

    const result = await answer(db, question, { uploadId });
    console.log(`"${question}" in ${fileName || 'All uploads'}\n`);
    console.log(result.text);

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

main().catch((err) => {
  console.error('Ask failed:', err.message);
  process.exit(1);
});
