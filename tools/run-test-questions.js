// Runs every question in test-questions.json and prints the scores, to choose the
// "not found" threshold for each search mode (and later to compare hybrid search).
// Usage: npm run test-questions
//
// Each question runs up to three searches:
// - all:   All uploads (approximate). Also reports the rank of the first chunk from an
//          expected upload (upload or alsoIn) within the top results.
// - one:   scoped to `upload` (exact).
// - wrong: scoped to `wrongUpload` (exact), answerable questions only: an easy negative,
//          like a user who picked the wrong upload.
// The threshold check uses the top score, so that's what is compared. A question that
// fails is reported and the run carries on.
// About 85 searches, each embedding a short question (a few tokens each).

const path = require('path');
const { connect } = require('../src/db');
const { search } = require('../src/search');
const config = require('../src/config');

const QUESTIONS_FILE = path.join(__dirname, '..', 'test-questions.json');

async function main() {
  const questions = require(QUESTIONS_FILE);
  const { client, db } = await connect();

  try {
    const uploads = await db.collection(config.collections.uploads)
      .find({ status: 'complete' }).toArray();
    const idOf = new Map(uploads.map((upload) => [upload.fileName, upload._id]));
    const scoped = (fileName) => {
      if (!idOf.has(fileName)) throw new Error(`no complete upload named "${fileName}"`);
      return { uploadId: idOf.get(fileName) };
    };

    const results = [];
    for (const q of questions) {
      const result = { q };
      try {
        const all = await search(db, q.question);
        result.all = topScore(all);
        const expected = [q.upload, ...(q.alsoIn || [])];
        const rank = all.findIndex((chunk) => expected.includes(chunk.fileName));
        result.rank = rank === -1 ? null : rank + 1;
        result.one = topScore(await search(db, q.question, scoped(q.upload)));
        if (q.wrongUpload) {
          result.wrong = topScore(await search(db, q.question, scoped(q.wrongUpload)));
        }
      } catch (err) {
        result.error = err.message;
      }
      results.push(result);
      printRow(result);
    }

    printSummary(results);
  } finally {
    await client.close();
  }
}

function topScore(chunks) {
  return chunks.length ? chunks[0].score : null;
}

const fmt = (score) => (score == null ? '     -' : score.toFixed(4));

function printRow({ q, all, rank, one, wrong, error }) {
  const label = `${q.answerable ? 'Y' : 'N'} ${q.id.padEnd(30)} ${q.kind.padEnd(11)}`;
  if (error) {
    console.log(`${label} ERROR: ${error}`);
    return;
  }
  const hit = q.answerable ? (rank ? `#${rank}` : 'miss') : '';
  console.log(`${label} all ${fmt(all)} ${hit.padEnd(4)}  one ${fmt(one)}  wrong ${fmt(wrong)}`);
}

function printSummary(results) {
  const ok = results.filter((r) => !r.error);
  const failed = results.length - ok.length;
  const answerable = ok.filter((r) => r.q.answerable);
  const unanswerable = ok.filter((r) => !r.q.answerable);

  console.log(`\n${ok.length} of ${results.length} questions ran${failed ? `, ${failed} failed` : ''}.`);
  console.log('Y = answerable, N = not answerable. Scores are the top score (cosine, higher is closer).');

  const top1 = answerable.filter((r) => r.rank === 1).length;
  const inTop = answerable.filter((r) => r.rank).length;
  console.log(`\nAll uploads (approximate)`);
  console.log(`  expected upload ranked #1 for ${top1} of ${answerable.length}, in the top ${config.search.limit} for ${inTop}`);
  compare(answerable, 'all', [['not answerable', unanswerable, 'all']]);

  console.log(`\nOne upload (exact)`);
  compare(answerable, 'one', [
    ['not answerable (hard)', unanswerable, 'one'],
    ['wrong upload (easy)', answerable, 'wrong'],
  ]);
}

// Prints the lowest positive score, the highest score of each negative group, and the
// gap between them. A negative gap means the groups overlap: no threshold separates them.
function compare(positives, key, negativeGroups) {
  const low = extreme(positives, key, Math.min);
  console.log(`  ${'answerable'.padEnd(22)} lowest  ${describe(low)}`);
  for (const [name, rows, negKey] of negativeGroups) {
    const high = extreme(rows, negKey, Math.max);
    const gap = low && high ? low.score - high.score : null;
    const gapText = gap == null ? '' : `  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(4)}`;
    console.log(`  ${name.padEnd(22)} highest ${describe(high)}${gapText}`);
    if (gap != null && gap < 0) {
      const above = rows.filter((r) => r[negKey] != null && r[negKey] >= low.score).map((r) => r.q.id);
      const below = positives.filter((r) => r[key] != null && r[key] <= high.score).map((r) => r.q.id);
      console.log(`    overlap: negatives at or above ${low.score.toFixed(4)}: ${above.join(', ')}`);
      console.log(`             answerable at or below ${high.score.toFixed(4)}: ${below.join(', ')}`);
    }
  }
}

function extreme(rows, key, pick) {
  const scored = rows.filter((r) => r[key] != null);
  if (!scored.length) return null;
  const score = pick(...scored.map((r) => r[key]));
  return { score, id: scored.find((r) => r[key] === score).q.id };
}

function describe(found) {
  return found ? `${found.score.toFixed(4)} (${found.id})` : '-';
}

main().catch((err) => {
  console.error('Test run failed:', err.message);
  if (err.name === 'MongoServerSelectionError') {
    console.error('Could not reach Atlas: check that your current IP is in Atlas Network Access.');
  }
  process.exit(1);
});
