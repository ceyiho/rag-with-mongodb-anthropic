# Project Plan: RAG Knowledge Base on MongoDB Atlas

## What we're building aka functional specifications
A personal knowledge base. Users upload files (text, markdown, later PDFs) and ask
questions in plain language. The app answers using only their content and cites which
upload and section each answer came from.

Purpose: a solo portfolio project that showcases MongoDB Atlas capabilities,
especially Vector Search.

Supported uploads: .txt, .md, and text-based PDFs. Reject scanned PDFs and images
with a clear message.

Upload-scoped questions: all uploads are shared and visible to everyone (no logins).
The user selects one upload or "All uploads" before asking. With one upload
selected, the search pre-filters by its uploadId, so answers come only from that upload.
With "All uploads", answers can come from any complete upload.
Grounding rules below apply either way.

Grounding: answers must come only from retrieved chunks, with citations.
If retrieval scores are below a threshold, reply "not found in your uploads" without
calling the LLM. The threshold only catches clearly unrelated questions, so the LLM
also replies "not found in your uploads" when the retrieved chunks don't contain the
answer (see Findings: "Not found" score threshold).

Uploads are one-way: no delete or edit in the app. Uploading a file whose name already
exists is rejected with a message. Test data is cleaned up manually in Atlas.

Deployment: runs on localhost or a private VM for demos. It is not exposed publicly,
so no logins or usage limits are needed.

## Terminology
- MDB doc: a document in MongoDB's document model (a record in a collection).
- Upload: a file the user uploads (a document in the everyday sense).
- Chunk: a piece of an upload, stored as one MDB doc in the `chunks` collection.
- Avoid the bare word "document"; use one of the terms above.

## Tech stack
- Runtime: Node.js (LTS)
- Backend: Express
- Database: MongoDB Atlas (free M0 cluster) via the official MongoDB Node.js driver
- Frontend: plain HTML + JavaScript (no framework for now)
- Language: plain JavaScript (no TypeScript for now)
- Embeddings: Auto-Embedding with Voyage AI on MongoDB Atlas, model `voyage-4`.
  Switching models later means re-embedding everything. Uses a one-time free
  allocation of 200 million tokens per model (not monthly), so avoid unnecessary
  re-embedding.
- Chunking: custom splitter (sections → paragraphs → sentences), sized in characters
  (≈4 characters per token). No library. Sections come from the extractor: Markdown
  headings, one per plain-text file, pages for PDFs.
- PDF extraction: a pdf.js-based library (choose in milestone 6), giving text per page.
  Pages act as sections for citations. Pages with almost no text mean a scanned PDF,
  which is rejected.
- Answer generation: Anthropic API with built-in citations; one call per question,
  skipped when retrieval scores are below the threshold. Model: Claude Sonnet 5.5
  (`claude-sonnet-5-5`).
- Secrets: stored in a `.env` file, never committed to git

## How it works
1. Ingest: user uploads a file; the app extracts text and splits it into overlapping chunks.
2. Store: each chunk is saved in Atlas with its text and metadata
   (uploadId, file name, section). The app does not create vectors.
3. Embed: Atlas Auto-Embedding converts each chunk's text to a vector with Voyage AI,
   through the vector search index.
4. Retrieve: the question is sent to Atlas as text; Atlas embeds it with the same model,
   and Vector Search finds the closest chunks (pre-filtered by uploadId when one upload
   is selected).
5. Answer: if the best match scores below the threshold, reply "not found in your
   uploads". Otherwise the chunks and question go to the LLM, which answers with citations.

## MongoDB features to showcase
- Atlas Vector Search with Auto-Embedding, pre-filtered by upload (uploadId)
- Hybrid search: vector search combined with Atlas Search (keyword/fuzzy)
- Optional: aggregation pipeline analytics (most-asked questions, most-cited uploads,
  questions with no good match). Parked; see the last milestone.

## Milestones

### Phase 1: core
1. Connect to Atlas and verify the connection. (No AI yet.)
2. Ingest from the command line: read a .txt or .md file, find sections (Markdown
   headings; plain text is one section), split into overlapping chunks, and save the
   upload and its chunks. Reject duplicate file names and unsupported types.
   Structure: one extractor per file type returns sections ({ section, text }); one
   shared splitter chunks them, so PDF support later only adds an extractor.
   All-or-nothing: an upload has a status (processing → complete); only complete
   uploads count as duplicates, so a failed ingest can be retried.
   Create `config.js` with the collection names and chunk sizes, and create the
   regular indexes (see Decisions).
   Inspect the chunks in Atlas (no embedding tokens are spent yet).
3. Create the vector search index with Auto-Embedding, with uploadId as a filter field.
   Wait until it reports ready. Note that embedding runs in the background: measure how
   long new chunks take to become searchable, and record it under Findings (milestone 8
   uses it for the "processing… ready" state).
   Before creating the index: check the Atlas docs for which changes trigger
   re-embedding (show the user the source), and check the M0 limit on search indexes
   (this project plans a vector and a keyword index). After embedding, measure M0
   storage use (512 MB limit).
4. Search from the command line: a text question returns the top chunks with scores,
   with and without the uploadId filter. Save test questions (answerable and not, each
   with the upload it should find) in `test-questions.json`, run them, and choose the
   "not found" score threshold (record it under Findings). Milestone 9 reuses this file
   to compare hybrid search with vector-only search.
   Search only complete uploads: "All uploads" filters on
   `uploadId: { $in: [complete upload ids] }` instead of no filter, so orphan chunks
   and crash leftovers never reach an answer.
   One upload selected: use exact search (`exact: true`), which is complete and cheap
   within one upload. "All uploads": use approximate search with `numCandidates`
   (see Findings: exact vs approximate search).
   Where the code goes: the search function in `src/` (e.g. `src/search.js`), since
   milestones 5 and 7 reuse it; the command-line search and the `test-questions.json`
   runner in `tools/`.
5. Answer: apply the threshold check, then the LLM answers with citations
   (upload + section). The system prompt treats uploaded text as material to answer
   from, never as instructions, and tells the LLM to reply "not found in your uploads"
   when the chunks don't contain the answer: the threshold can't catch on-topic
   questions whose answer is missing. The code must be able to detect that decision
   (structured output, or an answer with no citations), not rely on the model's
   wording. Measure it with `test-questions.json`: near-misses and technical off-topic
   questions should come back "not found", answerable ones answered with citations.
   The thresholds are in `config.js` (`search.notFoundThreshold`, one per search mode;
   application code, committed, not `.env`), added in milestone 4 for the test runner.
   Context: the LLM sees the top chunks only: up to ≈8,000 characters (5 × 1,600; our
   `config.search.limit`, not an Atlas or LLM limit), less when chunks are shorter than
   the target, as short Markdown sections are. If answers lack
   context, try neighbour expansion (send each hit with the chunks at `chunkIndex` ± 1
   from the same upload) before changing the chunk size. Re-check the chunk size here
   with broad questions (e.g. summaries), which milestone 4 didn't test.
   Where the code goes: the answer function in `src/`, since milestone 7 reuses it; the
   command-line ask command in `scripts/`, since it's how a user asks until the web page
   (milestone 8), like `ingest-file.js` for uploads. `tools/search.js` stays in `tools/`:
   it shows raw chunks and scores, for testing and tuning.
6. PDF support (command line): add a PDF extractor for text-based PDFs; reject scanned
   PDFs with a clear message. Comes before the API and web page so they are built once
   for all file types.
   With a large real PDF: record its chunk count (vs the estimate in Findings), and run
   `npm run probe` on it to confirm exact search with a large `limit` and to measure
   the delay for a large upload (see the caveats in tools/probe.js).
   Also with that PDF: re-check the "not found" threshold, which will likely drift up
   (an off-topic question's top score is the best of many more chunks); decide how page
   breaks are handled (pages as hard boundaries cut sentences at every break); and
   re-check the chunk size, since PDF chunks have no heading path for context.
   Ask it broad questions (summaries, overviews) and revisit `search.limit`: the top 5
   chunks cover little of a large upload (see Findings: Broad questions).

### Phase 2
7. Express API: one shared database client; routes to upload, list uploads, and ask.
   Test with curl before building any UI. Name the entry file `server.js` (not
   `index.js`) and point `npm start` at it; `package.json` needs no `main` field,
   since the app is run, never imported. Move the index definitions from
   `scripts/setup-db.js` into `src/indexes.js`, so the server can check at startup
   that the vector index exists.
8. Web page: upload form, upload picker (including "All uploads"), question box,
   answers with citations. Show a "processing… ready" state after upload, since new
   chunks are not searchable until their embeddings exist.
9. Hybrid search: add an Atlas Search (keyword) index and combine it with vector search.
   Combined scores use a different scale, so re-tune the "not found" threshold (record
   it under Findings), and
   compare against vector-only results using `test-questions.json`.
   Optional, for the demo: a search mode switch on the page (Vector · Keyword · Hybrid)
   to show how results differ, e.g. for exact codes or typos.

### Phase 3
10. README with architecture diagram, and a demo video.

### Optional (parked)
11. Analytics: log each question, top score, and cited chunks in a `questions`
    collection, then build an analytics view with aggregation pipelines.

## Open decisions
- Milestone 8: let the picker select several uploads, not just one or "All uploads"?
  The vector search filter would be `uploadId: { $in: [...] }`; the vector index stays
  the same, so no re-embedding.
- Milestone 8: how to tell that an upload's chunks are searchable, for the
  "processing… ready" state. Researched in milestone 3; Atlas has no per-upload
  progress report (index status covers the whole index; the Atlas metrics charts cover
  the whole cluster). Options:
  - A. Search and count: exact `$vectorSearch` filtered by `uploadId`, `limit` =
    chunkCount, then `$count` (as in tools/probe.js). Checks "searchable", the real end
    result, using public features only. Each check embeds a short query (a few tokens,
    counts toward the rate limit), and costs more for larger uploads.
  - B. Count embeddings: the generated embeddings collection in `__mdb_internal_search`
    (documented, read-only) holds one MDB doc per embedded chunk with a copy of
    `uploadId`, so `countDocuments({ uploadId })` vs chunkCount shows progress
    ("4 of 6 embedded"). Cheap at any size, no tokens. But it checks "embedded", one
    step before "searchable", and the collection is found by its generated name
    (prefix = index id), whose format has changed before (June 2026 release).
  - C. Fixed wait: assume ready after ~15 s (measured 5–11 s). Simplest, no guarantee,
    especially for large uploads.
  - Possible mix: B for progress, then one A check to confirm.

  Storing the result: keep it out of `status`, which is the ingest state only and
  drives the duplicate index. Prefer `searchableAt` (Date) on `uploads`: set the first
  time the check passes, so the upload is never checked again; `searchableAt −
  uploadedAt` gives the delay per upload. (Alternative: `searchable` boolean, which
  doesn't record when.)

## Decisions
- Database: `knowledge_base` (`DB_NAME` in `.env`).
- Schema: two collections, names in `config.js`.
  - `uploads`: `_id` (the uploadId), `fileName`, `title`, `fileType`, `status`
    (processing → complete), `uploadedAt`, `chunkCount`. `title` comes from the file
    (first `#` heading in Markdown; PDF metadata later), else from the file name.
  - `chunks`: `uploadId` (ObjectId), `fileName` (copied for citations), `section`,
    `chunkIndex`, `text` (heading path + body; the auto-embedded field).
  - Indexes: `uploads` partial unique on `fileName` where status is complete;
    `chunks` on `uploadId`. The vector index filters on `uploadId` only.
- Vector index `chunks_vector_cosine` on `chunks` (created by `npm run setup`):
  autoEmbed on `text`, model `voyage-4`, 1024 dimensions, scalar quantization, cosine
  similarity; filter on `uploadId` (queries must pass ObjectIds, not strings).
  Search indexes can't be edited: a changed definition gets a new index under a new
  name (use the spare slot), then the old one is dropped. Setup skips an index that
  already exists and never updates one.
- Chunk size: 1,600 characters (≈400 tokens), max 2,000, overlap 200. Sections are
  hard boundaries (a chunk never spans two): each Markdown heading starts a section, a
  plain-text file is one section, and PDFs will use pages (how page breaks are handled
  is decided in milestone 6). Values in `config.js`. Confirmed in milestone 4 against 1,000 (see
  Findings: Chunk size); re-check with answers (milestone 5) and a real PDF (milestone 6).
- Answers (milestone 5, from the Anthropic docs on search results and citations):
  - Chunks go to the LLM as `search_result` blocks in the user message, one per chunk
    with one text block each: `title` is "fileName: section", `source` identifies the
    chunk. A citation's `search_result_index` is the chunk's position in the list sent,
    so it maps back to upload and section. Claude cites whole blocks, so a citation
    quotes the whole chunk; split chunks into paragraph blocks later if the web page
    needs shorter quotes (no data change).
  - "Not found" is detected by citations: a reply with at least one citation is an
    answer; a reply with none is "not found in your uploads", whatever its wording.
    Built-in citations can't be combined with structured output (the API returns a
    400), so that option would mean giving up built-in citations. If citations prove
    unreliable, the fallback is a "not found" tool the LLM calls.
  - Partial answers: the LLM answers the part the chunks cover, with citations, and
    says plainly what the uploads don't cover. It counts as an answer.
- Folder layout (milestone 3). Scripts and tools import from `src/`, never the reverse.
  `src/` is app code; `scripts/` is what's needed to make the app work (setup, and the
  user-facing commands ingest and ask until the web page); `tools/` is maintenance and
  testing, including everything that shows the app's internals (e.g. the command-line
  search). ARCHITECTURE.md maps each folder and file.

## Findings
Measured results and the values chosen from them, with a short reason. Filled in as
milestones run.
- Embedding delay (milestone 3): about 5–11 s from upload to fully searchable
  (1-chunk upload: 7–11 s; 6-chunk upload: ≤5 s, all chunks at once). It did not
  grow with chunk count at this size. Measured with `npm run probe` ("N of N").
  Building the vector index over 17 existing chunks took about 80 s. For large uploads
  the probe's seconds include ingest time, and embedding beyond the rate limit is
  queued, so expect longer (to measure in milestone 6).
- Exact vs approximate search (milestone 3, Atlas docs + test): approximate search
  (default, HNSW) can miss results (the docs call 90–95% overlap with exact search
  typical good recall), so it can't be trusted to count chunks. Exact search
  (`exact: true`) checks every vector that passes the filter; the docs recommend it
  below 10,000 MDB docs and for selective pre-filters. On our index it works with
  scalar quantization and gives the same scores (within run-to-run jitter: ~0.0004 in
  milestone 3, up to ~0.001 across the 36 test questions in milestone 4).
  `numCandidates` (approximate only) is capped at 10,000.
- Upload size estimate (milestone 3, not measured): a 500-page textbook is about
  1,200–1,800 chunks (≈3,000–3,500 characters per page), up to ~2,500 when very dense.
  That's ~1M tokens and ~4.5–9 MB (see Storage). Confirm with a real PDF in
  milestone 6.
- Similarity (milestone 3): dotProduct with scalar quantization squeezed every score
  to about 0.50 (relevant vs off-topic differed by ~0.003). Cosine separates them
  (about 0.67–0.72 vs 0.55–0.58), with the same ranking. Chose cosine.
- Re-embedding triggers (milestone 3, Atlas docs): inserting a chunk or changing its
  `text` embeds that chunk; changing other fields or deleting does not. Changing the
  model, embedded path, dimensions or quantization rebuilds and re-embeds everything.
  An autoEmbed field can't be edited. Adding filter fields later isn't documented.
  Dropping an index also removes its stored embeddings.
- M0 limits (milestone 3): 3 search indexes (we plan 2, one spare for replacing an
  index side by side). Auto-Embedding needs no extra setup on M0.
- Storage (milestone 3): about 2.2–2.5 KB per chunk (text ≈1.0 KB, embedding ≈1.2 KB
  at 1 byte per dimension), plus index overhead. 512 MB fits well over 100,000
  chunks, so storage, not the 200M-token allowance (~500,000 chunks), is the tighter
  limit. Whole cluster at 24 chunks: ≈424 KB.
  In 500-page textbooks (estimate; see Upload size): at ~3–3.5 KB per chunk all-in,
  one is about 4.5 MB (typical, ~1,500 chunks) to 9 MB (dense, ~2,500 chunks), so
  512 MB holds roughly 50–100 of them (about 110 typical, 55 dense). The token
  allowance would cover ~200 (at ~1M tokens each), so storage runs out first.
  Uncertain: the vector index itself (Lucene, on the search side) isn't in these
  numbers, and it's unclear whether M0 counts it toward 512 MB. Re-measure with
  real PDFs in milestone 6.
- "Not found" score threshold (milestone 4): 0.62 for both search modes, confirmed at
  the chosen chunk size (1,600; the rerun gave the same results). Re-check it with a
  real PDF in milestone 6, since more chunks will likely push off-topic scores up. From
  `npm run test-questions` (36 questions; per-question results in
  `test-results/2026-09-29-chunk-1600.md`): answerable top scores 0.65–0.86 (lowest: an
  error code typed without its hyphen); clearly unrelated questions 0.58–0.61; asked of
  the wrong upload 0.53–0.69 (17 of 22 below 0.62).
  The threshold only catches clearly unrelated questions. Near-misses (on topic, answer
  absent) scored 0.68–0.80, and technical off-topic questions that share our wording
  0.62–0.77 ("How do I install Python on Windows?" 0.77), overlapping the answerable
  ones: the top score measures topic similarity, not whether the answer is present. So
  no threshold separates them, and the LLM must catch them (see milestone 5).
  Set low on purpose: too high refuses real answers, which nothing recovers; too low
  costs one LLM call that should answer "not found". The two modes scored almost the
  same, so one value, kept as two config entries so they can diverge (e.g. hybrid).
- Chunk size (milestone 4): kept 1,600 after comparing it with 1,000 (scaled max
  1,250, overlap 125) on the same 36 questions (`test-results/2026-09-29-chunk-1600.md`
  and `…-chunk-1000.md`). Retrieving the answer tied: each question's answer text
  (its `expect` phrases) was in the top 5 for 22 of 22 at both sizes, and at #1 about
  equally often (All/One: 19/21 at 1,600, 20/20 at 1,000). 1,000 raised scores and
  put the expected upload first more often (22 vs 20 of 22), most for answers that are
  a small part of a mixed-topic chunk (+0.035 to +0.064), but those answers were already
  retrieved at 1,600. With retrieval tied, 1,600 wins on the rest: more context for the
  LLM (top 5: up to ≈8,000 vs 5,000 characters), safer for PDF chunks, which have no heading
  path, about 30% less storage (fewer chunks, each with a fixed ≈1.2 KB embedding), and
  slightly better threshold behaviour (17 vs 16 of 22 wrong-upload questions rejected).
  Limits: `expect` phrases are short facts, so broad questions (where context matters
  most) aren't tested, and the samples are small. (Broad questions were tested in
  milestone 5 and support keeping 1,600; see Broad questions.) Extrapolated to PDFs (≈3,000–3,500
  characters per page): 1,000 would give about 1.6× the chunks of 1,600; the embedding
  tokens are the same either way.
- Broad questions (milestone 5): answers are limited by the top 5 chunks (≈8,000
  characters), not by chunk size. A summary of the 6-chunk Claude Code upload cited 5
  of its chunks and was complete; for the 13-chunk MongoDB upload, a schema design
  question missed "embed or reference", indexes and transactions, and the handbook
  summary missed the support requests section
  (`test-results/2026-09-29-answers-new-kinds.md`). The answers stay honest about it
  ("the excerpts I have cover…"). This is a limit of top-k retrieval: smaller chunks
  would make it worse (less text in the top 5), and neighbour expansion adds depth
  around a hit, not breadth. The lever is `search.limit`, which costs input tokens on
  every question, so it stays at 5 for now; revisit it with a large real PDF in
  milestone 6, where summarizing a whole upload can't work this way.
- Hybrid "not found" score threshold (milestone 9): not chosen yet

## Current status
- Git installed; Atlas account set up. Milestone 1 is completed.
- Milestone 2 is completed: `npm run ingest -- <file>` saves .txt and .md uploads and
  their chunks.
- Milestone 3 is completed: the vector index `chunks_vector_cosine` is ready (see
  Decisions), and delay, storage and search behaviour are under Findings.
- Milestone 4 is completed: `src/search.js` searches one upload (exact) or all complete
  uploads (approximate); `npm run search` shows raw results; `npm run test-questions`
  runs the 36 questions in `test-questions.json` and saves reports in `test-results/`.
  The "not found" threshold (0.62) and the chunk size (1,600) are under Findings.
  Five samples are in Atlas at 1,600 (37 chunks): nimbus-guide.md 11,
  nimbus-admin-handbook.txt 6, nimbus-release-notes.txt 1, mongodb-document-model.md 13,
  claude-code-first-steps.txt 6. Next: milestone 5 (answers with citations).
- Files and commands: see ARCHITECTURE.md.
