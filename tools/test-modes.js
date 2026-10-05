// The search modes the test runners (run-test-questions.js, run-test-answers.js) use for
// a question in test/questions.json, and what each mode expects:
// - all:     All uploads.
// - one:     the question's `upload`.
// - wrong:   the question's `wrongUpload` (answerable questions only).
// - several: the uploads in the question's `several` list, ticked together (optional).
// A mode expects an answer if the question is answerable and the mode searches an
// upload that answers it (`upload` or `alsoIn`); otherwise "not found".

// The file names a mode searches, or null for all uploads.
function uploadsFor(q, mode) {
  if (mode === 'all') return null;
  if (mode === 'one') return [q.upload];
  if (mode === 'wrong') return [q.wrongUpload];
  if (mode === 'several') return q.several;
  throw new Error(`unknown mode "${mode}"`);
}

// The uploads in this mode that answer the question ([] if none).
function answeringUploads(q, mode) {
  const answering = [q.upload, ...(q.alsoIn || [])];
  const searched = uploadsFor(q, mode);
  return searched ? answering.filter((name) => searched.includes(name)) : answering;
}

function expectsAnswer(q, mode) {
  return Boolean(q.answerable) && answeringUploads(q, mode).length > 0;
}

module.exports = { uploadsFor, answeringUploads, expectsAnswer };
