// Runs the questions in test-questions.json through the answer function (search,
// threshold check, LLM) and checks each reply: Pass or Fail, and for a Fail, where the
// problem is. tools/run-test-questions.js tests search only; this tests the answers.
// The question fields and kinds are described in tools/run-test-questions.js.
// Usage: npm run test-answers [-- --save <label>] [--only <id,id,...>] [--limit <n>]
// --save writes a report to test-results/<date>-answers-<label>.md, with every answer
// text, the settings and the system prompt.
// --only runs just these question ids, e.g. to recheck failures after a prompt change.
// --limit sends the top n chunks to the LLM instead of config.search.limit.
//
// Each question runs in up to three modes:
// - all:   All uploads.
// - one:   scoped to `upload`.
// - wrong: scoped to `wrongUpload` (answerable questions only). Should be "not found".
//
// Pass rules:
// - Answerable (all, one): answered, and a cited chunk contains one of the `expect`
//   phrases. The LLM may paraphrase, so the fact is checked in the cited chunks, not in
//   the answer text. Broad questions have no `expect`: a cited chunk from an expected
//   upload (`upload`, or `alsoIn` in all) is enough, and coverage is judged by reading.
//   For partial questions, whether the answer names the missing part is also judged by
//   reading (see the question's note).
// - Everything else (not answerable, wrong upload): "not found".
// A Fail is diagnosed as in HANDOFF.md: threshold (answerable question below it),
// retrieval (the expected fact or upload wasn't in the chunks sent), or prompt/LLM (it
// was, or the question had no answer to give).
//
// Cost: every mode above the threshold calls the LLM, about 70-80 calls for a full run
// (a few thousand input tokens each). The token totals are printed at the end.

const fs = require('fs');
const path = require('path');
const { connect } = require('../src/db');
const { answer, SYSTEM_PROMPT } = require('../src/answer');
const config = require('../src/config');

const ROOT = path.join(__dirname, '..');
const QUESTIONS_FILE = path.join(ROOT, 'test-questions.json');
const RESULTS_DIR = path.join(ROOT, 'test-results');
const USAGE = 'Usage: npm run test-answers [-- --save <label>] [--only <id,id,...>] [--limit <n>]';

async function main() {
  const args = process.argv.slice(2);
  const label = takeFlag(args, '--save');
  const only = takeFlag(args, '--only');
  const limitArg = takeFlag(args, '--limit');
  const limit = limitArg === undefined ? config.search.limit : Number(limitArg);

  const badLabel = label !== undefined && !/^[a-z0-9-]+$/.test(label);
  if (args.length || badLabel || only === '' || !(Number.isInteger(limit) && limit > 0)) {
    console.error(USAGE);
    if (badLabel) console.error('The label may contain lowercase letters, digits and hyphens.');
    process.exit(1);
  }
  const reportFile = label && path.join(RESULTS_DIR, `${today()}-answers-${label}.md`);
  if (reportFile && fs.existsSync(reportFile)) {
    console.error(`${path.relative(ROOT, reportFile)} already exists; choose another label.`);
    process.exit(1);
  }

  let questions = require(QUESTIONS_FILE);
  if (only) {
    const ids = only.split(',');
    const unknown = ids.filter((id) => !questions.some((q) => q.id === id));
    if (unknown.length) {
      console.error(`Unknown question id(s): ${unknown.join(', ')}`);
      process.exit(1);
    }
    questions = questions.filter((q) => ids.includes(q.id));
  }

  const { client, db } = await connect();

  try {
    const uploads = await db.collection(config.collections.uploads)
      .find({ status: 'complete' }).sort({ uploadedAt: 1 }).toArray();
    const idOf = new Map(uploads.map((upload) => [upload.fileName, upload._id]));
    const uploadIdFor = (q, mode) => {
      if (mode === 'all') return undefined;
      const fileName = mode === 'one' ? q.upload : q.wrongUpload;
      if (!idOf.has(fileName)) throw new Error(`no complete upload named "${fileName}"`);
      return idOf.get(fileName);
    };

    const rows = [];
    for (const q of questions) {
      for (const mode of modesFor(q)) {
        const row = { q, mode, expectAnswer: q.answerable && mode !== 'wrong' };
        try {
          row.result = await answer(db, q.question, { uploadId: uploadIdFor(q, mode), limit });
          Object.assign(row, judge(row));
        } catch (err) {
          row.error = err.message;
        }
        rows.push(row);
        printRow(row);
      }
    }

    const summary = summarize(rows);
    printSummary(summary);

    if (reportFile) {
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(reportFile, report({ label, only, limitArg, limit, rows, summary, uploads }));
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

function modesFor(q) {
  return q.answerable && q.wrongUpload ? ['all', 'one', 'wrong'] : ['all', 'one'];
}

// Whether any of the chunks contains one of the phrases. Ignores case and spacing.
function hasPhrase(chunks, phrases = []) {
  const wanted = phrases.map(normalize);
  return chunks.some((chunk) => wanted.some((p) => normalize(chunk.text).includes(p)));
}

const normalize = (text) => text.toLowerCase().replace(/\s+/g, ' ');

// --- Judging one reply ---

// Whether the chunks hold what the question needs: one of its `expect` phrases or, for a
// broad question (no phrases), any chunk from an expected upload.
function holdsAnswer(q, mode, chunks) {
  if (q.expect) return hasPhrase(chunks, q.expect);
  const uploads = mode === 'all' ? [q.upload, ...(q.alsoIn || [])] : [q.upload];
  return chunks.some((chunk) => uploads.includes(chunk.fileName));
}

function judge({ q, mode, expectAnswer, result: r }) {
  const cited = r.citations.map((c) => r.chunks.find((chunk) =>
    String(chunk.uploadId) === String(c.uploadId) && chunk.chunkIndex === c.chunkIndex));
  const factSent = expectAnswer && holdsAnswer(q, mode, r.chunks);
  const factCited = expectAnswer && holdsAnswer(q, mode, cited);
  const pass = expectAnswer ? r.found && factCited : !r.found;

  let diagnosis = '';
  if (!pass) {
    if (!expectAnswer) diagnosis = 'prompt/LLM';
    else if (r.reason === 'belowThreshold') diagnosis = 'threshold';
    else diagnosis = factSent ? 'prompt/LLM' : 'retrieval';
  }

  // Signs worth a look even on a Pass (see Decisions in PROJECT_PLAN.md: Answers).
  const notes = [];
  const saysNotFound = r.rawText && normalize(r.rawText).includes(normalize(config.answer.notFoundReply));
  if (r.found && saysNotFound) notes.push('cites while saying "not found"');
  if (r.reason === 'noCitations' && normalize(r.rawText) !== normalize(config.answer.notFoundReply)) {
    notes.push('uncited reply, not the exact "not found" wording');
  }
  if (expectAnswer && r.found && !factCited) {
    notes.push(q.expect ? 'answered, but no cited chunk has the expected fact'
      : 'answered, but cites no chunk from the expected upload');
  }

  return { pass, diagnosis, notes };
}

function expected(row) {
  return row.expectAnswer ? 'answer' : 'not found';
}

const fmt = (score) => (score == null ? '-' : score.toFixed(4));

function got({ result: r, error }) {
  if (error) return 'ERROR';
  if (r.found) return `answered (${r.citations.length} cited)`;
  return r.reason === 'belowThreshold' ? 'not found (threshold)' : 'not found (LLM)';
}

// --- Console output ---

function printRow(row) {
  const start = `${row.q.id.padEnd(30)} ${row.mode.padEnd(5)} expect ${expected(row).padEnd(9)}`;
  if (row.error) {
    console.log(`${start} ERROR: ${row.error}`);
    return;
  }
  const verdict = row.pass ? 'PASS' : `FAIL (${row.diagnosis})`;
  const notes = row.notes.length ? `  note: ${row.notes.join('; ')}` : '';
  console.log(`${start} top ${fmt(row.result.topScore)} got ${got(row).padEnd(22)} ${verdict}${notes}`);
}

function groupOf(row) {
  if (row.mode === 'wrong') return 'wrong upload';
  return row.q.answerable ? `answerable (${row.mode})` : row.q.kind;
}

function summarize(rows) {
  const ok = rows.filter((row) => !row.error);
  const groups = new Map();
  for (const row of ok) {
    const name = groupOf(row);
    if (!groups.has(name)) groups.set(name, { name, expect: expected(row), passed: 0, total: 0 });
    const group = groups.get(name);
    group.total += 1;
    if (row.pass) group.passed += 1;
  }

  const withLlm = ok.filter((row) => row.result.usage);
  return {
    total: rows.length,
    errors: rows.filter((row) => row.error),
    passed: ok.filter((row) => row.pass).length,
    groups: [...groups.values()],
    failures: ok.filter((row) => !row.pass),
    noted: ok.filter((row) => row.notes.length),
    llmCalls: withLlm.length,
    inputTokens: withLlm.reduce((sum, row) => sum + row.result.usage.input_tokens, 0),
    outputTokens: withLlm.reduce((sum, row) => sum + row.result.usage.output_tokens, 0),
  };
}

function printSummary(s) {
  console.log(`\n${s.passed} of ${s.total - s.errors.length} passed`
    + `${s.errors.length ? `, ${s.errors.length} error(s)` : ''}.`);
  for (const g of s.groups) {
    console.log(`  ${g.name.padEnd(20)} expect ${g.expect.padEnd(9)} ${g.passed} of ${g.total}`);
  }
  if (s.failures.length) {
    console.log('Failures:');
    for (const row of s.failures) console.log(`  ${row.q.id} (${row.mode}): ${row.diagnosis}`);
  }
  console.log(`LLM calls: ${s.llmCalls}, tokens in ${s.inputTokens}, out ${s.outputTokens}`);
}

// --- Saved report (Markdown) ---

function report({ label, only, limitArg, limit, rows, summary: s, uploads }) {
  const { chunking, search: searchConfig, answer: answerConfig } = config;
  const thresholds = searchConfig.notFoundThreshold;
  const totalChunks = uploads.reduce((sum, upload) => sum + (upload.chunkCount || 0), 0);
  const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const command = `npm run test-answers -- --save ${label}${only ? ` --only ${only}` : ''}`
    + `${limitArg !== undefined ? ` --limit ${limitArg}` : ''}`;

  const lines = [];
  const add = (...more) => lines.push(...more);

  add(`# Answer test run: ${label}`, '');
  add(`Run of \`${command}\` on ${today()}, over ${rows.length} question/mode pairs from `
    + '`test-questions.json`. Generated by the runner. LLM replies vary between runs.', '');
  if (s.errors.length) {
    add(`**${s.errors.length} run(s) failed** and are left out of the tables and summary:`, '');
    for (const row of s.errors) add(`- ${row.q.id} (${row.mode}): ${row.error}`);
    add('');
  }

  add('## Settings', '', '| Setting | Value |', '|---|---|');
  add(`| Model | \`${answerConfig.model}\` |`);
  add(`| Threshold | All ${thresholds.allUploads}, One ${thresholds.oneUpload} (config.js) |`);
  add(`| Search | top ${limit} chunks sent to the LLM (${limitArg !== undefined ? '--limit' : 'config.js'}) |`);
  add(`| Chunk size | target ${chunking.targetSize}, max ${chunking.maxSize}, overlap ${chunking.overlap} characters |`);
  add(`| Uploads | ${uploads.length} complete, ${totalChunks} chunks |`);
  add(`| LLM calls | ${s.llmCalls}; tokens in ${s.inputTokens}, out ${s.outputTokens} |`, '');

  add('## How to read the results', '');
  add('- **Modes**: all = All uploads; one = the question\'s `upload`; wrong = the question\'s');
  add('  `wrongUpload` (should be "not found").');
  add('- **Pass**: an answerable question is answered and a cited chunk contains one of its');
  add('  `expect` phrases (broad: cites a chunk from the expected upload); everything else comes');
  add('  back "not found". Not checked automatically, so read the answers: coverage for broad');
  add('  questions, and for partial ones whether the missing part is named.');
  add('- **Top score**: the best chunk\'s score from the search. Below the threshold, the reply');
  add('  is "not found" without calling the LLM; at or above it, the LLM decides.');
  add('- **Diagnosis** of a Fail: threshold (answerable, but below it), retrieval (the expected');
  add('  fact wasn\'t in the chunks sent), prompt/LLM (it was, or there was no answer to give).');
  add('- **Notes** flag replies worth a look even when they pass.', '');

  add('## Summary', '', `**${s.passed} of ${s.total - s.errors.length} passed.**`, '');
  add('| Group | Expected | Passed |', '|---|---|---|');
  for (const g of s.groups) add(`| ${g.name} | ${g.expect} | ${g.passed} of ${g.total} |`);
  add('');

  add('## Results', '', '| id | Kind | Mode | Question | Top score | Expected | Got | Pass/Fail | Notes |');
  add('|---|---|---|---|---|---|---|---|---|');
  for (const row of rows.filter((r) => !r.error)) {
    const verdict = row.pass ? 'Pass' : `**Fail** (${row.diagnosis})`;
    add(`| ${row.q.id} | ${row.q.kind} | ${row.mode} | ${cell(row.q.question)} | ${fmt(row.result.topScore)} | `
      + `${expected(row)} | ${got(row)} | ${verdict} | ${cell(row.notes.join('; '))} |`);
  }
  add('');

  add('## Answers', '', 'Every reply from the LLM (runs stopped by the threshold are left out).', '');
  for (const row of rows.filter((r) => !r.error && r.result.usage)) {
    const r = row.result;
    add(`### ${row.q.id} (${row.mode}): ${row.pass ? 'Pass' : `Fail (${row.diagnosis})`}, `
      + `top score ${fmt(r.topScore)}`, '');
    add(`**Q:** ${row.q.question}`, '');
    if (row.q.note) add(`*Note in test-questions.json:* ${row.q.note}`, '');
    add(...quote(r.found ? r.text : r.rawText), '');
    for (const c of r.citations) {
      const where = c.section && c.section !== c.fileName ? `${c.fileName}: ${c.section}` : c.fileName;
      add(`- [${c.n}] ${where} (#${c.chunkIndex}, score ${c.score.toFixed(4)})`);
    }
    if (r.citations.length) add('');
  }

  add('## System prompt', '', '```text', SYSTEM_PROMPT, '```', '');
  return lines.join('\n');
}

function quote(text) {
  return text.split('\n').map((line) => (line ? `> ${line}` : '>'));
}

main().catch((err) => {
  console.error('Test run failed:', err.message);
  if (err.name === 'MongoServerSelectionError') {
    console.error('Could not reach Atlas: check that your current IP is in Atlas Network Access.');
  }
  process.exit(1);
});
