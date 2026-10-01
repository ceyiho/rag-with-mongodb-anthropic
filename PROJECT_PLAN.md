# Project Plan: RAG Knowledge Base on MongoDB Atlas

## What we're building aka functional specifications
A personal knowledge base. Users upload files (text, markdown, PDFs) and ask
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
- Documentation: official product documentation (e.g. "the Atlas documentation").
  Don't shorten it to "docs", which reads like "MDB docs".

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
- PDF extraction: `unpdf`, a pdf.js wrapper that works with `require` and gives text
  per page. Pages act as sections for citations. Scanned PDFs are rejected.
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
- To consider: reranking with `$rerank` (Voyage AI), see milestone 9
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
   Before creating the index: check the Atlas documentation for which changes trigger
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
   Context: the LLM sees the top chunks only: up to ≈16,000 characters (10 × 1,600; our
   `config.search.limit`, 5 until milestone 6; not an Atlas or LLM limit), less when
   chunks are shorter than the target, as short Markdown sections are. If answers lack
   context, try neighbour expansion (send each hit with the chunks at `chunkIndex` ± 1
   from the same upload) before changing the chunk size. Re-check the chunk size here
   with broad questions (e.g. summaries), which milestone 4 didn't test.
   Where the code goes: the answer function in `src/`, since milestone 7 reuses it; the
   command-line ask command in `scripts/`, since it's how a user asks until the web page
   (milestone 8), like `ingest-file.js` for uploads. `tools/search.js` stays in `tools/`:
   it shows raw chunks and scores, for testing and tuning.
6. PDF support (command line): add a PDF extractor for text-based PDFs; reject scanned
   PDFs with a clear message. Comes before the API and web page so they are built once
   for all file types. Decide how page breaks are handled (pages as hard boundaries cut
   sentences at every break); and re-check the chunk size, since PDF chunks have no
   heading path for context.
   With a large real PDF: record its chunk count (vs the estimate in Findings), confirm
   exact search with a large `limit`, and measure the delay for a large upload. Re-check
   the "not found" threshold, which will likely drift up (an off-topic question's top
   score is the best of many more chunks), and revisit `search.limit` with broad
   questions (summaries, overviews): the top 5 chunks cover little of a large upload.
   Then drop running headers and footers (lines repeated in the page margins). Neither
   real PDF has any, so test with mock PDFs, including repeated body headings that must
   be kept.

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
   To consider: the `$rerank` stage (Voyage AI) to rerank 20–50 candidates into the top
   5. Its score may separate near-misses from answers, which cosine can't; measure that
   first. Blocked: needs MongoDB 8.3+ (our M0 runs 8.0.32) and is in Preview. Docs:
   https://www.mongodb.com/docs/vector-search/query/aggregation-stages/rerank/

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
    counts toward the rate limit), and costs more for larger uploads. Works for a
    313-chunk upload (milestone 6).
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
    (first `#` heading in Markdown, metadata title in a PDF), else from the file name.
  - `chunks`: `uploadId` (ObjectId), `fileName` (copied for citations), `section`,
    `chunkIndex`, `text` (Markdown: heading path + body; plain text: title + body;
    PDFs: title, chapter if any, + body; the auto-embedded field).
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
  plain-text file is one section, and each PDF page is one (see PDF pages). Values in
  `config.js`. Confirmed in milestone 4 against 1,000, and re-checked with answers
  (milestone 5) and PDFs (milestone 6); see Findings: Chunk size.
- PDF pages (milestone 6; detailed rules in the PDF extractor's header comment): each
  page is a section, cited by its PDF page number, and page breaks stay hard
  boundaries. Pages are read in visual order (some PDFs store code blocks after the
  prose). A sentence cut by a page break moves to the next page, unless either side of
  the break is code. Images are skipped and there's no OCR.
- PDF headers, footers and chapters (milestone 6): running headers and footers are
  dropped: margin lines that repeat on a run of nearby pages. A run, not a share of
  all pages, so chapter names go in long books too, while body sentences a book
  repeats on scattered pages stay. Chunks start with the title, not "page N", then the
  page's chapter when the headers name one ("Title > Chapter", like a Markdown heading
  path). The name moves from the body to the prefix so every chunk of the chapter
  carries it, header or not. Headers that never change (e.g. the book title) are
  ignored. The mock PDFs are committed; their generator is kept outside the
  repository. Not chosen: chapter names from the PDF outline (bookmarks);
  neither real PDF has one.
- Answers (milestone 5, from the Anthropic documentation on search results and
  citations):
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
  queued, so expect longer.
  Large upload (milestone 6): the 280-page book (313 chunks) was fully searchable
  within 13–16 s of upload, ingest included.
- Exact vs approximate search (milestone 3, Atlas documentation + test): approximate
  search (default, HNSW) can miss results (the documentation calls 90–95% overlap with
  exact search typical good recall), so it can't be trusted to count chunks. Exact
  search (`exact: true`) checks every vector that passes the filter; the documentation
  recommends it below 10,000 MDB docs and for selective pre-filters. On our index it
  works with scalar quantization and gives the same scores (within run-to-run jitter:
  ~0.0004 in milestone 3, up to ~0.001 across the 36 test questions in milestone 4).
  `numCandidates` (approximate only) is capped at 10,000. Exact search has no
  documented cap on `limit`; `limit` = 313 returned all 313 chunks of the book
  (milestone 6).
- Upload size estimate (milestone 3, not measured): a 500-page textbook is about
  1,200–1,800 chunks (≈3,000–3,500 characters per page), up to ~2,500 when very dense.
  That's ~1M tokens and ~4.5–9 MB (see Storage).
  Measured (milestone 6): a 280-page technical book
  (Practical MongoDB Aggregations, many code examples) gave 313 chunks from 278 pages
  with text, about 1.1 chunks per page. Its pages are far lighter than estimated
  (average 1,205 characters, median 1,151, max 3,355), so most pages are one chunk
  (average 1,117 characters). At this density 500 pages would be ~550 chunks; the
  estimate above still fits dense textbooks.
- Similarity (milestone 3): dotProduct with scalar quantization squeezed every score
  to about 0.50 (relevant vs off-topic differed by ~0.003). Cosine separates them
  (about 0.67–0.72 vs 0.55–0.58), with the same ranking. Chose cosine.
- Re-embedding triggers (milestone 3, Atlas documentation): inserting a chunk or
  changing its `text` embeds that chunk; changing other fields or deleting does not.
  Changing the model, embedded path, dimensions or quantization rebuilds and re-embeds
  everything. An autoEmbed field can't be edited. Adding filter fields later isn't
  documented. Dropping an index also removes its stored embeddings.
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
  numbers, and it's unclear whether M0 counts it toward 512 MB.
  Measured (milestone 6, ~360 chunks including the book): data 2.4 KB per chunk, as
  estimated; ~4.5 KB on disk with indexes (the generated embeddings take about twice
  their data size); plus the vector index, ~1.1 KB. So ~5.5 KB per chunk
  worst case: the book takes ~1.7 MB, and 512 MB holds ~90,000 chunks. Whether M0
  counts the embeddings and the vector index toward 512 MB is still unknown; storage
  isn't a concern at this project's scale either way.
- "Not found" score threshold (milestone 4): 0.62 for both search modes, confirmed at
  the chosen chunk size (1,600; the rerun gave the same results). From
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
  Milestone 6, with the PDFs (run of 2026-10-01): kept at 0.62,
  all answerable kept (lowest 0.654). In All uploads it no longer rejects off-topic
  questions (0 of 9; low-content chunks lift them to
  0.62–0.67), but still most wrong-upload ones (38 of 49). The LLM is the real "not
  found" gate.
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
  milestone 5 and support keeping 1,600; see Broad questions.)
  PDFs (milestone 6): kept 1,600. Pages are hard boundaries and only 30 of the book's
  278 pages are longer, so the size barely matters there. Short chunks (part openers,
  page ends) don't crowd out answers; they hold real content, so they aren't merged.
  One weak retrieval: a book question whose answer is on a mostly-code page ranked it
  #10, behind symbol-only cheatsheet pages; try neighbour expansion or hybrid search
  (milestone 9).
- Answers (milestone 5): all 112 question/mode pairs passed
  (`test-results/2026-09-29-answers-prompt-v2.md`). The LLM replied "not found" to
  every near-miss and off-topic question the threshold let through (up to 0.80), so
  threshold plus LLM work as planned. Detecting "not found" by citations held, and
  partial answers named their missing part.
  Milestone 6, with the PDFs at `search.limit` 10 (run of 2026-10-01): 188 of 191
  passed; the 3 failures were badly designed questions, since fixed. All other
  near-misses and off-topic questions came back "not found".
- Answer prompt (milestone 5): tuned against unasked gap notes, an invented example
  value and long answers (baseline and two attempt reports in `test-results/`). The
  kept rules are in `src/answer.js`. Accepted: proxy answers note that no exact syntax
  is given. Replies vary between runs, so judge prompt changes on a full run.
- LLM cost (milestone 5): billing implies ~$2 / $10 per million input / output tokens.
  Input dominates (~5,300 tokens per question at `search.limit` 10, mostly the
  chunks); a full `npm run test-answers` run (71 questions) is ~150 calls, ~$2.
- Broad questions (milestones 5–6): limited by how many chunks reach the LLM, not by
  chunk size. `search.limit` raised from 5 to 10 in milestone 6 (runs of 2026-10-01):
  uploads of 10–13 chunks now get complete answers; the book's stay partial. "What
  kinds of examples does the book include?" stays incomplete at any limit (no table
  of contents in its text). Cost: ~$0.003 more per question.
- Scanned PDFs (milestone 6): rejected as intended, tested with image-only mock PDFs,
  including one with a small text footer as phone scanner apps add. A text PDF with a
  few image-only pages (a cover, a diagram) is accepted; those pages give no section.
  Rejection happens before anything is saved.
- Plain-text chunk prefix (milestone 6): changed from the file name
  ("nimbus-admin-handbook.txt") to the title made from it ("Nimbus Admin Handbook"),
  to match PDFs. No measurable effect (runs of 2026-10-01): ranks, answers and the
  threshold unchanged; scores of the plain-text uploads' own questions moved by
  -0.006 to +0.006, mostly slightly down. Kept for consistency.
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
  claude-code-first-steps.txt 6.
- Milestone 5 is completed: `src/answer.js` answers with citations; `npm run ask`;
  `npm run test-answers` checks answers against `test-questions.json` (42 questions,
  new kinds partial and broad). Results under Findings.
- Milestone 6 is completed: PDF ingestion with running headers and footers dropped and
  chapter names in the prefix (see Decisions: PDF pages, and PDF headers, footers and
  chapters), and the tuning (threshold kept at 0.62, `search.limit` 10, chunk size
  kept; under Findings). In Atlas, 360 chunks: the five samples plus two real PDFs.
  Neither has running headers, so neither needed re-ingesting.
  The test set has 71 questions.
- Next: milestone 7 (Express API).
- Files and commands: see ARCHITECTURE.md.
