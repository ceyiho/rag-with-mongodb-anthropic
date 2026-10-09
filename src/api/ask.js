// POST /api/ask: answers a question from the ticked uploads or all uploads (see
// API_SPEC.md: Questions). Body: { question, uploadIds } or { question, scope: "all" },
// plus rerank: false for an answer from vector search alone (reranked by default).
// Checks the request, then calls src/answer.js, and sends only the fields the spec
// lists: the answer's extra fields (text, chunks, rawText, usage) stay on the server.

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { answer } = require('../answer');
const { ApiError } = require('./errors');
const { toObjectId } = require('./ids');

const MAX_QUESTION_LENGTH = 1000;

// HTTP statuses from the Anthropic API that mean "busy, try again later": rate-limited
// (429), unavailable (503), overloaded (529). The SDK has already retried twice.
const LLM_BUSY = [429, 503, 529];

module.exports = function askRoutes(db) {
  const router = express.Router();
  const uploads = db.collection(config.collections.uploads);

  // express.json() reads the JSON body into req.body (only for this route).
  router.post('/ask', express.json(), async (req, res) => {
    const { question, uploadIds, rerank } = await readRequest(req.body ?? {}, uploads);

    let result;
    try {
      result = await answer(db, question, { uploadIds, rerank });
    } catch (err) {
      if (llmBusy(err)) {
        console.error('Ask: answer service unavailable:', err.message);
        throw new ApiError(503, 'llmUnavailable', 'The answer service is busy right now. Try again in a minute.');
      }
      throw err;   // anything else, including a cut-off reply: 500
    }
    res.json(toApiAnswer(result));
  });

  return router;
};

// Checks the body and returns the question, the uploadIds (undefined for all uploads)
// and whether to rerank. Throws an ApiError for anything the spec rejects.
async function readRequest(body, uploads) {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new ApiError(400, 'missingQuestion', 'Type a question first.');
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ApiError(400, 'questionTooLong', `Questions can be up to ${MAX_QUESTION_LENGTH} characters.`);
  }
  // Only a real boolean: a string "false" would otherwise count as true.
  const rerank = body.rerank ?? true;
  if (typeof rerank !== 'boolean') throw new ApiError(400, 'invalidRerank', 'rerank must be true or false.');

  // Exactly one of uploadIds (one or more) or scope "all". An empty list is refused,
  // so a bug that sends one can't quietly search everything.
  const { uploadIds, scope } = body;
  const missing = () => new ApiError(400, 'missingScope', 'Tick at least one upload, or All uploads.');
  const invalid = (message) => new ApiError(400, 'invalidScope', message);
  if (uploadIds === undefined && scope === undefined) throw missing();
  if (uploadIds !== undefined && scope !== undefined) {
    throw invalid('Send either uploadIds or scope: "all", not both.');
  }
  if (scope !== undefined) {
    if (scope !== 'all') throw invalid('scope can only be "all".');
    return { question, uploadIds: undefined, rerank };
  }
  if (!Array.isArray(uploadIds)) throw invalid('uploadIds must be a list of upload ids.');
  if (!uploadIds.length) throw missing();

  // Each id must be a complete upload that is searchable.
  const ids = [...new Set(uploadIds.map(String))].map(toObjectId);
  const found = await uploads
    .find({ _id: { $in: ids }, status: 'complete' }, { projection: { searchableAt: 1 } })
    .toArray();
  if (found.length < ids.length) {
    throw new ApiError(404, 'uploadNotFound', 'One of the ticked uploads no longer exists.');
  }
  if (found.some((upload) => !upload.searchableAt)) {
    throw new ApiError(409, 'uploadNotReady', 'One of the ticked uploads is still being processed.');
  }
  return { question, uploadIds: ids, rerank };
}

function llmBusy(err) {
  return err instanceof Anthropic.APIConnectionError   // includes timeouts
    || (err instanceof Anthropic.APIError && LLM_BUSY.includes(err.status));
}

// The answer as API_SPEC.md lists it, with ids as hex strings.
function toApiAnswer(result) {
  return {
    found: result.found,
    reason: result.reason,
    parts: result.parts,
    citations: result.citations.map((c) => ({
      n: c.n,
      uploadId: c.uploadId.toHexString(),
      title: c.title,
      fileName: c.fileName,
      fileType: c.fileType,
      section: c.section,
      page: c.page,
      chunkIndex: c.chunkIndex,
      chunkCount: c.chunkCount,
      excerpt: c.excerpt,
    })),
    retrieval: {
      ...result.retrieval,
      hits: result.retrieval.hits.map((hit) => ({ ...hit, uploadId: hit.uploadId.toHexString() })),
    },
  };
}
