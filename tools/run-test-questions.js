// Runs every question in test-questions.json and prints the scores, to choose the
// "not found" threshold for each search mode (and later to compare hybrid search).
// Usage: npm run test-questions [-- --save <label>] [--threshold <score>]
// --save writes a report to test-results/<date>-<label>.md, e.g. --save chunk-800.
// --threshold tries another threshold for both modes instead of the ones in config.js.
//
// Each question runs up to three searches:
// - all:   All uploads (approximate). Also reports the rank of the first chunk from an
//          expected upload (upload or alsoIn) within the top results.
// - one:   scoped to `upload` (exact).
// - wrong: scoped to `wrongUpload` (exact), answerable questions only: an easy negative,
//          like a user who picked the wrong upload.
// The threshold check uses the top score, so that's what is compared. A question that
// fails is reported and the run carries on.
// Answer text: for answerable questions, the position of the first chunk that contains
// one of the question's `expect` phrases (copied from the samples), in all and one. It
// shows whether the passage with the answer was retrieved, whole, not just the right upload.
// About 90 searches, each embedding a short question (a few tokens each).
//
// test-questions.json (also read by tools/run-test-answers.js). Fields:
// - id, question, answerable: a short name, the question text, and whether the uploads
//   hold the answer.
// - upload: the upload that answers it; for a not-answerable question, the one it sounds
//   closest to. Used for the one-upload search.
// - alsoIn: other uploads that also answer it (optional). A hit in any of them counts.
// - wrongUpload: an upload on another topic, for the wrong-upload search (answerable only).
// - expect: phrases copied from the sample that hold the answer; any one counts
//   (answerable only). Specific enough that only the right passage contains them.
// - compareWith: the id of the clean version of a typo question (typo only).
// - kind, note: the kind (below) and a free-text note.
// Kinds:
// - direct:      uses the sample's own words.
// - paraphrase:  same meaning, different words.
// - mixed-chunk: the answer sits in a chunk that covers several topics.
// - typo:        a misspelled version of a clean question.
// - near-miss:   on topic, same vocabulary, but the answer isn't in the uploads.
// - off-topic:   not about any upload, either general or technical sharing our wording.
// The first four are answerable, the last two are not.

const fs = require('fs');
const path = require('path');
const { connect } = require('../src/db');
const { search } = require('../src/search');
const config = require('../src/config');

const ROOT = path.join(__dirname, '..');
const QUESTIONS_FILE = path.join(ROOT, 'test-questions.json');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const USAGE = 'Usage: npm run test-questions [-- --save <label>] [--threshold <score>]';

async function main() {
  const args = process.argv.slice(2);
  const label = takeFlag(args, '--save');
  const thresholdArg = takeFlag(args, '--threshold');
  const thresholds = thresholdArg === undefined
    ? config.search.notFoundThreshold
    : { oneUpload: Number(thresholdArg), allUploads: Number(thresholdArg) };

  const badLabel = label !== undefined && !/^[a-z0-9-]+$/.test(label);
  if (args.length || badLabel || !(thresholds.oneUpload > 0 && thresholds.allUploads > 0)) {
    console.error(USAGE);
    if (badLabel) console.error('The label may contain lowercase letters, digits and hyphens.');
    process.exit(1);
  }
  const reportFile = label && path.join(RESULTS_DIR, `${today()}-${label}.md`);
  if (reportFile && fs.existsSync(reportFile)) {
    console.error(`${path.relative(ROOT, reportFile)} already exists; choose another label.`);
    process.exit(1);
  }

  const questions = require(QUESTIONS_FILE);
  const { client, db } = await connect();

  try {
    const uploads = await db.collection(config.collections.uploads)
      .find({ status: 'complete' }).sort({ uploadedAt: 1 }).toArray();
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
        result.allText = phraseRank(all, q.expect);
        const one = await search(db, q.question, scoped(q.upload));
        result.one = topScore(one);
        result.oneText = phraseRank(one, q.expect);
        if (q.wrongUpload) {
          result.wrong = topScore(await search(db, q.question, scoped(q.wrongUpload)));
        }
      } catch (err) {
        result.error = err.message;
      }
      results.push(result);
      printRow(result);
    }

    printSummary(results, thresholds);

    if (reportFile) {
      const index = await vectorIndexSettings(db);
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(reportFile, report({ label, results, thresholds, uploads, index }));
      console.log(`\nSaved ${path.relative(ROOT, reportFile)}`);
    }
  } finally {
    await client.close();
  }
}

// Removes "--name value" from args and returns the value (undefined if absent).
function takeFlag(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function topScore(chunks) {
  return chunks.length ? chunks[0].score : null;
}

const fmt = (score) => (score == null ? '-' : score.toFixed(4));

// Position (1-based) of the first chunk containing one of the phrases, or null if none
// does. Ignores case and spacing. Undefined when the question has no phrases.
function phraseRank(chunks, phrases) {
  if (!phrases) return undefined;
  const wanted = phrases.map(normalize);
  const at = chunks.findIndex((chunk) => wanted.some((p) => normalize(chunk.text).includes(p)));
  return at === -1 ? null : at + 1;
}

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ');

const position = (rank) => (rank ? `#${rank}` : '-');

// --- Console output ---

function printRow({ q, all, rank, one, wrong, allText, oneText, error }) {
  const label = `${q.answerable ? 'Y' : 'N'} ${q.id.padEnd(30)} ${q.kind.padEnd(11)}`;
  if (error) {
    console.log(`${label} ERROR: ${error}`);
    return;
  }
  const hit = q.answerable ? (rank ? `#${rank}` : 'miss') : '';
  const text = allText === undefined ? '' : `  answer ${position(allText)}/${position(oneText)}`;
  console.log(`${label} all ${fmt(all).padStart(6)} ${hit.padEnd(4)}  one ${fmt(one).padStart(6)}  wrong ${fmt(wrong).padStart(6)}${text}`);
}

function printSummary(results, thresholds) {
  const ok = results.filter((r) => !r.error);
  const failed = results.length - ok.length;
  const answerable = ok.filter((r) => r.q.answerable);
  const unanswerable = ok.filter((r) => !r.q.answerable);

  console.log(`\n${ok.length} of ${results.length} questions ran${failed ? `, ${failed} failed` : ''}.`);
  console.log('Y = answerable, N = not answerable. Scores are the top score (cosine, higher is closer).');
  console.log('answer #a/#b = position of the first chunk with the answer text, in all/one ("-" = not in the results).');

  const text = answerText(answerable);
  if (text.checked) {
    console.log(`\nAnswer text in the top ${config.search.limit} (${text.checked} questions with phrases)`);
    console.log(`  All: ${text.all.found} (at #1: ${text.all.first}), One: ${text.one.found} (at #1: ${text.one.first})`);
    if (text.missing.length) console.log(`  missing: ${text.missing.join(', ')}`);
  }

  const { top1, inTop } = ranking(answerable);
  console.log(`\nAll uploads (approximate)`);
  console.log(`  expected upload ranked #1 for ${top1} of ${answerable.length}, in the top ${config.search.limit} for ${inTop}`);
  compare(answerable, 'all', [['not answerable', unanswerable, 'all']]);

  console.log(`\nOne upload (exact)`);
  compare(answerable, 'one', [
    ['not answerable (hard)', unanswerable, 'one'],
    ['wrong upload (easy)', answerable, 'wrong'],
  ]);

  console.log(`\nAt the thresholds (All ${thresholds.allUploads}, One ${thresholds.oneUpload})`);
  for (const line of thresholdRows(ok, thresholds)) {
    console.log(`  ${line.group.padEnd(22)} ${line.text}`);
  }
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
      const above = rows.filter((r) => r[negKey] != null && r[negKey] >= low.score).length;
      const below = positives.filter((r) => r[key] != null && r[key] <= high.score).length;
      console.log(`    overlap: ${above} negative(s) at or above ${low.score.toFixed(4)}, `
        + `${below} answerable at or below ${high.score.toFixed(4)}`);
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

// --- Shared summary figures ---

function ranking(answerable) {
  return {
    top1: answerable.filter((r) => r.rank === 1).length,
    inTop: answerable.filter((r) => r.rank).length,
  };
}

// How often the answer text was retrieved, per mode, and which questions missed it
// in either mode (with the mode, e.g. "handbook-invite-valid (all)").
function answerText(answerable) {
  const rows = answerable.filter((r) => r.allText !== undefined);
  const count = (key) => ({
    found: rows.filter((r) => r[key]).length,
    first: rows.filter((r) => r[key] === 1).length,
  });
  const missing = rows
    .filter((r) => !r.allText || !r.oneText)
    .map((r) => {
      const modes = [!r.allText && 'all', !r.oneText && 'one'].filter(Boolean);
      return `${r.q.id} (${modes.join(', ')})`;
    });
  return { checked: rows.length, all: count('allText'), one: count('oneText'), missing };
}

// How each group fares at the thresholds: answerable questions should pass (kept),
// everything else should fall below (rejected).
function thresholdRows(ok, thresholds) {
  const passAll = (r) => r.all != null && r.all >= thresholds.allUploads;
  const passOne = (r) => r.one != null && r.one >= thresholds.oneUpload;
  const answerable = ok.filter((r) => r.q.answerable);
  const withWrong = answerable.filter((r) => r.wrong != null);
  const count = (rows, test) => rows.filter(test).length;
  const rows = [
    {
      group: 'answerable kept',
      text: `All ${count(answerable, passAll)} of ${answerable.length}, One ${count(answerable, passOne)} of ${answerable.length}`,
    },
    {
      group: 'wrong upload rejected',
      text: `${count(withWrong, (r) => r.wrong < thresholds.oneUpload)} of ${withWrong.length}`,
    },
  ];
  for (const kind of unanswerableKinds(ok)) {
    const group = ok.filter((r) => !r.q.answerable && r.q.kind === kind);
    rows.push({
      group: `${kind} rejected`,
      text: `All ${count(group, (r) => !passAll(r))} of ${group.length}, One ${count(group, (r) => !passOne(r))} of ${group.length}`,
    });
  }
  return rows;
}

function unanswerableKinds(ok) {
  return [...new Set(ok.filter((r) => !r.q.answerable).map((r) => r.q.kind))];
}

// --- Saved report (Markdown) ---

async function vectorIndexSettings(db) {
  const name = config.searchIndexes.vector;
  const [index] = await db.collection(config.collections.chunks).listSearchIndexes(name).toArray();
  const field = index && (index.latestDefinition || index.definition).fields
    .find((f) => f.type === 'autoEmbed' || f.type === 'vector');
  if (!field) return `\`${name}\``;
  return `\`${name}\`: ${field.model}, ${field.numDimensions} dimensions, `
    + `${field.quantization || 'no'} quantization, ${field.similarity}`;
}

function report({ label, results, thresholds, uploads, index }) {
  const ok = results.filter((r) => !r.error);
  const failed = results.filter((r) => r.error);
  const answerable = ok.filter((r) => r.q.answerable);
  const unanswerable = ok.filter((r) => !r.q.answerable);
  const { chunking, search: searchConfig } = config;
  const totalChunks = uploads.reduce((sum, upload) => sum + (upload.chunkCount || 0), 0);
  const cell = (text) => String(text).replace(/\|/g, '\\|');
  const tAll = thresholds.allUploads;
  const tOne = thresholds.oneUpload;
  const thresholdText = tAll === tOne ? `${tOne}` : `All ${tAll}, One ${tOne}`;

  const lines = [];
  const add = (...more) => lines.push(...more);

  add(`# Test run: ${label}`, '');
  add(`Run of \`npm run test-questions -- --save ${label}\` on ${today()}, over the `
    + `${results.length} questions in \`test-questions.json\`. Generated by the runner. `
    + 'Scores vary by up to ~0.001 between runs, so smaller changes are noise.', '');
  if (failed.length) {
    add(`**${failed.length} question(s) failed** and are left out of the tables and summary:`, '');
    for (const r of failed) add(`- ${r.q.id}: ${r.error}`);
    add('');
  }

  add('## Settings', '', '| Setting | Value |', '|---|---|');
  add(`| Uploads | ${uploads.length} complete, ${totalChunks} chunks (`
    + `${uploads.map((u) => `${u.fileName} ${u.chunkCount}`).join(', ')}) |`);
  add(`| Chunk size | target ${chunking.targetSize}, max ${chunking.maxSize}, overlap ${chunking.overlap} characters |`);
  add(`| Vector index | ${index} |`);
  add(`| Search | top ${searchConfig.limit}; All uploads approximate (numCandidates `
    + `${searchConfig.limit * searchConfig.candidatesPerResult}), one upload exact |`);
  add(`| Threshold | ${thresholdText}${tAll === config.search.notFoundThreshold.allUploads
    && tOne === config.search.notFoundThreshold.oneUpload ? ' (config.js)' : ' (--threshold)'} |`, '');

  add('## How to read the results', '');
  add('Each question runs up to three searches. The score is the top score (cosine, higher is closer).', '');
  add('- **All**: All uploads. The rank is the position of the first chunk from an expected');
  add(`  upload (\`upload\` or \`alsoIn\`) in the top ${searchConfig.limit}.`);
  add('- **One**: scoped to the question\'s `upload`.');
  add('- **Answer** (after All and after One): position of the first chunk in the results that');
  add('  contains one of the question\'s `expect` phrases (copied from the sample), or **missing**.');
  add('  It checks that the passage with the answer came back whole, not just the right upload.');
  add('- **Wrong**: scoped to the question\'s `wrongUpload` (answerable questions only). The');
  add('  right result is "not found".');
  add(`- **At ${thresholdText}**: what the threshold does. For answerable questions: whether All and One`);
  add('  are kept (at or above it), and whether the wrong-upload search is rejected (below it). For the');
  add('  others: rejected, or passed on to the LLM.', '');

  add(`## Answerable questions (${answerable.length})`, '');
  add(`| id | Kind | Question | All | Rank | Answer | One | Answer | Wrong | At ${thresholdText} |`);
  add('|---|---|---|---|---|---|---|---|---|---|');
  const answerCell = (rank) => (rank === undefined ? '' : rank ? `#${rank}` : '**missing**');
  for (const r of answerable) {
    const refused = [r.all < tAll && 'All', r.one < tOne && 'One'].filter(Boolean);
    const kept = refused.length ? `**refused (${refused.join(', ')})**` : 'kept';
    const wrong = r.wrong == null ? '' : (r.wrong < tOne ? '; wrong rejected' : '; **wrong passes**');
    add(`| ${r.q.id} | ${r.q.kind} | ${cell(r.q.question)} | ${fmt(r.all)} | `
      + `${r.rank ? `#${r.rank}` : '**miss**'} | ${answerCell(r.allText)} | ${fmt(r.one)} | `
      + `${answerCell(r.oneText)} | ${fmt(r.wrong)} | ${kept}${wrong} |`);
  }
  add('');

  add(`## Not answerable (${unanswerable.length})`, '');
  add(`| id | Kind | Question | All | One | At ${thresholdText} |`, '|---|---|---|---|---|---|');
  for (const r of unanswerable) {
    const passes = [r.all >= tAll && 'All', r.one >= tOne && 'One'].filter(Boolean);
    const verdict = !passes.length ? 'rejected' : passes.length === 2 ? 'passes' : `passes (${passes[0]} only)`;
    add(`| ${r.q.id} | ${r.q.kind} | ${cell(r.q.question)} | ${fmt(r.all)} | ${fmt(r.one)} | ${verdict} |`);
  }
  add('');

  add('## Summary', '');
  const { top1, inTop } = ranking(answerable);
  add(`**Ranking (All uploads):** the expected upload ranked #1 for ${top1} of ${answerable.length} `
    + `answerable questions, and was in the top ${searchConfig.limit} for ${inTop}.`, '');

  const text = answerText(answerable);
  if (text.checked) {
    add(`**Answer text in the top ${searchConfig.limit}** (${text.checked} questions with \`expect\` phrases): `
      + `All ${text.all.found} (at #1: ${text.all.first}), One ${text.one.found} (at #1: ${text.one.first}).`
      + (text.missing.length ? ` Missing: ${text.missing.join(', ')}.` : ' None missing.'), '');
  }

  const range = (rows, key) => {
    const low = extreme(rows, key, Math.min);
    const high = extreme(rows, key, Math.max);
    return low ? `${fmt(low.score)}–${fmt(high.score)}` : '–';
  };
  add('**Score ranges (top score):**', '', '| Group | All | One |', '|---|---|---|');
  add(`| Answerable | ${range(answerable, 'all')} | ${range(answerable, 'one')} |`);
  for (const kind of unanswerableKinds(ok)) {
    const group = unanswerable.filter((r) => r.q.kind === kind);
    add(`| ${kind} | ${range(group, 'all')} | ${range(group, 'one')} |`);
  }
  add(`| Wrong upload | – | ${range(answerable, 'wrong')} |`, '');

  add(`**At ${thresholdText}:**`, '', '| Group | Result |', '|---|---|');
  for (const line of thresholdRows(ok, thresholds)) add(`| ${line.group} | ${line.text} |`);
  add('');

  const byId = new Map(ok.map((r) => [r.q.id, r]));
  const pairs = ok.filter((r) => r.q.compareWith && byId.has(r.q.compareWith));
  if (pairs.length) {
    add('**Typos vs clean questions (One):**', '');
    add('| Clean | Score | Typo | Score | Change |', '|---|---|---|---|---|');
    for (const r of pairs) {
      const clean = byId.get(r.q.compareWith);
      const change = r.one - clean.one;
      add(`| ${clean.q.id} | ${fmt(clean.one)} | ${r.q.id} | ${fmt(r.one)} | `
        + `${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(4)} |`);
    }
    add('');
  }

  const mixed = ok.filter((r) => r.q.kind === 'mixed-chunk');
  if (mixed.length) {
    add('**Mixed-chunk questions (One):**', '', '| id | Score | Note |', '|---|---|---|');
    for (const r of mixed) add(`| ${r.q.id} | ${fmt(r.one)} | ${cell(r.q.note || '')} |`);
    add('');
  }

  return lines.join('\n');
}

main().catch((err) => {
  console.error('Test run failed:', err.message);
  if (err.name === 'MongoServerSelectionError') {
    console.error('Could not reach Atlas: check that your current IP is in Atlas Network Access.');
  }
  process.exit(1);
});
